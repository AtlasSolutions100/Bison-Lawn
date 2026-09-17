import {
  useGetDashboardSummary,
  useGetContractorEarnings,
  useGetRecentActivity,
  useGetDashboardAlerts,
  getGetDashboardAlertsQueryKey,
  useListOpenNotes,
  getListOpenNotesQueryKey,
  AuditEvent
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Briefcase, Receipt, Ticket, Leaf, CalendarClock, MailWarning, BellRing, FileCheck2, Globe, StickyNote, Send } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { Link } from 'wouter';

const money = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
const ago = (iso: string | null | undefined) => (iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : '');

/**
 * 2026-09-15 walkthrough: the things he wants to see the moment he sits down —
 * estimates accepted, invoices that went out today, new website requests,
 * emails that did not send, and notes left open for the office. A glance, not
 * an inbox: nothing is marked read, each line opens the place to deal with it,
 * and the panel refreshes itself while the tab is open.
 */
function AlertsPanel() {
  const alerts = useGetDashboardAlerts({
    query: { queryKey: getGetDashboardAlertsQueryKey(), refetchInterval: 60_000, retry: false },
  });
  // Open notes come from the customer-activity side of the app; if that
  // endpoint is not there, the section is simply left out.
  const notes = useListOpenNotes({
    query: { queryKey: getListOpenNotesQueryKey(), refetchInterval: 60_000, retry: false },
  });

  if (alerts.isLoading) {
    return <div className="text-sm text-muted-foreground animate-pulse">Checking what needs a look...</div>;
  }
  if (alerts.isError || !alerts.data) {
    return <div className="text-sm text-destructive">Could not load alerts.</div>;
  }
  const a = alerts.data;
  const openNotes = notes.isError ? [] : (notes.data ?? []);
  const total = a.estimatesAccepted.count + a.invoicesSentToday.count + a.webRequests.count + a.failedEmails.count + openNotes.length;
  if (total === 0) {
    return <div className="text-sm text-muted-foreground py-4 text-center" data-testid="alerts-empty">Nothing needs a look right now.</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {a.estimatesAccepted.count > 0 && (
        <AlertGroup icon={FileCheck2} title="Estimates accepted" count={a.estimatesAccepted.count} note="last 7 days" testId="alerts-estimates">
          {a.estimatesAccepted.items.map(e => (
            <AlertLine key={e.id} href={`/clients/${e.clientId}`} title={e.clientName} detail={`${money(e.total)} · ${ago(e.at)}`} />
          ))}
        </AlertGroup>
      )}
      {a.invoicesSentToday.count > 0 && (
        <AlertGroup icon={Send} title="Invoices sent today" count={a.invoicesSentToday.count} testId="alerts-invoices">
          {a.invoicesSentToday.items.map(i => (
            <AlertLine key={i.id} href={`/invoices?clientId=${i.clientId}`} title={`#${i.number} · ${i.clientName}`} detail={`${money(i.total)} · ${ago(i.at)}`} />
          ))}
        </AlertGroup>
      )}
      {a.webRequests.count > 0 && (
        <AlertGroup icon={Globe} title="New website requests" count={a.webRequests.count} testId="alerts-web-requests">
          {a.webRequests.items.map(w => (
            <AlertLine key={w.id} href="/web-requests" title={w.name ?? 'Someone'} detail={[w.address, w.message].filter(Boolean).join(' · ') || ago(w.at)} />
          ))}
        </AlertGroup>
      )}
      {a.failedEmails.count > 0 && (
        <AlertGroup icon={MailWarning} title="Emails that did not send" count={a.failedEmails.count} note="last 7 days" tone="destructive" testId="alerts-failed-emails">
          {a.failedEmails.items.map(f => (
            <AlertLine
              key={f.id}
              href={f.clientId != null ? `/clients/${f.clientId}` : '/reports'}
              title={f.clientName ?? f.toEmail ?? 'No address'}
              detail={[f.subject, f.error].filter(Boolean).join(' · ') || ago(f.at)}
            />
          ))}
        </AlertGroup>
      )}
      {openNotes.length > 0 && (
        <AlertGroup icon={StickyNote} title="Open notes" count={openNotes.length} note="oldest first" testId="alerts-open-notes">
          {openNotes.slice(0, 8).map(n => (
            <AlertLine key={n.id} href={`/clients/${n.clientId}`} title={n.clientName ?? `Customer #${n.clientId}`} detail={n.body} />
          ))}
        </AlertGroup>
      )}
    </div>
  );
}

function AlertGroup({ icon: Icon, title, count, note, tone, testId, children }: {
  icon: typeof BellRing; title: string; count: number; note?: string; tone?: 'destructive'; testId: string; children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border p-3 ${tone === 'destructive' ? 'border-destructive/30 bg-destructive/5' : 'bg-card'}`} data-testid={testId}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${tone === 'destructive' ? 'text-destructive' : 'text-primary'}`} />
        <span className="font-semibold text-sm">{title}</span>
        <span className="ml-auto rounded-full bg-primary/10 text-primary text-xs font-bold px-2 py-0.5 tabular-nums">{count}</span>
      </div>
      <div className="space-y-1">{children}</div>
      {note && <p className="mt-2 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function AlertLine({ href, title, detail }: { href: string; title: string; detail: string }) {
  return (
    <Link href={href} className="block rounded-md px-2 py-1.5 -mx-1 hover:bg-muted/60 transition-colors">
      <div className="text-sm font-medium truncate">{title}</div>
      {detail && <div className="text-xs text-muted-foreground truncate">{detail}</div>}
    </Link>
  );
}

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  
  // Today's date for contractor earnings
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data: earnings, isLoading: isLoadingEarnings } = useGetContractorEarnings({ date: today });
  
  const { data: activity, isLoading: isLoadingActivity } = useGetRecentActivity();

  if (isLoadingSummary) {
    return <div className="p-8">Loading dashboard...</div>;
  }

  const s = summary!;

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Operations Dashboard</h1>
        <p className="text-muted-foreground mt-1">Overview of your business for today, {format(new Date(), 'MMMM d, yyyy')}</p>
      </div>

      {/* Customer messages whose delivery never completed — nobody knows if
          these customers were told, so surface them without a queue visit. */}
      {s.interruptedMessageCount > 0 && (
        <Link
          href="/automation"
          className="block rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive transition-colors hover:bg-destructive/15"
          data-testid="link-interrupted-messages"
        >
          <div className="flex items-center gap-3">
            <MailWarning className="w-5 h-5 shrink-0" />
            <div>
              <p className="font-bold">
                {s.interruptedMessageCount} customer {s.interruptedMessageCount === 1 ? 'message' : 'messages'} never finished sending
              </p>
              <p className="text-sm mt-0.5">
                Delivery was interrupted and no outcome was recorded. Assume these customers were not notified — review them in Automation Review.
              </p>
            </div>
          </div>
        </Link>
      )}

      <Card className="shadow-sm" data-testid="alerts-panel">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <BellRing className="w-5 h-5 text-primary" /> Needs a look
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AlertsPanel />
        </CardContent>
      </Card>

      {/* Top Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard href="/dispatch" title="Jobs Today" value={s.jobsToday} icon={Briefcase} subtitle={`${s.jobsCompletedToday} completed`} />
        <StatCard href="/invoices" title="Open Invoices" value={`$${s.openInvoiceTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}`} icon={Receipt} subtitle="Awaiting payment" />
        <StatCard href="/waiting-list" title="Waiting List" value={s.waitingListCount} icon={CalendarClock} subtitle="Ready to dispatch" />
        <StatCard href="/tickets" title="Open Tickets" value={s.openTickets} icon={Ticket} subtitle="Tasks needing attention" />
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <StatCard href="/clients" title="Total Clients" value={s.clientCount} icon={Users} subtitle={`${s.leadCount} active leads`} />
        <StatCard title="Revenue (MTD)" value={`$${s.revenueThisMonth.toLocaleString(undefined, {minimumFractionDigits: 2})}`} icon={Leaf} subtitle="Month to date" className="lg:col-span-3 bg-primary/5 border-primary/20" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Contractor Earnings */}
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Contractor Earnings (Today)</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingEarnings ? (
              <div className="text-sm text-muted-foreground animate-pulse">Loading earnings...</div>
            ) : !earnings?.length ? (
              <div className="text-sm text-muted-foreground py-4 text-center">No completed jobs today.</div>
            ) : (
              <div className="space-y-4">
                {earnings.map((e) => (
                  <div key={e.contractorId} className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
                    <div>
                      <div className="font-semibold text-foreground">{e.contractorName}</div>
                      <div className="text-xs text-muted-foreground">{e.jobCount} jobs completed</div>
                    </div>
                    <div className="font-bold text-lg text-primary">
                      ${e.totalAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px] overflow-y-auto pr-2">
            {isLoadingActivity ? (
              <div className="text-sm text-muted-foreground animate-pulse">Loading activity...</div>
            ) : !activity?.length ? (
              <div className="text-sm text-muted-foreground text-center py-4">No recent activity.</div>
            ) : (
              <div className="space-y-4 relative before:absolute before:inset-0 before:ml-2 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-300 before:to-transparent">
                {activity.map((a: AuditEvent) => (
                  <div key={a.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                    <div className="flex items-center justify-center w-6 h-6 rounded-full border border-white bg-slate-300 group-[.is-active]:bg-primary group-[.is-active]:text-white shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10">
                      <div className="w-2 h-2 rounded-full bg-white"></div>
                    </div>
                    
                    <div className="w-[calc(100%-3rem)] md:w-[calc(50%-1.5rem)] bg-card border rounded-lg p-3 shadow-sm">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-sm text-foreground">{a.action}</span>
                        <time className="text-xs text-muted-foreground font-medium">{format(new Date(a.createdAt), 'MMM d, h:mm a')}</time>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {a.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Every tile answers a question you then want to act on — "twelve jobs today"
// is followed by wanting to see them. `href` makes the whole tile the link
// rather than a small "view" affordance, because the number is what the eye
// lands on and therefore what the hand goes for.
// `className` carries grid positioning (Revenue spans three columns), so it has
// to sit on whichever element is the grid child — the link when there is one,
// the card otherwise. Applying it to both would put a column span on an element
// that is no longer in the grid.
function StatCard({ title, value, icon: Icon, subtitle, className = "", href }: any) {
  const card = (
    <Card className={`shadow-sm ${href ? 'h-full transition-colors hover:border-primary/40 hover:bg-primary/5' : className}`}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <h3 className="text-3xl font-bold text-foreground mt-1">{value}</h3>
          </div>
          <div className="w-12 h-12 bg-primary/10 text-primary rounded-xl flex items-center justify-center">
            <Icon className="w-6 h-6" />
          </div>
        </div>
        {subtitle && (
          <div className="mt-4 text-xs font-medium text-muted-foreground flex items-center">
            {subtitle}
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (!href) return card;
  return (
    <Link
      href={href}
      className={`block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
      data-testid={`link-stat-${String(title).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`}
    >
      {card}
    </Link>
  );
}
