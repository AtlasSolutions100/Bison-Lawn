import { Router, type IRouter } from "express";
import { db, invoicesTable, paymentsTable, clientsTable, jobsTable, servicesTable, billingSettingsTable } from "@workspace/db";
import { and, desc, eq, isNull, ne, sum } from "drizzle-orm";
import {
  ApplyPaymentBody,
  CreateInvoiceBody,
  UpdateInvoiceBody,
  CreatePaymentBody,
} from "@workspace/api-zod";
import { UpdateBillingSettingsBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, recalcClientBalance, recalcInvoice, getBillingSettings, roundMoney } from "../lib/helpers";

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
  // Insert and rebalance together: the new total and the balance must never be
  // visible out of step, and the recalc needs the client lock to hold across both.
  const inv = await db.transaction(async (tx) => {
    const [row] = await tx.insert(invoicesTable).values({ ...body, jobId: null }).returning();
    await recalcClientBalance(row.clientId, tx);
    return row;
  });
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
  const invoiceId = Number(req.params.id);
  const fresh = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .for("update");
    if (!existing) return null;
    await tx.update(invoicesTable).set(body).where(eq(invoicesTable.id, invoiceId));

    // Note on the reverse transition: un-voiding gives back an open invoice with
    // nothing paid, and the detached money stays as credit for the office to apply
    // deliberately. That is intentional — re-attaching automatically would guess at
    // which invoice the payment belongs to, and by the time an invoice is un-voided
    // the credit has often already been spent elsewhere.
    if (body.status === "void" && existing.status !== "void") {
      // Voiding cancels the invoice, not the money. Detach its payments so they
      // become unapplied credit the office can put against the right invoice.
      // Leaving them attached would drop the invoice total out of the balance
      // while its payment stayed counted, inventing credit nobody paid.
      await tx
        .update(paymentsTable)
        .set({ invoiceId: null })
        .where(eq(paymentsTable.invoiceId, invoiceId));
    }

    await recalcInvoice(invoiceId, tx);
    await recalcClientBalance(existing.clientId, tx);
    const [row] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
    return row;
  });
  if (!fresh) return res.status(404).json({ error: "Invoice not found" });
  return res.json(await hydrateInvoice(fresh));
});

// ---- payments ----

async function hydratePayment(p: typeof paymentsTable.$inferSelect) {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, p.clientId));
  return { ...p, clientName: client?.name ?? null };
}

router.get("/payments", async (req, res) => {
  const clientId = req.query.clientId ? Number(req.query.clientId) : undefined;
  const conds = [];
  if (clientId) conds.push(eq(paymentsTable.clientId, clientId));
  if (req.query.unapplied === "true") conds.push(isNull(paymentsTable.invoiceId));
  const rows = await db
    .select()
    .from(paymentsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(paymentsTable.createdAt));
  return res.json(await Promise.all(rows.map(hydratePayment)));
});

router.post("/payments", async (req, res) => {
  const body = CreatePaymentBody.parse(req.body);
  const result = await db.transaction(async (tx) => {
    let invoice: typeof invoicesTable.$inferSelect | null = null;
    if (body.invoiceId != null) {
      [invoice] = await tx
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, body.invoiceId))
        .for("update");
      if (!invoice) return { error: "not_found" as const };
      if (invoice.clientId !== body.clientId) return { error: "wrong_client" as const };
      if (invoice.status === "void") return { error: "void" as const };
    }

    const received = roundMoney(body.amount);
    const remaining = invoice
      ? Math.max(0, roundMoney(invoice.total - invoice.amountPaid))
      : received;
    const appliedAmount = invoice ? Math.min(received, remaining) : received;
    const creditAmount = invoice ? roundMoney(received - appliedAmount) : 0;

    let payment: typeof paymentsTable.$inferSelect;
    if (appliedAmount > 0) {
      [payment] = await tx
        .insert(paymentsTable)
        .values({ ...body, amount: appliedAmount })
        .returning();
    } else {
      [payment] = await tx
        .insert(paymentsTable)
        .values({ ...body, invoiceId: null, amount: creditAmount })
        .returning();
    }
    if (creditAmount > 0 && appliedAmount > 0) {
      await tx.insert(paymentsTable).values({
        ...body,
        invoiceId: null,
        amount: creditAmount,
      });
    }

    if (invoice && appliedAmount > 0) {
      const paid = roundMoney(invoice.amountPaid + appliedAmount);
      await tx
        .update(invoicesTable)
        .set({ amountPaid: paid, status: paid >= roundMoney(invoice.total) ? "paid" : "partial" })
        .where(eq(invoicesTable.id, invoice.id));
    }
    await recalcClientBalance(body.clientId, tx);
    return { payment };
  });
  if ("error" in result) {
    if (result.error === "not_found") return res.status(404).json({ error: "Invoice not found" });
    if (result.error === "wrong_client") return res.status(400).json({ error: "Invoice does not belong to this client" });
    return res.status(400).json({ error: "Cannot record a payment against a void invoice" });
  }
  const { payment } = result;
  await logAudit({
    clientId: payment.clientId,
    actorName: req.appUser?.name,
    action: "payment_recorded",
    description: `Recorded $${roundMoney(body.amount).toFixed(2)} payment via ${payment.method}${payment.reference ? ` (ref ${payment.reference})` : ""}`,
  });
  return res.status(201).json(await hydratePayment(payment));
});

router.post("/payments/:id/apply", async (req, res) => {
  const body = ApplyPaymentBody.parse(req.body);
  const paymentId = Number(req.params.id);
  const result = await db.transaction(async (tx) => {
    const [credit] = await tx
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, paymentId))
      .for("update");
    if (!credit) return { error: "not_found" as const };
    if (credit.invoiceId != null) return { error: "already_applied" as const };

    const [invoice] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, body.invoiceId))
      .for("update");
    if (!invoice) return { error: "invoice_not_found" as const };
    if (invoice.clientId !== credit.clientId) return { error: "wrong_client" as const };
    if (invoice.status === "void") return { error: "void" as const };

    const remainingBalance = Math.max(0, roundMoney(invoice.total - invoice.amountPaid));
    const appliedAmount = Math.min(roundMoney(credit.amount), remainingBalance);
    const remainingCredit = roundMoney(credit.amount - appliedAmount);
    if (appliedAmount > 0) {
      if (remainingCredit > 0) {
        await tx
          .update(paymentsTable)
          .set({ amount: remainingCredit })
          .where(eq(paymentsTable.id, credit.id));
        await tx.insert(paymentsTable).values({
          clientId: credit.clientId,
          invoiceId: invoice.id,
          jobId: credit.jobId,
          amount: appliedAmount,
          cardFee: 0,
          method: credit.method,
          reference: credit.reference,
          notes: credit.notes,
        });
      } else {
        await tx
          .update(paymentsTable)
          .set({ invoiceId: invoice.id })
          .where(eq(paymentsTable.id, credit.id));
      }
      const paid = roundMoney(invoice.amountPaid + appliedAmount);
      await tx
        .update(invoicesTable)
        .set({ amountPaid: paid, status: paid >= roundMoney(invoice.total) ? "paid" : "partial" })
        .where(eq(invoicesTable.id, invoice.id));
    }

    await recalcClientBalance(credit.clientId, tx);
    return { appliedAmount, remainingCredit, clientId: credit.clientId };
  });

  if ("error" in result) {
    if (result.error === "not_found") return res.status(404).json({ error: "Payment not found" });
    if (result.error === "invoice_not_found") return res.status(404).json({ error: "Invoice not found" });
    if (result.error === "already_applied") return res.status(400).json({ error: "Payment is already attached to an invoice" });
    if (result.error === "wrong_client") return res.status(400).json({ error: "Invoice belongs to a different client" });
    return res.status(400).json({ error: "Cannot apply credit to a void invoice" });
  }
  await logAudit({
    clientId: result.clientId,
    actorName: req.appUser?.name,
    action: "payment_applied",
    description: `Applied $${result.appliedAmount.toFixed(2)} of account credit to invoice #${body.invoiceId}`,
  });
  return res.json({ appliedAmount: result.appliedAmount, remainingCredit: result.remainingCredit });
});

router.delete("/payments/:id", async (req, res) => {
  const paymentId = Number(req.params.id);
  // Lock order here must be invoice -> payment -> client. Voiding an invoice holds
  // the invoice lock and then bulk-updates that invoice's payments, taking their
  // row locks; grabbing the payment first would close a deadlock cycle against it.
  // So: read the payment unlocked purely to learn which invoice to lock, lock that
  // invoice, then take the payment lock and re-check what we actually hold.
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await db.transaction(async (tx) => {
      const [probe] = await tx
        .select({ invoiceId: paymentsTable.invoiceId })
        .from(paymentsTable)
        .where(eq(paymentsTable.id, paymentId));
      if (!probe) return "gone" as const;
      if (probe.invoiceId != null) {
        await tx
          .select({ id: invoicesTable.id })
          .from(invoicesTable)
          .where(eq(invoicesTable.id, probe.invoiceId))
          .for("update");
      }
      const [payment] = await tx
        .select()
        .from(paymentsTable)
        .where(eq(paymentsTable.id, paymentId))
        .for("update");
      if (!payment) return "gone" as const;
      // If it was attached to a different invoice while we were taking locks (an
      // apply landing first), we do not hold that invoice's lock and must not take
      // it now — that is precisely the order that deadlocks. Start over instead,
      // and the next pass locks the right invoice first.
      if (payment.invoiceId !== probe.invoiceId && payment.invoiceId != null) {
        return "retry" as const;
      }
      await tx.delete(paymentsTable).where(eq(paymentsTable.id, payment.id));
      if (payment.invoiceId != null) await recalcInvoice(payment.invoiceId, tx);
      await recalcClientBalance(payment.clientId, tx);
      return "done" as const;
    });
    if (outcome !== "retry") break;
  }
  return res.status(204).end();
});

export default router;
