import { useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListClientActivity,
  useListClientNotes,
  useCreateClientNote,
  useUpdateClientNote,
  useListTickets,
  useCreateTicket,
  useUpdateTicket,
  useListClientPhotos,
  useUploadClientPhoto,
  useUpdatePhoto,
  useDeletePhoto,
  useListEstimates,
  useListUsers,
  getListClientNotesQueryKey,
  getListClientPhotosQueryKey,
  PhotoUploadInputContentType,
  type ActivityItem,
  type ClientNote,
  type JobPhoto,
  type JobPhotoKind,
  type Ticket,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { JobDetailDialog } from './jobs-panel';
import { format, parseISO, subDays, differenceInCalendarDays } from 'date-fns';
import {
  Activity, Briefcase, Camera, CheckCircle2, Circle, DollarSign, FileText, History, List, ListTodo,
  Mail, MoveHorizontal, Paperclip, Receipt, StickyNote, Trash2, Upload,
} from 'lucide-react';

/**
 * The bottom half of the customer's page, the way his old system laid it out:
 * the open estimates that still need chasing, then one Activity bar — every
 * visit, invoice, payment, email, estimate, ticket and note on one list with a
 * date range — with "Add a note" sitting right on top of it, then the tickets
 * and the photos for this customer. He reads a customer's whole story off this
 * one screen before he picks up the phone, so nothing here is hidden behind a
 * second click.
 */

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "Oct 3, 2026" from a yyyy-mm-dd, without the UTC-midnight day slip. */
const dayLabel = (d: string) => format(parseISO(d), 'MMM d, yyyy');
/**
 * The day an instant fell on here. Cutting the first ten characters off the
 * timestamp gives the UTC day, so an estimate emailed at 6 PM read "Sep 16"
 * next to a time that said "Sep 15, 6:00 PM" on the same screen.
 */
const instantDayLabel = (iso: string) => format(parseISO(iso), 'MMM d, yyyy');
const timeLabel = (iso: string) => format(parseISO(iso), 'MMM d, h:mm a');
const todayIso = () => format(new Date(), 'yyyy-MM-dd');

const selectClass = 'flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm';

function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'good' | 'bad' | 'warn' }) {
  const cls = {
    muted: 'bg-muted text-muted-foreground border-border',
    good: 'bg-primary/10 text-primary border-primary/20',
    bad: 'bg-destructive/10 text-destructive border-destructive/20',
    warn: 'bg-accent/20 text-accent-foreground border-accent/30',
  }[tone];
  return <span className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

export default function ClientActivityPanel({ clientId }: { clientId: number }) {
  return (
    <div className="space-y-8" data-testid="client-activity-panel">
      <OpenEstimatesCard clientId={clientId} />
      <ActivityTimelineCard clientId={clientId} />
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <ClientTicketsCard clientId={clientId} />
        <ClientPhotosCard clientId={clientId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open estimates
// ---------------------------------------------------------------------------

/**
 * "Open Estimates (1): #1840, 224 days, Sent, $0.00". The age is the whole
 * point — an estimate that has sat for months is either a phone call or a
 * decline, and he cannot see that on a list sorted by anything else.
 */
export function OpenEstimatesCard({ clientId }: { clientId: number }) {
  const { data: estimates, isLoading } = useListEstimates({ clientId });
  const open = useMemo(
    () => (estimates ?? []).filter(e => e.status === 'draft' || e.status === 'sent'),
    [estimates],
  );
  const closedCount = (estimates?.length ?? 0) - open.length;
  const today = new Date();

  return (
    <Card className="shadow-sm border-border" data-testid="client-open-estimates">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <FileText className="w-5 h-5 text-muted-foreground" /> Open Estimates ({open.length})
            {closedCount > 0 && (
              <Link href="/estimates" className="text-xs font-normal text-muted-foreground hover:underline">
                All ({estimates?.length})
              </Link>
            )}
          </CardTitle>
          <Link href={`/estimates?clientId=${clientId}&new=1`}>
            <Button size="sm" variant="outline" data-testid="button-add-estimate">Add an estimate</Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-4 text-sm text-muted-foreground animate-pulse">Loading estimates...</div>
        ) : open.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No open estimates{closedCount > 0 ? ` (${closedCount} accepted or declined)` : ''}.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left font-semibold px-4 py-2">Est #</th>
                <th className="text-left font-semibold px-4 py-2">Age</th>
                <th className="text-left font-semibold px-4 py-2">Stage</th>
                <th className="text-right font-semibold px-4 py-2">Value</th>
                <th className="text-left font-semibold px-4 py-2">Sent to</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {open.map(e => {
                const age = differenceInCalendarDays(today, parseISO(e.createdAt));
                return (
                  <tr key={e.id} className="hover:bg-muted/30" data-testid={`row-open-estimate-${e.id}`}>
                    <td className="px-4 py-2.5">
                      <Link href="/estimates" className="font-medium text-primary hover:underline">#{e.id}</Link>
                    </td>
                    {/* A month with no answer is when he normally follows up. */}
                    <td className={`px-4 py-2.5 whitespace-nowrap ${age > 30 ? 'text-destructive font-semibold' : ''}`}>
                      {age} {age === 1 ? 'day' : 'days'}
                    </td>
                    <td className="px-4 py-2.5"><Badge tone={e.status === 'sent' ? 'warn' : 'muted'}>{e.status === 'sent' ? 'Sent' : 'Draft'}</Badge></td>
                    <td className="px-4 py-2.5 text-right font-semibold whitespace-nowrap">{money(e.total)}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {e.sentToEmail ?? '—'}{e.sentAt ? ` · ${instantDayLabel(e.sentAt)}` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Activity timeline + notes
// ---------------------------------------------------------------------------

type TabKey = 'all' | 'past' | 'future' | 'events' | 'transactions' | 'estimates' | 'emails';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All history' },
  { key: 'past', label: 'Past visits' },
  { key: 'future', label: 'Future visits' },
  { key: 'events', label: 'Events' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'estimates', label: 'Estimates' },
  { key: 'emails', label: 'Emails' },
];

const OPEN_VISIT = new Set(['scheduled', 'on_the_way', 'in_progress']);

/**
 * A "future" visit is one still to be done, whatever its date: a job dated
 * last week that nobody finished is not history, it is late.
 */
function inTab(item: ActivityItem, tab: TabKey): boolean {
  switch (tab) {
    case 'all': return true;
    case 'past': return item.kind === 'visit' && !OPEN_VISIT.has(item.status ?? '');
    case 'future': return item.kind === 'visit' && OPEN_VISIT.has(item.status ?? '');
    case 'events': return item.kind === 'ticket' || item.kind === 'note' || item.kind === 'event';
    case 'transactions': return item.kind === 'invoice' || item.kind === 'payment';
    case 'estimates': return item.kind === 'estimate';
    case 'emails': return item.kind === 'email';
  }
}

const KIND_META: Record<ActivityItem['kind'], { label: string; icon: typeof Mail; className: string }> = {
  visit: { label: 'Visit', icon: Briefcase, className: 'bg-primary/10 text-primary' },
  invoice: { label: 'Invoice', icon: Receipt, className: 'bg-accent/20 text-accent-foreground' },
  payment: { label: 'Payment', icon: DollarSign, className: 'bg-primary/10 text-primary' },
  email: { label: 'Email', icon: Mail, className: 'bg-muted text-muted-foreground' },
  estimate: { label: 'Estimate', icon: FileText, className: 'bg-accent/20 text-accent-foreground' },
  ticket: { label: 'Ticket', icon: ListTodo, className: 'bg-accent/20 text-accent-foreground' },
  note: { label: 'Note', icon: StickyNote, className: 'bg-muted text-muted-foreground' },
  event: { label: 'Event', icon: History, className: 'bg-muted text-muted-foreground' },
};

function statusTone(status: string): 'muted' | 'good' | 'bad' | 'warn' {
  switch (status) {
    case 'opened': case 'completed': case 'paid': case 'accepted': case 'done': case 'closed': return 'good';
    case 'unopened': case 'failed': case 'cancelled': case 'declined': case 'void': case 'past_due': return 'bad';
    case 'open': case 'sent': case 'on_the_way': case 'in_progress': case 'skipped': return 'warn';
    default: return 'muted';
  }
}

const STATUS_LABEL: Record<string, string> = {
  on_the_way: 'On the way', in_progress: 'In progress', past_due: 'Past due', unopened: 'Not opened', opened: 'Opened',
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.replace(/_/g, ' ');

const LAYOUT_KEY = 'bison.client-activity.layout';
type Layout = 'list' | 'strip';
function readLayout(): Layout {
  try { return localStorage.getItem(LAYOUT_KEY) === 'strip' ? 'strip' : 'list'; } catch { return 'list'; }
}

/** Where a row takes him when he clicks it; null means there is nowhere to go. */
function itemHref(item: ActivityItem, clientId: number): string | null {
  switch (item.refKind) {
    case 'invoice': case 'payment': return `/invoices?clientId=${clientId}`;
    case 'estimate': return '/estimates';
    case 'ticket': return '/tickets';
    default: return null;
  }
}

export function ActivityTimelineCard({ clientId }: { clientId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<TabKey>('all');
  // Six months back is what his old screen opened on; blank "to" means "and
  // everything still coming", so future visits are on the list by default.
  const [from, setFrom] = useState(() => format(subDays(new Date(), 180), 'yyyy-MM-dd'));
  const [to, setTo] = useState('');
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [openJobId, setOpenJobId] = useState<number | null>(null);

  const { data: items, isLoading, isError } = useListClientActivity({ clientId, from, ...(to ? { to } : {}) });
  const { data: notes } = useListClientNotes(clientId);
  const updateNote = useUpdateClientNote();

  const counts = useMemo(() => {
    const all = items ?? [];
    return Object.fromEntries(TABS.map(t => [t.key, all.filter(i => inTab(i, t.key)).length])) as Record<TabKey, number>;
  }, [items]);
  const visible = useMemo(() => (items ?? []).filter(i => inTab(i, tab)), [items, tab]);
  const openNotes = useMemo(() => (notes ?? []).filter(n => n.status === 'open'), [notes]);

  const refreshNotes = () => {
    queryClient.invalidateQueries({ queryKey: getListClientNotesQueryKey(clientId) });
    queryClient.invalidateQueries({ queryKey: ['/api/client-activity'] });
    // The dashboard's open-notes list.
    queryClient.invalidateQueries({ queryKey: ['/api/notes/open'] });
  };

  const setNoteStatus = (noteId: number, status: 'open' | 'closed') => {
    updateNote.mutate({ id: noteId, data: { status } }, {
      onSuccess: () => { refreshNotes(); toast({ title: status === 'closed' ? 'Note closed' : 'Note reopened' }); },
      onError: (err: any) => toast({ title: 'Could not change the note', description: err?.data?.error ?? err?.message, variant: 'destructive' }),
    });
  };

  const chooseLayout = (next: Layout) => {
    setLayout(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* a private window forgets; fine */ }
  };

  const amountOf = (i: ActivityItem) => (i.amount != null ? money(i.amount) : null);

  return (
    <Card className="shadow-sm border-border" data-testid="client-activity-timeline">
      <CardHeader className="pb-3 border-b bg-card/50 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Activity className="w-5 h-5 text-muted-foreground" /> Activity
            {/* "Activity on account most recent to latest." It always came back
                newest first; saying so on the card is how he can tell at a
                glance that it is, instead of reading two dates to check. */}
            <span className="text-xs font-normal text-muted-foreground" data-testid="activity-order">Newest first</span>
            {openNotes.length > 0 && <Badge tone="warn">{openNotes.length} open {openNotes.length === 1 ? 'note' : 'notes'}</Badge>}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-40" data-testid="input-activity-from" />
            <span className="text-muted-foreground">to</span>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-40" placeholder="onward" data-testid="input-activity-to" />
            <div className="ml-2 inline-flex rounded-md border overflow-hidden">
              <button
                type="button"
                className={`px-2 py-1.5 ${layout === 'list' ? 'bg-muted' : 'hover:bg-muted/50'}`}
                title="Top to bottom"
                onClick={() => chooseLayout('list')}
                data-testid="button-activity-list"
              ><List className="w-4 h-4" /></button>
              <button
                type="button"
                className={`px-2 py-1.5 border-l ${layout === 'strip' ? 'bg-muted' : 'hover:bg-muted/50'}`}
                title="Side to side (recent activity in a row)"
                onClick={() => chooseLayout('strip')}
                data-testid="button-activity-strip"
              ><MoveHorizontal className="w-4 h-4" /></button>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {TABS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${tab === t.key ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted'}`}
              data-testid={`tab-activity-${t.key}`}
            >
              {t.label} ({counts[t.key] ?? 0})
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <NoteComposer clientId={clientId} onAdded={refreshNotes} />

        {openNotes.length > 0 && (
          <div className="rounded-lg border border-accent/40 bg-accent/10 p-3 space-y-2" data-testid="open-notes">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Still waiting on you</p>
            {openNotes.map(n => (
              <OpenNoteRow key={n.id} note={n} busy={updateNote.isPending} onClose={() => setNoteStatus(n.id, 'closed')} />
            ))}
          </div>
        )}

        {isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground animate-pulse">Loading activity...</div>
        ) : isError ? (
          <div className="py-6 text-center text-sm text-destructive">Activity could not be loaded.</div>
        ) : visible.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Nothing in this range.</div>
        ) : layout === 'strip' ? (
          <div className="flex gap-2 overflow-x-auto pb-2" data-testid="activity-strip">
            {visible.map(item => {
              const meta = KIND_META[item.kind];
              const Icon = meta.icon;
              const href = itemHref(item, clientId);
              const body = (
                <div className="w-44 shrink-0 rounded-lg border bg-card p-2.5 text-left hover:bg-muted/30 h-full">
                  <p className="text-[11px] text-muted-foreground">{dayLabel(item.date)}</p>
                  <p className={`mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${meta.className}`}>
                    <Icon className="w-3 h-3" /> {meta.label}
                  </p>
                  <p className="mt-1 text-sm font-medium line-clamp-2">{item.title}</p>
                  <p className="mt-1 flex items-center justify-between gap-1 text-xs">
                    {item.status ? <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge> : <span />}
                    {amountOf(item) && <span className="font-semibold">{amountOf(item)}</span>}
                  </p>
                </div>
              );
              const key = `${item.refKind}-${item.refId}`;
              if (item.refKind === 'job') return <button key={key} type="button" onClick={() => setOpenJobId(item.refId)}>{body}</button>;
              if (href) return <Link key={key} href={href}>{body}</Link>;
              return <div key={key}>{body}</div>;
            })}
          </div>
        ) : (
          <div className="divide-y" data-testid="activity-list">
            {visible.map(item => {
              const meta = KIND_META[item.kind];
              const Icon = meta.icon;
              const href = itemHref(item, clientId);
              const clickable = item.refKind === 'job' || href != null;
              const title = item.refKind === 'job'
                ? <button type="button" className="font-medium text-left hover:underline" onClick={() => setOpenJobId(item.refId)}>{item.title}</button>
                : href
                  ? <Link href={href} className="font-medium hover:underline">{item.title}</Link>
                  : <span className="font-medium">{item.title}</span>;
              return (
                <div key={`${item.refKind}-${item.refId}`} className={`flex gap-3 py-2.5 ${clickable ? 'hover:bg-muted/20' : ''}`} data-testid={`activity-${item.refKind}-${item.refId}`}>
                  <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.className}`} title={meta.label}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {title}
                      {item.status && <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>}
                      {item.refKind === 'note' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          disabled={updateNote.isPending}
                          onClick={() => setNoteStatus(item.refId, item.status === 'open' ? 'closed' : 'open')}
                          data-testid={`button-note-toggle-${item.refId}`}
                        >
                          {item.status === 'open' ? 'Close' : 'Reopen'}
                        </Button>
                      )}
                    </div>
                    {item.detail && <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{item.detail}</p>}
                    <p className="text-[11px] text-muted-foreground">
                      {item.at ? timeLabel(item.at) : dayLabel(item.date)}{item.actorName ? ` · ${item.actorName}` : ''}
                    </p>
                  </div>
                  {amountOf(item) && <div className="shrink-0 text-right text-sm font-semibold whitespace-nowrap">{amountOf(item)}</div>}
                </div>
              );
            })}
            {(items?.length ?? 0) >= 500 && (
              <p className="pt-3 text-xs text-muted-foreground">Showing the newest 500. Narrow the dates to see older rows.</p>
            )}
          </div>
        )}
      </CardContent>
      <JobDetailDialog jobId={openJobId} clientId={clientId} onClose={() => setOpenJobId(null)} />
    </Card>
  );
}

function OpenNoteRow({ note, busy, onClose }: { note: ClientNote; busy: boolean; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 text-sm" data-testid={`open-note-${note.id}`}>
      <Circle className="mt-1 w-3.5 h-3.5 shrink-0 text-accent-foreground" />
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap">{note.body}</p>
        <p className="text-[11px] text-muted-foreground">{note.authorName ?? 'Office'} · {timeLabel(note.createdAt)}</p>
      </div>
      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={onClose} data-testid={`button-close-note-${note.id}`}>
        <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Close
      </Button>
    </div>
  );
}

/**
 * "Add a Note..." with the open/closed choice next to it, the way his old
 * system asks. Closed is the default because most notes are just a record;
 * open is the one he needs to come back to, and it stays on the dashboard
 * until he closes it.
 */
function NoteComposer({ clientId, onAdded }: { clientId: number; onAdded: () => void }) {
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'open' | 'closed'>('closed');
  const createNote = useCreateClientNote();
  const { toast } = useToast();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    createNote.mutate({ id: clientId, data: { body: body.trim(), status } }, {
      onSuccess: () => { setBody(''); setStatus('closed'); onAdded(); toast({ title: status === 'open' ? 'Note added and left open' : 'Note added' }); },
      onError: (err: any) => toast({ title: 'Could not add the note', description: err?.data?.error ?? err?.message, variant: 'destructive' }),
    });
  };

  return (
    <form onSubmit={submit} className="rounded-lg border bg-muted/20 p-3 space-y-2" data-testid="note-composer">
      <Textarea
        placeholder="Add a note..."
        value={body}
        onChange={e => setBody(e.target.value)}
        className="min-h-16 bg-background"
        data-testid="input-note-body"
      />
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="text-xs font-semibold text-muted-foreground">Note status:</span>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="radio" name="note-status" checked={status === 'open'} onChange={() => setStatus('open')} data-testid="radio-note-open" /> Open (come back to it)
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="radio" name="note-status" checked={status === 'closed'} onChange={() => setStatus('closed')} data-testid="radio-note-closed" /> Closed
        </label>
        <Button type="submit" size="sm" className="ml-auto" disabled={!body.trim() || createNote.isPending} data-testid="button-add-note">
          {createNote.isPending ? 'Adding...' : 'Add'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/** Open first, soonest due at the top; done ones underneath, newest first. */
function sortTickets(rows: Ticket[]): Ticket[] {
  return [...rows].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    if (a.status === 'open') {
      const ad = a.dueDate ?? '9999-12-31';
      const bd = b.dueDate ?? '9999-12-31';
      if (ad !== bd) return ad < bd ? -1 : 1;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function ClientTicketsCard({ clientId }: { clientId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: tickets, isLoading, isError } = useListTickets({ clientId });
  const { data: users } = useListUsers();
  const updateTicket = useUpdateTicket();
  const createTicket = useCreateTicket();

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assignee, setAssignee] = useState('');

  const sorted = useMemo(() => sortTickets(tickets ?? []), [tickets]);
  const openCount = sorted.filter(t => t.status === 'open').length;
  const today = todayIso();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/tickets'] });
    queryClient.invalidateQueries({ queryKey: ['/api/client-activity'] });
  };

  const toggle = (t: Ticket) => {
    const status = t.status === 'open' ? 'done' : 'open';
    updateTicket.mutate({ id: t.id, data: { status } }, {
      onSuccess: () => { refresh(); toast({ title: status === 'done' ? 'Ticket done' : 'Ticket reopened' }); },
      onError: (err: any) => toast({ title: 'Could not change the ticket', description: err?.data?.error ?? err?.message, variant: 'destructive' }),
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    createTicket.mutate({
      data: {
        clientId,
        title: title.trim(),
        description: description.trim() || undefined,
        dueDate: dueDate || null,
        assignedToId: assignee ? Number(assignee) : null,
      },
    }, {
      onSuccess: () => {
        refresh();
        setTitle(''); setDescription(''); setDueDate(''); setAssignee(''); setAdding(false);
        toast({ title: 'Ticket added' });
      },
      onError: (err: any) => toast({ title: 'Ticket could not be added', description: err?.data?.error ?? err?.message, variant: 'destructive' }),
    });
  };

  return (
    <Card className="shadow-sm border-border" data-testid="client-tickets">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <ListTodo className="w-5 h-5 text-muted-foreground" /> Tickets
            {openCount > 0 && <Badge tone="warn">{openCount} open</Badge>}
          </CardTitle>
          <Button size="sm" variant={adding ? 'ghost' : 'outline'} onClick={() => setAdding(a => !a)} data-testid="button-add-ticket">
            {adding ? 'Cancel' : 'Add a ticket'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-4 space-y-3">
        {adding && (
          <form onSubmit={submit} className="rounded-lg border bg-muted/20 p-3 space-y-2" data-testid="ticket-form">
            <Input placeholder="What needs doing?" value={title} onChange={e => setTitle(e.target.value)} required data-testid="input-ticket-title" />
            <Textarea placeholder="Details (optional)" value={description} onChange={e => setDescription(e.target.value)} className="min-h-14 bg-background" data-testid="input-ticket-description" />
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="mb-1 block text-xs font-medium">Due</label>
                <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="w-40" data-testid="input-ticket-due" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium">For</label>
                <select className={`${selectClass} w-44`} value={assignee} onChange={e => setAssignee(e.target.value)} data-testid="select-ticket-assignee">
                  <option value="">Nobody yet</option>
                  {users?.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
              <Button type="submit" size="sm" className="ml-auto" disabled={!title.trim() || createTicket.isPending} data-testid="button-save-ticket">
                {createTicket.isPending ? 'Adding...' : 'Add ticket'}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">A ticket with a due date and a person shows on the dispatch board that day.</p>
          </form>
        )}
        {isLoading ? (
          <div className="text-sm text-muted-foreground animate-pulse">Loading tickets...</div>
        ) : isError ? (
          <div className="text-sm text-destructive">Tickets could not be loaded.</div>
        ) : sorted.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">No tickets for this customer.</div>
        ) : (
          <div className="divide-y">
            {sorted.map(t => {
              const late = t.status === 'open' && !!t.dueDate && t.dueDate < today;
              return (
                <div key={t.id} className="flex items-start gap-3 py-2.5" data-testid={`ticket-${t.id}`}>
                  <button
                    type="button"
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary"
                    title={t.status === 'open' ? 'Mark done' : 'Reopen'}
                    disabled={updateTicket.isPending}
                    onClick={() => toggle(t)}
                    data-testid={`button-ticket-toggle-${t.id}`}
                  >
                    {t.status === 'done' ? <CheckCircle2 className="w-5 h-5 text-primary" /> : <Circle className="w-5 h-5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium ${t.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>{t.title}</p>
                    {t.description && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{t.description}</p>}
                    <p className="text-[11px] text-muted-foreground">
                      {t.dueDate ? <span className={late ? 'text-destructive font-semibold' : ''}>Due {dayLabel(t.dueDate)}{late ? ' (late)' : ''}</span> : 'No due date'}
                      {t.assignedToName ? ` · ${t.assignedToName}` : ' · nobody assigned'}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Photos and attachments
// ---------------------------------------------------------------------------

/** Longest edge, in pixels, a photo is shrunk to before it is uploaded. */
const MAX_PHOTO_EDGE = 1600;
/** Mirrors the server's limit so the office hears "too big" before the upload, not after. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function isStorableType(type: string): type is PhotoUploadInputContentType {
  return Object.prototype.hasOwnProperty.call(PhotoUploadInputContentType, type);
}

/**
 * Same shrink the crew's phone does (my-jobs.tsx): a photo a sub texted in and
 * the office drags onto the account is still a multi-megabyte camera shot,
 * and he has ten gigabytes of these in his old system. A PDF goes up as is.
 * If the browser cannot re-encode the image the original bytes go up
 * unchanged, so a working upload never depends on the resize.
 */
async function toUploadPayload(file: File): Promise<{ contentType: PhotoUploadInputContentType; dataBase64: string }> {
  if (file.type === 'application/pdf') {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is over the 15 MB limit`);
    return { contentType: 'application/pdf', dataBase64: await readAsBase64(file) };
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.82));
    if (!blob) throw new Error('encode failed');
    return { contentType: 'image/jpeg', dataBase64: await readAsBase64(blob) };
  } catch {
    if (!isStorableType(file.type)) throw new Error(`${file.name}: only JPG, PNG, WEBP or PDF can be saved`);
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is over the 15 MB limit`);
    return { contentType: file.type, dataBase64: await readAsBase64(file) };
  }
}

const KIND_LABEL: Record<JobPhotoKind, string> = { before: 'Before', after: 'After', other: 'Other' };
type PhotoFilter = 'all' | JobPhotoKind | 'files';

export function ClientPhotosCard({ clientId }: { clientId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: photos, isLoading, isError } = useListClientPhotos(clientId);
  const upload = useUploadClientPhoto();
  const relabel = useUpdatePhoto();
  const remove = useDeletePhoto();

  const [filter, setFilter] = useState<PhotoFilter>('all');
  const [kind, setKind] = useState<JobPhotoKind>('other');
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(0);
  const [viewing, setViewing] = useState<JobPhoto | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListClientPhotosQueryKey(clientId) });
    queryClient.invalidateQueries({ queryKey: ['/api/client-activity'] });
  };

  const isFile = (p: JobPhoto) => p.contentType === 'application/pdf';
  const visible = useMemo(() => {
    const all = photos ?? [];
    if (filter === 'all') return all;
    if (filter === 'files') return all.filter(isFile);
    return all.filter(p => !isFile(p) && p.kind === filter);
  }, [photos, filter]);
  const pictures = visible.filter(p => !isFile(p));
  const files = visible.filter(isFile);

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const chosen = Array.from(list);
    setUploading(chosen.length);
    let ok = 0;
    for (const file of chosen) {
      try {
        const payload = await toUploadPayload(file);
        await upload.mutateAsync({ id: clientId, data: { ...payload, kind, caption: caption.trim() || null } });
        ok += 1;
      } catch (err: any) {
        toast({ title: `${file.name} was not saved`, description: err?.data?.error ?? err?.message, variant: 'destructive' });
      } finally {
        setUploading(n => n - 1);
      }
    }
    if (ok > 0) {
      refresh();
      setCaption('');
      toast({ title: ok === 1 ? 'Saved to the customer' : `${ok} files saved to the customer` });
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  const changeKind = (photo: JobPhoto, next: JobPhotoKind) => {
    relabel.mutate({ id: photo.id, data: { kind: next } }, {
      onSuccess: (updated) => { refresh(); setViewing(v => (v && v.id === updated.id ? updated : v)); },
      onError: (err: any) => toast({ title: 'Could not relabel', description: err?.data?.error ?? err?.message, variant: 'destructive' }),
    });
  };

  const deletePhoto = (photo: JobPhoto) => {
    if (!window.confirm(isFile(photo) ? 'Delete this file from the customer?' : 'Delete this photo from the customer?')) return;
    remove.mutate({ id: photo.id }, {
      onSuccess: () => { refresh(); setViewing(null); toast({ title: 'Deleted' }); },
      onError: (err: any) => toast({ title: 'Could not delete', description: err?.data?.error ?? err?.message, variant: 'destructive' }),
    });
  };

  const filters: { key: PhotoFilter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'before', label: 'Before' }, { key: 'after', label: 'After' }, { key: 'other', label: 'Other' }, { key: 'files', label: 'Files' },
  ];

  return (
    <Card className="shadow-sm border-border" data-testid="client-photos">
      <CardHeader className="pb-3 border-b bg-card/50 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Camera className="w-5 h-5 text-muted-foreground" /> Photos &amp; files
            {(photos?.length ?? 0) > 0 && <span className="text-sm font-normal text-muted-foreground">({photos?.length})</span>}
          </CardTitle>
          <div className="flex flex-wrap gap-1">
            {filters.map(f => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`rounded-md px-2 py-1 text-xs font-semibold ${filter === f.key ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted'}`}
                data-testid={`filter-photos-${f.key}`}
              >{f.label}</button>
            ))}
          </div>
        </div>
        {/* The label is chosen before the picker opens, like the crew's three
            camera buttons, so nobody answers a prompt per file. */}
        <div className="flex flex-wrap items-center gap-2">
          <select className={`${selectClass} w-28`} value={kind} onChange={e => setKind(e.target.value as JobPhotoKind)} data-testid="select-upload-kind">
            <option value="before">Before</option>
            <option value="after">After</option>
            <option value="other">Other</option>
          </select>
          <Input placeholder="Caption (optional)" value={caption} onChange={e => setCaption(e.target.value)} className="w-52" data-testid="input-upload-caption" />
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            className="hidden"
            onChange={e => void onFiles(e.target.files)}
            data-testid="input-upload-files"
          />
          <Button size="sm" onClick={() => inputRef.current?.click()} disabled={uploading > 0} data-testid="button-upload-photos">
            <Upload className="w-4 h-4 mr-1" /> {uploading > 0 ? `Saving ${uploading}...` : 'Add photos or files'}
          </Button>
          <span className="text-[11px] text-muted-foreground">JPG, PNG, WEBP or PDF, up to 15 MB each.</span>
        </div>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground animate-pulse">Loading photos...</div>
        ) : isError ? (
          <div className="text-sm text-destructive">Photos could not be loaded.</div>
        ) : visible.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            {filter === 'all' ? 'Nothing saved to this customer yet. Photos the crew takes on a job show up here too.' : 'Nothing with this label.'}
          </div>
        ) : (
          <>
            {pictures.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="photo-grid">
                {pictures.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setViewing(p)}
                    className="relative aspect-square overflow-hidden rounded-md border bg-muted"
                    data-testid={`photo-${p.id}`}
                  >
                    <img src={p.url} alt={p.caption ?? p.kind} className="h-full w-full object-cover" loading="lazy" />
                    <span className="absolute bottom-0 left-0 right-0 bg-black/55 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white text-left">
                      {KIND_LABEL[p.kind]}{p.jobId ? ` · job #${p.jobId}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {files.length > 0 && (
              <div className="divide-y rounded-md border" data-testid="file-list">
                {files.map(f => (
                  <div key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm" data-testid={`file-${f.id}`}>
                    <Paperclip className="w-4 h-4 shrink-0 text-muted-foreground" />
                    <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-medium text-primary hover:underline">
                      {f.caption || `PDF from ${instantDayLabel(f.takenAt)}`}
                    </a>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{Math.max(1, Math.round(f.byteSize / 1024))} KB · {f.uploadedByName ?? 'Office'}</span>
                    <button type="button" className="text-muted-foreground hover:text-destructive" title="Delete" onClick={() => deletePhoto(f)} data-testid={`button-delete-file-${f.id}`}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={viewing != null} onOpenChange={o => { if (!o) setViewing(null); }}>
        <DialogContent className="max-w-3xl">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-3">
                  <span>{viewing.caption || KIND_LABEL[viewing.kind]}</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {timeLabel(viewing.takenAt)} · {viewing.uploadedByName ?? 'Office'}{viewing.jobId ? ` · job #${viewing.jobId}` : ' · saved to the account'}
                  </span>
                </DialogTitle>
              </DialogHeader>
              <img src={viewing.url} alt={viewing.caption ?? viewing.kind} className="max-h-[65vh] w-full rounded-md object-contain bg-muted" />
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs font-semibold text-muted-foreground">Label</label>
                <select className={`${selectClass} w-28`} value={viewing.kind} onChange={e => changeKind(viewing, e.target.value as JobPhotoKind)} disabled={relabel.isPending} data-testid="select-photo-kind">
                  <option value="before">Before</option>
                  <option value="after">After</option>
                  <option value="other">Other</option>
                </select>
                <a href={viewing.url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">Open full size</a>
                <Button size="sm" variant="destructive" className="ml-auto" disabled={remove.isPending} onClick={() => deletePhoto(viewing)} data-testid="button-delete-photo">
                  <Trash2 className="w-4 h-4 mr-1" /> Delete
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
