import { Router, type IRouter } from "express";
import {
  clientsTable,
  clientServicesTable,
  db,
  letterSendsTable,
  letterTemplatesTable,
  servicesTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  RenewSpringLetterClientsBody,
  SendSpringLettersBody,
  SetSpringLetterPricesBody,
  PlanSpringLetterPricesBody,
  UpdateLetterTemplateBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import {
  currentServiceAmount,
  deliverSpringLetters,
  getOrCreateLetterTemplate,
  renderSpringLetter,
} from "../lib/letterDelivery";
import { logAudit, roundMoney } from "../lib/helpers";
import { propagateToFutureJobs } from "../lib/jobGeneration";

const router: IRouter = Router();

router.use(["/letter-template", "/spring-letters"], requireAuth, requireAdmin);

router.get("/letter-template", async (_req, res) => {
  return res.json(await getOrCreateLetterTemplate());
});

router.put("/letter-template", async (req, res) => {
  const body = UpdateLetterTemplateBody.parse(req.body);
  const existing = await getOrCreateLetterTemplate();
  const [saved] = await db
    .update(letterTemplatesTable)
    .set({
      name: body.name ?? existing.name,
      subject: body.subject,
      body: body.body,
      updatedAt: new Date(),
    })
    .where(eq(letterTemplatesTable.id, existing.id))
    .returning();
  return res.json(saved);
});

router.get("/spring-letters/clients", async (_req, res) => {
  const rows = await db
    .select({ client: clientsTable, clientService: clientServicesTable, service: servicesTable })
    .from(clientServicesTable)
    .innerJoin(clientsTable, eq(clientServicesTable.clientId, clientsTable.id))
    .innerJoin(servicesTable, eq(clientServicesTable.serviceId, servicesTable.id))
    .orderBy(asc(clientsTable.name), asc(servicesTable.name));

  const sends = rows.length
    ? await db
        .select()
        .from(letterSendsTable)
        .where(inArray(letterSendsTable.clientId, [...new Set(rows.map((row) => row.client.id))]))
        .orderBy(desc(letterSendsTable.createdAt), desc(letterSendsTable.id))
    : [];
  const latestSend = new Map<number, typeof letterSendsTable.$inferSelect>();
  for (const send of sends) {
    if (!latestSend.has(send.clientId)) latestSend.set(send.clientId, send);
  }

  const grouped = new Map<number, typeof rows>();
  for (const row of rows) grouped.set(row.client.id, [...(grouped.get(row.client.id) ?? []), row]);
  const currentYear = new Date().getFullYear();

  return res.json([...grouped.values()].map((clientRows) => {
    const { client } = clientRows[0];
    const services = clientRows.map(({ clientService, service }) => ({
      clientServiceId: clientService.id,
      serviceName: service.name,
      currentAmount: roundMoney(clientService.amount),
      newAmount: currentServiceAmount(clientService, service),
      // The catalogue price this row WOULD renew at, sent alongside so the
      // screen can show him what he is overriding and offer to drop back to it.
      catalogAmount: roundMoney(service.rate * clientService.quantity),
      customAmount: clientService.customAmount == null ? null : roundMoney(clientService.customAmount),
    }));
    const renewedDates = clientRows.map(({ clientService }) => clientService.lastRenewedAt);
    const fullyRenewed = renewedDates.every((date) => date && date.getFullYear() === currentYear);
    const lastRenewedAt = fullyRenewed
      ? renewedDates.reduce<Date | null>((latest, date) => !latest || (date && date > latest) ? date : latest, null)
      : null;
    const send = latestSend.get(client.id);
    return {
      clientId: client.id,
      clientName: client.name,
      email: client.email,
      services,
      currentTotal: roundMoney(services.reduce((sum, service) => sum + service.currentAmount, 0)),
      newTotal: roundMoney(services.reduce((sum, service) => sum + service.newAmount, 0)),
      lastRenewedAt: lastRenewedAt?.toISOString() ?? null,
      lastSendStatus: send?.status ?? null,
      lastSendError: send?.error ?? null,
      lastSentAt: send?.createdAt.toISOString() ?? null,
    };
  }));
});

function rollDateOneYear(value: string | null) {
  if (!value) return value;
  const [year, month, day] = value.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year + 1, month, 0)).getUTCDate();
  return `${year + 1}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

router.post("/spring-letters/renew", async (req, res) => {
  const { clientIds } = RenewSpringLetterClientsBody.parse(req.body);
  const outcomes = [];
  const currentYear = new Date().getFullYear();

  for (const clientId of [...new Set(clientIds)]) {
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
    if (!client) {
      outcomes.push({ clientId, clientName: `Client #${clientId}`, ok: false, error: "Client not found" });
      continue;
    }
    try {
      const totals = await db.transaction(async (tx) => {
        const rows = await tx
          .select({ clientService: clientServicesTable, service: servicesTable })
          .from(clientServicesTable)
          .innerJoin(servicesTable, eq(clientServicesTable.serviceId, servicesTable.id))
          .where(eq(clientServicesTable.clientId, clientId));
        if (!rows.length) throw new Error("No assigned services");
        const previousTotal = roundMoney(rows.reduce((sum, row) => sum + row.clientService.amount, 0));
        for (const { clientService, service } of rows) {
          const alreadyRenewed = clientService.lastRenewedAt?.getFullYear() === currentYear;
          await tx
            .update(clientServicesTable)
            .set({
              amount: currentServiceAmount(clientService, service),
              lastRenewedAt: new Date(),
              ...(alreadyRenewed ? {} : {
                startDate: rollDateOneYear(clientService.startDate),
                endDate: rollDateOneYear(clientService.endDate),
                firstServiceDate: rollDateOneYear(clientService.firstServiceDate),
                seasonEndDate: rollDateOneYear(clientService.seasonEndDate),
                renewDate: rollDateOneYear(clientService.renewDate),
              }),
            })
            .where(and(eq(clientServicesTable.id, clientService.id), eq(clientServicesTable.clientId, clientId)));
        }
        return {
          previousTotal,
          newTotal: roundMoney(rows.reduce((sum, row) => sum + currentServiceAmount(row.clientService, row.service), 0)),
        };
      });
      outcomes.push({ clientId, clientName: client.name, ok: true, error: null, ...totals });
    } catch (cause) {
      outcomes.push({
        clientId,
        clientName: client.name,
        ok: false,
        error: cause instanceof Error ? cause.message : "Renewal failed",
      });
    }
  }

  return res.json({ renewed: outcomes.filter((outcome) => outcome.ok).length, outcomes });
});

router.get("/spring-letters/preview/:id", async (req, res) => {
  const preview = await renderSpringLetter(Number(req.params.id));
  if (!preview) return res.status(404).json({ error: "Client not found" });
  return res.json(preview);
});

router.post("/spring-letters/send", async (req, res) => {
  const { clientIds } = SendSpringLettersBody.parse(req.body);
  return res.json(await deliverSpringLetters(clientIds));
});

// ---- per-customer prices for the spring letter (G5) ----
//
// "Some options select all and some custom prices, some increase %."
//
// Before this the only lever on the screen was the catalogue rate, and that
// rate is shared: changing it to settle one customer's price moved every
// customer on that service. These two endpoints are the per-customer half — a
// price typed against one row, and a percent raise aimed only at the customers
// he ticked. Both write client_services.customAmount, which
// currentServiceAmount reads, so the renewal and the letter quote his figure —
// and client_services.amount with it, which is the figure the visits on the
// board and the invoices raised off them copy. Writing only the first one meant
// the letter said $72.50 and the bill said $58.

/** Round to the nearest `roundTo` dollars when he asked for it. */
function roundTowards(value: number, roundTo: number | null | undefined): number {
  if (roundTo == null || !(roundTo > 0)) return roundMoney(value);
  return roundMoney(Math.round(value / roundTo) * roundTo);
}

/**
 * What a typed price has to write.
 *
 * `customAmount` alone is only what the letter quotes. The jobs on the board
 * and every invoice raised off them copy `client_services.amount`, so a price
 * he typed and sent out had to land there too — otherwise he quotes $72.50,
 * the season rolls over, and the bills go out at last year's $58. The field the
 * matrix priced it from goes with it: a price agreed with a customer is not
 * measured off their lawn any more, and leaving that label on the row would let
 * the next renewal reprice it from the matrix and bill something other than
 * what the letter said.
 */
function priceWrite(custom: number | null, amount: number) {
  return custom == null
    ? { customAmount: null, amount }
    : { customAmount: custom, amount, pricedFromLabel: null, pricedFromValue: null };
}

type PriceChange = {
  clientServiceId: number;
  clientId: number;
  clientName: string;
  serviceName: string;
  from: number;
  to: number;
};

/**
 * Type one customer's price. `amount: null` drops that row back to the
 * catalogue rate, which is the only way out of a custom price that does not
 * make him remember what the list price used to be.
 */
router.post("/spring-letters/prices", async (req, res) => {
  const { prices } = SetSpringLetterPricesBody.parse(req.body);
  const ids = [...new Set(prices.map((price) => price.clientServiceId))];
  if (!ids.length) return res.json({ saved: 0, cleared: 0, changes: [] });
  if (prices.some((price) => price.amount != null && price.amount < 0)) {
    return res.status(400).json({ error: "A price cannot be less than nothing." });
  }

  const rows = await db
    .select({ clientService: clientServicesTable, service: servicesTable, client: clientsTable })
    .from(clientServicesTable)
    .innerJoin(servicesTable, eq(clientServicesTable.serviceId, servicesTable.id))
    .innerJoin(clientsTable, eq(clientServicesTable.clientId, clientsTable.id))
    .where(inArray(clientServicesTable.id, ids));
  const byId = new Map(rows.map((row) => [row.clientService.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    return res.status(404).json({
      error: `${missing.length} of these services are no longer on the account. Reload the screen and try again.`,
    });
  }

  const changes: PriceChange[] = [];
  let saved = 0;
  let cleared = 0;
  for (const price of prices) {
    const row = byId.get(price.clientServiceId)!;
    const from = currentServiceAmount(row.clientService, row.service);
    const next = price.amount == null ? null : roundMoney(price.amount);
    if (next == null) cleared += 1;
    else saved += 1;
    const to = next ?? roundMoney(row.service.rate * row.clientService.quantity);
    const [written] = await db
      .update(clientServicesTable)
      .set(priceWrite(next, to))
      .where(eq(clientServicesTable.id, row.clientService.id))
      .returning();
    // The visits already on the board carry their own copy of the price, and
    // the invoice is raised off the visit. A figure he has typed and is about
    // to post out has to reach them, or this season bills the old number.
    // A visit whose price was edited by hand keeps it — that edit was deliberate.
    if (written) await propagateToFutureJobs(written, row.service);
    if (to !== from) {
      changes.push({
        clientServiceId: row.clientService.id,
        clientId: row.client.id,
        clientName: row.client.name,
        serviceName: row.service.name,
        from,
        to,
      });
    }
  }

  // Money, so it is audited by name: he has to be able to answer "why is this
  // customer paying that" six months later without remembering.
  for (const change of changes) {
    await logAudit({
      clientId: change.clientId,
      actorName: req.appUser?.name,
      action: "spring_letter_price_set",
      entityType: "client_service",
      entityId: change.clientServiceId,
      description:
        `Set this season's price for "${change.serviceName}" to $${change.to} (was $${change.from})` +
        " — the renewal and the spring letter both use it now",
    });
  }
  return res.json({ saved, cleared, changes });
});

/**
 * Raise, add to, or set the price of every service on the customers he ticked.
 *
 * `apply: false` is the preview: nothing is written and the screen shows every
 * from → to before he commits. Deliberately the same preview/apply shape as
 * the catalogue-wide bulk adjustment already on that screen, so the two bars
 * behave the same way — the only difference is who they reach.
 */
router.post("/spring-letters/price-plan", async (req, res) => {
  const body = PlanSpringLetterPricesBody.parse(req.body);
  if (!body.clientIds.length) return res.status(400).json({ error: "Tick the customers this should apply to." });
  if (!Number.isFinite(body.amount)) return res.status(400).json({ error: "Type a number." });
  if (body.mode === "set" && body.amount < 0) {
    return res.status(400).json({ error: "A price cannot be less than nothing." });
  }
  if (body.roundTo != null && !(body.roundTo > 0)) {
    return res.status(400).json({ error: "Round to a positive amount, or leave it blank." });
  }

  const rows = await db
    .select({ clientService: clientServicesTable, service: servicesTable, client: clientsTable })
    .from(clientServicesTable)
    .innerJoin(servicesTable, eq(clientServicesTable.serviceId, servicesTable.id))
    .innerJoin(clientsTable, eq(clientServicesTable.clientId, clientsTable.id))
    .where(inArray(clientServicesTable.clientId, [...new Set(body.clientIds)]))
    .orderBy(asc(clientsTable.name), asc(servicesTable.name));
  if (!rows.length) return res.json({ applied: false, mode: body.mode, changes: [] });

  const changes: PriceChange[] = rows.flatMap((row) => {
    const from = currentServiceAmount(row.clientService, row.service);
    const raw =
      body.mode === "percent" ? from * (1 + body.amount / 100)
      : body.mode === "add" ? from + body.amount
      : body.amount;
    // Never below nothing: a -200% raise or a $-500 cut is a typo, and a
    // negative price on a letter is a credit note he did not mean to send.
    const to = roundTowards(Math.max(0, raw), body.roundTo);
    if (to === from) return [];
    return [{
      clientServiceId: row.clientService.id,
      clientId: row.client.id,
      clientName: row.client.name,
      serviceName: row.service.name,
      from,
      to,
    }];
  });

  if (!body.apply) return res.json({ applied: false, mode: body.mode, changes });

  const serviceOf = new Map(rows.map((row) => [row.clientService.id, row.service]));
  for (const change of changes) {
    const [written] = await db
      .update(clientServicesTable)
      .set(priceWrite(change.to, change.to))
      .where(eq(clientServicesTable.id, change.clientServiceId))
      .returning();
    const svc = serviceOf.get(change.clientServiceId);
    if (written && svc) await propagateToFutureJobs(written, svc);
  }
  const how =
    body.mode === "percent" ? `${body.amount >= 0 ? "Raised" : "Lowered"} by ${Math.abs(body.amount)}%`
    : body.mode === "add" ? `${body.amount >= 0 ? "Added" : "Took off"} $${Math.abs(body.amount)}`
    : `Set to $${body.amount}`;
  const clientCount = new Set(changes.map((change) => change.clientId)).size;
  await logAudit({
    actorName: req.appUser?.name,
    action: "spring_letter_price_plan",
    description:
      `${how} this season's price on ${changes.length} assigned service${changes.length === 1 ? "" : "s"}` +
      ` across ${clientCount} customer${clientCount === 1 ? "" : "s"} from the spring letter screen`,
  });
  for (const change of changes) {
    await logAudit({
      clientId: change.clientId,
      actorName: req.appUser?.name,
      action: "spring_letter_price_set",
      entityType: "client_service",
      entityId: change.clientServiceId,
      description: `${how}: "${change.serviceName}" is $${change.to} this season (was $${change.from})`,
    });
  }
  return res.json({ applied: true, mode: body.mode, changes });
});

export default router;
