import { db, automationRunsTable, clientServicesTable, clientsTable, servicesTable } from "@workspace/db";
import type { ClientService } from "@workspace/db";
import { and, eq, isNotNull, lte, or } from "drizzle-orm";
import { logAudit, type Executor } from "./helpers";
import { logger } from "./logger";
import {
  generateJobs,
  regenerateFutureJobs,
  resolveServicePrice,
  rollDateOneYear,
  todayLocal,
} from "./jobGeneration";

/**
 * The nightly housekeeping on assigned services.
 *
 * Two jobs: put paused services back on the board when their date comes or
 * the account is paid up, and carry active services into the new season
 * (auto-renew) once their season ends. Nobody has to click anything; the
 * account page just shows "renewed for 2027" one morning.
 */

const TICK_MS = 5 * 60 * 1000;
const RUN_KIND = "client_services";

/** Same month and day next year for every date the row carries. */
function rolledDates(cs: ClientService) {
  return {
    startDate: rollDateOneYear(cs.startDate),
    endDate: rollDateOneYear(cs.endDate),
    firstServiceDate: rollDateOneYear(cs.firstServiceDate),
    seasonEndDate: rollDateOneYear(cs.seasonEndDate),
    renewDate: rollDateOneYear(cs.renewDate),
  };
}

/**
 * The date of the last monthly line of a contract — the day its term is up.
 * Same arithmetic the lines were built with, so it lands on the real day.
 */
export function contractLastInstallment(
  cs: Pick<ClientService, "firstServiceDate" | "contractMonths">,
): string | null {
  if (!cs.firstServiceDate || !cs.contractMonths) return null;
  const [y, m, d] = cs.firstServiceDate.split("-").map(Number);
  const i = cs.contractMonths - 1;
  const lastDay = new Date(Date.UTC(y, m + i, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + i, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/**
 * The last day a row's own season actually covers. Not the renew date: a
 * "renews March 1" typed on a row that mows until December is when the
 * paperwork turns over, not the day the mowing stopped.
 */
export function seasonOverDate(cs: ClientService): string | null {
  if (cs.scheduleType === "contract") return contractLastInstallment(cs);
  if (cs.seasonEndDate) return cs.seasonEndDate;
  if (cs.endDate) return cs.endDate;
  if (cs.firstServiceDate) return `${cs.firstServiceDate.slice(0, 4)}-12-31`;
  return null;
}

/**
 * The day a row's season is over. His renew date wins; otherwise the season
 * end, the window end, or the end of the first visit's year for a recurring
 * row with no season end (that is how far its visits were generated).
 *
 * Two dates are ignored on purpose. A contract runs its full term whatever
 * renew date got copied onto it — rolling it early would throw away the
 * payments the customer still owes. And a renew date older than the row's own
 * start date is a date from a past year that came off the service ("it renews
 * March 1"), not a season that ended; taking it at face value rolled a brand
 * new assignment forward a year on the next tick.
 */
export function renewalDueDate(cs: ClientService): string | null {
  if (cs.scheduleType === "contract") return contractLastInstallment(cs);
  const start = cs.firstServiceDate ?? cs.startDate;
  if (cs.renewDate && (!start || cs.renewDate >= start)) return cs.renewDate;
  if (cs.seasonEndDate) return cs.seasonEndDate;
  if (cs.endDate) return cs.endDate;
  if (cs.firstServiceDate) return `${cs.firstServiceDate.slice(0, 4)}-12-31`;
  return null;
}

/**
 * Why this row must not be rolled today, in his words, or null when it may be.
 * Only a contract mid-term is refused: its monthly lines are money the
 * customer still owes, and a renewal rebuilds the schedule from scratch.
 */
export function renewRefusal(cs: ClientService, today = todayLocal()): string | null {
  if (cs.scheduleType !== "contract") return null;
  const last = contractLastInstallment(cs);
  if (!last || last < today) return null;
  return `This contract still runs through ${last}. Renewing it now would take the payments that are left off the board — renew it once the last one has gone out.`;
}

/**
 * Roll one assignment into next season and put its visits on the board.
 * Reprices from the matrix against the customer's current measurement when
 * that is where the price came from; a hand-typed price stays what it was.
 */
export async function renewClientService(
  csId: number,
  tx: Executor,
  opts: { actorName?: string | null; today?: string } = {},
): Promise<ClientService | null> {
  const today = opts.today ?? todayLocal();
  const [cs] = await tx.select().from(clientServicesTable).where(eq(clientServicesTable.id, csId)).for("update");
  if (!cs) return null;
  const [svc] = await tx.select().from(servicesTable).where(eq(servicesTable.id, cs.serviceId));
  if (!svc) return null;
  const [client] = await tx.select().from(clientsTable).where(eq(clientsTable.id, cs.clientId));

  const patch: Partial<typeof clientServicesTable.$inferInsert> = {
    ...rolledDates(cs),
    lastRenewedAt: new Date(),
  };
  let priceNote = "";
  if (cs.pricedFromLabel && svc.pricingEquations.length > 0) {
    const priced = await resolveServicePrice(tx, svc, client ?? null, { quantity: cs.quantity });
    if (!priced.missingField && priced.amount !== cs.amount) {
      priceNote = `, price ${cs.amount} → ${priced.amount} from ${priced.pricedFromLabel} ${priced.pricedFromValue}`;
      patch.amount = priced.amount;
      patch.pricedFromValue = priced.pricedFromValue;
      patch.budgetedHours = priced.budgetedHours ?? cs.budgetedHours;
    }
  }
  const [renewed] = await tx
    .update(clientServicesTable)
    .set(patch)
    .where(eq(clientServicesTable.id, cs.id))
    .returning();
  // Last season's leftovers (a window that never got dispatched, say) go so
  // the new season starts clean; completed visits are history and stay.
  const created = await regenerateFutureJobs(renewed, svc, tx, { from: today });
  await logAudit({
    clientId: cs.clientId,
    actorName: opts.actorName ?? "Auto-renew",
    action: "service_renewed",
    description:
      `Renewed "${svc.name}" for the new season` +
      (renewed.firstServiceDate ? ` starting ${renewed.firstServiceDate}` : renewed.startDate ? ` (window ${renewed.startDate} to ${renewed.endDate})` : "") +
      `; ${created} visit(s) put on the board${priceNote}`,
  });
  return renewed;
}

/** Put one paused assignment back on the board. */
export async function resumeClientService(
  csId: number,
  tx: Executor,
  opts: { actorName?: string | null; reason?: string; today?: string } = {},
): Promise<ClientService | null> {
  const today = opts.today ?? todayLocal();
  const [cs] = await tx.select().from(clientServicesTable).where(eq(clientServicesTable.id, csId)).for("update");
  if (!cs || cs.pausedAt == null) return cs ?? null;
  const [svc] = await tx.select().from(servicesTable).where(eq(servicesTable.id, cs.serviceId));
  if (!svc) return null;
  const [resumed] = await tx
    .update(clientServicesTable)
    .set({ pausedAt: null, pauseUntil: null, resumeWhenPaid: false, pauseReason: null })
    .where(eq(clientServicesTable.id, cs.id))
    .returning();
  const created = (await generateJobs(resumed, svc, tx, { from: today })).length;
  await logAudit({
    clientId: cs.clientId,
    actorName: opts.actorName ?? "Service pause check",
    action: "service_resumed",
    description: `Resumed "${svc.name}"${opts.reason ? ` — ${opts.reason}` : ""}; ${created} visit(s) put back on the board`,
  });
  return resumed;
}

/**
 * Resume every paused service whose date has come, and every one waiting on
 * payment whose account is paid up. Cheap enough to run on every tick: only
 * paused rows are read.
 */
export async function resumeDueServices(today = todayLocal()): Promise<number> {
  const due = await db
    .select({ cs: clientServicesTable, balance: clientsTable.accountBalance })
    .from(clientServicesTable)
    .innerJoin(clientsTable, eq(clientServicesTable.clientId, clientsTable.id))
    .where(
      and(
        isNotNull(clientServicesTable.pausedAt),
        or(
          lte(clientServicesTable.pauseUntil, today),
          and(eq(clientServicesTable.resumeWhenPaid, true), lte(clientsTable.accountBalance, 0)),
        ),
      ),
    );
  let resumed = 0;
  for (const { cs, balance } of due) {
    const byDate = cs.pauseUntil != null && cs.pauseUntil <= today;
    const reason = byDate ? `pause ended ${cs.pauseUntil}` : `account paid up (balance $${balance})`;
    try {
      await db.transaction(async (tx) => {
        const row = await resumeClientService(cs.id, tx, { reason, today });
        if (row) resumed += 1;
      });
    } catch (err) {
      logger.error({ err, clientServiceId: cs.id }, "Could not resume a paused service");
    }
  }
  return resumed;
}

/**
 * Whether tonight's run should carry this row into the next season.
 *
 * A paused service waits under its pause. A one-time job is done once — it
 * came off an estimate with auto-renew on by default, and rolling it put a
 * real visit back on a contractor's board a year later for work nobody
 * ordered. And the season has to be genuinely over: with only the renew date
 * to go on, a date sitting in the past rolled the row a year that same night
 * and took the rest of this year's visits off the board.
 */
export function isRenewalDue(cs: ClientService, today: string): boolean {
  if (!cs.active || !cs.autoRenew || cs.pausedAt != null) return false;
  if (cs.scheduleType === "one_time") return false;
  const due = renewalDueDate(cs);
  if (!due || due >= today) return false;
  const seasonOver = seasonOverDate(cs);
  if (seasonOver && seasonOver >= today) return false;
  return true;
}

/** Carry every auto-renewing service whose season is over into the next one. */
export async function renewDueServices(today = todayLocal()): Promise<number> {
  const candidates = await db
    .select()
    .from(clientServicesTable)
    .where(and(eq(clientServicesTable.active, true), eq(clientServicesTable.autoRenew, true)));
  let renewed = 0;
  for (const cs of candidates) {
    if (!isRenewalDue(cs, today)) continue;
    // One transaction per row: a bad date on one account must not stop the
    // other 700 from rolling over.
    try {
      await db.transaction(async (tx) => {
        const row = await renewClientService(cs.id, tx, { today });
        if (row) renewed += 1;
      });
    } catch (err) {
      logger.error({ err, clientServiceId: cs.id }, "Could not auto-renew a service");
      await logAudit({
        clientId: cs.clientId,
        actorName: "Auto-renew",
        action: "service_renew_failed",
        description: `Could not renew assigned service #${cs.id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return renewed;
}

/**
 * Everything the tick does, in one call the manual button and the tests can
 * reach. Renewals are claimed once per local day through automation_runs so
 * two server instances (or a restart) cannot both roll the same season.
 */
export async function runClientServiceDailyTasks(
  opts: { today?: string; force?: boolean } = {},
): Promise<{ resumed: number; renewed: number; renewalsRan: boolean }> {
  const today = opts.today ?? todayLocal();
  const resumed = await resumeDueServices(today);

  let renewed = 0;
  let renewalsRan = false;
  const [claim] = await db
    .insert(automationRunsTable)
    .values({
      kind: RUN_KIND,
      trigger: opts.force ? "manual" : "scheduled",
      runDate: today,
      datesChecked: [today],
      status: "running",
      triggeredBy: opts.force ? "Assigned services — run now" : "Assigned services automation",
    })
    .onConflictDoNothing()
    .returning();
  if (claim) {
    renewalsRan = true;
    try {
      renewed = await renewDueServices(today);
      await db
        .update(automationRunsTable)
        .set({
          status: "succeeded",
          jobsChecked: renewed,
          summary: `${resumed} resumed, ${renewed} renewed`,
          finishedAt: new Date(),
        })
        .where(eq(automationRunsTable.id, claim.id));
    } catch (err) {
      await db
        .update(automationRunsTable)
        .set({
          status: "failed",
          runDate: null,
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
        })
        .where(eq(automationRunsTable.id, claim.id));
      throw err;
    }
  }
  return { resumed, renewed, renewalsRan };
}

let started = false;

/** Start the loop: once now, then every few minutes. Harmless to call twice. */
export function startClientServiceTicker(): void {
  if (started) return;
  started = true;
  const tick = () => {
    runClientServiceDailyTasks().catch((err) => logger.error({ err }, "Assigned-services tick failed"));
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  tick();
}
