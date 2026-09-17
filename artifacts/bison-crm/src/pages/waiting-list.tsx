import { useEffect, useMemo, useState } from 'react';
import {
  useListWaitingList, useListServices, useListClients, useBulkJobAction,
  useBuildRouteFromWaitingList, RouteBuildResult, type Job,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { format } from 'date-fns';
import { AlertTriangle, CalendarX, FileText, MailX, MapPin } from 'lucide-react';
import { DispatchMap } from '@/components/dispatch-map';
import { BulkActionsBar } from '@/components/dispatch/bulk-actions-bar';
import { EmailDocumentDialog } from '@/components/dispatch/email-document-dialog';
import { JobFiltersPopover, EMPTY_JOB_FILTERS, jobFilterParams, countActiveFilters, selectClass, type JobFilters } from '@/components/dispatch/job-filters';
import { useContractors } from '@/components/dispatch/contractors';
import { MapCodeBadge } from '@/components/map-code';
import { contractorColor } from '@/lib/contractor-color';

const today = () => format(new Date(), 'yyyy-MM-dd');

const money = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The waiting list: one-time jobs with a date window, not yet given a day.
 *
 * A job is only "waiting" on a day inside its window, so the list opens on
 * today and shows what could go out today. "All open windows" is the wider
 * view; "Windows that passed" is the tidy-up — jobs whose window closed without
 * going out, which he cancels in one go when a package was put on late.
 */
type WindowView = 'date' | 'all' | 'past';

export default function WaitingList() {
  const [view, setView] = useState<WindowView>('date');
  const [date, setDate] = useState(today());
  const [filters, setFilters] = useState<JobFilters>(EMPTY_JOB_FILTERS);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [showMap, setShowMap] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  const params = {
    ...(view === 'date' ? { date } : { window: view as 'all' | 'past' }),
    ...jobFilterParams(filters),
  };
  const { data: jobs, isLoading } = useListWaitingList(params);
  const contractors = useContractors();
  const bulk = useBulkJobAction();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Anything no longer listed drops out of the selection, so a change of
  // date or filter cannot leave unseen jobs in the next action.
  useEffect(() => {
    if (!jobs) return;
    const present = new Set(jobs.map((j) => j.id));
    setSelectedIds((cur) => (cur.every((id) => present.has(id)) ? cur : cur.filter((id) => present.has(id))));
  }, [jobs]);

  const toggleSelect = (id: number) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const allSelected = !!jobs?.length && jobs.every((j) => selectedIds.includes(j.id));
  const toggleAll = () => setSelectedIds(allSelected ? [] : (jobs ?? []).map((j) => j.id));
  const selectedJobs = useMemo(() => (jobs ?? []).filter((j) => selectedIds.includes(j.id)), [jobs, selectedIds]);

  const totals = useMemo(
    () => ({
      count: jobs?.length ?? 0,
      amount: (jobs ?? []).reduce((s, j) => s + (j.amount ?? 0), 0),
    }),
    [jobs],
  );

  // The map's one press: everything lassoed gets the date and the contractor.
  const quickDispatch = (input: { scheduledDate: string; assignedToId: number | null }) => {
    bulk.mutate(
      { data: { jobIds: selectedIds, action: 'dispatch', scheduledDate: input.scheduledDate, assignedToId: input.assignedToId } },
      {
        onSuccess: (r) => {
          queryClient.invalidateQueries({ queryKey: ['/api/waiting-list'] });
          queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
          setSelectedIds([]);
          toast({
            title: `Dispatched ${r.updated} job${r.updated === 1 ? '' : 's'} to ${input.scheduledDate}`,
            description: r.skippedIds.length ? `${r.skippedIds.length} left alone (already completed or cancelled).` : undefined,
          });
        },
        onError: (error) => toast({ title: 'Nothing was dispatched', description: error instanceof Error ? error.message : undefined, variant: 'destructive' }),
      },
    );
  };

  const hasFilters = countActiveFilters(filters) > 0;

  return (
    <div className="p-8 mx-auto space-y-4 flex flex-col h-[calc(100vh-2rem)] min-w-0">
      <div className="flex flex-wrap justify-between items-end gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Waiting List</h1>
          <p className="text-muted-foreground mt-1">
            {view === 'past'
              ? 'Jobs whose window closed without going out.'
              : view === 'all'
                ? 'Every job still waiting, whatever its window.'
                : `Jobs whose window is open on ${formatDate(date)}.`}
            {totals.count > 0 && ` ${totals.count} job${totals.count === 1 ? '' : 's'} · ${money(totals.amount)}.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2 bg-card p-2 rounded-lg border shadow-sm">
            <select className={`${selectClass} w-44`} value={view} onChange={(e) => setView(e.target.value as WindowView)} data-testid="waiting-view">
              <option value="date">Open on a date</option>
              <option value="all">All open windows</option>
              <option value="past">Windows that passed</option>
            </select>
            {view === 'date' && (
              <>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value || today())} className="w-40" data-testid="waiting-date" />
                <Button variant="ghost" size="sm" onClick={() => setDate(today())}>Today</Button>
              </>
            )}
            <JobFiltersPopover value={filters} onChange={setFilters} contractors={contractors} withStatus={false} />
          </div>
          <Button variant={showMap ? 'default' : 'outline'} onClick={() => setShowMap((v) => !v)} data-testid="toggle-map">
            <MapPin className="mr-1 h-4 w-4" /> {showMap ? 'Hide Map' : 'Show Map'}
          </Button>
          <BuildRouteDialog />
        </div>
      </div>

      {view === 'past' && (jobs?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="past-windows-banner">
          <AlertTriangle className="h-4 w-4 text-amber-700" />
          <span>
            These {jobs!.length} job{jobs!.length === 1 ? '' : 's'} never went out before {jobs!.length === 1 ? 'its' : 'their'} window closed.
            Tick them and use <strong>Cancel</strong> to clear the lot, or <strong>Dispatch</strong> to give them a day anyway.
          </span>
          {!allSelected && (
            <Button size="sm" variant="outline" onClick={toggleAll} data-testid="past-select-all">Select all {jobs!.length}</Button>
          )}
        </div>
      )}

      {showMap && (
        <DispatchMap
          jobs={jobs ?? []}
          contractors={contractors}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          variant="waiting"
          defaultDate={view === 'date' ? date : today()}
          quickDispatch={{ busy: bulk.isPending, onRun: quickDispatch }}
        />
      )}

      <BulkActionsBar
        selectedIds={selectedIds}
        jobs={jobs ?? []}
        contractors={contractors}
        context="waiting"
        defaultDate={view === 'date' ? date : today()}
        onClear={() => setSelectedIds([])}
        onEmail={() => setEmailOpen(true)}
      />

      <EmailDocumentDialog open={emailOpen} onOpenChange={setEmailOpen} jobs={selectedJobs} source="waiting_list" />

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0 z-10">
            <TableRow>
              <TableHead className="w-12">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} disabled={!jobs?.length} aria-label="Select all" data-testid="select-all" />
              </TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Service</TableHead>
              <TableHead>City</TableHead>
              <TableHead>Map</TableHead>
              <TableHead>Window</TableHead>
              <TableHead>Contractor</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={9} className="text-center py-4">Loading...</TableCell></TableRow>
            ) : !jobs?.length ? (
              <TableRow>
                <TableCell colSpan={9} className="py-12">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
                    <p className="font-medium">
                      {hasFilters
                        ? 'No waiting jobs match these filters'
                        : view === 'past'
                          ? 'No windows have passed. Nothing to tidy.'
                          : view === 'all'
                            ? 'Nothing is waiting.'
                            : `Nothing is waiting with a window open on ${formatDate(date)}.`}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {hasFilters ? 'Try clearing a filter.' : view === 'date' ? 'Try another date, or "All open windows".' : ''}
                    </p>
                    {hasFilters && (
                      <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_JOB_FILTERS)}>Clear filters</Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((j) => (
                <WaitingRow key={j.id} job={j} pastView={view === 'past'} selected={selectedIds.includes(j.id)} onToggle={() => toggleSelect(j.id)} />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function WaitingRow({ job, pastView, selected, onToggle }: { job: Job; pastView: boolean; selected: boolean; onToggle: () => void }) {
  const noEmail = !job.clientEmail?.trim();
  // On "Windows that passed" the server already decided, using our day — the
  // red text has to say the same thing the banner above it says, or he is
  // cancelling a batch that looks fine row by row.
  const windowPassed = pastView || (!!job.windowEnd && job.windowEnd < today());
  return (
    <TableRow
      className={`cursor-pointer ${selected ? 'bg-amber-50/70 hover:bg-amber-50' : 'hover:bg-muted/50'}`}
      onClick={onToggle}
      data-testid={`job-row-${job.id}`}
      data-selected={selected ? 'true' : undefined}
    >
      <TableCell onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${job.clientName ?? 'job'}`} data-testid={`select-${job.id}`} />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5 font-semibold">
          {/* The crossed calendar: not dispatched. Every row here is, and the
              board shows the ticked one — the same icon pair on both screens. */}
          <CalendarX className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Not dispatched" />
          <span className="truncate">{job.clientName}</span>
          {(noEmail || job.clientDoNotEmail) && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded border border-destructive/40 bg-destructive/10 px-1 text-[10px] font-medium text-destructive"
              title={noEmail ? 'No email address on the account' : 'Marked do not email'}
            >
              <MailX className="h-3 w-3" /> {noEmail ? 'No email' : 'Do not email'}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate max-w-[260px]" title={job.clientAddress ?? undefined}>{job.clientAddress || 'No address'}</div>
      </TableCell>
      {/* The short CODE is what he reads the waiting list by (BA7, BACKF, MOWIN). */}
      <TableCell className="text-sm">
        {job.serviceCode && <span className="mr-1 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{job.serviceCode}</span>}
        {job.serviceName ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-sm">{job.city ?? <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell>{job.clientMapCode ? <MapCodeBadge code={job.clientMapCode} /> : <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell className={`whitespace-nowrap text-sm ${windowPassed ? 'text-destructive' : ''}`} title={windowPassed ? 'The window has passed' : undefined}>
        {job.windowStart ? formatDate(job.windowStart) : '—'} → {job.windowEnd ? formatDate(job.windowEnd) : 'open'}
      </TableCell>
      <TableCell className="text-sm">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border border-white shadow" style={{ background: contractorColor(job.assignedToId) }} />
          {job.assignedToName ?? <span className="text-muted-foreground">Unassigned</span>}
        </span>
      </TableCell>
      <TableCell className="max-w-44">
        {job.notes ? (
          <span className={`inline-flex items-center gap-1 text-xs ${job.notesImportant ? 'font-medium text-destructive' : 'text-muted-foreground'}`} title={job.notes}>
            {job.notesImportant ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{job.notes}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right text-sm font-medium">{money(job.amount ?? 0)}</TableCell>
    </TableRow>
  );
}

function formatDate(value: string) {
  const d = new Date(value.includes('T') ? value : `${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? value : format(d, 'MMM d, yyyy');
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

  const contractors = useContractors();
  const { data: services } = useListServices();
  const { data: clients } = useListClients();
  const buildRoute = useBuildRouteFromWaitingList();
  const queryClient = useQueryClient();

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
