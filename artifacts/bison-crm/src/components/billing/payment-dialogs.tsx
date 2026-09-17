import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCreatePayment,
  useApplyPayment,
  useListPayments,
  useListInvoices,
  type Invoice,
  type Payment,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { PAYMENT_METHODS, dayLabel, errorText, invalidateBilling, methodLabel, money } from './shared';

/**
 * The money dialogs, shared by the Invoices page and the customer's
 * Accounting panel: take a payment on one invoice, take a payment on the
 * account (pick the invoice or leave it as credit), apply credit to an
 * invoice, and apply one particular credit to one of the customer's bills.
 */

function MethodSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {PAYMENT_METHODS.map((m) => (
        <option key={m} value={m}>
          {methodLabel(m)}
        </option>
      ))}
    </select>
  );
}

/** Take a payment against one invoice. Over the balance banks the rest as credit. */
export function RecordPaymentDialog({
  invoice,
  balanceDue,
  defaultMethod,
  trigger,
}: {
  invoice: Pick<Invoice, 'id' | 'clientId' | 'clientName' | 'number'>;
  balanceDue: number;
  defaultMethod?: string | null;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(balanceDue.toFixed(2));
  const [method, setMethod] = useState(defaultMethod || 'check');
  const [reference, setReference] = useState('');

  useEffect(() => {
    if (open) setAmount(balanceDue.toFixed(2));
  }, [open, balanceDue]);

  const createPayment = useCreatePayment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    const paymentAmount = Math.round(parseFloat(amount) * 100) / 100;
    const roundedBalance = Math.round(balanceDue * 100) / 100;
    if (paymentAmount > roundedBalance) {
      const credit = paymentAmount - roundedBalance;
      const confirmed = window.confirm(
        `This payment is ${money(credit)} more than the invoice balance. ` +
          `The invoice will be paid in full and the remaining ${money(credit)} will be kept as credit on the customer's account. Continue?`,
      );
      if (!confirmed) return;
    }
    createPayment.mutate(
      {
        data: {
          clientId: invoice.clientId,
          invoiceId: invoice.id,
          amount: paymentAmount,
          method: method as (typeof PAYMENT_METHODS)[number],
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          invalidateBilling(queryClient, invoice.clientId, invoice.id);
          toast({ title: `Payment of ${money(paymentAmount)} recorded on invoice #${invoice.number}` });
          setOpen(false);
          setReference('');
        },
        onError: (error) =>
          toast({ title: 'Could not record the payment', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="h-8 border-primary/30 text-primary hover:bg-primary/10">
            Pay
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a payment on invoice #{invoice.number}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="bg-muted p-3 rounded-md flex justify-between items-center">
            <span className="font-semibold text-foreground">{invoice.clientName}</span>
            <span className="text-destructive font-bold">Due: {money(balanceDue)}</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Amount ($)</label>
              <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">How they paid</label>
              <MethodSelect value={method} onChange={setMethod} />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Reference / check #</label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={createPayment.isPending || !amount || parseFloat(amount) <= 0}>
            {createPayment.isPending ? 'Recording…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Add payment" on the customer's page: the money comes first, the invoice
 * second. Leave the invoice blank and it sits on the account as credit (a
 * prepayment), to be applied when the bill exists.
 */
export function AddPaymentDialog({
  clientId,
  clientName,
  defaultMethod,
  trigger,
}: {
  clientId: number;
  clientName?: string | null;
  defaultMethod?: string | null;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(defaultMethod || 'check');
  const [reference, setReference] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [notes, setNotes] = useState('');

  const { data: invoices } = useListInvoices(
    { clientId },
    { query: { enabled: open, queryKey: ['/api/invoices', { clientId }] } },
  );
  const owed = (invoices ?? []).filter((i) => i.balance > 0 && i.status !== 'void');

  const createPayment = useCreatePayment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    // Default to the one bill they owe, which is the usual case.
    if (owed.length === 1 && !invoiceId) {
      setInvoiceId(String(owed[0].id));
      if (!amount) setAmount(owed[0].balance.toFixed(2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, owed.length]);

  const handleSave = () => {
    const paymentAmount = Math.round(parseFloat(amount) * 100) / 100;
    const target = owed.find((i) => String(i.id) === invoiceId);
    if (target && paymentAmount > target.balance) {
      const credit = paymentAmount - target.balance;
      if (
        !window.confirm(
          `That is ${money(credit)} more than invoice #${target.number} needs. It will be paid in full and ${money(credit)} kept as credit on the account. Continue?`,
        )
      )
        return;
    }
    createPayment.mutate(
      {
        data: {
          clientId,
          invoiceId: target ? target.id : null,
          amount: paymentAmount,
          method: method as (typeof PAYMENT_METHODS)[number],
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          invalidateBilling(queryClient, clientId, target?.id);
          toast({
            title: target
              ? `${money(paymentAmount)} recorded on invoice #${target.number}`
              : `${money(paymentAmount)} added as credit on the account`,
          });
          setOpen(false);
          setAmount('');
          setReference('');
          setNotes('');
          setInvoiceId('');
        },
        onError: (error) =>
          toast({ title: 'Could not record the payment', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger ?? <Button size="sm">Add payment</Button>}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a payment{clientName ? ` from ${clientName}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Amount ($)</label>
              <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">How they paid</label>
              <MethodSelect value={method} onChange={setMethod} />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Put it on</label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={invoiceId}
              onChange={(e) => setInvoiceId(e.target.value)}
            >
              <option value="">Credit on the account (no invoice yet)</option>
              {owed.map((i) => (
                <option key={i.id} value={i.id}>
                  Invoice #{i.number} — {money(i.balance)} due{i.invoiceDate ? ` (${dayLabel(i.invoiceDate)})` : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              Credit on the account can be applied to a bill later from the Payments list.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Reference / check #</label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Note</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={createPayment.isPending || !amount || parseFloat(amount) <= 0}>
            {createPayment.isPending ? 'Recording…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Put this customer's credit on this invoice. */
export function ApplyCreditDialog({
  invoice,
  balanceDue,
  trigger,
}: {
  invoice: Pick<Invoice, 'id' | 'clientId' | 'number'>;
  balanceDue: number;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { data: credits, isLoading, isError } = useListPayments(
    { clientId: invoice.clientId, unapplied: true },
    { query: { enabled: open, queryKey: ['/api/payments', { clientId: invoice.clientId, unapplied: true }] } },
  );
  const applyPayment = useApplyPayment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const applyCredit = (payment: Payment) => {
    applyPayment.mutate(
      { id: payment.id, data: { invoiceId: invoice.id } },
      {
        onSuccess: (result) => {
          invalidateBilling(queryClient, invoice.clientId, invoice.id);
          toast({
            title: 'Credit applied',
            description: `${money(result.appliedAmount)} applied to invoice #${invoice.number}${
              result.remainingCredit > 0 ? `; ${money(result.remainingCredit)} stays on the account.` : '.'
            }`,
          });
          setOpen(false);
        },
        onError: (error) =>
          toast({
            title: 'Could not apply the credit',
            description: errorText(error, 'The credit may have already been applied. Refresh and try again.'),
            variant: 'destructive',
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="h-8">
            Apply credit
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply account credit to invoice #{invoice.number}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-4">
          <p className="text-sm text-muted-foreground">
            Pick a credit to put against the {money(balanceDue)} still owed. Anything beyond that stays on the account.
          </p>
          {isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Loading credit…</div>
          ) : isError ? (
            <div className="py-4 text-center text-sm text-destructive">Could not load the account credit.</div>
          ) : !credits?.length ? (
            <div className="py-4 text-center text-sm text-muted-foreground">No credit on this account.</div>
          ) : (
            credits.map((payment) => (
              <div key={payment.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="font-semibold">{money(payment.amount)}</div>
                  <div className="text-xs text-muted-foreground">
                    {dayLabel(payment.createdAt)} · {methodLabel(payment.method)}
                    {payment.reference ? ` · ${payment.reference}` : ''}
                  </div>
                </div>
                <Button size="sm" onClick={() => applyCredit(payment)} disabled={applyPayment.isPending}>
                  {applyPayment.isPending ? 'Applying…' : `Apply ${money(Math.min(payment.amount, balanceDue))}`}
                </Button>
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The other way round: this credit, which of the customer's bills does it go on. */
export function ApplyPaymentToInvoiceDialog({
  payment,
  trigger,
}: {
  payment: Pick<Payment, 'id' | 'clientId' | 'clientName' | 'amount'>;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { data: invoices, isLoading, isError } = useListInvoices(
    { clientId: payment.clientId },
    { query: { enabled: open, queryKey: ['/api/invoices', { clientId: payment.clientId }] } },
  );
  const owed = (invoices ?? []).filter((i) => i.balance > 0 && i.status !== 'void');
  const applyPayment = useApplyPayment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const apply = (invoice: Invoice) => {
    applyPayment.mutate(
      { id: payment.id, data: { invoiceId: invoice.id } },
      {
        onSuccess: (result) => {
          invalidateBilling(queryClient, payment.clientId, invoice.id);
          toast({
            title: `${money(result.appliedAmount)} applied to invoice #${invoice.number}`,
            description: result.remainingCredit > 0 ? `${money(result.remainingCredit)} stays on the account.` : undefined,
          });
          setOpen(false);
        },
        onError: (error) =>
          toast({ title: 'Could not apply the credit', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="h-8">
            Apply to invoice
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Apply {money(payment.amount)} from {payment.clientName ?? 'this customer'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-4">
          {isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Loading their invoices…</div>
          ) : isError ? (
            <div className="py-4 text-center text-sm text-destructive">Could not load their invoices.</div>
          ) : owed.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              Nothing is owed on this account right now. The credit stays until the next bill.
            </div>
          ) : (
            owed.map((invoice) => (
              <div key={invoice.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="font-semibold">
                    Invoice #{invoice.number} · {money(invoice.balance)} due
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {dayLabel(invoice.invoiceDate)}
                    {invoice.daysPastDue > 0 ? ` · ${invoice.daysPastDue} days past due` : ''}
                  </div>
                </div>
                <Button size="sm" onClick={() => apply(invoice)} disabled={applyPayment.isPending}>
                  Apply {money(Math.min(payment.amount, invoice.balance))}
                </Button>
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
