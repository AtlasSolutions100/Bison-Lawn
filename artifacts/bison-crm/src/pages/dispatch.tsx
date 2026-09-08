import { useMemo, useState } from 'react';
import { DispatchMap } from '@/components/dispatch-map';
import { 
  useListJobs, useUpdateJob, useCompleteJob, useDeleteJob, useCreateJob, useGetJob,
  useListUsers, useAddJobProduct, useDeleteJobProduct, Job,
  useListClients, useListServices, useBulkAssignJobs
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { AlertTriangle, CheckCircle2, Columns3, FileText, MapPin, MoreVertical, Plus, Trash2, PackageOpen } from 'lucide-react';

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
  const queryClientForBoard = useQueryClient();
  
  const contractors = users?.filter(u => u.role === 'contractor') || [];

  // Hidden by default. He asked for the map, but the table is still how most of
  // a day gets worked, and 400 pins on load is not what someone checking one
  // job's status came for.
  const [showMap, setShowMap] = useState(false);
  const { visible, toggle } = useDispatchColumns();
  const bulkAssign = useBulkAssignJobs();
  const applyToSelection = (input: Parameters<typeof bulkAssign.mutate>[0]['data']) => {
    bulkAssign.mutate({ data: input }, {
      onSuccess: () => queryClientForBoard.invalidateQueries({ queryKey: ['/api/jobs'] }),
    });
  };

  // Satisfy useGetJob hook requirement
  const _ = useGetJob(1, { query: { enabled: false, queryKey: ['/api/jobs', 1] } });

  return (
    <div className="p-8 mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)] min-w-0">
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
              <option value="skipped">Skipped</option>
            </select>

            <Input type="text" placeholder="Filter city..." value={city} onChange={e => setCity(e.target.value)} className="w-40" />
          </div>
          
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" data-testid="columns-picker">
                <Columns3 className="mr-1 h-4 w-4" /> Columns
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-2">
              <p className="px-2 pb-1 text-xs text-muted-foreground">
                Client and the row buttons always show.
              </p>
              {DISPATCH_COLUMNS.map(col => (
                <label key={col.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={visible.includes(col.key)}
                    onChange={() => toggle(col.key)}
                    data-testid={`column-${col.key}`}
                  />
                  {col.label}
                </label>
              ))}
            </PopoverContent>
          </Popover>
          <Button variant={showMap ? 'default' : 'outline'} onClick={() => setShowMap(v => !v)}>
            <MapPin className="mr-1 h-4 w-4" /> {showMap ? 'Hide Map' : 'Show Map'}
          </Button>
          <NewJobDialog date={date} contractors={contractors} />
        </div>
      </div>

      {showMap && (
        <DispatchMap
          jobs={jobs ?? []}
          contractors={contractors}
          onCommit={applyToSelection}
          busy={bulkAssign.isPending}
        />
      )}

      <SubLoadSummary
        date={date}
        status={status}
        city={city}
        contractors={contractors}
        activeContractorId={contractorId}
        onPick={setContractorId}
      />

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-hidden flex flex-col">
        <div className="overflow-auto flex-1">
          {/*
            Narrower by the width of the column that merging the money figures
            removed. This does not yet stop the sideways scrolling he asked
            about separately — choosing which columns to show is its own item —
            but keeping 2000px here would have thrown the gain away.
          */}
          <Table className="min-w-full">
            <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-sm">
              <TableRow>
                <TableHead className="sticky left-0 z-20 w-64 min-w-64 bg-muted">Client</TableHead>
                <TableHead hidden={!visible.includes('order')} className="w-16 text-center">Order</TableHead>
                <TableHead hidden={!visible.includes('status')} className="w-36">Status</TableHead>
                <TableHead hidden={!visible.includes('date')} className="w-28">Date</TableHead>
                <TableHead hidden={!visible.includes('map')} className="w-36">Map</TableHead>
                <TableHead hidden={!visible.includes('city')} className="w-32">City</TableHead>
                <TableHead hidden={!visible.includes('lastService')} className="w-32">Last Service</TableHead>
                <TableHead hidden={!visible.includes('budgetedHours')} className="w-32">Budgeted Hours</TableHead>
                <TableHead hidden={!visible.includes('notes')} className="w-44">Notes</TableHead>
                <TableHead hidden={!visible.includes('service')}>Service</TableHead>
                <TableHead hidden={!visible.includes('assigned')} className="w-40">Assigned</TableHead>
                <TableHead hidden={!visible.includes('money')} className="text-right w-32">Money</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={14} className="text-center py-10 animate-pulse">Loading board...</TableCell></TableRow>
              ) : !jobs?.length ? (
                <TableRow><TableCell colSpan={14} className="text-center py-10">No jobs match the current filters.</TableCell></TableRow>
              ) : (
                jobs.map(job => <DispatchRow key={job.id} job={job} contractors={contractors} visible={visible} />)
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

/*
  Which columns the board shows.

  "instead of sliding the bar to the left or right to view the other options can
  I customize that of the options I need so I can see it all on one page" — and
  separately, the money figures he asked to see were already there but sat off
  the right-hand edge, which is the same complaint wearing a different hat.

  Client and the row actions are not listed: one is what you are looking at and
  the other is how you act on it, so neither is ever worth hiding. The default
  set is what fits a laptop without scrolling; everything else is one click away
  and the choice is remembered per browser.
*/
export const DISPATCH_COLUMNS: { key: string; label: string }[] = [
  { key: 'order', label: 'Order' },
  { key: 'status', label: 'Status' },
  { key: 'date', label: 'Date' },
  { key: 'map', label: 'Map' },
  { key: 'city', label: 'City' },
  { key: 'lastService', label: 'Last Service' },
  { key: 'budgetedHours', label: 'Budgeted Hours' },
  { key: 'notes', label: 'Notes' },
  { key: 'service', label: 'Service' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'money', label: 'Money' },
];

const DEFAULT_DISPATCH_COLUMNS = ['order', 'status', 'map', 'notes', 'service', 'assigned', 'money'];
const DISPATCH_COLUMNS_KEY = 'bison.dispatch.columns';

function useDispatchColumns() {
  const [visible, setVisible] = useState<string[]>(() => {
    // Reading localStorage can throw outright in a locked-down browser, and a
    // board that will not render because of a column preference is a worse
    // failure than a board with the default columns.
    try {
      const raw = localStorage.getItem(DISPATCH_COLUMNS_KEY);
      if (!raw) return DEFAULT_DISPATCH_COLUMNS;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : DEFAULT_DISPATCH_COLUMNS;
    } catch {
      return DEFAULT_DISPATCH_COLUMNS;
    }
  });

  const toggle = (key: string) => {
    setVisible((current) => {
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      try {
        localStorage.setItem(DISPATCH_COLUMNS_KEY, JSON.stringify(next));
      } catch {
        /* preference is not worth failing the interaction over */
      }
      return next;
    });
  };

  return { visible, toggle };
}

/** Google's directions URL takes a destination plus up to 9 waypoints. */
const MAX_MAP_STOPS = 10;

/**
 * Open a sub's whole day in Google Maps as one multi-stop route.
 *
 * Asked for as "in the dispatch board making it to link to map to manually
 * route". Each row already links to its own address, which answers "where is
 * this one" but not "what order should I drive these in" — the question the
 * board is actually for.
 *
 * This is the *driving* link, not the planning map — the two answer different
 * questions and both earn their place. Show Map above is where the office
 * decides who takes which stops and in what order; this hands the finished day
 * to a driver in the app that has live traffic and turn-by-turn.
 *
 * Stops in routeOrder, falling back to the order the board shows. Jobs without
 * an address are skipped: Maps would silently resolve a blank waypoint to
 * somewhere plausible and quietly send a crew to the wrong street.
 */
function googleMapsRouteUrl(jobs: Job[]): { url: string | null; used: number; dropped: number } {
  const addressable = [...jobs]
    .sort((a, b) => (a.routeOrder ?? Number.MAX_SAFE_INTEGER) - (b.routeOrder ?? Number.MAX_SAFE_INTEGER))
    .map(job => ({
      job,
      query: job.clientLat != null && job.clientLng != null
        ? `${job.clientLat},${job.clientLng}`
        : (job.clientAddress ?? '').trim(),
    }))
    .filter(stop => stop.query.length > 0);

  if (addressable.length === 0) return { url: null, used: 0, dropped: jobs.length };

  const used = addressable.slice(0, MAX_MAP_STOPS);
  const dropped = jobs.length - used.length;
  const params = new URLSearchParams({ api: '1', travelmode: 'driving' });

  // No origin on purpose: Google Maps then starts from wherever the driver
  // actually is. Naming the first stop as the origin routes *from* the first
  // customer, which skips the leg to it — and on a one-stop day produced a
  // route from an address to itself, which navigates nowhere.
  params.set('destination', used[used.length - 1].query);
  if (used.length > 1) {
    params.set('waypoints', used.slice(0, -1).map(stop => stop.query).join('|'));
  }
  return { url: `https://www.google.com/maps/dir/?${params.toString()}`, used: used.length, dropped };
}

const money = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Per-sub load for the selected day: stops, dollars and budgeted hours.
 *
 * Asked for directly — "see the route order and the dollar total for each sub
 * right on this screen, so I can tell at a glance whether someone is loaded too
 * heavy". The board already shows a route Order per row, but the row view can
 * never answer "too heavy compared to whom", because that is a question about
 * the subs side by side.
 */
function SubLoadSummary({
  date,
  status,
  city,
  contractors,
  activeContractorId,
  onPick,
}: {
  date: string;
  status: string;
  city: string;
  contractors: any[];
  activeContractorId: string;
  onPick: (id: string) => void;
}) {
  // Deliberately ignores the contractor filter. Filtering to one sub and then
  // reading their total tells you nothing about whether it is heavy — the
  // comparison is the whole point, so this always loads the full day.
  const { data: jobs } = useListJobs({
    date,
    ...(status && { status: status as any }),
    ...(city && { city }),
  });

  const buckets = useMemo(() => {
    if (!jobs?.length) return [];
    const byId = new Map<number | null, {
      id: number | null;
      name: string;
      stops: number;
      amount: number;
      hours: number;
      skipped: number;
      jobs: Job[];
    }>();

    for (const job of jobs) {
      const id = job.assignedToId ?? null;
      let bucket = byId.get(id);
      if (!bucket) {
        bucket = {
          id,
          name: id == null
            ? 'Unassigned'
            : job.assignedToName
              ?? contractors.find(c => c.id === id)?.name
              ?? `User #${id}`,
          stops: 0,
          amount: 0,
          hours: 0,
          skipped: 0,
          jobs: [],
        };
        byId.set(id, bucket);
      }
      bucket.stops += 1;
      bucket.jobs.push(job);
      bucket.amount += job.amount ?? 0;
      bucket.hours += job.budgetedHours ?? 0;
      if (job.status === 'skipped') bucket.skipped += 1;
    }

    // Heaviest first: the one at risk of being overloaded is the one worth
    // seeing without scanning. Unassigned is pinned last — it is a to-do, not a
    // workload, and it would otherwise sit in the middle of the comparison.
    return [...byId.values()].sort((a, b) => {
      if (a.id == null) return 1;
      if (b.id == null) return -1;
      return b.amount - a.amount;
    });
  }, [jobs, contractors]);

  if (!buckets.length) return null;

  const heaviest = Math.max(...buckets.filter(b => b.id != null).map(b => b.amount), 0);

  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {buckets.map(bucket => {
        const key = bucket.id == null ? 'unassigned' : String(bucket.id);
        const active = activeContractorId === key;
        // Share of the heaviest sub's dollars. Not a share of the day's total:
        // "half of what the busiest guy has" is the comparison being made.
        const share = heaviest > 0 && bucket.id != null ? bucket.amount / heaviest : 0;
        return (
          <div key={key} className="flex min-w-44 shrink-0 flex-col">
          <button
            type="button"
            // Unassigned has no contractor id to filter by, so it stays a
            // read-only tile rather than a button that looks live and does
            // nothing.
            onClick={() => bucket.id != null && onPick(active ? '' : key)}
            disabled={bucket.id == null}
            title={bucket.id == null
              ? 'Jobs with nobody assigned yet'
              : active
                ? 'Show all contractors'
                : `Show only ${bucket.name}`}
            className={`w-full rounded-lg border bg-card p-3 text-left shadow-sm transition ${
              bucket.id == null
                ? 'border-dashed opacity-90'
                : active
                  ? 'border-primary ring-2 ring-primary/30'
                  : 'hover:border-primary/50 hover:shadow'
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold">{bucket.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {bucket.stops} {bucket.stops === 1 ? 'stop' : 'stops'}
              </span>
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums">{money(bucket.amount)}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {bucket.hours > 0 ? `${bucket.hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} hrs budgeted` : 'No hours budgeted'}
              {bucket.skipped > 0 && (
                <span className="ml-1 font-medium text-orange-700">· {bucket.skipped} skipped</span>
              )}
            </div>
            {bucket.id != null && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${share >= 0.999 ? 'bg-primary' : 'bg-primary/50'}`}
                  style={{ width: `${Math.max(share * 100, 2)}%` }}
                />
              </div>
            )}
            </button>
            <RouteInMapsLink jobs={bucket.jobs} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Nested outside the tile button on purpose: a link inside a button is invalid
 * markup, and the two do different things — one filters the board, one leaves
 * the app.
 */
function RouteInMapsLink({ jobs }: { jobs: Job[] }) {
  const { url, used, dropped } = googleMapsRouteUrl(jobs);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-flex items-center gap-1 px-1 text-[11px] font-medium text-muted-foreground hover:text-primary hover:underline"
      title={dropped > 0
        ? `Google Maps takes ${MAX_MAP_STOPS} stops in one link. Opening the first ${used}; ${dropped} not included.`
        : `Open all ${used} stops in Google Maps, in route order`}
    >
      <MapPin className="h-3 w-3" />
      Route in Maps{dropped > 0 ? ` (first ${used})` : ''}
    </a>
  );
}

function DispatchRow({ job, contractors, visible }: { job: Job, contractors: any[], visible: string[] }) {
  const show = (key: string) => visible.includes(key);
  const updateJob = useUpdateJob();
  const completeJob = useCompleteJob();
  const deleteJob = useDeleteJob();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleUpdate = (data: any) => {
    updateJob.mutate({ id: job.id, data }, {
      onSuccess: (result: any) => {
        queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
        // Only the skip path returns a notice, so this stays quiet for every
        // other status change.
        if (result?.skipNotice) {
          toast({
            title: result.skipBillable ? 'Skip recorded — chargeable' : 'Skip recorded — free',
            description: result.skipNotice,
          });
        }
      },
    });
  };

  const statusColors = {
    scheduled: "bg-muted text-muted-foreground",
    on_the_way: "bg-accent/20 text-accent-foreground border-accent",
    in_progress: "bg-blue-100 text-blue-700 border-blue-200",
    completed: "bg-primary/20 text-primary border-primary",
    // Deliberately not the "completed" color: a skip is a miss, not a success.
    skipped: "bg-orange-100 text-orange-700 border-orange-200",
  };

  const hasCoordinates = job.clientLat != null && job.clientLng != null;
  const hasLocation = hasCoordinates || !!job.clientAddress;
  const mapUrl = hasCoordinates
    ? `https://www.google.com/maps/search/?api=1&query=${job.clientLat},${job.clientLng}`
    : job.clientAddress
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.clientAddress)}`
      : '';

  return (
    <TableRow className={`group hover:bg-muted/30 ${
      job.status === 'completed' ? 'opacity-60 bg-muted/10' :
      job.status === 'skipped' ? 'bg-orange-50/50' : ''
    }`}>
      <TableCell className="sticky left-0 z-[5] w-64 min-w-64 bg-card p-2 group-hover:bg-muted">
        <div className="font-semibold text-foreground">{job.clientName}</div>
        <div className="text-xs text-muted-foreground truncate max-w-[240px]" title={job.clientAddress ?? undefined}>
          {job.clientAddress || 'No address'}
        </div>
      </TableCell>
      <TableCell hidden={!show('order')} className="p-1 text-center">
        <Input 
          type="number" 
          defaultValue={job.routeOrder || ''} 
          onBlur={e => handleUpdate({ routeOrder: parseInt(e.target.value) || null })}
          className="w-14 h-8 mx-auto text-center p-1"
        />
      </TableCell>
      <TableCell hidden={!show('status')} className="p-2">
        <select 
          className={`w-full h-8 text-xs font-bold px-2 rounded-md outline-none cursor-pointer border ${statusColors[job.status as keyof typeof statusColors]}`}
          value={job.status}
          onChange={e => handleUpdate({ status: e.target.value as any })}
          disabled={job.status === 'completed'}
        >
          <option value="scheduled">SCHEDULED</option>
          <option value="on_the_way">ON THE WAY</option>
          <option value="in_progress">IN PROGRESS</option>
          <option value="skipped">SKIPPED</option>
          {job.status === 'completed' && <option value="completed">COMPLETED</option>}
        </select>
        {job.status === 'skipped' && job.skipReason && (
          <div className="mt-1 max-w-32 truncate text-[10px] font-medium text-orange-700" title={job.skipReason}>
            {job.skipReason}
          </div>
        )}
        {/* The toast is gone by the time the office bills. This is the durable
            record that the customer's free skip was already spent. */}
        {job.status === 'skipped' && job.skipBillable && (
          <div className="mt-1 text-[10px] font-bold uppercase tracking-wide text-destructive">
            Chargeable
          </div>
        )}
      </TableCell>
      <TableCell hidden={!show('date')} className="p-2 whitespace-nowrap text-sm">
        {job.scheduledDate
          ? formatDispatchDate(job.scheduledDate)
          : <span className="text-muted-foreground">Not scheduled</span>}
      </TableCell>
      <TableCell hidden={!show('map')} className="p-2">
        {hasLocation ? (
          <Button variant="outline" size="sm" className="h-8 px-2" asChild>
            <a href={mapUrl} target="_blank" rel="noreferrer" title={hasCoordinates ? 'Open coordinates in Google Maps' : 'Open address in Google Maps'}>
              <MapPin className="w-3.5 h-3.5 mr-1" /> Map
            </a>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="h-8 px-2" disabled title="This stop has no coordinates or address">
            <MapPin className="w-3.5 h-3.5 mr-1" /> No location
          </Button>
        )}
        {job.mapNote && (
          <div className="mt-1 max-w-32 truncate text-[10px] font-medium text-muted-foreground" title={job.mapNote}>
            {job.mapNote}
          </div>
        )}
      </TableCell>
      <TableCell hidden={!show('city')} className="p-2 text-sm">
        {job.city || <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell hidden={!show('lastService')} className="p-2 whitespace-nowrap text-sm">
        {job.lastServiceDate
          ? formatDispatchDate(job.lastServiceDate)
          : <span className="text-muted-foreground">Never serviced</span>}
      </TableCell>
      <TableCell hidden={!show('budgetedHours')} className="p-2 whitespace-nowrap text-sm">
        {job.budgetedHours != null
          ? `${job.budgetedHours} ${job.budgetedHours === 1 ? 'hour' : 'hours'}`
          : <span className="text-muted-foreground">Not set</span>}
      </TableCell>
      <TableCell hidden={!show('notes')} className="p-2">
        <JobNotes job={job} />
      </TableCell>
      <TableCell hidden={!show('service')} className="p-2 text-sm font-medium">
        {job.serviceName}
      </TableCell>
      <TableCell hidden={!show('assigned')} className="p-2">
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
      {/*
        All three money figures in one cell rather than three columns.

        Asked for: "on the dispatch board, seeing prices of job, and outstanding
        balance and last invoice balance". Two of the three were already here as
        separate columns — but at the far right of a board he has to scroll
        sideways to reach, which is why he could not see them and why he also
        asked to stop scrolling sideways. Adding a third column would have made
        that worse, so the three sit together and the board is one column
        narrower than before.
      */}
      <TableCell hidden={!show('money')} className="p-2 text-right text-sm whitespace-nowrap">
        <div className="font-bold text-foreground">
          ${job.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </div>
        <div className={job.clientBalance && job.clientBalance > 0 ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
          Owes ${(job.clientBalance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </div>
        {job.lastInvoiceBalance != null && (
          <div className="text-muted-foreground text-xs">
            #{job.lastInvoiceNumber}: ${job.lastInvoiceBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </div>
        )}
      </TableCell>
      <TableCell className="p-2 text-right space-x-1 whitespace-nowrap">
        <ProductsPopover job={job} />
        
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8"><MoreVertical className="w-4 h-4" /></Button>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" align="end">
            {job.status !== 'completed' && job.status !== 'skipped' && (
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

function formatDispatchDate(value: string) {
  const date = new Date(value.includes('T') ? value : `${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : format(date, 'MMM d, yyyy');
}

function JobNotes({ job }: { job: Job }) {
  if (!job.notes) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`h-8 max-w-40 justify-start px-2 ${job.notesImportant ? 'bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive' : ''}`}
          title={job.notes}
        >
          {job.notesImportant
            ? <AlertTriangle className="w-3.5 h-3.5 mr-1.5 shrink-0" />
            : <FileText className="w-3.5 h-3.5 mr-1.5 shrink-0" />}
          <span className="truncate">{job.notes}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm whitespace-pre-wrap" align="start">
        {job.notesImportant && (
          <div className="mb-2 flex items-center gap-1.5 font-semibold text-destructive">
            <AlertTriangle className="w-4 h-4" /> Important note
          </div>
        )}
        {job.notes}
      </PopoverContent>
    </Popover>
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
