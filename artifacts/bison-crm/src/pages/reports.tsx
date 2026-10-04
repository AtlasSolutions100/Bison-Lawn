import { useEffect, useMemo, useState } from 'react';
import { format, startOfMonth, subMonths } from 'date-fns';
import { Link } from 'wouter';
import {
  useGetCostingReport,
  useAskReportQuestion,
  useGetReportCatalogue,
  useGetReport,
  getGetReportQueryKey,
  type CostingRow,
  type ReportColumn,
  type ReportRow,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertCircle, Download, Sparkles, TrendingUp } from 'lucide-react';

const money = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
const hours = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}h`);

/**
 * The file his "Export to Excel" button saves. A plain link: the cookie
 * session rides along and the browser does the download, so there is no
 * blob code to go wrong and the same URL works pasted into a new tab.
 */
const csvHref = (key: string, from: string, to: string) =>
  `/api/reports/run?key=${encodeURIComponent(key)}&from=${from}&to=${to}&format=csv`;

/**
 * Variance is the number he acts on, so it carries the only colour on the page:
 * over the time it was priced for is bad, under is good. Zero is neither and
 * stays neutral rather than being coloured green for looking tidy.
 */
function Variance({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const over = value > 0.05;
  const under = value < -0.05;
  return (
    <span className={over ? 'font-semibold text-destructive' : under ? 'font-semibold text-primary' : ''}>
      {value > 0 ? '+' : ''}{value.toFixed(1)}h
    </span>
  );
}

/**
 * One cell of a curated report, drawn from the column's kind so a new report
 * on the server needs no new screen here. A "link" column is the customer's
 * name and opens their page; the row carries clientId for that.
 */
function ReportCell({ column, row }: { column: ReportColumn; row: ReportRow }) {
  const value = row[column.key];
  if (value == null || value === '') return <span className="text-muted-foreground">—</span>;
  switch (column.kind) {
    case 'money':
      return <>{money(Number(value))}</>;
    case 'hours':
      return column.key === 'varianceHours' ? <Variance value={Number(value)} /> : <>{hours(Number(value))}</>;
    case 'number':
      return <>{Number(value).toLocaleString()}</>;
    case 'sqft':
      return <>{Number(value).toLocaleString()} sq ft</>;
    case 'link': {
      const clientId = row.clientId;
      return typeof clientId === 'number' ? (
        <Link href={`/clients/${clientId}`} className="font-medium text-primary hover:underline">
          {String(value)}
        </Link>
      ) : (
        <>{String(value)}</>
      );
    }
    default:
      if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
      return <>{String(value)}</>;
  }
}

const RIGHT_ALIGNED = new Set(['money', 'hours', 'number', 'sqft']);

/**
 * The generic table every curated report renders into. The totals line is
 * only shown for the columns the report marks summable, so a per-week report
 * never gets a meaningless "total of the week-of dates".
 */
function ReportTable({
  columns,
  rows,
  totals,
  empty = 'Nothing in this period.',
}: {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: Record<string, number> | null;
  empty?: string;
}) {
  if (rows.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map(c => (
              <TableHead key={c.key} className={RIGHT_ALIGNED.has(c.kind) ? 'text-right' : ''}>
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {columns.map(c => (
                <TableCell key={c.key} className={RIGHT_ALIGNED.has(c.kind) ? 'text-right tabular-nums' : ''}>
                  <ReportCell column={c} row={row} />
                </TableCell>
              ))}
            </TableRow>
          ))}
          {totals && Object.keys(totals).length > 0 && (
            <TableRow className="bg-muted/40 font-semibold">
              {columns.map((c, i) => (
                <TableCell key={c.key} className={RIGHT_ALIGNED.has(c.kind) ? 'text-right tabular-nums' : ''}>
                  {i === 0 && !(c.key in totals)
                    ? 'Total'
                    : c.key in totals
                      ? <ReportCell column={c} row={{ [c.key]: totals[c.key] }} />
                      : ''}
                </TableCell>
              ))}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * How much of the work behind a row was actually clocked.
 *
 * Shown on every row on purpose. A row summarising ninety jobs from four
 * measured ones is nearly meaningless, and without this the reader cannot tell
 * that apart from a row where everything was measured.
 */
function Measured({ row }: { row: CostingRow }) {
  const complete = row.measuredJobs === row.jobs;
  return (
    <span className={complete ? 'text-muted-foreground' : 'text-amber-700'}>
      {row.measuredJobs}/{row.jobs}
    </span>
  );
}

function CostingTable({ rows, firstColumn }: { rows: CostingRow[]; firstColumn: string }) {
  if (rows.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Nothing completed in this period.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{firstColumn}</TableHead>
            <TableHead className="text-right">Clocked</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right">Budgeted</TableHead>
            <TableHead className="text-right">Actual</TableHead>
            <TableHead className="text-right">Variance</TableHead>
            <TableHead className="text-right">$ / hour</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(row => (
            <TableRow key={row.key}>
              <TableCell className="font-medium">{row.label}</TableCell>
              <TableCell className="text-right text-xs tabular-nums"><Measured row={row} /></TableCell>
              <TableCell className="text-right tabular-nums">{money(row.revenue)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{hours(row.budgetedHours)}</TableCell>
              <TableCell className="text-right tabular-nums">{hours(row.actualHours)}</TableCell>
              <TableCell className="text-right tabular-nums"><Variance value={row.varianceHours ?? null} /></TableCell>
              <TableCell className="text-right tabular-nums">
                {row.revenuePerHour == null ? <span className="text-muted-foreground">—</span> : money(row.revenuePerHour)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ExportButton({ reportKey, from, to }: { reportKey: string; from: string; to: string }) {
  return (
    <Button asChild variant="outline" size="sm" data-testid={`export-${reportKey}`}>
      <a href={csvHref(reportKey, from, to)} download>
        <Download className="mr-2 h-4 w-4" /> Export CSV
      </a>
    </Button>
  );
}

/**
 * The three money reports from his 2026-09-28 notes, and the sentence that has
 * to sit next to them.
 *
 * He asked for a cash report AND an accrual report, which only makes sense if
 * the difference between them is in front of him — otherwise two reports with
 * similar totals look like one of them is wrong. So the difference is stated on
 * screen wherever one of them is open, not buried in a help page.
 */
const MONEY_BASIS_REPORTS = new Set(['cash_report', 'accrual_report', 'cash_vs_accrual_by_month']);

function MoneyBasisNote() {
  return (
    <div className="rounded-md border-l-2 border-primary bg-primary/5 p-3 text-sm" data-testid="money-basis-note">
      <p>
        <strong>Cash</strong> counts a payment on the day you took it. <strong>Accrual</strong> counts
        an invoice on its invoice date, paid or not.
      </p>
      <p className="mt-1 text-muted-foreground">
        So a bill you sent in December and got paid for in February is accrual money in December and
        cash money in February. Cash tells you what is in the bank; accrual tells you what the month
        earned. That is why both are here.
      </p>
    </div>
  );
}

/** The report he last opened comes back next visit; it is a convenience, nothing more. */
const LAST_REPORT_KEY = 'bison.reports.last';

export default function Reports() {
  const [from, setFrom] = useState(format(startOfMonth(subMonths(new Date(), 2)), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [question, setQuestion] = useState('');
  const [reportKey, setReportKey] = useState<string>(() => {
    try { return localStorage.getItem(LAST_REPORT_KEY) ?? ''; } catch { return ''; }
  });

  const catalogue = useGetReportCatalogue();
  const costing = useGetCostingReport({ from, to });
  const ask = useAskReportQuestion();
  const picked = useGetReport(
    { key: reportKey, from, to },
    { query: { enabled: reportKey !== '', queryKey: getGetReportQueryKey({ key: reportKey, from, to }), retry: false } },
  );

  useEffect(() => {
    try { localStorage.setItem(LAST_REPORT_KEY, reportKey); } catch { /* private window */ }
  }, [reportKey]);

  const rangeValid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  // The picker sentences. The ones he named in the walkthrough come first so
  // the box reads like his list, and the older costing questions follow.
  const asks = useMemo(() => {
    const reports = catalogue.data?.reports ?? [];
    const named = reports.filter(r => !r.key.startsWith('costing_') && r.key !== 'unbilled_completed_work');
    const rest = reports.filter(r => !named.includes(r));
    return [...named, ...rest].flatMap(r => r.asks.map(a => ({ key: r.key, ask: a })));
  }, [catalogue.data]);

  const submitQuestion = (text = question) => {
    const q = text.trim();
    if (!q || !rangeValid) return;
    setQuestion(q);
    ask.mutate({ data: { question: q, from, to } });
  };

  const summary = costing.data?.summary;
  const measuredShare = summary && summary.completedJobs > 0
    ? summary.measuredJobs / summary.completedJobs
    : 0;
  const assistantAvailable = catalogue.data?.assistantAvailable ?? false;
  const pickedEntry = catalogue.data?.reports.find(r => r.key === reportKey);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="mt-1 text-muted-foreground">
            Every report runs over the dates on the right and exports to a spreadsheet.
          </p>
        </div>
        <div className="flex items-end gap-2 rounded-lg border bg-card p-2 shadow-sm">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">From</label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-40" data-testid="report-from" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">To</label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-40" data-testid="report-to" />
          </div>
        </div>
      </div>

      {!rangeValid && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Pick a from date that is on or before the to date.</AlertDescription>
        </Alert>
      )}

      {/* The plain-English box. Always on: with an assistant key the model
          picks the report and writes a few sentences; without one the question
          is matched on its words and the table alone is the answer. Either way
          the rows are shown, so a sentence can be checked against its data. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" /> Ask in plain English
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="e.g. how many jobs did each contractor skip, and what did that cost me?"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitQuestion(); }}
              data-testid="ask-input"
            />
            <Button onClick={() => submitQuestion()} disabled={!question.trim() || !rangeValid || ask.isPending} data-testid="ask-submit">
              {ask.isPending ? 'Working…' : 'Ask'}
            </Button>
          </div>
          {asks.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {asks.map(({ key, ask: sentence }) => (
                <button
                  key={`${key}:${sentence}`}
                  type="button"
                  onClick={() => submitQuestion(sentence)}
                  className="rounded-full border bg-background px-3 py-1 text-xs text-foreground transition-colors hover:border-primary hover:bg-primary/5"
                  data-testid={`ask-${key}`}
                >
                  {sentence}
                </button>
              ))}
            </div>
          )}
          {!assistantAvailable && catalogue.data && (
            <p className="text-xs text-muted-foreground">
              No assistant key is set on this server, so questions are matched on their words and
              answered with the table alone. The sentences above always work.
            </p>
          )}
          {ask.isError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {ask.error instanceof Error ? ask.error.message : 'The assistant could not answer that.'}
              </AlertDescription>
            </Alert>
          )}
          {ask.data && (
            <div className="space-y-3">
              <div className="rounded-md border-l-2 border-primary bg-primary/5 py-3 pl-3 pr-2">
                <p className="text-[15px] leading-relaxed" data-testid="ask-answer">{ask.data.answer}</p>
                {ask.data.reportTitle && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Read from: {ask.data.reportTitle}
                    {!ask.data.assistantUsed && ' (matched on the words, no assistant)'}
                  </p>
                )}
              </div>
              {ask.data.reportKey && (
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    {ask.data.rows.length} {ask.data.rows.length === 1 ? 'row' : 'rows'}, {from} to {to}
                  </p>
                  <ExportButton reportKey={ask.data.reportKey} from={from} to={to} />
                </div>
              )}
              {/* The same sentence when the question lands on one of them, so
                  he never reads a cash total thinking it is an accrual one. */}
              {ask.data.reportKey && MONEY_BASIS_REPORTS.has(ask.data.reportKey) && <MoneyBasisNote />}
              {ask.data.columns.length > 0 && (
                <div className="rounded-md border">
                  <ReportTable columns={ask.data.columns} rows={ask.data.rows} totals={ask.data.totals ?? null} />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* The same reports, picked by name. */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Open a report</CardTitle>
            <div className="flex items-center gap-2">
              <Select value={reportKey} onValueChange={setReportKey}>
                <SelectTrigger className="w-[320px]" data-testid="report-picker">
                  <SelectValue placeholder="Pick a report…" />
                </SelectTrigger>
                <SelectContent>
                  {(catalogue.data?.reports ?? []).map(r => (
                    <SelectItem key={r.key} value={r.key}>{r.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {reportKey && <ExportButton reportKey={reportKey} from={from} to={to} />}
            </div>
          </div>
          {pickedEntry && (
            <p className="text-sm text-muted-foreground">{pickedEntry.describes}.</p>
          )}
          {MONEY_BASIS_REPORTS.has(reportKey) && <MoneyBasisNote />}
          {reportKey === 'email_failures' && (
            <p className="text-xs text-amber-700">
              These are emails Gmail refused to send or that were skipped. A bounce that comes back
              later cannot be seen, because the app only sends mail and never reads the inbox.
            </p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {!reportKey ? (
            <p className="p-4 text-sm text-muted-foreground">Pick a report above, or ask a question.</p>
          ) : picked.isLoading ? (
            <Skeleton className="m-4 h-24" />
          ) : picked.isError ? (
            <Alert variant="destructive" className="m-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {picked.error instanceof Error ? picked.error.message : 'Could not run that report.'}
              </AlertDescription>
            </Alert>
          ) : picked.data ? (
            <ReportTable columns={picked.data.columns} rows={picked.data.rows} totals={picked.data.totals ?? null} />
          ) : null}
        </CardContent>
      </Card>

      {costing.isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : costing.isError ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not load the costing report</AlertTitle>
          <AlertDescription>
            {costing.error instanceof Error ? costing.error.message : 'Something went wrong.'}
          </AlertDescription>
        </Alert>
      ) : summary ? (
        <>
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Budgeted against actual hours</h2>
            <p className="text-sm text-muted-foreground">What the work actually cost, against what it was priced for.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Completed jobs" value={String(summary.completedJobs)} />
            <Stat label="Revenue" value={money(summary.revenue)} />
            <Stat label="Budgeted hours" value={hours(summary.budgetedHours)} />
            <Stat label="Actual hours" value={hours(summary.actualHours)} />
            <Stat
              label="Revenue per hour"
              value={summary.revenuePerHour == null ? '—' : money(summary.revenuePerHour)}
            />
          </div>

          {/* Stated before any of the tables, not as a footnote. Everything below
              is drawn from the clocked jobs only, and a low share makes the whole
              page indicative rather than reliable — the reader has to know that
              before reading a single figure, not after. */}
          {summary.completedJobs > 0 && measuredShare < 1 && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>
                {summary.measuredJobs} of {summary.completedJobs} completed jobs were clocked
              </AlertTitle>
              <AlertDescription>
                Hours and rates below cover only the clocked jobs. Work with no clock entry is left
                out rather than counted as zero hours, which would make the crew look faster than
                they were.
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="h-4 w-4" /> Customers whose work runs over
                </CardTitle>
                <ExportButton reportKey="costing_by_client" from={from} to={to} />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <CostingTable rows={costing.data?.byClient ?? []} firstColumn="Customer" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">By service</CardTitle>
                <ExportButton reportKey="costing_by_service" from={from} to={to} />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <CostingTable rows={costing.data?.byService ?? []} firstColumn="Service" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">By contractor</CardTitle>
                <ExportButton reportKey="costing_by_sub" from={from} to={to} />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <CostingTable rows={costing.data?.bySub ?? []} firstColumn="Contractor" />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
