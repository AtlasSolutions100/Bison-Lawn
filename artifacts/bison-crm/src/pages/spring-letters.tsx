import { useEffect, useMemo, useState } from 'react';
import {
  useBulkAdjustServicePrices,
  useGetLetterTemplate,
  getPreviewSpringLetterQueryKey,
  useListServices,
  useListSpringLetterClients,
  usePreviewSpringLetter,
  useRenewSpringLetterClients,
  useSendSpringLetters,
  useUpdateLetterTemplate,
  useUpdateService,
  BulkPriceAdjustInputMode,
  type BulkPriceAdjustInput,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Calculator, CheckCircle2, DollarSign, Mail, RefreshCw, Save, Send, TrendingUp } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';

const money = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';

export default function SpringLetters() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const servicesQuery = useListServices();
  const clientsQuery = useListSpringLetterClients();
  const templateQuery = useGetLetterTemplate();
  const updateService = useUpdateService();
  const bulkAdjust = useBulkAdjustServicePrices();
  const renewClients = useRenewSpringLetterClients();
  const updateTemplate = useUpdateLetterTemplate();
  const sendLetters = useSendSpringLetters();

  const [rates, setRates] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [templateInitialized, setTemplateInitialized] = useState(false);
  const [previewClientId, setPreviewClientId] = useState<number | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [renewalResult, setRenewalResult] = useState<Awaited<ReturnType<typeof renewClients.mutateAsync>> | null>(null);
  const [sendResult, setSendResult] = useState<Awaited<ReturnType<typeof sendLetters.mutateAsync>> | null>(null);

  const [bulkMode, setBulkMode] = useState<BulkPriceAdjustInputMode>(BulkPriceAdjustInputMode.percent);
  const [bulkAmount, setBulkAmount] = useState('');
  const [bulkRoundTo, setBulkRoundTo] = useState('');
  const [bulkExcluded, setBulkExcluded] = useState<Set<number>>(new Set());
  const [bulkPreview, setBulkPreview] = useState<Awaited<ReturnType<typeof bulkAdjust.mutateAsync>> | null>(null);
  const [bulkPreviewedKey, setBulkPreviewedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!servicesQuery.data) return;
    setRates((current) => {
      const next = { ...current };
      for (const service of servicesQuery.data) {
        if (next[service.id] === undefined) next[service.id] = String(service.rate);
      }
      return next;
    });
  }, [servicesQuery.data]);

  useEffect(() => {
    if (!clientsQuery.data || selectionInitialized) return;
    setSelected(new Set(clientsQuery.data.map((client) => client.clientId)));
    setPreviewClientId(clientsQuery.data[0]?.clientId ?? null);
    setSelectionInitialized(true);
  }, [clientsQuery.data, selectionInitialized]);

  useEffect(() => {
    if (!templateQuery.data || templateInitialized) return;
    setSubject(templateQuery.data.subject);
    setBody(templateQuery.data.body);
    setTemplateInitialized(true);
  }, [templateQuery.data, templateInitialized]);

  const templateDirty = Boolean(
    templateQuery.data && (subject !== templateQuery.data.subject || body !== templateQuery.data.body),
  );
  const changedServices = useMemo(
    () => (servicesQuery.data ?? []).filter((service) => {
      const rate = Number(rates[service.id]);
      return Number.isFinite(rate) && rate >= 0 && rate !== service.rate;
    }),
    [rates, servicesQuery.data],
  );
  const invalidRate = (servicesQuery.data ?? []).some((service) => {
    const value = Number(rates[service.id]);
    return rates[service.id]?.trim() === '' || !Number.isFinite(value) || value < 0;
  });

  // Every service is included unless explicitly unchecked, so the common case
  // ("raise everything 6%") needs no selection step at all.
  const bulkServiceIds = (servicesQuery.data ?? [])
    .filter((service) => !bulkExcluded.has(service.id))
    .map((service) => service.id);
  const bulkAllSelected = bulkServiceIds.length === (servicesQuery.data ?? []).length;
  const bulkAmountValue = Number(bulkAmount);
  const bulkRoundToValue = bulkRoundTo.trim() === '' ? null : Number(bulkRoundTo);
  const bulkAmountValid = bulkAmount.trim() !== '' && Number.isFinite(bulkAmountValue);
  const bulkRoundToValid = bulkRoundTo.trim() === '' || (Number.isFinite(bulkRoundToValue) && (bulkRoundToValue as number) > 0);
  const bulkParamsValid = bulkAmountValid && bulkRoundToValid && bulkServiceIds.length > 0;
  const bulkPayload: BulkPriceAdjustInput = {
    mode: bulkMode,
    amount: bulkAmountValue,
    serviceIds: bulkAllSelected ? null : bulkServiceIds,
    roundTo: bulkRoundToValue,
    apply: false,
  };
  // Any change to the inputs below invalidates a stale preview automatically —
  // Apply only lights up again once a fresh preview matches these exact params.
  const bulkParamsKey = JSON.stringify(bulkPayload);
  const bulkCanApply = bulkParamsValid && bulkPreview != null && bulkPreviewedKey === bulkParamsKey;
  const bulkStale = bulkPreview != null && bulkPreviewedKey !== bulkParamsKey;

  const selectedIds = [...selected];
  const previewQuery = usePreviewSpringLetter(previewClientId ?? 0, {
    query: {
      enabled: previewClientId != null && !templateDirty,
      queryKey: getPreviewSpringLetterQueryKey(previewClientId ?? 0),
    },
  });

  const toggleClient = (clientId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const toggleBulkService = (serviceId: number) => {
    setBulkExcluded((current) => {
      const next = new Set(current);
      if (next.has(serviceId)) next.delete(serviceId);
      else next.add(serviceId);
      return next;
    });
  };

  const previewBulkAdjustment = () => {
    bulkAdjust.mutate({ data: bulkPayload }, {
      onSuccess: (result) => { setBulkPreview(result); setBulkPreviewedKey(bulkParamsKey); },
      onError: (error) => toast({ title: 'Preview could not be calculated', description: errorMessage(error), variant: 'destructive' }),
    });
  };

  const applyBulkAdjustment = () => {
    bulkAdjust.mutate({ data: { ...bulkPayload, apply: true } }, {
      onSuccess: async (result) => {
        setBulkPreview(result);
        // Applied — a stale key forces a fresh preview before the next apply.
        setBulkPreviewedKey(null);
        const changedIds = new Set(result.changes.map((change) => change.serviceId));
        const fresh = await servicesQuery.refetch();
        if (fresh.data) {
          setRates((current) => {
            const next = { ...current };
            for (const service of fresh.data) {
              if (changedIds.has(service.id)) next[service.id] = String(service.rate);
            }
            return next;
          });
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['/api/spring-letters/clients'] }),
          ...(previewClientId != null
            ? [queryClient.invalidateQueries({ queryKey: getPreviewSpringLetterQueryKey(previewClientId) })]
            : []),
        ]);
        toast({ title: 'Seasonal pricing applied', description: `${result.changes.length} service${result.changes.length === 1 ? '' : 's'} updated.` });
      },
      onError: (error) => toast({ title: 'Bulk adjustment failed', description: errorMessage(error), variant: 'destructive' }),
    });
  };

  const savePricing = async () => {
    setPricingError(null);
    const failures: string[] = [];
    for (const service of changedServices) {
      try {
        await updateService.mutateAsync({ id: service.id, data: { rate: Number(rates[service.id]) } });
      } catch {
        failures.push(service.name);
      }
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['/api/services'] }),
      queryClient.invalidateQueries({ queryKey: ['/api/spring-letters/clients'] }),
      ...(previewClientId != null
        ? [queryClient.invalidateQueries({ queryKey: getPreviewSpringLetterQueryKey(previewClientId) })]
        : []),
    ]);
    if (failures.length) {
      setPricingError(`Could not save: ${failures.join(', ')}. Other changed rates were saved.`);
      return;
    }
    toast({ title: 'Service pricing saved', description: `${changedServices.length} rate${changedServices.length === 1 ? '' : 's'} updated.` });
  };

  const renewSelected = () => {
    setRenewalResult(null);
    renewClients.mutate({ data: { clientIds: selectedIds } }, {
      onSuccess: async (result) => {
        setRenewalResult(result);
        await queryClient.invalidateQueries({ queryKey: ['/api/spring-letters/clients'] });
        toast({ title: 'Renewal finished', description: `${result.renewed} of ${result.outcomes.length} customers renewed.` });
      },
      onError: (error) => toast({ title: 'Renewal could not start', description: errorMessage(error), variant: 'destructive' }),
    });
  };

  const saveTemplate = () => {
    updateTemplate.mutate({ data: { subject, body } }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ['/api/letter-template'] });
        if (previewClientId != null) {
          await queryClient.invalidateQueries({ queryKey: getPreviewSpringLetterQueryKey(previewClientId) });
        }
        toast({ title: 'Letter template saved' });
      },
      onError: (error) => toast({ title: 'Template was not saved', description: errorMessage(error), variant: 'destructive' }),
    });
  };

  const sendSelected = () => {
    setSendResult(null);
    sendLetters.mutate({ data: { clientIds: selectedIds } }, {
      onSuccess: async (result) => {
        setSendResult(result);
        await queryClient.invalidateQueries({ queryKey: ['/api/spring-letters/clients'] });
        toast({
          title: 'Spring letter run finished',
          description: `${result.sent} sent, ${result.failed} failed.`,
          variant: result.failed ? 'destructive' : 'default',
        });
      },
      onError: (error) => toast({ title: 'Letter run could not start', description: errorMessage(error), variant: 'destructive' }),
    });
  };

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Spring Letters</h1>
        <p className="text-muted-foreground mt-1">Update pricing, renew packages, and send every customer their letter.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-primary/10 p-2"><DollarSign className="h-5 w-5 text-primary" /></div>
            <div><CardTitle>1. Pricing</CardTitle><CardDescription>Set this year's standard service rates before renewing customers.</CardDescription></div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {servicesQuery.isLoading ? <Skeleton className="h-28 w-full" /> : servicesQuery.isError ? (
            <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Pricing could not be loaded</AlertTitle><AlertDescription>{errorMessage(servicesQuery.error)}</AlertDescription></Alert>
          ) : (
            <>
              <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold">Bulk seasonal adjustment</h3>
                </div>
                <p className="text-sm text-muted-foreground">Raise or lower every service at once instead of editing them one by one. Uncheck a service below to leave it out.</p>
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <Label htmlFor="bulk-mode">Adjustment</Label>
                    <select
                      id="bulk-mode"
                      className="mt-1 flex h-10 w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={bulkMode}
                      onChange={(event) => setBulkMode(event.target.value as BulkPriceAdjustInputMode)}
                    >
                      <option value={BulkPriceAdjustInputMode.percent}>Percent</option>
                      <option value={BulkPriceAdjustInputMode.fixed}>Fixed amount</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="bulk-amount">{bulkMode === BulkPriceAdjustInputMode.percent ? 'Percent increase' : 'Amount to add'}</Label>
                    <div className="relative mt-1 w-36">
                      {bulkMode === BulkPriceAdjustInputMode.fixed && <span className="absolute left-3 top-2 text-muted-foreground">$</span>}
                      <Input
                        id="bulk-amount"
                        className={bulkMode === BulkPriceAdjustInputMode.fixed ? 'pl-7' : 'pr-7'}
                        type="number"
                        step="0.01"
                        placeholder={bulkMode === BulkPriceAdjustInputMode.percent ? 'e.g. 6' : 'e.g. 10'}
                        value={bulkAmount}
                        onChange={(event) => setBulkAmount(event.target.value)}
                      />
                      {bulkMode === BulkPriceAdjustInputMode.percent && <span className="absolute right-3 top-2 text-muted-foreground">%</span>}
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="bulk-round-to">Round to nearest (optional)</Label>
                    <div className="relative mt-1 w-32">
                      <span className="absolute left-3 top-2 text-muted-foreground">$</span>
                      <Input id="bulk-round-to" className="pl-7" type="number" min="0" step="1" placeholder="e.g. 5" value={bulkRoundTo} onChange={(event) => setBulkRoundTo(event.target.value)} />
                    </div>
                  </div>
                  <Button variant="outline" onClick={previewBulkAdjustment} disabled={!bulkParamsValid || bulkAdjust.isPending}>
                    <Calculator className="mr-2 h-4 w-4" />{bulkAdjust.isPending ? 'Calculating…' : 'Preview'}
                  </Button>
                  <Button onClick={applyBulkAdjustment} disabled={!bulkCanApply || bulkAdjust.isPending}>
                    <TrendingUp className="mr-2 h-4 w-4" />{bulkAdjust.isPending ? 'Applying…' : `Apply to ${bulkServiceIds.length} service${bulkServiceIds.length === 1 ? '' : 's'}`}
                  </Button>
                </div>
                {bulkPreview && (
                  <div className="space-y-2">
                    <div className="overflow-x-auto rounded-md border bg-background">
                      <Table>
                        <TableHeader>
                          <TableRow><TableHead>Service</TableHead><TableHead>From</TableHead><TableHead>To</TableHead></TableRow>
                        </TableHeader>
                        <TableBody>
                          {bulkPreview.changes.map((change) => (
                            <TableRow key={change.serviceId}>
                              <TableCell>{change.serviceName}</TableCell>
                              <TableCell>{money(change.from)}</TableCell>
                              <TableCell className="font-medium text-primary">{money(change.to)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {bulkPreview.applied ? (
                      <p className="text-sm text-muted-foreground">Applied — these are the new prices.</p>
                    ) : bulkStale ? (
                      <p className="text-sm text-muted-foreground">Inputs changed since this preview. Preview again before applying.</p>
                    ) : (
                      <p className="text-sm text-muted-foreground">Preview only — nothing has been saved yet. Review the numbers, then Apply.</p>
                    )}
                  </div>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {servicesQuery.data?.map((service) => (
                  <div key={service.id} className="rounded-lg border bg-card p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <Label htmlFor={`rate-${service.id}`} className="truncate">{service.name}</Label>
                      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title="Include in bulk seasonal adjustment">
                        <Checkbox
                          className="h-3.5 w-3.5"
                          checked={!bulkExcluded.has(service.id)}
                          onCheckedChange={() => toggleBulkService(service.id)}
                          aria-label={`Include ${service.name} in bulk adjustment`}
                        />
                        Bulk
                      </label>
                    </div>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-muted-foreground">$</span>
                      <Input id={`rate-${service.id}`} className="pl-7" type="number" min="0" step="0.01" value={rates[service.id] ?? ''} onChange={(event) => setRates((current) => ({ ...current, [service.id]: event.target.value }))} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {pricingError && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Some rates were not saved</AlertTitle><AlertDescription>{pricingError}</AlertDescription></Alert>}
          <Button onClick={savePricing} disabled={!changedServices.length || invalidRate || updateService.isPending}>
            <Save className="mr-2 h-4 w-4" />{updateService.isPending ? 'Saving rates…' : `Save pricing${changedServices.length ? ` (${changedServices.length})` : ''}`}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-primary/10 p-2"><RefreshCw className="h-5 w-5 text-primary" /></div>
            <div><CardTitle>2. Renew</CardTitle><CardDescription>Select customers and carry their assigned services onto today's pricing and next year's dates.</CardDescription></div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {clientsQuery.isLoading ? <Skeleton className="h-52 w-full" /> : clientsQuery.isError ? (
            <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Customers could not be loaded</AlertTitle><AlertDescription>{errorMessage(clientsQuery.error)}</AlertDescription></Alert>
          ) : !clientsQuery.data?.length ? (
            <p className="rounded-lg border p-6 text-center text-muted-foreground">No customers have assigned services.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox checked={selected.size === clientsQuery.data.length} onCheckedChange={(checked) => setSelected(checked ? new Set(clientsQuery.data.map((client) => client.clientId)) : new Set())} />
                  Select all {clientsQuery.data.length} customers
                </label>
                <span className="text-sm text-muted-foreground">{selected.size} selected</span>
              </div>
              <div className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
                {clientsQuery.data.map((client) => (
                  <div key={client.clientId} className="rounded-lg border p-4">
                    <div className="flex items-start gap-3">
                      <Checkbox className="mt-1" checked={selected.has(client.clientId)} onCheckedChange={() => toggleClient(client.clientId)} aria-label={`Select ${client.clientName}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{client.clientName}</span>
                          {client.lastRenewedAt ? <Badge className="bg-primary/10 text-primary hover:bg-primary/10">Renewed this year</Badge> : <Badge variant="secondary">Still on last year's price</Badge>}
                          {!client.email && <Badge variant="destructive">No email address</Badge>}
                        </div>
                        <div className="mt-2 grid gap-1 text-sm">
                          {client.services.map((service) => (
                            <div key={service.clientServiceId} className="flex justify-between gap-4 text-muted-foreground">
                              <span>{service.serviceName}</span><span className="whitespace-nowrap">{money(service.currentAmount)} → <strong className="text-foreground">{money(service.newAmount)}</strong></span>
                            </div>
                          ))}
                          <div className="mt-1 flex justify-between border-t pt-2 font-medium">
                            <span>Total</span><span>{money(client.currentTotal)} → <span className="text-primary">{money(client.newTotal)}</span></span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {renewalResult && <RunResults title={`${renewalResult.renewed} customers renewed`} outcomes={renewalResult.outcomes} />}
          <Button onClick={renewSelected} disabled={!selected.size || renewClients.isPending || clientsQuery.isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${renewClients.isPending ? 'animate-spin' : ''}`} />{renewClients.isPending ? 'Renewing customers…' : `Renew ${selected.size} selected`}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-primary/10 p-2"><Mail className="h-5 w-5 text-primary" /></div>
            <div><CardTitle>3. Letter and send</CardTitle><CardDescription>Save the template, read a real preview, then email the selected customers one at a time.</CardDescription></div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {templateQuery.isLoading ? <Skeleton className="h-64 w-full" /> : templateQuery.isError ? (
            <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Template could not be loaded</AlertTitle><AlertDescription>{errorMessage(templateQuery.error)}</AlertDescription></Alert>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
              <div className="space-y-3">
                <div><Label htmlFor="letter-subject">Subject</Label><Input id="letter-subject" className="mt-1" value={subject} onChange={(event) => setSubject(event.target.value)} /></div>
                <div><Label htmlFor="letter-body">Body</Label><Textarea id="letter-body" className="mt-1 min-h-64 font-mono text-sm" value={body} onChange={(event) => setBody(event.target.value)} /></div>
                <Button onClick={saveTemplate} disabled={!templateDirty || !subject.trim() || !body.trim() || updateTemplate.isPending}>
                  <Save className="mr-2 h-4 w-4" />{updateTemplate.isPending ? 'Saving template…' : 'Save template'}
                </Button>
              </div>
              <div className="rounded-lg border bg-muted/40 p-4">
                <h3 className="font-semibold">Available merge tokens</h3>
                <p className="mt-1 text-sm text-muted-foreground">These are filled separately for each customer.</p>
                <div className="mt-3 space-y-2 text-sm">
                  <code className="block rounded bg-background px-2 py-1">{'{{clientName}}'}</code>
                  <code className="block rounded bg-background px-2 py-1">{'{{servicesTable}}'}</code>
                  <code className="block rounded bg-background px-2 py-1">{'{{total}}'}</code>
                </div>
              </div>
            </div>
          )}

          <div className="border-t pt-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1">
                <Label htmlFor="preview-client">Preview customer</Label>
                <select id="preview-client" className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={previewClientId ?? ''} onChange={(event) => setPreviewClientId(event.target.value ? Number(event.target.value) : null)}>
                  <option value="">Choose a customer</option>
                  {clientsQuery.data?.map((client) => <option key={client.clientId} value={client.clientId}>{client.clientName}{client.email ? '' : ' — no email'}</option>)}
                </select>
              </div>
            </div>
            {templateDirty ? (
              <Alert className="mt-3"><AlertCircle className="h-4 w-4" /><AlertTitle>Save before previewing or sending</AlertTitle><AlertDescription>The preview and emails always use the last saved template.</AlertDescription></Alert>
            ) : previewQuery.isLoading ? <Skeleton className="mt-3 h-44 w-full" /> : previewQuery.isError ? (
              <Alert variant="destructive" className="mt-3"><AlertCircle className="h-4 w-4" /><AlertTitle>Preview could not be rendered</AlertTitle><AlertDescription>{errorMessage(previewQuery.error)}</AlertDescription></Alert>
            ) : previewQuery.data ? (
              <div className="mt-3 rounded-lg border bg-background p-5">
                <div className="mb-3 border-b pb-3"><span className="text-xs uppercase text-muted-foreground">Subject</span><p className="font-semibold">{previewQuery.data.subject}</p></div>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-6">{previewQuery.data.body}</pre>
              </div>
            ) : null}
          </div>

          {sendResult && <RunResults title={`${sendResult.sent} sent, ${sendResult.failed} failed`} outcomes={sendResult.outcomes} />}
          <Alert>
            <Mail className="h-4 w-4" />
            <AlertTitle>Ready to send to {selected.size} selected customers</AlertTitle>
            <AlertDescription>Customers without email addresses will be recorded as failed and shown by name. Other letters will continue sending.</AlertDescription>
          </Alert>
          <Button onClick={sendSelected} disabled={!selected.size || templateDirty || sendLetters.isPending || !templateQuery.data}>
            <Send className="mr-2 h-4 w-4" />{sendLetters.isPending ? 'Sending letters one at a time…' : `Send ${selected.size} spring letters`}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function RunResults({ title, outcomes }: { title: string; outcomes: Array<{ clientId: number; clientName: string; ok: boolean; error?: string | null }> }) {
  return (
    <div className="rounded-lg border p-4">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-3 space-y-2">
        {outcomes.map((outcome) => (
          <div key={outcome.clientId} className={`flex items-start gap-2 text-sm ${outcome.ok ? 'text-foreground' : 'text-destructive'}`}>
            {outcome.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span><strong>{outcome.clientName}</strong>{outcome.ok ? ' — complete' : ` — ${outcome.error || 'Failed'}`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}