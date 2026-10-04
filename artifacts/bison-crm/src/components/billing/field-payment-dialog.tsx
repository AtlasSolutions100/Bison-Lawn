import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useGetFieldPaymentOptions, useRecordFieldPayment, type FieldPaymentInputMethod } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckCircle2, CreditCard, Lock } from 'lucide-react';
import { dayLabel, errorText, money } from './shared';

/**
 * "Take payments in the field under invoices with fee percentage."
 *
 * The phone could already take a payment for the job the sub was standing on.
 * What it could not do is take the cheque the customer actually wrote — which
 * is usually for last month's bill, not for today's mow — so either the sub
 * turned it down or it landed on the wrong bill and the office unpicked it
 * later. Here the customer's open bills are listed, this job's own one first,
 * and anything over the bill stays on the account as credit.
 *
 * Money is the one thing he does not hand to a whole crew, so the server
 * decides who may: office access to Invoices, or ticked by him on the Invoices
 * screen. When the answer is no, the screen says so in his words rather than
 * hiding a button and leaving the sub wondering.
 */

type Method = FieldPaymentInputMethod;

export default function FieldPaymentDialog({
  jobId,
  clientName,
  wide,
}: {
  jobId: number;
  clientName?: string | null;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('cash');
  const [reference, setReference] = useState('');
  const [invoiceChoice, setInvoiceChoice] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    amount: number;
    cardFee: number;
    invoiceNumber?: number | null;
    invoiceBalance?: number | null;
    creditLeft: number;
    accountBalance: number;
  } | null>(null);

  const { data: options, isLoading } = useGetFieldPaymentOptions(jobId, {
    query: { enabled: open, queryKey: [`/api/my/jobs/${jobId}/field-payment`] },
  });
  const record = useRecordFieldPayment();
  const queryClient = useQueryClient();

  // The bill they usually mean is this job's own one, so it starts picked.
  // Typing the amount is the only thing the sub should have to do.
  useEffect(() => {
    if (!open || !options?.invoices?.length || invoiceChoice) return;
    const mine = options.invoices.find((i) => i.isThisJob) ?? options.invoices[0];
    setInvoiceChoice(String(mine.id));
  }, [open, options, invoiceChoice]);

  const amt = Number(amount) || 0;
  // The fee goes on the bill as its own line, so it needs a bill. Money put
  // straight on the account has nowhere to show the surcharge, so none is
  // added — and the screen says the same figure the office will record.
  const feeCanBeCharged = invoiceChoice !== '';
  const feeApplies =
    method === 'credit_card' && feeCanBeCharged && Boolean(options?.cardFeeEnabled) && (options?.cardFeePercent ?? 0) > 0;
  const fee = feeApplies ? Math.round(amt * (options!.cardFeePercent)) / 100 : 0;
  const handedOver = Math.round((amt + fee) * 100) / 100;

  const close = () => {
    setOpen(false);
    setReceipt(null);
    setAmount('');
    setReference('');
    setMethod('cash');
    setInvoiceChoice('');
    setError(null);
  };

  const submit = () => {
    if (amt <= 0) return;
    setError(null);
    record.mutate(
      {
        id: jobId,
        data: {
          amount: amt,
          method,
          invoiceId: invoiceChoice ? Number(invoiceChoice) : null,
          reference: reference.trim() || null,
        },
      },
      {
        onSuccess: (r) => {
          // Everything on the phone and everything in the office: the sub's
          // own list, the customer's balance, the invoice queues.
          void queryClient.invalidateQueries();
          setReceipt({
            amount: r.amount,
            cardFee: r.cardFee,
            invoiceNumber: r.invoiceNumber,
            invoiceBalance: r.invoiceBalance,
            creditLeft: r.creditLeft,
            accountBalance: r.accountBalance,
          });
        },
        onError: (e) => setError(errorText(e, 'Could not record the payment')),
      },
    );
  };

  const blocked = options != null && !options.allowed;

  return (
    <>
      <Button onClick={() => setOpen(true)} className={`h-11 font-semibold ${wide ? 'col-span-2' : ''}`}>
        <CreditCard className="w-4 h-4 mr-1" /> Collect Payment
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{receipt ? 'Payment recorded' : 'Collect payment'}</DialogTitle>
          </DialogHeader>

          {receipt ? (
            <div className="space-y-2 text-center py-2">
              <CheckCircle2 className="w-10 h-10 text-primary mx-auto" />
              <p className="text-2xl font-bold">{money(receipt.amount)}</p>
              {receipt.cardFee > 0 && (
                <p className="text-sm text-muted-foreground">Includes {money(receipt.cardFee)} card processing fee</p>
              )}
              <p className="text-sm text-muted-foreground">
                {receipt.invoiceNumber != null
                  ? `On invoice #${receipt.invoiceNumber} — ${money(receipt.invoiceBalance ?? 0)} left on it`
                  : 'Kept as credit on the account'}
              </p>
              {receipt.creditLeft > 0 && (
                <p className="text-sm text-muted-foreground">{money(receipt.creditLeft)} over the bill stays as credit</p>
              )}
              <p className="text-sm">
                {clientName ?? 'The customer'} now stands at <span className="font-semibold">{money(receipt.accountBalance)}</span>
              </p>
            </div>
          ) : isLoading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
          ) : blocked ? (
            <div className="space-y-2 py-2 text-center">
              <Lock className="w-8 h-8 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">{options?.reason}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-sm bg-muted/50 rounded-md p-2 space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Customer balance</span>
                  <span className="font-semibold">{money(options?.accountBalance ?? 0)}</span>
                </div>
                {(options?.credit ?? 0) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Credit already on the account</span>
                    <span className="font-semibold">{money(options!.credit)}</span>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label>Which bill?</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={invoiceChoice}
                  onChange={(e) => setInvoiceChoice(e.target.value)}
                >
                  {(options?.invoices ?? []).map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      #{inv.number} · {money(inv.balance)}
                      {inv.isThisJob ? ' · this job' : inv.invoiceDate ? ` · ${dayLabel(inv.invoiceDate)}` : ''}
                      {inv.daysPastDue > 0 ? ` · ${inv.daysPastDue}d late` : ''}
                    </option>
                  ))}
                  <option value="">No bill — put it on the account</option>
                </select>
                {(options?.invoices?.length ?? 0) === 0 && (
                  <p className="text-xs text-muted-foreground">Nothing is owed, so this will sit on the account as credit.</p>
                )}
              </div>

              <div className="space-y-2">
                <Label>Amount</Label>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>Method</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as Method)}
                >
                  <option value="cash">Cash</option>
                  <option value="check">Check</option>
                  <option value="credit_card">Credit card</option>
                </select>
              </div>

              {method !== 'cash' && (
                <div className="space-y-2">
                  <Label>Reference (check # / last 4)</Label>
                  <Input value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
              )}

              {method === 'credit_card' &&
                (feeApplies ? (
                  // Said out loud before it is charged: the customer has to be
                  // told about the surcharge at the door, not find it later.
                  <div className="text-sm bg-accent/10 border border-accent/20 rounded-md p-3 space-y-1">
                    <div className="flex justify-between"><span>Payment</span><span>{money(amt)}</span></div>
                    <div className="flex justify-between">
                      <span>Card processing fee ({options!.cardFeePercent}%)</span>
                      <span>{money(fee)}</span>
                    </div>
                    <div className="flex justify-between font-bold border-t pt-1"><span>Customer pays</span><span>{money(handedOver)}</span></div>
                  </div>
                ) : Boolean(options?.cardFeeEnabled) && (options?.cardFeePercent ?? 0) > 0 && !feeCanBeCharged ? (
                  <p className="text-xs text-muted-foreground">
                    No bill picked, so no card fee goes on this one. Take {money(amt)} and nothing more.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">No card processing fee is switched on.</p>
                ))}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}

          <DialogFooter>
            {receipt ? (
              <Button onClick={close} className="w-full">Done</Button>
            ) : blocked ? (
              <Button variant="outline" onClick={close} className="w-full">Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={close}>Cancel</Button>
                <Button onClick={submit} disabled={amt <= 0 || record.isPending}>
                  {record.isPending ? 'Recording…' : `Record ${money(handedOver)}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
