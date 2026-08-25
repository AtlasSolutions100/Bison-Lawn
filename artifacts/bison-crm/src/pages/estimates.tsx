import { useEffect, useMemo, useState } from 'react';
import { 
  useListEstimates, useGetEstimate, useCreateEstimate, useDeleteEstimate, useSendEstimate,
  useReconcileEstimateDelivery,
  useListEstimateFields, useCreateEstimateField, useUpdateEstimateField, useDeleteEstimateField,
  useListClients, useListServices
} from '@workspace/api-client-react';
import type { EstimateField, EstimateFieldInput, Service } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Download, Send, Trash2, Plus, AlertCircle } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export default function Estimates() {
  const { data: estimates, isLoading } = useListEstimates();
  const deleteEstimate = useDeleteEstimate();
  const sendEstimate = useSendEstimate();
  const reconcileDelivery = useReconcileEstimateDelivery();
  const { data: clients } = useListClients();
  const queryClient = useQueryClient();
  const [sendTarget, setSendTarget] = useState<{ id: number; email: string; clientName: string } | null>(null);
  const [sendEmail, setSendEmail] = useState('');
  const [sendMessage, setSendMessage] = useState('Thank you for the opportunity to care for your property. Please review the attached estimate.');
  const [sendError, setSendError] = useState('');

  const openSend = (estimate: NonNullable<typeof estimates>[number]) => {
    const email = clients?.find(c => c.id === estimate.clientId)?.email ?? '';
    setSendTarget({ id: estimate.id, email, clientName: estimate.clientName ?? 'Client' });
    setSendEmail(email);
    setSendError('');
  };

  const handleSend = () => {
    if (!sendTarget) return;
    setSendError('');
    sendEstimate.mutate({ id: sendTarget.id, data: { toEmail: sendEmail, message: sendMessage } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
        setSendTarget(null);
      },
      onError: (error) => {
        setSendError(error instanceof Error ? error.message : 'Email delivery failed. Please retry.');
      },
    });
  };

  const handleDelete = (id: number) => {
    if(confirm('Delete estimate?')) {
      deleteEstimate.mutate({ id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimates'] }) });
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Estimates</h1>
        <p className="text-muted-foreground mt-1">Build and send estimates.</p>
      </div>

      <Tabs defaultValue="list" className="flex-1 flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <TabsList>
            <TabsTrigger value="list">All Estimates</TabsTrigger>
            <TabsTrigger value="builder">Builder</TabsTrigger>
            <TabsTrigger value="fields">Custom Fields</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="list" className="flex-1 m-0">
          <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto h-full">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-32"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-4">Loading...</TableCell></TableRow>
                ) : !estimates?.length ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-4">No estimates found.</TableCell></TableRow>
                ) : (
                  estimates.map(e => (
                    <TableRow key={e.id}>
                      <TableCell className="font-medium">{e.clientName}</TableCell>
                      <TableCell className="font-semibold">${e.total.toLocaleString(undefined, {minimumFractionDigits:2})}</TableCell>
                      <TableCell>
                        <span className={`px-2 py-1 rounded text-xs font-bold ${
                          e.status === 'accepted' ? 'bg-green-100 text-green-800' :
                          e.status === 'declined' ? 'bg-red-100 text-red-800' :
                          e.status === 'sent' ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                        }`}>
                          {e.status.toUpperCase()}
                        </span>
                        {e.lastDeliveryError && <div className="text-xs text-destructive mt-1">Delivery failed — retry available</div>}
                        {e.deliveryState === 'provider_accepted' && (
                          <div className="text-xs text-amber-700 mt-1">Gmail accepted — confirmation needs finishing</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-1 whitespace-nowrap">
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Preview or download PDF"
                          onClick={() => window.open(`/api/estimates/${e.id}/pdf`, '_blank', 'noopener,noreferrer')}
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          title={
                            e.status === 'accepted' || e.status === 'declined'
                              ? 'Final customer response recorded'
                              : e.deliveryState === 'sending' || e.deliveryState === 'provider_accepted'
                                ? 'Finish the existing delivery before sending again'
                                : e.sentAt ? 'Send again' : 'Email estimate'
                          }
                          disabled={
                            e.status === 'accepted' ||
                            e.status === 'declined' ||
                            e.deliveryState === 'sending' ||
                            e.deliveryState === 'provider_accepted'
                          }
                          className="text-primary hover:text-primary hover:bg-primary/10"
                          onClick={() => openSend(e)}
                        >
                          <Send className="w-4 h-4" />
                        </Button>
                        {(e.deliveryState === 'provider_accepted' || e.deliveryState === 'sending') && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Confirm this email was sent without sending another copy"
                            onClick={() => {
                              if (!confirm('Only continue if Gmail shows this estimate was sent. This finishes the delivery record without sending another email.')) return;
                              reconcileDelivery.mutate(
                                { id: e.id },
                                { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimates'] }) },
                              );
                            }}
                          >
                            <AlertCircle className="w-4 h-4 text-amber-600" />
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => handleDelete(e.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="builder" className="flex-1 m-0">
          <EstimateBuilder />
        </TabsContent>

        <TabsContent value="fields" className="flex-1 m-0">
          <EstimateFields />
        </TabsContent>
      </Tabs>

      <Dialog open={!!sendTarget} onOpenChange={open => !open && setSendTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email estimate to {sendTarget?.clientName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Customer email</label>
              <Input
                type="email"
                value={sendEmail}
                onChange={e => setSendEmail(e.target.value)}
                placeholder="customer@example.com"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Message</label>
              <textarea
                className="flex min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={sendMessage}
                onChange={e => setSendMessage(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The email includes a polished PDF plus secure Accept and Decline buttons.
            </p>
            {sendError && (
              <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{sendError}</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendTarget(null)}>Cancel</Button>
            <Button disabled={!sendEmail || sendEstimate.isPending} onClick={handleSend}>
              <Send className="w-4 h-4 mr-2" />
              {sendEstimate.isPending ? 'Sending…' : 'Send Estimate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function fieldLinePrice(field: EstimateField, value: string): number | null {
  if (field.fieldType !== 'calculable') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || value.trim() === '') return null;
  const unitSize = field.unitSize && field.unitSize > 0 ? field.unitSize : 1;
  return Math.round((numeric / unitSize) * (field.pricePerUnit ?? 0) * 100) / 100;
}

function serviceLinePrice(service: Service, value: string): number {
  const numeric = Number(value);
  const eqs = service.pricingEquations ?? [];
  if (eqs.length > 0 && Number.isFinite(numeric) && value.trim() !== '') {
    let idx = eqs.findIndex(e => e.upToSqft != null && numeric <= e.upToSqft);
    if (idx === -1) {
      idx = eqs.findIndex(e => e.upToSqft == null);
      if (idx === -1) idx = eqs.length - 1;
    }
    const eq = eqs[idx];
    let price = eq.basePrice;
    if (numeric > eq.baseSqft && eq.incrementSqft > 0) {
      price += Math.ceil((numeric - eq.baseSqft) / eq.incrementSqft) * eq.incrementPrice;
    }
    return Math.round(price * 100) / 100;
  }
  return Math.round(service.rate * service.quantity * 100) / 100;
}

function EstimateBuilder() {
  const [clientId, setClientId] = useState('');
  const [notes, setNotes] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<number, { selected: boolean; value: string }>>({});
  const [serviceValues, setServiceValues] = useState<Record<number, { selected: boolean; value: string }>>({});
  const { data: clients } = useListClients();
  const { data: fields } = useListEstimateFields();
  const { data: services } = useListServices();
  const createEstimate = useCreateEstimate();
  const queryClient = useQueryClient();

  // Satisfy useGetEstimate hook requirement
  const _ = useGetEstimate(1, { query: { enabled: false, queryKey: ['/api/estimates', 1] } });

  const client = clients?.find(c => String(c.id) === clientId);

  // Rebuild the builder state from scratch whenever the selected client changes,
  // so one customer's property values can never leak into another customer's
  // estimate. Runs as an effect keyed on data-loaded flags (not array identity)
  // so late-arriving query results still trigger the prefill without background
  // refetches wiping in-progress edits.
  const clientsLoaded = clients != null;
  const fieldsLoaded = fields != null;
  useEffect(() => {
    if (!clientId) {
      setFieldValues({});
      setServiceValues({});
      return;
    }
    if (!clientsLoaded || !fieldsLoaded) return;
    const property = (clients.find(c => String(c.id) === clientId)?.propertyData ?? {}) as Record<string, string>;
    const next: Record<number, { selected: boolean; value: string }> = {};
    for (const f of fields) {
      const saved = property[f.label];
      next[f.id] = { selected: saved != null, value: saved ?? '' };
    }
    setFieldValues(next);
    setServiceValues({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, clientsLoaded, fieldsLoaded]);

  const lines = useMemo(() => {
    const result: { fieldId?: number; serviceId?: number; label: string; value: string; calculatedPrice: number | null }[] = [];
    for (const f of fields ?? []) {
      const state = fieldValues[f.id];
      if (!state?.selected) continue;
      result.push({ fieldId: f.id, label: f.label, value: state.value, calculatedPrice: fieldLinePrice(f, state.value) });
    }
    for (const s of services ?? []) {
      const state = serviceValues[s.id];
      if (!state?.selected) continue;
      result.push({ serviceId: s.id, label: s.name, value: state.value, calculatedPrice: serviceLinePrice(s, state.value) });
    }
    return result;
  }, [fields, services, fieldValues, serviceValues]);

  const total = lines.reduce((sum, l) => sum + (l.calculatedPrice ?? 0), 0);
  const invalidCalculable = (fields ?? []).some(f => {
    const state = fieldValues[f.id];
    return state?.selected && f.fieldType === 'calculable' && (state.value.trim() === '' || !Number.isFinite(Number(state.value)));
  });

  const handleSave = () => {
    createEstimate.mutate({
      data: {
        clientId: parseInt(clientId),
        notes: notes.trim() || undefined,
        lines: lines.map(({ calculatedPrice, ...line }) => ({ ...line, calculatedPrice })),
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
        setClientId('');
        setNotes('');
        setFieldValues({});
        setServiceValues({});
        alert('Estimate created');
      },
      onError: (error) => alert(error instanceof Error ? error.message : 'Could not save estimate'),
    });
  };

  const fieldInput = (f: EstimateField) => {
    const state = fieldValues[f.id] ?? { selected: false, value: '' };
    const set = (patch: Partial<typeof state>) => setFieldValues(prev => ({ ...prev, [f.id]: { ...state, ...patch } }));
    return (
      <div key={f.id} className={`flex items-center gap-3 p-3 rounded-md border ${state.selected ? 'bg-background' : 'bg-muted/40'}`}>
        <input type="checkbox" className="w-4 h-4" checked={state.selected} onChange={e => set({ selected: e.target.checked })} />
        <div className="w-56">
          <div className="text-sm font-medium">{f.label}</div>
          {f.fieldType === 'calculable' && (
            <div className="text-xs text-muted-foreground">${f.pricePerUnit ?? 0} per {f.unitSize ?? 1} units</div>
          )}
        </div>
        {f.fieldType === 'boolean' ? (
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            disabled={!state.selected}
            value={state.value}
            onChange={e => set({ value: e.target.value })}
          >
            <option value="">—</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        ) : (
          <Input
            type={f.fieldType === 'text' ? 'text' : 'number'}
            className="w-40"
            disabled={!state.selected}
            value={state.value}
            onChange={e => set({ value: e.target.value })}
            placeholder={f.fieldType === 'text' ? 'Detail' : 'Value'}
          />
        )}
        <span className="ml-auto text-sm font-semibold tabular-nums">
          {state.selected && f.fieldType === 'calculable'
            ? (fieldLinePrice(f, state.value) == null ? 'Enter a number' : money(fieldLinePrice(f, state.value)!))
            : state.selected ? '—' : ''}
        </span>
      </div>
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px] items-start">
      <div className="bg-card p-6 border rounded-lg shadow-sm space-y-5">
        <h2 className="text-xl font-bold">New Estimate</h2>
        <div>
          <label className="text-sm font-medium mb-1 block">Client</label>
          <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={clientId} onChange={e => setClientId(e.target.value)}>
            <option value="">Select client...</option>
            {clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {client && Object.keys(client.propertyData ?? {}).length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">Values prefilled from {client.name}'s saved property details.</p>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Property Fields</h3>
          {!fields?.length ? (
            <p className="text-sm text-muted-foreground">No reusable fields yet — add them in the Custom Fields tab.</p>
          ) : (
            <div className="space-y-2">{fields.map(fieldInput)}</div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Services</h3>
          {!services?.length ? (
            <p className="text-sm text-muted-foreground">No services configured.</p>
          ) : (
            <div className="space-y-2">
              {services.map(s => {
                const state = serviceValues[s.id] ?? { selected: false, value: '' };
                const set = (patch: Partial<typeof state>) => setServiceValues(prev => ({ ...prev, [s.id]: { ...state, ...patch } }));
                const hasEquations = (s.pricingEquations ?? []).length > 0;
                return (
                  <div key={s.id} className={`flex items-center gap-3 p-3 rounded-md border ${state.selected ? 'bg-background' : 'bg-muted/40'}`}>
                    <input type="checkbox" className="w-4 h-4" checked={state.selected} onChange={e => set({ selected: e.target.checked })} />
                    <div className="w-56">
                      <div className="text-sm font-medium">{s.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {hasEquations ? 'Priced from sqft equations' : `Flat ${money(s.rate * s.quantity)}`}
                      </div>
                    </div>
                    {hasEquations && (
                      <Input
                        type="number"
                        className="w-40"
                        disabled={!state.selected}
                        value={state.value}
                        onChange={e => set({ value: e.target.value })}
                        placeholder="Sqft"
                      />
                    )}
                    <span className="ml-auto text-sm font-semibold tabular-nums">
                      {state.selected ? money(serviceLinePrice(s, state.value)) : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Notes</label>
          <textarea
            className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional notes shown on the estimate"
          />
        </div>
      </div>

      <div className="bg-card p-6 border rounded-lg shadow-sm space-y-3 sticky top-4">
        <h3 className="text-sm font-semibold">Summary</h3>
        {!lines.length ? (
          <p className="text-sm text-muted-foreground">Select fields or services to build the estimate.</p>
        ) : (
          <div className="space-y-1">
            {lines.map((l, i) => (
              <div key={i} className="flex justify-between text-sm gap-2">
                <span className="truncate">{l.label}{l.value ? ` — ${l.value}` : ''}</span>
                <span className="tabular-nums shrink-0">{l.calculatedPrice == null ? '—' : money(l.calculatedPrice)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-between border-t pt-2 font-bold">
          <span>Total</span>
          <span className="tabular-nums">{money(total)}</span>
        </div>
        {invalidCalculable && <p className="text-xs text-destructive">Enter numeric values for all selected calculable fields.</p>}
        <Button className="w-full" disabled={!clientId || !lines.length || invalidCalculable || createEstimate.isPending} onClick={handleSave}>
          {createEstimate.isPending ? 'Saving…' : 'Save Estimate'}
        </Button>
      </div>
    </div>
  );
}

const EMPTY_FIELD_FORM: EstimateFieldInput = { label: '', fieldType: 'calculable', pricePerUnit: null, unitSize: null, sortOrder: null };

function EstimateFields() {
  const { data: fields, isLoading } = useListEstimateFields();
  const createField = useCreateEstimateField();
  const updateField = useUpdateEstimateField();
  const deleteField = useDeleteEstimateField();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ id: number | null; form: EstimateFieldInput } | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['/api/estimate-fields'] });

  const saveForm = () => {
    if (!editing || !editing.form.label.trim()) return;
    const data: EstimateFieldInput = {
      ...editing.form,
      label: editing.form.label.trim(),
      pricePerUnit: editing.form.fieldType === 'calculable' ? editing.form.pricePerUnit : null,
      unitSize: editing.form.fieldType === 'calculable' ? editing.form.unitSize : null,
    };
    const done = { onSuccess: () => { invalidate(); setEditing(null); } };
    if (editing.id == null) createField.mutate({ data }, done);
    else updateField.mutate({ id: editing.id, data }, done);
  };

  const formNumber = (key: 'pricePerUnit' | 'unitSize' | 'sortOrder') => ({
    value: editing?.form[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setEditing(prev => prev && ({ ...prev, form: { ...prev.form, [key]: e.target.value === '' ? null : Number(e.target.value) } })),
  });

  return (
    <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto h-full p-6 space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold">Reusable Fields</h2>
          <p className="text-sm text-muted-foreground">Property details like Turf Sqft, Gate Code, or Sprinkler Zones. Calculable fields price line items automatically.</p>
        </div>
        <Button onClick={() => setEditing({ id: null, form: { ...EMPTY_FIELD_FORM } })}>
          <Plus className="w-4 h-4 mr-2" /> Add Field
        </Button>
      </div>

      {isLoading ? <div>Loading...</div> :
       !fields?.length ? <div className="text-sm text-muted-foreground">No fields configured.</div> :
       <Table>
         <TableHeader>
           <TableRow>
             <TableHead>Label</TableHead>
             <TableHead>Type</TableHead>
             <TableHead>Pricing</TableHead>
             <TableHead>Sort</TableHead>
             <TableHead className="w-24"></TableHead>
           </TableRow>
         </TableHeader>
         <TableBody>
           {fields.map(f => (
             <TableRow key={f.id}>
               <TableCell className="font-medium">{f.label}</TableCell>
               <TableCell className="capitalize">{f.fieldType}</TableCell>
               <TableCell className="text-sm text-muted-foreground">
                 {f.fieldType === 'calculable' ? `$${f.pricePerUnit ?? 0} per ${f.unitSize ?? 1} units` : 'Informational'}
               </TableCell>
               <TableCell>{f.sortOrder ?? '—'}</TableCell>
               <TableCell className="text-right whitespace-nowrap">
                 <Button variant="ghost" size="sm" onClick={() => setEditing({
                   id: f.id,
                   form: { label: f.label, fieldType: f.fieldType, pricePerUnit: f.pricePerUnit ?? null, unitSize: f.unitSize ?? null, sortOrder: f.sortOrder ?? null },
                 })}>Edit</Button>
                 <Button variant="ghost" size="icon" className="text-destructive" onClick={() => {
                   if (confirm(`Delete field "${f.label}"? Existing estimates keep their saved lines.`)) {
                     deleteField.mutate({ id: f.id }, { onSuccess: invalidate });
                   }
                 }}>
                   <Trash2 className="w-4 h-4" />
                 </Button>
               </TableCell>
             </TableRow>
           ))}
         </TableBody>
       </Table>
      }

      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id == null ? 'Add Field' : 'Edit Field'}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Label</label>
                <Input value={editing.form.label} placeholder="e.g. Turf Sqft"
                  onChange={e => setEditing(prev => prev && ({ ...prev, form: { ...prev.form, label: e.target.value } }))} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Type</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editing.form.fieldType}
                  onChange={e => setEditing(prev => prev && ({ ...prev, form: { ...prev.form, fieldType: e.target.value as EstimateFieldInput['fieldType'] } }))}
                >
                  <option value="calculable">Calculable (prices a line item)</option>
                  <option value="number">Number (informational)</option>
                  <option value="text">Text (informational)</option>
                  <option value="boolean">Yes / No (informational)</option>
                </select>
              </div>
              {editing.form.fieldType === 'calculable' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium mb-1 block">Price per unit ($)</label>
                    <Input type="number" min="0" step="0.01" {...formNumber('pricePerUnit')} />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1 block">Unit size</label>
                    <Input type="number" min="0" step="1" placeholder="e.g. 1000" {...formNumber('unitSize')} />
                  </div>
                  <p className="text-xs text-muted-foreground col-span-2">
                    Example: $20 per 1000 sqft → price per unit 20, unit size 1000. A 6200 sqft value prices at $124.
                  </p>
                </div>
              )}
              <div>
                <label className="text-sm font-medium mb-1 block">Sort order</label>
                <Input type="number" className="w-32" {...formNumber('sortOrder')} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!editing?.form.label.trim() || createField.isPending || updateField.isPending} onClick={saveForm}>
              {editing?.id == null ? 'Create Field' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
