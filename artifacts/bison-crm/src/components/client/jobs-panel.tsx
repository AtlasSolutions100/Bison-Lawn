import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListClientJobs,
  getListClientJobsQueryKey,
  useGetJob,
  useUpdateJob,
  useDispatchJobs,
  useCompleteJob,
  useUncompleteJob,
  useListFieldNotes,
  useListJobTimeEntries,
  useListJobPhotos,
  useGetInvoice,
  useListUsers,
  useListClientServices,
  useListServices,
  type Job,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { contractorColor } from '@/lib/contractor-color';
import { format, parseISO } from 'date-fns';
import { AlertTriangle, Briefcase, Camera, Clock, FileText, PackageOpen, Receipt, User } from 'lucide-react';

/**
 * The Jobs bar on the customer's page: every visit they have had or have
 * coming, with the money next to each one. His old system split it into All /
 * Upcoming / History and he reads the totals off the bottom, so this does the
 * same. Clicking a row opens the whole job — who did it, what the office told
 * the contractor, what the contractor wrote back, the parts, the time, the
 * photos — and the office can move, reassign, cancel, complete or un-complete
 * it from there without going to the board.
 */

type TabKey = 'all' | 'upcoming' | 'history';

const OPEN_STATUSES = new Set(['scheduled', 'on_the_way', 'in_progress']);

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  on_the_way: 'On the way',
  in_progress: 'In progress',
  completed: 'Completed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

const STATUS_CLASS: Record<string, string> = {
  scheduled: 'bg-muted text-muted-foreground border-border',
  on_the_way: 'bg-accent/20 text-accent-foreground border-accent/30',
  in_progress: 'bg-accent/20 text-accent-foreground border-accent/30',
  completed: 'bg-primary/10 text-primary border-primary/20',
  skipped: 'bg-destructive/10 text-destructive border-destructive/20',
  cancelled: 'bg-destructive/10 text-destructive border-destructive/20',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[status] ?? STATUS_CLASS.scheduled}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Oct 3, 2026" from a yyyy-mm-dd, without the UTC-midnight day slip. */
const dayLabel = (d: string) => format(parseISO(d), 'MMM d, yyyy');
const shortDay = (d: string) => format(parseISO(d), 'MMM d');

/**
 * What the visit actually bills at: the service price less the discount on the
 * assigned service. The job keeps the retail price all its life, so a $50 mow
 * with a $5 loyalty discount used to show $50 on the row and add $50 to the
 * bottom line while its invoice said $45 — over a season the History total was
 * out by the discount on every visit.
 */
const netAmount = (j: Job) => j.amount - (j.discountAmount ?? 0);

/** The day a job belongs to, for sorting: its board day, or the start of its window. */
function jobDay(j: Job): string {
  return j.scheduledDate ?? j.windowStart ?? '';
}

function JobDate({ job }: { job: Job }) {
  if (job.scheduledDate) return <span>{dayLabel(job.scheduledDate)}</span>;
  if (job.windowStart || job.windowEnd) {
    return (
      <span>
        {job.windowStart ? shortDay(job.windowStart) : '?'} – {job.windowEnd ? shortDay(job.windowEnd) : '?'}
        <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">waiting</span>
      </span>
    );
  }
  return <span className="text-muted-foreground">No date</span>;
}

function Contractor({ job }: { job: Job }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: contractorColor(job.assignedToId) }} />
      {job.assignedToName ?? <span className="text-muted-foreground">Unassigned</span>}
    </span>
  );
}

const PAGE = 50;

export default function ClientJobsPanel({ clientId }: { clientId: number }) {
  const { data: jobs, isLoading, isError } = useListClientJobs(clientId);
  const [tab, setTab] = useState<TabKey>('upcoming');
  const [limit, setLimit] = useState(PAGE);
  const [openJobId, setOpenJobId] = useState<number | null>(null);
  const today = format(new Date(), 'yyyy-MM-dd');

  const rows = useMemo(() => {
    const all = jobs ?? [];
    // Upcoming is anything still to be done: on the board from today on, or
    // on the waiting list with no day yet. History is everything that has
    // already happened, whichever way it ended.
    const upcoming = all.filter(j => OPEN_STATUSES.has(j.status) && (!j.dispatched || (j.scheduledDate ?? '') >= today));
    const history = all.filter(j => !upcoming.includes(j));
    const byDay = (dir: 1 | -1) => (a: Job, b: Job) => (jobDay(a) < jobDay(b) ? -dir : jobDay(a) > jobDay(b) ? dir : (a.id - b.id) * dir);
    return {
      all: [...all].sort(byDay(-1)),
      upcoming: [...upcoming].sort(byDay(1)),
      history: [...history].sort(byDay(-1)),
    };
  }, [jobs, today]);

  const visible = rows[tab];
  const shown = visible.slice(0, limit);
  const total = visible.reduce((s, j) => s + netAmount(j), 0);
  // Money the customer still has coming: only what was actually done counts
  // toward "history" totals in his head, so cancelled and skipped stay out.
  const doneTotal = visible.filter(j => j.status === 'completed').reduce((s, j) => s + netAmount(j), 0);

  return (
    <Card className="shadow-sm border-border" data-testid="client-jobs-panel">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Briefcase className="w-5 h-5 text-muted-foreground" /> Jobs
          </CardTitle>
          <Tabs value={tab} onValueChange={v => { setTab(v as TabKey); setLimit(PAGE); }}>
            <TabsList>
              <TabsTrigger value="all" data-testid="tab-jobs-all">All jobs ({rows.all.length})</TabsTrigger>
              <TabsTrigger value="upcoming" data-testid="tab-jobs-upcoming">Upcoming ({rows.upcoming.length})</TabsTrigger>
              <TabsTrigger value="history" data-testid="tab-jobs-history">History ({rows.history.length})</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-muted-foreground animate-pulse">Loading jobs...</div>
        ) : isError ? (
          <div className="p-6 text-center text-destructive">Jobs could not be loaded.</div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground">
            {tab === 'upcoming' ? 'Nothing scheduled. Assign a service or add a job.' : 'No jobs here yet.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left font-semibold px-4 py-2">Date</th>
                  <th className="text-left font-semibold px-4 py-2">Service</th>
                  <th className="text-left font-semibold px-4 py-2">Contractor</th>
                  <th className="text-right font-semibold px-4 py-2">Amount</th>
                  <th className="text-left font-semibold px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {shown.map(job => (
                  <tr
                    key={job.id}
                    className="cursor-pointer hover:bg-muted/30"
                    onClick={() => setOpenJobId(job.id)}
                    data-testid={`row-job-${job.id}`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap"><JobDate job={job} /></td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{job.serviceName ?? 'Job'}</span>
                      {job.notesImportant && job.notes && (
                        <AlertTriangle className="inline w-3.5 h-3.5 ml-1.5 text-destructive" aria-label="Important note" />
                      )}
                      {job.products && job.products.length > 0 && (
                        <span className="ml-1.5 text-xs text-muted-foreground">+{job.products.length} {job.products.length === 1 ? 'product' : 'products'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><Contractor job={job} /></td>
                    <td className="px-4 py-2.5 text-right font-semibold whitespace-nowrap">
                      {money(netAmount(job))}
                      {(job.discountAmount ?? 0) > 0 && (
                        <span className="ml-1 text-[10px] font-normal text-muted-foreground">less {money(job.discountAmount ?? 0)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5"><StatusBadge status={job.status} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/30 text-xs font-semibold">
                <tr>
                  <td className="px-4 py-2" colSpan={3}>
                    {visible.length} {visible.length === 1 ? 'job' : 'jobs'}
                    {tab !== 'upcoming' && doneTotal !== total && (
                      <span className="ml-2 font-normal text-muted-foreground">({money(doneTotal)} completed)</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">{money(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            {visible.length > shown.length && (
              <div className="p-3 text-center border-t">
                <Button variant="ghost" size="sm" onClick={() => setLimit(l => l + PAGE)}>
                  Show {Math.min(PAGE, visible.length - shown.length)} more
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
      <JobDetailDialog jobId={openJobId} clientId={clientId} onClose={() => setOpenJobId(null)} />
    </Card>
  );
}

/**
 * The job dialog on its own, so the Activity timeline (activity-panel.tsx)
 * can open a visit the same way the Jobs bar does. Pass null to keep it shut.
 */
export function JobDetailDialog({ jobId, clientId, onClose }: { jobId: number | null; clientId: number; onClose: () => void }) {
  return (
    <Dialog open={jobId != null} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        {jobId != null && <JobDetail jobId={jobId} clientId={clientId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof User; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        <Icon className="w-3.5 h-3.5" /> {title}
      </h4>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function JobDetail({ jobId, clientId, onClose }: { jobId: number; clientId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: job, isLoading } = useGetJob(jobId);
  const { data: fieldNotes } = useListFieldNotes({ jobId });
  const { data: timeEntries } = useListJobTimeEntries(jobId);
  const { data: photos } = useListJobPhotos(jobId);
  const { data: users } = useListUsers();
  const { data: services } = useListServices();
  const { data: clientServices } = useListClientServices(clientId);
  const invoiceId = job?.invoiceId ?? 0;
  const { data: invoice } = useGetInvoice(invoiceId, { query: { enabled: invoiceId > 0, queryKey: [`/api/invoices/${invoiceId}`] } });

  const updateJob = useUpdateJob();
  const dispatchJobs = useDispatchJobs();
  const completeJob = useCompleteJob();
  const uncompleteJob = useUncompleteJob();

  const [newDate, setNewDate] = useState('');
  const [newAssignee, setNewAssignee] = useState('');

  // Everything the page shows about this customer can change when a job
  // does: the jobs list, the job itself, the invoices and the balance.
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListClientJobsQueryKey(clientId) });
    queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}`] });
    queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
    queryClient.invalidateQueries({ queryKey: ['/api/waiting-list'] });
    queryClient.invalidateQueries({ queryKey: ['/api/invoices'] });
    queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}`] });
    queryClient.invalidateQueries({ queryKey: ['/api/client-activity'] });
  };
  const failed = (title: string) => (err: any) =>
    toast({ title, description: err?.data?.error ?? err?.message, variant: 'destructive' });

  if (isLoading || !job) {
    return (
      <>
        <DialogHeader><DialogTitle>Job #{jobId}</DialogTitle></DialogHeader>
        <div className="text-sm text-muted-foreground animate-pulse">Loading job...</div>
      </>
    );
  }

  const service = services?.find(s => s.id === job.serviceId);
  // The assigned service's own note: what the office told the contractor to
  // read before starting. CLIENT-SERVICES adds contractorNote to the
  // assigned-service contract; until then the field is simply absent.
  const assigned = clientServices?.find(cs => cs.id === job.clientServiceId) as
    | { contractorNote?: string | null; noteStartDate?: string | null; noteEndDate?: string | null }
    | undefined;
  // jobs.ts already puts the note that applies on this job's date onto the
  // job itself (and when the contractor opened it); those win when present.
  const onJob = job as { contractorNote?: string | null; noteAcknowledgedAt?: string | null };
  const presetNote = onJob.contractorNote?.trim() || assigned?.contractorNote?.trim() || null;
  const noteOpenedAt = onJob.noteAcknowledgedAt ?? null;
  const invoiceDescription = (service as { invoiceDescription?: string | null } | undefined)?.invoiceDescription?.trim() || null;
  const productsTotal = (job.products ?? []).reduce((s, p) => s + p.price * (p.quantity ?? 1), 0);
  const isCompleted = job.status === 'completed';
  const isClosed = isCompleted || job.status === 'cancelled';
  const busy = updateJob.isPending || dispatchJobs.isPending || completeJob.isPending || uncompleteJob.isPending;

  const reschedule = () => {
    if (!newDate) return;
    const after = () => { refresh(); setNewDate(''); toast({ title: `Moved to ${dayLabel(newDate)}` }); };
    if (job.dispatched) {
      updateJob.mutate({ id: job.id, data: { scheduledDate: newDate } }, { onSuccess: after, onError: failed('Could not move the job') });
    } else {
      // A waiting-list job has no day; giving it one is a dispatch, and that
      // is what puts it on the board.
      dispatchJobs.mutate({ data: { jobIds: [job.id], date: newDate } }, { onSuccess: after, onError: failed('Could not put the job on the board') });
    }
  };

  const reassign = () => {
    const assignedToId = newAssignee ? Number(newAssignee) : null;
    updateJob.mutate({ id: job.id, data: { assignedToId } }, {
      onSuccess: () => { refresh(); setNewAssignee(''); toast({ title: assignedToId ? 'Contractor changed' : 'Contractor removed' }); },
      onError: failed('Could not change the contractor'),
    });
  };

  const cancel = () => {
    const reason = window.prompt('Why is this job being cancelled? (shown on the row)');
    if (reason === null) return;
    updateJob.mutate({ id: job.id, data: { status: 'cancelled', cancelReason: reason.trim() || null } }, {
      onSuccess: () => { refresh(); toast({ title: 'Job cancelled' }); },
      onError: failed('Could not cancel the job'),
    });
  };

  const complete = () => {
    if (!window.confirm('Mark this job complete? That makes the invoice for it.')) return;
    completeJob.mutate({ id: job.id }, {
      onSuccess: (done) => { refresh(); toast({ title: 'Job completed', description: done.invoiceId ? `Invoice #${done.invoiceId} created` : undefined }); },
      onError: failed('Could not complete the job'),
    });
  };

  const undoComplete = () => {
    if (!window.confirm('Undo the completion? The invoice lines for this job come off the bill.')) return;
    uncompleteJob.mutate({ id: job.id, data: { sendTo: 'board' } }, {
      onSuccess: (r) => {
        refresh();
        toast({
          title: 'Completion undone',
          description: r.invoiceVoided
            ? `Invoice #${r.invoiceNumber ?? r.invoiceId} was voided`
            : r.invoiceId ? `Its lines were taken off invoice #${r.invoiceNumber ?? r.invoiceId}` : undefined,
        });
      },
      onError: failed('Could not undo the completion'),
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-3">
          <span>{job.serviceName ?? 'Job'} <span className="text-muted-foreground font-normal">#{job.id}</span></span>
          <StatusBadge status={job.status} />
        </DialogTitle>
      </DialogHeader>

      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><p className="text-xs text-muted-foreground">Date</p><p className="font-medium"><JobDate job={job} /></p></div>
        <div><p className="text-xs text-muted-foreground">Contractor</p><p className="font-medium"><Contractor job={job} /></p></div>
        <div><p className="text-xs text-muted-foreground">Amount</p><p className="font-bold">{money(netAmount(job))}{(job.discountAmount ?? 0) > 0 && <span className="text-xs font-normal text-muted-foreground"> after {money(job.discountAmount ?? 0)} off</span>}{productsTotal > 0 && <span className="text-xs font-normal text-muted-foreground"> + {money(productsTotal)} products</span>}</p></div>
        <div>
          <p className="text-xs text-muted-foreground">{isCompleted ? 'Completed' : job.status === 'cancelled' ? 'Cancelled' : job.status === 'skipped' ? 'Skipped' : 'Budgeted'}</p>
          <p className="font-medium">
            {isCompleted && job.completedAt ? format(parseISO(job.completedAt), 'MMM d, h:mm a')
              : job.status === 'cancelled' ? (job.cancelReason || 'no reason given')
              : job.status === 'skipped' ? (job.skipReason || 'no reason given')
              : job.budgetedHours != null ? `${job.budgetedHours} hrs` : '—'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Section icon={FileText} title="Notes for the contractor (preset)">
          {job.notes || presetNote ? (
            <div className="space-y-2">
              {job.notes && (
                <p className={`whitespace-pre-wrap ${job.notesImportant ? 'text-destructive font-medium' : ''}`}>
                  {job.notesImportant && <AlertTriangle className="inline w-4 h-4 mr-1" />}{job.notes}
                </p>
              )}
              {presetNote && (
                <p className="whitespace-pre-wrap">
                  <span className="text-xs text-muted-foreground">From the assigned service: </span>{presetNote}
                </p>
              )}
              {presetNote && (
                <p className="text-xs text-muted-foreground">
                  {noteOpenedAt
                    ? `Opened by the contractor ${format(parseISO(noteOpenedAt), 'MMM d, h:mm a')}`
                    : 'Not opened by the contractor yet — they cannot start until they do.'}
                </p>
              )}
            </div>
          ) : <p className="text-muted-foreground">None</p>}
        </Section>

        <Section icon={User} title="What the contractor wrote">
          {fieldNotes && fieldNotes.length > 0 ? (
            <div className="space-y-2">
              {fieldNotes.map(n => (
                <div key={n.id}>
                  <p className="whitespace-pre-wrap">{n.transcript}</p>
                  <p className="text-xs text-muted-foreground">{n.authorName ?? 'Contractor'} · {format(parseISO(n.createdAt), 'MMM d, h:mm a')}{n.ticketId ? ` · ticket #${n.ticketId}` : ''}</p>
                </div>
              ))}
            </div>
          ) : <p className="text-muted-foreground">Nothing written on this job</p>}
        </Section>

        <Section icon={Receipt} title="On the invoice">
          {invoice ? (
            <div className="space-y-1">
              <p>
                <Link href={`/invoices?clientId=${clientId}`} className="font-medium text-primary hover:underline">Invoice #{invoice.number}</Link>
                <span className="text-muted-foreground"> · {money(invoice.total)} · {invoice.status}{invoice.balance > 0 ? ` · ${money(invoice.balance)} owed` : ''}</span>
              </p>
              {invoice.lines.map(l => (
                <p key={l.id} className="text-xs">{l.description}{l.quantity !== 1 ? ` × ${l.quantity}` : ''} — {money(l.total)}</p>
              ))}
              {invoice.notes && <p className="text-xs"><span className="text-muted-foreground">Note to the customer: </span>{invoice.notes}</p>}
            </div>
          ) : (
            <div className="space-y-1">
              <p><span className="text-muted-foreground">Will print as: </span>{invoiceDescription ?? job.serviceName ?? 'Job'}</p>
              <p className="text-xs text-muted-foreground">Not invoiced yet — the invoice is made when the job is completed.</p>
            </div>
          )}
        </Section>

        <Section icon={PackageOpen} title="Products added">
          {job.products && job.products.length > 0 ? (
            <div className="space-y-1">
              {job.products.map(p => (
                <p key={p.id} className="flex justify-between"><span>{p.name}{(p.quantity ?? 1) !== 1 ? ` × ${p.quantity}` : ''}</span><span className="font-medium">{money(p.price * (p.quantity ?? 1))}</span></p>
              ))}
              <p className="flex justify-between border-t pt-1 font-semibold"><span>Products</span><span>{money(productsTotal)}</span></p>
            </div>
          ) : <p className="text-muted-foreground">None</p>}
        </Section>

        <Section icon={Clock} title="Time on site">
          {timeEntries && timeEntries.length > 0 ? (
            <div className="space-y-1">
              {timeEntries.map(t => (
                <p key={t.id} className="flex justify-between">
                  <span>{t.userName ?? 'Contractor'} · {format(parseISO(t.clockInAt), 'MMM d, h:mm a')}{t.clockOutAt ? ` – ${format(parseISO(t.clockOutAt), 'h:mm a')}` : ' (still on site)'}</span>
                  <span className="font-medium">{t.minutes != null ? `${t.minutes} min` : ''}</span>
                </p>
              ))}
            </div>
          ) : <p className="text-muted-foreground">No clock-ins</p>}
        </Section>

        <Section icon={Camera} title="Photos">
          {photos && photos.length > 0 ? (
            <div className="grid grid-cols-4 gap-1.5">
              {photos.map(p => (
                <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="relative aspect-square overflow-hidden rounded-md border bg-muted">
                  {p.contentType === 'application/pdf'
                    ? <span className="flex h-full items-center justify-center text-xs font-semibold">PDF</span>
                    : <img src={p.url} alt={p.caption ?? p.kind} className="h-full w-full object-cover" />}
                  <span className="absolute bottom-0 left-0 right-0 bg-black/55 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">{p.kind}</span>
                </a>
              ))}
            </div>
          ) : <p className="text-muted-foreground">None</p>}
        </Section>
      </div>

      <div className="rounded-lg border p-3 space-y-3">
        <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Change this job</h4>
        {!isClosed && (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium">{job.dispatched ? 'Move to' : 'Put on the board for'}</label>
              <Input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} className="w-44" data-testid="input-job-reschedule" />
            </div>
            <Button size="sm" variant="outline" onClick={reschedule} disabled={!newDate || busy} data-testid="button-job-reschedule">
              {job.dispatched ? 'Move' : 'Dispatch'}
            </Button>
            <div className="ml-4">
              <label className="mb-1 block text-xs font-medium">Contractor</label>
              <select className="flex h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm" value={newAssignee} onChange={e => setNewAssignee(e.target.value)} data-testid="select-job-assignee">
                <option value="">— pick —</option>
                {users?.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <Button size="sm" variant="outline" onClick={reassign} disabled={!newAssignee || busy} data-testid="button-job-reassign">Reassign</Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {!isClosed && job.status !== 'skipped' && (
            <Button size="sm" onClick={complete} disabled={busy} data-testid="button-job-complete">Mark complete</Button>
          )}
          {isCompleted && (
            <Button size="sm" variant="outline" onClick={undoComplete} disabled={busy} data-testid="button-job-uncomplete">Undo complete</Button>
          )}
          {!isClosed && (
            <Button size="sm" variant="destructive" onClick={cancel} disabled={busy} data-testid="button-job-cancel">Cancel job</Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose} className="ml-auto">Close</Button>
        </div>
      </div>
    </>
  );
}
