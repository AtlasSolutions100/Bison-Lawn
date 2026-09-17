import { useRef, useState } from 'react';
import {
  useListServices, useCreateService, useUpdateService, useDeleteService, useCalculateServicePrice,
  useListPackages, useCreatePackage, useUpdatePackage, useDeletePackage, useGetService,
  useGetBillingSettings, useUpdateBillingSettings, useListEstimateFields,
  useCopyServiceMatrix, useBuildMatrixFromRule,
  type Service, type ServicePackage, type EstimateField, type PricingEquation, type CopyMatrixResult, type PackageItem,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Plus, Edit2, Trash2, Calculator, Copy, Wand2 } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useToast } from '@/hooks/use-toast';

const equationSchema = z.object({
  baseSqft: z.coerce.number(),
  basePrice: z.coerce.number(),
  upToSqft: z.union([z.literal(''), z.coerce.number()]),
  incrementSqft: z.coerce.number().default(0),
  incrementPrice: z.coerce.number().default(0),
  // Blank is meaningful: "no estimate for this band", not zero hours.
  budgetedHours: z.union([z.literal(''), z.coerce.number().finite()]).optional(),
  budgetedCost: z.union([z.literal(''), z.coerce.number().finite()]).optional(),
});

const serviceSchema = z.object({
  name: z.string().min(1, "Required"),
  // 2026-09-15 walkthrough: a service has a NAME (dispatch board), a short CODE
  // (waiting list), an INVOICE DESCRIPTION (printed on the bill) and the
  // customer-facing description below (the estimate).
  code: z.string().optional(),
  invoiceDescription: z.string().optional(),
  description: z.string().optional(),
  billingMode: z.enum(['fixed', 'time']),
  visitsPerSeason: z.union([z.literal(''), z.coerce.number().int().positive()]),
  quantity: z.union([z.literal(''), z.coerce.number().finite()]),
  rate: z.union([z.literal(''), z.coerce.number().finite()]),
  billableHours: z.union([z.literal(''), z.coerce.number().finite()]),
  teamSize: z.union([z.literal(''), z.coerce.number().int()]),
  minDays: z.union([z.literal(''), z.coerce.number().int()]),
  defaultStartDate: z.string(),
  defaultEndDate: z.string(),
  renewDate: z.string(),
  pricingEquations: z.array(equationSchema),
  contractorOfferable: z.boolean().default(false),
  contractorPrice: z.union([z.literal(''), z.coerce.number().finite()]).optional(),
  vendorName: z.string().optional(),
  // '' means "turf square footage" (pricingFieldId null); otherwise the id of
  // the estimate field the equations below are evaluated against.
  pricingFieldId: z.union([z.literal(''), z.number()]),
});

type EquationRow = z.infer<typeof equationSchema>;

/** A saved band as the form holds it: blank strings where the API has null. */
function toFormBand(equation: PricingEquation): EquationRow {
  return {
    ...equation,
    upToSqft: equation.upToSqft ?? '',
    budgetedHours: equation.budgetedHours ?? '',
    budgetedCost: equation.budgetedCost ?? '',
  };
}

const emptyBand: EquationRow = { baseSqft: 0, basePrice: 0, incrementSqft: 0, incrementPrice: 0, upToSqft: '', budgetedHours: '', budgetedCost: '' };

/**
 * Only fields with a real number qualify as pricing input — a service priced
 * off "Gate Code" would evaluate its equations against text and the API
 * rejects it, so it isn't worth offering here.
 */
function isPriceableField(field: EstimateField) {
  return field.fieldType === 'calculable' || field.fieldType === 'number';
}

/** What the pricing equations are measured in, for labels that shouldn't lie about it. */
function pricingUnitLabel(pricingFieldId: number | null | undefined, fields: EstimateField[] | undefined) {
  if (pricingFieldId == null) return 'Turf Sqft';
  return fields?.find(f => f.id === pricingFieldId)?.label ?? 'Turf Sqft';
}

/** The server's own words when it refused, otherwise the generic line. */
function errorMessage(error: unknown) {
  const data = (error as { data?: { error?: string } } | null)?.data;
  if (data?.error) return data.error;
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

const money = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

const units = (value: number) => value.toLocaleString('en-US');

/**
 * "In the matrix, make the full cell visible (numbers get cut off)". A number
 * box inside a squeezed table cell shrinks with the cell, so 203.75 became
 * "203." and 30000 lost a digit. Every band box now keeps a floor width, the
 * spinner arrows (which ate the space) are gone, and the table scrolls
 * sideways rather than crushing its columns.
 */
const bandCell = 'h-8 min-w-[7rem] text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

const packageItemSchema = z.object({
  serviceId: z.coerce.number().int().positive('Pick a service'),
  label: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
});

const packageSchema = z.object({
  name: z.string().min(1, "Required"),
  description: z.string().optional(),
  items: z.array(packageItemSchema),
  scheduleType: z.union([z.enum(['window', 'recurring', 'one_time']), z.literal('')]),
  startDate: z.string(),
  endDate: z.string(),
  frequencyWeeks: z.union([z.literal(''), z.coerce.number().int().positive()]),
  seasonEndDate: z.string(),
  renewDate: z.string(),
});

export default function Services() {
  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Services & Pricing</h1>
        <p className="text-muted-foreground mt-1">Manage your service catalog and pricing equations.</p>
      </div>

      <Tabs defaultValue="services" className="flex-1 flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <TabsList>
            <TabsTrigger value="services">Services</TabsTrigger>
            <TabsTrigger value="packages">Packages</TabsTrigger>
            <TabsTrigger value="field-payments">Field Payments</TabsTrigger>
          </TabsList>

          <TabsContent value="services" className="m-0"><ServiceDialog /></TabsContent>
          <TabsContent value="packages" className="m-0"><PackageDialog /></TabsContent>
        </div>

        <TabsContent value="services" className="flex-1 m-0">
          <ServicesList />
        </TabsContent>
        <TabsContent value="packages" className="flex-1 m-0">
          <PackagesList />
        </TabsContent>
        <TabsContent value="field-payments" className="flex-1 m-0">
          <FieldPaymentSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FieldPaymentSettings() {
  const { data: settings, isLoading } = useGetBillingSettings();
  const updateSettings = useUpdateBillingSettings();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [percent, setPercent] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (isLoading || !settings) return <div className="text-muted-foreground animate-pulse p-4">Loading settings...</div>;

  const curEnabled = enabled ?? settings.cardFeeEnabled;
  const curPercent = percent ?? String(settings.cardFeePercent);

  const save = () => {
    setSaved(false);
    updateSettings.mutate(
      { data: { cardFeeEnabled: curEnabled, cardFeePercent: Number(curPercent) || 0 } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries();
          setSaved(true);
        },
      },
    );
  };

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>On-Site Card Payments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When enabled, a card processing fee is automatically added to on-site credit card payments.
          Contractors see the fee breakdown before recording, and it is disclosed to the customer.
        </p>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="w-4 h-4 accent-primary"
            checked={curEnabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span className="font-semibold text-sm">Add card processing fee to credit card payments</span>
        </label>
        {curEnabled && (
          <div className="space-y-1">
            <label className="text-sm font-medium">Fee percentage (%)</label>
            <Input
              type="number"
              min="0"
              max="25"
              step="0.1"
              className="max-w-[120px]"
              value={curPercent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={updateSettings.isPending}>
            {updateSettings.isPending ? 'Saving...' : 'Save Settings'}
          </Button>
          {saved && <span className="text-sm text-primary font-medium">Saved</span>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The pricing column, as one line instead of forty.
 *
 * Asked for directly: "can we hide the matrix numbers in the service so its
 * cleaner?". Every band used to render as its own line inside the cell, so
 * Mowing — forty bands — filled the screen on its own and the service list
 * could not be scanned at all. The band count and the range answer the question
 * the list is actually being read for; the bands themselves are one click away
 * and unchanged.
 */
function PricingSummary({ service, unit }: { service: Service; unit: string }) {
  const [open, setOpen] = useState(false);
  const equations: PricingEquation[] = service.pricingEquations ?? [];

  if (equations.length === 0) {
    return <span className="text-sm text-muted-foreground">Flat ${service.rate}</span>;
  }

  // Empty bands carry no price and are not part of the range a reader cares
  // about — they are also what used to price a large property at zero.
  const priced = equations.filter((e) => e.basePrice > 0 || e.incrementPrice > 0);
  const prices = priced.map((e) => e.basePrice);
  const range = prices.length
    ? prices.length === 1 || Math.min(...prices) === Math.max(...prices)
      ? `$${Math.min(...prices)}`
      : `$${Math.min(...prices)}–$${Math.max(...prices)}`
    : 'no prices set';
  const blanks = equations.length - priced.length;

  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="text-left text-muted-foreground hover:text-foreground"
        data-testid={`toggle-pricing-${service.id}`}
      >
        <span className="font-semibold text-foreground">{range}</span>
        {' · '}
        {equations.length} {equations.length === 1 ? 'band' : 'bands'}
        {blanks > 0 && <span className="text-destructive"> · {blanks} with no price</span>}
        <span className="ml-1 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-0.5" onClick={(e) => e.stopPropagation()}>
          {equations.map((eq, i) => (
            <div key={i} className="text-muted-foreground tabular-nums">
              Base <span className="font-semibold text-foreground">${eq.basePrice}</span> (up to {units(eq.baseSqft)} {unit})
              {eq.incrementPrice ? ` + $${eq.incrementPrice} / ${units(eq.incrementSqft)} ${unit}` : ''}
              {eq.upToSqft ? ` (Max ${units(eq.upToSqft)})` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ServicesList() {
  const { data: services, isLoading } = useListServices();
  const { data: estimateFields } = useListEstimateFields();
  const deleteService = useDeleteService();
  const queryClient = useQueryClient();
  // "Seach bar for services" — his catalogue is 146 services long, so finding
  // "Backflow Test Winter" meant scrolling past everything alphabetically
  // between it and Aeration. Matches the name, the code and the description,
  // because he names services by code as often as by what they are.
  const [search, setSearch] = useState('');
  // "Click the service row to open it instead of hunting for the edit pen."
  // One dialog for whichever row was clicked; keyed by id so the form starts
  // from that service's values rather than the last one opened.
  const [editing, setEditing] = useState<Service | null>(null);

  // Satisfy useGetService requirement even if unused in list
  const _ = useGetService(1, { query: { enabled: false, queryKey: ['/api/services', 1] } });

  if (isLoading) return <div className="text-muted-foreground animate-pulse p-4">Loading services...</div>;

  const term = search.trim().toLowerCase();
  const shown = term
    ? (services ?? []).filter(s =>
        s.name.toLowerCase().includes(term)
        || (s.code ?? '').toLowerCase().includes(term)
        || (s.description ?? '').toLowerCase().includes(term))
    : (services ?? []);

  return (
    <div className="bg-card border rounded-lg shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center gap-3 border-b p-3">
        <Input
          className="h-9 max-w-xs"
          placeholder="Search services..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search services"
          data-testid="service-search"
        />
        <span className="text-sm text-muted-foreground">
          {term ? `${shown.length} of ${services?.length ?? 0}` : `${services?.length ?? 0} services`}
        </span>
      </div>
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="w-24">Code</TableHead>
            <TableHead>Service Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Pricing Model</TableHead>
            <TableHead>Field Offer</TableHead>
            <TableHead>Performed By</TableHead>
            <TableHead className="w-24"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map(s => (
            <TableRow
              key={s.id}
              className="hover:bg-muted/50 cursor-pointer"
              onClick={() => setEditing(s)}
              data-testid={`service-row-${s.id}`}
            >
              <TableCell className="font-mono text-xs text-muted-foreground">{s.code ?? '—'}</TableCell>
              <TableCell className="font-semibold text-foreground">
                {s.name}
                {s.billingMode === 'time' && (
                  <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">billed on time</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">{s.invoiceDescription ?? s.description}</TableCell>
              <TableCell>
                <PricingSummary service={s} unit={pricingUnitLabel(s.pricingFieldId, estimateFields)} />
                {s.visitsPerSeason != null && s.visitsPerSeason > 1 && (
                  <div className="text-xs text-muted-foreground">× {s.visitsPerSeason} visits a season</div>
                )}
              </TableCell>
              <TableCell className="text-sm">
                {s.vendorName ? (
                  <span className="font-semibold">{s.vendorName}</span>
                ) : (
                  <span className="text-muted-foreground">Our crew</span>
                )}
              </TableCell>
              <TableCell>
                {s.contractorOfferable ? (
                  <span className="text-sm font-semibold text-primary">
                    ${(s.contractorPrice ?? s.rate).toFixed(2)}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right space-x-2 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary" onClick={() => setEditing(s)} title="Edit service">
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => {
                  if(confirm('Delete service?')) {
                    deleteService.mutate({id: s.id}, { onSuccess: () => queryClient.invalidateQueries({queryKey: ['/api/services']})});
                  }
                }}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {!services?.length && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No services found.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      {editing && (
        <ServiceDialog
          key={editing.id}
          serviceToEdit={editing}
          open
          onOpenChange={(next) => { if (!next) setEditing(null); }}
        />
      )}
    </div>
  );
}

/** "Aeration ×2, Timer Adjustment ×4" — what the package holds, repeats counted. */
function packageContents(pkg: ServicePackage) {
  const counts = new Map<string, number>();
  for (const service of pkg.services ?? []) counts.set(service.name, (counts.get(service.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

function PackagesList() {
  const { data: packages, isLoading } = useListPackages();
  const deletePackage = useDeletePackage();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ServicePackage | null>(null);

  if (isLoading) return <div className="text-muted-foreground animate-pulse p-4">Loading packages...</div>;

  return (
    <div className="bg-card border rounded-lg shadow-sm overflow-hidden">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead>Package Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Contents</TableHead>
            <TableHead className="w-24"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {packages?.map(p => (
            <TableRow
              key={p.id}
              className="hover:bg-muted/50 cursor-pointer"
              onClick={() => setEditing(p)}
              data-testid={`package-row-${p.id}`}
            >
              <TableCell className="font-semibold text-foreground">{p.name}</TableCell>
              <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">{p.description}</TableCell>
              <TableCell className="text-sm">
                <span className="font-semibold text-primary">{p.items?.length ?? p.serviceIds?.length ?? 0} {(p.items?.length ?? 0) === 1 ? 'entry' : 'entries'}</span>
                {!!p.services?.length && <span className="text-muted-foreground"> · {packageContents(p)}</span>}
              </TableCell>
              <TableCell className="text-right space-x-2 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary" onClick={() => setEditing(p)} title="Edit package">
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => {
                  if(confirm('Delete package?')) {
                    deletePackage.mutate({id: p.id}, { onSuccess: () => queryClient.invalidateQueries({queryKey: ['/api/packages']})});
                  }
                }}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {!packages?.length && (
            <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No packages found.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      {editing && (
        <PackageDialog
          key={editing.id}
          packageToEdit={editing}
          open
          onOpenChange={(next) => { if (!next) setEditing(null); }}
        />
      )}
    </div>
  );
}

/**
 * "Copy a matrix from one service to another (Bison App 1 -> 2..8), optionally
 * multiplied (one-time mow = 1.5x mowing)."
 *
 * Copies the SAVED matrix of the service being edited onto the ticked
 * services. Preview first: the server sends back exactly the bands every
 * target would get, and which targets already have a matrix that would be
 * replaced, so nothing is overwritten on a guess.
 */
function CopyMatrixDialog({ source, services, unitLabel, matrixDirty }: {
  source: Service;
  services: Service[];
  unitLabel: string;
  matrixDirty: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [targets, setTargets] = useState<number[]>([]);
  const [mode, setMode] = useState<'multiply' | 'add' | 'percent'>('multiply');
  const [value, setValue] = useState('1');
  const [roundTo, setRoundTo] = useState('');
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<CopyMatrixResult | null>(null);
  const copy = useCopyServiceMatrix();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const others = services.filter(s => s.id !== source.id);
  const term = filter.trim().toLowerCase();
  const shown = term
    ? others.filter(s => s.name.toLowerCase().includes(term) || (s.code ?? '').toLowerCase().includes(term))
    : others;
  const toggle = (id: number, on: boolean) => {
    setPreview(null);
    setTargets(prev => (on ? [...new Set([...prev, id])] : prev.filter(x => x !== id)));
  };
  const selectShown = () => {
    setPreview(null);
    setTargets(prev => [...new Set([...prev, ...shown.map(s => s.id)])]);
  };

  const body = () => ({
    targetServiceIds: targets,
    mode,
    value: value === '' ? (mode === 'multiply' ? 1 : 0) : Number(value),
    roundTo: roundTo === '' ? null : Number(roundTo),
    copyPricingField: true,
  });

  const run = (apply: boolean) => {
    copy.mutate({ id: source.id, data: { ...body(), apply, overwrite: replace } }, {
      onSuccess: (res) => {
        if (!apply) {
          setPreview(res);
          return;
        }
        queryClient.invalidateQueries({ queryKey: ['/api/services'] });
        toast({ title: `Matrix copied to ${res.targets.length} ${res.targets.length === 1 ? 'service' : 'services'}` });
        setOpen(false);
        setPreview(null);
        setTargets([]);
      },
      onError: (error) => toast({ title: apply ? 'Matrix was not copied' : 'Could not preview', description: errorMessage(error), variant: 'destructive' }),
    });
  };

  const changeLabel = mode === 'multiply' ? `× ${value || 1}` : mode === 'add' ? `+ $${value || 0}` : `+ ${value || 0}%`;
  const willReplace = preview?.targets.filter(t => t.existingBands > 0) ?? [];
  const sample = preview?.targets[0]?.equations ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setPreview(null); }}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="copy-matrix-open">
          <Copy className="w-3 h-3 mr-1" /> Copy this matrix to…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Copy the {source.name} matrix to other services</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {matrixDirty && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              This copies the matrix as it was last saved. You have unsaved changes to the bands — save the service first if you want those copied.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Copy to</label>
                <button type="button" className="text-xs text-primary hover:underline" onClick={selectShown} data-testid="copy-matrix-select-shown">
                  Select all shown ({shown.length})
                </button>
              </div>
              <Input
                className="h-8"
                placeholder="Filter, e.g. Bison"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                data-testid="copy-matrix-filter"
              />
              <div className="max-h-64 overflow-y-auto rounded-md border p-2 space-y-1">
                {shown.map(s => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-primary"
                      checked={targets.includes(s.id)}
                      onChange={e => toggle(s.id, e.target.checked)}
                      data-testid={`copy-matrix-target-${s.id}`}
                    />
                    <span className="truncate">{s.name}</span>
                    {s.pricingEquations?.some(e => e.basePrice > 0 || e.incrementPrice > 0) && (
                      <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">has {s.pricingEquations.length} bands</span>
                    )}
                  </label>
                ))}
                {!shown.length && <p className="text-xs text-muted-foreground">No other services match.</p>}
              </div>
              <p className="text-xs text-muted-foreground">{targets.length} selected</p>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium">Change the prices</label>
                <div className="mt-1 flex gap-2">
                  <select
                    className="flex h-9 rounded-md border border-input bg-background px-2 text-sm"
                    value={mode}
                    onChange={e => { setMode(e.target.value as typeof mode); setValue(e.target.value === 'multiply' ? '1' : '0'); setPreview(null); }}
                    data-testid="copy-matrix-mode"
                  >
                    <option value="multiply">Multiply by</option>
                    <option value="add">Add $</option>
                    <option value="percent">Add %</option>
                  </select>
                  <Input
                    type="number"
                    step="0.01"
                    className="h-9 w-28"
                    value={value}
                    onChange={e => { setValue(e.target.value); setPreview(null); }}
                    data-testid="copy-matrix-value"
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Leave it at ×1 for an exact copy. A one-time mow is mowing × 1.5.
                </p>
              </div>
              <div>
                <label className="text-sm font-medium">Round each price to</label>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-sm">$</span>
                  <Input
                    type="number"
                    step="0.01"
                    className="h-9 w-28"
                    placeholder="keep cents"
                    value={roundTo}
                    onChange={e => { setRoundTo(e.target.value); setPreview(null); }}
                    data-testid="copy-matrix-round"
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 w-4 h-4 accent-primary" checked={replace} onChange={e => setReplace(e.target.checked)} data-testid="copy-matrix-replace" />
                <span>Replace what is there — a service that already has a matrix gets this one instead</span>
              </label>
              <p className="text-xs text-muted-foreground">
                The bands stay measured in {unitLabel}; each target's "Price By" is set to match. Budgeted cost scales with the rate; hours do not change.
              </p>
            </div>
          </div>

          {preview && (
            <div className="rounded-md border p-3 space-y-2" data-testid="copy-matrix-preview">
              <p className="text-sm font-medium">
                Each of the {preview.targets.length} {preview.targets.length === 1 ? 'service' : 'services'} gets these {sample.length} bands ({changeLabel}{roundTo ? `, rounded to $${roundTo}` : ''}):
              </p>
              <div className="max-h-48 overflow-auto">
                <table className="w-full text-xs tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-right [&>th:first-child]:text-left">
                      <th>To ({unitLabel})</th><th>Rate</th><th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sample.map((band, i) => (
                      <tr key={i} className="border-t [&>td]:px-2 [&>td]:py-1 [&>td]:text-right [&>td:first-child]:text-left">
                        <td>{band.upToSqft == null ? 'and up' : units(band.upToSqft)}</td>
                        <td>{money(band.basePrice)}{band.incrementPrice ? ` + ${money(band.incrementPrice)} / ${units(band.incrementSqft)}` : ''}</td>
                        <td>{band.budgetedCost == null ? '—' : money(band.budgetedCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                Going to: {preview.targets.map(t => t.serviceName).join(', ')}.
              </p>
              {willReplace.length > 0 && (
                <p className={`text-xs ${replace ? 'text-amber-700' : 'text-destructive'}`}>
                  {willReplace.map(t => `${t.serviceName} (${t.existingBands} bands)`).join(', ')} already {willReplace.length === 1 ? 'has' : 'have'} a matrix.
                  {replace ? ' It will be replaced.' : ' Tick "Replace what is there" to overwrite, or untick them.'}
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="pt-4">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" variant="secondary" disabled={!targets.length || copy.isPending} onClick={() => run(false)} data-testid="copy-matrix-preview-btn">
            Preview
          </Button>
          <Button type="button" disabled={!preview || copy.isPending} onClick={() => run(true)} data-testid="copy-matrix-apply">
            {copy.isPending ? 'Working…' : `Copy to ${targets.length} ${targets.length === 1 ? 'service' : 'services'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Rate matrix rule: $X per 1000 sqft up to Y; Bison application: $X per 500
 * up to Y." One sentence in, the bands out — then he edits any row he likes.
 * Works on a service that is not saved yet, because nothing is stored: the
 * server only does the arithmetic.
 */
function FillByRulePanel({ unitLabel, costPercent, hasPricedBands, onBands }: {
  unitLabel: string;
  costPercent: string;
  hasPricedBands: boolean;
  onBands: (bands: PricingEquation[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rule, setRule] = useState({ startPrice: '', per: '', step: '1000', upTo: '', tier2: false, per2: '', step2: '', upTo2: '' });
  const build = useBuildMatrixFromRule();
  const { toast } = useToast();
  const set = (key: keyof typeof rule, v: string | boolean) => setRule(r => ({ ...r, [key]: v }));

  const run = () => {
    const tier = (per: string, step: string, upTo: string) => ({
      pricePerStep: Number(per) || 0,
      stepSize: Number(step),
      upTo: upTo === '' ? null : Number(upTo),
    });
    build.mutate({
      data: {
        startPrice: Number(rule.startPrice) || 0,
        firstTier: tier(rule.per, rule.step, rule.upTo),
        ...(rule.tier2 ? { secondTier: tier(rule.per2, rule.step2, rule.upTo2) } : {}),
        costPercent: Number(costPercent) > 0 ? Number(costPercent) : null,
      },
    }, {
      onSuccess: (res) => {
        if (hasPricedBands && !confirm(`Replace the ${'current'} bands with ${res.equations.length} new ones? The old rows go away.`)) return;
        onBands(res.equations);
        setOpen(false);
        toast({ title: `${res.equations.length} bands filled in`, description: 'Check them over, then save the service.' });
      },
      onError: (error) => toast({ title: 'Could not build the bands', description: errorMessage(error), variant: 'destructive' }),
    });
  };

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="fill-by-rule-open">
        <Wand2 className="w-3 h-3 mr-1" /> Fill bands by rule
      </Button>
    );
  }

  const num = (key: keyof typeof rule, placeholder: string, testId: string, extra?: string) => (
    <Input
      type="number"
      step="any"
      className={`h-8 w-24 ${bandCell} ${extra ?? ''}`}
      placeholder={placeholder}
      value={String(rule[key])}
      onChange={e => set(key, e.target.value)}
      data-testid={testId}
    />
  );

  return (
    <div className="w-full rounded-lg border bg-background p-3 space-y-2 text-sm" data-testid="fill-by-rule">
      <div className="flex flex-wrap items-center gap-2">
        <span>Start at $</span>{num('startPrice', '49', 'rule-start')}
        <span>then add $</span>{num('per', '5', 'rule-per')}
        <span>per</span>{num('step', '1000', 'rule-step')}
        <span>{unitLabel} up to</span>{num('upTo', 'blank = and up', 'rule-upto', 'w-32')}
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" className="w-4 h-4 accent-primary" checked={rule.tier2} onChange={e => set('tier2', e.target.checked)} data-testid="rule-tier2" />
        Above that, a second step
      </label>
      {rule.tier2 && (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <span>add $</span>{num('per2', '4.50', 'rule-per2')}
          <span>per</span>{num('step2', '2000', 'rule-step2')}
          <span>{unitLabel} up to</span>{num('upTo2', 'blank = and up', 'rule-upto2', 'w-32')}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        The start price covers the first step. Leave "up to" blank for one last "and up" band that keeps adding the step price.
        {Number(costPercent) > 0 ? ` Cost fills at ${costPercent}% of rate.` : ''}
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={run} disabled={build.isPending || !rule.step} data-testid="rule-build">
          {build.isPending ? 'Building…' : 'Build the bands'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
      </div>
    </div>
  );
}

function ServiceDialog({ serviceToEdit, open: controlledOpen, onOpenChange }: {
  serviceToEdit?: Service;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  // Uncontrolled behind the "New Service" / pen buttons; controlled when the
  // list opens it from a row click.
  const [selfOpen, setSelfOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : selfOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setSelfOpen(next);
    onOpenChange?.(next);
  };
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createService = useCreateService();
  const updateService = useUpdateService();
  const calculatePrice = useCalculateServicePrice();
  const { data: estimateFields } = useListEstimateFields();
  const { data: allServices } = useListServices();
  const priceableFields = (estimateFields ?? []).filter(isPriceableField);

  // Open on the base+increment columns only when this service already uses them,
  // so the common flat matrix stays as narrow as his old one while a service
  // priced the older way still shows every value it depends on.
  const [showAdvanced, setShowAdvanced] = useState<boolean>(
    (serviceToEdit?.pricingEquations ?? []).some(e => e.incrementPrice || e.incrementSqft || e.baseSqft),
  );
  const [testSqft, setTestSqft] = useState<number>(0);
  const [testPrice, setTestPrice] = useState<number | null>(null);

  const form = useForm<z.infer<typeof serviceSchema>>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      name: serviceToEdit?.name || '',
      code: serviceToEdit?.code || '',
      invoiceDescription: serviceToEdit?.invoiceDescription || '',
      description: serviceToEdit?.description || '',
      billingMode: serviceToEdit?.billingMode === 'time' ? 'time' : 'fixed',
      visitsPerSeason: serviceToEdit?.visitsPerSeason ?? '',
      quantity: serviceToEdit?.quantity ?? 1,
      rate: serviceToEdit?.rate ?? 0,
      billableHours: serviceToEdit?.billableHours ?? '',
      teamSize: serviceToEdit?.teamSize ?? '',
      minDays: serviceToEdit?.minDays ?? '',
      defaultStartDate: serviceToEdit?.defaultStartDate ?? '',
      defaultEndDate: serviceToEdit?.defaultEndDate ?? '',
      renewDate: serviceToEdit?.renewDate ?? '',
      pricingEquations: serviceToEdit?.pricingEquations?.map(toFormBand) || [emptyBand],
      contractorOfferable: serviceToEdit?.contractorOfferable ?? false,
      contractorPrice: serviceToEdit?.contractorPrice ?? '',
      vendorName: serviceToEdit?.vendorName ?? '',
      pricingFieldId: serviceToEdit?.pricingFieldId ?? '',
    }
  });

  const { fields, append, remove, move, replace } = useFieldArray({ control: form.control, name: "pricingEquations" });

  /*
    "Entering in data in matrix using enter closes out the matrix, can that just
    move to the next column."

    Enter in a single-line input submits the enclosing form, and this form's
    submit saves and closes the dialog — so tabbing through forty bands, one
    reflexive Enter threw away everything typed since the last save. Enter now
    walks to the next cell across the row and wraps to the start of the next,
    which is what it does in the spreadsheet he is copying these numbers out of.
  */
  /*
    "In matrix - cost is % of Rate. can that automatically be filled based on
    rate?" — it is, and consistently: 60 of the 71 priced bands in his catalogue
    have a budgeted cost of exactly 75% of the rate, and most of the rest are
    85%. So the percentage is the thing worth typing once, and the column
    follows from it.

    Filling is deliberately a button rather than something that happens as he
    types. Bands he has already costed by hand are real numbers, and silently
    overwriting them the moment a rate changed would lose work he cannot get
    back.
  */
  const [costPercent, setCostPercent] = useState('75');
  const fillCostsFromRate = () => {
    const pct = Number(costPercent);
    if (!Number.isFinite(pct) || pct <= 0) return;
    const rows = form.getValues('pricingEquations') ?? [];
    rows.forEach((row, index: number) => {
      const rate = Number(row?.basePrice);
      if (!Number.isFinite(rate) || rate <= 0) return;
      form.setValue(`pricingEquations.${index}.budgetedCost`, Math.round(rate * pct) / 100, {
        shouldDirty: true,
      });
    });
  };

  const matrixRef = useRef<HTMLTableElement>(null);
  const handleMatrixKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (target.tagName !== 'INPUT') return;
    e.preventDefault();
    const inputs = Array.from(matrixRef.current?.querySelectorAll('input') ?? []);
    const next = inputs[inputs.indexOf(target as HTMLInputElement) + 1];
    if (!next) return;
    next.focus();
    next.select();
  };

  const onSubmit = (raw: z.infer<typeof serviceSchema>) => {
    const data = {
      ...raw,
      code: raw.code?.trim() || null,
      invoiceDescription: raw.invoiceDescription?.trim() || null,
      visitsPerSeason: raw.visitsPerSeason === '' ? null : raw.visitsPerSeason,
      quantity: raw.quantity === '' ? 1 : raw.quantity,
      rate: raw.rate === '' ? 0 : raw.rate,
      billableHours: raw.billableHours === '' ? null : raw.billableHours,
      teamSize: raw.teamSize === '' ? null : raw.teamSize,
      minDays: raw.minDays === '' ? null : raw.minDays,
      defaultStartDate: raw.defaultStartDate || null,
      defaultEndDate: raw.defaultEndDate || null,
      renewDate: raw.renewDate || null,
      pricingEquations: raw.pricingEquations.map(equation => ({
        ...equation,
        upToSqft: equation.upToSqft === '' ? null : equation.upToSqft,
        // Blank is 'no estimate for this band'. Coercing it to 0 would claim a
        // mow takes no time, and job costing would quietly believe it.
        budgetedHours: equation.budgetedHours === '' || equation.budgetedHours == null ? null : Number(equation.budgetedHours),
        budgetedCost: equation.budgetedCost === '' || equation.budgetedCost == null ? null : Number(equation.budgetedCost),
      })),
      contractorPrice: raw.contractorPrice === '' || raw.contractorPrice == null ? null : Number(raw.contractorPrice),
      vendorName: raw.vendorName?.trim() || null,
      pricingFieldId: raw.pricingFieldId === '' ? null : raw.pricingFieldId,
    };
    if (serviceToEdit) {
      updateService.mutate({ id: serviceToEdit.id, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/services'] });
          setOpen(false);
          toast({ title: 'Service updated' });
        },
        onError: (error) => toast({ title: 'Could not update service', description: errorMessage(error), variant: 'destructive' }),
      });
    } else {
      createService.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/services'] });
          setOpen(false);
          form.reset();
          toast({ title: 'Service created' });
        },
        onError: (error) => toast({ title: 'Could not create service', description: errorMessage(error), variant: 'destructive' }),
      });
    }
  };

  const runTest = () => {
    if (serviceToEdit && testSqft > 0) {
      calculatePrice.mutate({ id: serviceToEdit.id, data: { sqft: testSqft } }, {
        onSuccess: (res) => setTestPrice(res.price)
      });
    }
  };

  const pricingFieldIdWatch = form.watch('pricingFieldId');
  const unitLabel = pricingUnitLabel(pricingFieldIdWatch === '' ? null : pricingFieldIdWatch, estimateFields);
  const visitsWatch = form.watch('visitsPerSeason');
  const bandsWatch = form.watch('pricingEquations');
  const hasPricedBands = (bandsWatch ?? []).some(b => Number(b.basePrice) > 0 || Number(b.incrementPrice) > 0);

  const applyRuleBands = (bands: PricingEquation[]) => {
    replace(bands.map(toFormBand));
    if (bands.some(b => b.incrementPrice || b.incrementSqft || b.baseSqft)) setShowAdvanced(true);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          {serviceToEdit ? (
            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary"><Edit2 className="w-4 h-4" /></Button>
          ) : (
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-sm"><Plus className="w-4 h-4 mr-2" /> New Service</Button>
          )}
        </DialogTrigger>
      )}
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{serviceToEdit ? 'Edit Service' : 'Create New Service'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 pt-4">

          <div className="md:col-span-3">
            <Form {...form}>
              <form id="service-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <FormField control={form.control} name="name" render={({ field }) => (
                    <FormItem className="col-span-2"><FormLabel>Service Name</FormLabel><FormControl><Input {...field} data-testid="service-name" /></FormControl>
                      <p className="text-xs text-muted-foreground">What the dispatch board shows.</p>
                      <FormMessage/></FormItem>
                  )} />
                  <FormField control={form.control} name="code" render={({ field }) => (
                    <FormItem><FormLabel>Code</FormLabel><FormControl><Input placeholder="e.g. BA7" className="font-mono uppercase" {...field} data-testid="service-code" /></FormControl>
                      <p className="text-xs text-muted-foreground">Short. The waiting list shows it.</p>
                      <FormMessage/></FormItem>
                  )} />
                </div>
                <FormField control={form.control} name="invoiceDescription" render={({ field }) => (
                  <FormItem><FormLabel>Invoice description</FormLabel><FormControl><Input placeholder="Printed on the bill — leave blank to use the name" {...field} data-testid="service-invoice-description" /></FormControl><FormMessage/></FormItem>
                )} />
                {/*
                  A textarea, not a single-line input: "Estimate Descriptions I
                  need to be able to press enter to move to the next line so I
                  can give a cleaner view of discription", and the example he
                  gave is a title with an indented bullet under it. Enter used
                  to submit the form and close the dialog. The estimate PDF
                  already renders these line breaks, so nothing downstream needed
                  changing — only the box he types into.
                */}
                <FormField control={form.control} name="description" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Estimate description</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        className="resize-y"
                        placeholder={'Top Dressing of Lawn\n*Layer of organic material for building soil health and helping to retain water'}
                        {...field}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">What the customer reads on the estimate. Enter starts a new line.</p>
                    <FormMessage/>
                  </FormItem>
                )} />

                <FormField control={form.control} name="vendorName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Outside company that performs this service</FormLabel>
                    <FormControl><Input placeholder="Leave empty when our own crew does the work" {...field} /></FormControl>
                    <p className="text-xs text-muted-foreground">Enter the vendor name only when an outside company performs and invoices you for this service.</p>
                    <FormMessage/>
                  </FormItem>
                )} />

                <div className="p-4 bg-muted/30 border rounded-lg space-y-3">
                  <h4 className="font-semibold">Pricing</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {/*
                      His split: mowing, aeration and the sprinkler jobs keep
                      their price; clean-ups, pruning and sprinkler repair are
                      billed on the start/stop time and the office adjusts the
                      price afterwards.
                    */}
                    <FormField control={form.control} name="billingMode" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Billing</FormLabel>
                        <FormControl>
                          <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={field.value}
                            onChange={e => field.onChange(e.target.value)}
                            data-testid="service-billing-mode"
                          >
                            <option value="fixed">Set price</option>
                            <option value="time">Billed on time</option>
                          </select>
                        </FormControl>
                        <FormMessage/>
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="visitsPerSeason" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Visits per season</FormLabel>
                        <FormControl><Input type="number" min="1" step="1" placeholder="1" {...field} data-testid="service-visits" /></FormControl>
                        <FormMessage/>
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="quantity" render={({ field }) => (
                      <FormItem><FormLabel>Default Quantity</FormLabel><FormControl><Input type="number" min="0" step="0.01" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                    <FormField control={form.control} name="rate" render={({ field }) => (
                      <FormItem><FormLabel>Rate ($)</FormLabel><FormControl><Input type="number" min="0" step="0.01" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {/* "He types 28 mows and the customer sees the quantity so they can divide total by visits." */}
                    Visits per season is the default the estimate multiplies by — 28 for weekly mowing — so the customer sees the season total and the visits behind it.
                    {form.watch('billingMode') === 'time' ? ' Billed on time: the job\'s start/stop sets the price and you adjust it before the invoice goes out.' : ''}
                  </p>
                  <FormField control={form.control} name="pricingFieldId" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Price By</FormLabel>
                      <FormControl>
                        <select
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          value={field.value === '' ? '' : String(field.value)}
                          onChange={e => field.onChange(e.target.value === '' ? '' : Number(e.target.value))}
                        >
                          <option value="">Turf Sqft (default)</option>
                          {priceableFields.map(f => (
                            <option key={f.id} value={f.id}>{f.label}</option>
                          ))}
                        </select>
                      </FormControl>
                      <p className="text-xs text-muted-foreground">
                        The property detail the pricing equations below are evaluated against — e.g. Sprinkler Zones for a blow-out priced per zone.
                      </p>
                      <FormMessage/>
                    </FormItem>
                  )} />
                </div>

                <div className="p-4 bg-muted/30 border rounded-lg space-y-3">
                  <h4 className="font-semibold">Scheduling & Crew</h4>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <FormField control={form.control} name="billableHours" render={({ field }) => (
                      <FormItem><FormLabel>Billable Hours</FormLabel><FormControl><Input type="number" min="0" step="0.25" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                    <FormField control={form.control} name="teamSize" render={({ field }) => (
                      <FormItem><FormLabel>Team Size</FormLabel><FormControl><Input type="number" min="1" step="1" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                    <FormField control={form.control} name="minDays" render={({ field }) => (
                      <FormItem><FormLabel>Minimum Days</FormLabel><FormControl><Input type="number" min="0" step="1" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                    <FormField control={form.control} name="defaultStartDate" render={({ field }) => (
                      <FormItem><FormLabel>Default Start Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                    <FormField control={form.control} name="defaultEndDate" render={({ field }) => (
                      <FormItem><FormLabel>Default End Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                    <FormField control={form.control} name="renewDate" render={({ field }) => (
                      <FormItem><FormLabel>Renew Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                  </div>
                </div>

                <div className="p-4 bg-muted/30 border rounded-lg space-y-3">
                  <FormField control={form.control} name="contractorOfferable" render={({ field }) => (
                    <FormItem className="flex items-center gap-3 space-y-0">
                      <FormControl>
                        <input type="checkbox" className="w-4 h-4 accent-primary" checked={field.value} onChange={e => field.onChange(e.target.checked)} />
                      </FormControl>
                      <div>
                        <FormLabel className="font-semibold">Contractors can offer on site</FormLabel>
                        <p className="text-xs text-muted-foreground">Allow field crews to add this as one-time extra work from their phone.</p>
                      </div>
                    </FormItem>
                  )} />
                  {form.watch('contractorOfferable') && (
                    <FormField control={form.control} name="contractorPrice" render={({ field }) => (
                      <FormItem>
                        <FormLabel>On-site price ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" placeholder="Defaults to service rate" {...field} /></FormControl>
                        <FormMessage/>
                      </FormItem>
                    )} />
                  )}
                </div>

                <div className="pt-4 border-t">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                    <h4 className="font-semibold">Pricing Equations <span className="font-normal text-muted-foreground">— priced by {unitLabel}</span></h4>
                    <div className="flex flex-wrap items-center gap-2">
                      {serviceToEdit && (
                        <CopyMatrixDialog
                          source={serviceToEdit}
                          services={allServices ?? []}
                          unitLabel={unitLabel}
                          matrixDirty={!!form.formState.dirtyFields.pricingEquations}
                        />
                      )}
                    </div>
                  </div>
                  <div className="mb-3 flex">
                    <FillByRulePanel
                      unitLabel={unitLabel}
                      costPercent={costPercent}
                      hasPricedBands={hasPricedBands}
                      onBands={applyRuleBands}
                    />
                  </div>

                  {/*
                    One band per row, entered across rather than down.

                    Asked for directly: "can we change the matrix input to
                    horizontal instead of vertical like it is now". His mowing
                    matrix runs to nineteen bands, and as stacked cards that is
                    several screens of scrolling to check one price — the shape
                    of the table is what makes a matrix readable at all.

                    "From" is shown but never typed: it is the previous band's
                    "To" plus one. Two numbers that must agree, entered twice, is
                    a gap or an overlap waiting to happen, and a gap here prices
                    a lawn at zero.
                  */}
                  <div className="overflow-x-auto rounded-lg border">
                    <table ref={matrixRef} onKeyDown={handleMatrixKeyDown} className="w-max min-w-full text-sm">
                      <thead className="bg-muted/60">
                        <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium [&>th]:whitespace-nowrap">
                          <th className="min-w-[6rem]">From</th>
                          <th>To</th>
                          <th>Rate ($)</th>
                          {showAdvanced && <th>Base {unitLabel}</th>}
                          {showAdvanced && <th>+ per step ($)</th>}
                          {showAdvanced && <th>Step size</th>}
                          <th>B. Hrs</th>
                          <th>B. Cost ($)</th>
                          <th className="w-24"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field, index) => {
                          const previousTo = index === 0 ? null : form.watch(`pricingEquations.${index - 1}.upToSqft`);
                          const from = index === 0
                            ? '0'
                            : previousTo === '' || previousTo == null
                              ? '—'
                              : units(Number(previousTo) + 1);
                          return (
                            <tr key={field.id} className="border-t [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-middle">
                              <td className="tabular-nums text-muted-foreground whitespace-nowrap text-right pr-4" data-testid={`band-from-${index}`}>{from}</td>
                              <td>
                                <FormField control={form.control} name={`pricingEquations.${index}.upToSqft`} render={({ field }) => (
                                  <FormItem className="space-y-0">
                                    <FormControl>
                                      <Input type="number" className={bandCell} placeholder="and up" {...field} value={field.value === 0 ? 0 : field.value || ''} data-testid={`band-to-${index}`} />
                                    </FormControl>
                                  </FormItem>
                                )} />
                              </td>
                              <td>
                                <FormField control={form.control} name={`pricingEquations.${index}.basePrice`} render={({ field }) => (
                                  <FormItem className="space-y-0"><FormControl><Input type="number" step="0.01" className={bandCell} {...field} data-testid={`band-rate-${index}`} /></FormControl></FormItem>
                                )} />
                              </td>
                              {showAdvanced && (
                                <td>
                                  <FormField control={form.control} name={`pricingEquations.${index}.baseSqft`} render={({ field }) => (
                                    <FormItem className="space-y-0"><FormControl><Input type="number" className={bandCell} {...field} /></FormControl></FormItem>
                                  )} />
                                </td>
                              )}
                              {showAdvanced && (
                                <td>
                                  <FormField control={form.control} name={`pricingEquations.${index}.incrementPrice`} render={({ field }) => (
                                    <FormItem className="space-y-0"><FormControl><Input type="number" step="0.01" className={bandCell} {...field} value={field.value || ''} /></FormControl></FormItem>
                                  )} />
                                </td>
                              )}
                              {showAdvanced && (
                                <td>
                                  <FormField control={form.control} name={`pricingEquations.${index}.incrementSqft`} render={({ field }) => (
                                    <FormItem className="space-y-0"><FormControl><Input type="number" className={bandCell} {...field} value={field.value || ''} /></FormControl></FormItem>
                                  )} />
                                </td>
                              )}
                              <td>
                                <FormField control={form.control} name={`pricingEquations.${index}.budgetedHours`} render={({ field }) => (
                                  <FormItem className="space-y-0"><FormControl><Input type="number" step="0.05" className={`${bandCell} min-w-[5rem]`} placeholder="—" {...field} value={field.value ?? ''} /></FormControl></FormItem>
                                )} />
                              </td>
                              <td>
                                <FormField control={form.control} name={`pricingEquations.${index}.budgetedCost`} render={({ field }) => (
                                  <FormItem className="space-y-0"><FormControl><Input type="number" step="0.01" className={bandCell} placeholder="—" {...field} value={field.value ?? ''} /></FormControl></FormItem>
                                )} />
                              </td>
                              <td className="whitespace-nowrap">
                                {/* "add a matrix field and be able to move it up to a
                                    different line as I made a typing error" — a band
                                    typed into the wrong row used to mean retyping every
                                    row below it. */}
                                <Button
                                  type="button" variant="ghost" size="icon"
                                  className="h-8 w-6 text-muted-foreground disabled:opacity-25"
                                  disabled={index === 0}
                                  title="Move this band up"
                                  data-testid={`band-up-${index}`}
                                  onClick={() => move(index, index - 1)}
                                >
                                  ↑
                                </Button>
                                <Button
                                  type="button" variant="ghost" size="icon"
                                  className="h-8 w-6 text-muted-foreground disabled:opacity-25"
                                  disabled={index === fields.length - 1}
                                  title="Move this band down"
                                  data-testid={`band-down-${index}`}
                                  onClick={() => move(index, index + 1)}
                                >
                                  ↓
                                </Button>
                                {fields.length > 1 && (
                                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove(index)}>
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {/*
                    "when adding tiers to matrix, can that button be moved to the
                    bottom" / "in service, Add tier at the bottom of the service".
                    A new band always belongs after the last one, and on a forty
                    band matrix the last one is where you already are — the
                    button used to be at the top, a full screen of scrolling away
                    from the row you had just filled in.
                  */}
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => append({ ...emptyBand, upToSqft: 0 })}>
                      <Plus className="w-3 h-3 mr-1" /> Add Tier
                    </Button>
                    <span className="ml-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                      Cost is
                      <Input
                        type="number"
                        className="h-8 w-16"
                        value={costPercent}
                        onChange={e => setCostPercent(e.target.value)}
                        aria-label="Cost as a percentage of rate"
                        data-testid="cost-percent"
                      />
                      % of rate
                      <Button type="button" variant="outline" size="sm" onClick={fillCostsFromRate} data-testid="fill-costs">
                        Fill costs
                      </Button>
                    </span>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <p className="text-xs text-muted-foreground">
                      Leave the last <strong>To</strong> empty for “and up”. Budgeted hours and cost are optional —
                      blank means no estimate for that band, which is different from zero.
                    </p>
                    <Button type="button" variant="ghost" size="sm" className="shrink-0 text-xs" onClick={() => setShowAdvanced(v => !v)}>
                      {showAdvanced ? 'Hide' : 'Show'} base + increment
                    </Button>
                  </div>
                </div>
              </form>
            </Form>
          </div>

          <div className="md:col-span-1 bg-muted/50 p-4 rounded-lg border h-fit">
            <h4 className="font-semibold flex items-center gap-2 mb-4"><Calculator className="w-4 h-4" /> Live Test</h4>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Test {unitLabel}</label>
                <div className="flex gap-2">
                  <Input type="number" placeholder="e.g. 5000" value={testSqft || ''} onChange={e => setTestSqft(parseInt(e.target.value))} />
                  <Button onClick={runTest} disabled={!serviceToEdit || !testSqft}>Run</Button>
                </div>
              </div>
              <div className="p-4 bg-background border rounded-md text-center">
                <p className="text-xs text-muted-foreground font-semibold uppercase">Est. Price per visit</p>
                <p className="text-2xl font-bold text-primary mt-1">{testPrice !== null ? `$${testPrice.toFixed(2)}` : '--'}</p>
                {testPrice !== null && visitsWatch !== '' && Number(visitsWatch) > 1 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    × {visitsWatch} visits = <span className="font-semibold text-foreground">{money(testPrice * Number(visitsWatch))}</span> a season
                  </p>
                )}
              </div>
              {!serviceToEdit && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Save the service first to use the live calculator endpoint.
                </p>
              )}
              <p className="text-xs text-muted-foreground leading-relaxed">
                The test uses the saved bands, not the ones you are editing.
              </p>
            </div>
          </div>

        </div>
        <DialogFooter className="pt-4 mt-4 border-t">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" form="service-form" disabled={createService.isPending || updateService.isPending} data-testid="service-save">
            {createService.isPending || updateService.isPending ? 'Saving...' : serviceToEdit ? 'Save Changes' : 'Create Service'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PackageDialog({ packageToEdit, open: controlledOpen, onOpenChange }: {
  packageToEdit?: ServicePackage;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [selfOpen, setSelfOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : selfOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setSelfOpen(next);
    onOpenChange?.(next);
  };
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createPackage = useCreatePackage();
  const updatePackage = useUpdatePackage();
  const { data: services, isLoading: servicesLoading, isError: servicesError } = useListServices();

  // Packages saved before entries existed only carry the id list.
  const existingItems: PackageItem[] = packageToEdit
    ? (packageToEdit.items?.length ? packageToEdit.items : (packageToEdit.serviceIds ?? []).map((serviceId): PackageItem => ({ serviceId })))
    : [];

  const form = useForm<z.infer<typeof packageSchema>>({
    resolver: zodResolver(packageSchema),
    defaultValues: {
      name: packageToEdit?.name || '',
      description: packageToEdit?.description || '',
      items: existingItems.map(item => ({
        serviceId: item.serviceId,
        label: item.label ?? '',
        windowStart: item.windowStart ?? '',
        windowEnd: item.windowEnd ?? '',
      })),
      scheduleType: packageToEdit?.scheduleType ?? '',
      startDate: packageToEdit?.startDate ?? '',
      endDate: packageToEdit?.endDate ?? '',
      frequencyWeeks: packageToEdit?.frequencyWeeks ?? '',
      seasonEndDate: packageToEdit?.seasonEndDate ?? '',
      renewDate: packageToEdit?.renewDate ?? '',
    }
  });

  const { fields: itemFields, append: appendItem, remove: removeItem, move: moveItem } = useFieldArray({ control: form.control, name: 'items' });
  const scheduleType = form.watch('scheduleType');
  const itemsWatch = form.watch('items');

  const onSubmit = (raw: z.infer<typeof packageSchema>) => {
    const items = raw.items.map(item => ({
      serviceId: item.serviceId,
      label: item.label.trim() || null,
      windowStart: item.windowStart || null,
      windowEnd: item.windowEnd || null,
    }));
    const data = {
      name: raw.name,
      description: raw.description,
      items,
      serviceIds: items.map(item => item.serviceId),
      scheduleType: raw.scheduleType || null,
      startDate: raw.scheduleType === 'window' || raw.scheduleType === 'recurring' ? raw.startDate || null : null,
      endDate: raw.scheduleType === 'window' ? raw.endDate || null : null,
      frequencyWeeks: raw.scheduleType === 'recurring' && raw.frequencyWeeks !== '' ? raw.frequencyWeeks : null,
      seasonEndDate: raw.scheduleType === 'recurring' ? raw.seasonEndDate || null : null,
      renewDate: raw.scheduleType === 'recurring' ? raw.renewDate || null : null,
    };
    if (packageToEdit) {
      updatePackage.mutate({ id: packageToEdit.id, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/packages'] });
          setOpen(false);
          toast({ title: 'Package updated' });
        },
        onError: (error) => toast({ title: 'Could not update package', description: errorMessage(error), variant: 'destructive' }),
      });
    } else {
      createPackage.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/packages'] });
          setOpen(false);
          form.reset();
          toast({ title: 'Package created' });
        },
        onError: (error) => toast({ title: 'Could not create package', description: errorMessage(error), variant: 'destructive' }),
      });
    }
  };

  const serviceName = (id: number) => services?.find(s => s.id === id)?.name ?? '';
  // "Aeration ×2" — the same service more than once is the point, so say so
  // beside the list rather than hiding it.
  const repeated = (() => {
    const counts = new Map<number, number>();
    for (const item of itemsWatch ?? []) counts.set(item.serviceId, (counts.get(item.serviceId) ?? 0) + 1);
    return [...counts.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${serviceName(id)} ×${n}`);
  })();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          {packageToEdit ? (
            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary"><Edit2 className="w-4 h-4" /></Button>
          ) : (
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-sm">
              <Plus className="w-4 h-4 mr-2" /> New Package
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{packageToEdit ? 'Edit Package' : 'Create New Package'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Package Name</FormLabel><FormControl><Input {...field} data-testid="package-name" /></FormControl><FormMessage/></FormItem>
            )} />
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea rows={3} className="resize-y" {...field} /></FormControl><FormMessage/></FormItem>
            )} />

            {/*
              A list of entries, not a checklist: "A package may contain the
              same service more than once (sprinkler timer adjustment x4, core
              aeration = aeration x2)". Each entry can carry its own label and
              window so the four timer adjustments are June, July, August and
              September rather than four rows that look the same.
            */}
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="font-semibold">What is in the package</h4>
                  <p className="text-xs text-muted-foreground">Add a service as many times as it happens. Label the repeats so you can tell them apart on the account.</p>
                </div>
                <Button
                  type="button" variant="outline" size="sm"
                  disabled={!services?.length}
                  onClick={() => appendItem({ serviceId: services?.[0]?.id ?? 0, label: '', windowStart: '', windowEnd: '' })}
                  data-testid="package-add-entry"
                >
                  <Plus className="w-3 h-3 mr-1" /> Add service
                </Button>
              </div>
              {servicesLoading && <p className="text-sm text-muted-foreground animate-pulse">Loading services...</p>}
              {servicesError && <p className="text-sm text-destructive">Could not load services. Close this dialog and try again.</p>}
              {!servicesLoading && !servicesError && (
                <div className="space-y-2">
                  {itemFields.map((item, index) => (
                    <div key={item.id} className="grid grid-cols-12 gap-2 items-start rounded-md border p-2" data-testid={`package-entry-${index}`}>
                      <FormField control={form.control} name={`items.${index}.serviceId`} render={({ field }) => (
                        <FormItem className="col-span-12 md:col-span-4 space-y-0">
                          <FormControl>
                            <select
                              className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                              value={String(field.value)}
                              onChange={e => field.onChange(Number(e.target.value))}
                              data-testid={`package-entry-service-${index}`}
                            >
                              {services?.map(service => (
                                <option key={service.id} value={service.id}>{service.name}</option>
                              ))}
                            </select>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name={`items.${index}.label`} render={({ field }) => (
                        <FormItem className="col-span-12 md:col-span-3 space-y-0">
                          <FormControl><Input className="h-9" placeholder="Label, e.g. June" {...field} data-testid={`package-entry-label-${index}`} /></FormControl>
                        </FormItem>
                      )} />
                      <FormField control={form.control} name={`items.${index}.windowStart`} render={({ field }) => (
                        <FormItem className="col-span-6 md:col-span-2 space-y-0">
                          <FormControl><Input type="date" className="h-9" title="Window start (beats the package start for this entry)" {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <FormField control={form.control} name={`items.${index}.windowEnd`} render={({ field }) => (
                        <FormItem className="col-span-6 md:col-span-2 space-y-0">
                          <FormControl><Input type="date" className="h-9" title="Window end" {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <div className="col-span-12 md:col-span-1 flex justify-end whitespace-nowrap">
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-6 text-muted-foreground disabled:opacity-25" disabled={index === 0} title="Move up" onClick={() => moveItem(index, index - 1)}>↑</Button>
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-6 text-muted-foreground disabled:opacity-25" disabled={index === itemFields.length - 1} title="Move down" onClick={() => moveItem(index, index + 1)}>↓</Button>
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="Remove" onClick={() => removeItem(index)} data-testid={`package-entry-remove-${index}`}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {!itemFields.length && <p className="text-sm text-muted-foreground">Nothing in this package yet.</p>}
                  {!services?.length && <p className="text-sm text-muted-foreground">No services are available.</p>}
                  {repeated.length > 0 && (
                    <p className="text-xs text-muted-foreground" data-testid="package-repeats">Repeated: {repeated.join(', ')}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    The dates on an entry are its own window and beat the package dates below for that entry only. Leave them blank to use the package dates.
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
              <div>
                <h4 className="font-semibold">Inherited Scheduling Defaults</h4>
                <p className="text-xs text-muted-foreground">
                  These defaults are copied to each service when this package is assigned to a client.
                  Changing them later will not rewrite clients who already have the package.
                </p>
              </div>
              <FormField control={form.control} name="scheduleType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Schedule Type</FormLabel>
                  <FormControl>
                    <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" {...field}>
                      <option value="">Ask when assigning</option>
                      <option value="window">Service window</option>
                      <option value="recurring">Recurring</option>
                      <option value="one_time">One-time</option>
                    </select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              {scheduleType === 'window' && (
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="startDate" render={({ field }) => (
                    <FormItem><FormLabel>Start Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage/></FormItem>
                  )} />
                  <FormField control={form.control} name="endDate" render={({ field }) => (
                    <FormItem><FormLabel>End Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage/></FormItem>
                  )} />
                </div>
              )}

              {scheduleType === 'recurring' && (
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="frequencyWeeks" render={({ field }) => (
                    <FormItem><FormLabel>Every (weeks)</FormLabel><FormControl><Input type="number" min="1" step="1" {...field} /></FormControl><FormMessage/></FormItem>
                  )} />
                  <FormField control={form.control} name="startDate" render={({ field }) => (
                    <FormItem><FormLabel>Start Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage/></FormItem>
                  )} />
                  <FormField control={form.control} name="seasonEndDate" render={({ field }) => (
                    <FormItem><FormLabel>Season End Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage/></FormItem>
                  )} />
                  <FormField control={form.control} name="renewDate" render={({ field }) => (
                    <FormItem><FormLabel>Renew Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage/></FormItem>
                  )} />
                </div>
              )}
            </div>
            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createPackage.isPending || updatePackage.isPending} data-testid="package-save">
                {createPackage.isPending || updatePackage.isPending ? 'Saving...' : packageToEdit ? 'Save Changes' : 'Create Package'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
