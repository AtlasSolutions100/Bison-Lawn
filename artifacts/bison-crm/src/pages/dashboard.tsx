import { 
  useGetDashboardSummary, 
  useGetContractorEarnings,
  useGetRecentActivity,
  AuditEvent
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Briefcase, Receipt, Ticket, Leaf, CalendarClock, MailWarning } from 'lucide-react';
import { format } from 'date-fns';
import { Link } from 'wouter';

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

      {/* Top Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Jobs Today" value={s.jobsToday} icon={Briefcase} subtitle={`${s.jobsCompletedToday} completed`} />
        <StatCard title="Open Invoices" value={`$${s.openInvoiceTotal.toLocaleString(undefined, {minimumFractionDigits: 2})}`} icon={Receipt} subtitle="Awaiting payment" />
        <StatCard title="Waiting List" value={s.waitingListCount} icon={CalendarClock} subtitle="Ready to dispatch" />
        <StatCard title="Open Tickets" value={s.openTickets} icon={Ticket} subtitle="Tasks needing attention" />
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <StatCard title="Total Clients" value={s.clientCount} icon={Users} subtitle={`${s.leadCount} active leads`} />
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

function StatCard({ title, value, icon: Icon, subtitle, className = "" }: any) {
  return (
    <Card className={`shadow-sm ${className}`}>
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
}
