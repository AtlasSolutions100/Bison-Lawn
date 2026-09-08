import { Router, type IRouter } from "express";
import { db, ticketsTable, clientsTable, usersTable } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { CreateTicketBody, UpdateTicketBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(requireAuth);

async function hydrate(rows: (typeof ticketsTable.$inferSelect)[]) {
  if (rows.length === 0) return [];
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((x): x is number => x != null))];
  const userIds = [...new Set(rows.map((r) => r.assignedToId).filter((x): x is number => x != null))];
  const [clients, users] = await Promise.all([
    clientIds.length ? db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds)) : Promise.resolve([]),
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : Promise.resolve([]),
  ]);
  const cMap = new Map(clients.map((c) => [c.id, c.name]));
  const uMap = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    ...r,
    clientName: r.clientId ? (cMap.get(r.clientId) ?? null) : null,
    assignedToName: r.assignedToId ? (uMap.get(r.assignedToId) ?? null) : null,
  }));
}

router.get("/tickets", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const conds = [];
  const isAdmin = req.appUser!.role === "admin";
  if (!isAdmin) {
    // Contractors only see tickets assigned to them
    conds.push(eq(ticketsTable.assignedToId, req.appUser!.id));
  }
  if (q.clientId) conds.push(eq(ticketsTable.clientId, Number(q.clientId)));
  if (isAdmin && q.assignedTo) conds.push(eq(ticketsTable.assignedToId, Number(q.assignedTo)));
  if (q.status) conds.push(eq(ticketsTable.status, q.status));
  // Dispatch board filters. Two requests, and they only make sense together:
  // "tickets: put on dispatch board only if assigned to someone" and "tickets
  // to show on dispatch board for the date(s) specified on ticket creation".
  // A ticket nobody owns, or one not due on the day being worked, is noise on a
  // board that is about today's route.
  if (q.dueDate) conds.push(eq(ticketsTable.dueDate, q.dueDate));
  if (q.assigned === "true") conds.push(isNotNull(ticketsTable.assignedToId));
  const rows = await db
    .select()
    .from(ticketsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(ticketsTable.createdAt));
  return res.json(await hydrate(rows));
});

router.post("/tickets", requireAdmin, async (req, res) => {
  const body = CreateTicketBody.parse(req.body);
  const [ticket] = await db.insert(ticketsTable).values(body).returning();
  return res.status(201).json((await hydrate([ticket]))[0]);
});

router.patch("/tickets/:id", async (req, res) => {
  const body = UpdateTicketBody.parse(req.body);
  if (req.appUser!.role !== "admin") {
    const [existing] = await db
      .select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, Number(req.params.id)));
    if (!existing) return res.status(404).json({ error: "Ticket not found" });
    if (existing.assignedToId !== req.appUser!.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    // Assigned contractors may only toggle status
    if (Object.keys(body).some((k) => k !== "status")) {
      return res.status(403).json({ error: "Contractors can only update ticket status" });
    }
  }
  const [ticket] = await db
    .update(ticketsTable)
    .set(body)
    .where(eq(ticketsTable.id, Number(req.params.id)))
    .returning();
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  return res.json((await hydrate([ticket]))[0]);
});

router.delete("/tickets/:id", requireAdmin, async (req, res) => {
  await db.delete(ticketsTable).where(eq(ticketsTable.id, Number(req.params.id)));
  return res.status(204).end();
});

export default router;
