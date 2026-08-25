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
  UpdateLetterTemplateBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import {
  currentServiceAmount,
  deliverSpringLetters,
  getOrCreateLetterTemplate,
  renderSpringLetter,
} from "../lib/letterDelivery";
import { roundMoney } from "../lib/helpers";

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

export default router;
