import { useEffect, useMemo, useState } from 'react';
import {
  useGetQuickbooksStatus,
  useDisconnectQuickbooks,
  useGetQuickbooksProfitAndLoss,
  useGetQuickbooksExpenses,
  getGetQuickbooksStatusQueryKey,
  getGetQuickbooksProfitAndLossQueryKey,
  getGetQuickbooksExpensesQueryKey,
  type QuickbooksReport,
  type QuickbooksStatus,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, Link2, Link2Off, RefreshCw, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';

const today = () => new Date().toISOString().slice(0, 10);
const startOfYear = () => `${today().slice(0, 4)}-01-01`;

/**
 * What the OAuth callback redirected back with. Fixed codes only — the server
 * never echoes anything from Intuit's query string into this URL.
 */
const CALLBACK_OUTCOMES: Record<string, { title: string; body: string; bad: boolean }> = {
  connected: {
    title: 'QuickBooks connected',
    body: 'Your reports are below.',
    bad: false,
  },
  declined: {
    title: 'Not connected',
    body: 'QuickBooks did not grant access. Nothing was changed.',
    bad: true,
  },
  'state-mismatch': {
    title: 'That sign-in could not be verified',
    body: 'The reply from QuickBooks did not match the request this app sent, so it was ignored. Start again from Connect.',
    bad: true,
  },
  'invalid-callback': {
    title: 'That sign-in could not be completed',
    body: 'QuickBooks came back without the details needed to finish. Start again from Connect.',
    bad: true,
  },
  'not-configured': {
    title: 'This server is not set up for QuickBooks',
    body: 'The Intuit credentials are missing, so the connection could not be finished.',
    bad: true,
  },
  'exchange-failed': {
    title: 'QuickBooks would not finish the connection',
    body: 'The authorisation could not be exchanged for access. Try Connect again.',
    bad: true,
  },
};

export default function Books() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const statusQuery = useGetQuickbooksStatus();
  const status = statusQuery.data;

  const [from, setFrom] = useState(startOfYear);
  const [to, setTo] = useState(today);
  // Applied separately so typing a date does not fire a report request per
  // keystroke against a rate-limited API.
  const [range, setRange] = useState(() => ({ from: startOfYear(), to: today() }));

  // Read once: the outcome belongs to this page load, and the query string is
  // cleared straight away so a refresh does not replay the banner.
  const [outcome] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('quickbooks');
  });

  useEffect(() => {
    if (!outcome || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('quickbooks');
    window.history.replaceState({}, '', url.toString());
  }, [outcome]);

  const connected = status?.connected === true;

  const profitAndLoss = useGetQuickbooksProfitAndLoss(range, {
    query: {
      queryKey: getGetQuickbooksProfitAndLossQueryKey(range),
      enabled: connected,
      // A report that QuickBooks refused is a fact about the connection, not a
      // flaky request; retrying just makes him wait longer for the same answer.
      retry: false,
    },
  });
  const expenses = useGetQuickbooksExpenses(range, {
    query: {
      queryKey: getGetQuickbooksExpensesQueryKey(range),
      enabled: connected,
      retry: false,
    },
  });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: getGetQuickbooksStatusQueryKey() });
    void profitAndLoss.refetch();
    void expenses.refetch();
  };

  const banner = outcome ? CALLBACK_OUTCOMES[outcome] : undefined;

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Books</h1>
          <p className="text-muted-foreground mt-1">
            Your QuickBooks profit and loss and where the money went, without signing in to
            QuickBooks. Read only — nothing here changes your bookkeeping.
          </p>
        </div>
        {connected && (
          <Button variant="outline" size="sm" onClick={refreshAll} className="shrink-0">
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        )}
      </div>

      {banner && (
        <Alert variant={banner.bad ? 'destructive' : 'default'}>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.body}</AlertDescription>
        </Alert>
      )}

      {statusQuery.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : statusQuery.isError ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not check the QuickBooks connection</AlertTitle>
          <AlertDescription>{errorMessage(statusQuery.error)}</AlertDescription>
        </Alert>
      ) : status ? (
        <ConnectionCard
          status={status}
          onDisconnected={() => {
            toast({ title: 'QuickBooks disconnected' });
            void queryClient.invalidateQueries({ queryKey: getGetQuickbooksStatusQueryKey() });
          }}
          onError={(error) =>
            toast({ variant: 'destructive', title: 'Could not disconnect', description: errorMessage(error) })
          }
        />
      ) : null}

      {connected && (
        <>
          <DateRange
            from={from}
            to={to}
            onFrom={setFrom}
            onTo={setTo}
            onApply={() => setRange({ from, to })}
            dirty={from !== range.from || to !== range.to}
          />

          <ReportCard
            heading="Profit & Loss"
            description="Income, cost of sales and expenses for the period, exactly as QuickBooks totals them."
            report={profitAndLoss.data}
            isLoading={profitAndLoss.isLoading}
            error={profitAndLoss.error}
          />

          <ReportCard
            heading="Where the money went"
            description="The expense side of the same Profit & Loss, broken out by category."
            report={expenses.data}
            isLoading={expenses.isLoading}
            error={expenses.error}
          />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- connection ----

function ConnectionCard({
  status,
  onDisconnected,
  onError,
}: {
  status: QuickbooksStatus;
  onDisconnected: () => void;
  onError: (error: unknown) => void;
}) {
  const disconnect = useDisconnectQuickbooks({
    mutation: { onSuccess: onDisconnected, onError },
  });

  if (!status.configured) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>This server has no QuickBooks credentials</AlertTitle>
        <AlertDescription>
          Nobody has given this installation an Intuit client ID and secret, so it cannot talk to
          QuickBooks at all. There is nothing to connect to yet — this is a setup step on the server,
          not something to fix here.
        </AlertDescription>
      </Alert>
    );
  }

  if (!status.connected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connect QuickBooks</CardTitle>
          <CardDescription>
            You will be sent to Intuit to sign in and approve read-only access to your company file.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.lastError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Last time QuickBooks said</AlertTitle>
              <AlertDescription>{status.lastError}</AlertDescription>
            </Alert>
          )}
          {status.environment === 'sandbox' && <SandboxWarning connected={false} />}
          {status.connectUrl ? (
            <Button asChild>
              {/* A full page navigation, not a fetch: Intuit's sign-in has to
                  happen in the address bar where he can see who he is signing
                  in to. */}
              <a href={status.connectUrl}>
                <Link2 className="w-4 h-4 mr-2" />
                Connect to QuickBooks
              </a>
            </Button>
          ) : (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Missing return address</AlertTitle>
              <AlertDescription>
                The server does not know its own public URL, so QuickBooks has nowhere to send you
                back to. Set APP_PUBLIC_URL and try again.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {status.environment === 'sandbox' && <SandboxWarning connected />}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                {status.companyName ?? `Company ${status.realmId ?? ''}`.trim()}
                <Badge variant={status.environment === 'production' ? 'secondary' : 'destructive'}>
                  {status.environment === 'production' ? 'Live company' : 'Sandbox test company'}
                </Badge>
              </CardTitle>
              <CardDescription>Connected to QuickBooks — read only.</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              <Link2Off className="w-4 h-4 mr-2" />
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <Fact label="Company ID" value={status.realmId} />
            <Fact label="Connected" value={formatMoment(status.connectedAt)} />
            <Fact label="Connected by" value={status.connectedByName} />
            <Fact label="Last read" value={formatMoment(status.lastSyncedAt)} />
          </dl>
          {status.lastError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>QuickBooks reported a problem</AlertTitle>
              <AlertDescription>{status.lastError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The sandbox is Intuit's demo company, not his books. Every number below it is
 * invented, and someone glancing at this page has no other way to tell — so it
 * says so loudly, above the figures, not in a footnote.
 */
function SandboxWarning({ connected }: { connected: boolean }) {
  return (
    <Alert variant="destructive" className="border-destructive">
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>These are not your real books</AlertTitle>
      <AlertDescription>
        {connected
          ? 'This is connected to Intuit’s sandbox — a made-up test company. Every figure on this page is sample data. Do not use it for taxes, pricing or any decision about the business.'
          : 'This server is set up against Intuit’s sandbox, so connecting will pull figures from a made-up test company rather than your real QuickBooks.'}
      </AlertDescription>
    </Alert>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4 sm:block">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value || '—'}</dd>
    </div>
  );
}

function formatMoment(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

// ------------------------------------------------------------ date range ----

function DateRange({
  from,
  to,
  onFrom,
  onTo,
  onApply,
  dirty,
}: {
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onApply: () => void;
  dirty: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-4 pt-6">
        <div className="space-y-1">
          <Label htmlFor="books-from">From</Label>
          <Input id="books-from" type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="books-to">To</Label>
          <Input id="books-to" type="date" value={to} onChange={(e) => onTo(e.target.value)} />
        </div>
        <Button onClick={onApply} disabled={!dirty}>
          Show this period
        </Button>
        <p className="text-sm text-muted-foreground ml-auto">
          Defaults to this year so far.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- reports ----

function ReportCard({
  heading,
  description,
  report,
  isLoading,
  error,
}: {
  heading: string;
  description: string;
  report: QuickbooksReport | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  const format = useMemo(() => {
    const currency = report?.currency || 'USD';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency });
    } catch {
      // A currency code QuickBooks knows and the browser does not must not blank
      // the whole report.
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
    }
  }, [report?.currency]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{heading}</CardTitle>
        <CardDescription>
          {description}
          {report && (
            <>
              {' '}
              <span className="whitespace-nowrap">
                {report.from} to {report.to}
              </span>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>QuickBooks could not return this report</AlertTitle>
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        ) : !report || report.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            QuickBooks has nothing to report for this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>{report.title}</TableHead>
                  <TableHead className="text-right w-40">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row, index) => (
                  <TableRow
                    key={`${index}-${row.label}`}
                    className={row.isTotal ? 'border-t-2 bg-muted/30' : undefined}
                  >
                    <TableCell
                      className={row.isTotal ? 'font-semibold text-foreground' : 'text-foreground'}
                      style={{ paddingLeft: `${0.75 + (row.depth ?? 0) * 1.25}rem` }}
                    >
                      {row.label}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${row.isTotal ? 'font-semibold' : ''}`}
                    >
                      {/* A zero on a non-total line is nearly always a section
                          heading, which QuickBooks itself prints with a blank
                          amount. Totals always show their figure. */}
                      {row.amount === 0 && !row.isTotal ? '—' : format.format(row.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
