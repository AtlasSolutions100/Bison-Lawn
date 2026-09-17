import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetInvoice,
  useUpdateInvoice,
  useVerifyInvoice,
  useDeleteInvoice,
  useSendInvoice,
  useAttachJobToInvoice,
  useUncompleteJob,
  useDeletePayment,
  useListPayments,
  useListInvoiceAudit,
  useListServices,
  useListJobs,
  type Invoice,
  type InvoiceLineItem,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, FileText, Plus, Send, Trash2, Undo2 } from 'lucide-react';
import { RecordPaymentDialog, ApplyCreditDialog } from './payment-dialogs';
import {
  DELIVERY_LABEL,
  StatusPill,
  dayLabel,
  errorText,
  invalidateBilling,
  methodLabel,
  momentLabel,
  money,
  openPdf,
} from './shared';

/**
 * One invoice, opened from any list. This is where he verifies a bill before
 * it goes anywhere: fix the description, the date, the quantity or the rate
 * on any line, take a line off, add a service or a job the crew forgot to
 * bill, write a note to the customer, then press Verify. It is also the
 * bill's own history and its payments, so nothing about one invoice needs
 * a second screen.
 */

type DraftLine = {
  key: number;
  description: string;
  serviceDate: string;
  quantity: string;
  unitPrice: string;
  jobId: number | null;
};

let lineKey = 1;
const emptyLine = (): DraftLine => ({ key: lineKey++, description: '', serviceDate: '', quantity: '1', unitPrice: '', jobId: null });
const fromLine = (line: InvoiceLineItem): DraftLine => ({
  key: lineKey++,
  description: line.description,
  serviceDate: line.serviceDate ?? '',
  quantity: String(line.quantity),
  unitPrice: line.unitPrice.toFixed(2),
  jobId: line.jobId ?? null,
});

const lineTotal = (line: DraftLine) =>
  Math.round((parseFloat(line.quantity) || 0) * (parseFloat(line.unitPrice) || 0) * 100) / 100;

export function InvoiceDialog({
  invoiceId,
  open,
  onOpenChange,
}: {
  invoiceId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: invoice, isLoading } = useGetInvoice(invoiceId ?? 0, {
    query: { enabled: open && invoiceId != null, queryKey: [`/api/invoices/${invoiceId}`] },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
        {!invoice ? (
          <>
            <DialogHeader>
              <DialogTitle>Invoice</DialogTitle>
            </DialogHeader>
            <div className="py-8 text-center text-sm text-muted-foreground">
              {isLoading ? 'Loading…' : 'This invoice could not be loaded.'}
            </div>
          </>
        ) : (
          <InvoiceEditor key={invoice.id} invoice={invoice} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function InvoiceEditor({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [lines, setLines] = useState<DraftLine[]>(() => (invoice.lines.length ? invoice.lines.map(fromLine) : [emptyLine()]));
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [invoiceDate, setInvoiceDate] = useState(invoice.invoiceDate ?? '');
  const [poNumber, setPoNumber] = useState(invoice.poNumber ?? '');
  const [dirty, setDirty] = useState(false);
  const [sendBackTo, setSendBackTo] = useState<'board' | 'waiting_list'>('board');
  const [serviceId, setServiceId] = useState('');
  const [missedJobId, setMissedJobId] = useState('');

  // A save or a verify comes back with fresh lines; take them unless he is
  // mid-edit, in which case his typing wins over the refetch.
  useEffect(() => {
    if (dirty) return;
    setLines(invoice.lines.length ? invoice.lines.map(fromLine) : [emptyLine()]);
    setNotes(invoice.notes ?? '');
    setInvoiceDate(invoice.invoiceDate ?? '');
    setPoNumber(invoice.poNumber ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice]);

  const updateInvoice = useUpdateInvoice();
  const verifyInvoice = useVerifyInvoice();
  const deleteInvoice = useDeleteInvoice();
  const sendInvoice = useSendInvoice();
  const attachJob = useAttachJobToInvoice();
  const uncompleteJob = useUncompleteJob();

  const { data: services } = useListServices();
  const { data: completedJobs } = useListJobs(
    { clientId: invoice.clientId, status: 'completed' },
    { query: { queryKey: ['/api/jobs', { clientId: invoice.clientId, status: 'completed' }] } },
  );
  const missedJobs = useMemo(
    () => (completedJobs ?? []).filter((j) => j.invoiceId == null && j.id !== invoice.jobId),
    [completedJobs, invoice.jobId],
  );

  // A bill paid in full at the door is already "paid" but still unchecked:
  // he can fix its lines and must still press Verify before it goes out.
  const isPending = invoice.needsVerification;
  const editable = invoice.status !== 'void' && (isPending || invoice.status !== 'paid');
  const wentOut = Boolean(invoice.sentAt || invoice.printedAt);
  const draftTotal = lines.reduce((sum, l) => sum + (l.description.trim() ? lineTotal(l) : 0), 0);
  const busy =
    updateInvoice.isPending ||
    verifyInvoice.isPending ||
    deleteInvoice.isPending ||
    sendInvoice.isPending ||
    attachJob.isPending ||
    uncompleteJob.isPending;

  const touch = () => setDirty(true);
  const updateLine = (key: number, patch: Partial<DraftLine>) => {
    touch();
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const removeLine = (key: number) => {
    touch();
    setLines((prev) => (prev.length === 1 ? [emptyLine()] : prev.filter((l) => l.key !== key)));
  };

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: errorText(error), variant: 'destructive' });
  const refresh = () => invalidateBilling(queryClient, invoice.clientId, invoice.id);

  const parsedLines = () =>
    lines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        serviceDate: l.serviceDate || null,
        quantity: parseFloat(l.quantity) || 0,
        unitPrice: parseFloat(l.unitPrice) || 0,
        jobId: l.jobId,
      }));

  const save = (then?: () => void) => {
    if (wentOut && !window.confirm('This bill already went out to the customer. Their copy will not change. Save anyway?')) return;
    updateInvoice.mutate(
      {
        id: invoice.id,
        data: {
          lines: parsedLines(),
          notes: notes.trim() || null,
          invoiceDate: invoiceDate || null,
          poNumber: poNumber.trim() || null,
        },
      },
      {
        onSuccess: () => {
          setDirty(false);
          refresh();
          if (then) then();
          else toast({ title: `Invoice #${invoice.number} saved` });
        },
        onError: failed('Could not save the invoice'),
      },
    );
  };

  const verify = () => {
    const go = () =>
      verifyInvoice.mutate(
        { id: invoice.id },
        {
          onSuccess: (v) => {
            refresh();
            toast({
              title: `Invoice #${v.number} verified`,
              description: `It is now in the ${DELIVERY_LABEL[v.deliveryMethod ?? 'email'] ?? v.deliveryMethod} queue.`,
            });
            onClose();
          },
          onError: failed('Could not verify the invoice'),
        },
      );
    if (dirty) save(go);
    else go();
  };

  const addFromService = () => {
    const svc = services?.find((s) => String(s.id) === serviceId);
    if (!svc) return;
    touch();
    const line: DraftLine = {
      key: lineKey++,
      description: svc.invoiceDescription?.trim() || svc.name,
      serviceDate: invoice.invoiceDate ?? '',
      quantity: '1',
      unitPrice: (svc.rate ?? 0).toFixed(2),
      jobId: null,
    };
    setLines((prev) => (prev.length === 1 && !prev[0].description.trim() ? [line] : [...prev, line]));
    setServiceId('');
  };

  const addMissedJob = () => {
    const job = missedJobs.find((j) => String(j.id) === missedJobId);
    if (!job) return;
    attachJob.mutate(
      { id: invoice.id, data: { jobId: job.id } },
      {
        onSuccess: (v) => {
          refresh();
          setMissedJobId('');
          toast({ title: `Job added to invoice #${v.number}`, description: `Now ${money(v.total)}.` });
        },
        onError: failed('Could not add that job'),
      },
    );
  };

  const undoJob = (jobId: number, label: string) => {
    const where = sendBackTo === 'waiting_list' ? 'the waiting list' : 'the board';
    if (!window.confirm(`Undo the completion of ${label}? Its lines come off this bill and the job goes back to ${where}.`)) return;
    uncompleteJob.mutate(
      { id: jobId, data: { sendTo: sendBackTo } },
      {
        onSuccess: (r) => {
          refresh();
          toast({
            title: 'Completion undone',
            description: r.invoiceVoided ? `Invoice #${r.invoiceNumber ?? r.invoiceId} was voided — nothing was left on it.` : undefined,
          });
          if (r.invoiceVoided) onClose();
        },
        onError: failed('Could not undo the completion'),
      },
    );
  };

  const send = () => {
    const question = invoice.sentAt
      ? `This invoice was already emailed on ${dayLabel(invoice.sentAt)}. Send it again?`
      : `Email invoice #${invoice.number} to ${invoice.clientEmail ?? invoice.clientName}?`;
    if (!window.confirm(question)) return;
    sendInvoice.mutate(
      { id: invoice.id, data: {} },
      {
        onSuccess: (r) => {
          refresh();
          toast({ title: `Invoice emailed to ${r.toEmail ?? 'the customer'}` });
        },
        onError: failed('Could not send the invoice'),
      },
    );
  };

  const voidIt = () => {
    const paid = invoice.amountPaid > 0 ? ` The ${money(invoice.amountPaid)} already paid stays on the account as credit.` : '';
    if (!window.confirm(`Void invoice #${invoice.number} (${money(invoice.total)})? The customer will no longer owe it.${paid}`)) return;
    updateInvoice.mutate(
      { id: invoice.id, data: { status: 'void' } },
      { onSuccess: () => { refresh(); toast({ title: `Invoice #${invoice.number} voided` }); }, onError: failed('Could not void the invoice') },
    );
  };

  const remove = (force = false) => {
    const warn = force
      ? `Delete invoice #${invoice.number} anyway? Any money paid on it stays on the account as credit.`
      : `Delete invoice #${invoice.number} for good? Its job goes back to "completed, not invoiced" so it can be billed again. If this is the newest invoice its number will be reused; otherwise the number is gone.`;
    if (!window.confirm(warn)) return;
    deleteInvoice.mutate(
      { id: invoice.id, data: { force } },
      {
        onSuccess: () => {
          refresh();
          toast({ title: `Invoice #${invoice.number} deleted` });
          onClose();
        },
        onError: (error) => {
          const msg = errorText(error);
          if (!force && /void it instead|delete anyway/i.test(msg)) {
            if (window.confirm(`${msg}\n\nDelete anyway?`)) remove(true);
            return;
          }
          failed('Could not delete the invoice')(error);
        },
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-3">
          <span>Invoice #{invoice.number}</span>
          <StatusPill status={invoice.status} />
          <span className="text-sm font-normal text-muted-foreground">
            {invoice.clientName}
            {invoice.clientAddress ? ` · ${invoice.clientAddress}` : ''}
          </span>
        </DialogTitle>
      </DialogHeader>

      {/* The three numbers he asked to see side by side before a bill goes out. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Figure label="Invoice total" value={money(dirty ? draftTotal : invoice.total)} hint={dirty ? 'unsaved' : undefined} />
        <Figure label="Invoice balance" value={money(invoice.balance)} tone={invoice.balance > 0 ? 'due' : 'ok'} />
        <Figure label="Account balance" value={money(invoice.accountBalance)} tone={invoice.accountBalance > 0 ? 'due' : 'ok'} />
        <Figure
          label="Credit on account"
          value={money(invoice.unappliedCredit ?? 0)}
          hint={(invoice.unappliedCredit ?? 0) > 0 && invoice.balance > 0 ? 'can be applied' : undefined}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {invoice.serviceName && <span>Job: {invoice.serviceName}</span>}
        {invoice.terms && <span>Terms: {invoice.terms}</span>}
        {invoice.dueDate && <span>Due: {dayLabel(invoice.dueDate)}</span>}
        {invoice.daysPastDue > 0 && <span className="text-destructive font-medium">{invoice.daysPastDue} days past due</span>}
        {invoice.verifiedAt && <span>Verified {momentLabel(invoice.verifiedAt)}</span>}
        {invoice.deliveryMethod && <span>Goes out by {DELIVERY_LABEL[invoice.deliveryMethod] ?? invoice.deliveryMethod}</span>}
        {invoice.sentAt && <span>Emailed {momentLabel(invoice.sentAt)}</span>}
        {invoice.printedAt && <span>Printed {momentLabel(invoice.printedAt)}</span>}
        {invoice.lastPaymentMethod && <span>Pays by {methodLabel(invoice.lastPaymentMethod)}</span>}
        {invoice.clientDoNotEmail && <span className="text-destructive font-medium">Do not email</span>}
      </div>

      <Tabs defaultValue="bill" className="mt-2">
        <TabsList>
          <TabsTrigger value="bill">Bill</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="bill" className="space-y-4 pt-3">
          {!editable && (
            <p className="text-sm text-muted-foreground">
              This invoice is {invoice.status === 'void' ? 'void' : 'paid in full'}, so its lines are locked.
            </p>
          )}
          <div className="space-y-2">
            <div className="hidden sm:grid grid-cols-12 gap-2 text-xs text-muted-foreground px-1">
              <div className="col-span-5">Description</div>
              <div className="col-span-2">Service date</div>
              <div className="col-span-1 text-right">Qty</div>
              <div className="col-span-2 text-right">Rate</div>
              <div className="col-span-1 text-right">Total</div>
              <div className="col-span-1" />
            </div>
            {lines.map((line) => (
              <div key={line.key} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                <div className="sm:col-span-5">
                  <Input
                    value={line.description}
                    disabled={!editable}
                    onChange={(e) => updateLine(line.key, { description: e.target.value })}
                    placeholder="What was done"
                  />
                  {line.jobId != null && (
                    <button
                      type="button"
                      className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-destructive"
                      disabled={busy}
                      onClick={() => undoJob(line.jobId!, `job #${line.jobId}`)}
                    >
                      Take job #{line.jobId} off this bill and send it back
                    </button>
                  )}
                </div>
                <Input
                  type="date"
                  className="sm:col-span-2"
                  value={line.serviceDate}
                  disabled={!editable}
                  onChange={(e) => updateLine(line.key, { serviceDate: e.target.value })}
                />
                <Input
                  type="number"
                  step="0.01"
                  className="sm:col-span-1 text-right"
                  value={line.quantity}
                  disabled={!editable}
                  onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                />
                <Input
                  type="number"
                  step="0.01"
                  className="sm:col-span-2 text-right"
                  value={line.unitPrice}
                  disabled={!editable}
                  onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })}
                  placeholder="0.00"
                />
                <div className="sm:col-span-1 text-right text-sm font-semibold tabular-nums">{money(lineTotal(line))}</div>
                <div className="sm:col-span-1 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 text-muted-foreground"
                    disabled={!editable}
                    onClick={() => removeLine(line.key)}
                    aria-label="Remove line"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {editable && (
            <div className="flex flex-wrap items-end gap-2">
              <Button size="sm" variant="outline" className="h-9" onClick={() => { touch(); setLines((p) => [...p, emptyLine()]); }}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add line
              </Button>
              <div className="flex items-end gap-1">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Add a service</label>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm max-w-[220px]"
                    value={serviceId}
                    onChange={(e) => setServiceId(e.target.value)}
                  >
                    <option value="">Pick a service…</option>
                    {services?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} — {money(s.rate)}
                      </option>
                    ))}
                  </select>
                </div>
                <Button size="sm" variant="outline" className="h-9" disabled={!serviceId} onClick={addFromService}>
                  Add
                </Button>
              </div>
              <div className="flex items-end gap-1">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Add a missed job {missedJobs.length ? `(${missedJobs.length} not billed)` : ''}
                  </label>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm max-w-[260px]"
                    value={missedJobId}
                    onChange={(e) => setMissedJobId(e.target.value)}
                    disabled={missedJobs.length === 0}
                  >
                    <option value="">{missedJobs.length ? 'Pick a job…' : 'No completed jobs waiting to be billed'}</option>
                    {missedJobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        #{j.id} {j.serviceName ?? 'Job'} · {dayLabel(j.scheduledDate)} · {money(j.amount)}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9"
                  disabled={!missedJobId || dirty || attachJob.isPending}
                  title={dirty ? 'Save your changes first' : undefined}
                  onClick={addMissedJob}
                >
                  Add
                </Button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="text-sm font-medium mb-1 block">Note to the customer</label>
              <Textarea
                value={notes}
                disabled={!editable}
                onChange={(e) => { touch(); setNotes(e.target.value); }}
                placeholder="Prints on the bill under the lines"
                className="min-h-[70px]"
              />
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Invoice date</label>
                <Input type="date" value={invoiceDate} disabled={!editable} onChange={(e) => { touch(); setInvoiceDate(e.target.value); }} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">PO number</label>
                <Input value={poNumber} disabled={!editable} onChange={(e) => { touch(); setPoNumber(e.target.value); }} placeholder="Optional" />
              </div>
            </div>
          </div>

          {invoice.jobId != null && editable && !wentOut && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3 text-sm">
              <Undo2 className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">Marked complete by mistake?</span>
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                value={sendBackTo}
                onChange={(e) => setSendBackTo(e.target.value as 'board' | 'waiting_list')}
              >
                <option value="board">Back on the board</option>
                <option value="waiting_list">Back to the waiting list</option>
              </select>
              <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => undoJob(invoice.jobId!, `job #${invoice.jobId}`)}>
                Undo completion
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="payments" className="pt-3">
          <InvoicePayments invoice={invoice} />
        </TabsContent>

        <TabsContent value="history" className="pt-3">
          <InvoiceHistory invoiceId={invoice.id} />
        </TabsContent>
      </Tabs>

      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" className="h-9 text-muted-foreground" onClick={() => openPdf(`/api/invoices/${invoice.id}/pdf`)}>
            <FileText className="w-3.5 h-3.5 mr-1.5" /> PDF
          </Button>
          {invoice.status !== 'void' && !isPending && (
            <Button size="sm" variant="ghost" className="h-9" onClick={send} disabled={busy}>
              <Send className="w-3.5 h-3.5 mr-1.5" /> {invoice.sentAt ? 'Resend' : 'Email'}
            </Button>
          )}
          {invoice.status !== 'void' && (
            <Button size="sm" variant="ghost" className="h-9 text-muted-foreground" onClick={voidIt} disabled={busy}>
              Void
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-9 text-muted-foreground hover:text-destructive" onClick={() => remove(false)} disabled={busy}>
            <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {editable && (
            <Button variant={isPending ? 'outline' : 'default'} onClick={() => save()} disabled={busy || !dirty}>
              {updateInvoice.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          )}
          {isPending && (
            <Button onClick={verify} disabled={busy}>
              <CheckCircle2 className="w-4 h-4 mr-1.5" />
              {verifyInvoice.isPending ? 'Verifying…' : dirty ? 'Save & verify' : 'Verify'}
            </Button>
          )}
        </div>
      </DialogFooter>
    </>
  );
}

function Figure({ label, value, tone, hint }: { label: string; value: string; tone?: 'due' | 'ok'; hint?: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-base font-bold tabular-nums ${tone === 'due' ? 'text-destructive' : tone === 'ok' ? 'text-primary' : ''}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function InvoicePayments({ invoice }: { invoice: Invoice }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: payments, isLoading } = useListPayments(
    { clientId: invoice.clientId },
    { query: { queryKey: ['/api/payments', { clientId: invoice.clientId }] } },
  );
  const deletePayment = useDeletePayment();
  const mine = (payments ?? []).filter((p) => p.invoiceId === invoice.id);
  const canPay = invoice.status !== 'void' && invoice.balance > 0;

  const remove = (id: number, amount: number) => {
    if (!window.confirm(`Delete the ${money(amount)} payment? The invoice will be owed again.`)) return;
    deletePayment.mutate(
      { id },
      {
        onSuccess: () => { invalidateBilling(queryClient, invoice.clientId, invoice.id); toast({ title: 'Payment deleted' }); },
        onError: (error) => toast({ title: 'Could not delete the payment', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          Paid {money(invoice.amountPaid)} of {money(invoice.total)} ·{' '}
          <span className={invoice.balance > 0 ? 'text-destructive font-semibold' : 'text-primary font-semibold'}>{money(invoice.balance)} due</span>
        </span>
        {canPay && (
          <div className="flex gap-2">
            {(invoice.unappliedCredit ?? 0) > 0 && <ApplyCreditDialog invoice={invoice} balanceDue={invoice.balance} />}
            <RecordPaymentDialog invoice={invoice} balanceDue={invoice.balance} defaultMethod={invoice.lastPaymentMethod} />
          </div>
        )}
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments on this invoice yet.</p>
      ) : (
        <div className="divide-y rounded-md border">
          {mine.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <div>
                <span className="font-semibold">{money(p.amount)}</span>
                <span className="text-muted-foreground"> · {dayLabel(p.createdAt)} · {methodLabel(p.method)}{p.reference ? ` · ${p.reference}` : ''}</span>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove(p.id, p.amount)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InvoiceHistory({ invoiceId }: { invoiceId: number }) {
  const { data: events, isLoading } = useListInvoiceAudit(invoiceId, {
    query: { queryKey: [`/api/invoices/${invoiceId}/audit`] },
  });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading history…</p>;
  if (!events?.length) return <p className="text-sm text-muted-foreground">Nothing has happened to this invoice yet.</p>;
  return (
    <div className="space-y-3">
      {events.map((e) => (
        <div key={e.id} className="text-sm flex gap-4">
          <span className="w-36 shrink-0 text-xs text-muted-foreground font-medium">{momentLabel(e.createdAt)}</span>
          <div>
            <div className="text-foreground">{e.description}</div>
            <div className="text-xs text-muted-foreground">
              {e.actorName ?? 'System'} · {e.action.replace(/_/g, ' ')}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
