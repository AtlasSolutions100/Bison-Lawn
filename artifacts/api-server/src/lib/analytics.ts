/**
 * The curated reports. Every number Adam sees comes from one of these queries.
 *
 * Deliberately a fixed set rather than generated SQL. These figures decide what
 * he charges and who he keeps, and a model that writes its own query can return
 * a confidently wrong number with nothing to catch it. The AI layer that sits on
 * top chooses which of these to run and writes the prose around the result; it
 * never computes a figure of its own.
 *
 * The rule that matters most below: **a job with no clock entries has no actual,
 * and that is not zero**. Treating unmeasured work as zero hours makes a crew
 * look infinitely efficient and would quietly recommend cutting the price on the
 * jobs that are actually losing money. Unmeasured jobs are counted and reported
 * separately, never folded into an average.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type CostingRow = {
  key: string;
  label: string;
  jobs: number;
  /** Jobs with at least one closed clock entry — the only ones with an actual. */
  measuredJobs: number;
  revenue: number;
  budgetedHours: number | null;
  actualHours: number | null;
  /** actual - budgeted, positive means it took longer than planned. */
  varianceHours: number | null;
  /** Revenue per actual hour worked. Null when nothing was measured. */
  revenuePerHour: number | null;
};

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Hours actually worked per job, from closed clock entries only.
 *
 * An open entry (someone still on site, or who forgot to clock out) is excluded
 * rather than counted to now: a forgotten clock-out would otherwise grow all day
 * and turn one job into the least profitable work he has ever done.
 */
const ACTUAL_HOURS_CTE = sql`
  actuals as (
    select job_id,
           sum(extract(epoch from (clock_out_at - clock_in_at)) / 3600.0) as hours
    from job_time_entries
    where clock_out_at is not null
    group by job_id
  )
`;

function toRows(result: Array<Record<string, unknown>>): CostingRow[] {
  return result.map((r) => {
    const measured = Number(r.measured_jobs ?? 0);
    const actual = r.actual_hours == null ? null : Number(r.actual_hours);
    const budgeted = r.budgeted_hours == null ? null : Number(r.budgeted_hours);
    return {
      key: String(r.key ?? ""),
      label: String(r.label ?? "Unassigned"),
      jobs: Number(r.jobs ?? 0),
      measuredJobs: measured,
      revenue: round(Number(r.revenue ?? 0)),
      budgetedHours: budgeted == null ? null : round(budgeted, 2),
      actualHours: actual == null ? null : round(actual, 2),
      // Only meaningful when both sides exist. A variance against a missing
      // budget, or against unmeasured work, is a number with no meaning.
      varianceHours: actual == null || budgeted == null ? null : round(actual - budgeted, 2),
      revenuePerHour: actual == null || actual <= 0 ? null : round(Number(r.revenue ?? 0) / actual, 2),
    };
  });
}

/**
 * Completed work only. In-progress jobs have a budget but no finished actual, so
 * including them would drag every average toward "under budget" for no reason
 * other than the day not being over.
 */
const COMPLETED = sql`j.status = 'completed'`;

export async function costingBySub(from: string, to: string): Promise<CostingRow[]> {
  const result = await db.execute(sql`
    with ${ACTUAL_HOURS_CTE}
    select coalesce(u.id::text, 'unassigned') as key,
           coalesce(u.name, 'Unassigned') as label,
           count(*) as jobs,
           count(a.hours) as measured_jobs,
           sum(j.amount) as revenue,
           sum(j.budgeted_hours) filter (where a.hours is not null) as budgeted_hours,
           sum(a.hours) as actual_hours
    from jobs j
    left join users u on u.id = j.assigned_to_id
    left join actuals a on a.job_id = j.id
    where ${COMPLETED} and j.scheduled_date between ${from} and ${to}
    group by 1, 2
    order by sum(j.amount) desc
  `);
  return toRows(result.rows as Array<Record<string, unknown>>);
}

export async function costingByService(from: string, to: string): Promise<CostingRow[]> {
  const result = await db.execute(sql`
    with ${ACTUAL_HOURS_CTE}
    select coalesce(s.id::text, 'none') as key,
           coalesce(s.name, 'No service') as label,
           count(*) as jobs,
           count(a.hours) as measured_jobs,
           sum(j.amount) as revenue,
           sum(j.budgeted_hours) filter (where a.hours is not null) as budgeted_hours,
           sum(a.hours) as actual_hours
    from jobs j
    left join services s on s.id = j.service_id
    left join actuals a on a.job_id = j.id
    where ${COMPLETED} and j.scheduled_date between ${from} and ${to}
    group by 1, 2
    order by sum(j.amount) desc
  `);
  return toRows(result.rows as Array<Record<string, unknown>>);
}

/**
 * Customers whose work runs over the time it was priced for.
 *
 * Ordered by variance rather than revenue: the account that quietly takes twice
 * as long as quoted is the one worth knowing about, and it is rarely the biggest
 * invoice.
 */
export async function costingByClient(from: string, to: string): Promise<CostingRow[]> {
  const result = await db.execute(sql`
    with ${ACTUAL_HOURS_CTE}
    select c.id::text as key,
           c.name as label,
           count(*) as jobs,
           count(a.hours) as measured_jobs,
           sum(j.amount) as revenue,
           sum(j.budgeted_hours) filter (where a.hours is not null) as budgeted_hours,
           sum(a.hours) as actual_hours
    from jobs j
    join clients c on c.id = j.client_id
    left join actuals a on a.job_id = j.id
    where ${COMPLETED} and j.scheduled_date between ${from} and ${to}
    group by 1, 2
    having count(a.hours) > 0
    order by (sum(a.hours) - sum(j.budgeted_hours) filter (where a.hours is not null)) desc nulls last
  `);
  return toRows(result.rows as Array<Record<string, unknown>>);
}

export type CostingSummary = {
  from: string;
  to: string;
  completedJobs: number;
  /** How many of those have a closed clock entry. The honesty of everything else. */
  measuredJobs: number;
  revenue: number;
  budgetedHours: number | null;
  actualHours: number | null;
  varianceHours: number | null;
  revenuePerHour: number | null;
};

export async function costingSummary(from: string, to: string): Promise<CostingSummary> {
  const result = await db.execute(sql`
    with ${ACTUAL_HOURS_CTE}
    select count(*) as jobs,
           count(a.hours) as measured_jobs,
           coalesce(sum(j.amount), 0) as revenue,
           sum(j.budgeted_hours) filter (where a.hours is not null) as budgeted_hours,
           sum(a.hours) as actual_hours
    from jobs j
    left join actuals a on a.job_id = j.id
    where ${COMPLETED} and j.scheduled_date between ${from} and ${to}
  `);
  const [row] = toRows(result.rows as Array<Record<string, unknown>>);
  return {
    from,
    to,
    completedJobs: row?.jobs ?? 0,
    measuredJobs: row?.measuredJobs ?? 0,
    revenue: row?.revenue ?? 0,
    budgetedHours: row?.budgetedHours ?? null,
    actualHours: row?.actualHours ?? null,
    varianceHours: row?.varianceHours ?? null,
    revenuePerHour: row?.revenuePerHour ?? null,
  };
}

/**
 * Completed work that has never been invoiced — money already earned and not yet
 * asked for. Kept in the same module because it is the other question a service
 * business asks its own data.
 */
export async function unbilledCompletedWork(from: string, to: string) {
  const result = await db.execute(sql`
    select c.id::text as key,
           c.name as label,
           count(*) as jobs,
           count(*) as measured_jobs,
           sum(j.amount) as revenue,
           null::double precision as budgeted_hours,
           null::double precision as actual_hours
    from jobs j
    join clients c on c.id = j.client_id
    where j.status = 'completed'
      and j.invoice_id is null
      and j.scheduled_date between ${from} and ${to}
    group by 1, 2
    order by sum(j.amount) desc
  `);
  return toRows(result.rows as Array<Record<string, unknown>>);
}

/** The named reports the AI layer is allowed to choose between. */
export const REPORTS = {
  costing_by_sub: {
    title: "Budgeted vs actual hours by crew",
    describes: "which crew members run over or under the time their jobs were priced for",
    run: costingBySub,
  },
  costing_by_service: {
    title: "Budgeted vs actual hours by service",
    describes: "which services are priced for the wrong amount of time, and what each earns per hour",
    run: costingByService,
  },
  costing_by_client: {
    title: "Customers whose work runs over budget",
    describes: "which customers take longer than they were quoted for, worst first",
    run: costingByClient,
  },
  unbilled_completed_work: {
    title: "Completed work not yet invoiced",
    describes: "work that is finished and has not been billed to the customer",
    run: unbilledCompletedWork,
  },
} as const;

export type ReportKey = keyof typeof REPORTS;

export function isReportKey(value: string): value is ReportKey {
  return Object.prototype.hasOwnProperty.call(REPORTS, value);
}
