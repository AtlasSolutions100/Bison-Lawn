import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCreateInvoice,
  useListServices,
  usePriceServiceForClient,
  useSearchInvoiceCustomers,
  type InvoiceCustomerMatch,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Plus, Search, Trash2, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { errorText, invalidateBilling, money } from './shared';

/**
 * "When creating invoice having ability to search by info on clients account
 * and when adding service to bill pulling info from matrix based on customer
 * account."
 *
 * The old New invoice window handed him a dropdown of 709 names in
 * alphabetical order. He does not always have the name: he has a cheque stub
 * with an address on it, a voicemail with a phone number, or the account
 * number off a Service Autopilot record. So the customer is found by typing
 * anything that is on their account, and every match says which detail
 * matched and what they already owe, so he can tell two Wagners apart.
 *
 * Then, adding a service prices it the way a completed job prices itself —
 * through that customer's own matrix value, not the flat rate, because a
 * 30,000 sqft lawn and a 3,000 sqft lawn are not the same mow. The line says
 * where the number came from, and when the measurement is missing it says that
 * instead of quietly charging the wrong price.
 */

type DraftLine = {
  key: number;
  description: string;
  serviceDate: string;
  quantity: string;
  unitPrice: string;
  /** Where the rate came from, shown under the line so he can trust the number. */
  from?: string | null;
};

let lineKey = 1;
const emptyLine = (): DraftLine => ({ key: lineKey++, description: '', serviceDate: '', quantity: '1', unitPrice: '' });
const lineTotal = (l: DraftLine) => Math.round((parseFloat(l.quantity) || 0) * (parseFloat(l.unitPrice) || 0) * 100) / 100;

export default function RaiseInvoiceDialog() {
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState<InvoiceCustomerMatch | null>(null);
  const [poNumber, setPoNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [serviceId, setServiceId] = useState('');
  const [measurement, setMeasurement] = useState('');
  const [priceNote, setPriceNote] = useState<string | null>(null);

  const createInvoice = useCreateInvoice();
  const priceService = usePriceServiceForClient();
  const { data: services } = useListServices();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const parsedLines = lines
    .filter((l) => l.description.trim())
    .map((l) => ({
      description: l.description.trim(),
      serviceDate: l.serviceDate || null,
      quantity: parseFloat(l.quantity) || 0,
      unitPrice: parseFloat(l.unitPrice) || 0,
    }));
  const total = lines.reduce((sum, l) => sum + (l.description.trim() ? lineTotal(l) : 0), 0);

  const updateLine = (key: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const reset = () => {
    setClient(null);
    setPoNumber('');
    setNotes('');
    setLines([emptyLine()]);
    setServiceId('');
    setMeasurement('');
    setPriceNote(null);
  };

  const addFromService = () => {
    if (!client || !serviceId) return;
    priceService.mutate(
      {
        data: {
          clientId: client.id,
          serviceId: Number(serviceId),
          ...(measurement.trim() ? { measurement: Number(measurement) } : {}),
        },
      },
      {
        onSuccess: (priced) => {
          const from = priced.fromMatrix
            ? `Priced from this customer's ${priced.pricedFromLabel}${priced.pricedFromValue != null ? ` of ${priced.pricedFromValue.toLocaleString()}` : ''}`
            : priced.missingField
              ? `No ${priced.missingField} on this account, so this is the flat rate of ${money(priced.flatRate)} — check it`
              : `Flat rate for ${priced.serviceName}`;
          setLines((prev) => {
            const next = prev.filter((l) => l.description.trim() || l.unitPrice.trim());
            return [
              ...next,
              {
                key: lineKey++,
                description: priced.description,
                serviceDate: '',
                quantity: String(priced.quantity),
                unitPrice: priced.unitPrice.toFixed(2),
                from,
              },
            ];
          });
          setPriceNote(from);
          setServiceId('');
          setMeasurement('');
        },
        onError: (error) => toast({ title: 'Could not price that service', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  const handleSave = () => {
    if (!client) return;
    createInvoice.mutate(
      {
        data: {
          clientId: client.id,
          lines: parsedLines,
          ...(poNumber.trim() && { poNumber: poNumber.trim() }),
          ...(notes && { notes }),
        },
      },
      {
        onSuccess: (inv) => {
          invalidateBilling(queryClient, inv.clientId, inv.id);
          void queryClient.invalidateQueries({ queryKey: ['/api/invoices/account-summary'] });
          toast({
            title: `Invoice #${inv.number} created`,
            description: `${money(inv.total)} on ${client.name}'s account, in the ${inv.deliveryMethod === 'print' ? 'To print' : 'To email'} queue.`,
          });
          setOpen(false);
          reset();
        },
        onError: (error) => toast({ title: 'Could not create the invoice', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button className="h-10 bg-primary text-primary-foreground font-semibold shadow-sm px-4">
          <Plus className="w-4 h-4 mr-2" /> New invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New invoice{client ? ` for ${client.name}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4 max-h-[70vh] overflow-y-auto pr-1">
          {client ? <ChosenCustomer client={client} onClear={() => setClient(null)} /> : <CustomerFinder onPick={setClient} />}

          {client && (
            <>
              <div>
                <label className="text-sm font-medium mb-1 block">PO number (optional)</label>
                <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="Customer's reference" />
                {/* Terms are not editable here: they come from the account and
                    are snapshotted at issue. Showing which ones will apply
                    stops a bill going out on terms nobody expected. */}
                {client.billingTerms && <p className="text-xs text-muted-foreground mt-1">Terms: {client.billingTerms}</p>}
              </div>

              {/* Add a service and it prices itself off this customer's matrix. */}
              <div className="rounded-md border border-dashed p-3 space-y-2">
                <div className="text-sm font-medium">Add a service, priced for this customer</div>
                <div className="flex flex-wrap gap-2">
                  <select
                    className="flex h-9 flex-1 min-w-[12rem] rounded-md border border-input bg-background px-2 text-sm"
                    value={serviceId}
                    onChange={(e) => setServiceId(e.target.value)}
                  >
                    <option value="">Pick a service…</option>
                    {services?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <Input
                    type="number"
                    className="h-9 w-40"
                    placeholder="Re-measured?"
                    value={measurement}
                    onChange={(e) => setMeasurement(e.target.value)}
                  />
                  <Button size="sm" variant="outline" className="h-9" disabled={!serviceId || priceService.isPending} onClick={addFromService}>
                    {priceService.isPending ? 'Pricing…' : 'Add line'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The rate comes off this customer's own matrix value. Type a measurement only if you re-measured on site — a fresh
                  number beats the one on file.
                </p>
                {priceNote && <p className="text-xs font-medium text-foreground">{priceNote}</p>}
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
                  {lines.map((line) => (
                    <div key={line.key} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
                      <div className="sm:col-span-5">
                        <Input
                          value={line.description}
                          onChange={(e) => updateLine(line.key, { description: e.target.value })}
                          placeholder="Mowing — 8/12, 8/19, 8/26"
                        />
                        {line.from && <p className="text-[11px] text-muted-foreground mt-1">{line.from}</p>}
                      </div>
                      <Input
                        type="date"
                        className="sm:col-span-3"
                        value={line.serviceDate}
                        onChange={(e) => updateLine(line.key, { serviceDate: e.target.value })}
                      />
                      <Input
                        type="number"
                        step="0.01"
                        className="sm:col-span-1 text-right"
                        value={line.quantity}
                        onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                      />
                      <Input
                        type="number"
                        step="0.01"
                        className="sm:col-span-2 text-right"
                        value={line.unitPrice}
                        onChange={(e) => updateLine(line.key, { unitPrice: e.target.value, from: null })}
                        placeholder="0.00"
                      />
                      <div className="sm:col-span-1 flex justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-muted-foreground"
                          // Never leave zero rows: an empty editor gives the
                          // office nothing to click and no way back.
                          onClick={() => setLines((prev) => (prev.length === 1 ? [emptyLine()] : prev.filter((l) => l.key !== line.key)))}
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
                customer's account right away.
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createInvoice.isPending || !client || parsedLines.length === 0 || total <= 0}>
            Create invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Find the customer by anything on their account. */
function CustomerFinder({ onPick }: { onPick: (c: InvoiceCustomerMatch) => void }) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  // Two characters is the floor: one letter matches half of Post Falls and the
  // list is useless.
  const enabled = query.length >= 2;
  const { data: matches, isFetching } = useSearchInvoiceCustomers(
    { q: query || 'x' },
    { query: { enabled, queryKey: ['/api/invoices/customer-search', query] } },
  );

  const rows = useMemo(() => matches ?? [], [matches]);
  return (
    <div>
      <label className="text-sm font-medium mb-1 block">Customer *</label>
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-3 text-muted-foreground" />
        <Input
          className="pl-9"
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Name, address, phone, account number, zip or email"
        />
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        Anything off their account will find them — "615 E 18th", a phone number, or the old Service Autopilot number.
      </p>
      {enabled && (
        <div className="mt-2 max-h-56 overflow-y-auto rounded-md border divide-y">
          {isFetching && rows.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted-foreground">Looking…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted-foreground">Nobody on file matches that.</div>
          ) : (
            rows.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onPick(c)}
                className="w-full text-left px-3 py-2 hover:bg-muted/60 transition-colors"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">matched on {c.matchedOn}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {[c.serviceAddress, c.city, c.accountNumber ? `#${c.accountNumber}` : null, c.phone].filter(Boolean).join(' · ')}
                </div>
                {(c.openInvoiceCount > 0 || c.accountBalance !== 0) && (
                  <div className="text-xs mt-0.5">
                    <span className={c.accountBalance > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                      {money(c.accountBalance)}
                    </span>
                    {c.openInvoiceCount > 0 && (
                      <span className="text-muted-foreground"> · {c.openInvoiceCount} open bill{c.openInvoiceCount === 1 ? '' : 's'}</span>
                    )}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ChosenCustomer({ client, onClear }: { client: InvoiceCustomerMatch; onClear: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2">
      <div>
        <div className="font-medium">{client.name}</div>
        <div className="text-xs text-muted-foreground">
          {[client.serviceAddress, client.city, client.accountNumber ? `#${client.accountNumber}` : null].filter(Boolean).join(' · ')}
        </div>
        <div className="text-xs mt-0.5">
          <span className={client.accountBalance > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}>
            {money(client.accountBalance)} on the account
          </span>
          {client.invoiceDelivery && <span className="text-muted-foreground"> · bills go by {client.invoiceDelivery}</span>}
        </div>
      </div>
      <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={onClear}>
        <X className="w-4 h-4 mr-1" /> Change
      </Button>
    </div>
  );
}
