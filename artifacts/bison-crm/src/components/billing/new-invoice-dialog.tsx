import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateInvoice } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Plus, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { errorText, invalidateBilling, money } from './shared';

/**
 * "Creating invoice needs to show up on clients account."
 *
 * A bill he raises for one customer is raised from that customer's page, not
 * from the Invoices screen with a 709-name dropdown to scroll through first —
 * and the moment it is saved it is on the account: in the Invoices list, in the
 * statement, in the balance at the top of the page and on the timeline. That is
 * what this button is for. The customer is already known, so there is no picker
 * to get wrong.
 *
 * A bill the office typed line by line counts as checked, so the server sends
 * it straight to the email or print queue rather than back to him to verify
 * what he just wrote.
 */

type DraftLine = { description: string; serviceDate: string; quantity: string; unitPrice: string };
const emptyLine = (): DraftLine => ({ description: '', serviceDate: '', quantity: '1', unitPrice: '' });

export default function NewClientInvoiceDialog({
  clientId,
  clientName,
  billingTerms,
}: {
  clientId: number;
  clientName?: string | null;
  billingTerms?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [poNumber, setPoNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const createInvoice = useCreateInvoice();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const parsedLines = lines
    .filter((line) => line.description.trim())
    .map((line) => ({
      description: line.description.trim(),
      serviceDate: line.serviceDate || null,
      quantity: parseFloat(line.quantity) || 0,
      unitPrice: parseFloat(line.unitPrice) || 0,
    }));

  // Shown live so the office sees the same number the customer will, before
  // committing. Rounded per line to match how the server stores them.
  const total = parsedLines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitPrice * 100) / 100, 0);

  const updateLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const reset = () => {
    setPoNumber('');
    setNotes('');
    setLines([emptyLine()]);
  };

  const handleSave = () => {
    createInvoice.mutate(
      {
        data: {
          clientId,
          lines: parsedLines,
          ...(poNumber.trim() && { poNumber: poNumber.trim() }),
          ...(notes && { notes }),
        },
      },
      {
        onSuccess: (inv) => {
          // Every list this account shows money in, so the bill is there the
          // second the window closes and he does not have to reload the page
          // to believe it.
          invalidateBilling(queryClient, clientId, inv.id);
          void queryClient.invalidateQueries({ queryKey: ['/api/client-activity'] });
          toast({
            title: `Invoice #${inv.number} is on the account`,
            description: `${money(inv.total)} · in the ${inv.deliveryMethod === 'print' ? 'To print' : 'To email'} queue.`,
          });
          setOpen(false);
          reset();
        },
        onError: (error) =>
          toast({ title: 'Could not create the invoice', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="h-9">
          <Plus className="w-4 h-4 mr-2" /> New invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New invoice{clientName ? ` for ${clientName}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4 max-h-[65vh] overflow-y-auto pr-1">
          <div>
            <label className="text-sm font-medium mb-1 block">PO number (optional)</label>
            <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="Customer reference" />
            {/* Terms are not editable here: they come from the account and are
                snapshotted at issue. Showing which ones will apply prevents an
                invoice going out on terms the office did not expect. */}
            {billingTerms && <p className="text-xs text-muted-foreground mt-1">Terms: {billingTerms}</p>}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">Lines *</label>
              <Button size="sm" variant="outline" className="h-8" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add line
              </Button>
            </div>
            <div className="space-y-2">
              <div className="hidden sm:grid grid-cols-12 gap-2 text-xs text-muted-foreground px-1">
                <div className="col-span-5">Description</div>
                <div className="col-span-3">Date of service</div>
                <div className="col-span-1 text-right">Qty</div>
                <div className="col-span-2 text-right">Price</div>
                <div className="col-span-1" />
              </div>
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                  <Input
                    className="sm:col-span-5"
                    value={line.description}
                    onChange={(e) => updateLine(index, { description: e.target.value })}
                    placeholder="Mowing — 8/12, 8/19, 8/26"
                  />
                  <Input
                    type="date"
                    className="sm:col-span-3"
                    value={line.serviceDate}
                    onChange={(e) => updateLine(index, { serviceDate: e.target.value })}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    className="sm:col-span-1 text-right"
                    value={line.quantity}
                    onChange={(e) => updateLine(index, { quantity: e.target.value })}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    className="sm:col-span-2 text-right"
                    value={line.unitPrice}
                    onChange={(e) => updateLine(index, { unitPrice: e.target.value })}
                    placeholder="0.00"
                  />
                  <div className="sm:col-span-1 flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-muted-foreground"
                      // Never leave zero rows: an empty editor gives the office
                      // nothing to click and no way back to a usable form.
                      onClick={() => setLines((prev) => (prev.length === 1 ? [emptyLine()] : prev.filter((_, i) => i !== index)))}
                      aria-label="Remove line"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end mt-3 text-sm">
              <span className="text-muted-foreground mr-3">Invoice total</span>
              <span className="font-bold">{money(total)}</span>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">Note to the customer (optional)</label>
            <textarea
              className="flex min-h-[70px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Prints on the bill"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            A bill you type yourself is already checked, so it goes straight to the email or print queue — and onto this
            account right away.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createInvoice.isPending || parsedLines.length === 0 || total <= 0}>
            Create invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
