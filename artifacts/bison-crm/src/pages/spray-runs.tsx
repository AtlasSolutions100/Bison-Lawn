import { useEffect, useMemo, useState } from 'react';
import {
  useCompleteVendorRun,
  useListClients,
  useListServices,
  useListVendorRuns,
  type VendorRunResult,
  type VendorRunRow,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, Receipt, ScanSearch, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
// The matcher lives with the API so it can be exercised server-side too; it is a
// pure, dependency-free module, so the page imports the same file rather than
// keeping a second copy of the address-normalising rules in sync.
import {
  matchInvoiceToCustomers,
  type CustomerMatch,
  type InvoiceMatchResult,
} from '../../../api-server/src/lib/vendorInvoiceParse';

const today = new Date().toISOString().slice(0, 10);

const statusLabels: Record<VendorRunRow['status'], string> = {
  not_scheduled: 'Not scheduled',
  scheduled: 'Scheduled',
  completed: 'Completed, not billed',
  invoiced: 'Already invoiced',
};

const matchLabels: Record<CustomerMatch['confidence'], string> = {
  matched: 'On the invoice',
  probable: 'Probably on the invoice',
  unmatched: 'Not on the invoice',
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred';
}

export default function SprayRuns() {
  const { data: services, isLoading: servicesLoading, isError: servicesError } = useListServices();
  const vendorServices = useMemo(
    () => services?.filter((service) => Boolean(service.vendorName?.trim())) ?? [],
    [services],
  );
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [serviceDate, setServiceDate] = useState(today);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<VendorRunResult | null>(null);
  const [invoiceText, setInvoiceText] = useState('');
  const [matchResult, setMatchResult] = useState<InvoiceMatchResult | null>(null);
  const completeRun = useCompleteVendorRun();
  // Addresses are what the invoice is matched on, and the run rows only carry
  // names and cities.
  const { data: clients } = useListClients();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (serviceId == null && vendorServices.length > 0) setServiceId(vendorServices[0].id);
  }, [serviceId, vendorServices]);

  const runs = useListVendorRuns(
    { serviceId: serviceId ?? 0, from: serviceDate, to: serviceDate },
    {
      query: {
        enabled: serviceId != null && Boolean(serviceDate),
        queryKey: ['/api/vendor-runs', serviceId, serviceDate],
      },
    },
  );
  const rows = runs.data ?? [];
  const selectable = rows.filter((row) => row.status !== 'invoiced');
  const selectedRows = selectable.filter((row) => selected.has(row.clientId));
  const selectedTotal = selectedRows.reduce((sum, row) => sum + row.amount, 0);
  const selectedService = vendorServices.find((service) => service.id === serviceId);

  const addressByClient = useMemo(
    () => new Map((clients ?? []).map((client) => [client.id, client.serviceAddress ?? null])),
    [clients],
  );
  const candidates = useMemo(
    () =>
      rows.map((row) => ({
        clientId: row.clientId,
        clientName: row.clientName,
        address: addressByClient.get(row.clientId) ?? null,
        city: row.city,
      })),
    [rows, addressByClient],
  );
  const matchByClient = useMemo(
    () => new Map((matchResult?.matches ?? []).map((match) => [match.clientId, match])),
    [matchResult],
  );
  const matchedCount = matchResult?.matches.filter((match) => match.confidence === 'matched').length ?? 0;
  const probableCount = matchResult?.matches.filter((match) => match.confidence === 'probable').length ?? 0;
  // A customer the invoice covers who is already invoiced is the double-bill the
  // owner keeps hitting; call it out rather than leaving it as one more row.
  const alreadyBilled = rows.filter(
    (row) => row.status === 'invoiced' && matchByClient.get(row.clientId)?.confidence === 'matched',
  );

  useEffect(() => {
    setSelected(new Set());
    setResult(null);
    setMatchResult(null);
  }, [serviceId, serviceDate]);

  useEffect(() => {
    if (runs.data) {
      const valid = new Set(runs.data.filter((row) => row.status !== 'invoiced').map((row) => row.clientId));
      setSelected((current) => new Set([...current].filter((id) => valid.has(id))));
    }
  }, [runs.data]);

  const toggle = (clientId: number, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(clientId);
      else next.delete(clientId);
      return next;
    });
  };

  const runMatch = () => {
    const matched = matchInvoiceToCustomers(invoiceText, candidates, { vendorName: selectedService?.vendorName });
    setMatchResult(matched);
    setResult(null);
    // Only an address that lines up is ticked for him. A wrong tick bills someone
    // for work nobody did, so "probable" is left for him to decide on.
    const billable = new Set(selectable.map((row) => row.clientId));
    setSelected(
      new Set(
        matched.matches
          .filter((match) => match.confidence === 'matched' && billable.has(match.clientId))
          .map((match) => match.clientId),
      ),
    );
    toast({
      title: 'Invoice matched',
      description: `${matched.matches.filter((match) => match.confidence === 'matched').length} ticked, ${
        matched.matches.filter((match) => match.confidence === 'probable').length
      } to confirm, ${matched.unmatchedLines.length} invoice line(s) with no customer.`,
    });
  };

  const clearMatch = () => {
    setInvoiceText('');
    setMatchResult(null);
    setSelected(new Set());
  };

  const submit = () => {
    if (serviceId == null || !serviceDate || selected.size === 0) return;
    setResult(null);
    completeRun.mutate(
      { data: { serviceId, serviceDate, clientIds: [...selected] } },
      {
        onSuccess: (response) => {
          setResult(response);
          setSelected(new Set());
          queryClient.invalidateQueries();
          toast({
            title: response.failed ? 'Spray run finished with errors' : 'Spray run reconciled',
            description: `${response.completed} billed, ${response.skipped} skipped, ${response.failed} failed.`,
            variant: response.failed ? 'destructive' : 'default',
          });
        },
        onError: (error) => {
          toast({
            title: 'Could not reconcile spray run',
            description: errorMessage(error),
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Spray Runs</h1>
        <p className="text-muted-foreground mt-1">
          Match an outside company&apos;s completed run to every customer who should be billed.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Vendor invoice details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="vendor-service">Vendor-performed service</label>
            <select
              id="vendor-service"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={serviceId ?? ''}
              disabled={servicesLoading || servicesError}
              onChange={(event) => setServiceId(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">
                {servicesLoading ? 'Loading services…' : vendorServices.length ? 'Select a service…' : 'No vendor services configured'}
              </option>
              {vendorServices.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} — {service.vendorName}
                </option>
              ))}
            </select>
            {servicesError && <p className="text-sm text-destructive">Could not load services. Refresh and try again.</p>}
            {!servicesLoading && !servicesError && vendorServices.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Set an outside company on a service in Services &amp; Pricing before reconciling a run.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="service-date">Date the vendor performed the work</label>
            <Input
              id="service-date"
              type="date"
              value={serviceDate}
              onChange={(event) => setServiceDate(event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {serviceId != null && serviceDate && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Paste the {selectedService?.vendorName ?? 'vendor'} invoice</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Copy the invoice out of the email and paste it here. Addresses are matched first, names second — headers
              and totals are ignored. Nothing is billed until you press the button at the bottom.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              aria-label="Vendor invoice text"
              className="min-h-[160px] font-mono text-xs"
              placeholder={'Fertilizer + broadleaf    77 KAGY BOULEVARD, Bozeman MT    $75.00\nRound 3 fert    Cedar Hollow HOA    202 Cedar Hollow Wy.    $75.00'}
              value={invoiceText}
              onChange={(event) => setInvoiceText(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runMatch} disabled={!invoiceText.trim() || runs.isLoading}>
                <ScanSearch className="mr-2 h-4 w-4" /> Match to customers
              </Button>
              {matchResult && (
                <Button variant="ghost" onClick={clearMatch}>
                  Clear
                </Button>
              )}
              {matchResult && (
                <p className="text-sm text-muted-foreground">
                  {matchedCount} matched and ticked · {probableCount} to confirm · {matchResult.unmatchedLines.length}{' '}
                  invoice line(s) with no customer · {matchResult.ignoredLines.length} header/total line(s) ignored
                </p>
              )}
            </div>
            {matchResult && alreadyBilled.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <p className="font-semibold">Already invoiced — do not bill again</p>
                <p className="mt-1">
                  {alreadyBilled.map((row) => row.clientName).join(', ')} {alreadyBilled.length === 1 ? 'is' : 'are'} on
                  this invoice but already has an invoice for this run. They cannot be ticked.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {matchResult && matchResult.unmatchedLines.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg text-destructive">
              <ShieldAlert className="h-5 w-5" />
              {matchResult.unmatchedLines.length} invoice line(s) match no customer
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              The vendor charged for these but no customer on this service explains them. Either the account is not set
              up, the address on file is different, or they are on a different service. Check each one before you send
              invoices — this is where a spray customer gets missed.
            </p>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {matchResult.unmatchedLines.map((line) => (
                <li key={line.lineNumber} className="rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
                  <span className="text-muted-foreground mr-2">line {line.lineNumber}</span>
                  {line.text}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {serviceId != null && serviceDate && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="text-lg">{selectedService?.vendorName} reconciliation</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {matchResult
                  ? 'Ticked rows were matched to the invoice by address. Confirm the “probably” rows yourself, then bill.'
                  : "Check only the customers listed on the vendor's invoice."}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm text-muted-foreground">{selectedRows.length} selected</p>
              <p className="text-2xl font-bold text-primary">${selectedTotal.toFixed(2)}</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {runs.isLoading && (
              <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" /> Loading customer reconciliation…
              </div>
            )}
            {runs.isError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                Could not load this spray run: {errorMessage(runs.error)}
              </div>
            )}
            {!runs.isLoading && !runs.isError && (
              <>
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="w-12">
                          <Checkbox
                            aria-label="Select all billable customers"
                            checked={selectable.length > 0 && selectedRows.length === selectable.length}
                            onCheckedChange={(checked) =>
                              setSelected(checked ? new Set(selectable.map((row) => row.clientId)) : new Set())
                            }
                          />
                        </TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>City</TableHead>
                        {matchResult && <TableHead>Invoice match</TableHead>}
                        <TableHead>Status</TableHead>
                        <TableHead>Last completed</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => {
                        const invoiced = row.status === 'invoiced';
                        const missing = row.status === 'not_scheduled';
                        const match = matchByClient.get(row.clientId);
                        return (
                          <TableRow key={row.clientServiceId} className={missing ? 'bg-accent/40 hover:bg-accent/60' : undefined}>
                            <TableCell>
                              <Checkbox
                                aria-label={`Select ${row.clientName}`}
                                disabled={invoiced || completeRun.isPending}
                                checked={selected.has(row.clientId)}
                                onCheckedChange={(checked) => toggle(row.clientId, checked === true)}
                              />
                            </TableCell>
                            <TableCell className="font-semibold">{row.clientName}</TableCell>
                            <TableCell className="text-muted-foreground">{row.city || '—'}</TableCell>
                            {matchResult && (
                              <TableCell className="max-w-xs">
                                <Badge
                                  variant={
                                    match?.confidence === 'matched'
                                      ? 'default'
                                      : match?.confidence === 'probable'
                                        ? 'outline'
                                        : 'secondary'
                                  }
                                  className="gap-1"
                                >
                                  {match?.confidence === 'matched' && <CheckCircle2 className="h-3 w-3" />}
                                  {match?.confidence === 'probable' && <HelpCircle className="h-3 w-3" />}
                                  {matchLabels[match?.confidence ?? 'unmatched']}
                                </Badge>
                                {match && match.confidence !== 'unmatched' && (
                                  <p className="text-xs text-muted-foreground mt-1">{match.reason}</p>
                                )}
                                {match?.lines.map((line) => (
                                  <p key={line.lineNumber} className="text-xs font-mono text-muted-foreground mt-1 truncate">
                                    {line.text}
                                  </p>
                                ))}
                              </TableCell>
                            )}
                            <TableCell>
                              <Badge variant={invoiced ? 'secondary' : missing ? 'destructive' : 'outline'} className="gap-1">
                                {missing && <ShieldAlert className="h-3 w-3" />}
                                {invoiced && <Receipt className="h-3 w-3" />}
                                {statusLabels[row.status]}
                              </Badge>
                              {missing && <p className="text-xs font-medium mt-1">At risk of being missed</p>}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{row.lastCompletedDate || '—'}</TableCell>
                            <TableCell className="text-right font-semibold">${row.amount.toFixed(2)}</TableCell>
                          </TableRow>
                        );
                      })}
                      {rows.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={matchResult ? 7 : 6} className="py-10 text-center text-muted-foreground">
                            No customers have this service assigned.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Button onClick={submit} disabled={selected.size === 0 || completeRun.isPending}>
                    {completeRun.isPending ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Billing selected customers…</>
                    ) : (
                      <><Receipt className="mr-2 h-4 w-4" /> Bill {selectedRows.length} customers — ${selectedTotal.toFixed(2)}</>
                    )}
                  </Button>
                  {completeRun.isError && (
                    <p className="text-sm text-destructive">Nothing was confirmed. Review the error and try again.</p>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              {result.failed ? <AlertTriangle className="h-5 w-5 text-destructive" /> : <CheckCircle2 className="h-5 w-5 text-primary" />}
              Reconciliation results
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {result.completed} billed · {result.skipped} skipped · {result.failed} failed
            </p>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.outcomes.map((outcome) => (
                    <TableRow key={outcome.clientId}>
                      <TableCell className="font-semibold">{outcome.clientName}</TableCell>
                      <TableCell>
                        <Badge variant={outcome.status === 'failed' ? 'destructive' : outcome.status === 'skipped' ? 'secondary' : 'outline'}>
                          {outcome.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{outcome.invoiceId ? `#${outcome.invoiceId}` : '—'}</TableCell>
                      <TableCell className={outcome.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                        {outcome.reason || 'Completed and invoiced successfully'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}