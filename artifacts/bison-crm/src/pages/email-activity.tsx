import { useEffect, useMemo, useState } from 'react';
import { Link, useRoute } from 'wouter';
import { format } from 'date-fns';
import {
  useGetEmailActivitySummary,
  useGetEmailBatch,
  useGetEmailBatchOverview,
  useListEmailBatches,
  type EmailBatch,
  type EmailBatchRecipient,
} from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/lib/access';
import {
  ArrowLeft, ChevronRight, Inbox, Mail, MailCheck, MailWarning, Search, Send, SkipForward,
} from 'lucide-react';

/**
 * Email Activity. His words for why this screen exists: "out of the 30 emails
 * that were sent, 30 were delivered and 21 were opened. That's very, very
 * good data for me." It was the one screen in his old system he called huge,
 * and he wants it in one place — not one customer's account at a time.
 */

/** Mirrors SOURCE_LABELS on the server; it is the filter he picks from. */
const SOURCES: { value: string; label: string }[] = [
  { value: 'dispatch', label: 'Dispatch board' },
  { value: 'waiting_list', label: 'Waiting list' },
  { value: 'client_page', label: 'Client page' },
  { value: 'automation', label: 'Automation' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'estimate', label: 'Estimate' },
  { value: 'letter', label: 'Spring letter' },
  { value: 'crew', label: 'Crew on the way' },
];

const WINDOWS: { days: number; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
  { days: 3650, label: 'Everything' },
];

const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm';

const when = (iso: string) => format(new Date(iso), "d MMM yyyy 'at' h:mm a");
const shortWhen = (iso: string) => format(new Date(iso), 'd MMM h:mm a');

function percent(part: number, whole: number): string {
  if (!whole) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

/** What a batch was: the document if it had one, else the rule, else the subject. */
function batchName(b: EmailBatch): string {
  return b.templateName ?? b.ruleName ?? b.subject ?? '(no subject)';
}

export default function EmailActivity() {
  const [, params] = useRoute('/email-activity/:batchId');
  const batchId = params?.batchId ?? null;
  return batchId ? <BatchResults batchId={decodeURIComponent(batchId)} /> : <BatchList />;
}

// ------------------------------------------------------------------ the list --

function BatchList() {
  const [days, setDays] = useState(30);
  const [source, setSource] = useState('');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  // Off to start with. This screen is about the sends that went out together;
  // the one-off bills are here when he wants them and out of the way when he
  // is reading a letter's results.
  const [includeSingles, setIncludeSingles] = useState(false);

  // A beat behind what he types, so a four-letter document name is one request
  // instead of four.
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const summary = useGetEmailActivitySummary({ days });
  const batches = useListEmailBatches({
    limit: 200,
    ...(source ? { source } : {}),
    ...(q ? { q } : {}),
    ...(includeSingles ? { includeSingles: true } : {}),
  });
  const rows = batches.data ?? [];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Inbox className="w-7 h-7 text-primary" /> Email Activity
        </h1>
        <p className="text-muted-foreground mt-1">
          Every batch of email the app has sent, newest first — from the dispatch board, the waiting list, a customer's
          page, an invoice, an estimate, a spring letter or an automation. Click a line to see exactly who it went to,
          their address, and who has opened it.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select className={selectClass} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="How far back the totals count">
          {WINDOWS.map((w) => <option key={w.days} value={w.days}>{w.label}</option>)}
        </select>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8 w-64"
            placeholder="Find a document or an automation"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <select className={selectClass} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Where it was sent from">
          <option value="">Sent from anywhere</option>
          {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={includeSingles}
            onChange={(e) => setIncludeSingles(e.target.checked)}
          />
          Include emails sent to one customer on their own
        </label>
      </div>

      <Totals summary={summary.data} loading={summary.isLoading} days={days} />

      <p className="text-xs text-muted-foreground">
        "Opened" means the pictures in the email were loaded at least once. Gmail and Apple Mail sometimes load them
        before anyone reads a word, and a phone set to block pictures never loads them at all — so treat "not opened
        yet" as "we have not heard back from their mail program", not as "they ignored you".
      </p>

      {batches.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : !rows.length ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {q || source
              ? 'Nothing matches that. Clear the search or pick "Sent from anywhere".'
              : 'No sends that went out together yet. Tick the box above to see emails that went to one customer on their own, or send a document from the board, a customer’s page or an invoice and the batch shows up here.'}
          </CardContent>
        </Card>
      ) : (
        <div className="bg-card border rounded-lg divide-y overflow-hidden">
          <div className="hidden md:grid grid-cols-[10rem_1fr_9rem_5rem_5rem_5rem_7rem_1.5rem] gap-2 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <span>When</span><span>Document</span><span>Sent from</span>
            <span className="text-right">Sent</span><span className="text-right">Failed</span><span className="text-right">Skipped</span>
            <span className="text-right">Opened</span><span />
          </div>
          {rows.map((b) => (
            <Link
              key={b.batchId}
              href={`/email-activity/${encodeURIComponent(b.batchId)}`}
              className="block px-3 py-2 hover:bg-muted/40 grid grid-cols-1 md:grid-cols-[10rem_1fr_9rem_5rem_5rem_5rem_7rem_1.5rem] gap-x-2 gap-y-1 items-center text-sm"
            >
              <span className="text-muted-foreground">{shortWhen(b.createdAt)}</span>
              <span className="min-w-0">
                <span className="font-medium truncate block" title={b.subject ?? ''}>{batchName(b)}</span>
                {b.ruleName && b.templateName && b.ruleName !== b.templateName ? (
                  <span className="text-xs text-muted-foreground">by the "{b.ruleName}" automation</span>
                ) : null}
              </span>
              <span className="text-muted-foreground truncate">
                {b.sourceLabel}
                {b.single ? <span className="text-xs"> · on its own</span> : null}
                {b.sentByName ? <span className="block text-xs">{b.sentByName}</span> : null}
              </span>
              <span className="md:text-right">
                <span className="md:hidden text-muted-foreground">Sent </span>
                <span className="font-semibold">{b.sent}</span>
                <span className="text-muted-foreground"> of {b.total}</span>
              </span>
              <span className={`md:text-right ${b.failed ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
                <span className="md:hidden">Failed </span>{b.failed}
              </span>
              <span className="md:text-right text-muted-foreground">
                <span className="md:hidden">Skipped </span>{b.skipped}
              </span>
              <span className={`md:text-right ${b.opened ? 'text-primary font-semibold' : 'text-muted-foreground'}`}>
                <span className="md:hidden">Opened </span>{b.opened}
                {/* Out of the ones that carried a pixel, not out of everything
                    that went: the crew's "on my way" notice has no pixel, so
                    counting it here read as nobody opening anything. */}
                <span className="font-normal text-muted-foreground"> ({percent(b.opened, b.trackable)})</span>
              </span>
              <ChevronRight className="hidden md:block w-4 h-4 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
      {rows.length >= 200 ? (
        <p className="text-xs text-muted-foreground">Showing the newest 200 batches. Use the search to find an older one.</p>
      ) : null}

      <MarketingLinks />
    </div>
  );
}

/**
 * In his old system this screen lived in a Marketing menu with the
 * automations, the letter templates and the web form, and he moved between
 * them all day. Our sidebar is one flat list, so the rest of that drawer sits
 * at the bottom of the results he just read — a link he cannot open is not
 * shown, same rule as the sidebar.
 */
function MarketingLinks() {
  const documents = useCan('documents');
  const settings = useCan('settings');
  const clients = useCan('clients');
  const links = [
    { href: '/spring-letters', label: 'Spring letters', hint: 'pick who gets one and send the batch', show: documents },
    { href: '/automation', label: 'Automations', hint: 'the rules that send on their own', show: settings },
    { href: '/settings', label: 'Documents and templates', hint: 'the wording of every letter and bill', show: settings },
    { href: '/web-requests', label: 'Web requests', hint: 'what came in off the website form', show: clients },
  ].filter((l) => l.show);
  if (!links.length) return null;
  return (
    <div className="pt-2 border-t">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">The rest of the marketing side</p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="text-primary hover:underline">
            {l.label} <span className="text-muted-foreground text-xs">— {l.hint}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Totals({ summary, loading, days }: { summary?: { batches: number; singles: number; total: number; sent: number; failed: number; skipped: number; opened: number; trackable: number }; loading: boolean; days: number }) {
  const label = WINDOWS.find((w) => w.days === days)?.label ?? `Last ${days} days`;
  if (loading || !summary) {
    return <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;
  }
  const tiles = [
    {
      label: 'Batches',
      value: String(summary.batches),
      hint: summary.singles
        ? `${label.toLowerCase()}, plus ${summary.singles} sent on their own`
        : label.toLowerCase(),
      icon: Inbox,
    },
    { label: 'Sent', value: `${summary.sent} of ${summary.total}`, hint: 'the mail server took them', icon: Send },
    // The percent is out of the emails that carried a pixel, because an email
    // sent without one can never come back opened — counting those made the
    // open rate read as almost nothing.
    {
      label: 'Opened',
      value: `${summary.opened} (${percent(summary.opened, summary.trackable)})`,
      hint: summary.sent > summary.trackable
        ? `out of the ${summary.trackable} we can ask about`
        : 'pictures loaded at least once',
      icon: MailCheck,
    },
    { label: 'Failed or skipped', value: `${summary.failed + summary.skipped}`, hint: `${summary.failed} failed, ${summary.skipped} skipped`, icon: MailWarning },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {tiles.map((t) => (
        <Card key={t.label}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </div>
            <div className="text-2xl font-bold mt-1">{t.value}</div>
            <div className="text-xs text-muted-foreground">{t.hint}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// --------------------------------------------------------------- one batch ---

function BatchResults({ batchId }: { batchId: string }) {
  const overview = useGetEmailBatchOverview(batchId);
  const recipients = useGetEmailBatch(batchId);
  const rows = recipients.data ?? [];

  const [show, setShow] = useState<'all' | 'opened' | 'not_opened' | 'problem'>('all');
  const shown = useMemo(() => rows.filter((r) => {
    if (show === 'opened') return !!r.openedAt;
    // Only the ones we actually asked about. An email with no pixel in it is
    // not somebody who has not opened it — it is one we cannot know about.
    if (show === 'not_opened') return r.status === 'sent' && r.trackable && !r.openedAt;
    if (show === 'problem') return r.status === 'failed' || r.status === 'skipped';
    return true;
  }), [rows, show]);

  const notFound = overview.isError || recipients.isError;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <Link href="/email-activity" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> All email activity
      </Link>

      {notFound ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          That send is not in the log any more.
        </CardContent></Card>
      ) : overview.isLoading || !overview.data ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <BatchHeader batch={overview.data} />
      )}

      {/* He can land straight on this page from a bookmark, so the honest
          caveat about opens has to be here too, not only on the list. */}
      <p className="text-xs text-muted-foreground">
        "Opened" means the pictures in the email were loaded at least once. Some mail programs load them before anyone
        reads a word and some never load them at all, so "not opened yet" means "their mail program has not told us",
        not "they ignored you".
      </p>

      <div className="flex flex-wrap gap-2">
        {([
          ['all', `Everyone (${rows.length})`],
          ['opened', `Opened (${rows.filter((r) => r.openedAt).length})`],
          ['not_opened', `Not opened yet (${rows.filter((r) => r.status === 'sent' && r.trackable && !r.openedAt).length})`],
          ['problem', `Failed or skipped (${rows.filter((r) => r.status !== 'sent').length})`],
        ] as const).map(([value, label]) => (
          <Button key={value} size="sm" variant={show === value ? 'default' : 'outline'} onClick={() => setShow(value)}>
            {label}
          </Button>
        ))}
      </div>

      {recipients.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : !shown.length ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Nobody in this list.</CardContent></Card>
      ) : (
        <div className="bg-card border rounded-lg divide-y">
          <div className="hidden md:grid grid-cols-[1fr_1fr_9rem_1fr] gap-3 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <span>Customer</span><span>Where they are</span><span>Sent</span><span>Opened</span>
          </div>
          {shown.map((r) => <RecipientRow key={r.id} row={r} />)}
        </div>
      )}
    </div>
  );
}

function BatchHeader({ batch: b }: { batch: EmailBatch }) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{batchName(b)}</h1>
      <p className="text-sm text-muted-foreground mt-1">
        {b.single ? 'One email, sent' : 'Sent'} {when(b.createdAt)} from the {b.sourceLabel.toLowerCase()}
        {b.sentByName ? ` by ${b.sentByName}` : ''}
        {b.ruleName && b.ruleName !== b.templateName ? ` · automation "${b.ruleName}"` : ''}
      </p>
      {b.subject && b.subject !== batchName(b) ? (
        <p className="text-sm text-muted-foreground">Subject line: {b.subject}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <Badge variant="secondary">{b.sent} of {b.total} sent</Badge>
        <Badge variant={b.opened ? 'default' : 'outline'}>{b.opened} opened ({percent(b.opened, b.trackable)})</Badge>
        {b.failed ? <Badge variant="destructive">{b.failed} failed</Badge> : null}
        {b.skipped ? <Badge variant="outline">{b.skipped} skipped</Badge> : null}
      </div>
    </div>
  );
}

function RecipientRow({ row: r }: { row: EmailBatchRecipient }) {
  return (
    <div className="px-3 py-2 grid grid-cols-1 md:grid-cols-[1fr_1fr_9rem_1fr] gap-x-3 gap-y-1 items-start text-sm">
      <span className="min-w-0">
        {/* His "delivered opens up to customer account": the name is the way in. */}
        {r.clientId != null
          ? <Link href={`/clients/${r.clientId}`} className="font-medium text-primary hover:underline">{r.clientName}</Link>
          : <span className="font-medium">{r.clientName}</span>}
        <span className="block text-xs text-muted-foreground truncate">{r.toEmail ?? 'no email on file'}</span>
      </span>
      <span className="min-w-0 text-xs text-muted-foreground">
        {r.clientAddress ?? 'no address on file'}
        {r.clientPhone ? <span className="block">{r.clientPhone}</span> : null}
      </span>
      <span className="text-xs text-muted-foreground">
        {r.status === 'sent'
          ? (r.sentAt ? shortWhen(r.sentAt) : shortWhen(r.createdAt))
          : r.status === 'failed' ? 'did not go out' : 'left out'}
      </span>
      <span className="text-xs">
        {r.status === 'sent' && r.openedAt ? (
          <span className="text-primary font-semibold flex items-center gap-1">
            <MailCheck className="w-3.5 h-3.5 shrink-0" />
            {when(r.openedAt)}{r.openCount > 1 ? ` (${r.openCount} times)` : ''}
          </span>
        ) : r.status === 'sent' && !r.trackable ? (
          // This one went out without a pixel in it, so nothing can ever come
          // back about it. Saying "not opened yet" about it would be telling
          // him something about this customer that is simply not true.
          <span className="text-muted-foreground flex items-center gap-1">
            <Mail className="w-3.5 h-3.5 shrink-0" /> No read receipt on this one
          </span>
        ) : r.status === 'sent' ? (
          <span className="text-muted-foreground flex items-center gap-1">
            <Mail className="w-3.5 h-3.5 shrink-0" /> Not opened yet
          </span>
        ) : r.status === 'failed' ? (
          <span className="text-destructive font-semibold flex items-center gap-1" title={r.error ?? ''}>
            <MailWarning className="w-3.5 h-3.5 shrink-0" /> Failed{r.error ? `: ${r.error}` : ''}
          </span>
        ) : (
          <span className="text-muted-foreground flex items-center gap-1">
            <SkipForward className="w-3.5 h-3.5 shrink-0" />
            {r.skipReason === 'do_not_email'
              ? 'Skipped — marked do not email'
              : r.skipReason === 'no_email'
                ? 'Skipped — no email address on file'
                : 'Skipped'}
          </span>
        )}
      </span>
    </div>
  );
}
