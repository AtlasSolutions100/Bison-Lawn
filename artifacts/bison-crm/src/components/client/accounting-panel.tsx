import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetClient,
  useListInvoices,
  useListPayments,
  useDeletePayment,
  useDeleteInvoice,
  useUpdateInvoice,
  useSendInvoice,
  useVerifyInvoice,
  type Invoice,
  type Payment,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, DollarSign, FileText, Send, Trash2 } from 'lucide-react';
import { InvoiceDialog } from '@/components/billing/invoice-dialog';
import { AddPaymentDialog, ApplyPaymentToInvoiceDialog } from '@/components/billing/payment-dialogs';
import NewClientInvoiceDialog from '@/components/billing/new-invoice-dialog';
import AccountSummaryStrip from '@/components/billing/account-summary';
import { StatusPill, dayLabel, errorText, invalidateBilling, methodLabel, money, officeDay, openPdf } from '@/components/billing/shared';

/**
 * The Accounting tab on a customer's page: what they owe, what they have
 * paid, and a running statement — with add payment, apply credit, and the
 * delete buttons his old CRM had, so a wrong entry is fixed on the account
 * rather than on the global invoices screen.
 */
export default function ClientAccountingPanel({ clientId }: { clientId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: client } = useGetClient(clientId, { query: { queryKey: [`/api/clients/${clientId}`] } });
  const { data: invoices, isLoading: loadingInvoices } = useListInvoices(
    { clientId },
    { query: { queryKey: ['/api/invoices', { clientId }] } },
  );
  const { data: payments, isLoading: loadingPayments } = useListPayments(
    { clientId },
    { query: { queryKey: ['/api/payments', { clientId }] } },
  );
  const [openId, setOpenId] = useState<number | null>(null);

  const deletePayment = useDeletePayment();
  const deleteInvoice = useDeleteInvoice();
  const updateInvoice = useUpdateInvoice();
  const sendInvoice = useSendInvoice();
  const verifyInvoice = useVerifyInvoice();

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: errorText(error), variant: 'destructive' });
  const refresh = (invoiceId?: number | null) => invalidateBilling(queryClient, clientId, invoiceId);

  const rows = invoices ?? [];
  const pays = payments ?? [];
  const credit = client?.unappliedCredit ?? 0;
  const pendingCount = rows.filter((i) => i.needsVerification).length;

  // Only bills that have actually been issued count against the customer, so
  // this box, the statement below it and the balance printed on their bill all
  // say the same number. A completion nobody has checked yet is not theirs to
  // owe — and money taken at the door for it is set aside with it, rather than
  // showing up as a credit they could ask for back.
  const unissued = new Set(rows.filter((i) => i.needsVerification).map((i) => i.id));
  const issued = rows.filter((i) => i.status !== 'void' && !i.needsVerification);
  const balance =
    Math.round(
      (issued.reduce((s, i) => s + i.total, 0) -
        pays.filter((p) => p.invoiceId == null || !unissued.has(p.invoiceId)).reduce((s, p) => s + p.amount, 0)) *
        100,
    ) / 100;
  const owed = issued.filter((i) => i.balance > 0).reduce((s, i) => s + i.balance, 0);

  const removePayment = (p: Payment) => {
    if (!window.confirm(`Delete the ${money(p.amount)} payment?${p.invoiceId ? ` Invoice #${p.invoiceNumber} will be owed again.` : ''}`)) return;
    deletePayment.mutate({ id: p.id }, { onSuccess: () => { refresh(p.invoiceId); toast({ title: 'Payment deleted' }); }, onError: failed('Could not delete the payment') });
  };

  const removeInvoice = (inv: Invoice, force = false) => {
    const q = force
      ? `Delete invoice #${inv.number} anyway? Money paid on it stays on the account as credit.`
      : `Delete invoice #${inv.number} (${money(inv.total)}) for good? Its job goes back to "completed, not invoiced". Void keeps a record instead.`;
    if (!window.confirm(q)) return;
    deleteInvoice.mutate(
      { id: inv.id, data: { force } },
      {
        onSuccess: () => { refresh(inv.id); toast({ title: `Invoice #${inv.number} deleted` }); },
        onError: (error) => {
          const msg = errorText(error);
          if (!force && /void it instead|delete anyway/i.test(msg)) {
            if (window.confirm(`${msg}\n\nDelete anyway?`)) removeInvoice(inv, true);
            return;
          }
          failed('Could not delete the invoice')(error);
        },
      },
    );
  };

  const voidInvoice = (inv: Invoice) => {
    const paid = inv.amountPaid > 0 ? ` The ${money(inv.amountPaid)} already paid stays as credit.` : '';
    if (!window.confirm(`Void invoice #${inv.number} (${money(inv.total)})? They will no longer owe it.${paid}`)) return;
    updateInvoice.mutate({ id: inv.id, data: { status: 'void' } }, { onSuccess: () => { refresh(inv.id); toast({ title: `Invoice #${inv.number} voided` }); }, onError: failed('Could not void the invoice') });
  };

  const send = (inv: Invoice) => {
    const q = inv.sentAt ? `Invoice #${inv.number} was already emailed ${dayLabel(inv.sentAt)}. Send again?` : `Email invoice #${inv.number} to ${inv.clientEmail ?? client?.name}?`;
    if (!window.confirm(q)) return;
    sendInvoice.mutate({ id: inv.id, data: {} }, { onSuccess: (r) => { refresh(inv.id); toast({ title: `Emailed to ${r.toEmail ?? 'the customer'}` }); }, onError: failed('Could not send the invoice') });
  };

  const verify = (inv: Invoice) =>
    verifyInvoice.mutate({ id: inv.id }, { onSuccess: () => { refresh(inv.id); toast({ title: `Invoice #${inv.number} verified` }); }, onError: failed('Could not verify') });

  // The statement: every bill and every payment in date order with the
  // balance after each, oldest first, the way a bank statement reads.
  const statement = useMemo(() => {
    type Line = { key: string; date: string; label: string; charge: number; credit: number; invoiceId?: number };
    const lines: Line[] = [];
    for (const inv of rows) {
      if (inv.status === 'void' || inv.needsVerification) continue;
      lines.push({ key: `i${inv.id}`, date: officeDay(inv.invoiceDate ?? inv.createdAt), label: `Invoice #${inv.number}${inv.serviceName ? ` — ${inv.serviceName}` : ''}`, charge: inv.total, credit: 0, invoiceId: inv.id });
    }
    for (const p of pays) {
      lines.push({ key: `p${p.id}`, date: officeDay(p.createdAt), label: `Payment · ${methodLabel(p.method)}${p.reference ? ` ${p.reference}` : ''}${p.invoiceId != null ? ` on #${p.invoiceNumber ?? p.invoiceId}` : ' (credit on account)'}`, charge: 0, credit: p.amount });
    }
    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : 1));
    let running = 0;
    return lines.map((l) => {
      running = Math.round((running + l.charge - l.credit) * 100) / 100;
      return { ...l, running };
    });
  }, [rows, pays]);

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-muted-foreground" /> Accounting
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* A bill for this customer gets raised here, on their account,
                because that is where he is standing when he decides to bill
                them — and it lands in the list below before the window has
                finished closing. */}
            <NewClientInvoiceDialog clientId={clientId} clientName={client?.name} billingTerms={client?.billingTerms} />
            <AddPaymentDialog clientId={clientId} clientName={client?.name} defaultMethod={client?.preferredPaymentMethod} />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 text-sm">
          <Figure label="Account balance" value={money(balance)} tone={balance > 0 ? 'due' : 'ok'} />
          <Figure label="Open invoices" value={money(owed)} tone={owed > 0 ? 'due' : 'ok'} />
          <Figure label="Credit on account" value={money(credit)} hint={credit > 0 && owed > 0 ? 'apply it from Payments' : undefined} />
          <Figure label="How they pay" value={methodLabel(client?.preferredPaymentMethod ?? pays[0]?.method)} hint={pendingCount ? `${pendingCount} bill${pendingCount === 1 ? '' : 's'} to verify` : undefined} />
        </div>
        <div className="pt-3">
          <AccountSummaryStrip clientId={clientId} />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Tabs defaultValue="invoices">
          <TabsList className="m-3">
            <TabsTrigger value="invoices">Invoices ({rows.length})</TabsTrigger>
            <TabsTrigger value="payments">Payments ({pays.length})</TabsTrigger>
            <TabsTrigger value="statement">Statement</TabsTrigger>
          </TabsList>

          <TabsContent value="invoices" className="m-0">
            {loadingInvoices ? (
              <div className="p-6 text-center text-muted-foreground animate-pulse">Loading invoices…</div>
            ) : rows.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">No invoices yet.</div>
            ) : (
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="w-56"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono text-sm">
                        <button type="button" className="underline underline-offset-2 hover:text-primary" onClick={() => setOpenId(inv.id)}>#{inv.number}</button>
                        {inv.serviceName && <div className="text-xs text-muted-foreground">{inv.serviceName}</div>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {dayLabel(inv.invoiceDate ?? inv.createdAt)}
                        {inv.daysPastDue > 0 && <div className="text-xs font-semibold text-destructive">{inv.daysPastDue} days past due</div>}
                      </TableCell>
                      <TableCell><StatusPill status={inv.status} /></TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">{money(inv.total)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{money(inv.amountPaid)}</TableCell>
                      <TableCell className={`text-right tabular-nums font-bold ${inv.balance > 0 ? 'text-destructive' : 'text-primary'}`}>{money(inv.balance)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {inv.needsVerification && (
                          <Button size="sm" variant="outline" className="h-8 mr-1" onClick={() => verify(inv)} disabled={verifyInvoice.isPending}>
                            <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Verify
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground" title="PDF" onClick={() => openPdf(`/api/invoices/${inv.id}/pdf`)}><FileText className="w-4 h-4" /></Button>
                        {inv.status !== 'void' && !inv.needsVerification && (
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground" title={inv.sentAt ? 'Resend' : 'Email'} onClick={() => send(inv)} disabled={sendInvoice.isPending}><Send className="w-4 h-4" /></Button>
                        )}
                        {inv.status !== 'void' && (
                          <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={() => voidInvoice(inv)}>Void</Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" title="Delete" onClick={() => removeInvoice(inv)}><Trash2 className="w-4 h-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="payments" className="m-0">
            {loadingPayments ? (
              <div className="p-6 text-center text-muted-foreground animate-pulse">Loading payments…</div>
            ) : pays.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">No payments yet.</div>
            ) : (
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>On</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-44"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pays.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-nowrap">{dayLabel(p.createdAt)}</TableCell>
                      <TableCell>{methodLabel(p.method)}</TableCell>
                      <TableCell className="text-muted-foreground">{p.reference || '—'}</TableCell>
                      <TableCell>
                        {p.invoiceId != null ? (
                          <button type="button" className="underline underline-offset-2" onClick={() => setOpenId(p.invoiceId!)}>#{p.invoiceNumber ?? p.invoiceId}</button>
                        ) : (
                          <span className="text-primary text-xs font-semibold">Credit on account</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-bold text-primary">{money(p.amount)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {p.invoiceId == null && owed > 0 && <ApplyPaymentToInvoiceDialog payment={{ ...p, clientName: p.clientName ?? client?.name }} trigger={<Button size="sm" variant="outline" className="h-8 mr-1">Apply</Button>} />}
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" onClick={() => removePayment(p)} aria-label="Delete payment"><Trash2 className="w-4 h-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="statement" className="m-0">
            {statement.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">Nothing on the account yet.</div>
            ) : (
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Charge</TableHead>
                    <TableHead className="text-right">Payment</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statement.map((l) => (
                    <TableRow key={l.key}>
                      <TableCell className="whitespace-nowrap">{dayLabel(l.date)}</TableCell>
                      <TableCell>
                        {l.invoiceId ? (
                          <button type="button" className="underline underline-offset-2" onClick={() => setOpenId(l.invoiceId!)}>{l.label}</button>
                        ) : (
                          l.label
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.charge ? money(l.charge) : ''}</TableCell>
                      <TableCell className="text-right tabular-nums text-primary">{l.credit ? money(l.credit) : ''}</TableCell>
                      <TableCell className={`text-right tabular-nums font-semibold ${l.running > 0 ? 'text-destructive' : l.running < 0 ? 'text-primary' : ''}`}>{money(l.running)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>
        <InvoiceDialog invoiceId={openId} open={openId != null} onOpenChange={(o) => { if (!o) setOpenId(null); }} />
      </CardContent>
    </Card>
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
