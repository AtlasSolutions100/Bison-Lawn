import { Router, type IRouter } from "express";
import { db, estimateFieldsTable, estimatesTable, clientsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  CreateEstimateFieldBody,
  UpdateEstimateFieldBody,
  CreateEstimateBody,
  SendEstimateBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit } from "../lib/helpers";

const router: IRouter = Router();

router.use(requireAuth, requireAdmin);

// ---- estimate fields ----

router.get("/estimate-fields", async (_req, res) => {
  return res.json(await db.select().from(estimateFieldsTable).orderBy(estimateFieldsTable.sortOrder, estimateFieldsTable.id));
});

router.post("/estimate-fields", async (req, res) => {
  const body = CreateEstimateFieldBody.parse(req.body);
  const [field] = await db.insert(estimateFieldsTable).values(body).returning();
  return res.status(201).json(field);
});

router.patch("/estimate-fields/:id", async (req, res) => {
  const body = UpdateEstimateFieldBody.parse(req.body);
  const [field] = await db
    .update(estimateFieldsTable)
    .set(body)
    .where(eq(estimateFieldsTable.id, Number(req.params.id)))
    .returning();
  if (!field) return res.status(404).json({ error: "Field not found" });
  return res.json(field);
});

router.delete("/estimate-fields/:id", async (req, res) => {
  await db.delete(estimateFieldsTable).where(eq(estimateFieldsTable.id, Number(req.params.id)));
  return res.status(204).end();
});

// ---- estimates ----

async function withClientName(est: typeof estimatesTable.$inferSelect) {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, est.clientId));
  return { ...est, clientName: client?.name ?? null };
}

router.get("/estimates", async (req, res) => {
  const clientId = req.query.clientId ? Number(req.query.clientId) : undefined;
  const rows = await db
    .select()
    .from(estimatesTable)
    .where(clientId ? eq(estimatesTable.clientId, clientId) : undefined)
    .orderBy(desc(estimatesTable.createdAt));
  return res.json(await Promise.all(rows.map(withClientName)));
});

router.post("/estimates", async (req, res) => {
  const body = CreateEstimateBody.parse(req.body);
  const total = body.lines.reduce((s, l) => s + (l.calculatedPrice ?? 0), 0);
  const [est] = await db
    .insert(estimatesTable)
    .values({
      clientId: body.clientId,
      notes: body.notes ?? null,
      lines: body.lines,
      total: Math.round(total * 100) / 100,
    })
    .returning();
  await logAudit({
    clientId: body.clientId,
    actorName: req.appUser?.name,
    action: "estimate_created",
    description: `Created estimate #${est.id} for $${est.total}`,
  });
  return res.status(201).json(await withClientName(est));
});

router.get("/estimates/:id", async (req, res) => {
  const [est] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, Number(req.params.id)));
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  return res.json(await withClientName(est));
});

router.delete("/estimates/:id", async (req, res) => {
  await db.delete(estimatesTable).where(eq(estimatesTable.id, Number(req.params.id)));
  return res.status(204).end();
});

router.post("/estimates/:id/send", async (req, res) => {
  const body = SendEstimateBody.parse(req.body);
  const [est] = await db
    .update(estimatesTable)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(estimatesTable.id, Number(req.params.id)))
    .returning();
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  await logAudit({
    clientId: est.clientId,
    actorName: req.appUser?.name,
    action: "estimate_sent",
    description: `Sent estimate #${est.id} to ${body.toEmail}`,
  });
  return res.json(await withClientName(est));
});

export default router;
