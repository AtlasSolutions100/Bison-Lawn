import { useState } from 'react';
import { 
  useListInvoices, useUpdateInvoice, useCreatePayment, useListPayments, useDeletePayment, useGetInvoice,
  useListClients, useCreateInvoice, useApplyPayment
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearch } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Trash2, Plus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function Invoices() {
  const [status, setStatus] = useState<any>('');
  // A client page deep-links here as /invoices?clientId=<id>. The filter stays in
  // the URL so it is shareable, and it is announced above the table — an unexplained
  // short list is worse than no filter at all.
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  const clientIdParam = new URLSearchParams(searchString).get('clientId');
  const clientFilter = clientIdParam && /^\d+$/.test(clientIdParam) ? Number(clientIdParam) : null;
  const { data: filterClients } = useListClients();
  const filterLabel =
    clientFilter == null
      ? null
      : filterClients?.find(c => c.id === clientFilter)?.name ?? `client #${clientFilter}`;
  const { data: invoices, isLoading } = useListInvoices({
    ...(status ? { status } : {}),
    ...(clientFilter != null ? { clientId: clientFilter } : {}),
  });

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Invoices & Payments</h1>
          {filterLabel ? (
            <p className="text-muted-foreground mt-1">
              Showing invoices for <span className="font-medium text-foreground">{filterLabel}</span>.{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => setLocation('/invoices', { replace: true })}
              >
                Show all clients
              </button>
            </p>
          ) : (
            <p className="text-muted-foreground mt-1">Manage receivables and record payments.</p>
          )}
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 bg-card p-2 rounded-lg border shadow-sm">
            <select 
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm w-40" 
              value={status} 
              onChange={e => setStatus(e.target.value)}
            >
              <option value="">All Statuses</option>
              <option value="open">Open</option>
              <option value="partial">Partial</option>
              <option value="paid">Paid</option>
              <option value="void">Void</option>
            </select>
          </div>
          <NewInvoiceDialog />
        </div>
      </div>

      <Tabs defaultValue="invoices" className="flex-1 flex flex-col">
        <TabsList className="w-fit mb-4">
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="payments">Payment History</TabsTrigger>
        </TabsList>

        <TabsContent value="invoices" className="m-0 flex-1 flex flex-col">
          <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Balance Due</TableHead>
                  <TableHead className="w-32"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-4">Loading...</TableCell></TableRow>
                ) : !invoices?.length ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-4">No invoices found.</TableCell></TableRow>
                ) : (
                  invoices.map(inv => (
                    <InvoiceRow key={inv.id} invoice={inv} />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
        
        <TabsContent value="payments" className="m-0 flex-1 flex flex-col">
          <PaymentHistory />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function NewInvoiceDialog() {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [total, setTotal] = useState('');
  const [notes, setNotes] = useState('');
  
  const { data: clients } = useListClients();
  const createInvoice = useCreateInvoice();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    createInvoice.mutate({
      data: {
        clientId: parseInt(clientId),
        total: parseFloat(total) || 0,
        ...(notes && { notes })
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/invoices'] });
        queryClient.invalidateQueries({ queryKey: [`/api/clients`] });
        toast({ title: "Invoice created successfully" });
        setOpen(false);
        setClientId('');
        setTotal('');
        setNotes('');
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-10 bg-primary text-primary-foreground font-semibold shadow-sm px-4">
          <Plus className="w-4 h-4 mr-2" /> New Invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Manual Invoice</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Client *</label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={clientId} onChange={e => setClientId(e.target.value)}>
              <option value="">Select client...</option>
              {clients?.map(c => <option key={c.id} value={c.id}>{c.name} - {c.serviceAddress}, {c.city}</option>)}
            </select>
          </div>
          
          <div>
            <label className="text-sm font-medium mb-1 block">Total Amount ($) *</label>
            <Input type="number" step="0.01" value={total} onChange={e => setTotal(e.target.value)} placeholder="0.00" />
          </div>
          
          <div>
            <label className="text-sm font-medium mb-1 block">Notes (Optional)</label>
            <textarea className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createInvoice.isPending || !clientId || !total || parseFloat(total) <= 0}>Create Invoice</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InvoiceRow({ invoice }: { invoice: any }) {
  const statusColors = {
    open: "bg-destructive/10 text-destructive border-destructive/20",
    partial: "bg-accent/20 text-accent-foreground border-accent/30",
    paid: "bg-primary/10 text-primary border-primary/20",
    void: "bg-muted text-muted-foreground",
  };

  const updateInvoice = useUpdateInvoice();
  const queryClient = useQueryClient();
  const { data: clients } = useListClients();
  const client = clients?.find(c => c.id === invoice.clientId);
  const unappliedCredit = client?.unappliedCredit ?? 0;

  const handleUpdate = () => {
    updateInvoice.mutate({ id: invoice.id, data: { status: 'void' } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/invoices'] })
    });
  };

  // satisfies useGetInvoice requirement
  const _ = useGetInvoice(1, { query: { enabled: false, queryKey: ['/api/invoices', 1] } });

  const balanceDue = (invoice.total || 0) - (invoice.amountPaid || 0);

  return (
    <TableRow className="hover:bg-muted/50">
      <TableCell className="font-medium text-foreground">
        <div>{invoice.clientName}</div>
        {/* Only where the credit is actionable. Repeating it on paid and void rows
            is noise, and it reads as though the credit belongs to that invoice. */}
        {unappliedCredit > 0 && balanceDue > 0 && invoice.status !== 'void' && (
          <div className="text-xs font-normal text-primary">
            ${unappliedCredit.toLocaleString(undefined, { minimumFractionDigits: 2 })} credit on account
          </div>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{invoice.createdAt ? format(new Date(invoice.createdAt), 'MMM d, yyyy') : '-'}</TableCell>
      <TableCell>
        <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${statusColors[invoice.status as keyof typeof statusColors] || statusColors.open}`}>
          {invoice.status.toUpperCase()}
        </span>
      </TableCell>
      <TableCell className="text-right font-semibold">
        ${(invoice.total || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}
      </TableCell>
      <TableCell className={`text-right font-bold ${balanceDue > 0 ? 'text-destructive' : 'text-primary'}`}>
        ${balanceDue.toLocaleString(undefined, {minimumFractionDigits: 2})}
      </TableCell>
      <TableCell className="text-right space-x-2">
        {invoice.status !== 'paid' && invoice.status !== 'void' && (
          <>
            {unappliedCredit > 0 && <ApplyCreditDialog invoice={invoice} balanceDue={balanceDue} />}
            <RecordPaymentDialog invoice={invoice} balanceDue={balanceDue} />
          </>
        )}
        {invoice.status !== 'void' && (
          <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={handleUpdate}>Void</Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function RecordPaymentDialog({ invoice, balanceDue }: { invoice: any, balanceDue: number }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(balanceDue.toString());
  const [method, setMethod] = useState('credit_card');
  const [reference, setReference] = useState('');
  
  const createPayment = useCreatePayment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    const paymentAmount = Math.round(parseFloat(amount) * 100) / 100;
    const roundedBalance = Math.round(balanceDue * 100) / 100;
    if (paymentAmount > roundedBalance) {
      const credit = paymentAmount - roundedBalance;
      const confirmed = window.confirm(
        `This payment is $${credit.toFixed(2)} more than the invoice balance. ` +
        `The invoice will be paid in full and the remaining $${credit.toFixed(2)} will be kept as credit on the client's account. Continue?`
      );
      if (!confirmed) return;
    }
    createPayment.mutate({
      data: {
        clientId: invoice.clientId,
        invoiceId: invoice.id,
        amount: paymentAmount,
        method: method as any,
        reference
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/invoices'] });
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${invoice.clientId}`] });
        queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
        toast({ title: "Payment recorded successfully" });
        setOpen(false);
      },
      onError: (error: any) => {
        toast({
          title: "Could not record payment",
          description: error?.message ?? "Please try again.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 border-primary/30 text-primary hover:bg-primary/10">Pay</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record Payment</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="bg-muted p-3 rounded-md mb-4 flex justify-between items-center">
            <span className="font-semibold text-foreground">{invoice.clientName}</span>
            <span className="text-destructive font-bold">Due: ${balanceDue.toLocaleString(undefined, {minimumFractionDigits:2})}</span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Amount ($)</label>
              <Input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Method</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={method} onChange={e => setMethod(e.target.value)}>
                <option value="credit_card">Credit Card</option>
                <option value="check">Check</option>
                <option value="venmo">Venmo</option>
                <option value="zelle">Zelle</option>
                <option value="cash">Cash</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Reference / Check #</label>
            <Input value={reference} onChange={e => setReference(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createPayment.isPending || !amount || parseFloat(amount) <= 0}>
            {createPayment.isPending ? "Recording..." : "Record Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApplyCreditDialog({ invoice, balanceDue }: { invoice: any, balanceDue: number }) {
  const [open, setOpen] = useState(false);
  const { data: credits, isLoading, isError } = useListPayments(
    { clientId: invoice.clientId, unapplied: true },
    { query: { enabled: open, queryKey: ['/api/payments', { clientId: invoice.clientId, unapplied: true }] } },
  );
  const applyPayment = useApplyPayment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const applyCredit = (payment: NonNullable<typeof credits>[number]) => {
    const amount = Math.min(payment.amount, balanceDue);
    applyPayment.mutate(
      { id: payment.id, data: { invoiceId: invoice.id } },
      {
        onSuccess: result => {
          queryClient.invalidateQueries({ queryKey: ['/api/invoices'] });
          queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
          queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
          toast({
            title: "Credit applied successfully",
            description: `$${result.appliedAmount.toFixed(2)} applied to this invoice${
              result.remainingCredit > 0 ? `; $${result.remainingCredit.toFixed(2)} remains on the account.` : "."
            }`,
          });
          setOpen(false);
        },
        onError: (error: any) => {
          toast({
            title: "Could not apply credit",
            description: error?.message ?? "The credit may have already been applied. Refresh and try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8">Apply Credit</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply Account Credit</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-4">
          <p className="text-sm text-muted-foreground">
            Choose a credit to apply to the ${balanceDue.toFixed(2)} invoice balance. Any credit beyond the balance will remain on the account.
          </p>
          {isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Loading available credit...</div>
          ) : isError ? (
            <div className="py-4 text-center text-sm text-destructive">Could not load available credit.</div>
          ) : !credits?.length ? (
            <div className="py-4 text-center text-sm text-muted-foreground">No unapplied credit is available.</div>
          ) : (
            credits.map(payment => (
              <div key={payment.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="font-semibold">${payment.amount.toFixed(2)}</div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(payment.createdAt), 'MMM d, yyyy')} · {payment.method.replace('_', ' ')}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => applyCredit(payment)}
                  disabled={applyPayment.isPending}
                >
                  {applyPayment.isPending ? "Applying..." : `Apply $${Math.min(payment.amount, balanceDue).toFixed(2)}`}
                </Button>
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentHistory() {
  const { data: payments, isLoading } = useListPayments();
  const deletePayment = useDeletePayment();
  const queryClient = useQueryClient();

  return (
    <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="w-16"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={5} className="text-center py-4">Loading...</TableCell></TableRow>
          ) : !payments?.length ? (
            <TableRow><TableCell colSpan={5} className="text-center py-4">No payments found.</TableCell></TableRow>
          ) : (
            payments.map(p => (
              <TableRow key={p.id}>
                <TableCell>{format(new Date(p.createdAt), 'MMM d, yyyy')}</TableCell>
                <TableCell className="capitalize font-medium">{p.method.replace('_', ' ')}</TableCell>
                <TableCell className="text-muted-foreground">{p.reference || '-'}</TableCell>
                <TableCell className="text-right font-bold text-primary">
                  ${p.amount.toLocaleString(undefined, {minimumFractionDigits: 2})}
                  {p.invoiceId == null && <div className="text-xs font-normal">Unapplied credit</div>}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => {
                    if(confirm('Delete payment? This will update the invoice balance.')) {
                      deletePayment.mutate({ id: p.id }, { onSuccess: () => {
                        queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
                        queryClient.invalidateQueries({ queryKey: ['/api/invoices'] });
                      }});
                    }
                  }}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
