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
} from "@workspace/db";
import { and, count, desc, eq, gte, inArray, ne, sum } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";

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
      contractorName: users.find((u) => u.id === contractorId)?.name ?? "Unknown",
      jobCount: e.jobCount,
      totalAmount: Math.round(e.totalAmount * 100) / 100,
      completedCount: e.completedCount,
    })),
  );
});

export default router;
