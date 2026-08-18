import { useState } from 'react';
import { useListClients, useCreateClient, Client } from '@workspace/api-client-react';
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
import { Search, Plus, MapPin, Phone, Mail, ChevronRight } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

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
  status: z.enum(['lead', 'client', 'former_client']),
  accountBalance: z.coerce.number().default(0),
});

export default function Clients() {
  const [statusFilter, setStatusFilter] = useState<'lead'|'client'|'former_client'|'all'>('all');
  const [search, setSearch] = useState('');
  
  const queryParams = { 
    ...(statusFilter !== 'all' && { status: statusFilter }),
    ...(search && { search })
  };
  
  const { data: clients, isLoading } = useListClients(queryParams);

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
        
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search name, email, or city..."
            className="pl-9 bg-background"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-hidden flex flex-col">
        <div className="overflow-auto flex-1">
          <Table>
            <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-sm">
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Service Location</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-muted-foreground animate-pulse">
                    Loading clients...
                  </TableCell>
                </TableRow>
              ) : !clients?.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                    No clients found.
                  </TableCell>
                </TableRow>
              ) : (
                clients.map((client) => (
                  <ClientRow key={client.id} client={client} />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function ClientRow({ client }: { client: Client }) {
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
      name: '', email: '', phone: '', serviceAddress: '', city: '', status: 'lead', accountBalance: 0
    }
  });

  const onSubmit = (data: z.infer<typeof clientSchema>) => {
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
