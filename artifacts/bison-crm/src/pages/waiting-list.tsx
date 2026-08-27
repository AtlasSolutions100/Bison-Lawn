import { useMemo, useState } from 'react';
import {
  useListWaitingList, useDispatchJobs, useListUsers, useListServices, useListClients,
  useBuildRouteFromWaitingList, RouteBuildResult
} from '@workspace/api-client-react';
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
          <BuildRouteDialog />
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

const CAP_REASON: Record<string, string> = {
  stops: 'the stop count',
  dollars: 'the dollar cap',
  hours: 'the hours cap',
};

const emptyForm = {
  date: format(new Date(), 'yyyy-MM-dd'),
  serviceId: '',
  mapCode: '',
  city: '',
  contractorId: '',
  maxStops: '',
  maxDollars: '',
  maxHours: '',
};

/**
 * Carves a day-sized route out of the waiting list. Preview first, apply second:
 * a blow-out season drops several hundred jobs in here at once and nobody is
 * going to unpick four hundred wrongly scheduled jobs by hand, so the dialog
 * never sends apply until the office has seen the stops it would take.
 */
function BuildRouteDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [preview, setPreview] = useState<RouteBuildResult | null>(null);

  const { data: users } = useListUsers();
  const { data: services } = useListServices();
  const { data: clients } = useListClients();
  const buildRoute = useBuildRouteFromWaitingList();
  const queryClient = useQueryClient();

  const contractors = users?.filter(u => u.role === 'contractor') || [];

  const { mapCodes, cities } = useMemo(() => {
    const codes = new Set<string>();
    const towns = new Set<string>();
    for (const c of clients ?? []) {
      if (c.mapCode?.trim()) codes.add(c.mapCode.trim());
      if (c.city?.trim()) towns.add(c.city.trim());
    }
    return { mapCodes: [...codes].sort(), cities: [...towns].sort() };
  }, [clients]);

  // Any change to the filters or caps throws the preview away. Applying a
  // preview that no longer matches what is on screen would schedule a different
  // set of jobs than the one the office just read.
  const setField = (key: keyof typeof form, value: string) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setPreview(null);
  };

  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const submit = (apply: boolean) => {
    buildRoute.mutate({
      data: {
        scheduledDate: form.date,
        serviceId: form.serviceId ? parseInt(form.serviceId) : null,
        mapCode: form.mapCode || null,
        city: form.city || null,
        assignedToId: form.contractorId ? parseInt(form.contractorId) : null,
        maxStops: num(form.maxStops),
        maxDollars: num(form.maxDollars),
        maxHours: num(form.maxHours),
        apply,
      }
    }, {
      onSuccess: (result) => {
        if (!apply) {
          setPreview(result);
          return;
        }
        queryClient.invalidateQueries({ queryKey: ['/api/waiting-list'] });
        queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
        setPreview(null);
        setForm(emptyForm);
        setOpen(false);
      }
    });
  };

  // Cumulative dollars down the route, so the office can see where the money is
  // by the time the truck reaches each stop rather than only the final figure.
  let running = 0;
  const stops = (preview?.selected ?? []).map(s => {
    running += s.amount;
    return { ...s, runningTotal: running };
  });

  return (
    <Dialog open={open} onOpenChange={next => { setOpen(next); if (!next) setPreview(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline">Build Route</Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Build Route from Waiting List</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Route Date</label>
              <Input type="date" value={form.date} onChange={e => setField('date', e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium">Contractor (Optional)</label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.contractorId}
                onChange={e => setField('contractorId', e.target.value)}
              >
                <option value="">Unassigned</option>
                {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Service</label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.serviceId}
                onChange={e => setField('serviceId', e.target.value)}
              >
                <option value="">All Services</option>
                {(services ?? []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Area</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.mapCode}
                  onChange={e => setField('mapCode', e.target.value)}
                >
                  <option value="">All Areas</option>
                  {mapCodes.map(code => <option key={code} value={code}>{code}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">City</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.city}
                  onChange={e => setField('city', e.target.value)}
                >
                  <option value="">All Cities</option>
                  {cities.map(city => <option key={city} value={city}>{city}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div>
            <div className="text-sm font-medium">Fill the day until</div>
            <p className="text-muted-foreground text-xs mt-1">
              Leave a box empty to ignore that limit. The route stops at whichever limit is reached first.
            </p>
            <div className="grid grid-cols-3 gap-4 mt-2">
              <div>
                <label className="text-xs text-muted-foreground">Max stops</label>
                <Input type="number" min="1" placeholder="e.g. 40" value={form.maxStops} onChange={e => setField('maxStops', e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Max dollars</label>
                <Input type="number" min="0" step="1" placeholder="e.g. 2500" value={form.maxDollars} onChange={e => setField('maxDollars', e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Max hours</label>
                <Input type="number" min="0" step="0.5" placeholder="e.g. 8" value={form.maxHours} onChange={e => setField('maxHours', e.target.value)} />
              </div>
            </div>
          </div>

          {buildRoute.isError && (
            <p className="text-sm text-destructive">Could not build the route. Check the date and the limits, then try again.</p>
          )}

          {preview && (
            <div className="space-y-3 border-t pt-4">
              <div className="grid grid-cols-4 gap-3">
                <Stat label="Stops" value={String(preview.selected.length)} />
                <Stat label="Total" value={`$${preview.totalAmount.toFixed(2)}`} />
                <Stat label="Hours" value={preview.totalHours.toFixed(1)} />
                <Stat label="Left waiting" value={String(preview.skipped)} />
              </div>

              <p className="text-sm text-muted-foreground">
                {preview.limitedBy
                  ? `Stopped at ${CAP_REASON[preview.limitedBy] ?? preview.limitedBy}. `
                  : 'Everything matching fitted. '}
                {preview.skipped > 0
                  ? `${preview.skipped} matching job${preview.skipped === 1 ? '' : 's'} stay on the waiting list, untouched.`
                  : 'Nothing was left behind.'}
              </p>

              {preview.selected.length === 0 ? (
                <p className="text-sm">No jobs matched those filters and limits, so there is nothing to schedule.</p>
              ) : (
                <div className="border rounded-lg max-h-72 overflow-auto">
                  <Table>
                    <TableHeader className="bg-muted/50 sticky top-0">
                      <TableRow>
                        <TableHead className="w-12">#</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>Address</TableHead>
                        <TableHead>Area</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Running</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stops.map(s => (
                        <TableRow key={s.jobId}>
                          <TableCell className="text-muted-foreground">{s.routeOrder}</TableCell>
                          <TableCell className="font-semibold">{s.clientName}</TableCell>
                          <TableCell className="text-muted-foreground">{s.address || '-'}</TableCell>
                          <TableCell>{s.mapCode || '-'}</TableCell>
                          <TableCell className="text-right">${s.amount.toFixed(2)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">${s.runningTotal.toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="outline" onClick={() => submit(false)} disabled={buildRoute.isPending}>
            {preview ? 'Refresh Preview' : 'Preview Route'}
          </Button>
          <Button onClick={() => submit(true)} disabled={buildRoute.isPending || !preview || preview.selected.length === 0}>
            Schedule {preview ? `${preview.selected.length} Stops` : 'Route'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string, value: string }) {
  return (
    <div className="bg-muted/50 border rounded-lg px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
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
