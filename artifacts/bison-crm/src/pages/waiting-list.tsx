import { useState } from 'react';
import { useListWaitingList, useDispatchJobs, useListUsers } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { format } from 'date-fns';

export default function WaitingList() {
  const [dateRange, setDateRange] = useState({ from: '', to: '' });
  const { data: jobs, isLoading } = useListWaitingList(dateRange.from || dateRange.to ? dateRange : undefined);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Waiting List</h1>
          <p className="text-muted-foreground mt-1">Jobs with date windows not yet dispatched.</p>
        </div>
        <div className="flex items-center gap-4">
          <Input type="date" value={dateRange.from} onChange={e => setDateRange(prev => ({...prev, from: e.target.value}))} className="w-40" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" value={dateRange.to} onChange={e => setDateRange(prev => ({...prev, to: e.target.value}))} className="w-40" />
          <DispatchDialog selectedIds={selectedIds} onComplete={() => setSelectedIds([])} />
        </div>
      </div>

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-12"></TableHead>
              <TableHead>Client</TableHead>
              <TableHead>City</TableHead>
              <TableHead>Service</TableHead>
              <TableHead>Window Start</TableHead>
              <TableHead>Window End</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-4">Loading...</TableCell></TableRow>
            ) : !jobs?.length ? (
              <TableRow><TableCell colSpan={6} className="text-center py-4">No jobs in waiting list.</TableCell></TableRow>
            ) : (
              jobs.map(j => (
                <TableRow key={j.id} className="hover:bg-muted/50 cursor-pointer" onClick={() => toggleSelect(j.id)}>
                  <TableCell onClick={e => e.stopPropagation()}>
                    <Checkbox checked={selectedIds.includes(j.id)} onCheckedChange={() => toggleSelect(j.id)} />
                  </TableCell>
                  <TableCell className="font-semibold">{j.clientName}</TableCell>
                  <TableCell>{j.city}</TableCell>
                  <TableCell>{j.serviceName}</TableCell>
                  <TableCell>{j.windowStart}</TableCell>
                  <TableCell>{j.windowEnd || 'End of window'}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DispatchDialog({ selectedIds, onComplete }: { selectedIds: number[], onComplete: () => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [contractorId, setContractorId] = useState<string>('');
  
  const { data: users } = useListUsers();
  const dispatchJobs = useDispatchJobs();
  const queryClient = useQueryClient();

  const contractors = users?.filter(u => u.role === 'contractor') || [];

  const handleDispatch = () => {
    dispatchJobs.mutate({
      data: {
        jobIds: selectedIds,
        date,
        assignedToId: contractorId ? parseInt(contractorId) : undefined
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/waiting-list'] });
        queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
        setOpen(false);
        onComplete();
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={selectedIds.length === 0}>
          Dispatch ({selectedIds.length})
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dispatch Jobs</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <label className="text-sm font-medium">Date</label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium">Contractor (Optional)</label>
            <select 
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={contractorId} 
              onChange={e => setContractorId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleDispatch} disabled={dispatchJobs.isPending}>Confirm Dispatch</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
