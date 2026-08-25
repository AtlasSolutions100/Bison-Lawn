import { db, automationRunsTable } from "@workspace/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { logAudit } from "./helpers";
import { logger } from "./logger";
import { addDaysISO, runWeatherCheckForDate } from "./weatherCheck";

/**
 * Daily weather check.
 *
 * The office should not have to remember to click "Check Weather": once a day,
 * early in the morning, the same rule evaluation runs for the upcoming days'
 * jobs. It only ever prepares pending suggestions, so every schedule change
 * still passes through admin review.
 */
export const WEATHER_SCHEDULE = {
  /** Local wall-clock time the daily run should fire. */
  runAtLocalTime: "05:00",
  /** Business timezone the run time is expressed in. */
  timeZone: "America/Chicago",
  /** How many days of scheduled jobs to check, starting with today. */
  daysAhead: 2,
} as const;

const TICK_MS = 5 * 60 * 1000;
const MAX_FAILED_ATTEMPTS_PER_DAY = 3;
/**
 * A claimed run that hasn't finished within this window is treated as
 * abandoned (the instance that claimed it crashed or was recycled) and its
 * day is released for a retry. Longer than any healthy run, short enough that
 * one crash never costs a whole day.
 */
const CLAIM_LEASE_MS = 10 * 60 * 1000;
/** Don't re-evaluate due-ness more than this often when driven by requests. */
const REQUEST_TRIGGER_THROTTLE_MS = 60 * 1000;

const [RUN_HOUR, RUN_MINUTE] = WEATHER_SCHEDULE.runAtLocalTime.split(":").map(Number);

/** Wall-clock parts of an instant in a given IANA timezone. */
function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Intl renders midnight as hour 24 in some runtimes.
  const hour = get("hour") % 24;
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar day (YYYY-MM-DD) that `date` falls on in the business timezone. */
export function localDateOf(date: Date, timeZone = WEATHER_SCHEDULE.timeZone): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes past local midnight for `date` in the business timezone. */
function localMinutesOf(date: Date, timeZone = WEATHER_SCHEDULE.timeZone): number {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** The UTC instant matching a local wall-clock time in the business timezone. */
function utcInstantFor(localDate: string, hour: number, minute: number, timeZone: string): Date {
  // Start from the naive UTC reading, then correct by the zone offset. Two
  // passes settle the DST boundary cases where the offset itself shifts.
  let guess = new Date(`${localDate}T${pad(hour)}:${pad(minute)}:00Z`);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const offset = asUtc - guess.getTime();
    guess = new Date(new Date(`${localDate}T${pad(hour)}:${pad(minute)}:00Z`).getTime() - offset);
  }
  return guess;
}

/** When the next daily run is due, given the current time. */
export function nextRunAt(now = new Date()): Date {
  const today = localDateOf(now);
  const dueToday = utcInstantFor(today, RUN_HOUR, RUN_MINUTE, WEATHER_SCHEDULE.timeZone);
  if (dueToday.getTime() > now.getTime()) return dueToday;
  return utcInstantFor(addDaysISO(today, 1), RUN_HOUR, RUN_MINUTE, WEATHER_SCHEDULE.timeZone);
}

/** The dates a run covers: today plus the following `daysAhead - 1` days. */
export function datesForRun(runDate: string): string[] {
  return Array.from({ length: WEATHER_SCHEDULE.daysAhead }, (_, i) => addDaysISO(runDate, i));
}

/** Run the check across several dates, aggregating the per-date results. */
export async function runWeatherCheckForDates(dates: string[]) {
  let jobsChecked = 0;
  let suggestionsCreated = 0;
  const summaries: string[] = [];
  for (const date of dates) {
    const outcome = await runWeatherCheckForDate(date);
    jobsChecked += outcome.jobsChecked;
    suggestionsCreated += outcome.suggestionsCreated;
    if (outcome.forecastSummary) summaries.push(outcome.forecastSummary);
  }
  return { jobsChecked, suggestionsCreated, summary: summaries.join(" · ") || null };
}

const failedAttempts = new Map<string, number>();

/**
 * Fire the daily run if it is due and today's slot has not been claimed yet.
 * Claiming happens through a partial unique index on (kind, run_date) for
 * scheduled rows, so neither a restart mid-morning nor a second instance can
 * double-run the same day. `force` skips the time-of-day check for an
 * externally triggered run (e.g. a platform scheduled job).
 */
export async function runDailyWeatherCheck({ force = false } = {}): Promise<void> {
  const now = new Date();
  if (!force && localMinutesOf(now) < RUN_HOUR * 60 + RUN_MINUTE) return;

  // Recover days claimed by an instance that died mid-run before trying to
  // claim, so a crash costs one lease window rather than the whole day.
  await releaseExpiredClaims();

  const runDate = localDateOf(now);
  if ((failedAttempts.get(runDate) ?? 0) >= MAX_FAILED_ATTEMPTS_PER_DAY) return;

  const dates = datesForRun(runDate);
  const [claim] = await db
    .insert(automationRunsTable)
    .values({
      kind: "weather",
      trigger: "scheduled",
      runDate,
      datesChecked: dates,
      status: "running",
      triggeredBy: "Weather automation",
      leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
    })
    .onConflictDoNothing()
    .returning();
  if (!claim) return; // already ran (or is running) for this local day

  logger.info({ runDate, dates }, "Starting scheduled weather check");
  // A healthy check can take longer than one lease while it processes a large
  // job list. Renew independently of forecast calls so a second instance
  // cannot reclaim it mid-run.
  const heartbeat = setInterval(() => {
    db
      .update(automationRunsTable)
      .set({ leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS) })
      .where(and(eq(automationRunsTable.id, claim.id), eq(automationRunsTable.status, "running")))
      .catch((err) => logger.warn({ err, runId: claim.id }, "Could not renew weather-check lease"));
  }, Math.floor(CLAIM_LEASE_MS / 3));
  heartbeat.unref();
  try {
    const { jobsChecked, suggestionsCreated, summary } = await runWeatherCheckForDates(dates);
    await db
      .update(automationRunsTable)
      .set({ status: "succeeded", jobsChecked, suggestionsCreated, summary, leaseExpiresAt: null, finishedAt: new Date() })
      .where(eq(automationRunsTable.id, claim.id));
    await logAudit({
      actorName: "Weather automation",
      action: "weather_check_run",
      description:
        `Scheduled weather check for ${dates.join(", ")}: ${jobsChecked} job(s) checked, ` +
        `${suggestionsCreated} suggestion(s) prepared for admin review`,
    });
    failedAttempts.delete(runDate);
    logger.info({ runDate, jobsChecked, suggestionsCreated }, "Scheduled weather check finished");
  } catch (err) {
    // Release the day's slot (NULLs don't collide in the unique index) so the
    // next tick can retry, while keeping the failure on the record.
    await db
      .update(automationRunsTable)
      .set({
        status: "failed",
        runDate: null,
        error: err instanceof Error ? err.message : String(err),
        leaseExpiresAt: null,
        finishedAt: new Date(),
      })
      .where(eq(automationRunsTable.id, claim.id));
    failedAttempts.set(runDate, (failedAttempts.get(runDate) ?? 0) + 1);
    logger.error({ err, runDate }, "Scheduled weather check failed");
  } finally {
    clearInterval(heartbeat);
  }
}

/** Most recent run of each trigger, for the admin-facing status panel. */
export async function getWeatherCheckStatus() {
  const [lastAutomatic] = await db
    .select()
    .from(automationRunsTable)
    .where(and(eq(automationRunsTable.kind, "weather"), eq(automationRunsTable.trigger, "scheduled")))
    .orderBy(desc(automationRunsTable.startedAt))
    .limit(1);
  const [lastManual] = await db
    .select()
    .from(automationRunsTable)
    .where(and(eq(automationRunsTable.kind, "weather"), eq(automationRunsTable.trigger, "manual")))
    .orderBy(desc(automationRunsTable.startedAt))
    .limit(1);
  return {
    enabled: schedulerStarted,
    runAtLocalTime: WEATHER_SCHEDULE.runAtLocalTime,
    timeZone: WEATHER_SCHEDULE.timeZone,
    daysAhead: WEATHER_SCHEDULE.daysAhead,
    nextRunAt: schedulerStarted ? nextRunAt().toISOString() : null,
    lastAutomaticRun: lastAutomatic ? serializeRun(lastAutomatic) : null,
    lastManualRun: lastManual ? serializeRun(lastManual) : null,
  };
}

export function serializeRun(run: typeof automationRunsTable.$inferSelect) {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    datesChecked: run.datesChecked,
    jobsChecked: run.jobsChecked,
    suggestionsCreated: run.suggestionsCreated,
    summary: run.summary,
    error: run.error,
    triggeredBy: run.triggeredBy,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

let schedulerStarted = false;
let lastTriggerAttempt = 0;

let inFlightRun: Promise<void> | null = null;

/** Evaluate due-ness once; concurrent callers share the same attempt. */
function tick(): Promise<void> {
  if (inFlightRun) return inFlightRun;
  lastTriggerAttempt = Date.now();
  inFlightRun = runDailyWeatherCheck()
    .catch((err) => logger.error({ err }, "Weather scheduler tick failed"))
    .finally(() => {
      inFlightRun = null;
    });
  return inFlightRun;
}

/**
 * Start the daily weather check loop. Ticking every few minutes (rather than
 * sleeping until the exact instant) keeps the run-time correct across DST
 * changes and catches up if the server was down at the scheduled hour.
 */
export function startWeatherScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  logger.info(
    {
      runAtLocalTime: WEATHER_SCHEDULE.runAtLocalTime,
      timeZone: WEATHER_SCHEDULE.timeZone,
      nextRunAt: nextRunAt().toISOString(),
    },
    "Weather scheduler started",
  );
  tick();
}

/**
 * Also evaluate due-ness on incoming traffic. This deployment autoscales, so
 * an instance may be asleep at the scheduled hour and no timer would fire;
 * the first request of the morning then triggers the catch-up run. The
 * database day-claim keeps concurrent instances from running it twice.
 * No-op until the scheduler is started, so tests importing the app are unaffected.
 */
export function weatherSchedulerRequestHook(): (req: unknown, res: unknown, next: () => void) => void {
  return (_req, _res, next) => {
    next(); // never delay a response for this
    if (!schedulerStarted) return;
    if (Date.now() - lastTriggerAttempt < REQUEST_TRIGGER_THROTTLE_MS) return;
    tick();
  };
}

/**
 * Bounded, awaited catch-up for read paths that must not show a stale queue.
 *
 * The timer only ticks while an instance is serving and the request hook is
 * deliberately non-blocking, so on an autoscaled deployment that slept through
 * the scheduled hour the very first admin to open the review queue could
 * otherwise see yesterday's suggestions. This runs the due check first and
 * waits up to `timeoutMs` for it; past that the response goes out and the run
 * finishes in the background. Concurrent callers share one run, and the
 * database day-claim still guarantees it happens only once per day.
 */
export async function ensureDailyWeatherCheck({ timeoutMs = 8000 } = {}): Promise<void> {
  if (!schedulerStarted) return; // not serving the app (tests, one-shot job)
  const run = tick();
  await Promise.race([run, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
}

/**
 * Release days claimed by a run that never finished. Lease-based rather than
 * "clear everything on startup" because several instances may be serving at
 * once — a blanket sweep could release a run another instance is mid-way
 * through.
 */
export async function releaseExpiredClaims(): Promise<void> {
  await db
    .update(automationRunsTable)
    .set({
      status: "failed",
      runDate: null,
      error: "Interrupted — the check did not finish (the server restarted or timed out)",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(automationRunsTable.kind, "weather"),
        eq(automationRunsTable.status, "running"),
        isNull(automationRunsTable.finishedAt),
        or(
          isNull(automationRunsTable.leaseExpiresAt),
          sql`${automationRunsTable.leaseExpiresAt} < now()`,
        ),
      ),
    );
}
