import { useMemo, useState } from 'react';
import { useListClients, useCreateClient, useUpdateClient, Client } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow 
} from '@/components/ui/table';
import { 
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter 
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Search, Plus, MapPin, Phone, Mail, ChevronRight, Droplets } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';
import { MapCodeBadge, WaterProviderLookupLink, mapCodeChipClass } from '@/components/map-code';

const clientSchema = z.object({
  name: z.string().min(2, "Name is required"),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  billingAddress: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingZip: z.string().optional(),
  serviceAddress: z.string().min(5, "Service Address is required"),
  city: z.string().min(2, "Service City is required"),
  mapCode: z.string().max(16, "Map codes are a short shorthand, e.g. PF").optional(),
  waterDistrict: z.string().optional(),
  status: z.enum(['lead', 'client', 'former_client']),
  accountBalance: z.coerce.number().default(0),
});

export default function Clients() {
  const [statusFilter, setStatusFilter] = useState<'lead'|'client'|'former_client'|'all'>('all');
  const [search, setSearch] = useState('');
  const [mapCodeFilter, setMapCodeFilter] = useState<string>('all');
  /*
    Sorting is a mode rather than a flag now. "Can leads be organized
    alphabetically but also looked up based on input date" — alphabetical is the
    default and always was; what was missing is being able to ask "who came in
    most recently", which for a lead list is the question you actually have.
  */
  const [sort, setSort] = useState<'name' | 'mapCode' | 'added'>('name');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const queryParams = {
    ...(statusFilter !== 'all' && { status: statusFilter }),
    ...(search && { search })
  };

  const { data: clients, isLoading } = useListClients(queryParams);

  // Zones come from the clients themselves rather than a settings list: he
  // invents a map code the moment he takes on a new corner of town, and having
  // to register it somewhere first is how records end up with no zone at all.
  const mapCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const client of clients ?? []) {
      const code = client.mapCode?.trim();
      if (code) codes.add(code.toUpperCase());
    }
    return [...codes].sort((a, b) => a.localeCompare(b));
  }, [clients]);

  const visibleClients = useMemo(() => {
    const rows = (clients ?? []).filter((client) => {
      const code = client.mapCode?.trim().toUpperCase() ?? '';
      if (mapCodeFilter === 'all') return true;
      if (mapCodeFilter === 'none') return code === '';
      return code === mapCodeFilter;
    });
    if (sort === 'name') return rows;

    if (sort === 'added') {
      return [...rows].sort((a, b) => {
        // Newest first: a lead list is read to find the enquiry that just came
        // in, not the oldest one. Customers with no recorded date sort last
        // rather than pretending to be the oldest.
        const aAt = a.createdAt ? new Date(a.createdAt).getTime() : null;
        const bAt = b.createdAt ? new Date(b.createdAt).getTime() : null;
        if (aAt == null && bAt == null) return a.name.localeCompare(b.name);
        if (aAt == null) return 1;
        if (bAt == null) return -1;
        return bAt - aAt || a.name.localeCompare(b.name);
      });
    }

    return [...rows].sort((a, b) => {
      const aCode = a.mapCode?.trim().toUpperCase() ?? '';
      const bCode = b.mapCode?.trim().toUpperCase() ?? '';
      // Unzoned clients sort last, not first: they are the ones still needing a
      // route decision, and mixed in alphabetically they never get made.
      if (aCode !== bCode) {
        if (!aCode) return 1;
        if (!bCode) return -1;
        return aCode.localeCompare(bCode);
      }
      return a.name.localeCompare(b.name);
    });
  }, [clients, mapCodeFilter, sort]);

  // Selection survives across filter changes but only ever acts on rows the
  // office can currently see — applying a map code to a client scrolled out of
  // view by a filter change is a silent edit nobody asked for.
  const visibleIds = visibleClients.map((client) => client.id);
  const selectedVisibleIds = selectedIds.filter((id) => visibleIds.includes(id));
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length;

  const toggleClient = (id: number, checked: boolean) =>
    setSelectedIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((existing) => existing !== id)));

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Clients & Leads</h1>
          <p className="text-muted-foreground mt-1">Manage your customer database and properties.</p>
        </div>
        <NewClientDialog />
      </div>

      <div className="flex flex-col sm:flex-row justify-between items-center gap-4 bg-card p-2 rounded-lg border shadow-sm">
        <Tabs value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)} className="w-full sm:w-auto">
          <TabsList className="grid w-full sm:w-[400px] grid-cols-4">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="lead">Leads</TabsTrigger>
            <TabsTrigger value="client">Active</TabsTrigger>
            <TabsTrigger value="former_client">Former</TabsTrigger>
          </TabsList>
        </Tabs>
        
        <div className="flex w-full sm:w-auto items-center gap-2">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
            value={mapCodeFilter}
            onChange={(e) => setMapCodeFilter(e.target.value)}
            aria-label="Filter by map code"
          >
            <option value="all">All map codes</option>
            <option value="none">No map code</option>
            {mapCodes.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>

          <div className="relative flex-1 sm:w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search name, city, map code..."
              className="pl-9 bg-background"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {selectedVisibleIds.length > 0 && (
        <BulkMapCodeBar
          ids={selectedVisibleIds}
          knownCodes={mapCodes}
          onDone={() => setSelectedIds([])}
        />
      )}

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-hidden flex flex-col">
        <div className="overflow-auto flex-1">
          <Table>
            <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-sm">
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer align-middle accent-primary"
                    aria-label="Select all shown clients"
                    checked={allVisibleSelected}
                    onChange={(e) => setSelectedIds(e.target.checked ? visibleIds : [])}
                  />
                </TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Service Location</TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="font-medium hover:text-primary transition-colors"
                    onClick={() => setSort(sort === 'mapCode' ? 'name' : 'mapCode')}
                    title="Group the list by route zone"
                  >
                    Map Code / Water {sort === 'mapCode' ? '▲' : ''}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="font-medium hover:text-primary transition-colors"
                    onClick={() => setSort(sort === 'added' ? 'name' : 'added')}
                    title="Sort by when they were added, newest first"
                    data-testid="sort-by-added"
                  >
                    Added {sort === 'added' ? '▼' : ''}
                  </button>
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-10 text-muted-foreground animate-pulse">
                    Loading clients...
                  </TableCell>
                </TableRow>
              ) : !visibleClients.length ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                    No clients found.
                  </TableCell>
                </TableRow>
              ) : (
                visibleClients.map((client) => (
                  <ClientRow
                    key={client.id}
                    client={client}
                    selected={selectedIds.includes(client.id)}
                    onSelectedChange={(checked) => toggleClient(client.id, checked)}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function BulkMapCodeBar({ ids, knownCodes, onDone }: {
  ids: number[];
  knownCodes: string[];
  onDone: () => void;
}) {
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const updateClient = useUpdateClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const apply = async () => {
    setSaving(true);
    let done = 0;
    try {
      // One at a time on purpose. Re-zoning a route can touch a hundred rows,
      // and firing that many PATCHes at once leaves a half-applied change with
      // nothing to say which clients took it — the count below is only honest
      // because each request has finished before the next one starts.
      for (const id of ids) {
        await updateClient.mutateAsync({ id, data: { mapCode: code.trim().toUpperCase() || null } });
        done++;
      }
      toast({ title: `Map code applied to ${done} client${done === 1 ? '' : 's'}` });
      onDone();
    } catch (error) {
      toast({
        title: done ? `Stopped after ${done} of ${ids.length}` : 'Map code could not be applied',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
      queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
    }
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-primary/5 border border-primary/20 rounded-lg p-3">
      <span className="text-sm font-semibold">{ids.length} selected</span>
      <div className="flex items-center gap-2">
        <Input
          className="h-9 w-40 bg-background uppercase"
          placeholder="Map code, e.g. PF"
          maxLength={16}
          list="known-map-codes"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <datalist id="known-map-codes">
          {knownCodes.map((known) => <option key={known} value={known} />)}
        </datalist>
        <Button size="sm" onClick={apply} disabled={saving}>
          {saving ? 'Applying...' : 'Apply map code'}
        </Button>
        <Button size="sm" variant="outline" onClick={onDone} disabled={saving}>Clear</Button>
      </div>
      <span className="text-xs text-muted-foreground">Leave blank to clear the map code on the selected clients.</span>
    </div>
  );
}

function ClientRow({ client, selected, onSelectedChange }: {
  client: Client;
  selected: boolean;
  onSelectedChange: (checked: boolean) => void;
}) {
  const [, setLocation] = useLocation();

  const statusColors = {
    lead: "bg-accent/20 text-accent-foreground border-accent/30",
    client: "bg-primary/10 text-primary border-primary/20",
    former_client: "bg-muted text-muted-foreground border-border",
  };

  return (
    <TableRow 
      className="cursor-pointer hover:bg-muted/50 transition-colors group"
      onClick={() => setLocation(`/clients/${client.id}`)}
    >
      <TableCell onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer align-middle accent-primary"
          aria-label={`Select ${client.name}`}
          checked={selected}
          onChange={(e) => onSelectedChange(e.target.checked)}
        />
      </TableCell>
      <TableCell className="font-semibold text-foreground">
        {client.name}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1 text-sm">
          {client.phone && <span className="flex items-center gap-1.5 text-muted-foreground"><Phone className="w-3 h-3"/> {client.phone}</span>}
          {client.email && <span className="flex items-center gap-1.5 text-muted-foreground"><Mail className="w-3 h-3"/> {client.email}</span>}
          {!client.phone && !client.email && <span className="text-muted-foreground/50 italic">No contact info</span>}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-1.5 font-medium text-foreground"><MapPin className="w-3.5 h-3.5 text-muted-foreground"/> {client.serviceAddress}</span>
          <span className="text-muted-foreground ml-5">{client.city}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1 text-sm">
          {client.mapCode?.trim()
            ? <MapCodeBadge code={client.mapCode} />
            : <span className="text-muted-foreground/50 italic text-xs">No map code</span>}
          {client.waterDistrict && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Droplets className="w-3 h-3" /> {client.waterDistrict}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
        {client.createdAt
          ? new Date(client.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
          : <span className="text-muted-foreground/50 italic text-xs">—</span>}
      </TableCell>
      <TableCell>
        <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${statusColors[client.status as keyof typeof statusColors]}`}>
          {client.status === 'former_client' ? 'FORMER' : client.status.toUpperCase()}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <span className={`font-semibold ${client.accountBalance > 0 ? 'text-destructive' : client.accountBalance < 0 ? 'text-primary' : 'text-muted-foreground'}`}>
          ${client.accountBalance.toLocaleString(undefined, {minimumFractionDigits:2})}
        </span>
      </TableCell>
      <TableCell>
        <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
      </TableCell>
    </TableRow>
  );
}

function NewClientDialog() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const createClient = useCreateClient();
  
  const form = useForm<z.infer<typeof clientSchema>>({
    resolver: zodResolver(clientSchema),
    defaultValues: {
      name: '', email: '', phone: '', serviceAddress: '', city: '',
      mapCode: '', waterDistrict: '', status: 'lead', accountBalance: 0
    }
  });

  const onSubmit = (values: z.infer<typeof clientSchema>) => {
    // Blank means "not known yet", which is not the same as an empty map code
    // sitting in the column and reading as a real zone in the filter list.
    const data = {
      ...values,
      mapCode: values.mapCode?.trim().toUpperCase() || undefined,
      waterDistrict: values.waterDistrict?.trim() || undefined,
    };
    createClient.mutate({ data }, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
        setOpen(false);
        setLocation(`/clients/${res.id}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-sm">
          <Plus className="w-4 h-4 mr-2" /> New Client
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Create New Client</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem className="col-span-2"><FormLabel>Full Name / Company</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
              )} />
              <FormField control={form.control} name="phone" render={({ field }) => (
                <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
              )} />
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem><FormLabel>Email</FormLabel><FormControl><Input {...field} type="email" /></FormControl><FormMessage/></FormItem>
              )} />
              <div className="col-span-2 pt-2 pb-1 border-b">
                <h4 className="font-semibold text-sm">Service Location</h4>
              </div>
              <FormField control={form.control} name="serviceAddress" render={({ field }) => (
                <FormItem className="col-span-2"><FormLabel>Address</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
              )} />
              <FormField control={form.control} name="city" render={({ field }) => (
                <FormItem><FormLabel>City</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
              )} />
              <FormField control={form.control} name="mapCode" render={({ field }) => (
                <FormItem>
                  <FormLabel>Map Code</FormLabel>
                  <FormControl><Input {...field} className="uppercase" placeholder="e.g. PF" maxLength={16} /></FormControl>
                  <FormMessage/>
                </FormItem>
              )} />
              <FormField control={form.control} name="waterDistrict" render={({ field }) => (
                <FormItem className="col-span-2">
                  <div className="flex items-center justify-between">
                    <FormLabel>Water District</FormLabel>
                    <WaterProviderLookupLink />
                  </div>
                  <FormControl><Input {...field} placeholder="e.g. Whitworth Water District No. 2" /></FormControl>
                  <FormMessage/>
                </FormItem>
              )} />
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel>
                  <select 
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    {...field}
                  >
                    <option value="lead">Lead</option>
                    <option value="client">Active Client</option>
                  </select>
                <FormMessage/></FormItem>
              )} />
            </div>
            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createClient.isPending}>
                {createClient.isPending ? "Creating..." : "Save Client"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
