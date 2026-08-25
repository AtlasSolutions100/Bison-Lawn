import { useState, useRef, useEffect } from 'react';
import { useRoute } from 'wouter';
import { 
  useGetClient, 
  useUpdateClient, 
  useDeleteClient,
  useListClientNotes,
  useCreateClientNote,
  useListClientAudit,
  useListClientServices,
  useCreateClientService,
  useUpdateClientService,
  useDeleteClientService,
  useListServices,
  useListPackages,
  useCalculateServicePrice,
  Client
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { 
  ArrowLeft, MapPin, Phone, Mail, DollarSign, Calendar, FileText, 
  Settings, User, Plus, MessageSquare, Clock, Trash2 
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';
import { 
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter 
} from '@/components/ui/dialog';

export default function ClientDetail() {
  const [, params] = useRoute('/clients/:id');
  const id = params?.id ? parseInt(params.id) : 0;
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: client, isLoading } = useGetClient(id);
  const updateClient = useUpdateClient();

  if (isLoading) return <div className="p-8">Loading client...</div>;
  if (!client) return <div className="p-8">Client not found.</div>;

  const updateStatus = (status: 'lead' | 'client' | 'former_client') => {
    updateClient.mutate({ id, data: { status } }, {
      onSuccess: (data) => {
        queryClient.setQueryData([`/api/clients/${id}`], data);
      }
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)]">
      {/* Header Area */}
      <div className="bg-card border-b px-8 py-6 shadow-sm z-10 shrink-0">
        <div className="max-w-7xl mx-auto">
          <Link href="/clients" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary mb-4 transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Clients
          </Link>
          
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-extrabold tracking-tight text-foreground">{client.name}</h1>
                <select 
                  value={client.status}
                  onChange={(e) => updateStatus(e.target.value as any)}
                  className={`text-xs font-bold px-2 py-1 rounded-md border outline-none cursor-pointer
                    ${client.status === 'lead' ? 'bg-accent/20 text-accent-foreground border-accent/30' : 
                      client.status === 'client' ? 'bg-primary/10 text-primary border-primary/20' : 
                      'bg-muted text-muted-foreground border-border'}
                  `}
                >
                  <option value="lead">LEAD</option>
                  <option value="client">ACTIVE</option>
                  <option value="former_client">FORMER</option>
                </select>
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground pt-1">
                {client.phone && <span className="flex items-center gap-1"><Phone className="w-4 h-4"/> {client.phone}</span>}
                {client.email && <span className="flex items-center gap-1"><Mail className="w-4 h-4"/> {client.email}</span>}
                <span className="flex items-center gap-1"><MapPin className="w-4 h-4"/> {client.serviceAddress}, {client.city}</span>
              </div>
            </div>

            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 min-w-[200px] flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-primary/80 uppercase tracking-wider">Balance</p>
                <p className={`text-3xl font-bold mt-1 ${client.accountBalance > 0 ? 'text-destructive' : client.accountBalance < 0 ? 'text-primary' : 'text-foreground'}`}>
                  ${client.accountBalance.toLocaleString(undefined, {minimumFractionDigits: 2})}
                </p>
              </div>
              <RecordPaymentDialog clientId={id} />
            </div>
          </div>
        </div>
      </div>

      {/* Main Content scrollable */}
      <div className="flex-1 overflow-y-auto p-8 bg-muted/20">
        <div className="max-w-7xl mx-auto grid grid-cols-1 xl:grid-cols-3 gap-8">
          
          <div className="xl:col-span-2 space-y-8">
            <ClientServices clientId={id} />
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <ClientEstimates clientId={id} />
              <ClientInvoices clientId={id} />
            </div>

            <ClientAudit clientId={id} />
          </div>

          <div className="space-y-8">
            <ClientProperties client={client} />
            <ClientNotes clientId={id} />
          </div>
          
        </div>
      </div>
    </div>
  );
}

function RecordPaymentDialog({ clientId }: { clientId: number }) {
  // We'll implement payment recording in the invoices/payments sections, but keep the button here.
  const [, setLocation] = useLocation();
  return (
    <Button size="sm" onClick={() => setLocation(`/invoices?clientId=${clientId}`)}>
      Payments
    </Button>
  );
}

function ClientProperties({ client }: { client: Client }) {
  // Saved property details, keyed by estimate field label. Estimates prefill
  // from these values and can write corrected values back on save.
  const properties = Object.entries(client.propertyData ?? {});
  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <Settings className="w-5 h-5 text-muted-foreground" /> 
          Property Details
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {client.mapNote && (
          <div>
            <span className="text-xs font-semibold text-muted-foreground uppercase">Map / Crew Note</span>
            <p className="text-sm font-medium bg-accent/10 border border-accent/20 p-2 rounded-md mt-1 text-accent-foreground">
              {client.mapNote}
            </p>
          </div>
        )}
        {properties.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No property details saved yet. Build an estimate for this client and keep “Save these field values” checked to record them here.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {properties.map(([label, value]) => (
              <div key={label} className="bg-muted px-2.5 py-1 rounded-md text-xs border">
                <span className="font-semibold text-muted-foreground mr-1">{label}:</span>
                {value}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ClientNotes({ clientId }: { clientId: number }) {
  const { data: notes, isLoading } = useListClientNotes(clientId);
  const createNote = useCreateClientNote();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    createNote.mutate({ id: clientId, data: { body } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/notes`] });
        setBody("");
      }
    });
  };

  return (
    <Card className="shadow-sm border-border flex flex-col h-[500px]">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-muted-foreground" /> 
          Notes Timeline
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? <div className="text-sm text-muted-foreground animate-pulse">Loading notes...</div> : 
         !notes?.length ? <div className="text-sm text-muted-foreground text-center py-4">No notes yet.</div> :
         notes.map(note => (
          <div key={note.id} className="bg-muted/30 border p-3 rounded-lg">
            <div className="flex items-center justify-between mb-1 text-xs">
              <span className="font-semibold text-foreground">{note.authorName}</span>
              <span className="text-muted-foreground">{format(new Date(note.createdAt), 'MMM d, h:mm a')}</span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{note.body}</p>
          </div>
        ))}
      </CardContent>
      <div className="p-4 border-t bg-card/50 mt-auto">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input 
            placeholder="Add a note..." 
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" disabled={!body.trim() || createNote.isPending}>Add</Button>
        </form>
      </div>
    </Card>
  );
}

function ClientServices({ clientId }: { clientId: number }) {
  const { data: services, isLoading } = useListClientServices(clientId);
  const deleteService = useDeleteClientService();
  const queryClient = useQueryClient();

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Calendar className="w-5 h-5 text-muted-foreground" /> 
            Active Services & Subscriptions
          </CardTitle>
          <AddServiceDialog clientId={clientId} />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? <div className="p-6 text-center text-muted-foreground animate-pulse">Loading...</div> : 
         !services?.length ? <div className="p-6 text-center text-muted-foreground">No active services.</div> :
         <div className="divide-y">
           {services.map(s => (
             <div key={s.id} className="p-4 hover:bg-muted/30 transition-colors flex items-center justify-between group">
               <div>
                 <h4 className="font-bold text-foreground">{s.serviceName || s.packageName}</h4>
                 <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                   <span className="font-medium text-foreground">${s.amount.toLocaleString(undefined, {minimumFractionDigits:2})}</span>
                   {s.scheduleType === 'recurring' ? (
                     <span className="flex items-center gap-1"><Clock className="w-3 h-3"/> Every {s.frequencyWeeks} week(s)</span>
                   ) : (
                     <span className="flex items-center gap-1"><Calendar className="w-3 h-3"/> Window: {s.startDate} to {s.endDate}</span>
                   )}
                 </div>
               </div>
               <Button 
                 variant="ghost" 
                 size="icon" 
                 className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                 onClick={() => {
                   if(confirm('Remove this service?')) {
                     deleteService.mutate({ id: s.id }, {
                       onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/client-services`] })
                     });
                   }
                 }}
               >
                 <Trash2 className="w-4 h-4" />
               </Button>
             </div>
           ))}
         </div>
        }
      </CardContent>
    </Card>
  );
}

function AddServiceDialog({ clientId }: { clientId: number }) {
  const [open, setOpen] = useState(false);
  const { data: services } = useListServices();
  const { data: packages } = useListPackages();
  const createService = useCreateClientService();
  const calculatePrice = useCalculateServicePrice();
  const queryClient = useQueryClient();

  const [type, setType] = useState<'service'|'package'>('service');
  const [itemId, setItemId] = useState<string>('');
  const [sqft, setSqft] = useState<number>(0);
  const [priceOverride, setPriceOverride] = useState<string>('');
  const [scheduleType, setScheduleType] = useState<'window'|'recurring'>('recurring');

  const [livePrice, setLivePrice] = useState<number|null>(null);

  // Live price effect
  useEffect(() => {
    if (type === 'service' && itemId && sqft > 0) {
      calculatePrice.mutate({ id: parseInt(itemId), data: { sqft } }, {
        onSuccess: (data) => setLivePrice(data.price)
      });
    } else {
      setLivePrice(null);
    }
  }, [type, itemId, sqft]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalPrice = priceOverride ? parseFloat(priceOverride) : (livePrice || 0);
    
    // In a real app we'd collect all the schedule dates from form inputs. 
    // Mocking the dates for the payload.
    const payload: any = {
      amount: finalPrice,
      scheduleType,
      ...(type === 'service' ? { serviceId: parseInt(itemId) } : { packageId: parseInt(itemId) }),
      ...(scheduleType === 'recurring' ? {
        frequencyWeeks: 1, firstDate: '2024-05-01', renewDate: '2025-05-01'
      } : {
        startDate: '2024-05-01', endDate: '2024-05-07'
      })
    };

    createService.mutate({ id: clientId, data: payload }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/client-services`] });
        setOpen(false);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 bg-primary text-primary-foreground hover:bg-primary/90">
          <Plus className="w-4 h-4 mr-1" /> Assign Service
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign Service or Package</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Type</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none" value={type} onChange={(e) => {setType(e.target.value as any); setItemId('');}}>
                <option value="service">Single Service</option>
                <option value="package">Package / Bundle</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Item</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none" value={itemId} onChange={(e) => setItemId(e.target.value)} required>
                <option value="">Select...</option>
                {type === 'service' 
                  ? services?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)
                  : packages?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)
                }
              </select>
            </div>
          </div>

          {type === 'service' && itemId && (
            <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg border">
              <div>
                <label className="text-sm font-medium mb-1 block">Property Sqft</label>
                <Input type="number" value={sqft || ''} onChange={(e) => setSqft(parseInt(e.target.value)||0)} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Calculated Price</label>
                <div className="h-10 flex items-center px-3 font-bold text-lg bg-background border rounded-md text-primary">
                  {livePrice !== null ? `$${livePrice.toFixed(2)}` : '--'}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Price Override ($)</label>
              <Input type="number" step="0.01" value={priceOverride} onChange={(e) => setPriceOverride(e.target.value)} placeholder="Leave blank for calc" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Schedule Type</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none" value={scheduleType} onChange={(e) => setScheduleType(e.target.value as any)}>
                <option value="recurring">Recurring (Weekly/etc)</option>
                <option value="window">Date Window (One-off)</option>
              </select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!itemId || createService.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ClientEstimates({ clientId }: { clientId: number }) {
  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <FileText className="w-5 h-5 text-muted-foreground" /> Estimates
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 text-center text-muted-foreground">
        Estimates list goes here.
      </CardContent>
    </Card>
  );
}

function ClientInvoices({ clientId }: { clientId: number }) {
  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-muted-foreground" /> Invoices
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 text-center text-muted-foreground">
        Invoices list goes here.
      </CardContent>
    </Card>
  );
}

function ClientAudit({ clientId }: { clientId: number }) {
  const [open, setOpen] = useState(false);
  const { data: audit, isLoading } = useListClientAudit(clientId, { query: { enabled: open, queryKey: ['/api/clients', clientId, 'audit'] } });

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50 cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setOpen(!open)}>
        <CardTitle className="text-sm font-bold flex items-center justify-between text-muted-foreground">
          <span>Audit Trail (History)</span>
          <span className="text-xs font-normal">{open ? 'Hide' : 'Show'}</span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="p-4">
          {isLoading ? <div className="text-xs animate-pulse">Loading history...</div> : 
           !audit?.length ? <div className="text-xs">No history found.</div> :
           <div className="space-y-3">
             {audit.map(a => (
               <div key={a.id} className="text-sm flex gap-4">
                 <span className="w-32 shrink-0 text-xs text-muted-foreground font-medium">{format(new Date(a.createdAt), 'MM/dd/yy h:mm a')}</span>
                 <div>
                   <span className="font-semibold text-foreground mr-2">{a.action}</span>
                   <span className="text-muted-foreground">{a.description}</span>
                 </div>
               </div>
             ))}
           </div>
          }
        </CardContent>
      )}
    </Card>
  );
}
