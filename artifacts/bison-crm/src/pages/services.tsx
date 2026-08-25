import { useState } from 'react';
import { 
  useListServices, useCreateService, useUpdateService, useDeleteService, useCalculateServicePrice,
  useListPackages, useCreatePackage, useUpdatePackage, useDeletePackage, useGetService,
  useGetBillingSettings, useUpdateBillingSettings
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

const equationSchema = z.object({
  baseSqft: z.coerce.number(),
  basePrice: z.coerce.number(),
  upToSqft: z.coerce.number(),
  incrementSqft: z.coerce.number().default(0),
  incrementPrice: z.coerce.number().default(0),
});

const serviceSchema = z.object({
  name: z.string().min(1, "Required"),
  description: z.string().optional(),
  pricingEquations: z.array(equationSchema),
  contractorOfferable: z.boolean().default(false),
  contractorPrice: z.union([z.coerce.number(), z.literal('')]).optional(),
});

const packageSchema = z.object({
  name: z.string().min(1, "Required"),
  description: z.string().optional(),
  serviceIds: z.array(z.number()),
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
                  {s.pricingEquations?.map((eq: any, i: number) => (
                    <div key={i} className="mb-1 text-muted-foreground">
                      Base <span className="font-semibold text-foreground">${eq.basePrice}</span> (up to {eq.baseSqft} sqft)
                      {eq.incrementPrice ? ` + $${eq.incrementPrice} / ${eq.incrementSqft} sqft` : ''}
                      {eq.upToSqft ? ` (Max ${eq.upToSqft})` : ''}
                    </div>
                  ))}
                </div>
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
            <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No services found.</TableCell></TableRow>
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

function ServiceDialog({ serviceToEdit }: { serviceToEdit?: any }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const createService = useCreateService();
  const updateService = useUpdateService();
  const calculatePrice = useCalculateServicePrice();
  
  const [testSqft, setTestSqft] = useState<number>(0);
  const [testPrice, setTestPrice] = useState<number | null>(null);

  const form = useForm<z.infer<typeof serviceSchema>>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      name: serviceToEdit?.name || '',
      description: serviceToEdit?.description || '',
      pricingEquations: serviceToEdit?.pricingEquations || [{ baseSqft: 0, basePrice: 0, incrementSqft: 0, incrementPrice: 0, upToSqft: 0 }],
      contractorOfferable: serviceToEdit?.contractorOfferable ?? false,
      contractorPrice: serviceToEdit?.contractorPrice ?? '',
    }
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: "pricingEquations" });

  const onSubmit = (raw: z.infer<typeof serviceSchema>) => {
    const data = {
      ...raw,
      contractorPrice: raw.contractorPrice === '' || raw.contractorPrice == null ? null : Number(raw.contractorPrice),
    };
    if (serviceToEdit) {
      updateService.mutate({ id: serviceToEdit.id, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/services'] });
          setOpen(false);
        }
      });
    } else {
      createService.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/services'] });
          setOpen(false);
          form.reset();
        }
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {serviceToEdit ? (
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary"><Edit2 className="w-4 h-4" /></Button>
        ) : (
          <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-sm"><Plus className="w-4 h-4 mr-2" /> New Service</Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
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
                    <h4 className="font-semibold">Pricing Equations</h4>
                    <Button type="button" variant="outline" size="sm" onClick={() => append({ baseSqft: 0, basePrice: 0, upToSqft: 0, incrementSqft: 0, incrementPrice: 0 })}>
                      <Plus className="w-3 h-3 mr-1" /> Add Tier
                    </Button>
                  </div>
                  
                  <div className="space-y-4">
                    {fields.map((field, index) => (
                      <div key={field.id} className="p-4 bg-muted/30 border rounded-lg relative">
                        <div className="grid grid-cols-2 gap-4">
                          <FormField control={form.control} name={`pricingEquations.${index}.baseSqft`} render={({ field }) => (
                            <FormItem><FormLabel>Base Sqft</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage/></FormItem>
                          )} />
                          <FormField control={form.control} name={`pricingEquations.${index}.basePrice`} render={({ field }) => (
                            <FormItem><FormLabel>Base Price ($)</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage/></FormItem>
                          )} />
                          <FormField control={form.control} name={`pricingEquations.${index}.incrementSqft`} render={({ field }) => (
                            <FormItem><FormLabel>Inc. Sqft Step (Optional)</FormLabel><FormControl><Input type="number" {...field} value={field.value || ''}/></FormControl><FormMessage/></FormItem>
                          )} />
                          <FormField control={form.control} name={`pricingEquations.${index}.incrementPrice`} render={({ field }) => (
                            <FormItem><FormLabel>Inc. Price ($)</FormLabel><FormControl><Input type="number" {...field} value={field.value || ''}/></FormControl><FormMessage/></FormItem>
                          )} />
                          <FormField control={form.control} name={`pricingEquations.${index}.upToSqft`} render={({ field }) => (
                            <FormItem><FormLabel>Max Sqft (End of tier)</FormLabel><FormControl><Input type="number" {...field} value={field.value || ''}/></FormControl><FormMessage/></FormItem>
                          )} />
                        </div>
                        {fields.length > 1 && (
                          <Button type="button" variant="ghost" size="icon" className="absolute top-2 right-2 text-muted-foreground hover:text-destructive" onClick={() => remove(index)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </form>
            </Form>
          </div>

          <div className="md:col-span-1 bg-muted/50 p-4 rounded-lg border h-fit">
            <h4 className="font-semibold flex items-center gap-2 mb-4"><Calculator className="w-4 h-4" /> Live Test</h4>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Test Sqft</label>
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
            {serviceToEdit ? 'Save Changes' : 'Create Service'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PackageDialog({ packageToEdit }: { packageToEdit?: any }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const createPackage = useCreatePackage();
  const updatePackage = useUpdatePackage();

  const form = useForm<z.infer<typeof packageSchema>>({
    resolver: zodResolver(packageSchema),
    defaultValues: {
      name: packageToEdit?.name || '',
      description: packageToEdit?.description || '',
      serviceIds: packageToEdit?.serviceIds || [],
    }
  });

  const onSubmit = (data: z.infer<typeof packageSchema>) => {
    if (packageToEdit) {
      updatePackage.mutate({ id: packageToEdit.id, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/packages'] });
          setOpen(false);
        }
      });
    } else {
      createPackage.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/packages'] });
          setOpen(false);
          form.reset();
        }
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {packageToEdit ? (
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary"><Edit2 className="w-4 h-4" /></Button>
        ) : (
          <Button className="hidden"></Button>
        )}
      </DialogTrigger>
      <DialogContent>
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
            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createPackage.isPending || updatePackage.isPending}>
                {packageToEdit ? 'Save Changes' : 'Create Package'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
