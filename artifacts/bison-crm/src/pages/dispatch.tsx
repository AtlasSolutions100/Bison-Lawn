import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type L from 'leaflet';
import { DispatchMap } from '@/components/dispatch-map';
import { BulkActionsBar } from '@/components/dispatch/bulk-actions-bar';
import {
  JobFiltersPopover, EMPTY_JOB_FILTERS, jobFilterParams, countActiveFilters, selectClass, type JobFilters,
} from '@/components/dispatch/job-filters';
import { useContractors, type ContractorOption } from '@/components/dispatch/contractors';
import { EmailDocumentDialog } from '@/components/dispatch/email-document-dialog';
import { CrewLocationsLayer, CrewStrip } from '@/components/crew-locations';
import { MapCodeBadge } from '@/components/map-code';
import { contractorColor } from '@/lib/contractor-color';
import {
  useListJobs, useUpdateJob, useCompleteJob, useDeleteJob, useCreateJob,
  useAddJobProduct, useDeleteJobProduct, useBulkJobAction, Job,
  useListClients, useListServices, useBulkAssignJobs, useListTickets,
  useUncompleteJob, useListProductPresets,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import {
  AlertTriangle, CalendarCheck, CalendarX, CheckCircle2, Columns3, FileText, ListOrdered, MailX, MapPin,
  MoreVertical, Plus, RotateCcw, SkipForward, Trash2, PackageOpen, XCircle,
} from 'lucide-react';

const today = () => format(new Date(), 'yyyy-MM-dd');

/** First and last day of the month a `<input type="month">` gives (yyyy-mm). */
function monthRange(ym: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(y, mo, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

/**
 * "Set route order" on the board: click the stops in driving order, then save.
 * `scope` is the jobs being renumbered (one sub's day, or whatever was ticked);
 * `order` is the click order so far. Nothing is written until Save, so the
 * numbers he already has survive a mistaken press.
 */
export type RenumberState = { scope: number[]; order: number[] };

export default function Dispatch() {
  // A span of days, not one day: "pick a month or a span of time". Both ends
  // default to today so the board opens the way it always has.
  const [range, setRange] = useState({ from: today(), to: today() });
  const [filters, setFilters] = useState<JobFilters>(EMPTY_JOB_FILTERS);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [renumber, setRenumber] = useState<RenumberState | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [leafletMap, setLeafletMap] = useState<L.Map | null>(null);

  const from = range.from <= range.to ? range.from : range.to;
  const to = range.from <= range.to ? range.to : range.from;
  const spansDays = from !== to;

  const queryParams = { from, to, ...jobFilterParams(filters) };
  const { data: jobs, isLoading } = useListJobs(queryParams);
  const contractors = useContractors();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Hidden by default. He asked for the map, but the table is still how most of
  // a day gets worked, and 400 pins on load is not what someone checking one
  // job's status came for.
  const [showMap, setShowMap] = useState(false);
  const { visible, toggle } = useDispatchColumns();
  // The date on every row once the board shows more than one day, whatever
  // the column picker says: a range without dates is a list of guesses.
  const visibleEffective = useMemo(
    () => (spansDays && !visible.includes('date') ? [...visible, 'date'] : visible),
    [visible, spansDays],
  );
  const hasFilters = countActiveFilters(filters) > 0;
  const bulkAssign = useBulkAssignJobs();

  // A selection only means the rows on screen. When the day or a filter
  // changes, anything no longer listed drops out rather than being acted on
  // unseen.
  useEffect(() => {
    if (!jobs) return;
    const present = new Set(jobs.map((j) => j.id));
    setSelectedIds((cur) => (cur.every((id) => present.has(id)) ? cur : cur.filter((id) => present.has(id))));
  }, [jobs]);

  const allSelected = !!jobs?.length && jobs.every((j) => selectedIds.includes(j.id));
  const toggleAll = () => setSelectedIds(allSelected ? [] : (jobs ?? []).map((j) => j.id));
  const toggleOne = (id: number) =>
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // --- set route order -----------------------------------------------------------
  const startRenumber = (scope: number[]) => {
    if (scope.length === 0) return;
    // Nothing is written until Save. His current CRM clears the numbers the
    // moment the button is pressed — "if I push this set route order, it will
    // reset all of them and then I have to go back in and click on them and
    // number them again" — so pressing it by mistake costs him the route he
    // already built. Here the old numbers stay on screen while he picks, and
    // Cancel leaves the day exactly as it was.
    setRenumber({ scope, order: [] });
    setSelectedIds([]);
  };
  const pickForRenumber = (id: number) =>
    setRenumber((cur) => {
      if (!cur || !cur.scope.includes(id)) return cur;
      return { ...cur, order: cur.order.includes(id) ? cur.order.filter((x) => x !== id) : [...cur.order, id] };
    });
  const saveRenumber = () => {
    if (!renumber || renumber.order.length === 0) return;
    const picked = renumber.order;
    const skipped = renumber.scope.filter((id) => !picked.includes(id));
    const fail = (error: unknown) =>
      toast({ title: 'Could not save the order', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    const numberThePicked = () =>
      bulkAssign.mutate(
        { data: { jobIds: picked, routeOrderFrom: 1 } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
            toast({ title: `Route order set for ${picked.length} stop${picked.length === 1 ? '' : 's'}` });
            setRenumber(null);
          },
          onError: fail,
        },
      );
    // A stop he left out of the run loses its old number, or the board would
    // show yesterday's 4 sitting between today's 3 and 5. Cleared first so no
    // two stops ever read the same number, even for the moment in between.
    if (skipped.length === 0) return numberThePicked();
    bulkAssign.mutate(
      { data: { jobIds: skipped, clearRouteOrder: true } },
      { onSuccess: numberThePicked, onError: fail },
    );
  };

  const selectedJobs = useMemo(() => (jobs ?? []).filter((j) => selectedIds.includes(j.id)), [jobs, selectedIds]);
  // Same object between renders, or the map redraws every pin on every render
  // while the order is being clicked out.
  const mapRenumber = useMemo(() => (renumber ? { ...renumber, onPick: pickForRenumber } : null), [renumber]);

  return (
    <div className="p-8 mx-auto space-y-4 flex flex-col h-[calc(100vh-2rem)] min-w-0">
      <div className="flex flex-wrap justify-between items-end gap-3">
        <div>
          {/* Compact on purpose. He measured the cost of this header himself:
              "be able to see the whole list of jobs on the dispatch board
              without scrolling. Right now I can only see two at a time." */}
          <h1 className="text-2xl font-bold tracking-tight">Dispatch Board</h1>
          <p className="text-sm text-muted-foreground">
            {spansDays ? `${formatDispatchDate(from)} to ${formatDispatchDate(to)}` : formatDispatchDate(from)} · routes, status and who has what.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-card p-1.5 shadow-sm">
            <Input type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value || r.from }))} className="h-8 w-[8.5rem]" data-testid="board-from" title="From" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value || r.to }))} className="h-8 w-[8.5rem]" data-testid="board-to" title="To" />
            <Button variant="ghost" size="sm" onClick={() => setRange({ from: today(), to: today() })} data-testid="board-today">Today</Button>
            <input
              type="month"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={spansDays && monthRange(from.slice(0, 7))?.from === from && monthRange(from.slice(0, 7))?.to === to ? from.slice(0, 7) : ''}
              onChange={e => { const r = monthRange(e.target.value); if (r) setRange(r); }}
              title="Show a whole month"
              data-testid="board-month"
            />

            <select className={`${selectClass} !h-8 !w-36`} value={filters.contractorId} onChange={e => setFilters(f => ({ ...f, contractorId: e.target.value }))} data-testid="board-contractor">
              <option value="">All contractors</option>
              {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <JobFiltersPopover value={filters} onChange={setFilters} contractors={contractors} />
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" data-testid="columns-picker">
                <Columns3 className="mr-1 h-4 w-4" /> Columns
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-2">
              <p className="px-2 pb-1 text-xs text-muted-foreground">
                Client and the row buttons always show.{spansDays ? ' Date always shows for a span of days.' : ''}
              </p>
              {DISPATCH_COLUMNS.map(col => (
                <label key={col.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={visibleEffective.includes(col.key)}
                    disabled={col.key === 'date' && spansDays}
                    onChange={() => toggle(col.key)}
                    data-testid={`column-${col.key}`}
                  />
                  {col.label}
                </label>
              ))}
            </PopoverContent>
          </Popover>
          <Button variant={showMap ? 'default' : 'outline'} onClick={() => setShowMap(v => !v)} data-testid="toggle-map">
            <MapPin className="mr-1 h-4 w-4" /> {showMap ? 'Hide Map' : 'Show Map'}
          </Button>
          <NewJobDialog date={from} contractors={contractors} />
        </div>
      </div>

      {showMap && (
        <>
          <DispatchMap
            jobs={jobs ?? []}
            contractors={contractors}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            variant="board"
            renumber={mapRenumber}
            onMapReady={setLeafletMap}
          />
          <CrewLocationsLayer map={leafletMap} date={from} />
        </>
      )}
      <CrewStrip date={from} />

      <TicketStrip date={from} spansDays={spansDays} />

      <SubLoadSummary
        from={from}
        to={to}
        filters={filters}
        contractors={contractors}
        activeContractorId={filters.contractorId}
        onPick={(id) => setFilters(f => ({ ...f, contractorId: id }))}
        onSetRouteOrder={startRenumber}
        busy={bulkAssign.isPending || renumber != null}
      />

      {renumber ? (
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm shadow-sm" data-testid="renumber-bar">
          <ListOrdered className="h-4 w-4 text-amber-700" />
          <span>
            <strong>Setting route order.</strong> Click the rows or the pins in driving order — {renumber.order.length} of {renumber.scope.length} picked. Nothing changes until you save.
          </span>
          <Button size="sm" onClick={saveRenumber} disabled={renumber.order.length === 0 || bulkAssign.isPending} data-testid="renumber-save">
            Save order
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRenumber(null)} data-testid="renumber-cancel">
            Cancel
          </Button>
        </div>
      ) : (
        <BulkActionsBar
          selectedIds={selectedIds}
          jobs={jobs ?? []}
          contractors={contractors}
          context="board"
          defaultDate={from}
          onClear={() => setSelectedIds([])}
          onEmail={() => setEmailOpen(true)}
          onRenumber={() => startRenumber(selectedIds)}
        />
      )}

      <EmailDocumentDialog open={emailOpen} onOpenChange={setEmailOpen} jobs={selectedJobs} source="dispatch" />

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-hidden flex flex-col">
        <div className="overflow-auto flex-1">
          <Table className="min-w-full">
            <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-sm">
              <TableRow>
                <TableHead className="sticky left-0 z-20 w-72 min-w-72 bg-muted">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                      disabled={!jobs?.length || renumber != null}
                      aria-label="Select all"
                      data-testid="select-all"
                    />
                    Client
                  </div>
                </TableHead>
                <TableHead hidden={!visibleEffective.includes('order')} className="w-16 text-center">Order</TableHead>
                <TableHead hidden={!visibleEffective.includes('status')} className="w-36">Status</TableHead>
                <TableHead hidden={!visibleEffective.includes('date')} className="w-40">Date</TableHead>
                <TableHead hidden={!visibleEffective.includes('map')} className="w-36">Map</TableHead>
                <TableHead hidden={!visibleEffective.includes('city')} className="w-32">City</TableHead>
                <TableHead hidden={!visibleEffective.includes('lastService')} className="w-32">Last Service</TableHead>
                <TableHead hidden={!visibleEffective.includes('budgetedHours')} className="w-32">Budgeted Hours</TableHead>
                <TableHead hidden={!visibleEffective.includes('notes')} className="w-44">Notes</TableHead>
                <TableHead hidden={!visibleEffective.includes('service')}>Service</TableHead>
                <TableHead hidden={!visibleEffective.includes('assigned')} className="w-44">Assigned</TableHead>
                <TableHead hidden={!visibleEffective.includes('money')} className="text-right w-32">Money</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={14} className="text-center py-10 animate-pulse">Loading board...</TableCell></TableRow>
              ) : !jobs?.length ? (
                <TableRow>
                  <TableCell colSpan={14} className="py-12">
                    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
                      <p className="font-medium text-foreground">
                        {hasFilters
                          ? 'No jobs match these filters'
                          : spansDays
                            ? `Nothing scheduled from ${formatDispatchDate(from)} to ${formatDispatchDate(to)}`
                            : `Nothing scheduled for ${formatDispatchDate(from)}`}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {hasFilters
                          ? 'Try clearing a filter.'
                          : 'Pick other dates, add a job, or dispatch some from the waiting list.'}
                      </p>
                      {hasFilters && (
                        <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_JOB_FILTERS)} data-testid="clear-dispatch-filters">
                          Clear filters
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map(job => (
                  <DispatchRow
                    key={job.id}
                    job={job}
                    contractors={contractors}
                    visible={visibleEffective}
                    selected={selectedIds.includes(job.id)}
                    onToggle={() => toggleOne(job.id)}
                    renumber={renumber}
                    onRenumberPick={() => pickForRenumber(job.id)}
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

// Date is in the default set now: he asked for it on each row once the board
// could show more than one day.
const DEFAULT_DISPATCH_COLUMNS = ['order', 'status', 'date', 'map', 'notes', 'service', 'assigned', 'money'];
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
 * Tickets due on the day being worked, and only ones somebody owns.
 *
 * Two requests that only make sense together: "tickets: put on dispatch board
 * only if assigned to someone" and "tickets to show on dispatch board for the
 * date(s) specified on ticket creation". An unowned ticket, or one not due
 * today, is noise on a board that is about today's route — so both filters are
 * applied on the server rather than fetching everything and hiding most of it.
 *
 * A strip rather than table rows: a ticket is not a job. It has no route order,
 * no price and no crew to assign, and forcing one into the jobs table would
 * have meant a row of empty cells pretending otherwise.
 */
function TicketStrip({ date, spansDays }: { date: string; spansDays: boolean }) {
  const { data: tickets } = useListTickets({ dueDate: date, assigned: 'true', status: 'open' });
  if (!tickets?.length) return null;

  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm" data-testid="dispatch-tickets">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <FileText className="h-4 w-4 text-muted-foreground" />
        {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'} due {spansDays ? formatDispatchDate(date) : 'today'}
      </div>
      <div className="flex flex-wrap gap-2">
        {tickets.map(t => (
          <div key={t.id} className="rounded-md border bg-background px-2.5 py-1.5 text-xs">
            <div className="font-medium text-foreground">{t.title}</div>
            <div className="text-muted-foreground">
              {t.assignedToName ?? 'Unassigned'}
              {t.clientName ? ` · ${t.clientName}` : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Per-sub load for the selected days: stops, dollars and budgeted hours.
 *
 * Asked for directly — "see the route order and the dollar total for each sub
 * right on this screen, so I can tell at a glance whether someone is loaded too
 * heavy". The board already shows a route Order per row, but the row view can
 * never answer "too heavy compared to whom", because that is a question about
 * the subs side by side.
 */
function SubLoadSummary({
  from,
  to,
  filters,
  contractors,
  activeContractorId,
  onPick,
  onSetRouteOrder,
  busy,
}: {
  from: string;
  to: string;
  filters: JobFilters;
  contractors: ContractorOption[];
  activeContractorId: string;
  onPick: (id: string) => void;
  onSetRouteOrder: (jobIds: number[]) => void;
  busy: boolean;
}) {
  // Deliberately ignores the contractor filter. Filtering to one sub and then
  // reading their total tells you nothing about whether it is heavy — the
  // comparison is the whole point, so this always loads the full day.
  const { data: jobs } = useListJobs({ from, to, ...jobFilterParams({ ...filters, contractorId: '' }) });
  const spansDays = from !== to;

  const buckets = useMemo(() => {
    if (!jobs?.length) return [];
    const byId = new Map<number | null, {
      id: number | null;
      name: string;
      stops: number;
      amount: number;
      hours: number;
      skipped: number;
      cancelled: number;
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
          cancelled: 0,
          jobs: [],
        };
        byId.set(id, bucket);
      }
      bucket.stops += 1;
      bucket.jobs.push(job);
      bucket.amount += job.amount ?? 0;
      bucket.hours += job.budgetedHours ?? 0;
      if (job.status === 'skipped') bucket.skipped += 1;
      if (job.status === 'cancelled') bucket.cancelled += 1;
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
    <div className="flex gap-2 overflow-x-auto pb-1">
      {buckets.map(bucket => {
        const key = bucket.id == null ? 'unassigned' : String(bucket.id);
        const active = activeContractorId === key;
        // Share of the heaviest sub's dollars. Not a share of the day's total:
        // "half of what the busiest guy has" is the comparison being made.
        const share = heaviest > 0 && bucket.id != null ? bucket.amount / heaviest : 0;
        const openJobs = bucket.jobs.filter(j => j.status !== 'completed' && j.status !== 'cancelled');
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
            // The same colour as this sub's pins on the map, so the tile and
            // the map can be read against each other.
            style={{ borderLeftColor: contractorColor(bucket.id), borderLeftWidth: 4 }}
            className={`w-full rounded-lg border bg-card p-2 text-left shadow-sm transition ${
              bucket.id == null
                ? 'border-dashed opacity-90'
                : active
                  ? 'border-primary ring-2 ring-primary/30'
                  : 'hover:border-primary/50 hover:shadow'
            }`}
            data-testid={`sub-tile-${key}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold">{bucket.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {bucket.stops} {bucket.stops === 1 ? 'stop' : 'stops'}
              </span>
            </div>
            <div className="text-base font-bold leading-tight tabular-nums">{money(bucket.amount)}</div>
            <div className="text-[11px] leading-tight text-muted-foreground">
              {bucket.hours > 0 ? `${bucket.hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} hrs budgeted` : 'No hours budgeted'}
              {bucket.skipped > 0 && (
                <span className="ml-1 font-medium text-orange-700">· {bucket.skipped} skipped</span>
              )}
              {bucket.cancelled > 0 && (
                <span className="ml-1 font-medium text-zinc-600">· {bucket.cancelled} cancelled</span>
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
            <div className="flex items-center gap-3">
              {spansDays ? (
                <span className="mt-1 px-1 text-[11px] text-muted-foreground" title="Google Maps routes one day at a time">
                  Pick one day for a Maps route
                </span>
              ) : (
                <RouteInMapsLink jobs={bucket.jobs} />
              )}
              {openJobs.length > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSetRouteOrder(openJobs.map(j => j.id))}
                  className="mt-1 inline-flex items-center gap-1 px-1 text-[11px] font-medium text-muted-foreground hover:text-primary hover:underline disabled:opacity-50"
                  title={`Clear ${bucket.name}'s route numbers, then click the stops in driving order`}
                  data-testid={`set-route-order-${key}`}
                >
                  <ListOrdered className="h-3 w-3" /> Set route order
                </button>
              )}
            </div>
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

const statusColors: Record<string, string> = {
  scheduled: "bg-muted text-muted-foreground",
  on_the_way: "bg-accent/20 text-accent-foreground border-accent",
  in_progress: "bg-blue-100 text-blue-700 border-blue-200",
  completed: "bg-primary/20 text-primary border-primary",
  // Deliberately not the "completed" color: a skip is a miss, not a success.
  skipped: "bg-orange-100 text-orange-700 border-orange-200",
  // Called off by the office. Grey and struck through: nobody is going.
  cancelled: "bg-zinc-100 text-zinc-500 border-zinc-300 line-through",
};

function DispatchRow({
  job,
  contractors,
  visible,
  selected,
  onToggle,
  renumber,
  onRenumberPick,
}: {
  job: Job;
  contractors: ContractorOption[];
  visible: string[];
  selected: boolean;
  onToggle: () => void;
  renumber: RenumberState | null;
  onRenumberPick: () => void;
}) {
  const show = (key: string) => visible.includes(key);
  const updateJob = useUpdateJob();
  const completeJob = useCompleteJob();
  const deleteJob = useDeleteJob();
  const uncompleteJob = useUncompleteJob();
  const bulk = useBulkJobAction();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [dateDraft, setDateDraft] = useState(job.scheduledDate ?? '');
  useEffect(() => { setDateDraft(job.scheduledDate ?? ''); }, [job.scheduledDate]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
    queryClient.invalidateQueries({ queryKey: ['/api/waiting-list'] });
  };

  // He marks a job done by mistake and used to have to go hunt for the invoice
  // to undo it. Now it's one click from the row it was completed on.
  const undoCompletion = () => {
    const who = job.clientName ?? 'the customer';
    const ok = window.confirm(
      `Undo completion for ${who}?\n\nThe job goes back on the board as scheduled, and its charges come off the invoice. If that was the only thing on the invoice, the invoice is voided.`,
    );
    if (!ok) return;
    uncompleteJob.mutate({ id: job.id, data: { sendTo: 'board' } }, {
      onSuccess: (result) => {
        refresh();
        queryClient.invalidateQueries({ queryKey: ['/api/invoices'] });
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
        toast({
          title: 'Completion undone',
          description: result.invoiceVoided
            ? `${who} is back on the board. Invoice #${result.invoiceNumber ?? result.invoiceId ?? ''} was voided.`
            : result.invoiceId != null
              ? `${who} is back on the board. Its charges came off invoice #${result.invoiceNumber ?? result.invoiceId}.`
              : `${who} is back on the board.`,
        });
      },
      onError: (error) => toast({ title: 'Could not undo', description: error instanceof Error ? error.message : undefined, variant: 'destructive' }),
    });
  };

  const handleUpdate = (data: Parameters<typeof updateJob.mutate>[0]['data']) => {
    updateJob.mutate({ id: job.id, data }, {
      onSuccess: (result) => {
        refresh();
        // Only the skip path returns a notice, so this stays quiet for every
        // other status change.
        const r = result as Job & { skipNotice?: string | null };
        if (r?.skipNotice) {
          toast({
            title: r.skipBillable ? 'Skip recorded — chargeable' : 'Skip recorded — free',
            description: r.skipNotice,
          });
        }
      },
      onError: (error) => {
        toast({ title: 'That did not save', description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
      },
    });
  };

  /**
   * The date box saves on the way out, not on every keystroke.
   *
   * A date box hands back a value every time one of its three parts changes, so
   * clicking into the year and typing "2" gave us "0002-09-16" — a date that
   * looks real, saved straight away, and took the job off the board in the
   * middle of typing, onto a day in year 2 that no screen here will ever show
   * again. Stepping through days with the arrow keys saved every day it passed
   * as its own reschedule too. Now it is a draft until he tabs out or presses
   * Enter, the same as "Move to date" on the selection bar.
   */
  const commitDate = () => {
    const value = dateDraft;
    if (value === (job.scheduledDate ?? '')) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31') {
      setDateDraft(job.scheduledDate ?? '');
      if (value) {
        toast({
          title: 'That date does not look right',
          description: 'Type the whole date — month, day and a four-digit year.',
          variant: 'destructive',
        });
      }
      return;
    }
    // A skipped visit given a new day is owed again, so the skip is retired
    // with the move. Left on, the crew arrives to a row that still says
    // SKIPPED and Complete turns them away.
    handleUpdate(
      job.status === 'skipped' || job.status === 'cancelled'
        ? { scheduledDate: value, status: 'scheduled' }
        : { scheduledDate: value },
    );
  };

  const changeStatus = (next: string) => {
    if (next === job.status) return;
    if (next === 'cancelled') return cancelJob();
    if (next === 'skipped') return skipJob();
    handleUpdate({ status: next as Job['status'] });
  };
  const skipJob = () => {
    const reason = window.prompt(`Skip ${job.clientName ?? 'this job'}? Type the reason (optional).`, job.skipReason ?? '');
    if (reason === null) return;
    handleUpdate({ status: 'skipped', skipReason: reason.trim() || null });
  };
  const cancelJob = () => {
    const reason = window.prompt(`Cancel ${job.clientName ?? 'this job'}? Type the reason (optional). Nobody will go.`, '');
    if (reason === null) return;
    handleUpdate({ status: 'cancelled', cancelReason: reason.trim() || null });
  };
  const backToWaiting = () => {
    bulk.mutate({ data: { jobIds: [job.id], action: 'waiting_list' } }, {
      onSuccess: () => {
        refresh();
        toast({ title: 'Back on the waiting list', description: `${job.clientName ?? 'The job'} has no date now.` });
      },
      onError: (error) => toast({ title: 'Could not send it back', description: error instanceof Error ? error.message : undefined, variant: 'destructive' }),
    });
  };

  const hasCoordinates = job.clientLat != null && job.clientLng != null;
  const hasLocation = hasCoordinates || !!job.clientAddress;
  const mapUrl = hasCoordinates
    ? `https://www.google.com/maps/search/?api=1&query=${job.clientLat},${job.clientLng}`
    : job.clientAddress
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.clientAddress)}`
      : '';

  const inScope = renumber?.scope.includes(job.id) ?? false;
  const pending = inScope ? renumber!.order.indexOf(job.id) : -1;
  const closed = job.status === 'completed' || job.status === 'cancelled';
  const noEmail = !job.clientEmail?.trim();

  return (
    <TableRow
      className={`group ${
        renumber
          ? inScope ? 'cursor-pointer hover:bg-amber-50' : 'opacity-40'
          : 'hover:bg-muted/30'
      } ${
        selected ? 'bg-amber-50/70' :
        job.status === 'completed' ? 'opacity-60 bg-muted/10' :
        job.status === 'cancelled' ? 'opacity-60 bg-zinc-50' :
        job.status === 'skipped' ? 'bg-orange-50/50' : ''
      }`}
      onClick={renumber && inScope ? onRenumberPick : undefined}
      data-testid={`job-row-${job.id}`}
      data-selected={selected ? 'true' : undefined}
    >
      <TableCell className={`sticky left-0 z-[5] w-72 min-w-72 p-2 ${selected ? 'bg-amber-50' : 'bg-card group-hover:bg-muted'}`}>
        <div className="flex items-start gap-2">
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            disabled={renumber != null}
            className="mt-1"
            aria-label={`Select ${job.clientName ?? 'job'}`}
            onClick={e => e.stopPropagation()}
            data-testid={`select-${job.id}`}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-semibold text-foreground">
              {/* "Be able to open up a customer's account by clicking on their
                  name in the dispatch board." */}
              {job.clientId != null ? (
                <Link
                  href={`/clients/${job.clientId}`}
                  onClick={(e) => e.stopPropagation()}
                  className="truncate hover:underline"
                  title={`Open ${job.clientName ?? 'this customer'}`}
                >
                  {job.clientName}
                </Link>
              ) : (
                <span className="truncate">{job.clientName}</span>
              )}
              {/* Said on the row before a bulk email, not after: the two he has
                  to ring are the ones with no address here. */}
              {(noEmail || job.clientDoNotEmail) && (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded border border-destructive/40 bg-destructive/10 px-1 text-[10px] font-medium text-destructive"
                  title={noEmail ? 'No email address on the account' : 'Marked do not email'}
                >
                  <MailX className="h-3 w-3" /> {noEmail ? 'No email' : 'Do not email'}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate max-w-[240px]" title={job.clientAddress ?? undefined}>
              {job.clientAddress || 'No address'}
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell hidden={!show('order')} className="p-1 text-center">
        {inScope ? (
          <span
            className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${pending >= 0 ? 'bg-amber-600 text-white' : 'border border-dashed text-muted-foreground'}`}
            title={pending >= 0 ? `Stop ${pending + 1}` : job.routeOrder ? `Was stop ${job.routeOrder}; click to pick it again` : 'Not numbered yet'}
          >
            {/* Until he saves, a stop he has not picked still shows the number
                it has today, so he can see the run he is replacing. */}
            {pending >= 0 ? pending + 1 : job.routeOrder || '·'}
          </span>
        ) : (
          <Input
            type="number"
            defaultValue={job.routeOrder || ''}
            onBlur={e => { const v = parseInt(e.target.value) || null; if (v !== (job.routeOrder ?? null)) handleUpdate({ routeOrder: v }); }}
            disabled={renumber != null}
            className="w-14 h-8 mx-auto text-center p-1"
            data-testid={`order-${job.id}`}
          />
        )}
      </TableCell>
      <TableCell hidden={!show('status')} className="p-1.5">
        <select
          className={`w-full h-8 text-xs font-bold px-2 rounded-md outline-none cursor-pointer border ${statusColors[job.status] ?? ''}`}
          value={job.status}
          onChange={e => changeStatus(e.target.value)}
          disabled={job.status === 'completed'}
          data-testid={`status-${job.id}`}
        >
          <option value="scheduled">SCHEDULED</option>
          <option value="on_the_way">ON THE WAY</option>
          <option value="in_progress">IN PROGRESS</option>
          <option value="skipped">SKIPPED</option>
          <option value="cancelled">CANCELLED</option>
          {job.status === 'completed' && <option value="completed">COMPLETED</option>}
        </select>
        {job.status === 'skipped' && job.skipReason && (
          <div className="mt-1 max-w-32 truncate text-[10px] font-medium text-orange-700" title={job.skipReason}>
            {job.skipReason}
          </div>
        )}
        {job.status === 'cancelled' && job.cancelReason && (
          <div className="mt-1 max-w-32 truncate text-[10px] font-medium text-zinc-600" title={job.cancelReason}>
            {job.cancelReason}
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
      <TableCell hidden={!show('date')} className="p-1.5 whitespace-nowrap text-sm">
        <div className="flex items-center gap-1.5">
          {/* The calendar he asked for: ticked when the job has been dispatched
              (which everything on the board has), crossed on the waiting list. */}
          {job.dispatched
            ? <CalendarCheck className="h-4 w-4 shrink-0 text-primary" aria-label="Dispatched" />
            : <CalendarX className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Not dispatched" />}
          <Input
            type="date"
            value={dateDraft}
            onChange={e => setDateDraft(e.target.value)}
            onBlur={commitDate}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
            disabled={closed || renumber != null}
            className="h-8 w-36 px-1 text-xs"
            title="Change the date of this job, then press Enter or click away"
            data-testid={`date-${job.id}`}
          />
        </div>
      </TableCell>
      <TableCell hidden={!show('map')} className="p-1.5">
        <div className="flex items-center gap-1.5">
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
          {job.clientMapCode && <MapCodeBadge code={job.clientMapCode} />}
        </div>
        {job.mapNote && (
          <div className="mt-1 max-w-32 truncate text-[10px] font-medium text-muted-foreground" title={job.mapNote}>
            {job.mapNote}
          </div>
        )}
      </TableCell>
      <TableCell hidden={!show('city')} className="p-1.5 text-sm">
        {job.city || <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell hidden={!show('lastService')} className="p-1.5 whitespace-nowrap text-sm">
        {job.lastServiceDate
          ? formatDispatchDate(job.lastServiceDate)
          : <span className="text-muted-foreground">Never serviced</span>}
      </TableCell>
      <TableCell hidden={!show('budgetedHours')} className="p-1.5 whitespace-nowrap text-sm">
        {job.budgetedHours != null
          ? `${job.budgetedHours} ${job.budgetedHours === 1 ? 'hour' : 'hours'}`
          : <span className="text-muted-foreground">Not set</span>}
      </TableCell>
      <TableCell hidden={!show('notes')} className="p-1.5">
        <JobNotes job={job} />
      </TableCell>
      <TableCell hidden={!show('service')} className="whitespace-nowrap p-1.5 text-sm font-medium">
        {job.serviceCode && <span className="mr-1 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{job.serviceCode}</span>}
        {job.serviceName}
      </TableCell>
      <TableCell hidden={!show('assigned')} className="p-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-full border border-white shadow"
            style={{ background: contractorColor(job.assignedToId) }}
            title={job.assignedToName ?? 'Unassigned'}
          />
          <select
            className="w-full h-8 text-xs px-2 rounded-md border outline-none bg-background"
            value={job.assignedToId || ''}
            onChange={e => handleUpdate({ assignedToId: e.target.value ? parseInt(e.target.value) : null })}
            disabled={closed || renumber != null}
            data-testid={`assigned-${job.id}`}
          >
            <option value="">Unassigned</option>
            {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            {job.assignedToId && !contractors.some(c => c.id === job.assignedToId) && (
              <option value={job.assignedToId}>{job.assignedToName ?? `User #${job.assignedToId}`}</option>
            )}
          </select>
        </div>
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
      <TableCell hidden={!show('money')} className="p-1.5 text-right text-sm whitespace-nowrap">
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
      <TableCell className="p-1.5 text-right space-x-1 whitespace-nowrap" onClick={e => e.stopPropagation()}>
        <ProductsPopover job={job} />

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`row-menu-${job.id}`}><MoreVertical className="w-4 h-4" /></Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-1" align="end">
            {!closed && job.status !== 'skipped' && (
              <Button
                variant="ghost"
                className="w-full justify-start text-primary hover:text-primary hover:bg-primary/10"
                onClick={() => {
                  completeJob.mutate({ id: job.id }, {
                    onSuccess: () => { refresh(); toast({ title: 'Completed and invoiced', description: `${job.clientName ?? 'The job'} is on the customer's account.` }); },
                    onError: (error) => toast({ title: 'Could not complete', description: error instanceof Error ? error.message : undefined, variant: 'destructive' }),
                  });
                }}
                data-testid={`complete-${job.id}`}
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> Complete & Invoice
              </Button>
            )}
            {!closed && job.status !== 'skipped' && (
              <Button variant="ghost" className="w-full justify-start text-orange-700 hover:text-orange-700 hover:bg-orange-50" onClick={skipJob} data-testid={`skip-${job.id}`}>
                <SkipForward className="w-4 h-4 mr-2" /> Skip
              </Button>
            )}
            {!closed && (
              <Button variant="ghost" className="w-full justify-start" onClick={cancelJob} data-testid={`cancel-${job.id}`}>
                <XCircle className="w-4 h-4 mr-2" /> Cancel job
              </Button>
            )}
            {job.status !== 'completed' && (
              <Button variant="ghost" className="w-full justify-start" onClick={backToWaiting} disabled={bulk.isPending} data-testid={`waiting-${job.id}`}>
                <RotateCcw className="w-4 h-4 mr-2" /> Back to waiting list
              </Button>
            )}
            {job.status !== 'completed' && (
              <Button
                variant="ghost"
                className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => {
                  if (confirm(`Delete this job for ${job.clientName ?? 'the customer'}? This cannot be undone.`)) {
                    deleteJob.mutate({ id: job.id }, { onSuccess: refresh });
                  }
                }}
                data-testid={`delete-${job.id}`}
              >
                <Trash2 className="w-4 h-4 mr-2" /> Delete Job
              </Button>
            )}
            {job.status === 'completed' && (
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={undoCompletion}
                disabled={uncompleteJob.isPending}
                data-testid={`uncomplete-${job.id}`}
              >
                <RotateCcw className="w-4 h-4 mr-2" /> Undo completion
              </Button>
            )}
          </PopoverContent>
        </Popover>
      </TableCell>
    </TableRow>
  );
}

export function formatDispatchDate(value: string) {
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
          onClick={e => e.stopPropagation()}
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
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  // The parts list only loads once the popover is opened, so 60 rows on the
  // board don't each fetch it.
  const { data: presets } = useListProductPresets({ query: { enabled: open, queryKey: ['/api/product-presets'] } });
  // '' = type it in by hand; otherwise the id of a preset off the parts list.
  const [presetId, setPresetId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const isCompleted = job.status === 'completed';
  const preset = presets?.find(p => String(p.id) === presetId) ?? null;
  const qty = parseFloat(quantity);
  const qtyOk = Number.isFinite(qty) && qty > 0;
  const canAdd = !isCompleted && qtyOk && (preset ? true : Boolean(name.trim()) && price !== '' && Number.isFinite(parseFloat(price)));

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    const data = preset
      ? { presetId: preset.id, quantity: qty }
      : { name: name.trim(), price: parseFloat(price), quantity: qty };
    addProduct.mutate({ id: job.id, data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
        setName('');
        setPrice('');
        setQuantity('1');
      },
      onError: (error) => toast({ title: 'Could not add', description: error instanceof Error ? error.message : undefined, variant: 'destructive' }),
    });
  };

  const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:bg-primary/10" title="Products/Parts" data-testid={`products-${job.id}`}>
          <PackageOpen className="w-4 h-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4" align="end">
        <h4 className="font-semibold text-sm mb-3">Parts & Products</h4>
        <div className="space-y-2 mb-4 max-h-[200px] overflow-auto">
          {!job.products?.length ? (
            <div className="text-xs text-muted-foreground">No products added.</div>
          ) : (
            job.products.map(p => {
              const q = p.quantity ?? 1;
              return (
                <div key={p.id} className="flex justify-between items-center text-sm bg-muted/50 p-2 rounded border">
                  <span className="truncate w-36" title={p.name}>{p.name}</span>
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    {q !== 1 && <span className="text-xs text-muted-foreground">{q} × {money(p.price)}</span>}
                    <span className="font-semibold">{money(p.price * q)}</span>
                    {!isCompleted && (
                      <Button variant="ghost" size="icon" className="w-5 h-5 text-destructive" onClick={() => {
                        deleteProduct.mutate({ id: p.id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/jobs'] }) });
                      }}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        {!isCompleted && (
          <form onSubmit={handleAdd} className="space-y-2 pt-3 border-t">
            {/* Bag fee, sprinkler head, etc. come off the parts list so the price is
                always the same; the free-text row stays for the one-off nobody listed. */}
            <select
              className={selectClass}
              value={presetId}
              onChange={e => setPresetId(e.target.value)}
              data-testid={`product-preset-${job.id}`}
            >
              <option value="">Type it in…</option>
              {(presets ?? []).map(p => (
                <option key={p.id} value={p.id}>
                  {p.label} — {money(p.defaultPrice)}{p.unit ? ` / ${p.unit}` : ''}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              {preset ? (
                <div className="flex-1 min-w-0 self-center text-xs text-muted-foreground truncate">
                  {money(preset.defaultPrice)}{preset.unit ? ` per ${preset.unit}` : ' each'}
                </div>
              ) : (
                <>
                  <Input placeholder="Part name" value={name} onChange={e => setName(e.target.value)} className="h-8 text-xs flex-1 min-w-0" data-testid={`product-name-${job.id}`} />
                  <Input type="number" step="0.01" min="0" placeholder="$" value={price} onChange={e => setPrice(e.target.value)} className="h-8 text-xs w-16" data-testid={`product-price-${job.id}`} />
                </>
              )}
              <Input
                type="number"
                step="any"
                min="0"
                placeholder="Qty"
                title="How many"
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                className="h-8 text-xs w-14"
                data-testid={`product-qty-${job.id}`}
              />
              <Button type="submit" size="sm" className="h-8 w-8 p-0 shrink-0" disabled={!canAdd || addProduct.isPending} title="Add" data-testid={`product-add-${job.id}`}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            {qtyOk && (preset || (price !== '' && Number.isFinite(parseFloat(price)))) && qty !== 1 && (
              <div className="text-xs text-muted-foreground text-right">
                {qty} × {money(preset ? preset.defaultPrice : parseFloat(price))} = {money((preset ? preset.defaultPrice : parseFloat(price)) * qty)}
              </div>
            )}
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}

function NewJobDialog({ date, contractors }: { date: string, contractors: ContractorOption[] }) {
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

  // Follows the board's date so "Add Job" lands on the day being looked at.
  useEffect(() => { setScheduledDate(date); }, [date]);

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
