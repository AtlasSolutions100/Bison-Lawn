import { Router, type IRouter } from "express";
import {
  db,
  fieldNotesTable,
  jobsTable,
  ticketsTable,
  clientsTable,
  usersTable,
  servicesTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CreateFieldNoteBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit } from "../lib/helpers";

const router: IRouter = Router();

router.use(requireAuth);

type NoteRow = typeof fieldNotesTable.$inferSelect;

async function hydrate(rows: NoteRow[]) {
  if (rows.length === 0) return [];
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const userIds = [...new Set(rows.map((r) => r.authorId).filter((x): x is number => x != null))];
  const [clients, users] = await Promise.all([
    db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds)),
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : Promise.resolve([]),
  ]);
  const cMap = new Map(clients.map((c) => [c.id, c.name]));
  const uMap = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    ...r,
    clientName: cMap.get(r.clientId) ?? null,
    authorName: r.authorId ? (uMap.get(r.authorId) ?? null) : null,
  }));
}

/**
 * Contractors record/dictate a note on one of their jobs. The transcript is
 * stored and an office ticket is created so the office can review and act on
 * it. Both are recorded in the audit trail.
 */
router.post("/my/jobs/:id/field-notes", async (req, res) => {
  const body = CreateFieldNoteBody.parse(req.body);
  const jobId = Number(req.params.id);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) return res.status(404).json({ error: "Job not found" });

  const isAdmin = req.appUser!.role === "admin";
  const canAccess =
    isAdmin ||
    (job.assignedToId === req.appUser!.id && job.dispatched === true && job.visibleToContractor === true);
  if (!canAccess) return res.status(403).json({ error: "Forbidden" });

  let serviceName: string | null = null;
  if (job.serviceId) {
    const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, job.serviceId));
    serviceName = svc?.name ?? null;
  }
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, job.clientId));

  const transcript = body.transcript.trim();
  const summary = transcript.length > 60 ? `${transcript.slice(0, 57)}...` : transcript;

  const note = await db.transaction(async (tx) => {
    const [ticket] = await tx
      .insert(ticketsTable)
      .values({
        clientId: job.clientId,
        title: `Field note: ${summary}`,
        description: `From ${req.appUser!.name} on job #${job.id}${serviceName ? ` (${serviceName})` : ""}${job.scheduledDate ? `, scheduled ${job.scheduledDate}` : ""}:\n\n${transcript}`,
      })
      .returning();
    const [inserted] = await tx
      .insert(fieldNotesTable)
      .values({
        jobId: job.id,
        clientId: job.clientId,
        authorId: req.appUser!.id,
        transcript,
        source: body.source ?? "typed",
        ticketId: ticket.id,
      })
      .returning();
    return inserted;
  });

  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "field_note_created",
    description: `Field note (${note.source}) recorded on job #${job.id}${client ? ` for ${client.name}` : ""}; office ticket #${note.ticketId} created for review`,
  });

  return res.status(201).json((await hydrate([note]))[0]);
});

router.get("/field-notes", requireAdmin, async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const conds = [];
  if (q.jobId) conds.push(eq(fieldNotesTable.jobId, Number(q.jobId)));
  if (q.clientId) conds.push(eq(fieldNotesTable.clientId, Number(q.clientId)));
  const rows = await db
    .select()
    .from(fieldNotesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(fieldNotesTable.createdAt));
  return res.json(await hydrate(rows));
});

export default router;
