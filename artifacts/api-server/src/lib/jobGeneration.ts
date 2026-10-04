import { db, jobsTable, estimateFieldsTable } from "@workspace/db";
import type { Client, ClientService, EstimateField, Service } from "@workspace/db";
import { and, eq, gt, gte, inArray, or } from "drizzle-orm";
import { numericFieldValue, priceService, pricingFieldOf, roundMoney, type Executor } from "./helpers";

/**
 * Turning an assigned service into visits on the board.
 *
 * Everything that creates jobs from a client_services row goes through here:
 * assigning, editing the schedule, pausing and resuming, and the nightly
 * renewal. One place, so a monthly-week-2 mow lands on the same Tuesday
 * whichever path asked for it.
 */

/** Ceiling on visits one assignment can put on the board in one go. */
export const MAX_GENERATED_JOBS = 60;

// ---- dates (UTC parts throughout; the columns are yyyy-mm-dd text) ----

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function plusDays(isoDate: string, days: number): string {
  const d = parse(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/** 0 = Sunday … 6 = Saturday, the way `Date#getUTCDay` and the picker count. */
export function weekdayOf(isoDate: string): number {
  return parse(isoDate).getUTCDay();
}

/**
 * ISO-8601 week number. His current CRM labels every week "Week 38 (Even
 * Week)" and his bi-weekly schedules are "Wednesday - Odd Weeks", so the
 * parity has to come from the same numbering or the crews land on the wrong
 * week the first time the calendar year turns.
 */
export function isoWeekNumber(isoDate: string): number {
  const d = parse(isoDate);
  // Thursday of this week decides which year the week belongs to.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
}

export function weekParityOf(isoDate: string): "odd" | "even" {
  return isoWeekNumber(isoDate) % 2 === 0 ? "even" : "odd";
}

/** The Nth (1-4) given weekday of a month, or null when the month has no such day. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string | null {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > lastDay) return null;
  return iso(new Date(Date.UTC(year, month - 1, day)));
}

/** Same month and day next year; Feb 29 becomes Feb 28. */
export function rollDateOneYear(value: string | null): string | null {
  if (!value) return value;
  const [year, month, day] = value.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year + 1, month, 0)).getUTCDate();
  return `${year + 1}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function yearEndOf(isoDate: string): string {
  return `${isoDate.slice(0, 4)}-12-31`;
}

// ---- dates he means every year ----

/**
 * "When creating packages does not need year as they will be renewed every
 * year and have the same date window of service." So a window, a season end
 * and a renew date can all be written as a bare month and day — "10-01" — and
 * the year is worked out when the thing is actually put on an account.
 */
const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a year-free "mm-dd". */
export function isMonthDay(value: string | null | undefined): boolean {
  return value != null && MONTH_DAY_RE.test(value);
}

/** "2026-10-01" or "10-01" → "10-01". */
export function monthDayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isMonthDay(value)) return value;
  if (FULL_DATE_RE.test(value)) return value.slice(5);
  return null;
}

/**
 * The same check `dateFieldError` does, widened to accept a year-free date.
 * Returns the complaint in his words, or null when the value is fine.
 */
export function seasonDateError(label: string, value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (isMonthDay(value)) {
    const [month, day] = value.split("-").map(Number);
    // A leap day with no year is legal: it resolves to the 28th in a common year.
    const longest = new Date(Date.UTC(2024, month, 0)).getUTCDate();
    if (day > longest) return `${label} is not a real calendar date`;
    return null;
  }
  if (!FULL_DATE_RE.test(value)) {
    return `${label} must be a date — either yyyy-mm-dd, or mm-dd for the same day every year`;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return `${label} is not a real calendar date`;
  }
  return null;
}

/** mm-dd in `year`, with Feb 29 falling back to the 28th in a common year. */
function inYear(monthDay: string, year: number): string {
  const [month, day] = monthDay.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/**
 * Turn a date he means every year into the one season it belongs to.
 *
 * `onOrAfter` is the day the season is being judged from — today when a
 * package is assigned, the row's own start date when a renew date is resolved
 * against it. A year-free date lands in that day's year, or the next one if it
 * has already gone by. A full date is left exactly as typed unless
 * `rollStale` says otherwise, which is for dates that came off a service years
 * ago ("it renews March 1", typed in 2020) where the month and day are the
 * only part that was ever meant.
 */
export function resolveSeasonDate(
  value: string | null | undefined,
  onOrAfter: string | null = null,
  opts: { rollStale?: boolean } = {},
): string | null {
  if (!value) return null;
  const from = onOrAfter ?? todayLocal();
  const md = monthDayOf(value);
  if (!md) return value;
  if (FULL_DATE_RE.test(value) && (!opts.rollStale || value >= from)) return value;
  const candidate = inYear(md, Number(from.slice(0, 4)));
  return candidate >= from ? candidate : inYear(md, Number(from.slice(0, 4)) + 1);
}

/**
 * A window as a pair, so a season that runs over New Year (blow-outs from
 * November into February) stays one window and an open window stays open.
 * The window only moves to next year once the whole of it is behind us, and
 * only when he left both sides year-free: a date typed with a year is the year
 * he asked for.
 */
export function resolveSeasonWindow(
  start: string | null | undefined,
  end: string | null | undefined,
  today = todayLocal(),
): { startDate: string | null; endDate: string | null } {
  const year = Number(today.slice(0, 4));
  const startMd = monthDayOf(start);
  const endMd = monthDayOf(end);
  // Nothing year-free: the dates are what he typed, and nobody moves them.
  if (!isMonthDay(start) && !isMonthDay(end)) {
    return { startDate: start ?? null, endDate: end ?? null };
  }
  // A side he typed WITH a year is the year he meant ("2026-10-01 for one year
  // only"), so it never moves and the year-free side lands in its season. Only
  // a window that is year-free on both sides may roll into next year — moving a
  // date he deliberately dated was putting a one-off October 2026 window into
  // 2027 just because the other box said 05-30.
  if (start && !isMonthDay(start)) {
    const startYear = Number(start.slice(0, 4));
    const endDate = inYear(endMd!, startYear);
    return { startDate: start, endDate: endDate < start ? inYear(endMd!, startYear + 1) : endDate };
  }
  if (end && !isMonthDay(end)) {
    const endYear = Number(end.slice(0, 4));
    const startDate = inYear(startMd!, endYear);
    return { startDate: startDate > end ? inYear(startMd!, endYear - 1) : startDate, endDate: end };
  }
  let startDate = startMd ? inYear(startMd, year) : null;
  let endDate = endMd ? inYear(endMd, year) : null;
  if (startDate && endDate && endDate < startDate) endDate = inYear(endMd!, year + 1);
  const last = endDate ?? startDate;
  if (last && last < today) {
    startDate = startMd ? inYear(startMd, year + 1) : startDate;
    // With no start date at all, next year is the only season left to put a
    // year-free end in: its own year is the one already behind us, which left
    // a package entry sitting on an end date four months past.
    endDate = endMd ? inYear(endMd, startDate ? Number(startDate.slice(0, 4)) : year + 1) : endDate;
    if (startDate && endDate && endDate < startDate) endDate = inYear(endMd!, Number(startDate.slice(0, 4)) + 1);
  }
  return { startDate, endDate };
}

/** The day this row's season begins — what "order by window of start times" means. */
export function seasonStartOf(
  cs: Pick<ClientService, "scheduleType" | "startDate" | "firstServiceDate">,
): string | null {
  if (cs.scheduleType === "window") return cs.startDate ?? cs.firstServiceDate ?? null;
  return cs.firstServiceDate ?? cs.startDate ?? null;
}

/**
 * The renew date that actually governs this row.
 *
 * "Renew date is not client specific but Product based": the service's date
 * wins and every customer with that service follows it, resolved against the
 * row's own season so "03-01" on the service means the March after this
 * customer's season. The row's own date is used only when the office
 * deliberately set one for this customer (renewDateOverridden), and for rows
 * that predate the flag it is still the fallback when the service has no date
 * of its own.
 */
export function effectiveRenewDate(
  cs: Pick<ClientService, "renewDate" | "renewDateOverridden" | "scheduleType" | "startDate" | "firstServiceDate">,
  serviceRenewDate: string | null | undefined,
): string | null {
  if (cs.renewDateOverridden && cs.renewDate) return cs.renewDate;
  if (serviceRenewDate) {
    const anchor = seasonStartOf(cs);
    return resolveSeasonDate(serviceRenewDate, anchor, { rollStale: true });
  }
  return cs.renewDate ?? null;
}

/**
 * His towns are Pacific — Coeur d'Alene, Post Falls, Hayden, and the
 * Washington branch. The weather scheduler's Chicago clock is only when its
 * check fires, so it must not decide what day it is on the board: with it,
 * anything saved after 10 pm counted as tomorrow and skipped today's visit.
 */
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "America/Los_Angeles";

export function todayLocal(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ---- cadence ----

/**
 * Which week of the month a date sits in, 1-4, the way he says it ("the
 * first week", "the fourth week"). Anything past the 28th counts as week 4:
 * a fifth Tuesday is not a week of its own on his board.
 */
export function weekOfMonthOf(isoDate: string): number {
  return Math.min(4, Math.ceil(Number(isoDate.slice(8, 10)) / 7));
}

/**
 * The visit dates an assignment calls for, from `from` (inclusive) through the
 * end of its season. Recurring only — window, one-time and contract rows are
 * handled in generateJobs.
 *
 * With no season end the visits run to December 31 of the first visit's year;
 * the nightly renewal then carries the row into the new year. That replaces
 * the old "no season end means one job" rule, which put one mow on the board
 * and nothing after it.
 */
export function recurringDates(
  cs: Pick<
    ClientService,
    "firstServiceDate" | "seasonEndDate" | "frequency" | "frequencyWeeks" | "weekday" | "weekParity" | "monthlyWeek"
  >,
  from: string | null,
  cap = MAX_GENERATED_JOBS,
): string[] {
  if (!cs.firstServiceDate) return [];
  const start = from && from > cs.firstServiceDate ? from : cs.firstServiceDate;
  const until = cs.seasonEndDate ?? yearEndOf(cs.firstServiceDate);
  const dates: string[] = [];

  if (cs.frequency === "monthly") {
    const weekday = cs.weekday ?? weekdayOf(cs.firstServiceDate);
    const n = cs.monthlyWeek ?? weekOfMonthOf(cs.firstServiceDate);
    let year = Number(start.slice(0, 4));
    let month = Number(start.slice(5, 7));
    while (dates.length < cap) {
      const candidate = nthWeekdayOfMonth(year, month, weekday, n);
      if (candidate && candidate > until) break;
      if (candidate && candidate >= start) dates.push(candidate);
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      if (`${year}-${String(month).padStart(2, "0")}-01` > until) break;
    }
    return dates;
  }

  let step: number;
  let d: string;
  if (cs.frequency === "weekly" || cs.frequency === "biweekly") {
    const weekday = cs.weekday ?? weekdayOf(cs.firstServiceDate);
    step = cs.frequency === "weekly" ? 7 : 14;
    d = start;
    while (weekdayOf(d) !== weekday) d = plusDays(d, 1);
    if (cs.frequency === "biweekly") {
      const parity = cs.weekParity ?? weekParityOf(cs.firstServiceDate);
      if (weekParityOf(d) !== parity) d = plusDays(d, 7);
    }
  } else {
    // Older rows: a plain "every N weeks" from the first visit date.
    const weeks = cs.frequencyWeeks ?? 1;
    if (!Number.isInteger(weeks) || weeks < 1) {
      throw new Error("Recurring frequency must be a whole number of weeks of at least 1");
    }
    step = weeks * 7;
    d = cs.firstServiceDate;
    while (d < start) d = plusDays(d, step);
  }
  while (dates.length < cap && d <= until) {
    dates.push(d);
    d = plusDays(d, step);
  }
  return dates;
}

/** Plain words for the board and the account: "Every other Wednesday (odd weeks)". */
export function cadenceLabel(cs: Pick<ClientService, "scheduleType" | "frequency" | "frequencyWeeks" | "weekday" | "weekParity" | "monthlyWeek" | "firstServiceDate" | "contractMonths">): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const nth = ["", "1st", "2nd", "3rd", "4th"];
  if (cs.scheduleType === "contract") return `Contract, ${cs.contractMonths ?? 12} monthly payments`;
  if (cs.scheduleType === "window") return "Waiting list (date window)";
  if (cs.scheduleType === "one_time") return "One time";
  const weekday = cs.weekday ?? (cs.firstServiceDate ? weekdayOf(cs.firstServiceDate) : null);
  const dayName = weekday == null ? "" : days[weekday];
  if (cs.frequency === "weekly") return `Weekly, ${dayName}`;
  if (cs.frequency === "biweekly") {
    const parity = cs.weekParity ?? (cs.firstServiceDate ? weekParityOf(cs.firstServiceDate) : null);
    return `Every other ${dayName}${parity ? ` (${parity} weeks)` : ""}`;
  }
  if (cs.frequency === "monthly") {
    const n = cs.monthlyWeek ?? (cs.firstServiceDate ? weekOfMonthOf(cs.firstServiceDate) : 1);
    return `Monthly, ${nth[n]} ${dayName}`;
  }
  // Older rows carry only frequencyWeeks, with no weekday and no named
  // frequency. Say it the way he would rather than "Every 1 week(s)".
  const weeks = cs.frequencyWeeks ?? 1;
  const every = weeks === 1 ? "Weekly" : weeks === 2 ? "Every other week" : `Every ${weeks} weeks`;
  return dayName ? `${every}, ${dayName}` : every;
}

// ---- money ----

export function discountAmountFor(
  amount: number,
  discountType: string | null | undefined,
  discountValue: number | null | undefined,
): number {
  if (!discountType || !discountValue || discountValue <= 0) return 0;
  const raw = discountType === "percent" ? (amount * discountValue) / 100 : discountValue;
  return roundMoney(Math.min(Math.max(0, raw), Math.max(0, amount)));
}

/**
 * What a visit is worth on the board before it happens. A time-billed job
 * is priced as budgeted hours x the hourly rate so the day's total means
 * something; the real figure replaces it at completion from the clock.
 */
export function plannedVisitAmount(cs: Pick<ClientService, "amount" | "budgetedHours">, billingMode: string): number {
  if (billingMode === "time") return roundMoney(cs.amount * (cs.budgetedHours ?? 0));
  return cs.amount;
}

export type ResolvedPrice = {
  amount: number;
  budgetedHours: number | null;
  pricedFromLabel: string | null;
  pricedFromValue: number | null;
  /** The property detail the matrix needs and the customer does not have. */
  missingField: string | null;
  billingMode: string;
};

/**
 * Price a service for one customer.
 *
 * Matrix-priced services read the customer's own property detail (Turf Sqft,
 * Sprinkler Zones — whichever field the service names) so the rate fills in
 * by itself. That is the thing his old CRM never managed: the matrix was
 * there, the sqft was there, and the rate box still came up 0.00. A typed
 * price always wins; a typed measurement beats the one on file.
 */
export async function resolveServicePrice(
  tx: Executor,
  svc: Service,
  client: Pick<Client, "propertyData"> | null,
  opts: { quantity?: number | null; explicitAmount?: number | null; sqft?: number | null } = {},
): Promise<ResolvedPrice> {
  const quantity = opts.quantity ?? svc.quantity ?? 1;
  const hasMatrix = svc.pricingEquations.length > 0;
  const base: ResolvedPrice = {
    amount: 0,
    budgetedHours: svc.billableHours ?? null,
    pricedFromLabel: null,
    pricedFromValue: null,
    missingField: null,
    billingMode: svc.billingMode,
  };

  if (opts.explicitAmount != null) return { ...base, amount: roundMoney(opts.explicitAmount) };

  if (svc.billingMode === "time") {
    // The amount on a time service is its hourly rate; hours come from the clock.
    return { ...base, amount: roundMoney(svc.rate) };
  }

  if (!hasMatrix) return { ...base, amount: roundMoney(svc.rate * quantity) };

  // "Which detail does this price from" is answered in one place now, because
  // the estimate builder has to get the same answer off the same account.
  const allFields = await tx.select().from(estimateFieldsTable);
  const field: EstimateField | null = pricingFieldOf(svc, allFields);
  const label = field?.label ?? "Turf Sqft";
  const onFile = numericFieldValue(client?.propertyData?.[label]);
  const value = opts.sqft != null && Number.isFinite(opts.sqft) && opts.sqft > 0 ? opts.sqft : onFile;
  if (value == null || value <= 0) {
    return { ...base, amount: roundMoney(svc.rate * quantity), missingField: label };
  }
  const priced = priceService(svc, field, value);
  const band = priced.equationIndex == null ? null : svc.pricingEquations[priced.equationIndex];
  return {
    ...base,
    amount: roundMoney(priced.price * quantity),
    budgetedHours: band?.budgetedHours ?? svc.billableHours ?? null,
    pricedFromLabel: label,
    pricedFromValue: value,
  };
}

// ---- notes ----

/** The must-read note for a visit on `date`, or null when none is in force that day. */
export function contractorNoteFor(
  cs: Pick<ClientService, "contractorNote" | "noteStartDate" | "noteEndDate"> | null | undefined,
  date: string | null,
): string | null {
  if (!cs?.contractorNote?.trim()) return null;
  const on = date ?? todayLocal();
  if (cs.noteStartDate && on < cs.noteStartDate) return null;
  if (cs.noteEndDate && on > cs.noteEndDate) return null;
  return cs.contractorNote.trim();
}

// ---- generation ----

/**
 * A service puts visits on the board only while it is switched on and not
 * paused — and only when our own crew is the one doing the work.
 *
 * An outside company's service (`services.vendorName`, e.g. Acme Spray on the
 * fertilizer applications) has no stop a sub can drive to: those visits are
 * completed in bulk from the vendor's own invoice on the Spray Runs screen.
 * Accepting an estimate already knew this; assigning the same service by hand
 * from the customer's account did not, and put six phantom fertilizer stops on
 * the board in a probe. The rule belongs here, where every path goes through.
 */
export function generatesJobs(
  cs: Pick<ClientService, "active" | "pausedAt">,
  svc?: Pick<Service, "vendorName"> | null,
): boolean {
  if (svc && svc.vendorName != null) return false;
  return cs.active && cs.pausedAt == null;
}

function visitValues(cs: ClientService, svc: Pick<Service, "billingMode">) {
  return {
    clientId: cs.clientId,
    clientServiceId: cs.id,
    serviceId: cs.serviceId,
    assignedToId: cs.assignedToId,
    budgetedHours: cs.budgetedHours,
    amount: plannedVisitAmount(cs, svc.billingMode),
    discountType: cs.discountType,
    discountValue: cs.discountValue,
    discountLabel: cs.discountLabel,
    billingMode: svc.billingMode,
    hourlyRate: svc.billingMode === "time" ? cs.amount : null,
  };
}

/**
 * Create the visits for an assignment from `from` onwards (today when
 * omitted, so a resume never re-creates a visit that already went by).
 * Returns what was inserted.
 */
export async function generateJobs(
  cs: ClientService,
  svc: Pick<Service, "billingMode" | "vendorName">,
  tx: Executor = db,
  opts: { from?: string | null } = {},
): Promise<(typeof jobsTable.$inferSelect)[]> {
  if (!generatesJobs(cs, svc)) return [];
  const from = opts.from ?? null;
  const base = visitValues(cs, svc);

  if (cs.scheduleType === "window") {
    // Waiting list entry: not dispatched, has a window. A window already
    // closed is left alone rather than put back on the list.
    if (from && cs.endDate && cs.endDate < from) return [];
    return tx
      .insert(jobsTable)
      .values({ ...base, dispatched: false, windowStart: cs.startDate, windowEnd: cs.endDate })
      .returning();
  }

  if (cs.scheduleType === "contract") {
    if (!cs.firstServiceDate || !cs.contractMonths || cs.contractTotal == null) {
      throw new Error("A contract needs a first payment date, the number of months and the annual total");
    }
    // Equal monthly lines; the last one absorbs the cents so the twelve add up
    // to exactly the contract.
    const installment = roundMoney(cs.contractTotal / cs.contractMonths);
    const rows: (typeof jobsTable.$inferInsert)[] = [];
    const [y, m, d] = cs.firstServiceDate.split("-").map(Number);
    for (let i = 0; i < cs.contractMonths; i++) {
      const lastDay = new Date(Date.UTC(y, m + i, 0)).getUTCDate();
      const date = iso(new Date(Date.UTC(y, m - 1 + i, Math.min(d, lastDay))));
      if (from && date < from) continue;
      const amount =
        i === cs.contractMonths - 1
          ? roundMoney(cs.contractTotal - installment * (cs.contractMonths - 1))
          : installment;
      rows.push({
        ...base,
        amount,
        dispatched: true,
        scheduledDate: date,
        // Contract lines are billing, not a stop on a route: kept off the
        // crew's phones so nobody drives to a house to "do" a payment.
        visibleToContractor: false,
        notes: `Contract payment ${i + 1} of ${cs.contractMonths}`,
      });
    }
    return rows.length ? tx.insert(jobsTable).values(rows).returning() : [];
  }

  if (cs.scheduleType === "recurring") {
    if (!cs.firstServiceDate) throw new Error("Recurring services require a first service date");
    const dates = recurringDates(cs, from);
    if (dates.length === 0) return [];
    return tx
      .insert(jobsTable)
      .values(dates.map((scheduledDate) => ({ ...base, dispatched: true, scheduledDate })))
      .returning();
  }

  // one_time
  if (from && cs.firstServiceDate && cs.firstServiceDate < from) return [];
  return tx
    .insert(jobsTable)
    .values({ ...base, dispatched: !!cs.firstServiceDate, scheduledDate: cs.firstServiceDate })
    .returning();
}

/** Visits still ahead of us that a schedule change is allowed to rewrite. */
function futureScheduledVisits(csId: number, from: string) {
  return and(
    eq(jobsTable.clientServiceId, csId),
    eq(jobsTable.status, "scheduled"),
    or(eq(jobsTable.dispatched, false), gte(jobsTable.scheduledDate, from)),
  );
}

/**
 * Throw away the visits not yet started and build them again from the row as
 * it reads now. Used when the cadence or dates change and on pause / resume.
 * Anything completed, skipped or under way today is history and is kept.
 */
export async function regenerateFutureJobs(
  cs: ClientService,
  svc: Pick<Service, "billingMode" | "vendorName">,
  tx: Executor = db,
  opts: { from?: string } = {},
): Promise<number> {
  const from = opts.from ?? todayLocal();
  await tx.delete(jobsTable).where(futureScheduledVisits(cs.id, from));
  const created = await generateJobs(cs, svc, tx, { from });
  return created.length;
}

/**
 * Call off the visits past the day a customer actually finishes.
 *
 * "Season End date will be the same for all mowing clients. If some decide to
 * end earlier having the ability to cancel upcoming or future jobs." Cancelled
 * rather than deleted: the office asked for them, and a visit that quietly
 * vanished is the thing he could never explain to a customer. A cancel is not
 * a skip either — it counts against nobody and the crew never sees it.
 */
export async function cancelVisitsAfter(
  csId: number,
  lastDate: string,
  reason: string,
  tx: Executor = db,
): Promise<number> {
  const rows = await tx
    .update(jobsTable)
    .set({ status: "cancelled", cancelReason: reason, cancelledAt: new Date(), dispatched: false })
    .where(
      and(
        eq(jobsTable.clientServiceId, csId),
        eq(jobsTable.status, "scheduled"),
        gt(jobsTable.scheduledDate, lastDate),
      ),
    )
    .returning({ id: jobsTable.id });
  return rows.length;
}

/** How many visits a season end on `lastDate` would call off, before anything is written. */
export async function visitsAfterCount(csId: number, lastDate: string, tx: Executor = db): Promise<number> {
  const rows = await tx
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.clientServiceId, csId),
        eq(jobsTable.status, "scheduled"),
        gt(jobsTable.scheduledDate, lastDate),
      ),
    );
  return rows.length;
}

/** Take future visits off the board without touching the row (pause, switch off). */
export async function removeFutureJobs(csId: number, tx: Executor = db, from = todayLocal()): Promise<number> {
  const rows = await tx.delete(jobsTable).where(futureScheduledVisits(csId, from)).returning({ id: jobsTable.id });
  return rows.length;
}

/**
 * Push a price, hours, contractor or discount change onto the visits still to
 * come, in place. A job the office already priced by hand keeps its number.
 */
export async function propagateToFutureJobs(
  cs: ClientService,
  svc: Pick<Service, "billingMode">,
  tx: Executor = db,
  from = todayLocal(),
): Promise<void> {
  const where = futureScheduledVisits(cs.id, from);
  await tx
    .update(jobsTable)
    .set({
      assignedToId: cs.assignedToId,
      budgetedHours: cs.budgetedHours,
      discountType: cs.discountType,
      discountValue: cs.discountValue,
      discountLabel: cs.discountLabel,
      hourlyRate: svc.billingMode === "time" ? cs.amount : null,
    })
    .where(where);
  if (cs.scheduleType !== "contract") {
    await tx
      .update(jobsTable)
      .set({ amount: plannedVisitAmount(cs, svc.billingMode) })
      .where(and(where, eq(jobsTable.amountOverridden, false)));
  }
}

/** Ids of every job that belongs to one of these assignments, for cleanup. */
export async function jobIdsFor(csIds: number[], tx: Executor = db): Promise<number[]> {
  if (csIds.length === 0) return [];
  const rows = await tx.select({ id: jobsTable.id }).from(jobsTable).where(inArray(jobsTable.clientServiceId, csIds));
  return rows.map((r) => r.id);
}
