import { and, eq, gte, isNotNull, lt, ne } from "drizzle-orm";
import { db, jobsTable } from "@workspace/db";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * How many free skips a customer gets per calendar year.
 *
 * One, per his mowing terms. Named rather than inlined so the number is
 * findable when he changes it, which he will — it is a sales lever.
 */
export const FREE_SKIPS_PER_YEAR = 1;

export type SkipAssessment = {
  /** True when this skip is chargeable because the free one is already used. */
  billable: boolean;
  /** Skips already taken this year, not counting the one being taken now. */
  priorSkips: number;
  /** Ready to show to the office, and to record on the audit trail. */
  message: string;
};

/**
 * Decide whether the skip being taken now is the free one or a chargeable one.
 *
 * Counts by calendar year on `skippedAt`, which is when the skip was taken —
 * not `scheduledDate`, so moving a job between years cannot retroactively hand
 * back a free skip that was already spent.
 *
 * Scoped to the client rather than to one service on purpose: he describes the
 * allowance as one per customer per year, and counting it per service would let
 * a customer on two mowing schedules skip twice for free.
 */
export async function assessSkip(
  clientId: number,
  jobId: number,
  now: Date = new Date(),
  tx: Executor = db,
): Promise<SkipAssessment> {
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const nextYearStart = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));

  const rows = await tx
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.clientId, clientId),
        eq(jobsTable.status, "skipped"),
        isNotNull(jobsTable.skippedAt),
        gte(jobsTable.skippedAt, yearStart),
        lt(jobsTable.skippedAt, nextYearStart),
        // Re-skipping a job already marked skipped must not count it twice.
        ne(jobsTable.id, jobId),
      ),
    );

  const priorSkips = rows.length;
  const billable = priorSkips >= FREE_SKIPS_PER_YEAR;
  const year = now.getUTCFullYear();
  const message = billable
    ? `Chargeable skip — the customer already used ${priorSkips === 1 ? "their free skip" : `${priorSkips} skips`} in ${year}. Per the service terms this one is still billed as a completed service.`
    : `Free skip — the customer's one allowed skip for ${year}.`;

  return { billable, priorSkips, message };
}
