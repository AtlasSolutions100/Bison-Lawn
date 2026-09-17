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
