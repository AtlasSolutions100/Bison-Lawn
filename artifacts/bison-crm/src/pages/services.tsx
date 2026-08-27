import { useState } from 'react';
import {
  useListServices, useCreateService, useUpdateService, useDeleteService, useCalculateServicePrice,
  useListPackages, useCreatePackage, useUpdatePackage, useDeletePackage, useGetService,
  useGetBillingSettings, useUpdateBillingSettings, useListEstimateFields,
  type Service, type ServicePackage, type EstimateField
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Plus, Edit2, Trash2, Calculator } from 'lucide-react';
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
  description: z.string().optional(),
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

const packageSchema = z.object({
  name: z.string().min(1, "Required"),
  description: z.string().optional(),
  serviceIds: z.array(z.number()),
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

function ServicesList() {
  const { data: services, isLoading } = useListServices();
  const { data: estimateFields } = useListEstimateFields();
  const deleteService = useDeleteService();
  const queryClient = useQueryClient();

  // Satisfy useGetService requirement even if unused in list
  const _ = useGetService(1, { query: { enabled: false, queryKey: ['/api/services', 1] } });

  if (isLoading) return <div className="text-muted-foreground animate-pulse p-4">Loading services...</div>;

  return (
    <div className="bg-card border rounded-lg shadow-sm overflow-hidden">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead>Service Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Pricing Model</TableHead>
            <TableHead>Field Offer</TableHead>
            <TableHead>Performed By</TableHead>
            <TableHead className="w-24"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {services?.map(s => (
            <TableRow key={s.id} className="hover:bg-muted/50">
              <TableCell className="font-semibold text-foreground">{s.name}</TableCell>
              <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">{s.description}</TableCell>
              <TableCell>
                <div className="text-sm">
                  {s.pricingEquations?.map((eq: any, i: number) => {
                    const unit = pricingUnitLabel(s.pricingFieldId, estimateFields);
                    return (
                      <div key={i} className="mb-1 text-muted-foreground">
                        Base <span className="font-semibold text-foreground">${eq.basePrice}</span> (up to {eq.baseSqft} {unit})
                        {eq.incrementPrice ? ` + $${eq.incrementPrice} / ${eq.incrementSqft} ${unit}` : ''}
                        {eq.upToSqft ? ` (Max ${eq.upToSqft})` : ''}
                      </div>
                    );
                  })}
                </div>
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
              <TableCell className="text-right space-x-2">
                <ServiceDialog serviceToEdit={s} />
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
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No services found.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function PackagesList() {
  const { data: packages, isLoading } = useListPackages();
  const deletePackage = useDeletePackage();
  const queryClient = useQueryClient();

  if (isLoading) return <div className="text-muted-foreground animate-pulse p-4">Loading packages...</div>;

  return (
    <div className="bg-card border rounded-lg shadow-sm overflow-hidden">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead>Package Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Price</TableHead>
            <TableHead className="w-24"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {packages?.map(p => (
            <TableRow key={p.id} className="hover:bg-muted/50">
              <TableCell className="font-semibold text-foreground">{p.name}</TableCell>
              <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">{p.description}</TableCell>
              <TableCell className="font-semibold text-primary">{p.serviceIds?.length} Services</TableCell>
              <TableCell className="text-right space-x-2">
                <PackageDialog packageToEdit={p} />
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
    </div>
  );
}

function ServiceDialog({ serviceToEdit }: { serviceToEdit?: Service }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createService = useCreateService();
  const updateService = useUpdateService();
  const calculatePrice = useCalculateServicePrice();
  const { data: estimateFields } = useListEstimateFields();
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
      description: serviceToEdit?.description || '',
      quantity: serviceToEdit?.quantity ?? 1,
      rate: serviceToEdit?.rate ?? 0,
      billableHours: serviceToEdit?.billableHours ?? '',
      teamSize: serviceToEdit?.teamSize ?? '',
      minDays: serviceToEdit?.minDays ?? '',
      defaultStartDate: serviceToEdit?.defaultStartDate ?? '',
      defaultEndDate: serviceToEdit?.defaultEndDate ?? '',
      renewDate: serviceToEdit?.renewDate ?? '',
      pricingEquations: serviceToEdit?.pricingEquations?.map(equation => ({
        ...equation,
        upToSqft: equation.upToSqft ?? '',
        budgetedHours: equation.budgetedHours ?? '',
        budgetedCost: equation.budgetedCost ?? '',
      })) || [{ baseSqft: 0, basePrice: 0, incrementSqft: 0, incrementPrice: 0, upToSqft: '', budgetedHours: '', budgetedCost: '' }],
      contractorOfferable: serviceToEdit?.contractorOfferable ?? false,
      contractorPrice: serviceToEdit?.contractorPrice ?? '',
      vendorName: serviceToEdit?.vendorName ?? '',
      pricingFieldId: serviceToEdit?.pricingFieldId ?? '',
    }
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: "pricingEquations" });

  const onSubmit = (raw: z.infer<typeof serviceSchema>) => {
    const data = {
      ...raw,
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
        onError: () => toast({ title: 'Could not update service', variant: 'destructive' }),
      });
    } else {
      createService.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/services'] });
          setOpen(false);
          form.reset();
          toast({ title: 'Service created' });
        },
        onError: () => toast({ title: 'Could not create service', variant: 'destructive' }),
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {serviceToEdit ? (
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary"><Edit2 className="w-4 h-4" /></Button>
        ) : (
          <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-sm"><Plus className="w-4 h-4 mr-2" /> New Service</Button>
        )}
      </DialogTrigger>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{serviceToEdit ? 'Edit Service' : 'Create New Service'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4">
          
          <div className="md:col-span-2">
            <Form {...form}>
              <form id="service-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem><FormLabel>Service Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
                )} />
                <FormField control={form.control} name="description" render={({ field }) => (
                  <FormItem><FormLabel>Description</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
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
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="quantity" render={({ field }) => (
                      <FormItem><FormLabel>Default Quantity</FormLabel><FormControl><Input type="number" min="0" step="0.01" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                    <FormField control={form.control} name="rate" render={({ field }) => (
                      <FormItem><FormLabel>Rate ($)</FormLabel><FormControl><Input type="number" min="0" step="0.01" {...field} /></FormControl><FormMessage/></FormItem>
                    )} />
                  </div>
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
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="font-semibold">Pricing Equations <span className="font-normal text-muted-foreground">— priced by {unitLabel}</span></h4>
                    <Button type="button" variant="outline" size="sm" onClick={() => append({ baseSqft: 0, basePrice: 0, upToSqft: 0, incrementSqft: 0, incrementPrice: 0, budgetedHours: '', budgetedCost: '' })}>
                      <Plus className="w-3 h-3 mr-1" /> Add Tier
                    </Button>
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
                    <table className="w-full text-sm">
                      <thead className="bg-muted/60">
                        <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium [&>th]:whitespace-nowrap">
                          <th className="w-24">From</th>
                          <th className="w-28">To</th>
                          <th className="w-28">Rate ($)</th>
                          {showAdvanced && <th className="w-28">Base {unitLabel}</th>}
                          {showAdvanced && <th className="w-28">+ per step</th>}
                          {showAdvanced && <th className="w-28">Step size</th>}
                          <th className="w-24">B. Hrs</th>
                          <th className="w-28">B. Cost ($)</th>
                          <th className="w-10"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field, index) => {
                          const previousTo = index === 0 ? null : form.watch(`pricingEquations.${index - 1}.upToSqft`);
                          const from = index === 0
                            ? 0
                            : previousTo === '' || previousTo == null
                              ? '—'
                              : Number(previousTo) + 1;
                          return (
                            <tr key={field.id} className="border-t [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-middle">
                              <td className="tabular-nums text-muted-foreground">{from}</td>
                              <td>
                                <FormField control={form.control} name={`pricingEquations.${index}.upToSqft`} render={({ field }) => (
                                  <FormItem className="space-y-0">
                                    <FormControl>
                                      <Input type="number" className="h-8" placeholder="and up" {...field} value={field.value === 0 ? 0 : field.value || ''} />
                                    </FormControl>
                                  </FormItem>
                                )} />
                              </td>
                              <td>
                                <FormField control={form.control} name={`pricingEquations.${index}.basePrice`} render={({ field }) => (
                                  <FormItem className="space-y-0"><FormControl><Input type="number" step="0.01" className="h-8" {...field} /></FormControl></FormItem>
                                )} />
                              </td>
                              {showAdvanced && (
                                <td>
                                  <FormField control={form.control} name={`pricingEquations.${index}.baseSqft`} render={({ field }) => (
                                    <FormItem className="space-y-0"><FormControl><Input type="number" className="h-8" {...field} /></FormControl></FormItem>
                                  )} />
                                </td>
                              )}
                              {showAdvanced && (
                                <td>
                                  <FormField control={form.control} name={`pricingEquations.${index}.incrementPrice`} render={({ field }) => (
                                    <FormItem className="space-y-0"><FormControl><Input type="number" step="0.01" className="h-8" {...field} value={field.value || ''} /></FormControl></FormItem>
                                  )} />
                                </td>
                              )}
                              {showAdvanced && (
                                <td>
                                  <FormField control={form.control} name={`pricingEquations.${index}.incrementSqft`} render={({ field }) => (
                                    <FormItem className="space-y-0"><FormControl><Input type="number" className="h-8" {...field} value={field.value || ''} /></FormControl></FormItem>
                                  )} />
                                </td>
                              )}
                              <td>
                                <FormField control={form.control} name={`pricingEquations.${index}.budgetedHours`} render={({ field }) => (
                                  <FormItem className="space-y-0"><FormControl><Input type="number" step="0.05" className="h-8" placeholder="—" {...field} value={field.value ?? ''} /></FormControl></FormItem>
                                )} />
                              </td>
                              <td>
                                <FormField control={form.control} name={`pricingEquations.${index}.budgetedCost`} render={({ field }) => (
                                  <FormItem className="space-y-0"><FormControl><Input type="number" step="0.01" className="h-8" placeholder="—" {...field} value={field.value ?? ''} /></FormControl></FormItem>
                                )} />
                              </td>
                              <td>
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
                <p className="text-xs text-muted-foreground font-semibold uppercase">Est. Price</p>
                <p className="text-2xl font-bold text-primary mt-1">{testPrice !== null ? `$${testPrice.toFixed(2)}` : '--'}</p>
              </div>
              {!serviceToEdit && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Save the service first to use the live calculator endpoint.
                </p>
              )}
            </div>
          </div>
          
        </div>
        <DialogFooter className="pt-4 mt-4 border-t">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" form="service-form" disabled={createService.isPending || updateService.isPending}>
            {createService.isPending || updateService.isPending ? 'Saving...' : serviceToEdit ? 'Save Changes' : 'Create Service'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PackageDialog({ packageToEdit }: { packageToEdit?: ServicePackage }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createPackage = useCreatePackage();
  const updatePackage = useUpdatePackage();
  const { data: services, isLoading: servicesLoading, isError: servicesError } = useListServices();

  const form = useForm<z.infer<typeof packageSchema>>({
    resolver: zodResolver(packageSchema),
    defaultValues: {
      name: packageToEdit?.name || '',
      description: packageToEdit?.description || '',
      serviceIds: packageToEdit?.serviceIds || [],
      scheduleType: packageToEdit?.scheduleType ?? '',
      startDate: packageToEdit?.startDate ?? '',
      endDate: packageToEdit?.endDate ?? '',
      frequencyWeeks: packageToEdit?.frequencyWeeks ?? '',
      seasonEndDate: packageToEdit?.seasonEndDate ?? '',
      renewDate: packageToEdit?.renewDate ?? '',
    }
  });

  const scheduleType = form.watch('scheduleType');

  const onSubmit = (raw: z.infer<typeof packageSchema>) => {
    const data = {
      name: raw.name,
      description: raw.description,
      serviceIds: raw.serviceIds,
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
        onError: () => toast({ title: 'Could not update package', variant: 'destructive' }),
      });
    } else {
      createPackage.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/packages'] });
          setOpen(false);
          form.reset();
          toast({ title: 'Package created' });
        },
        onError: () => toast({ title: 'Could not create package', variant: 'destructive' }),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {packageToEdit ? (
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary"><Edit2 className="w-4 h-4" /></Button>
        ) : (
          <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-sm">
            <Plus className="w-4 h-4 mr-2" /> New Package
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{packageToEdit ? 'Edit Package' : 'Create New Package'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Package Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
            )} />
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem><FormLabel>Description</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
            )} />

            <div className="space-y-3 rounded-lg border p-4">
              <div>
                <h4 className="font-semibold">Included Services</h4>
                <p className="text-xs text-muted-foreground">Choose the services assigned together in this package.</p>
              </div>
              {servicesLoading && <p className="text-sm text-muted-foreground animate-pulse">Loading services...</p>}
              {servicesError && <p className="text-sm text-destructive">Could not load services. Close this dialog and try again.</p>}
              {!servicesLoading && !servicesError && (
                <FormField control={form.control} name="serviceIds" render={({ field }) => (
                  <FormItem className="grid grid-cols-1 sm:grid-cols-2 gap-2 space-y-0">
                    {services?.map(service => (
                      <label key={service.id} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-primary"
                          checked={field.value.includes(service.id)}
                          onChange={event => field.onChange(
                            event.target.checked
                              ? [...field.value, service.id]
                              : field.value.filter(id => id !== service.id),
                          )}
                        />
                        {service.name}
                      </label>
                    ))}
                    {!services?.length && <p className="text-sm text-muted-foreground">No services are available.</p>}
                    <FormMessage />
                  </FormItem>
                )} />
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
              <Button type="submit" disabled={createPackage.isPending || updatePackage.isPending}>
                {createPackage.isPending || updatePackage.isPending ? 'Saving...' : packageToEdit ? 'Save Changes' : 'Create Package'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
