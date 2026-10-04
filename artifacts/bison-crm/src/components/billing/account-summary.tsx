import { useGetAccountSummary } from '@workspace/api-client-react';
import { dayLabel, money } from './shared';

/**
 * The same figures, in one line, for the balance box at the top of the
 * customer's page.
 *
 * "Admin see running total for customer" — the big number there is the account
 * balance, which is not a lie and is not the whole story. These three words
 * under it say what else is in play without him having to open a tab: what is
 * past due, what we are holding for them, and what is finished and not billed
 * yet. Zero figures are left out so the line stays short on the customers who
 * owe nothing.
 */
export function AccountRunningTotalLine({ clientId }: { clientId: number }) {
  const { data: summary } = useGetAccountSummary(
    { clientId },
    { query: { queryKey: ['/api/invoices/account-summary', { clientId }] } },
  );
  if (!summary) return null;
  const bits = [
    summary.pastDue > 0 ? `${money(summary.pastDue)} past due` : null,
    summary.credit > 0 ? `${money(summary.credit)} credit` : null,
    summary.notYetInvoiced > 0 ? `${money(summary.notYetInvoiced)} not billed yet` : null,
    summary.awaitingVerification > 0 ? `${money(summary.awaitingVerification)} not checked` : null,
    summary.writtenOff > 0 ? `${money(summary.writtenOff)} written off` : null,
  ].filter(Boolean) as string[];
  return (
    <p className="text-xs font-medium text-muted-foreground mt-1" data-testid="running-total">
      Owed now <span className="font-bold text-foreground">{money(summary.owedNow)}</span>
      {bits.length > 0 && <> · {bits.join(' · ')}</>}
    </p>
  );
}

/**
 * "Admin see running total for customer."
 *
 * The customer's page showed one number — the account balance — which is true
 * and does not answer the question he actually asks on the phone: what do they
 * owe me right now, and what is still coming. So every part is on the strip
 * with the word that explains it: bills they have and have not paid, the part
 * of that which is late, money we are holding for them, bills we raised and
 * have not checked yet, work finished with no bill on it, and anything he gave
 * up on. The running total is the one figure he quotes: owed less credit.
 *
 * The words come from the server with the figures, so the number and its
 * explanation can never drift apart.
 */
export default function AccountSummaryStrip({ clientId }: { clientId: number }) {
  const { data: summary, isLoading } = useGetAccountSummary(
    { clientId },
    { query: { queryKey: ['/api/invoices/account-summary', { clientId }] } },
  );

  if (isLoading) {
    return <div className="rounded-md border bg-card px-3 py-4 text-sm text-muted-foreground animate-pulse">Adding it up…</div>;
  }
  if (!summary) return null;

  const highlight = (key: string) => key === 'runningTotal';
  return (
    <div className="rounded-md border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2">
        <span className="text-sm font-semibold">Running total</span>
        <span className={`text-2xl font-bold tabular-nums ${summary.runningTotal > 0 ? 'text-destructive' : summary.runningTotal < 0 ? 'text-primary' : ''}`}>
          {money(summary.runningTotal)}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 divide-x divide-y sm:divide-y-0">
        {summary.parts.map((part) => (
          <div key={part.key} className={`px-3 py-2 ${highlight(part.key) ? 'bg-muted/50' : ''}`}>
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{part.label}</div>
            <div
              className={`text-base font-bold tabular-nums ${
                part.amount === 0 ? 'text-muted-foreground' : part.key === 'credit' ? 'text-primary' : part.key === 'writtenOff' ? 'text-muted-foreground' : 'text-foreground'
              }`}
            >
              {money(part.amount)}
            </div>
            {/* One word of explanation under each figure: a number nobody can
                explain is a number that gets argued about on the phone. */}
            <div className="text-[11px] text-muted-foreground leading-snug">{part.explain}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>
          With everything that is coming: <span className="font-semibold text-foreground tabular-nums">{money(summary.withEverything)}</span>
        </span>
        <span>
          {summary.openInvoiceCount} open bill{summary.openInvoiceCount === 1 ? '' : 's'}
        </span>
        {summary.notInvoicedJobCount > 0 && (
          <span>
            {summary.notInvoicedJobCount} finished job{summary.notInvoicedJobCount === 1 ? '' : 's'} with no bill yet
          </span>
        )}
        {summary.oldestUnpaidDate && <span>Oldest unpaid: {dayLabel(summary.oldestUnpaidDate)}</span>}
      </div>
    </div>
  );
}
