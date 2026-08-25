import { useEffect, useMemo, useState } from 'react';
import {
  useCompleteVendorRun,
  useListServices,
  useListVendorRuns,
  type VendorRunResult,
  type VendorRunRow,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, Receipt, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';

const today = new Date().toISOString().slice(0, 10);

const statusLabels: Record<VendorRunRow['status'], string> = {
  not_scheduled: 'Not scheduled',
  scheduled: 'Scheduled',
  completed: 'Completed, not billed',
  invoiced: 'Already invoiced',
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
  const completeRun = useCompleteVendorRun();
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

  useEffect(() => {
    setSelected(new Set());
    setResult(null);
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
          <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="text-lg">{selectedService?.vendorName} reconciliation</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Check only the customers listed on the vendor&apos;s invoice.
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
                        <TableHead>Status</TableHead>
                        <TableHead>Last completed</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => {
                        const invoiced = row.status === 'invoiced';
                        const missing = row.status === 'not_scheduled';
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
                          <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
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