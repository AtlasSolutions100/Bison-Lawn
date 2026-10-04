import { Router, type IRouter } from "express";
import { db, clientsTable, clientServicesTable, jobsTable, servicesTable } from "@workspace/db";
import type { Client, ClientService, Service } from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  GetServiceAssignedImpactQueryParams,
  PushServiceToAssignedBody,
  SetServiceSeasonEndBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, roundMoney } from "../lib/helpers";
import {
  cadenceLabel,
  cancelVisitsAfter,
  propagateToFutureJobs,
  resolveSeasonDate,
  resolveServicePrice,
  seasonDateError,
  seasonStartOf,
  todayLocal,
  visitsAfterCount,
} from "../lib/jobGeneration";

/**
 * Changing a service, and what that should do to the customers who already
 * have it.
 *
 * "Making changes to service info. Ask if want to push on to current assigned
 * jobs/customers." A price on an account is a copy taken the day the service
 * was assigned — that is on purpose, so last April's mow is still billed at
 * last April's price. The cost of it is that putting mowing up $5 changed
 * nothing for the 300 customers who already mow with him. Nothing here pushes
 * on its own: every endpoint answers with the preview first, says how many
 * customers and how many visits are involved, and only writes when `apply` is
 * set. Every write is on the account's own activity so the customer's page
 * says where their new price came from.
 *
 * The season end lives here too ("Season End date will be the same for all
 * mowing clients"), because it is the same shape of job: one date on the
 * service, pushed onto everybody, with the visits past it called off.
 */
const router: IRouter = Router();

router.use(["/services"], requireAuth, requireAdmin);

/** What can be pushed. The rest of a service is read live and needs no push. */
type PushField = "price" | "hours";

type Candidate = {
  cs: ClientService;
  client: Pick<Client, "id" | "name" | "propertyData">;
  newAmount: number;
  newBudgetedHours: number | null;
  missingField: string | null;
  pricedFromLabel: string | null;
  pricedFromValue: number | null;
  upcomingVisits: number;
  handTyped: boolean;
};

/**
 * Every account that has this service, with what it would become.
 *
 * A matrix-priced service is re-priced against each customer's own
 * measurement, not slammed to one number: "mowing went up" means a 6,200 sqft
 * lawn moves to the new 6,200 sqft band, which is the whole point of the
 * matrix. A row whose price never came from the matrix (`pricedFromLabel`
 * empty) was typed by the office for a reason, so it is listed as such and
 * left alone unless he says to include it.
 *
 * `fromRate` is the rate the service had before he saved it. A flat service
 * records nothing about where the number on a row came from, so the only way
 * to tell "we negotiated this one down to $180" from "this one is simply still
 * on the old $220" is to measure it against the old rate — which is why the
 * dialog hands it back.
 */
async function candidatesFor(
  svc: Service,
  clientServiceIds?: number[] | null,
  fromRate?: number | null,
): Promise<Candidate[]> {
  const rows = await db
    .select({ cs: clientServicesTable, client: clientsTable })
    .from(clientServicesTable)
    .innerJoin(clientsTable, eq(clientServicesTable.clientId, clientsTable.id))
    .where(
      and(
        eq(clientServicesTable.serviceId, svc.id),
        ...(clientServiceIds?.length ? [inArray(clientServicesTable.id, clientServiceIds)] : []),
      ),
    );
  if (rows.length === 0) return [];

  const upcoming = await db
    .select({ csId: jobsTable.clientServiceId, count: sql<number>`count(*)` })
    .from(jobsTable)
    .where(
      and(
        inArray(
          jobsTable.clientServiceId,
          rows.map((r) => r.cs.id),
        ),
        eq(jobsTable.status, "scheduled"),
      ),
    )
    .groupBy(jobsTable.clientServiceId);
  const aheadOf = new Map(upcoming.map((u) => [u.csId, Number(u.count)]));
  const hasMatrix = svc.pricingEquations.length > 0;
  /** What the service alone charges a row at `rate` — the same sum `resolveServicePrice` does without a matrix. */
  const flatAt = (rate: number, quantity: number | null) =>
    roundMoney(svc.billingMode === "time" ? rate : rate * (quantity ?? 1));

  const out: Candidate[] = [];
  for (const { cs, client } of rows) {
    const priced = await resolveServicePrice(db, svc, client, { quantity: cs.quantity });
    out.push({
      cs,
      client: { id: client.id, name: client.name, propertyData: client.propertyData },
      newAmount: priced.amount,
      newBudgetedHours: priced.budgetedHours,
      missingField: priced.missingField,
      pricedFromLabel: priced.pricedFromLabel,
      pricedFromValue: priced.pricedFromValue,
      upcomingVisits: aheadOf.get(cs.id) ?? 0,
      // A customer with nothing under Property Details is NOT a price somebody
      // typed — the matrix simply had nothing to price from, which is a
      // different thing to tell him and a different thing to fix. Counting
      // those as hand-typed said "34 prices were typed by hand" about accounts
      // nobody had touched.
      //
      // On a flat service there is no label to go by, so the number itself is
      // the evidence: a row sitting on the rate the service used to charge was
      // never touched, and anything else was typed. Thirty accounts negotiated
      // down to $180 were being quietly slammed to the new $240 with no way to
      // leave them out.
      handTyped: hasMatrix
        ? cs.pricedFromLabel == null && priced.missingField == null
        : cs.amount !== flatAt(fromRate ?? svc.rate, cs.quantity),
    });
  }
  return out;
}

function candidateRow(c: Candidate, fields: PushField[]) {
  const pushPrice = fields.includes("price");
  const pushHours = fields.includes("hours");
  return {
    clientServiceId: c.cs.id,
    clientId: c.client.id,
    clientName: c.client.name,
    label: c.cs.label ?? null,
    cadence: cadenceLabel(c.cs),
    active: c.cs.active,
    paused: c.cs.pausedAt != null,
    handTyped: c.handTyped,
    missingField: c.missingField,
    pricedFromLabel: c.pricedFromLabel,
    pricedFromValue: c.pricedFromValue,
    fromAmount: c.cs.amount,
    toAmount: pushPrice ? c.newAmount : c.cs.amount,
    fromHours: c.cs.budgetedHours,
    toHours: pushHours ? c.newBudgetedHours : c.cs.budgetedHours,
    upcomingVisits: c.upcomingVisits,
  };
}

/**
 * "Ask if want to push on to current assigned jobs/customers" — and he cannot
 * answer that without being told how many customers he is about to change, so
 * this is what the dialog asks for the moment a service is saved.
 */
router.get("/services/:id/assigned-impact", async (req, res) => {
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, Number(req.params.id)));
  if (!svc) return res.status(404).json({ error: "Service not found" });
  const query = GetServiceAssignedImpactQueryParams.parse(req.query);
  const candidates = await candidatesFor(svc, null, query.fromRate ?? null);
  const rows = candidates.map((c) => candidateRow(c, ["price", "hours"]));
  const hours = (value: number | null | undefined) => (value == null ? null : Number(value));
  // The same two guards the push itself applies, so "N accounts would change"
  // is the number he gets when he presses the button. Telling him 40 above a
  // button that says 5 is how a number stops being worth reading; the prices
  // somebody typed and the customers with no measurement are counted on their
  // own lines underneath.
  const movable = rows.filter((r) => !r.handTyped);
  return res.json({
    serviceId: svc.id,
    serviceName: svc.name,
    billingMode: svc.billingMode,
    rate: svc.rate,
    billableHours: svc.billableHours,
    invoiceDescription: svc.invoiceDescription,
    seasonEndDate: svc.seasonEndDate,
    renewDate: svc.renewDate,
    matrixPriced: svc.pricingEquations.length > 0,
    clientCount: new Set(candidates.map((c) => c.client.id)).size,
    rowCount: candidates.length,
    upcomingVisits: candidates.reduce((sum, c) => sum + c.upcomingVisits, 0),
    priceDiffers: movable.filter((r) => r.missingField == null && r.toAmount !== r.fromAmount).length,
    hoursDiffers: movable.filter((r) => hours(r.toHours) !== hours(r.fromHours)).length,
    handTypedCount: rows.filter((r) => r.handTyped).length,
    missingFieldCount: rows.filter((r) => r.missingField != null).length,
    rows,
  });
});

/**
 * Push the price and the budgeted hours onto the accounts that already have
 * this service, and onto the visits still ahead of them. A visit the office
 * already re-priced by hand keeps its number — `propagateToFutureJobs` has
 * always honoured that and still does.
 */
router.post("/services/:id/push-to-assigned", async (req, res) => {
  const body = PushServiceToAssignedBody.parse(req.body ?? {});
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, Number(req.params.id)));
  if (!svc) return res.status(404).json({ error: "Service not found" });
  const fields = [...new Set(body.fields ?? [])] as PushField[];
  if (fields.length === 0) {
    return res.status(400).json({ error: "Pick what to push: the price, the billable hours, or both." });
  }
  // An empty list is "nobody", which is the one thing it must never read as
  // "everybody": leaving the list off is how you ask for every customer who
  // has the service, so a list that arrived empty is a caller with nothing
  // picked, not a request to re-price 300 accounts.
  if (body.clientServiceIds && body.clientServiceIds.length === 0) {
    return res.status(400).json({
      error: "No customers were picked. Leave the list off to push onto every customer who has this service.",
    });
  }

  const candidates = await candidatesFor(svc, body.clientServiceIds ?? null, body.fromRate ?? null);
  const includeTyped = body.includeCustomPrices === true;
  // A price nobody typed and a row that is simply already right are both
  // nothing to do; saying "34 customers changed" when 30 of them did not is
  // the kind of number he stops trusting.
  const willChange = candidates.filter((c) => {
    if (c.handTyped && !includeTyped) return false;
    if (c.missingField && fields.includes("price")) return false;
    const priceMoves = fields.includes("price") && c.newAmount !== c.cs.amount;
    const hoursMove =
      fields.includes("hours") && (c.newBudgetedHours ?? null) !== (c.cs.budgetedHours ?? null);
    return priceMoves || hoursMove;
  });
  const changing = new Set(willChange);
  const skipped = candidates
    .filter((c) => !changing.has(c))
    .map((c) => ({
      ...candidateRow(c, fields),
      // The missing measurement first: it is the one he can actually go and
      // fix, and it is the honest answer for a row the matrix could not price.
      reason: c.missingField && fields.includes("price")
        ? `this customer has no ${c.missingField} on file`
        : c.handTyped && !includeTyped
          ? "the price on this account was typed by hand"
          : "already up to date",
    }));

  if (body.apply !== true) {
    return res.json({
      applied: false,
      serviceId: svc.id,
      serviceName: svc.name,
      fields,
      clientCount: new Set(willChange.map((c) => c.client.id)).size,
      visitsUpdated: willChange.reduce((sum, c) => sum + c.upcomingVisits, 0),
      rows: willChange.map((c) => candidateRow(c, fields)),
      skipped,
    });
  }

  let visitsUpdated = 0;
  for (const c of willChange) {
    const patch: Partial<typeof clientServicesTable.$inferInsert> = {};
    if (fields.includes("price")) {
      patch.amount = c.newAmount;
      patch.pricedFromLabel = c.pricedFromLabel;
      patch.pricedFromValue = c.pricedFromValue;
    }
    if (fields.includes("hours")) patch.budgetedHours = c.newBudgetedHours;
    // One transaction per account: a bad row must not stop the other 300
    // customers from getting the new price.
    const [updated] = await db.transaction(async (tx) => {
      const rows = await tx
        .update(clientServicesTable)
        .set(patch)
        .where(eq(clientServicesTable.id, c.cs.id))
        .returning();
      if (rows[0]) await propagateToFutureJobs(rows[0], svc, tx);
      return rows;
    });
    if (!updated) continue;
    visitsUpdated += c.upcomingVisits;
    await logAudit({
      clientId: c.client.id,
      actorName: req.appUser?.name,
      action: "service_change_pushed",
      description:
        `"${svc.name}" changed on the service, pushed to this account: ` +
        [
          fields.includes("price") && c.newAmount !== c.cs.amount
            ? `price $${c.cs.amount} → $${c.newAmount}` +
              (c.pricedFromLabel ? ` (from ${c.pricedFromLabel} ${c.pricedFromValue})` : "")
            : null,
          fields.includes("hours") && (c.newBudgetedHours ?? null) !== (c.cs.budgetedHours ?? null)
            ? `billable hours ${c.cs.budgetedHours ?? "—"} → ${c.newBudgetedHours ?? "—"}`
            : null,
        ]
          .filter(Boolean)
          .join(", ") +
        `; ${c.upcomingVisits} upcoming visit(s) re-priced`,
    });
  }

  const clientCount = new Set(willChange.map((c) => c.client.id)).size;
  await logAudit({
    actorName: req.appUser?.name,
    action: "service_changes_pushed",
    description:
      `Pushed the new ${fields.map((f) => (f === "price" ? "price" : "billable hours")).join(" and ")} on "${svc.name}" ` +
      `to ${clientCount} customer${clientCount === 1 ? "" : "s"} (${willChange.length} assigned service row(s), ${visitsUpdated} upcoming visit(s))` +
      (skipped.length ? `; ${skipped.length} left alone` : ""),
  });
  return res.json({
    applied: true,
    serviceId: svc.id,
    serviceName: svc.name,
    fields,
    clientCount,
    visitsUpdated,
    rows: willChange.map((c) => ({ ...candidateRow(c, fields), fromAmount: c.cs.amount })),
    skipped,
  });
});

/**
 * "Season End date will be the same for all mowing clients."
 *
 * One date on the service, pushed onto every customer who has it, with the
 * visits past it cancelled. The date may be written year-free ("10-15"),
 * because it is the same day every year; each account gets it in the year its
 * own season runs in. A customer who already finishes EARLIER is left where
 * they are: they decided to stop early, and this is not the place to put them
 * back on until October.
 */
router.post("/services/:id/season-end", async (req, res) => {
  const body = SetServiceSeasonEndBody.parse(req.body ?? {});
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, Number(req.params.id)));
  if (!svc) return res.status(404).json({ error: "Service not found" });
  const problem = seasonDateError("Season end date", body.seasonEndDate);
  if (problem) return res.status(400).json({ error: problem });
  if (!body.seasonEndDate) return res.status(400).json({ error: "Give the day the season ends." });

  const today = todayLocal();
  // A day already gone by would cancel the rest of everybody's year, so a full
  // date in the past is refused rather than pushed. A year-free date always
  // lands in a season still ahead of us, so it is never caught by this.
  const typedDate = resolveSeasonDate(body.seasonEndDate, today);
  if (typedDate && typedDate < today) {
    return res.status(400).json({
      error: `The season cannot end on ${body.seasonEndDate} — that day has already gone by. Type 10-15 for the same day every year, or a day still ahead.`,
    });
  }

  const rows = await db
    .select({ cs: clientServicesTable, client: clientsTable })
    .from(clientServicesTable)
    .innerJoin(clientsTable, eq(clientServicesTable.clientId, clientsTable.id))
    // Paused accounts are left out on purpose: they have no visits on the board
    // to call off, and putting a date on a switched-off row would make it look
    // live again. Resume the customer first, then set their season end.
    .where(
      and(
        eq(clientServicesTable.serviceId, svc.id),
        eq(clientServicesTable.active, true),
        isNull(clientServicesTable.pausedAt),
      ),
    );

  const keepEarly = body.keepEarlierFinishes !== false;
  const planned: {
    cs: ClientService;
    client: Client;
    resolved: string;
    leftAlone: boolean;
    visitsCancelled: number;
    changed: boolean;
  }[] = [];
  for (const { cs, client } of rows) {
    // Judged from today, not from the row's own start date. A row the nightly
    // renewal has not rolled yet — auto-renew switched off, or a one-off —
    // still carries last spring's start, and anchoring "10-15" on that landed
    // the season end in a year already over, which called off the customer's
    // whole remaining season. The row's own start is only used when their
    // season has not begun yet.
    const start = seasonStartOf(cs);
    const resolved = resolveSeasonDate(body.seasonEndDate, start && start > today ? start : today);
    if (!resolved) continue;
    // "Finishing earlier" means earlier in the season this date belongs to. A
    // row still showing last year's finish is not somebody who stopped early,
    // it is the row that most needs the new date.
    const earlier = cs.seasonEndDate != null && cs.seasonEndDate >= today && cs.seasonEndDate < resolved;
    const leftAlone = keepEarly && earlier;
    planned.push({
      cs,
      client,
      resolved,
      leftAlone,
      visitsCancelled: leftAlone ? 0 : await visitsAfterCount(cs.id, resolved),
      changed: !leftAlone && cs.seasonEndDate !== resolved,
    });
  }

  const shape = () => ({
    serviceId: svc.id,
    serviceName: svc.name,
    seasonEndDate: body.seasonEndDate,
    customersChanged: new Set(planned.filter((p) => p.changed || p.visitsCancelled > 0).map((p) => p.client.id)).size,
    visitsCancelled: planned.reduce((sum, p) => sum + p.visitsCancelled, 0),
    rows: planned.map((p) => ({
      clientServiceId: p.cs.id,
      clientId: p.client.id,
      clientName: p.client.name,
      from: p.cs.seasonEndDate,
      to: p.leftAlone ? p.cs.seasonEndDate : p.resolved,
      visitsCancelled: p.visitsCancelled,
      leftAlone: p.leftAlone,
    })),
  });

  if (body.apply !== true) return res.json({ applied: false, ...shape() });

  const reason = body.reason?.trim() || `Season ends ${body.seasonEndDate}`;
  // The service's own copy is what new assignments inherit and what next
  // year's rollover reads, so it is saved exactly as typed — year-free stays
  // year-free.
  await db.update(servicesTable).set({ seasonEndDate: body.seasonEndDate }).where(eq(servicesTable.id, svc.id));
  for (const p of planned) {
    if (p.leftAlone) continue;
    const cancelled = await db.transaction(async (tx) => {
      await tx
        .update(clientServicesTable)
        .set({ seasonEndDate: p.resolved })
        .where(eq(clientServicesTable.id, p.cs.id));
      return cancelVisitsAfter(p.cs.id, p.resolved, reason, tx);
    });
    if (!p.changed && cancelled === 0) continue;
    await logAudit({
      clientId: p.client.id,
      actorName: req.appUser?.name,
      action: "service_season_end_pushed",
      description:
        `"${svc.name}" now ends ${p.resolved}` +
        (p.cs.seasonEndDate ? ` instead of ${p.cs.seasonEndDate}` : "") +
        `; ${cancelled} visit(s) after it cancelled`,
    });
  }
  const summary = shape();
  await logAudit({
    actorName: req.appUser?.name,
    action: "service_season_end_set",
    description:
      `Set the season end on "${svc.name}" to ${body.seasonEndDate} for every customer who has it: ` +
      `${summary.customersChanged} customer(s), ${summary.visitsCancelled} visit(s) cancelled` +
      (planned.some((p) => p.leftAlone)
        ? `; ${planned.filter((p) => p.leftAlone).length} finishing earlier were left alone`
        : ""),
  });
  return res.json({ applied: true, ...summary });
});

export default router;
