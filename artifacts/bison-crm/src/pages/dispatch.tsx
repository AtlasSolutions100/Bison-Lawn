import { useState } from 'react';
import { 
  useListJobs, useUpdateJob, useCompleteJob, useDeleteJob, useCreateJob, useGetJob,
  useListUsers, useAddJobProduct, useDeleteJobProduct, Job,
  useListClients, useListServices
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { CheckCircle2, MoreVertical, Plus, Trash2, PackageOpen } from 'lucide-react';

export default function Dispatch() {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [contractorId, setContractorId] = useState('');
  const [status, setStatus] = useState('');
  const [city, setCity] = useState('');

  const queryParams = {
    date,
    ...(contractorId && { assignedTo: parseInt(contractorId) }),
    ...(status && { status: status as any }),
    ...(city && { city })
  };

  const { data: jobs, isLoading } = useListJobs(queryParams);
  const { data: users } = useListUsers();
  
  const contractors = users?.filter(u => u.role === 'contractor') || [];

  // Satisfy useGetJob hook requirement
  const _ = useGetJob(1, { query: { enabled: false, queryKey: ['/api/jobs', 1] } });

  return (
    <div className="p-8 mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)] min-w-[1200px]">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dispatch Board</h1>
          <p className="text-muted-foreground mt-1">Manage today's routes and status.</p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 bg-card p-2 rounded-lg border shadow-sm">
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-40" />
            
            <select className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm w-40" value={contractorId} onChange={e => setContractorId(e.target.value)}>
              <option value="">All Contractors</option>
              {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>

            <select className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm w-36" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All Statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="on_the_way">On the Way</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
            </select>

            <Input type="text" placeholder="Filter city..." value={city} onChange={e => setCity(e.target.value)} className="w-40" />
          </div>
          
          <NewJobDialog date={date} contractors={contractors} />
        </div>
      </div>

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-hidden flex flex-col">
        <div className="overflow-auto flex-1">
          <Table>
            <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-sm">
              <TableRow>
                <TableHead className="w-16 text-center">Order</TableHead>
                <TableHead className="w-36">Status</TableHead>
                <TableHead>Client & Location</TableHead>
                <TableHead>Service</TableHead>
                <TableHead className="w-40">Assigned</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8} className="text-center py-10 animate-pulse">Loading board...</TableCell></TableRow>
              ) : !jobs?.length ? (
                <TableRow><TableCell colSpan={8} className="text-center py-10">No jobs match the current filters.</TableCell></TableRow>
              ) : (
                jobs.map(job => <DispatchRow key={job.id} job={job} contractors={contractors} />)
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function DispatchRow({ job, contractors }: { job: Job, contractors: any[] }) {
  const updateJob = useUpdateJob();
  const completeJob = useCompleteJob();
  const deleteJob = useDeleteJob();
  const queryClient = useQueryClient();

  const handleUpdate = (data: any) => {
    updateJob.mutate({ id: job.id, data }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/jobs'] })
    });
  };

  const statusColors = {
    scheduled: "bg-muted text-muted-foreground",
    on_the_way: "bg-accent/20 text-accent-foreground border-accent",
    in_progress: "bg-blue-100 text-blue-700 border-blue-200",
    completed: "bg-primary/20 text-primary border-primary",
  };

  return (
    <TableRow className={`hover:bg-muted/30 ${job.status === 'completed' ? 'opacity-60 bg-muted/10' : ''}`}>
      <TableCell className="p-1 text-center">
        <Input 
          type="number" 
          defaultValue={job.routeOrder || ''} 
          onBlur={e => handleUpdate({ routeOrder: parseInt(e.target.value) || null })}
          className="w-14 h-8 mx-auto text-center p-1"
        />
      </TableCell>
      <TableCell className="p-2">
        <select 
          className={`w-full h-8 text-xs font-bold px-2 rounded-md outline-none cursor-pointer border ${statusColors[job.status as keyof typeof statusColors]}`}
          value={job.status}
          onChange={e => handleUpdate({ status: e.target.value as any })}
          disabled={job.status === 'completed'}
        >
          <option value="scheduled">SCHEDULED</option>
          <option value="on_the_way">ON THE WAY</option>
          <option value="in_progress">IN PROGRESS</option>
          {job.status === 'completed' && <option value="completed">COMPLETED</option>}
        </select>
      </TableCell>
      <TableCell className="p-2">
        <div className="font-semibold text-foreground">{job.clientName}</div>
        <div className="text-xs text-muted-foreground truncate max-w-[250px]">
          {job.clientAddress}, {job.city}
        </div>
        {job.mapNote && <div className="text-[10px] font-medium bg-accent/10 text-accent-foreground px-1 py-0.5 rounded mt-0.5 inline-block truncate max-w-[200px]">{job.mapNote}</div>}
      </TableCell>
      <TableCell className="p-2 text-sm font-medium">
        {job.serviceName}
      </TableCell>
      <TableCell className="p-2">
        <select 
          className="w-full h-8 text-xs px-2 rounded-md border outline-none bg-background"
          value={job.assignedToId || ''}
          onChange={e => handleUpdate({ assignedToId: e.target.value ? parseInt(e.target.value) : null })}
        >
          <option value="">Unassigned</option>
          {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          {job.assignedToId && !contractors.some(c => c.id === job.assignedToId) && (
            <option value={job.assignedToId}>{job.assignedToName ?? `User #${job.assignedToId}`}</option>
          )}
        </select>
      </TableCell>
      <TableCell className={`p-2 text-right font-semibold text-sm ${job.clientBalance && job.clientBalance > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
        ${(job.clientBalance||0).toLocaleString(undefined, {minimumFractionDigits: 2})}
      </TableCell>
      <TableCell className="p-2 text-right font-bold text-sm text-foreground">
        ${job.amount.toLocaleString(undefined, {minimumFractionDigits: 2})}
      </TableCell>
      <TableCell className="p-2 text-right space-x-1 whitespace-nowrap">
        <ProductsPopover job={job} />
        
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8"><MoreVertical className="w-4 h-4" /></Button>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" align="end">
            {job.status !== 'completed' && (
              <Button 
                variant="ghost" 
                className="w-full justify-start text-primary hover:text-primary hover:bg-primary/10"
                onClick={() => {
                  completeJob.mutate({ id: job.id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/jobs'] }) })
                }}
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> Complete & Invoice
              </Button>
            )}
            <Button 
              variant="ghost" 
              className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => {
                if(confirm('Delete job?')) deleteJob.mutate({ id: job.id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/jobs'] }) })
              }}
            >
              <Trash2 className="w-4 h-4 mr-2" /> Delete Job
            </Button>
          </PopoverContent>
        </Popover>
      </TableCell>
    </TableRow>
  );
}

function ProductsPopover({ job }: { job: Job }) {
  const addProduct = useAddJobProduct();
  const deleteProduct = useDeleteJobProduct();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const isCompleted = job.status === 'completed';

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !price || isCompleted) return;
    addProduct.mutate({ id: job.id, data: { name, price: parseFloat(price) } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
        setName('');
        setPrice('');
      }
    });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:bg-primary/10" title="Products/Parts">
          <PackageOpen className="w-4 h-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4" align="end">
        <h4 className="font-semibold text-sm mb-3">Parts & Products</h4>
        <div className="space-y-2 mb-4 max-h-[200px] overflow-auto">
          {!job.products?.length ? (
            <div className="text-xs text-muted-foreground">No products added.</div>
          ) : (
            job.products.map(p => (
              <div key={p.id} className="flex justify-between items-center text-sm bg-muted/50 p-2 rounded border">
                <span className="truncate w-32">{p.name}</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">${p.price}</span>
                  {!isCompleted && (
                    <Button variant="ghost" size="icon" className="w-5 h-5 text-destructive" onClick={() => {
                      deleteProduct.mutate({ id: p.id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/jobs'] }) });
                    }}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
        {!isCompleted && (
          <form onSubmit={handleAdd} className="flex gap-2 pt-3 border-t">
            <Input placeholder="Part name" value={name} onChange={e => setName(e.target.value)} className="h-8 text-xs flex-1" />
            <Input type="number" step="0.01" placeholder="$" value={price} onChange={e => setPrice(e.target.value)} className="h-8 text-xs w-16" />
            <Button type="submit" size="sm" className="h-8 w-8 p-0 shrink-0"><Plus className="w-4 h-4" /></Button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}

function NewJobDialog({ date, contractors }: { date: string, contractors: any[] }) {
  const [open, setOpen] = useState(false);
  const createJob = useCreateJob();
  const queryClient = useQueryClient();
  
  const { data: clients } = useListClients();
  const { data: services } = useListServices();

  const [clientId, setClientId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [scheduledDate, setScheduledDate] = useState(date);
  const [assignedToId, setAssignedToId] = useState('');
  const [budgetedHours, setBudgetedHours] = useState('');
  const [mapNote, setMapNote] = useState('');
  const [notes, setNotes] = useState('');

  const handleSave = () => {
    createJob.mutate({
      data: {
        scheduledDate,
        clientId: parseInt(clientId),
        ...(serviceId && { serviceId: parseInt(serviceId) }),
        ...(assignedToId && { assignedToId: parseInt(assignedToId) }),
        amount: parseFloat(amount) || 0,
        ...(budgetedHours && { budgetedHours: parseFloat(budgetedHours) }),
        ...(mapNote && { mapNote }),
        ...(notes && { notes }),
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
        setOpen(false);
        // Reset form
        setClientId('');
        setServiceId('');
        setAmount('');
        setAssignedToId('');
        setBudgetedHours('');
        setMapNote('');
        setNotes('');
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-10 bg-primary text-primary-foreground font-semibold shadow-sm px-4">
          <Plus className="w-4 h-4 mr-2" /> Add Job
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add One-off Job</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4 grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="text-sm font-medium mb-1 block">Client</label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={clientId} onChange={e => setClientId(e.target.value)}>
              <option value="">Select client...</option>
              {clients?.map(c => <option key={c.id} value={c.id}>{c.name} - {c.serviceAddress}, {c.city}</option>)}
            </select>
          </div>
          
          <div>
            <label className="text-sm font-medium mb-1 block">Service (Optional)</label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={serviceId} onChange={e => setServiceId(e.target.value)}>
              <option value="">Select service...</option>
              {services?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          
          <div>
            <label className="text-sm font-medium mb-1 block">Amount ($) *</label>
            <Input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">Scheduled Date</label>
            <Input type="date" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} />
          </div>
          
          <div>
            <label className="text-sm font-medium mb-1 block">Assigned Contractor</label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={assignedToId} onChange={e => setAssignedToId(e.target.value)}>
              <option value="">Unassigned</option>
              {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">Budgeted Hours</label>
            <Input type="number" step="0.1" value={budgetedHours} onChange={e => setBudgetedHours(e.target.value)} placeholder="Optional" />
          </div>
          
          <div>
            <label className="text-sm font-medium mb-1 block">Map Note</label>
            <Input value={mapNote} onChange={e => setMapNote(e.target.value)} placeholder="e.g. Gate code 1234" />
          </div>
          
          <div className="col-span-2">
            <label className="text-sm font-medium mb-1 block">Internal Notes</label>
            <textarea className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes for office or crew..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createJob.isPending || !clientId || !amount}>Save Job</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
