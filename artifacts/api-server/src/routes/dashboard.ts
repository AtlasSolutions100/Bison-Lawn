import { Router, type IRouter } from "express";
import {
  db,
  clientsTable,
  jobsTable,
  invoicesTable,
  paymentsTable,
  ticketsTable,
  auditEventsTable,
  usersTable,
  suggestedActionsTable,
  estimatesTable,
  webRequestsTable,
  emailSendsTable,
} from "@workspace/db";
import { and, count, desc, eq, gte, inArray, ne, sql, sum } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { todayISO } from "../lib/invoiceNumbers";
import { shownName } from "../lib/userAccounts";

const router: IRouter = Router();

router.use("/dashboard", requireAuth, requireAdmin);

router.get("/dashboard/summary", async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";

  const [
    [leads],
    [clients],
    [jobsToday],
    [jobsCompletedToday],
    [openInv],
    [waiting],
    [openTickets],
    [revenue],
    [interruptedMessages],
  ] = await Promise.all([
    db.select({ n: count() }).from(clientsTable).where(eq(clientsTable.status, "lead")),
    db.select({ n: count() }).from(clientsTable).where(eq(clientsTable.status, "client")),
    db
      .select({ n: count() })
      .from(jobsTable)
      .where(and(eq(jobsTable.dispatched, true), eq(jobsTable.scheduledDate, today))),
    db
      .select({ n: count() })
      .from(jobsTable)
      .where(and(eq(jobsTable.scheduledDate, today), eq(jobsTable.status, "completed"))),
    db
      .select({ total: sum(invoicesTable.total), paid: sum(invoicesTable.amountPaid) })
      .from(invoicesTable)
      .where(and(ne(invoicesTable.status, "void"), ne(invoicesTable.status, "paid"))),
    db.select({ n: count() }).from(jobsTable).where(eq(jobsTable.dispatched, false)),
    db.select({ n: count() }).from(ticketsTable).where(eq(ticketsTable.status, "open")),
    db
      .select({ total: sum(paymentsTable.amount) })
      .from(paymentsTable)
      .where(gte(paymentsTable.createdAt, new Date(monthStart))),
    // Approved customer messages whose delivery was interrupted: nobody knows
    // whether the customer was told, so the office must chase them by hand.
    db
      .select({ n: count() })
      .from(suggestedActionsTable)
      .where(eq(suggestedActionsTable.messageDeliveryState, "abandoned")),
  ]);

  return res.json({
    leadCount: leads.n,
    clientCount: clients.n,
    jobsToday: jobsToday.n,
    jobsCompletedToday: jobsCompletedToday.n,
    openInvoiceTotal: Math.round((Number(openInv.total ?? 0) - Number(openInv.paid ?? 0)) * 100) / 100,
    waitingListCount: waiting.n,
    openTickets: openTickets.n,
    revenueThisMonth: Number(revenue.total ?? 0),
    interruptedMessageCount: interruptedMessages.n,
  });
});

router.get("/dashboard/activity", async (_req, res) => {
  const rows = await db.select().from(auditEventsTable).orderBy(desc(auditEventsTable.createdAt)).limit(30);
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((x): x is number => x != null))];
  const clients = clientIds.length
    ? await db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds))
    : [];
  const cMap = new Map(clients.map((c) => [c.id, c.name]));
  return res.json(rows.map((r) => ({ ...r, clientName: r.clientId ? (cMap.get(r.clientId) ?? null) : null })));
});

router.get("/dashboard/contractor-earnings", async (req, res) => {
  const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
  const jobs = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.dispatched, true), eq(jobsTable.scheduledDate, date)));
  const users = await db.select().from(usersTable);
  const byUser = new Map<number, { jobCount: number; totalAmount: number; completedCount: number }>();
  for (const j of jobs) {
    if (j.assignedToId == null) continue;
    const e = byUser.get(j.assignedToId) ?? { jobCount: 0, totalAmount: 0, completedCount: 0 };
    e.jobCount++;
    e.totalAmount += j.amount;
    if (j.status === "completed") e.completedCount++;
    byUser.set(j.assignedToId, e);
  }
  return res.json(
    [...byUser.entries()].map(([contractorId, e]) => ({
      contractorId,
      contractorName: (() => {
        const u = users.find((x) => x.id === contractorId);
        return u ? shownName(u) : "Unknown";
      })(),
      jobCount: e.jobCount,
      totalAmount: Math.round(e.totalAmount * 100) / 100,
      completedCount: e.completedCount,
    })),
  );
});

/**
 * 2026-09-15 walkthrough: the alerts he wants on the first screen of the day —
 * estimates accepted, invoices that went out today, new website requests, and
 * emails that did not send. Each carries the last few rows and a count, so the
 * panel can say "3 estimates accepted" and name them without another trip.
 * A week back for the "recent" ones: older than that and it is history, not an
 * alert. Nothing here is marked read; the panel is a glance, not an inbox.
 */
router.get("/dashboard/alerts", async (_req, res) => {
  const today = todayISO();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // Timestamps are stored as UTC wall time, so they are read as UTC first and
  // only then shown on his calendar.
  const tz = process.env.APP_TIME_ZONE || "America/Los_Angeles";
  const LIMIT = 8;

  const [estimatesAccepted, [estimatesAcceptedCount], invoicesSent, [invoicesSentCount], webRequests, [webRequestsCount], failedEmails, [failedEmailsCount]] =
    await Promise.all([
      db
        .select({
          id: estimatesTable.id,
          clientId: estimatesTable.clientId,
          clientName: clientsTable.name,
          total: estimatesTable.total,
          at: estimatesTable.respondedAt,
        })
        .from(estimatesTable)
        .innerJoin(clientsTable, eq(clientsTable.id, estimatesTable.clientId))
        .where(and(eq(estimatesTable.status, "accepted"), gte(estimatesTable.respondedAt, weekAgo)))
        .orderBy(desc(estimatesTable.respondedAt))
        .limit(LIMIT),
      db
        .select({ n: count() })
        .from(estimatesTable)
        .where(and(eq(estimatesTable.status, "accepted"), gte(estimatesTable.respondedAt, weekAgo))),
      db
        .select({
          id: invoicesTable.id,
          number: invoicesTable.number,
          clientId: invoicesTable.clientId,
          clientName: clientsTable.name,
          total: invoicesTable.total,
          at: invoicesTable.sentAt,
        })
        .from(invoicesTable)
        .innerJoin(clientsTable, eq(clientsTable.id, invoicesTable.clientId))
        .where(sql`to_char((${invoicesTable.sentAt} at time zone 'UTC') at time zone ${tz}, 'YYYY-MM-DD') = ${today}`)
        .orderBy(desc(invoicesTable.sentAt))
        .limit(LIMIT),
      db
        .select({ n: count() })
        .from(invoicesTable)
        .where(sql`to_char((${invoicesTable.sentAt} at time zone 'UTC') at time zone ${tz}, 'YYYY-MM-DD') = ${today}`),
      db
        .select({
          id: webRequestsTable.id,
          name: webRequestsTable.name,
          address: webRequestsTable.address,
          message: webRequestsTable.message,
          at: webRequestsTable.createdAt,
        })
        .from(webRequestsTable)
        .where(eq(webRequestsTable.status, "new"))
        .orderBy(desc(webRequestsTable.createdAt))
        .limit(LIMIT),
      db.select({ n: count() }).from(webRequestsTable).where(eq(webRequestsTable.status, "new")),
      db
        .select({
          id: emailSendsTable.id,
          clientId: emailSendsTable.clientId,
          clientName: clientsTable.name,
          toEmail: emailSendsTable.toEmail,
          subject: emailSendsTable.subject,
          error: emailSendsTable.error,
          at: emailSendsTable.createdAt,
        })
        .from(emailSendsTable)
        .leftJoin(clientsTable, eq(clientsTable.id, emailSendsTable.clientId))
        .where(and(eq(emailSendsTable.status, "failed"), gte(emailSendsTable.createdAt, weekAgo)))
        .orderBy(desc(emailSendsTable.createdAt))
        .limit(LIMIT),
      db
        .select({ n: count() })
        .from(emailSendsTable)
        .where(and(eq(emailSendsTable.status, "failed"), gte(emailSendsTable.createdAt, weekAgo))),
    ]);

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return res.json({
    estimatesAccepted: {
      count: estimatesAcceptedCount.n,
      items: estimatesAccepted.map((e) => ({ ...e, at: iso(e.at) })),
    },
    invoicesSentToday: {
      count: invoicesSentCount.n,
      items: invoicesSent.map((i) => ({ ...i, number: i.number ?? i.id, at: iso(i.at) })),
    },
    webRequests: {
      count: webRequestsCount.n,
      items: webRequests.map((w) => ({ ...w, at: iso(w.at) })),
    },
    failedEmails: {
      count: failedEmailsCount.n,
      items: failedEmails.map((f) => ({ ...f, at: iso(f.at) })),
    },
  });
});

export default router;
