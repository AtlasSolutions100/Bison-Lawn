import { Router, type IRouter } from "express";
import {
  db,
  invoicesTable,
  invoiceLineItemsTable,
  paymentsTable,
  clientsTable,
  jobsTable,
  servicesTable,
  billingSettingsTable,
} from "@workspace/db";
import { and, asc, desc, eq, isNull, ne, sum } from "drizzle-orm";
import {
  ApplyPaymentBody,
  CreateInvoiceBody,
  UpdateInvoiceBody,
  CreatePaymentBody,
  SendInvoiceBody,
} from "@workspace/api-zod";
import { UpdateBillingSettingsBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, recalcClientBalance, recalcInvoice, getBillingSettings, roundMoney } from "../lib/helpers";
import { getCompanyProfile } from "../lib/companyProfile";
import { dueDateFrom, nextInvoiceNumber, todayISO } from "../lib/invoiceNumbers";
import {
  balanceOf,
  createInvoiceEmailHtml,
  createInvoicePdf,
  invoiceEmailSubject,
  invoiceNumberOf,
} from "../lib/invoiceDocument";
import { sendInvoiceViaGmail } from "../lib/invoiceDelivery";
import { logger } from "../lib/logger";

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

type LineInput = { description: string; serviceDate?: string | null; quantity?: number; unitPrice?: number };

/**
 * Turn submitted lines into rows, with the per-line total computed once here.
 *
 * Rounded at the line rather than at the sum: the customer can add up the
 * printed column themselves, and a total that disagrees with its own lines by a
 * cent is the kind of thing that gets an invoice queried instead of paid.
 */
function toLineRows(invoiceId: number, lines: LineInput[]) {
  return lines.map((line, index) => {
    const quantity = line.quantity ?? 1;
    const unitPrice = line.unitPrice ?? 0;
    return {
      invoiceId,
      description: line.description,
      serviceDate: line.serviceDate ?? null,
      quantity,
      unitPrice,
      total: roundMoney(quantity * unitPrice),
      sortOrder: index,
    };
  });
}

const sumLines = (rows: { total: number }[]) => roundMoney(rows.reduce((acc, row) => acc + row.total, 0));

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
  const lines = await db
    .select()
    .from(invoiceLineItemsTable)
    .where(eq(invoiceLineItemsTable.invoiceId, inv.id))
    .orderBy(asc(invoiceLineItemsTable.sortOrder), asc(invoiceLineItemsTable.id));
  return {
    ...inv,
    clientName: client?.name ?? null,
    serviceName,
    // Surfaced so every consumer agrees on the number: the list, the detail
    // page, the PDF and the coupon were otherwise each free to subtract
    // differently, and one of them would eventually round the other way.
    number: invoiceNumberOf(inv),
    balance: balanceOf(inv),
    lines,
  };
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
    const { lines, ...invoiceFields } = body;
    const [client] = await tx.select().from(clientsTable).where(eq(clientsTable.id, body.clientId));
    if (!client) throw Object.assign(new Error("Client not found"), { status: 404 });

    const invoiceDate = invoiceFields.invoiceDate?.trim() || todayISO();
    // Terms come from the customer's account unless this invoice overrides them,
    // and are snapshotted here so changing the account later cannot restate an
    // invoice that has already gone out.
    const terms = invoiceFields.terms?.trim() || client.billingTerms?.trim() || null;

    const [row] = await tx
      .insert(invoicesTable)
      .values({
        ...invoiceFields,
        jobId: null,
        number: await nextInvoiceNumber(tx),
        invoiceDate,
        terms,
        dueDate: dueDateFrom(invoiceDate, terms),
        total: invoiceFields.total ?? 0,
      })
      .returning();

    if (lines?.length) {
      const rows = toLineRows(row.id, lines);
      await tx.insert(invoiceLineItemsTable).values(rows);
      // The lines are the invoice. A submitted `total` that disagrees with them
      // would print one number and owe another.
      await tx.update(invoicesTable).set({ total: sumLines(rows) }).where(eq(invoicesTable.id, row.id));
    }

    await recalcInvoice(row.id, tx);
    await recalcClientBalance(row.clientId, tx);
    const [fresh] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, row.id));
    return fresh;
  });
  await logAudit({
    clientId: inv.clientId,
    actorName: req.appUser?.name,
    action: "invoice_created",
    description: `Created invoice #${invoiceNumberOf(inv)} for $${inv.total}`,
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
    const { lines, ...invoiceFields } = body;
    const patch: Partial<typeof invoicesTable.$inferInsert> = { ...invoiceFields };

    // Re-derive the due date whenever either half of the calculation moves, so
    // a corrected invoice date cannot leave a due date behind from the old one.
    if (invoiceFields.terms !== undefined || invoiceFields.invoiceDate !== undefined) {
      const invoiceDate = invoiceFields.invoiceDate ?? existing.invoiceDate ?? todayISO();
      const terms = invoiceFields.terms ?? existing.terms;
      if (invoiceFields.dueDate === undefined) patch.dueDate = dueDateFrom(invoiceDate, terms);
    }

    if (lines) {
      await tx.delete(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, invoiceId));
      const rows = toLineRows(invoiceId, lines);
      if (rows.length) await tx.insert(invoiceLineItemsTable).values(rows);
      patch.total = sumLines(rows);
    }

    await tx.update(invoicesTable).set(patch).where(eq(invoicesTable.id, invoiceId));

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

/** Invoice, its client and its lines — everything either document builder needs. */
async function loadInvoiceForDocument(invoiceId: number) {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!invoice) return null;
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, invoice.clientId));
  if (!client) return null;
  const lines = await db
    .select()
    .from(invoiceLineItemsTable)
    .where(eq(invoiceLineItemsTable.invoiceId, invoiceId))
    .orderBy(asc(invoiceLineItemsTable.sortOrder), asc(invoiceLineItemsTable.id));
  return { invoice, client, lines, company: await getCompanyProfile() };
}

router.get("/invoices/:id/pdf", async (req, res) => {
  const data = await loadInvoiceForDocument(Number(req.params.id));
  if (!data) return res.status(404).json({ error: "Invoice not found" });
  const pdf = await createInvoicePdf(data);
  const number = invoiceNumberOf(data.invoice);
  res.setHeader("Content-Type", "application/pdf");
  // inline, not attachment: the office opens this to check it before sending,
  // and a forced download for every preview fills their Downloads folder.
  res.setHeader("Content-Disposition", `inline; filename="Invoice-${number}.pdf"`);
  return res.end(pdf);
});

router.post("/invoices/:id/send", async (req, res) => {
  const body = SendInvoiceBody.parse(req.body ?? {});
  const invoiceId = Number(req.params.id);
  const data = await loadInvoiceForDocument(invoiceId);
  if (!data) return res.status(404).json({ error: "Invoice not found" });
  if (data.invoice.status === "void") {
    return res.status(400).json({ error: "This invoice is void. Un-void it before sending." });
  }

  // Billing email first: that is the address the customer chose for bills, and
  // it is routinely a bookkeeper rather than the person whose lawn it is.
  const toEmail = (body.toEmail ?? data.client.billingEmail ?? data.client.email ?? "").trim();
  if (!toEmail) {
    return res
      .status(400)
      .json({ error: "No email address on file for this customer. Add one, or send the PDF yourself." });
  }

  const pdf = await createInvoicePdf(data);
  const html = createInvoiceEmailHtml(data);
  let messageId: string | null = null;
  try {
    const sent = await sendInvoiceViaGmail({
      toEmail,
      subject: invoiceEmailSubject(data.invoice, data.company),
      html,
      pdf,
      invoiceNumber: invoiceNumberOf(data.invoice),
      company: data.company,
    });
    messageId = (sent as { id?: string } | null)?.id ?? null;
  } catch (err) {
    logger.error({ err, invoiceId }, "failed to send invoice email");
    return res.status(502).json({ error: err instanceof Error ? err.message : "Could not send the invoice." });
  }

  // Stamped only after Gmail accepted it. Marking it sent before the send would
  // hide a failed invoice from the office in the one view built to catch them.
  await db.update(invoicesTable).set({ sentAt: new Date() }).where(eq(invoicesTable.id, invoiceId));
  await logAudit({
    clientId: data.invoice.clientId,
    actorName: req.appUser?.name,
    action: "invoice_sent",
    description: `Emailed invoice #${invoiceNumberOf(data.invoice)} to ${toEmail}`,
  });

  return res.json({ sent: true, toEmail, messageId });
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
