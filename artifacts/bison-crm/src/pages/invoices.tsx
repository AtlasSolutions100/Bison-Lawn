import { useEffect, useMemo, useState } from 'react';
import {
  useListInvoices,
  useVerifyInvoice,
  useEmailInvoices,
  useListPayments,
  useDeletePayment,
  useListClients,
  useCreateInvoice,
  type Invoice,
  type InvoiceBatchEmailResult,
  type Payment,
  type ListInvoicesQueue,
  type ListPaymentsMethod,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearch } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CheckCircle2, Download, FileText, Mail, Plus, Printer, Search, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { InvoiceDialog } from '@/components/billing/invoice-dialog';
import { RecordPaymentDialog, ApplyPaymentToInvoiceDialog } from '@/components/billing/payment-dialogs';
import {
  PAYMENT_METHODS,
  StatusPill,
  dayLabel,
  downloadCsv,
  errorText,
  invalidateBilling,
  methodLabel,
  money,
  officeDay,
  openPdf,
} from '@/components/billing/shared';

/**
 * His invoice queues, in the order a bill moves through them: a completed
 * job lands in "Needs verification", Verify sends it to "To email" or "To
 * print" by the customer's preference, and from there it sits in Open (with
 * days past due and how they pay) until it is paid. Nothing is emailed until
 * he says so.
 */

type QueueKey = ListInvoicesQueue | 'all' | 'payments';

const QUEUES: { key: QueueKey; label: string; blurb: string }[] = [
  { key: 'pending', label: 'Needs verification', blurb: 'Completed jobs whose bill you have not checked yet. Nothing here has gone to the customer.' },
  { key: 'to_email', label: 'To email', blurb: 'Verified and waiting to be emailed with the Bison bill letter and the PDF.' },
  { key: 'to_print', label: 'To print', blurb: 'Verified and waiting to be printed. Print all makes one PDF, one bill per page.' },
  { key: 'open', label: 'Open', blurb: 'Everything still owed.' },
  { key: 'past_due', label: 'Past due', blurb: 'Owed and past the due date (the invoice date when terms are due on receipt).' },
  { key: 'paid', label: 'Paid', blurb: 'Paid in full.' },
  { key: 'void', label: 'Void', blurb: 'Cancelled bills, kept for the record.' },
  { key: 'all', label: 'All', blurb: 'Every invoice.' },
  { key: 'payments', label: 'Payments', blurb: 'Every payment and credit, searchable.' },
];

export default function Invoices() {
  // A client page deep-links here as /invoices?clientId=<id>. The filter stays in
  // the URL so it is shareable, and it is announced above the table — an unexplained
  // short list is worse than no filter at all.
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(searchString);
  const clientIdParam = params.get('clientId');
  const clientFilter = clientIdParam && /^\d+$/.test(clientIdParam) ? Number(clientIdParam) : null;
  const tabParam = params.get('tab');
  const [queue, setQueue] = useState<QueueKey>(
    () => (QUEUES.some((q) => q.key === tabParam) ? (tabParam as QueueKey) : clientFilter ? 'all' : 'pending'),
  );
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: filterClients } = useListClients();
  const filterLabel =
    clientFilter == null ? null : (filterClients?.find((c) => c.id === clientFilter)?.name ?? `client #${clientFilter}`);

  const listParams = {
    ...(queue !== 'all' && queue !== 'payments' ? { queue } : {}),
    ...(debounced ? { search: debounced } : {}),
    ...(clientFilter != null ? { clientId: clientFilter } : {}),
  };
  const { data: invoices, isLoading } = useListInvoices(listParams, {
    query: { enabled: queue !== 'payments', queryKey: ['/api/invoices', listParams] },
  });
  // The one count that matters at a glance: how much is waiting on him.
  const { data: pendingList } = useListInvoices(
    { queue: 'pending' },
    { query: { queryKey: ['/api/invoices', { queue: 'pending' }] } },
  );
  const pendingCount = pendingList?.length ?? 0;

  const current = QUEUES.find((q) => q.key === queue)!;

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col min-h-[calc(100vh-2rem)]">
      <div className="flex flex-wrap justify-between items-start gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Invoices & Payments</h1>
          {filterLabel ? (
            <p className="text-muted-foreground mt-1">
              Showing <span className="font-medium text-foreground">{filterLabel}</span> only.{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => setLocation('/invoices', { replace: true })}
              >
                Show everyone
              </button>
            </p>
          ) : (
            <p className="text-muted-foreground mt-1">Check each bill, send it, and see what is still owed.</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-3 text-muted-foreground" />
            <Input
              className="pl-9 w-64"
              placeholder={queue === 'payments' ? 'Name, check #, amount, invoice #' : 'Name, address or invoice #'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <NewInvoiceDialog />
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {QUEUES.map((q) => (
          <button
            key={q.key}
            type="button"
            onClick={() => setQueue(q.key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              queue === q.key ? 'border-primary text-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {q.label}
            {q.key === 'pending' && pendingCount > 0 && (
              <span className="ml-2 inline-flex items-center justify-center rounded-full bg-accent text-accent-foreground text-xs font-semibold px-1.5 min-w-[1.25rem]">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground -mt-3">{current.blurb}</p>

      {queue === 'payments' ? (
        <PaymentsTab search={debounced} clientId={clientFilter} />
      ) : (
        <InvoiceQueue queue={queue} invoices={invoices} isLoading={isLoading} />
      )}
    </div>
  );
}

// ------------------------------------------------------------- queues ----

function InvoiceQueue({ queue, invoices, isLoading }: { queue: QueueKey; invoices: Invoice[] | undefined; isLoading: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const [batch, setBatch] = useState<InvoiceBatchEmailResult | null>(null);
  const emailInvoices = useEmailInvoices();
  const verifyInvoice = useVerifyInvoice();

  // A fresh queue is a fresh selection: ticks from the last tab must not
  // ride along into "Email all".
  useEffect(() => {
    setSelected(new Set());
    setBatch(null);
  }, [queue]);

  const rows = invoices ?? [];
  const batchable = queue === 'to_email' || queue === 'to_print';
  const chosen = rows.filter((r) => selected.has(r.id));
  const targets = chosen.length ? chosen : rows;
  const allTicked = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const emailAll = () => {
    const ids = targets.map((r) => r.id);
    if (ids.length === 0) return;
    const noEmail = targets.filter((r) => !r.clientEmail).length;
    const note = noEmail ? ` ${noEmail} of them have no email address on file and will be skipped.` : '';
    if (!window.confirm(`Email ${ids.length} invoice${ids.length === 1 ? '' : 's'} now?${note}`)) return;
    emailInvoices.mutate(
      { data: { ids } },
      {
        onSuccess: (result) => {
          setBatch(result);
          setSelected(new Set());
          invalidateBilling(queryClient);
          toast({
            title: `${result.sent} of ${ids.length} emailed`,
            description:
              result.skipped.length || result.failed.length
                ? `${result.skipped.length} skipped, ${result.failed.length} failed — see the list below.`
                : undefined,
            variant: result.failed.length ? 'destructive' : 'default',
          });
        },
        onError: (error) => toast({ title: 'Could not email the invoices', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  const printAll = () => {
    const ids = targets.map((r) => r.id);
    if (ids.length === 0) return;
    openPdf(`/api/invoices/print.pdf?ids=${ids.join(',')}`);
    // The print stamps each invoice on the server; give the tab a moment to
    // fetch before this list refreshes and the rows leave the queue.
    setTimeout(() => invalidateBilling(queryClient), 2500);
    setSelected(new Set());
  };

  const verify = (inv: Invoice) => {
    verifyInvoice.mutate(
      { id: inv.id },
      {
        onSuccess: (v) => {
          invalidateBilling(queryClient, inv.clientId, inv.id);
          toast({ title: `Invoice #${v.number} verified`, description: `Now waiting to be ${v.deliveryMethod === 'print' ? 'printed' : v.deliveryMethod === 'both' ? 'emailed and printed' : 'emailed'}.` });
        },
        onError: (error) => toast({ title: 'Could not verify', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  const showDue = queue === 'open' || queue === 'past_due' || queue === 'all' || queue === 'to_email' || queue === 'to_print';
  const cols = 10 + (batchable ? 1 : 0);

  return (
    <div className="space-y-3 flex-1 flex flex-col">
      {batchable && (
        <div className="flex flex-wrap items-center gap-2">
          {queue === 'to_email' ? (
            <Button size="sm" onClick={emailAll} disabled={rows.length === 0 || emailInvoices.isPending}>
              <Mail className="w-4 h-4 mr-2" />
              {emailInvoices.isPending ? 'Emailing…' : chosen.length ? `Email ${chosen.length} selected` : `Email all (${rows.length})`}
            </Button>
          ) : (
            <Button size="sm" onClick={printAll} disabled={rows.length === 0}>
              <Printer className="w-4 h-4 mr-2" />
              {chosen.length ? `Print ${chosen.length} selected` : `Print all (${rows.length})`}
            </Button>
          )}
          {chosen.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {queue === 'to_email'
              ? 'One email per customer, sent in order. Only customers with no address on file are skipped and listed — a bill still goes out to customers marked do-not-email, since that box is for bulk notices. Set a customer to Print on their Billing tab to keep their bill off email.'
              : 'Opens one PDF with every bill on its own page, and marks each one printed.'}
          </span>
        </div>
      )}

      {batch && (batch.skipped.length > 0 || batch.failed.length > 0) && (
        <Alert variant={batch.failed.length ? 'destructive' : 'default'}>
          <AlertTitle>
            {batch.sent} sent, {batch.skipped.length} skipped, {batch.failed.length} failed
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-0.5 text-sm">
              {[...batch.failed.map((o) => ({ ...o, kind: 'failed' })), ...batch.skipped.map((o) => ({ ...o, kind: 'skipped' }))].map((o) => (
                <li key={`${o.kind}-${o.invoiceId}`}>
                  #{o.number} {o.clientName ?? ''} — {o.kind === 'skipped' ? SKIP_REASON[o.reason] ?? o.reason : o.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              {batchable && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allTicked}
                    onCheckedChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())}
                    aria-label="Select all"
                  />
                </TableHead>
              )}
              <TableHead className="w-20">#</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>{showDue ? 'Due' : 'Job'}</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Pays by</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Invoice balance</TableHead>
              <TableHead className="text-right">Account balance</TableHead>
              <TableHead className="w-64"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={cols} className="text-center py-6 text-muted-foreground">Loading…</TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={cols} className="text-center py-6 text-muted-foreground">
                  {queue === 'pending' ? 'Nothing waiting to be verified.' : 'No invoices here.'}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((inv) => (
                <TableRow key={inv.id} className="hover:bg-muted/50">
                  {batchable && (
                    <TableCell>
                      <Checkbox checked={selected.has(inv.id)} onCheckedChange={() => toggle(inv.id)} aria-label={`Select invoice ${inv.number}`} />
                    </TableCell>
                  )}
                  <TableCell className="font-mono text-sm">
                    <button type="button" className="underline underline-offset-2 hover:text-primary" onClick={() => setOpenId(inv.id)}>
                      #{inv.number}
                    </button>
                    {inv.terms && <div className="text-xs text-muted-foreground">{inv.terms}</div>}
                  </TableCell>
                  <TableCell className="font-medium text-foreground">
                    <div>{inv.clientName}</div>
                    {inv.clientAddress && <div className="text-xs font-normal text-muted-foreground">{inv.clientAddress}</div>}
                    {(inv.unappliedCredit ?? 0) > 0 && inv.balance > 0 && (
                      <div className="text-xs font-normal text-primary">{money(inv.unappliedCredit)} credit on account</div>
                    )}
                    {inv.clientDoNotEmail && queue === 'to_email' && (
                      <div className="text-xs font-normal text-muted-foreground">Do-not-email (bulk notices only — the bill still goes)</div>
                    )}
                    {!inv.clientEmail && queue === 'to_email' && <div className="text-xs font-normal text-destructive">No email on file</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap">{dayLabel(inv.invoiceDate ?? inv.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {showDue ? (
                      <>
                        <div className="text-muted-foreground">{dayLabel(inv.dueDate ?? inv.invoiceDate)}</div>
                        {inv.daysPastDue > 0 && <div className="text-xs font-semibold text-destructive">{inv.daysPastDue} days past due</div>}
                      </>
                    ) : (
                      <span className="text-muted-foreground">{inv.serviceName ?? (inv.jobId ? `Job #${inv.jobId}` : 'Manual')}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusPill status={inv.status} />
                    {!inv.needsVerification && inv.deliveryMethod && (
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {inv.sentAt ? `emailed ${dayLabel(inv.sentAt)}` : inv.printedAt ? `printed ${dayLabel(inv.printedAt)}` : `by ${inv.deliveryMethod}`}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{methodLabel(inv.lastPaymentMethod)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{money(inv.total)}</TableCell>
                  <TableCell className={`text-right font-bold tabular-nums ${inv.balance > 0 ? 'text-destructive' : 'text-primary'}`}>{money(inv.balance)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${inv.accountBalance > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{money(inv.accountBalance)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap space-x-1">
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setOpenId(inv.id)}>
                      Open
                    </Button>
                    {inv.needsVerification && (
                      <Button size="sm" className="h-8" onClick={() => verify(inv)} disabled={verifyInvoice.isPending}>
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Verify
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={() => openPdf(`/api/invoices/${inv.id}/pdf`)}>
                      <FileText className="w-3.5 h-3.5" />
                    </Button>
                    {inv.status !== 'void' && !inv.needsVerification && inv.balance > 0 && (
                      <RecordPaymentDialog invoice={inv} balanceDue={inv.balance} defaultMethod={inv.lastPaymentMethod} />
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <InvoiceDialog invoiceId={openId} open={openId != null} onOpenChange={(o) => { if (!o) setOpenId(null); }} />
    </div>
  );
}

const SKIP_REASON: Record<string, string> = {
  no_email: 'no email on file',
  do_not_email: 'marked do not email',
  not_verified: 'not verified yet',
  void: 'void',
  already_sent: 'already emailed',
};

// ---------------------------------------------------------- payments ----

function PaymentsTab({ search, clientId }: { search: string; clientId: number | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [method, setMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [unappliedOnly, setUnappliedOnly] = useState(false);

  const params = {
    ...(search ? { search } : {}),
    ...(method ? { method: method as ListPaymentsMethod } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(unappliedOnly ? { unapplied: true } : {}),
    ...(clientId != null ? { clientId } : {}),
  };
  const { data: payments, isLoading } = useListPayments(params, { query: { queryKey: ['/api/payments', params] } });
  const deletePayment = useDeletePayment();
  const rows = payments ?? [];
  const total = rows.reduce((s, p) => s + p.amount, 0);

  // Credit on account, by customer: the "unapplied / prepaid / overpaid" list.
  const credits = useMemo(() => {
    const map = new Map<number, { clientId: number; clientName: string; count: number; total: number; oldest: string; payments: Payment[] }>();
    for (const p of rows) {
      if (p.invoiceId != null) continue;
      const entry = map.get(p.clientId) ?? { clientId: p.clientId, clientName: p.clientName ?? `Customer #${p.clientId}`, count: 0, total: 0, oldest: p.createdAt, payments: [] };
      entry.count += 1;
      entry.total = Math.round((entry.total + p.amount) * 100) / 100;
      if (p.createdAt < entry.oldest) entry.oldest = p.createdAt;
      entry.payments.push(p);
      map.set(p.clientId, entry);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [rows]);

  const remove = (p: Payment) => {
    if (!window.confirm(`Delete the ${money(p.amount)} payment from ${p.clientName ?? 'this customer'}?${p.invoiceId ? ` Invoice #${p.invoiceNumber} will be owed again.` : ''}`)) return;
    deletePayment.mutate(
      { id: p.id },
      {
        onSuccess: () => { invalidateBilling(queryClient, p.clientId, p.invoiceId); toast({ title: 'Payment deleted' }); },
        onError: (error) => toast({ title: 'Could not delete the payment', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  const exportCsv = () =>
    downloadCsv(
      `payments-${officeDay(new Date().toISOString())}.csv`,
      ['Date', 'Customer', 'Method', 'Reference', 'Invoice #', 'Amount', 'Applied', 'Notes'],
      rows.map((p) => [
        // The day he took it, on his clock — an evening payment used to export
        // dated the next day and would not match his deposit.
        officeDay(p.createdAt),
        p.clientName ?? '',
        methodLabel(p.method),
        p.reference ?? '',
        p.invoiceNumber ?? '',
        p.amount.toFixed(2),
        p.invoiceId != null ? 'yes' : 'credit on account',
        p.notes ?? '',
      ]),
    );

  return (
    <div className="space-y-3 flex-1 flex flex-col">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Method</label>
          <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">Any</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{methodLabel(m)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">From</label>
          <Input type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">To</label>
          <Input type="date" className="h-9" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm h-9 cursor-pointer">
          <Checkbox checked={unappliedOnly} onCheckedChange={(v) => setUnappliedOnly(Boolean(v))} />
          Credit on account only (unapplied, prepaid, overpaid)
        </label>
        <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
          <span>
            {rows.length} payment{rows.length === 1 ? '' : 's'} · {money(total)}
          </span>
          <Button size="sm" variant="outline" className="h-9" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="w-3.5 h-3.5 mr-1.5" /> CSV
          </Button>
        </div>
      </div>

      {unappliedOnly && credits.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {credits.map((c) => (
            <div key={c.clientId} className="rounded-lg border bg-card p-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold">{c.clientName}</div>
                <div className="text-xs text-muted-foreground">
                  {c.count} credit{c.count === 1 ? '' : 's'} · oldest {dayLabel(c.oldest)}
                </div>
                <div className="text-lg font-bold text-primary">{money(c.total)}</div>
              </div>
              <ApplyPaymentToInvoiceDialog
                payment={c.payments[0]}
                trigger={<Button size="sm">Apply {money(c.payments[0].amount)}</Button>}
              />
            </div>
          ))}
        </div>
      )}

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-44"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">No payments match.</TableCell></TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap">{dayLabel(p.createdAt)}</TableCell>
                  <TableCell className="font-medium">{p.clientName ?? `Customer #${p.clientId}`}</TableCell>
                  <TableCell>{methodLabel(p.method)}</TableCell>
                  <TableCell className="text-muted-foreground">{p.reference || '—'}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.invoiceId != null ? `#${p.invoiceNumber ?? p.invoiceId}` : <span className="text-primary text-xs font-semibold">Credit on account</span>}
                  </TableCell>
                  <TableCell className="text-right font-bold text-primary tabular-nums">{money(p.amount)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap space-x-1">
                    {p.invoiceId == null && <ApplyPaymentToInvoiceDialog payment={p} />}
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove(p)} aria-label="Delete payment">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ------------------------------------------------------- new invoice ----

type DraftLine = { description: string; serviceDate: string; quantity: string; unitPrice: string };
const emptyLine = (): DraftLine => ({ description: '', serviceDate: '', quantity: '1', unitPrice: '' });

function NewInvoiceDialog() {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);

  const { data: clients } = useListClients();
  const createInvoice = useCreateInvoice();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const selectedClient = clients?.find((c) => String(c.id) === clientId);

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
    setClientId('');
    setPoNumber('');
    setNotes('');
    setLines([emptyLine()]);
  };

  const handleSave = () => {
    createInvoice.mutate(
      {
        data: {
          clientId: parseInt(clientId),
          lines: parsedLines,
          ...(poNumber.trim() && { poNumber: poNumber.trim() }),
          ...(notes && { notes }),
        },
      },
      {
        onSuccess: (inv) => {
          invalidateBilling(queryClient, inv.clientId);
          toast({ title: `Invoice #${inv.number} created`, description: `It is in the ${inv.deliveryMethod === 'print' ? 'To print' : 'To email'} queue.` });
          setOpen(false);
          reset();
        },
        onError: (error) => toast({ title: 'Could not create the invoice', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-10 bg-primary text-primary-foreground font-semibold shadow-sm px-4">
          <Plus className="w-4 h-4 mr-2" /> New invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New invoice</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4 max-h-[65vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Customer *</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Pick a customer…</option>
                {clients?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} - {c.serviceAddress}, {c.city}
                  </option>
                ))}
              </select>
              {/* Terms are not editable here: they come from the account and are
                  snapshotted at issue. Showing which ones will apply prevents an
                  invoice going out on terms the office did not expect. */}
              {selectedClient?.billingTerms && <p className="text-xs text-muted-foreground mt-1">Terms: {selectedClient.billingTerms}</p>}
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">PO number (optional)</label>
              <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="Customer's reference" />
            </div>
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
                  <Input className="sm:col-span-5" value={line.description} onChange={(e) => updateLine(index, { description: e.target.value })} placeholder="Mowing — 8/12, 8/19, 8/26" />
                  <Input type="date" className="sm:col-span-3" value={line.serviceDate} onChange={(e) => updateLine(index, { serviceDate: e.target.value })} />
                  <Input type="number" step="0.01" className="sm:col-span-1 text-right" value={line.quantity} onChange={(e) => updateLine(index, { quantity: e.target.value })} />
                  <Input type="number" step="0.01" className="sm:col-span-2 text-right" value={line.unitPrice} onChange={(e) => updateLine(index, { unitPrice: e.target.value })} placeholder="0.00" />
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
            <textarea className="flex min-h-[70px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Prints on the bill" />
          </div>
          <p className="text-xs text-muted-foreground">
            A bill you type yourself is already checked, so it goes straight to the email or print queue.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createInvoice.isPending || !clientId || parsedLines.length === 0 || total <= 0}>
            Create invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
