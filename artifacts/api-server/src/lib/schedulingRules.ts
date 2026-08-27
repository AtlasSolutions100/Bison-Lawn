import {
  db,
  auditEventsTable,
  clientsTable,
  jobsTable,
  schedulingRulesTable,
  servicesTable,
  usersTable,
} from "@workspace/db";
import type { Estimate, EstimateLine, SchedulingRule } from "@workspace/db";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { haversineKm, logAudit } from "./helpers";
import { addDaysISO } from "./weatherCheck";
import { localDateOf } from "./weatherScheduler";

/**
 * What happens when a customer accepts an estimate.
 *
 * The office is still working out the policy, so none of it is written here:
 * every decision comes from a scheduling_rules row they can edit themselves.
 * This module only reads those rows and turns an accepted estimate into jobs.
 *
 * An accepted estimate with no matching rule creates nothing. That is
 * deliberate — an install that has never configured a rule keeps the old
 * behaviour (status flip + audit event) rather than surprising the office with
 * jobs it never asked for.
 */

/** How far ahead route_fit will look for an existing route to join. */
const ROUTE_FIT_LOOKAHEAD_DAYS = 14;

/**
 * How long a waiting-list job with no configured season sits available. The
 * waiting list is queried by date (windowStart ≤ date ≤ windowEnd), so a job
 * with no window would be invisible on the dispatch board; a year-long hold
 * keeps it in front of the office until someone schedules it.
 */
const OPEN_ENDED_WINDOW_DAYS = 365;

export type ScheduledFromEstimate = {
  jobId: number;
  serviceId: number;
  serviceName: string;
  ruleId: number;
  action: string;
  scheduledDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  assignedToName: string | null;
  /** Why this date was picked, for the audit trail. */
  reason: string;
};

/**
 * Pick the rule that governs a line: the enabled rule naming that exact
 * service wins, otherwise the enabled catch-all (null serviceId). Within
 * either group the office's own ordering (sortOrder, then id) decides, so a
 * rule can be promoted without deleting the one it replaces.
 */
function ruleForService(rules: SchedulingRule[], serviceId: number): SchedulingRule | null {
  return rules.find((r) => r.serviceId === serviceId) ?? rules.find((r) => r.serviceId == null) ?? null;
}

/**
 * Resolve a MM-DD window against the season the acceptance falls in.
 *
 * The office writes "03-01" once and it keeps working every year. A window
 * whose end month-day precedes its start (e.g. 11-01 → 03-15) wraps into the
 * next year, and a window that has already closed this year rolls forward to
 * the next one — a clean-up accepted in December belongs to next spring, not
 * to a spring that is already over.
 */
export function resolveSeasonWindow(
  acceptedOn: string,
  startMonthDay: string | null,
  endMonthDay: string | null,
): { windowStart: string; windowEnd: string } {
  if (!startMonthDay || !endMonthDay) {
    return { windowStart: acceptedOn, windowEnd: addDaysISO(acceptedOn, OPEN_ENDED_WINDOW_DAYS) };
  }
  const year = Number(acceptedOn.slice(0, 4));
  const build = (offsetYears: number) => {
    const windowStart = `${year + offsetYears}-${startMonthDay}`;
    // A window that ends before it starts runs across New Year's Eve.
    const endYear = endMonthDay < startMonthDay ? year + offsetYears + 1 : year + offsetYears;
    return { windowStart, windowEnd: `${endYear}-${endMonthDay}` };
  };
  const thisSeason = build(0);
  return thisSeason.windowEnd < acceptedOn ? build(1) : thisSeason;
}

type RouteStop = { scheduledDate: string; serviceId: number | null; assignedToId: number | null; lat: number; lng: number };

type RouteFitPlacement = { scheduledDate: string; assignedToId: number | null; reason: string };

/**
 * Find the day whose existing route this new stop fits into best.
 *
 * The route optimiser (lib/helpers optimizeRoute) orders the stops *within* one
 * sub's day and is applied when the route is read, not when a job is created —
 * so the only thing left to choose here is which day the stop joins. We score
 * each candidate day by how close the new address is to the nearest stop
 * already on it and take the closest, earliest day. That is a real "best fit",
 * but a deliberately simple one: it does not model drive time, crew capacity or
 * the hours a day already holds, so the office can still move the job.
 *
 * Anything unknowable (no coordinates on file, no dispatched work in the
 * lookahead) falls back to the plain offset date, which is never worse than
 * what the office would have got by entering the job by hand.
 */
async function planRouteFit(
  clientLat: number | null,
  clientLng: number | null,
  serviceId: number,
  earliest: string,
): Promise<RouteFitPlacement> {
  if (clientLat == null || clientLng == null) {
    return { scheduledDate: earliest, assignedToId: null, reason: "no coordinates on file to fit a route with" };
  }

  const latest = addDaysISO(earliest, ROUTE_FIT_LOOKAHEAD_DAYS);
  const rows = await db
    .select({
      scheduledDate: jobsTable.scheduledDate,
      serviceId: jobsTable.serviceId,
      assignedToId: jobsTable.assignedToId,
      lat: clientsTable.lat,
      lng: clientsTable.lng,
    })
    .from(jobsTable)
    .innerJoin(clientsTable, eq(jobsTable.clientId, clientsTable.id))
    .where(
      and(
        eq(jobsTable.dispatched, true),
        // Completed and skipped days are history; only work still to be done
        // tells us where a crew will actually be.
        inArray(jobsTable.status, ["scheduled", "on_the_way", "in_progress"]),
        gte(jobsTable.scheduledDate, earliest),
        lte(jobsTable.scheduledDate, latest),
      ),
    );

  const located = rows.filter(
    (r): r is RouteStop => r.scheduledDate != null && r.lat != null && r.lng != null,
  );
  // A mowing stop belongs on a mowing day. Only when this service is not out
  // there yet do we fall back to every route in the window.
  const sameService = located.filter((s) => s.serviceId === serviceId);
  const candidates = sameService.length ? sameService : located;

  let best: RouteStop | null = null;
  let bestKm = Infinity;
  for (const stop of candidates) {
    const km = haversineKm(clientLat, clientLng, stop.lat, stop.lng);
    // Ties go to the earlier day: the customer said yes, so sooner is better.
    if (km < bestKm - 1e-9 || (best != null && Math.abs(km - bestKm) <= 1e-9 && stop.scheduledDate < best.scheduledDate)) {
      best = stop;
      bestKm = Math.min(km, bestKm);
    }
  }
  if (!best) {
    return { scheduledDate: earliest, assignedToId: null, reason: "no route to join in the next two weeks" };
  }
  return {
    scheduledDate: best.scheduledDate,
    assignedToId: best.assignedToId,
    // Miles, because that is what the office reads on the route screen.
    reason: `nearest existing ${sameService.length ? "stop for this service" : "stop"} on that day is ${(bestKm * 0.621).toFixed(1)} mi away`,
  };
}

/**
 * Create the jobs an accepted estimate calls for.
 *
 * Callers must only reach this once per acceptance — see the public respond
 * handler in routes/estimates.ts, where the conditional status update is what
 * makes that true. Errors are thrown, not swallowed: the caller decides what a
 * scheduling failure means, and for a customer-facing acceptance the answer is
 * always "log it and carry on".
 */
export async function scheduleAcceptedEstimate(
  estimate: Estimate,
  options: { clientName?: string | null; acceptedOn?: string } = {},
): Promise<ScheduledFromEstimate[]> {
  /*
   * Only what the customer actually ticked.
   *
   * `acceptedLines` holds indexes into the ORIGINAL `lines` array, so the
   * filter has to run before any other filtering reindexes it — computing
   * indexes after dropping the non-service lines would shift every one of them
   * and schedule the wrong work.
   *
   * NULL means every line: that is what an estimate accepted before per-service
   * selection existed means, and what a form submission with no checkboxes
   * means. Treating NULL as "nothing selected" would silently stop scheduling
   * work that was genuinely sold.
   */
  const accepted = estimate.acceptedLines as number[] | null;
  const lines = (estimate.lines as EstimateLine[])
    .map((line, index) => ({ line, index }))
    .filter(({ index }) => accepted === null || accepted.includes(index))
    .map(({ line }) => line)
    .filter(
      (line): line is EstimateLine & { serviceId: number } => line.serviceId != null,
    );
  if (lines.length === 0) return [];

  const rules = await db
    .select()
    .from(schedulingRulesTable)
    .where(eq(schedulingRulesTable.enabled, true))
    .orderBy(asc(schedulingRulesTable.sortOrder), asc(schedulingRulesTable.id));
  if (rules.length === 0) return [];

  // The business day the customer said yes on, not the UTC day: an acceptance
  // at 8pm Central must schedule "tomorrow" from the office's tomorrow.
  const acceptedOn = options.acceptedOn ?? localDateOf(new Date());

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, estimate.clientId));
  const serviceIds = [...new Set(lines.map((line) => line.serviceId))];
  const services = await db
    .select({ id: servicesTable.id, name: servicesTable.name, vendorName: servicesTable.vendorName })
    .from(servicesTable)
    .where(inArray(servicesTable.id, serviceIds));
  const serviceNames = new Map(services.map((s) => [s.id, s.name]));
  const vendorServiceIds = new Set(
    services.filter((s) => s.vendorName != null).map((s) => s.id),
  );

  const created: ScheduledFromEstimate[] = [];
  for (const line of lines) {
    // Work an outside company performs is never scheduled onto our own board.
    // Those jobs are completed in bulk from the vendor's invoice (see Spray
    // Runs), so a crew job here would be a phantom stop the sub cannot do and
    // a second source of truth for whether the work happened.
    //
    // Enforced here rather than as a default rule on purpose: it is an
    // invariant of vendor work, not a policy choice, so it must hold for a
    // vendor service added next year that no default ever matched — and it must
    // survive the catch-all rule, which would otherwise dispatch it.
    if (vendorServiceIds.has(line.serviceId)) continue;

    const rule = ruleForService(rules, line.serviceId);
    if (!rule || rule.action === "none") continue;

    const serviceName = serviceNames.get(line.serviceId) ?? line.label;
    let scheduledDate: string | null = null;
    let windowStart: string | null = null;
    let windowEnd: string | null = null;
    let assignedToId = rule.assignedToId;
    let reason: string;

    if (rule.action === "waiting_list") {
      const window = resolveSeasonWindow(acceptedOn, rule.windowStartMonthDay, rule.windowEndMonthDay);
      windowStart = window.windowStart;
      windowEnd = window.windowEnd;
      reason = `held for the ${windowStart} → ${windowEnd} window`;
    } else if (rule.action === "route_fit") {
      const placement = await planRouteFit(
        client?.lat ?? null,
        client?.lng ?? null,
        line.serviceId,
        addDaysISO(acceptedOn, rule.offsetDays),
      );
      scheduledDate = placement.scheduledDate;
      // A rule that names an assignee overrides the route: the office asked for
      // that sub by name. Otherwise the job joins whoever already owns the day.
      assignedToId = rule.assignedToId ?? placement.assignedToId;
      reason = `fitted into the route on ${scheduledDate} (${placement.reason})`;
    } else {
      scheduledDate = addDaysISO(acceptedOn, rule.offsetDays);
      reason = `dispatched for ${scheduledDate}`;
    }

    const [job] = await db
      .insert(jobsTable)
      .values({
        clientId: estimate.clientId,
        serviceId: line.serviceId,
        // dispatch and route_fit both put the job on the board; waiting_list
        // holds it off until the office moves it to a sub.
        dispatched: rule.action !== "waiting_list",
        scheduledDate,
        windowStart,
        windowEnd,
        assignedToId,
        amount: line.calculatedPrice ?? 0,
        notes: rule.jobNote,
      })
      .returning();

    const [assignee] = assignedToId
      ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, assignedToId))
      : [];

    created.push({
      jobId: job.id,
      serviceId: line.serviceId,
      serviceName,
      ruleId: rule.id,
      action: rule.action,
      scheduledDate,
      windowStart,
      windowEnd,
      assignedToName: assignee?.name ?? null,
      reason,
    });

    // The office never touched this job, so the audit trail is the only place
    // it can see where the work came from — and it is what tells an assigned
    // sub that a new job landed on their day.
    await logAudit({
      clientId: estimate.clientId,
      actorName: options.clientName ?? null,
      action: "job_scheduled_from_estimate",
      description:
        `Accepted estimate #${estimate.id} created job #${job.id} for ${serviceName}: ${reason}` +
        `${assignee?.name ? `, assigned to ${assignee.name}` : ""}` +
        ` (scheduling rule #${rule.id}, ${rule.action})`,
    });
  }

  return created;
}

/**
 * The starting policy, matching what the owner described: sprinkler repairs go
 * out the next day, mowing joins the nearest route, seasonal package work waits
 * for its season, and anything else lands on tomorrow's dispatch board for the
 * office to hand to a sub.
 *
 * These are a starting point, not the policy — every field is editable from the
 * automation page, which is the whole reason they are rows.
 */
const SPRING_WINDOW = { start: "03-01", end: "05-31" };
const FALL_WINDOW = { start: "09-01", end: "11-30" };

/** Which season a seasonal service belongs to, read off its own name. */
function seasonOf(serviceName: string) {
  return /fall|autumn/i.test(serviceName) ? FALL_WINDOW : SPRING_WINDOW;
}

const DEFAULT_RULES: {
  matches: RegExp | null;
  action: string;
  offsetDays: number;
  window: (serviceName: string) => { start: string | null; end: string | null };
  jobNote: string;
  sortOrder: number;
}[] = [
  {
    matches: /sprinkler|irrigation/i,
    action: "dispatch",
    offsetDays: 1,
    window: () => ({ start: null, end: null }),
    jobNote: "Auto-scheduled from an accepted estimate — sprinkler work, next day.",
    sortOrder: 10,
  },
  {
    matches: /mow/i,
    action: "route_fit",
    offsetDays: 1,
    window: () => ({ start: null, end: null }),
    jobNote: "Auto-scheduled from an accepted estimate — fitted into the nearest route.",
    sortOrder: 20,
  },
  {
    // Aeration is usually fall work here, so anything not named for spring
    // starts in the fall window.
    matches: /aerat/i,
    action: "waiting_list",
    offsetDays: 1,
    window: (name) => (/spring/i.test(name) ? SPRING_WINDOW : FALL_WINDOW),
    jobNote: "Auto-scheduled from an accepted estimate — held for its aeration window.",
    sortOrder: 30,
  },
  {
    matches: /clean-?\s?up/i,
    action: "waiting_list",
    offsetDays: 1,
    window: (name) => seasonOf(name),
    jobNote: "Auto-scheduled from an accepted estimate — held for its clean-up window.",
    sortOrder: 40,
  },
  {
    // The catch-all: "if the estimate has a one time job, put it on the
    // dispatch board for the next day and I can move it to the right sub".
    matches: null,
    action: "dispatch",
    offsetDays: 1,
    window: () => ({ start: null, end: null }),
    jobNote: "Auto-scheduled from an accepted estimate — assign to a sub.",
    sortOrder: 100,
  },
];

/** Marks that seeding has happened, so deleted defaults never come back. */
const SEED_MARKER_ACTION = "scheduling_rules_seeded";

/**
 * Put the starting policy in place the first time the office opens the rules.
 *
 * Seeding once and recording it in the audit trail is what makes this safe to
 * call on every read: an office that deletes every default meant to, and must
 * not find them all back on the next page load.
 */
export async function ensureDefaultSchedulingRules(): Promise<void> {
  const [seeded] = await db
    .select({ id: auditEventsTable.id })
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, SEED_MARKER_ACTION))
    .limit(1);
  if (seeded) return;

  const [existing] = await db.select({ id: schedulingRulesTable.id }).from(schedulingRulesTable).limit(1);
  if (existing) {
    // Rules already written by hand (or by an earlier build). Record the marker
    // so the defaults never appear alongside them later.
    await logAudit({ action: SEED_MARKER_ACTION, description: "Scheduling rules already existed; defaults not added" });
    return;
  }

  const services = await db.select({ id: servicesTable.id, name: servicesTable.name }).from(servicesTable);
  const values = DEFAULT_RULES.flatMap((preset) => {
    // A service-specific default is only worth writing if that service exists;
    // otherwise the catch-all already covers it.
    const targets: { id: number | null; name: string }[] = preset.matches
      ? services.filter((s) => preset.matches!.test(s.name))
      : [{ id: null, name: "" }];
    return targets.map((target) => {
      const window = preset.window(target.name);
      return {
        serviceId: target.id,
        enabled: true,
        action: preset.action,
        offsetDays: preset.offsetDays,
        windowStartMonthDay: window.start,
        windowEndMonthDay: window.end,
        jobNote: preset.jobNote,
        sortOrder: preset.sortOrder,
      };
    });
  });

  await db.insert(schedulingRulesTable).values(values);
  await logAudit({
    action: SEED_MARKER_ACTION,
    description: `Added ${values.length} starting scheduling rule(s) for accepted estimates`,
  });
}
