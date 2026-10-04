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
 *
 * 2026-09-15 walkthrough. The reports he named, each over a from/to range and
 * exportable: skipped and cancelled jobs per contractor with the revenue lost,
 * revenue per week per contractor, turf square footage per week, unapplied and
 * overpaid payments, emails that did not send, and job cost (budgeted hours
 * and cost against clocked hours, per job and per service).
 */
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import type { PricingEquation } from "@workspace/db";
import { calculatePrice } from "./helpers";
// What a customer still owes on one invoice. Imported rather than written out
// again here: void — and, once the write-off work lands, written off — owes
// nothing, and a report that worked that out for itself would sooner or later
// disagree with the balance on the customer's own account.
import { balanceOf } from "./invoiceDocument";
// The two ways out of a balance he will never collect, named in one place so
// the monthly report and the account summary can never disagree about which
// statuses those are.
import { WRITE_OFF_STATUSES } from "./invoiceStatus";

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

/**
 * How a column should be shown and exported. The web renders the table from
 * this, so a new report needs no new screen — only a query and its columns.
 */
export type ColumnKind = "text" | "money" | "number" | "hours" | "date" | "sqft" | "link";
export type ReportColumn = { key: string; label: string; kind: ColumnKind };
export type ReportRow = Record<string, string | number | boolean | null>;

export type ReportDef = {
  title: string;
  /** One line, in his words, used by the picker and by the AI router. */
  describes: string;
  /**
   * The questions this report answers, phrased the way he asks them. Shown as
   * the picker when no AI key is set, and matched word-for-word first when one
   * is, so the same sentence always lands on the same report.
   */
  asks: string[];
  /** Words that point at this report when a question is routed without AI. */
  keywords: string[];
  columns: ReportColumn[];
  /** Column keys summed into a totals row (money and hours only). */
  totals?: string[];
  run: (from: string, to: string) => Promise<ReportRow[]>;
};

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const num = (v: unknown) => (v == null ? null : Number(v));

/**
 * The first number in a property field he typed by hand. "6,200 sq ft",
 * "approx. 6,200 sq. ft." and "6,200-7,000" all read as 6200; "half an acre"
 * reads as nothing at all.
 *
 * Only the leading figure, never every digit glued together: keeping all of
 * them turned a range like "6,200-7,000" into 62,007,000 square feet on his
 * weekly total, and a second full stop ("sq. ft.") made the whole report fail
 * to load rather than skip the one customer.
 */
const turfNumber = (value: SQL) =>
  // [.] rather than an escaped dot: a backslash here has to survive both the
  // template string and the SQL literal, and when it does not the dot quietly
  // matches the "-" in a range again.
  sql`(regexp_match(replace(${value}, ',', ''), '[0-9]+(?:[.][0-9]+)?'))[1]::numeric`;

/**
 * His day, not the server's. Timestamps are stored as UTC wall time, so a bill
 * he entered or an email that failed at 6 pm here belongs to the day before by
 * UTC — it dropped off the report he opens that same evening. The dashboard
 * already counts the day this way (routes/dashboard.ts).
 */
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "America/Los_Angeles";
const localDay = (ts: SQL) =>
  sql`to_char((${ts} at time zone 'UTC') at time zone ${APP_TIME_ZONE}, 'YYYY-MM-DD')`;

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
           coalesce(nullif(u.display_name, ''), u.name, 'Unassigned') as label,
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

const COSTING_COLUMNS: ReportColumn[] = [
  { key: "label", label: "Name", kind: "text" },
  { key: "jobs", label: "Jobs", kind: "number" },
  { key: "measuredJobs", label: "Clocked", kind: "number" },
  { key: "revenue", label: "Revenue", kind: "money" },
  { key: "budgetedHours", label: "Budgeted", kind: "hours" },
  { key: "actualHours", label: "Actual", kind: "hours" },
  { key: "varianceHours", label: "Variance", kind: "hours" },
  { key: "revenuePerHour", label: "$ / hour", kind: "money" },
];

/**
 * Skipped and cancelled work is the same loss to him: a visit that was on the
 * board and earned nothing. A job is dated by its scheduled day, the day the
 * revenue was expected, not the day someone pressed skip. "cancelled" is
 * counted whenever the dispatch board records it as a status; a job deleted
 * outright leaves nothing to count, which is why deleting is the wrong way to
 * cancel.
 */
const LOST_WORK = sql`j.status in ('skipped', 'cancelled')`;

async function skipsByContractor(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    select coalesce(nullif(u.display_name, ''), u.name, 'Unassigned') as contractor,
           count(*) filter (where j.status = 'skipped') as skipped,
           count(*) filter (where j.status = 'cancelled') as cancelled,
           count(*) filter (where j.status = 'skipped' and j.skip_billable) as billable_skips,
           coalesce(sum(j.amount), 0) as revenue_lost,
           coalesce(sum(j.amount) filter (where j.status = 'skipped' and j.skip_billable), 0) as still_billable
    from jobs j
    left join users u on u.id = j.assigned_to_id
    where ${LOST_WORK} and j.scheduled_date between ${from} and ${to}
    group by 1
    order by sum(j.amount) desc
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    contractor: String(r.contractor),
    skipped: Number(r.skipped),
    cancelled: Number(r.cancelled),
    billableSkips: Number(r.billable_skips),
    revenueLost: round(Number(r.revenue_lost)),
    // His one-free-skip rule: skips past the free one are still billed as a
    // completed service, so this much of the "lost" figure can come back.
    stillBillable: round(Number(r.still_billable)),
  }));
}

async function skippedJobs(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    select j.scheduled_date as date,
           coalesce(nullif(u.display_name, ''), u.name, 'Unassigned') as contractor,
           c.id as client_id,
           c.name as client,
           coalesce(s.name, '') as service,
           j.status,
           coalesce(j.skip_reason, '') as reason,
           j.amount,
           coalesce(j.skip_billable, false) as billable
    from jobs j
    join clients c on c.id = j.client_id
    left join services s on s.id = j.service_id
    left join users u on u.id = j.assigned_to_id
    where ${LOST_WORK} and j.scheduled_date between ${from} and ${to}
    order by j.scheduled_date desc, c.name
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    date: String(r.date),
    contractor: String(r.contractor),
    clientId: Number(r.client_id),
    client: String(r.client),
    service: String(r.service),
    status: String(r.status),
    reason: String(r.reason),
    amount: round(Number(r.amount)),
    billable: Boolean(r.billable),
  }));
}

/** Monday of the week the job was scheduled in, as yyyy-mm-dd. */
const WEEK_OF = sql`to_char(date_trunc('week', j.scheduled_date::date), 'YYYY-MM-DD')`;

async function revenueByWeekByContractor(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    select ${WEEK_OF} as week,
           coalesce(nullif(u.display_name, ''), u.name, 'Unassigned') as contractor,
           count(*) as jobs,
           coalesce(sum(j.amount), 0) as revenue
    from jobs j
    left join users u on u.id = j.assigned_to_id
    where ${COMPLETED} and j.scheduled_date between ${from} and ${to}
    group by 1, 2
    order by 1, 4 desc
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    week: String(r.week),
    contractor: String(r.contractor),
    jobs: Number(r.jobs),
    revenue: round(Number(r.revenue)),
  }));
}

async function revenueByWeek(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    select ${WEEK_OF} as week,
           count(*) as jobs,
           count(distinct j.assigned_to_id) as contractors,
           coalesce(sum(j.amount), 0) as revenue
    from jobs j
    where ${COMPLETED} and j.scheduled_date between ${from} and ${to}
    group by 1
    order by 1
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    week: String(r.week),
    jobs: Number(r.jobs),
    contractors: Number(r.contractors),
    revenue: round(Number(r.revenue)),
  }));
}

/**
 * Square footage lives on the customer, not the job: whichever property field
 * he labelled turf ("Turf Sqft" on the import). It is free text — "6,200",
 * "6200 sq ft" — so the first figure in it is what counts (see turfNumber). A
 * customer with no turf figure is counted separately, never as zero.
 *
 * Only services priced on turf count as turf work: a service with no pricing
 * field (mowing, aeration, fertilizer) or one pointed at the turf field. A
 * blow-out priced per zone is not "square footage mowed".
 */
function turfJobsCte(from: string, to: string) {
  return sql`
    turf_jobs as (
      select j.id, j.scheduled_date, j.amount, j.service_id,
             -- Carried through so the per-day report can split the same turf
             -- reading by crew. Reading it a second way would eventually give
             -- two different square-footage totals for the same week.
             j.assigned_to_id,
             ${turfNumber(sql`(select pd.value from jsonb_each_text(c.property_data) pd
                 where lower(pd.key) in ('turf sqft', 'turf sq ft', 'turf square feet', 'turf', 'sqft', 'lawn sqft')
                 limit 1)`)} as sqft
      from jobs j
      join clients c on c.id = j.client_id
      left join services s on s.id = j.service_id
      left join estimate_fields f on f.id = s.pricing_field_id
      where j.status = 'completed'
        and j.scheduled_date between ${from} and ${to}
        and (s.pricing_field_id is null or f.label ilike '%turf%')
    )
  `;
}
async function sqftByWeek(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    with ${turfJobsCte(from, to)}
    select to_char(date_trunc('week', j.scheduled_date::date), 'YYYY-MM-DD') as week,
           count(*) as jobs,
           count(j.sqft) as jobs_with_sqft,
           coalesce(sum(j.sqft), 0) as sqft,
           coalesce(sum(j.amount), 0) as revenue
    from turf_jobs j
    group by 1
    order by 1
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    week: String(r.week),
    jobs: Number(r.jobs),
    jobsWithSqft: Number(r.jobs_with_sqft),
    sqft: Math.round(Number(r.sqft)),
    revenue: round(Number(r.revenue)),
  }));
}

async function sqftByWeekByService(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    with ${turfJobsCte(from, to)}
    select to_char(date_trunc('week', j.scheduled_date::date), 'YYYY-MM-DD') as week,
           coalesce(s.name, 'No service') as service,
           count(*) as jobs,
           count(j.sqft) as jobs_with_sqft,
           coalesce(sum(j.sqft), 0) as sqft,
           coalesce(sum(j.amount), 0) as revenue
    from turf_jobs j
    left join services s on s.id = j.service_id
    group by 1, 2
    order by 1, 5 desc
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    week: String(r.week),
    service: String(r.service),
    jobs: Number(r.jobs),
    jobsWithSqft: Number(r.jobs_with_sqft),
    sqft: Math.round(Number(r.sqft)),
    revenue: round(Number(r.revenue)),
  }));
}

/**
 * Money sitting on accounts that has not been matched to a bill. Two shapes:
 * a payment with no invoice at all (prepaid, or taken before the invoice was
 * raised), and an invoice paid past its total (overpaid). Both are what his
 * old system called "unused amount", and both are what he applies to the next
 * invoice by hand.
 */
async function unappliedPayments(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    select 'unapplied' as kind,
           ${localDay(sql`p.created_at`)} as date,
           c.id as client_id, c.name as client,
           coalesce(c.service_address, '') as address, coalesce(c.city, '') as city,
           p.method, coalesce(p.reference, '') as reference,
           p.amount as amount, p.amount as unused
    from payments p
    join clients c on c.id = p.client_id
    where p.invoice_id is null
      and ${localDay(sql`p.created_at`)} between ${from} and ${to}
    union all
    select 'overpaid' as kind,
           coalesce(i.invoice_date, ${localDay(sql`i.created_at`)}) as date,
           c.id as client_id, c.name as client,
           coalesce(c.service_address, '') as address, coalesce(c.city, '') as city,
           '' as method, 'Invoice #' || coalesce(i.number, i.id)::text as reference,
           i.amount_paid as amount, i.amount_paid - i.total as unused
    from invoices i
    join clients c on c.id = i.client_id
    where i.status <> 'void'
      and i.amount_paid > i.total + 0.005
      and coalesce(i.invoice_date, ${localDay(sql`i.created_at`)}) between ${from} and ${to}
    order by 2 desc, 4
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    date: String(r.date),
    clientId: Number(r.client_id),
    client: String(r.client),
    address: String(r.address),
    city: String(r.city),
    kind: String(r.kind),
    method: String(r.method),
    reference: String(r.reference),
    amount: round(Number(r.amount)),
    unused: round(Number(r.unused)),
  }));
}

/**
 * Emails that did not reach the customer, as far as we can know. Gmail is
 * send-only here (no inbox read), so a bounce that comes back an hour later is
 * invisible; what is recorded is every send Gmail refused, every customer
 * skipped for having no address or being marked do-not-email, and the older
 * letter and estimate sends that failed the same way.
 */
async function emailFailures(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    select ${localDay(sql`e.created_at`)} as date,
           c.id as client_id, coalesce(c.name, '(no customer)') as client,
           coalesce(e.to_email, '') as to_email,
           e.source as source,
           coalesce(e.subject, '') as subject,
           e.status as status,
           coalesce(e.error, e.skip_reason, '') as reason
    from email_sends e
    left join clients c on c.id = e.client_id
    where e.status in ('failed', 'skipped')
      and ${localDay(sql`e.created_at`)} between ${from} and ${to}
    union all
    select ${localDay(sql`l.created_at`)}, c.id, c.name,
           coalesce(l.sent_to_email, ''), 'letter', l.subject, 'failed', coalesce(l.error, '')
    from letter_sends l
    join clients c on c.id = l.client_id
    where l.status = 'failed'
      and ${localDay(sql`l.created_at`)} between ${from} and ${to}
    union all
    select ${localDay(sql`coalesce(es.sent_at, es.created_at)`)}, c.id, c.name,
           coalesce(c.email, ''), 'estimate', 'Estimate #' || es.id::text, 'failed',
           coalesce(es.last_delivery_error, '')
    from estimates es
    join clients c on c.id = es.client_id
    where es.delivery_state = 'failed'
      and ${localDay(sql`coalesce(es.sent_at, es.created_at)`)} between ${from} and ${to}
    order by 1 desc, 3
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    date: String(r.date),
    clientId: r.client_id == null ? null : Number(r.client_id),
    client: String(r.client),
    toEmail: String(r.to_email),
    source: String(r.source),
    subject: String(r.subject),
    status: String(r.status),
    reason: String(r.reason),
  }));
}

/**
 * Feedback 91 — job cost analysis. Per job: the hours and cost it was priced
 * at, against the hours actually clocked. The budget comes from the matrix
 * band the property falls in (budgetedHours / budgetedCost per band), found the
 * same way the price was, from the customer's property figure; a job whose
 * band carries no budget, or whose customer has no figure, shows a blank
 * budget rather than a zero one.
 *
 * There is no pay rate per contractor in the system, so "actual cost" is not
 * invented here: what is real is actual hours, revenue, and revenue per hour.
 */
type JobCostRaw = {
  id: number;
  date: string;
  clientId: number;
  client: string;
  serviceId: number | null;
  service: string;
  contractor: string;
  amount: number;
  budgetedHours: number | null;
  actualHours: number | null;
  pricingEquations: PricingEquation[];
  quantity: number | null;
};

async function jobCostRows(from: string, to: string): Promise<JobCostRaw[]> {
  const result = await db.execute(sql`
    with ${ACTUAL_HOURS_CTE}
    select j.id, j.scheduled_date as date, c.id as client_id, c.name as client,
           s.id as service_id, coalesce(s.name, 'No service') as service,
           coalesce(nullif(u.display_name, ''), u.name, 'Unassigned') as contractor,
           j.amount, j.budgeted_hours, a.hours as actual_hours,
           coalesce(s.pricing_equations, '[]'::jsonb) as pricing_equations,
           ${turfNumber(sql`coalesce(
               (select pd.value from jsonb_each_text(c.property_data) pd where f.id is not null and lower(pd.key) = lower(f.label) limit 1),
               (select pd.value from jsonb_each_text(c.property_data) pd where f.id is null and lower(pd.key) in ('turf sqft', 'turf sq ft', 'turf square feet', 'turf', 'sqft', 'lawn sqft') limit 1)
             )`)} as quantity
    from jobs j
    join clients c on c.id = j.client_id
    left join services s on s.id = j.service_id
    left join estimate_fields f on f.id = s.pricing_field_id
    left join users u on u.id = j.assigned_to_id
    left join actuals a on a.job_id = j.id
    where ${COMPLETED} and j.scheduled_date between ${from} and ${to}
    order by j.scheduled_date desc, c.name
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    date: String(r.date),
    clientId: Number(r.client_id),
    client: String(r.client),
    serviceId: r.service_id == null ? null : Number(r.service_id),
    service: String(r.service),
    contractor: String(r.contractor),
    amount: Number(r.amount),
    budgetedHours: num(r.budgeted_hours),
    actualHours: num(r.actual_hours),
    pricingEquations: Array.isArray(r.pricing_equations) ? (r.pricing_equations as PricingEquation[]) : [],
    quantity: num(r.quantity),
  }));
}

/** The matrix band this job's property falls in, or null when it cannot be told. */
function bandFor(job: JobCostRaw): PricingEquation | null {
  if (job.quantity == null || job.pricingEquations.length === 0) return null;
  const { equationIndex } = calculatePrice(job.pricingEquations, job.quantity);
  return equationIndex == null ? null : job.pricingEquations[equationIndex] ?? null;
}

async function jobCosts(from: string, to: string): Promise<ReportRow[]> {
  const jobs = await jobCostRows(from, to);
  return jobs.map((j) => {
    const band = bandFor(j);
    const budgetedHours = j.budgetedHours ?? band?.budgetedHours ?? null;
    const budgetedCost = band?.budgetedCost ?? null;
    const actual = j.actualHours;
    return {
      date: j.date,
      clientId: j.clientId,
      client: j.client,
      service: j.service,
      contractor: j.contractor,
      revenue: round(j.amount),
      budgetedHours: budgetedHours == null ? null : round(budgetedHours),
      budgetedCost: budgetedCost == null ? null : round(budgetedCost),
      actualHours: actual == null ? null : round(actual),
      varianceHours: actual == null || budgetedHours == null ? null : round(actual - budgetedHours),
      revenuePerHour: actual == null || actual <= 0 ? null : round(j.amount / actual),
      // What is left after the cost he budgeted for the band. Blank when the
      // band has no cost, not zero: no budget is not a free job.
      marginAtBudget: budgetedCost == null ? null : round(j.amount - budgetedCost),
    };
  });
}

async function jobCostsByService(from: string, to: string): Promise<ReportRow[]> {
  const jobs = await jobCostRows(from, to);
  const groups = new Map<
    string,
    { service: string; jobs: number; measured: number; revenue: number; bh: number; bhCount: number; bc: number; bcCount: number; ah: number }
  >();
  for (const j of jobs) {
    const key = j.serviceId == null ? "none" : String(j.serviceId);
    const g = groups.get(key) ?? {
      service: j.service, jobs: 0, measured: 0, revenue: 0, bh: 0, bhCount: 0, bc: 0, bcCount: 0, ah: 0,
    };
    const band = bandFor(j);
    const budgetedHours = j.budgetedHours ?? band?.budgetedHours ?? null;
    const budgetedCost = band?.budgetedCost ?? null;
    g.jobs += 1;
    g.revenue += j.amount;
    if (budgetedCost != null) { g.bc += budgetedCost; g.bcCount += 1; }
    if (j.actualHours != null) {
      g.measured += 1;
      g.ah += j.actualHours;
      // Budget is summed over clocked jobs only so the variance compares like
      // with like — same rule as the costing tables above.
      if (budgetedHours != null) { g.bh += budgetedHours; g.bhCount += 1; }
    }
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .map((g) => ({
      service: g.service,
      jobs: g.jobs,
      measuredJobs: g.measured,
      revenue: round(g.revenue),
      budgetedHours: g.bhCount === 0 ? null : round(g.bh),
      budgetedCost: g.bcCount === 0 ? null : round(g.bc),
      actualHours: g.measured === 0 ? null : round(g.ah),
      varianceHours: g.measured === 0 || g.bhCount === 0 ? null : round(g.ah - g.bh),
      revenuePerHour: g.measured === 0 || g.ah <= 0 ? null : round(g.revenue / g.ah),
      marginAtBudget: g.bcCount === 0 ? null : round(g.revenue - g.bc),
    }));
}

/* ------------------------------------------------------------------------- *
 * 2026-09-28 notes, Reports section. The four he was still missing: a cash
 * report and an accrual report (R1), how long jobs actually take (R2), the
 * spread of crews (R3), and square footage per day per crew (R4).
 * ------------------------------------------------------------------------- */

/**
 * R1. The two reports he ran every month in Service Autopilot, and the reason
 * he wants both rather than one:
 *
 *   cash    — money that actually arrived, counted on the day the payment was
 *             taken. This is the one that ties to his bank statement.
 *   accrual — money he billed, counted on the invoice's own date, whether or
 *             not a cent of it has come in. This is the one that says what the
 *             month earned.
 *
 * A December invoice paid in February is accrual in December and cash in
 * February. That gap is the whole point: cash tells him what he can spend,
 * accrual tells him what the season is worth, and neither one answers the
 * other's question.
 *
 * Both are dated by HIS day, not by UTC, the same as every other report here:
 * a card he takes at 6 in the evening belongs to that evening.
 */
const PAYMENT_DAY = localDay(sql`p.created_at`);
/** An invoice carries its own office date; fall back to the day it was created. */
const INVOICE_DAY = sql`coalesce(i.invoice_date, ${localDay(sql`i.created_at`)})`;

async function cashReport(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    select ${PAYMENT_DAY} as date,
           c.id as client_id, c.name as client,
           p.method,
           coalesce(p.reference, '') as reference,
           case when i.id is null then ''
                else 'Invoice #' || coalesce(i.number, i.id)::text end as invoice,
           p.amount as amount,
           p.card_fee as card_fee
    from payments p
    join clients c on c.id = p.client_id
    left join invoices i on i.id = p.invoice_id
    where ${PAYMENT_DAY} between ${from} and ${to}
    order by 1, c.name
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const amount = Number(r.amount ?? 0);
    const cardFee = Number(r.card_fee ?? 0);
    return {
      date: String(r.date),
      clientId: Number(r.client_id),
      client: String(r.client),
      method: String(r.method),
      reference: String(r.reference),
      invoice: String(r.invoice),
      amount: round(amount),
      cardFee: round(cardFee),
      // What the work actually kept. The card surcharge came in with the
      // payment and went straight back out to the processor, so counting it as
      // takings would flatter every card month by three percent.
      net: round(amount - cardFee),
    };
  });
}

async function accrualReport(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    select ${INVOICE_DAY} as date,
           c.id as client_id, c.name as client,
           'Invoice #' || coalesce(i.number, i.id)::text as invoice,
           i.status as status,
           i.total as total,
           i.amount_paid as amount_paid
    from invoices i
    join clients c on c.id = i.client_id
    -- Void is the one status left out: a voided invoice was never a bill, so
    -- the month never earned it. One waiting in the verify queue IS left in —
    -- the work is done and the money is earned, and showing it is how he spots
    -- a bill that has been sitting there unverified.
    where i.status <> 'void'
      and ${INVOICE_DAY} between ${from} and ${to}
    order by 1, c.name
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const total = Number(r.total ?? 0);
    const amountPaid = Number(r.amount_paid ?? 0);
    const status = String(r.status);
    return {
      date: String(r.date),
      clientId: Number(r.client_id),
      client: String(r.client),
      invoice: String(r.invoice),
      status,
      total: round(total),
      paid: round(amountPaid),
      balance: round(balanceOf({ total, amountPaid, status })),
    };
  });
}

/** Money he decided he is never going to see: written off, or gone to collections. */
const WRITTEN_OFF = sql`i.status in (${sql.join(
  WRITE_OFF_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

/**
 * The same two figures side by side, a month at a time — how he actually reads
 * them. Billed and received will not match in any single month and are not
 * meant to; the gap column is the number he is really after, because a big
 * negative one means a month's invoices have not been paid yet.
 *
 * Except when he gave up on the money. A written-off bill stays in Invoiced,
 * because the month really did earn it and a write-off in September does not
 * un-bill March — but it will never be paid, so it sits in the gap for ever and
 * nothing on the line said why. The Written off column is that explanation: a
 * gap the same size as it is a balance he closed out, not one still coming in.
 */
async function cashVsAccrualByMonth(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    with cash as (
      select to_char((${PAYMENT_DAY})::date, 'YYYY-MM') as month,
             count(*) as payments,
             coalesce(sum(p.amount), 0) as received
      from payments p
      where ${PAYMENT_DAY} between ${from} and ${to}
      group by 1
    ),
    accrual as (
      select to_char((${INVOICE_DAY})::date, 'YYYY-MM') as month,
             count(*) as invoices,
             coalesce(sum(i.total), 0) as invoiced,
             coalesce(sum(i.total) filter (where ${WRITTEN_OFF}), 0) as written_off
      from invoices i
      where i.status <> 'void'
        and ${INVOICE_DAY} between ${from} and ${to}
      group by 1
    )
    select coalesce(a.month, ca.month) as month,
           coalesce(a.invoices, 0) as invoices,
           coalesce(a.invoiced, 0) as invoiced,
           coalesce(a.written_off, 0) as written_off,
           coalesce(ca.payments, 0) as payments,
           coalesce(ca.received, 0) as received
    from accrual a
    full outer join cash ca on ca.month = a.month
    order by 1
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => {
    const invoiced = Number(r.invoiced ?? 0);
    const received = Number(r.received ?? 0);
    return {
      month: String(r.month),
      invoices: Number(r.invoices ?? 0),
      invoiced: round(invoiced),
      writtenOff: round(Number(r.written_off ?? 0)),
      payments: Number(r.payments ?? 0),
      received: round(received),
      gap: round(received - invoiced),
    };
  });
}

/**
 * R2 — "time to complete jobs".
 *
 * Two different numbers come out of the clock, and he needs them kept apart:
 *   crew hours  — every closed entry added up. Two people for an hour is two
 *                 crew hours, and this is the number the budget is written in.
 *   on site     — first clock-in to last clock-out on the job. Two people for
 *                 an hour is one hour on site, and this is "how long did it
 *                 take", which is what he asked.
 *
 * Open entries are ignored, the same as everywhere else here: someone who
 * forgot to clock out would otherwise make a job look like it took all night.
 * A job nobody clocked has no time at all and is simply not in these rows —
 * counted as zero it would make every average look better than the work was.
 */
type JobTiming = { crewHours: number; onSiteHours: number; people: number };

// One definition of "closed clock entries on completed work in this range",
// used by both halves of the report so the two can never cover slightly
// different work. The users join is on a non-null foreign key, so it cannot
// drop an entry; it is here because the per-person half needs the name.
const CLOSED_ENTRIES_IN_RANGE = (from: string, to: string) => sql`
  from job_time_entries e
  join jobs j on j.id = e.job_id
  join users u on u.id = e.user_id
  where e.clock_out_at is not null
    and ${COMPLETED}
    and j.scheduled_date between ${from} and ${to}
`;

async function jobTimings(from: string, to: string): Promise<Map<number, JobTiming>> {
  const result = await db.execute(sql`
    select e.job_id,
           sum(extract(epoch from (e.clock_out_at - e.clock_in_at)) / 3600.0) as crew_hours,
           extract(epoch from (max(e.clock_out_at) - min(e.clock_in_at))) / 3600.0 as on_site_hours,
           count(distinct e.user_id) as people
    ${CLOSED_ENTRIES_IN_RANGE(from, to)}
    group by 1
  `);
  const map = new Map<number, JobTiming>();
  for (const r of result.rows as Array<Record<string, unknown>>) {
    map.set(Number(r.job_id), {
      crewHours: Number(r.crew_hours ?? 0),
      onSiteHours: Number(r.on_site_hours ?? 0),
      people: Number(r.people ?? 0),
    });
  }
  return map;
}

/** Hours one person clocked on one job. The per-contractor half of R2. */
async function jobTimingsByPerson(from: string, to: string) {
  const result = await db.execute(sql`
    select e.job_id, e.user_id,
           coalesce(nullif(u.display_name, ''), u.name, 'Unknown') as person,
           sum(extract(epoch from (e.clock_out_at - e.clock_in_at)) / 3600.0) as hours
    ${CLOSED_ENTRIES_IN_RANGE(from, to)}
    group by 1, 2, 3
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    jobId: Number(r.job_id),
    userId: Number(r.user_id),
    person: String(r.person),
    hours: Number(r.hours ?? 0),
  }));
}

/**
 * The budget to put next to the actual. Same rule as the job cost report: the
 * job's own budgeted hours when it has them, otherwise the hours written on the
 * matrix band the property falls in. A job with neither shows a blank budget,
 * never a zero one — no budget is not a free job.
 */
const budgetFor = (job: JobCostRaw): number | null => job.budgetedHours ?? bandFor(job)?.budgetedHours ?? null;

const avg = (total: number, count: number) => (count === 0 ? null : round(total / count, 2));

async function timeToCompleteByService(from: string, to: string): Promise<ReportRow[]> {
  const [jobs, timings] = await Promise.all([jobCostRows(from, to), jobTimings(from, to)]);
  type Bucket = {
    service: string; jobs: number; onSite: number; crew: number; people: number;
    budget: number; budgetCount: number; crewWithBudget: number;
    fastest: number | null; slowest: number | null;
  };
  const groups = new Map<string, Bucket>();
  for (const job of jobs) {
    const timing = timings.get(job.id);
    if (!timing) continue;
    const key = job.serviceId == null ? "none" : String(job.serviceId);
    const g = groups.get(key) ?? {
      service: job.service, jobs: 0, onSite: 0, crew: 0, people: 0,
      budget: 0, budgetCount: 0, crewWithBudget: 0, fastest: null, slowest: null,
    };
    g.jobs += 1;
    g.onSite += timing.onSiteHours;
    g.crew += timing.crewHours;
    g.people += timing.people;
    const budget = budgetFor(job);
    // The variance below is only allowed to see the jobs that HAVE a budget, so
    // their hours are kept apart as they are added. A customer with no turf
    // figure gives a job no budget at all, and charging its hours against an
    // average budget it never had would print a fat overrun on a service he
    // priced right.
    if (budget != null) { g.budget += budget; g.budgetCount += 1; g.crewWithBudget += timing.crewHours; }
    g.fastest = g.fastest == null ? timing.onSiteHours : Math.min(g.fastest, timing.onSiteHours);
    g.slowest = g.slowest == null ? timing.onSiteHours : Math.max(g.slowest, timing.onSiteHours);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.crew - a.crew)
    .map((g) => {
      const avgBudget = avg(g.budget, g.budgetCount);
      const avgCrew = avg(g.crew, g.jobs);
      // Both halves over the budgeted jobs only, so the subtraction is the same
      // work on both sides. It will not always equal the two columns beside it,
      // and that is why "With budget" is on the row next to it.
      const avgCrewWithBudget = avg(g.crewWithBudget, g.budgetCount);
      return {
        service: g.service,
        jobs: g.jobs,
        budgetedJobs: g.budgetCount,
        avgBudgetedHours: avgBudget,
        avgOnSiteHours: avg(g.onSite, g.jobs),
        avgCrewHours: avgCrew,
        avgCrew: avg(g.people, g.jobs),
        // Crew hours against the budget, not time on site: the budget is
        // written as crew hours, so comparing it to a two-man hour would say
        // every job came in early.
        varianceHours:
          avgBudget == null || avgCrewWithBudget == null ? null : round(avgCrewWithBudget - avgBudget, 2),
        fastestHours: g.fastest == null ? null : round(g.fastest, 2),
        slowestHours: g.slowest == null ? null : round(g.slowest, 2),
        totalCrewHours: round(g.crew, 2),
      };
    });
}

async function timeToCompleteByContractor(from: string, to: string): Promise<ReportRow[]> {
  const [jobs, perPerson, timings] = await Promise.all([
    jobCostRows(from, to),
    jobTimingsByPerson(from, to),
    jobTimings(from, to),
  ]);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  type Bucket = {
    contractor: string; jobs: number; hours: number; shared: number;
    budget: number; budgetCount: number; hoursWithBudget: number;
    fastest: number | null; slowest: number | null;
  };
  const groups = new Map<number, Bucket>();
  for (const entry of perPerson) {
    const job = byId.get(entry.jobId);
    if (!job) continue;
    const g = groups.get(entry.userId) ?? {
      contractor: entry.person, jobs: 0, hours: 0, shared: 0,
      budget: 0, budgetCount: 0, hoursWithBudget: 0, fastest: null, slowest: null,
    };
    g.jobs += 1;
    g.hours += entry.hours;
    // A job two people clocked carries its whole budget into both their rows —
    // there is no way to split one budget between two men, and hiding the count
    // would make a shared job look like someone ran badly over on their own.
    if ((timings.get(entry.jobId)?.people ?? 1) > 1) g.shared += 1;
    const budget = budgetFor(job);
    // Same rule as the service half: a job with no budget keeps its hours out
    // of the variance, or the man gets billed for an overrun on a job nobody
    // ever gave him a number for.
    if (budget != null) { g.budget += budget; g.budgetCount += 1; g.hoursWithBudget += entry.hours; }
    g.fastest = g.fastest == null ? entry.hours : Math.min(g.fastest, entry.hours);
    g.slowest = g.slowest == null ? entry.hours : Math.max(g.slowest, entry.hours);
    groups.set(entry.userId, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.hours - a.hours)
    .map((g) => {
      const avgBudget = avg(g.budget, g.budgetCount);
      const avgHours = avg(g.hours, g.jobs);
      const avgHoursWithBudget = avg(g.hoursWithBudget, g.budgetCount);
      return {
        contractor: g.contractor,
        jobs: g.jobs,
        budgetedJobs: g.budgetCount,
        sharedJobs: g.shared,
        avgBudgetedHours: avgBudget,
        avgHours,
        varianceHours:
          avgBudget == null || avgHoursWithBudget == null ? null : round(avgHoursWithBudget - avgBudget, 2),
        fastestHours: g.fastest == null ? null : round(g.fastest, 2),
        slowestHours: g.slowest == null ? null : round(g.slowest, 2),
        totalHours: round(g.hours, 2),
      };
    });
}

/**
 * R3 — "spread of crews". Who is loaded and who is light, over a range.
 *
 * A stop is a visit on the board with that contractor's name on it. Cancelled
 * visits are left out because nobody ever drove to them; skips are counted,
 * because he still routed the man there and the day was still spent.
 *
 * Hours come from the contractor's OWN clock entries, not from the jobs
 * assigned to him, so a day spent helping on somebody else's clean-up shows up
 * as his hours — which is the point of the report.
 *
 * Which is also why the list of men is not the list of leads. The second man in
 * the truck on a clean-up is crew, never the assigned name, so a sub who only
 * ever helps would have had no line at all and his hours would have gone
 * missing out of the total. Everyone the range touched gets a line: whoever was
 * assigned a visit, whoever was added to a crew, and whoever clocked. A man
 * with hours and no visits of his own reads as 0 stops and his real hours,
 * which is exactly the "he is light" answer the report is for.
 *
 * The two share columns are what makes it readable at a glance: four men on an
 * even split sit near 25% each, and the man at 9% is the light one.
 */
async function crewSpread(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    with assigned as (
      select j.id, j.assigned_to_id, j.scheduled_date, j.status, j.amount
      from jobs j
      where j.scheduled_date between ${from} and ${to}
        and j.status <> 'cancelled'
    ),
    clocked as (
      select e.user_id,
             sum(extract(epoch from (e.clock_out_at - e.clock_in_at)) / 3600.0) as hours
      from job_time_entries e
      join jobs j on j.id = e.job_id
      where e.clock_out_at is not null
        and j.scheduled_date between ${from} and ${to}
      group by 1
    ),
    -- Everyone the range touched. The null in here is the "Unassigned" line:
    -- visits with nobody's name on them still have to be shown, not dropped.
    people as (
      select distinct a.assigned_to_id as user_id from assigned a
      union
      select h.user_id from clocked h
      union
      select jc.user_id from job_crew jc join assigned a on a.id = jc.job_id
    )
    select coalesce(nullif(u.display_name, ''), u.name, 'Unassigned') as contractor,
           count(a.id) as stops,
           count(a.id) filter (where a.status = 'completed') as completed,
           count(a.id) filter (where a.status = 'skipped') as skipped,
           count(distinct a.scheduled_date) as days,
           coalesce(sum(a.amount) filter (where a.status = 'completed'), 0) as revenue,
           -- clocked holds one row per man, so max is that man's hours.
           coalesce(max(h.hours), 0) as hours
    from people p
    left join users u on u.id = p.user_id
    left join assigned a on a.assigned_to_id is not distinct from p.user_id
    left join clocked h on h.user_id = p.user_id
    group by p.user_id, u.display_name, u.name
    order by count(a.id) desc, coalesce(max(h.hours), 0) desc
  `);
  const rows = (result.rows as Array<Record<string, unknown>>).map((r) => ({
    contractor: String(r.contractor),
    stops: Number(r.stops ?? 0),
    completed: Number(r.completed ?? 0),
    skipped: Number(r.skipped ?? 0),
    days: Number(r.days ?? 0),
    hours: round(Number(r.hours ?? 0), 2),
    revenue: round(Number(r.revenue ?? 0)),
  }));
  const allStops = rows.reduce((sum, r) => sum + r.stops, 0);
  const allRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
  return rows.map((r) => ({
    ...r,
    stopsPerDay: r.days === 0 ? null : round(r.stops / r.days, 1),
    revenuePerStop: r.stops === 0 ? null : round(r.revenue / r.stops),
    shareOfStops: allStops === 0 ? null : round((r.stops / allStops) * 100, 1),
    shareOfRevenue: allRevenue === 0 ? null : round((r.revenue / allRevenue) * 100, 1),
  }));
}

/**
 * R4 — "sqft in a day per crew". The same turf reading as the weekly report,
 * cut by the day and by whose name was on the visit, because a week is too
 * coarse to tell him whether a man can take another lawn on a Tuesday.
 */
async function sqftByDay(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    with ${turfJobsCte(from, to)},
    -- Who actually worked the day: the man whose name is on the visit AND the
    -- rest of the truck. Counting assigned names alone said "0 crews" on a day
    -- of unassigned stops, and read a two-man clean-up as one crew.
    day_people as (
      select j.scheduled_date as day, j.assigned_to_id as user_id
      from turf_jobs j
      where j.assigned_to_id is not null
      union
      select j.scheduled_date as day, jc.user_id
      from turf_jobs j
      join job_crew jc on jc.job_id = j.id
    ),
    day_crews as (
      select day, count(distinct user_id) as crews from day_people group by 1
    )
    select j.scheduled_date as day,
           count(*) as jobs,
           count(j.sqft) as jobs_with_sqft,
           dc.crews as contractors,
           coalesce(sum(j.sqft), 0) as sqft,
           coalesce(sum(j.amount), 0) as revenue
    from turf_jobs j
    left join day_crews dc on dc.day = j.scheduled_date
    group by 1, dc.crews
    order by 1
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    day: String(r.day),
    jobs: Number(r.jobs),
    jobsWithSqft: Number(r.jobs_with_sqft),
    // Blank, not nought: a day whose stops carry nobody's name has no crew
    // count to give, and a "0" there looks like the work did itself.
    contractors: r.contractors == null ? null : Number(r.contractors),
    sqft: Math.round(Number(r.sqft)),
    revenue: round(Number(r.revenue)),
  }));
}

async function sqftByDayByContractor(from: string, to: string): Promise<ReportRow[]> {
  const result = await db.execute(sql`
    with ${turfJobsCte(from, to)}
    select j.scheduled_date as day,
           coalesce(nullif(u.display_name, ''), u.name, 'Unassigned') as contractor,
           count(*) as jobs,
           count(j.sqft) as jobs_with_sqft,
           coalesce(sum(j.sqft), 0) as sqft,
           coalesce(sum(j.amount), 0) as revenue
    from turf_jobs j
    left join users u on u.id = j.assigned_to_id
    group by 1, 2
    order by 1, 5 desc
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    day: String(r.day),
    contractor: String(r.contractor),
    jobs: Number(r.jobs),
    jobsWithSqft: Number(r.jobs_with_sqft),
    sqft: Math.round(Number(r.sqft)),
    revenue: round(Number(r.revenue)),
  }));
}

/** The named reports the AI layer is allowed to choose between. */
export const REPORTS: Record<string, ReportDef> = {
  costing_by_sub: {
    title: "Budgeted vs actual hours by crew",
    describes: "which crew members run over or under the time their jobs were priced for",
    asks: ["Which contractors run over the hours their jobs were priced for?"],
    keywords: ["crew", "contractor", "over budget", "under budget", "hours", "actual"],
    columns: COSTING_COLUMNS,
    run: costingBySub,
  },
  costing_by_service: {
    title: "Budgeted vs actual hours by service",
    describes: "which services are priced for the wrong amount of time, and what each earns per hour",
    asks: ["Which services earn the least per hour?"],
    keywords: ["service", "per hour", "priced", "hours", "earns"],
    columns: COSTING_COLUMNS,
    run: costingByService,
  },
  costing_by_client: {
    title: "Customers whose work runs over budget",
    describes: "which customers take longer than they were quoted for, worst first",
    asks: ["Which customers take longer than I quoted?"],
    keywords: ["customer", "client", "longer", "quoted", "over"],
    columns: COSTING_COLUMNS,
    run: costingByClient,
  },
  unbilled_completed_work: {
    title: "Completed work not yet invoiced",
    describes: "work that is finished and has not been billed to the customer",
    asks: ["What finished work has not been invoiced yet?"],
    keywords: ["unbilled", "not invoiced", "not billed", "uninvoiced", "finished"],
    columns: COSTING_COLUMNS.slice(0, 4),
    totals: ["revenue"],
    run: unbilledCompletedWork,
  },
  skips_by_contractor: {
    title: "Skipped and cancelled jobs per contractor",
    describes: "how many jobs each contractor skipped or cancelled, and the revenue lost",
    asks: ["How many jobs did each contractor skip or cancel, and how much revenue was lost?"],
    keywords: ["skip", "skipped", "skips", "cancel", "cancelled", "canceled", "lost", "lose", "losing", "loss", "revenue lost", "missed"],
    columns: [
      { key: "contractor", label: "Contractor", kind: "text" },
      { key: "skipped", label: "Skipped", kind: "number" },
      { key: "cancelled", label: "Cancelled", kind: "number" },
      { key: "billableSkips", label: "Billable skips", kind: "number" },
      { key: "revenueLost", label: "Revenue lost", kind: "money" },
      { key: "stillBillable", label: "Still billable", kind: "money" },
    ],
    totals: ["skipped", "cancelled", "billableSkips", "revenueLost", "stillBillable"],
    run: skipsByContractor,
  },
  skipped_jobs: {
    title: "Skipped and cancelled jobs, one per line",
    describes: "every skipped or cancelled visit with the customer, contractor, reason and amount",
    asks: ["Show me each job that was skipped or cancelled and why."],
    keywords: ["skipped jobs", "which jobs", "reason", "why skipped", "cancelled jobs"],
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "client", label: "Customer", kind: "link" },
      { key: "service", label: "Service", kind: "text" },
      { key: "contractor", label: "Contractor", kind: "text" },
      { key: "status", label: "Status", kind: "text" },
      { key: "reason", label: "Reason", kind: "text" },
      { key: "amount", label: "Amount", kind: "money" },
      { key: "billable", label: "Billable", kind: "text" },
    ],
    totals: ["amount"],
    run: skippedJobs,
  },
  revenue_by_week_by_contractor: {
    title: "Revenue per week per contractor",
    describes: "completed-job revenue for each contractor, week by week",
    asks: ["How much revenue did each contractor bring in per week?"],
    keywords: ["revenue", "week", "weekly", "contractor", "per week", "each week"],
    columns: [
      { key: "week", label: "Week of", kind: "date" },
      { key: "contractor", label: "Contractor", kind: "text" },
      { key: "jobs", label: "Jobs", kind: "number" },
      { key: "revenue", label: "Revenue", kind: "money" },
    ],
    totals: ["jobs", "revenue"],
    run: revenueByWeekByContractor,
  },
  revenue_by_week: {
    title: "Revenue per week",
    describes: "completed-job revenue for the whole company, week by week",
    asks: ["How much revenue came in each week?"],
    keywords: ["revenue", "week", "weekly", "total", "company"],
    columns: [
      { key: "week", label: "Week of", kind: "date" },
      { key: "jobs", label: "Jobs", kind: "number" },
      { key: "contractors", label: "Contractors", kind: "number" },
      { key: "revenue", label: "Revenue", kind: "money" },
    ],
    totals: ["jobs", "revenue"],
    run: revenueByWeek,
  },
  sqft_by_week: {
    title: "Turf square footage per week",
    describes: "square feet of turf worked per week on completed turf-priced jobs (mowing, aeration, fertilizer), from each customer's turf sqft",
    asks: ["How many square feet did we mow each week?"],
    keywords: ["sqft", "sq ft", "square", "footage", "feet", "mow", "mowed", "turf", "acres"],
    columns: [
      { key: "week", label: "Week of", kind: "date" },
      { key: "jobs", label: "Jobs", kind: "number" },
      { key: "jobsWithSqft", label: "With sqft", kind: "number" },
      { key: "sqft", label: "Sqft", kind: "sqft" },
      { key: "revenue", label: "Revenue", kind: "money" },
    ],
    totals: ["jobs", "jobsWithSqft", "sqft", "revenue"],
    run: sqftByWeek,
  },
  sqft_by_week_by_service: {
    title: "Turf square footage per week, by service",
    describes: "the same square footage per week, split by service so mowing can be read on its own",
    asks: ["How many square feet per week, split by service?"],
    keywords: ["sqft", "square", "footage", "by service", "mowing", "aeration"],
    columns: [
      { key: "week", label: "Week of", kind: "date" },
      { key: "service", label: "Service", kind: "text" },
      { key: "jobs", label: "Jobs", kind: "number" },
      { key: "jobsWithSqft", label: "With sqft", kind: "number" },
      { key: "sqft", label: "Sqft", kind: "sqft" },
      { key: "revenue", label: "Revenue", kind: "money" },
    ],
    totals: ["jobs", "jobsWithSqft", "sqft", "revenue"],
    run: sqftByWeekByService,
  },
  sqft_by_day_by_contractor: {
    title: "Turf square footage per day, per crew",
    describes: "square feet of turf each man got through on each day, from the same turf figure as the weekly report",
    asks: ["How many square feet did each crew do in a day?"],
    keywords: ["sqft per day", "square feet a day", "sqft in a day", "per day", "a day", "daily sqft", "crew sqft"],
    columns: [
      { key: "day", label: "Day", kind: "date" },
      { key: "contractor", label: "Contractor", kind: "text" },
      { key: "jobs", label: "Stops", kind: "number" },
      { key: "jobsWithSqft", label: "With sqft", kind: "number" },
      { key: "sqft", label: "Sqft", kind: "sqft" },
      { key: "revenue", label: "Revenue", kind: "money" },
    ],
    totals: ["jobs", "jobsWithSqft", "sqft", "revenue"],
    run: sqftByDayByContractor,
  },
  sqft_by_day: {
    title: "Turf square footage per day",
    describes: "square feet of turf for the whole company, day by day",
    asks: ["How many square feet did we do each day?"],
    keywords: ["sqft a day", "square footage per day", "whole day", "day by day", "each day"],
    columns: [
      { key: "day", label: "Day", kind: "date" },
      { key: "jobs", label: "Stops", kind: "number" },
      { key: "jobsWithSqft", label: "With sqft", kind: "number" },
      { key: "contractors", label: "Crews", kind: "number" },
      { key: "sqft", label: "Sqft", kind: "sqft" },
      { key: "revenue", label: "Revenue", kind: "money" },
    ],
    totals: ["jobs", "jobsWithSqft", "sqft", "revenue"],
    run: sqftByDay,
  },
  cash_report: {
    title: "Cash report — money received",
    describes:
      "every payment that actually came in, counted on the day you took it, paid invoice or not — this is the one that ties to the bank",
    asks: ["Cash report: what money came in?"],
    keywords: ["cash", "cash report", "cash basis", "money in", "money received", "received", "collected", "deposits", "came in"],
    columns: [
      { key: "date", label: "Date paid", kind: "date" },
      { key: "client", label: "Customer", kind: "link" },
      { key: "method", label: "Paid by", kind: "text" },
      { key: "reference", label: "Ref", kind: "text" },
      { key: "invoice", label: "Against", kind: "text" },
      { key: "amount", label: "Amount", kind: "money" },
      { key: "cardFee", label: "Card fee", kind: "money" },
      { key: "net", label: "Net", kind: "money" },
    ],
    totals: ["amount", "cardFee", "net"],
    run: cashReport,
  },
  accrual_report: {
    title: "Accrual report — money invoiced",
    describes:
      "every invoice dated in the period with what is still owed on it, paid or not — this is the one that says what the period earned",
    asks: ["Accrual report: what did I invoice?"],
    keywords: ["accrual", "accrual report", "accrual basis", "invoiced", "billed", "what i billed", "earned", "booked"],
    columns: [
      { key: "date", label: "Invoice date", kind: "date" },
      { key: "client", label: "Customer", kind: "link" },
      { key: "invoice", label: "Invoice", kind: "text" },
      { key: "status", label: "Status", kind: "text" },
      { key: "total", label: "Invoiced", kind: "money" },
      { key: "paid", label: "Paid", kind: "money" },
      { key: "balance", label: "Still owed", kind: "money" },
    ],
    totals: ["total", "paid", "balance"],
    run: accrualReport,
  },
  cash_vs_accrual_by_month: {
    title: "Cash against accrual, month by month",
    describes:
      "billed against received for each month, with the gap — a big negative gap means that month's invoices have not been paid yet, unless it is money you wrote off",
    asks: ["How does the money I billed compare to the money I received, month by month?"],
    keywords: ["cash vs accrual", "cash against accrual", "billed vs received", "by month", "each month", "monthly", "gap"],
    columns: [
      { key: "month", label: "Month", kind: "date" },
      { key: "invoices", label: "Invoices", kind: "number" },
      { key: "invoiced", label: "Invoiced (accrual)", kind: "money" },
      // So a gap he closed out himself cannot read as money still coming in.
      { key: "writtenOff", label: "Written off", kind: "money" },
      { key: "payments", label: "Payments", kind: "number" },
      { key: "received", label: "Received (cash)", kind: "money" },
      { key: "gap", label: "Gap", kind: "money" },
    ],
    totals: ["invoices", "invoiced", "writtenOff", "payments", "received", "gap"],
    run: cashVsAccrualByMonth,
  },
  time_to_complete_by_service: {
    title: "Time to complete jobs, by service",
    describes:
      "how long each service actually takes — time on site and crew hours from the clock — next to the hours it was budgeted for",
    asks: ["How long do jobs actually take, by service?"],
    keywords: ["time to complete", "how long", "take", "takes", "taking", "on site", "time on site", "duration", "actually takes"],
    columns: [
      { key: "service", label: "Service", kind: "text" },
      { key: "jobs", label: "Clocked jobs", kind: "number" },
      // How many of those jobs had a budget to compare against. The variance is
      // worked out over these and no others.
      { key: "budgetedJobs", label: "With budget", kind: "number" },
      { key: "avgBudgetedHours", label: "Budget avg", kind: "hours" },
      { key: "avgOnSiteHours", label: "On site avg", kind: "hours" },
      { key: "avgCrewHours", label: "Crew hrs avg", kind: "hours" },
      { key: "avgCrew", label: "Men on job", kind: "number" },
      { key: "varianceHours", label: "Variance", kind: "hours" },
      { key: "fastestHours", label: "Fastest", kind: "hours" },
      { key: "slowestHours", label: "Slowest", kind: "hours" },
      { key: "totalCrewHours", label: "Crew hrs total", kind: "hours" },
    ],
    // Averages are not summable, so only the counts and the real totals are
    // added up. A "total of the averages" line would be a made-up number.
    totals: ["jobs", "budgetedJobs", "totalCrewHours"],
    run: timeToCompleteByService,
  },
  time_to_complete_by_contractor: {
    title: "Time to complete jobs, by contractor",
    describes:
      "the hours each man actually clocked per job against the hours those jobs were budgeted for, with how many of them he shared with someone else",
    asks: ["How long does each contractor take on a job?"],
    keywords: ["how long does each", "time per contractor", "hours per job", "clocked", "clock", "shared job", "faster", "slower"],
    columns: [
      { key: "contractor", label: "Contractor", kind: "text" },
      { key: "jobs", label: "Clocked jobs", kind: "number" },
      // Only these jobs are in the variance — the rest never had a budget.
      { key: "budgetedJobs", label: "With budget", kind: "number" },
      { key: "sharedJobs", label: "Shared", kind: "number" },
      { key: "avgBudgetedHours", label: "Budget avg", kind: "hours" },
      { key: "avgHours", label: "His hrs avg", kind: "hours" },
      { key: "varianceHours", label: "Variance", kind: "hours" },
      { key: "fastestHours", label: "Fastest", kind: "hours" },
      { key: "slowestHours", label: "Slowest", kind: "hours" },
      { key: "totalHours", label: "His hrs total", kind: "hours" },
    ],
    totals: ["jobs", "budgetedJobs", "sharedJobs", "totalHours"],
    run: timeToCompleteByContractor,
  },
  crew_spread: {
    title: "Spread of crews",
    describes: "how the work is spread: stops, days out, clocked hours and revenue per contractor, with each man's share",
    asks: ["How is the work spread across the crews?"],
    keywords: ["spread", "spread of crews", "distributed", "distribution", "loaded", "light", "busy", "stops", "workload", "even"],
    columns: [
      { key: "contractor", label: "Contractor", kind: "text" },
      { key: "stops", label: "Stops", kind: "number" },
      { key: "completed", label: "Done", kind: "number" },
      { key: "skipped", label: "Skipped", kind: "number" },
      { key: "days", label: "Days out", kind: "number" },
      { key: "stopsPerDay", label: "Stops / day", kind: "number" },
      { key: "hours", label: "Clocked hrs", kind: "hours" },
      { key: "revenue", label: "Revenue", kind: "money" },
      { key: "revenuePerStop", label: "$ / stop", kind: "money" },
      { key: "shareOfStops", label: "% of stops", kind: "number" },
      { key: "shareOfRevenue", label: "% of money", kind: "number" },
    ],
    totals: ["stops", "completed", "skipped", "hours", "revenue"],
    run: crewSpread,
  },
  unapplied_payments: {
    title: "Unapplied, prepaid and overpaid payments",
    describes: "money on customer accounts that is not matched to an invoice: payments with no invoice, and invoices paid past their total",
    asks: ["Which payments are unapplied, prepaid or overpaid?"],
    keywords: ["unapplied", "prepaid", "prepay", "overpaid", "credit", "unused", "payments", "not applied"],
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "client", label: "Customer", kind: "link" },
      { key: "address", label: "Address", kind: "text" },
      { key: "city", label: "City", kind: "text" },
      { key: "kind", label: "Kind", kind: "text" },
      { key: "method", label: "Paid by", kind: "text" },
      { key: "reference", label: "Ref", kind: "text" },
      { key: "amount", label: "Amount", kind: "money" },
      { key: "unused", label: "Unused", kind: "money" },
    ],
    totals: ["amount", "unused"],
    run: unappliedPayments,
  },
  email_failures: {
    title: "Emails that did not send",
    describes: "emails Gmail refused or that were skipped for no address or do-not-email; bounces that come back later cannot be seen",
    asks: ["Which emails bounced or failed to send?"],
    keywords: ["email", "emails", "bounce", "bounced", "failed", "undeliverable", "did not send", "skipped email"],
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "client", label: "Customer", kind: "link" },
      { key: "toEmail", label: "To", kind: "text" },
      { key: "source", label: "From", kind: "text" },
      { key: "subject", label: "Subject", kind: "text" },
      { key: "status", label: "Status", kind: "text" },
      { key: "reason", label: "Reason", kind: "text" },
    ],
    run: emailFailures,
  },
  job_costs: {
    title: "Job cost, one job per line",
    describes: "each completed job with its budgeted hours and cost from the matrix band against the hours actually clocked",
    asks: ["Show me the cost of each job: budgeted hours and cost against actual hours."],
    keywords: ["job cost", "cost", "budgeted", "budget", "actual", "each job", "per job", "margin"],
    columns: [
      { key: "date", label: "Date", kind: "date" },
      { key: "client", label: "Customer", kind: "link" },
      { key: "service", label: "Service", kind: "text" },
      { key: "contractor", label: "Contractor", kind: "text" },
      { key: "revenue", label: "Revenue", kind: "money" },
      { key: "budgetedHours", label: "Budget hrs", kind: "hours" },
      { key: "budgetedCost", label: "Budget cost", kind: "money" },
      { key: "actualHours", label: "Actual hrs", kind: "hours" },
      { key: "varianceHours", label: "Variance", kind: "hours" },
      { key: "revenuePerHour", label: "$ / hour", kind: "money" },
      { key: "marginAtBudget", label: "Margin at budget", kind: "money" },
    ],
    totals: ["revenue", "budgetedHours", "budgetedCost", "actualHours", "marginAtBudget"],
    run: jobCosts,
  },
  job_costs_by_service: {
    title: "Job cost by service",
    describes: "budgeted hours and cost against actual hours, totalled per service",
    asks: ["What does each service cost against what it was budgeted?"],
    keywords: ["job cost", "cost by service", "budgeted cost", "margin", "per service", "service cost"],
    columns: [
      { key: "service", label: "Service", kind: "text" },
      { key: "jobs", label: "Jobs", kind: "number" },
      { key: "measuredJobs", label: "Clocked", kind: "number" },
      { key: "revenue", label: "Revenue", kind: "money" },
      { key: "budgetedHours", label: "Budget hrs", kind: "hours" },
      { key: "budgetedCost", label: "Budget cost", kind: "money" },
      { key: "actualHours", label: "Actual hrs", kind: "hours" },
      { key: "varianceHours", label: "Variance", kind: "hours" },
      { key: "revenuePerHour", label: "$ / hour", kind: "money" },
      { key: "marginAtBudget", label: "Margin at budget", kind: "money" },
    ],
    totals: ["jobs", "measuredJobs", "revenue", "budgetedHours", "budgetedCost", "actualHours", "marginAtBudget"],
    run: jobCostsByService,
  },
};

export type ReportKey = keyof typeof REPORTS;

export function isReportKey(value: string): value is ReportKey {
  return Object.prototype.hasOwnProperty.call(REPORTS, value);
}

/** Totals row for the columns the report marks summable; null when it has none. */
export function totalsOf(report: ReportDef, rows: ReportRow[]): Record<string, number> | null {
  if (!report.totals?.length) return null;
  const totals: Record<string, number> = {};
  for (const key of report.totals) {
    let sum = 0;
    for (const row of rows) {
      const v = row[key];
      if (typeof v === "number") sum += v;
    }
    totals[key] = round(sum);
  }
  return totals;
}

/** The catalogue the picker and the AI router both read from. */
export function reportCatalogue() {
  return Object.entries(REPORTS).map(([key, r]) => ({
    key,
    title: r.title,
    describes: r.describes,
    asks: r.asks,
    columns: r.columns,
  }));
}

/**
 * Report rows as a spreadsheet file. Quoted the plain way Excel expects; money
 * and hours are left as bare numbers so the sheet can add them up.
 */
export function toCsv(report: ReportDef, rows: ReportRow[]): string {
  const quote = (v: unknown) => {
    if (v == null) return "";
    const s = typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [report.columns.map((c) => quote(c.label)).join(",")];
  for (const row of rows) lines.push(report.columns.map((c) => quote(row[c.key])).join(","));
  const totals = totalsOf(report, rows);
  if (totals) {
    lines.push(
      report.columns
        .map((c, i) => (i === 0 ? "Total" : totals[c.key] == null ? "" : String(totals[c.key])))
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
