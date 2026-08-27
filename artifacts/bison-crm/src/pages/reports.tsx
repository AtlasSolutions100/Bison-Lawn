import { useState } from 'react';
import { format, startOfMonth, subMonths } from 'date-fns';
import { useGetCostingReport, useAskReportQuestion, type CostingRow } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, Sparkles, TrendingUp } from 'lucide-react';

const money = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
const hours = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}h`);

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

export default function Reports() {
  const [from, setFrom] = useState(format(startOfMonth(subMonths(new Date(), 2)), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [question, setQuestion] = useState('');

  const report = useGetCostingReport({ from, to });
  const ask = useAskReportQuestion();

  const summary = report.data?.summary;
  const measuredShare = summary && summary.completedJobs > 0
    ? summary.measuredJobs / summary.completedJobs
    : 0;

  const submitQuestion = () => {
    if (!question.trim()) return;
    ask.mutate({ data: { question: question.trim(), from, to } });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="mt-1 text-muted-foreground">
            What the work actually cost, against what it was priced for.
          </p>
        </div>
        <div className="flex items-end gap-2 rounded-lg border bg-card p-2 shadow-sm">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">From</label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-40" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">To</label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-40" />
          </div>
        </div>
      </div>

      {report.isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : report.isError ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not load the report</AlertTitle>
          <AlertDescription>
            {report.error instanceof Error ? report.error.message : 'Something went wrong.'}
          </AlertDescription>
        </Alert>
      ) : summary ? (
        <>
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

          {report.data?.assistantAvailable ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4" /> Ask about this data
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    placeholder="e.g. which customers take longer than I quoted?"
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') submitQuestion(); }}
                  />
                  <Button onClick={submitQuestion} disabled={!question.trim() || ask.isPending}>
                    {ask.isPending ? 'Thinking…' : 'Ask'}
                  </Button>
                </div>
                {ask.isError && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      {ask.error instanceof Error ? ask.error.message : 'The assistant could not answer that.'}
                    </AlertDescription>
                  </Alert>
                )}
                {ask.data && (
                  <div className="rounded-md border-l-2 border-primary bg-primary/5 py-3 pl-3 pr-2">
                    <p className="text-[15px] leading-relaxed">{ask.data.answer}</p>
                    {ask.data.reportTitle && (
                      // Named so he can scroll to the same table and check the
                      // sentence against the rows it was written from.
                      <p className="mt-2 text-xs text-muted-foreground">
                        Read from: {ask.data.reportTitle}
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <p className="text-xs text-muted-foreground">
              Plain-English questions are switched off: no assistant key is set on this server.
            </p>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4" /> Customers whose work runs over
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <CostingTable rows={report.data?.byClient ?? []} firstColumn="Customer" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">By service</CardTitle></CardHeader>
            <CardContent className="p-0">
              <CostingTable rows={report.data?.byService ?? []} firstColumn="Service" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">By crew</CardTitle></CardHeader>
            <CardContent className="p-0">
              <CostingTable rows={report.data?.bySub ?? []} firstColumn="Crew" />
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
