import { Router, type IRouter } from "express";
import { db, clientsTable, invoicesTable, paymentsTable, ticketsTable, jobsTable, servicesTable } from "@workspace/db";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";

const router: IRouter = Router();

// One box for everything the office looks up by hand. Office only.
router.use("/search", requireAuth, requireArea("clients"));

const PER_GROUP = 8;

/**
 * 2026-09-15 walkthrough: "a global search box that searches clients, former
 * clients, tickets, invoices, payments at once". Every group runs at once and
 * each is capped, so a common word like "Hayden" comes back as a short list
 * per group rather than one long scroll. Former clients are searched the same
 * as current ones — the point of the box is finding the one he half-remembers.
 */
router.get("/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) return res.status(400).json({ error: "Type at least two characters" });
  const like = `%${q}%`;
  // Digits alone are how he looks up an invoice number or a payment amount;
  // the same digits also match a phone number or a house number in the others.
  const asNumber = /^\d+(\.\d{1,2})?$/.test(q) ? Number(q) : null;

  const [clients, tickets, invoices, payments, jobs] = await Promise.all([
    db
      .select({
        id: clientsTable.id,
        name: clientsTable.name,
        status: clientsTable.status,
        serviceAddress: clientsTable.serviceAddress,
        city: clientsTable.city,
        phone: clientsTable.phone,
        email: clientsTable.email,
        mapCode: clientsTable.mapCode,
      })
      .from(clientsTable)
      .where(
        or(
          ilike(clientsTable.name, like),
          ilike(clientsTable.serviceAddress, like),
          ilike(clientsTable.city, like),
          ilike(clientsTable.email, like),
          ilike(clientsTable.phone, like),
          ilike(clientsTable.mapCode, like),
          ilike(clientsTable.accountNumber, like),
          ilike(clientsTable.externalId, like),
          sql`exists (select 1 from jsonb_array_elements_text(${clientsTable.tags}) tag where tag ilike ${like})`,
        ),
      )
      .orderBy(clientsTable.name)
      .limit(PER_GROUP),
    db
      .select({
        id: ticketsTable.id,
        title: ticketsTable.title,
        status: ticketsTable.status,
        dueDate: ticketsTable.dueDate,
        clientId: ticketsTable.clientId,
        clientName: clientsTable.name,
      })
      .from(ticketsTable)
      .leftJoin(clientsTable, eq(clientsTable.id, ticketsTable.clientId))
      .where(or(ilike(ticketsTable.title, like), ilike(ticketsTable.description, like), ilike(clientsTable.name, like)))
      .orderBy(desc(ticketsTable.createdAt))
      .limit(PER_GROUP),
    db
      .select({
        id: invoicesTable.id,
        number: invoicesTable.number,
        status: invoicesTable.status,
        total: invoicesTable.total,
        amountPaid: invoicesTable.amountPaid,
        invoiceDate: invoicesTable.invoiceDate,
        poNumber: invoicesTable.poNumber,
        clientId: invoicesTable.clientId,
        clientName: clientsTable.name,
      })
      .from(invoicesTable)
      .innerJoin(clientsTable, eq(clientsTable.id, invoicesTable.clientId))
      .where(
        or(
          // Old rows have no number and show their id instead, so both match.
          sql`coalesce(${invoicesTable.number}, ${invoicesTable.id})::text ilike ${like}`,
          ilike(invoicesTable.poNumber, like),
          ilike(invoicesTable.notes, like),
          ilike(clientsTable.name, like),
          ...(asNumber != null ? [sql`abs(${invoicesTable.total} - ${asNumber}) < 0.005`] : []),
        ),
      )
      .orderBy(desc(invoicesTable.createdAt))
      .limit(PER_GROUP),
    db
      .select({
        id: paymentsTable.id,
        amount: paymentsTable.amount,
        method: paymentsTable.method,
        reference: paymentsTable.reference,
        invoiceId: paymentsTable.invoiceId,
        createdAt: paymentsTable.createdAt,
        clientId: paymentsTable.clientId,
        clientName: clientsTable.name,
      })
      .from(paymentsTable)
      .innerJoin(clientsTable, eq(clientsTable.id, paymentsTable.clientId))
      .where(
        or(
          ilike(paymentsTable.reference, like),
          ilike(paymentsTable.notes, like),
          ilike(clientsTable.name, like),
          ...(asNumber != null ? [sql`abs(${paymentsTable.amount} - ${asNumber}) < 0.005`] : []),
        ),
      )
      .orderBy(desc(paymentsTable.createdAt))
      .limit(PER_GROUP),
    db
      .select({
        id: jobsTable.id,
        status: jobsTable.status,
        scheduledDate: jobsTable.scheduledDate,
        amount: jobsTable.amount,
        clientId: jobsTable.clientId,
        clientName: clientsTable.name,
        address: clientsTable.serviceAddress,
        city: clientsTable.city,
        serviceName: servicesTable.name,
      })
      .from(jobsTable)
      .innerJoin(clientsTable, eq(clientsTable.id, jobsTable.clientId))
      .leftJoin(servicesTable, eq(servicesTable.id, jobsTable.serviceId))
      // Customer name and service name are in here because of the reason he
      // gave for not using one-time jobs at all: "waiting list or one-time jobs
      // will get lost because there's no way for me to search those." Looking
      // for a stray clean-up, he types the customer's name, not their street.
      .where(
        or(
          ilike(clientsTable.name, like),
          ilike(clientsTable.serviceAddress, like),
          ilike(servicesTable.name, like),
          ilike(jobsTable.mapNote, like),
          ilike(jobsTable.notes, like),
        ),
      )
      .orderBy(desc(jobsTable.scheduledDate))
      .limit(PER_GROUP),
  ]);

  return res.json({
    q,
    clients,
    tickets,
    invoices: invoices.map((i) => ({
      ...i,
      number: i.number ?? i.id,
      balance: Math.round((i.total - i.amountPaid) * 100) / 100,
    })),
    payments: payments.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
    jobs,
  });
});

export default router;
