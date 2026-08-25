import { Router, type IRouter } from "express";
import { db, invoicesTable, paymentsTable, clientsTable, jobsTable, servicesTable, billingSettingsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  CreateInvoiceBody,
  UpdateInvoiceBody,
  CreatePaymentBody,
} from "@workspace/api-zod";
import { UpdateBillingSettingsBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, recalcClientBalance, recalcInvoice, getBillingSettings } from "../lib/helpers";

const router: IRouter = Router();

router.use(["/invoices", "/payments"], requireAuth, requireAdmin);

// ---- billing settings (card fee) ----
// Contractors need read access to disclose the card fee on site; only admins may change it.
router.get("/billing-settings", requireAuth, async (_req, res) => {
  const s = await getBillingSettings();
  return res.json({ cardFeeEnabled: s.cardFeeEnabled, cardFeePercent: s.cardFeePercent });
});

router.patch("/billing-settings", requireAuth, requireAdmin, async (req, res) => {
  const body = UpdateBillingSettingsBody.parse(req.body);
  const existing = await getBillingSettings();
  const [updated] = await db
    .update(billingSettingsTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(billingSettingsTable.id, existing.id))
    .returning();
  await logAudit({
    actorName: req.appUser?.name,
    action: "billing_settings_updated",
    description: `Card fee ${updated.cardFeeEnabled ? "enabled" : "disabled"} at ${updated.cardFeePercent}%`,
  });
  return res.json({ cardFeeEnabled: updated.cardFeeEnabled, cardFeePercent: updated.cardFeePercent });
});

async function hydrateInvoice(inv: typeof invoicesTable.$inferSelect) {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, inv.clientId));
  let serviceName: string | null = null;
  if (inv.jobId) {
    const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, inv.jobId));
    if (job?.serviceId) {
      const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, job.serviceId));
      serviceName = svc?.name ?? null;
    }
  }
  return { ...inv, clientName: client?.name ?? null, serviceName };
}

router.get("/invoices", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const conds = [];
  if (q.clientId) conds.push(eq(invoicesTable.clientId, Number(q.clientId)));
  if (q.status) conds.push(eq(invoicesTable.status, q.status));
  const rows = await db
    .select()
    .from(invoicesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(invoicesTable.createdAt));
  return res.json(await Promise.all(rows.map(hydrateInvoice)));
});

router.post("/invoices", async (req, res) => {
  const body = CreateInvoiceBody.parse(req.body);
  if (body.jobId != null) {
    // Job invoices are created exclusively by the atomic job-completion flow
    return res.status(400).json({ error: "Job invoices are created automatically when a job is completed" });
  }
  const [inv] = await db.insert(invoicesTable).values({ ...body, jobId: null }).returning();
  await recalcClientBalance(inv.clientId);
  await logAudit({
    clientId: inv.clientId,
    actorName: req.appUser?.name,
    action: "invoice_created",
    description: `Created invoice #${inv.id} for $${inv.total}`,
  });
  return res.status(201).json(await hydrateInvoice(inv));
});

router.get("/invoices/:id", async (req, res) => {
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, Number(req.params.id)));
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  return res.json(await hydrateInvoice(inv));
});

router.patch("/invoices/:id", async (req, res) => {
  const body = UpdateInvoiceBody.parse(req.body);
  const [inv] = await db
    .update(invoicesTable)
    .set(body)
    .where(eq(invoicesTable.id, Number(req.params.id)))
    .returning();
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  await recalcInvoice(inv.id);
  await recalcClientBalance(inv.clientId);
  const [fresh] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv.id));
  return res.json(await hydrateInvoice(fresh));
});

// ---- payments ----

async function hydratePayment(p: typeof paymentsTable.$inferSelect) {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, p.clientId));
  return { ...p, clientName: client?.name ?? null };
}

router.get("/payments", async (req, res) => {
  const clientId = req.query.clientId ? Number(req.query.clientId) : undefined;
  const rows = await db
    .select()
    .from(paymentsTable)
    .where(clientId ? eq(paymentsTable.clientId, clientId) : undefined)
    .orderBy(desc(paymentsTable.createdAt));
  return res.json(await Promise.all(rows.map(hydratePayment)));
});

router.post("/payments", async (req, res) => {
  const body = CreatePaymentBody.parse(req.body);
  if (body.invoiceId != null) {
    const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, body.invoiceId));
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.clientId !== body.clientId) {
      return res.status(400).json({ error: "Invoice does not belong to this client" });
    }
    if (inv.status === "void") {
      return res.status(400).json({ error: "Cannot record a payment against a void invoice" });
    }
  }
  const [payment] = await db.insert(paymentsTable).values(body).returning();
  if (payment.invoiceId) await recalcInvoice(payment.invoiceId);
  await recalcClientBalance(payment.clientId);
  await logAudit({
    clientId: payment.clientId,
    actorName: req.appUser?.name,
    action: "payment_recorded",
    description: `Recorded $${payment.amount} payment via ${payment.method}${payment.reference ? ` (ref ${payment.reference})` : ""}`,
  });
  return res.status(201).json(await hydratePayment(payment));
});

router.delete("/payments/:id", async (req, res) => {
  const [payment] = await db
    .delete(paymentsTable)
    .where(eq(paymentsTable.id, Number(req.params.id)))
    .returning();
  if (payment) {
    if (payment.invoiceId) await recalcInvoice(payment.invoiceId);
    await recalcClientBalance(payment.clientId);
  }
  return res.status(204).end();
});

export default router;
