import { Router, type IRouter } from "express";
import {
  db,
  invoicesTable,
  invoiceLineItemsTable,
  paymentsTable,
  clientsTable,
  jobsTable,
  jobProductsTable,
  servicesTable,
  billingSettingsTable,
  auditEventsTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, ne, or, sql, sum, type SQL } from "drizzle-orm";
import {
  ApplyPaymentBody,
  AttachJobToInvoiceBody,
  CreateInvoiceBody,
  DeleteInvoiceBody,
  EmailInvoicesBody,
  UpdateInvoiceBody,
  CreatePaymentBody,
  SendInvoiceBody,
  UncompleteJobBody,
} from "@workspace/api-zod";
import { UpdateBillingSettingsBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin, requireArea } from "../middlewares/requireAuth";
import {
  logAudit,
  recalcClientBalance,
  recalcInvoice,
  getBillingSettings,
  roundMoney,
  type Executor,
} from "../lib/helpers";
import { dueDateFrom, nextInvoiceNumber, officeTimeZone, todayISO } from "../lib/invoiceNumbers";
import { balanceOf, createInvoicePdf, createInvoicesPdf, daysPastDueOf, invoiceNumberOf } from "../lib/invoiceDocument";
import { billedAccountBalances, emailInvoice, emailInvoices, loadInvoiceForDocument } from "../lib/invoiceDelivery";
import { discountAmountFor } from "../lib/jobGeneration";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use(["/invoices", "/payments"], requireAuth, requireArea("invoices"));

/**
 * Stamp the bills that were already checked before there was a Verify button.
 *
 * Every invoice the business raised before this build has no verifiedAt, so
 * without this they all pile into "Needs verification" — including the ones the
 * customer has already been emailed and the ones they have already paid — and
 * he would have to press Verify on hundreds of bills he sent months ago. Their
 * check was the fact they went out, so that is the date we record: when it was
 * sent, else when it was printed, else the day it was raised.
 *
 * Only the old ones: a bill raised by this build's job completion is "pending"
 * and is never touched, and the cutoff is the oldest invoice anyone has
 * verified, so a bill paid at the door today still waits for him to look at it.
 */
export async function backfillLegacyVerifiedAt() {
  return db.transaction(async (tx) => {
    // One writer at a time; two app processes starting together must not both
    // stamp the same rows.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('invoice_verified_at_backfill'))`);
    const result = await tx.execute(sql`
      update invoices
         set verified_at = coalesce(sent_at, printed_at, created_at)
       where verified_at is null
         and status in ('open', 'partial', 'paid')
         and created_at < coalesce((select min(verified_at) from invoices), now())
    `);
    const stamped = Number((result as unknown as { rowCount?: number | null }).rowCount ?? 0);
    if (stamped > 0) {
      await logAudit({
        action: "invoices_verified_backfill",
        description: `Counted ${stamped} older invoice${stamped === 1 ? "" : "s"} as already checked — they were sent or printed before there was a Verify button`,
      });
    }
    return stamped;
  });
}

let backfillRun: Promise<number> | null = null;
router.use(["/invoices", "/payments"], async (_req, _res, next) => {
  // Once per process, on the first look at the billing screens. A failure here
  // must never keep him out of his own invoices, so it is logged and dropped.
  backfillRun ??= backfillLegacyVerifiedAt().catch((err) => {
    logger.error({ err }, "could not backfill invoice verified_at");
    return 0;
  });
  await backfillRun;
  next();
});

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

type InvoiceRow = typeof invoicesTable.$inferSelect;
type LineInput = {
  description: string;
  serviceDate?: string | null;
  quantity?: number;
  unitPrice?: number;
  jobId?: number | null;
};

const money = (n: number) => `$${roundMoney(n).toFixed(2)}`;

/**
 * Turn submitted lines into rows, with the per-line total computed once here.
 *
 * Rounded at the line rather than at the sum: the customer can add up the
 * printed column themselves, and a total that disagrees with its own lines by a
 * cent is the kind of thing that gets an invoice queried instead of paid.
 */
function toLineRows(invoiceId: number, lines: LineInput[], startAt = 0) {
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
      sortOrder: startAt + index,
      jobId: line.jobId ?? null,
    };
  });
}

const sumLines = (rows: { total: number }[]) => roundMoney(rows.reduce((acc, row) => acc + row.total, 0));

/**
 * How a bill goes out to this customer. His Billing tab says email / print /
 * both; a customer with nothing chosen gets email if there is an address to
 * send to and paper if there is not, so nobody's bill silently goes nowhere.
 */
function deliveryMethodFor(client: Pick<typeof clientsTable.$inferSelect, "invoiceDelivery" | "billingEmail" | "email">) {
  const chosen = (client.invoiceDelivery ?? "").trim();
  if (chosen === "email" || chosen === "print" || chosen === "both") return chosen;
  return (client.billingEmail ?? client.email ?? "").trim() ? "email" : "print";
}

/**
 * Everything the invoices page reads off a row, loaded in a handful of
 * queries for the whole list rather than four per invoice: the queue tabs
 * refetch after every verify, and a season of bills is a few thousand rows.
 */
async function hydrateInvoices(rows: InvoiceRow[]) {
  if (rows.length === 0) return [];
  const invoiceIds = rows.map((r) => r.id);
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter((x): x is number => x != null))];
  const today = todayISO();

  const [clients, jobs, lines, lastPayments, credits, billedBalances] = await Promise.all([
    db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds)),
    jobIds.length
      ? db
          .select({ id: jobsTable.id, serviceId: jobsTable.serviceId })
          .from(jobsTable)
          .where(inArray(jobsTable.id, jobIds))
      : Promise.resolve([]),
    db
      .select()
      .from(invoiceLineItemsTable)
      .where(inArray(invoiceLineItemsTable.invoiceId, invoiceIds))
      .orderBy(asc(invoiceLineItemsTable.sortOrder), asc(invoiceLineItemsTable.id)),
    // "How they pay": the method on the customer's most recent payment, any
    // invoice. A customer who has never paid shows nothing rather than a guess.
    db
      .select({ clientId: paymentsTable.clientId, method: paymentsTable.method })
      .from(paymentsTable)
      .where(
        inArray(
          paymentsTable.id,
          db
            .select({ id: sql<number>`max(${paymentsTable.id})` })
            .from(paymentsTable)
            .where(inArray(paymentsTable.clientId, clientIds))
            .groupBy(paymentsTable.clientId),
        ),
      ),
    db
      .select({ clientId: paymentsTable.clientId, total: sum(paymentsTable.amount) })
      .from(paymentsTable)
      .where(and(inArray(paymentsTable.clientId, clientIds), isNull(paymentsTable.invoiceId)))
      .groupBy(paymentsTable.clientId),
    // What the customer owes on bills that have actually been issued. Not
    // clients.accountBalance: that counts last night's unchecked completions
    // too, and this is the figure the printed coupon and the emailed bill
    // quote back to the customer.
    billedAccountBalances(clientIds),
  ]);

  const serviceIds = [...new Set(jobs.map((j) => j.serviceId).filter((x): x is number => x != null))];
  const services = serviceIds.length
    ? await db.select({ id: servicesTable.id, name: servicesTable.name }).from(servicesTable).where(inArray(servicesTable.id, serviceIds))
    : [];

  const cMap = new Map(clients.map((c) => [c.id, c]));
  const jMap = new Map(jobs.map((j) => [j.id, j]));
  const sMap = new Map(services.map((s) => [s.id, s.name]));
  const payMap = new Map(lastPayments.map((p) => [p.clientId, p.method]));
  const creditMap = new Map(credits.map((c) => [c.clientId, roundMoney(Number(c.total ?? 0))]));
  const lineMap = new Map<number, typeof lines>();
  for (const line of lines) {
    const bucket = lineMap.get(line.invoiceId) ?? [];
    bucket.push(line);
    lineMap.set(line.invoiceId, bucket);
  }

  return rows.map((inv) => {
    const client = cMap.get(inv.clientId);
    const job = inv.jobId ? jMap.get(inv.jobId) : undefined;
    return {
      ...inv,
      clientName: client?.name ?? null,
      clientAddress: client
        ? [client.serviceAddress, client.city].map((v) => (v ?? "").trim()).filter(Boolean).join(", ") || null
        : null,
      clientEmail: (client?.billingEmail ?? client?.email ?? "").trim() || null,
      clientDoNotEmail: client?.doNotEmail ?? false,
      serviceName: job?.serviceId ? (sMap.get(job.serviceId) ?? null) : null,
      // Surfaced so every consumer agrees on the number: the list, the detail
      // page, the PDF and the coupon were otherwise each free to subtract
      // differently, and one of them would eventually round the other way.
      number: invoiceNumberOf(inv),
      balance: balanceOf(inv),
      accountBalance: billedBalances.get(inv.clientId) ?? 0,
      unappliedCredit: creditMap.get(inv.clientId) ?? 0,
      daysPastDue: daysPastDueOf(inv, today),
      lastPaymentMethod: payMap.get(inv.clientId) ?? null,
      needsVerification: awaitingVerification(inv),
      lines: lineMap.get(inv.id) ?? [],
    };
  });
}

async function hydrateInvoice(inv: InvoiceRow) {
  return (await hydrateInvoices([inv]))[0]!;
}

/** Still owed: open or partly paid. Pending is not "open" — nobody has been billed yet. */
const OWED = ["open", "partial"] as const;

/**
 * Whether the office still has to check this bill. Checking is a separate
 * fact from the money: a bill paid in full at the door is "paid" and still
 * needs a look before it goes out, so this reads verifiedAt, not the status.
 *
 * A bill the customer already holds was checked by definition — it went out.
 * Older invoices carry no verifiedAt at all (the column came with this build),
 * and asking him to Verify a bill he emailed in July, or one that a restart
 * caught before the backfill ran, is worse than trusting the send.
 */
const awaitingVerification = (inv: Pick<InvoiceRow, "verifiedAt" | "status" | "sentAt" | "printedAt">) =>
  inv.verifiedAt == null && inv.status !== "void" && inv.sentAt == null && inv.printedAt == null;

const effectiveDue = sql`coalesce(${invoicesTable.dueDate}, ${invoicesTable.invoiceDate})`;

/**
 * His invoice tabs, each a predicate on the row. An invoice can sit in two
 * of them at once (delivery "both" is in to_email and to_print until each has
 * happened), so every queue is defined on its own rather than as a state
 * machine.
 */
function queueCondition(queue: string, today: string): SQL | null {
  switch (queue) {
    case "pending":
      // Not "status = pending": a bill paid in full at the door is already
      // paid and still has to be checked, so it waits here too. One that was
      // already emailed or printed is not waiting on anybody (see
      // awaitingVerification) and stays out of this tab and its count.
      return and(
        isNull(invoicesTable.verifiedAt),
        ne(invoicesTable.status, "void"),
        isNull(invoicesTable.sentAt),
        isNull(invoicesTable.printedAt),
      )!;
    case "to_email":
      return and(
        inArray(invoicesTable.status, [...OWED, "paid"]),
        sql`${invoicesTable.verifiedAt} is not null`,
        isNull(invoicesTable.sentAt),
        inArray(invoicesTable.deliveryMethod, ["email", "both"]),
      )!;
    case "to_print":
      return and(
        inArray(invoicesTable.status, [...OWED, "paid"]),
        sql`${invoicesTable.verifiedAt} is not null`,
        isNull(invoicesTable.printedAt),
        inArray(invoicesTable.deliveryMethod, ["print", "both"]),
      )!;
    case "open":
      return inArray(invoicesTable.status, [...OWED]);
    case "past_due":
      // Only bills the customer has actually received: an unsent one is our
      // delay, not theirs, and it belongs in Needs verification or To email.
      return and(
        inArray(invoicesTable.status, [...OWED]),
        isNotNull(invoicesTable.sentAt),
        sql`${effectiveDue} is not null`,
        lt(effectiveDue, today),
      )!;
    case "paid":
      return eq(invoicesTable.status, "paid");
    case "void":
      return eq(invoicesTable.status, "void");
    default:
      return null;
  }
}

router.get("/invoices", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const conds: SQL[] = [];
  if (q.clientId) conds.push(eq(invoicesTable.clientId, Number(q.clientId)));
  if (q.status) conds.push(eq(invoicesTable.status, q.status));
  if (q.queue) {
    const cond = queueCondition(q.queue, todayISO());
    if (!cond) return res.status(400).json({ error: `Unknown queue "${q.queue}"` });
    conds.push(cond);
  }
  const search = (q.search ?? "").trim();
  if (search) {
    const like = `%${search}%`;
    const byClient = inArray(
      invoicesTable.clientId,
      db
        .select({ id: clientsTable.id })
        .from(clientsTable)
        .where(or(ilike(clientsTable.name, like), ilike(clientsTable.serviceAddress, like))),
    );
    // A bare number is an invoice number first ("#4912" on a cheque stub),
    // and a customer whose name happens to contain it second.
    const digits = /^#?(\d+)$/.exec(search);
    conds.push(digits ? or(byClient, eq(invoicesTable.number, Number(digits[1])))! : byClient);
  }
  const rows = await db
    .select()
    .from(invoicesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(invoicesTable.createdAt), desc(invoicesTable.id));
  return res.json(await hydrateInvoices(rows));
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
        // The office typed this one line by line, which is the verifying. It
        // goes straight to the email or print queue rather than back to him
        // to check what he just wrote.
        verifiedAt: new Date(),
        verifiedById: req.appUser?.id ?? null,
        deliveryMethod: deliveryMethodFor(client),
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
    description: `Created invoice #${invoiceNumberOf(inv)} for ${money(inv.total)}; goes out by ${inv.deliveryMethod}`,
    entityType: "invoice",
    entityId: inv.id,
  });
  return res.status(201).json(await hydrateInvoice(inv));
});

// ---- batch email / print ----
// Registered ahead of /invoices/:id so "email" and "print.pdf" are never read
// as an invoice id.

router.post("/invoices/email", async (req, res) => {
  const body = EmailInvoicesBody.parse(req.body);
  const ids = [...new Set(body.ids)];
  const result = await emailInvoices({ invoiceIds: ids, actorName: req.appUser?.name, actorId: req.appUser?.id });
  return res.json(result);
});

router.get("/invoices/print.pdf", async (req, res) => {
  const raw = String((req.query as Record<string, string | undefined>).ids ?? "");
  const ids = [...new Set(raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return res.status(400).json({ error: "No invoices to print" });
  if (ids.length > 500) return res.status(400).json({ error: "Print at most 500 invoices at a time" });

  const batch = [];
  for (const id of ids) {
    const data = await loadInvoiceForDocument(id);
    // Void bills do not go in envelopes, and a pending one has not been
    // checked yet — the single PDF button is there for looking at those.
    if (!data || data.invoice.status === "void" || awaitingVerification(data.invoice)) continue;
    batch.push(data);
  }
  if (batch.length === 0) {
    return res.status(400).json({ error: "None of those invoices can be printed (void or not yet verified)" });
  }

  const pdf = await createInvoicesPdf(batch);
  const now = new Date();
  const printedIds = batch.map((b) => b.invoice.id);
  await db.update(invoicesTable).set({ printedAt: now }).where(inArray(invoicesTable.id, printedIds));
  // One line per invoice so each bill's own history shows the print, plus the
  // customer card. Inserted in one statement: forty envelopes is forty rows.
  await db.insert(auditEventsTable).values(
    batch.map((b) => ({
      clientId: b.client.id,
      actorName: req.appUser?.name ?? null,
      action: "invoice_printed",
      description: `Printed invoice #${invoiceNumberOf(b.invoice)} (${money(balanceOf(b.invoice))} due)${
        batch.length > 1 ? ` in a run of ${batch.length}` : ""
      }`,
      entityType: "invoice",
      entityId: b.invoice.id,
    })),
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${batch.length === 1 ? `Invoice-${invoiceNumberOf(batch[0]!.invoice)}` : `Invoices-${todayISO()}`}.pdf"`,
  );
  return res.end(pdf);
});

router.get("/invoices/:id", async (req, res) => {
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, Number(req.params.id)));
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  return res.json(await hydrateInvoice(inv));
});

/**
 * Lines that belong to jobs other than the invoice's own (missed jobs added
 * after the fact). When those lines go, the job goes back to
 * completed-but-not-invoiced so it can be billed again rather than vanishing.
 */
async function releaseJobsNoLongerOnInvoice(tx: Executor, invoiceId: number, keptJobIds: Set<number>) {
  const attached = await tx
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.invoiceId, invoiceId));
  const [inv] = await tx.select({ jobId: invoicesTable.jobId }).from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  const released = attached.map((j) => j.id).filter((id) => id !== inv?.jobId && !keptJobIds.has(id));
  if (released.length) {
    await tx.update(jobsTable).set({ invoiceId: null }).where(inArray(jobsTable.id, released));
  }
  return released;
}

router.patch("/invoices/:id", async (req, res) => {
  const body = UpdateInvoiceBody.parse(req.body);
  const invoiceId = Number(req.params.id);
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .for("update");
    if (!existing) return null;
    // Only Verify moves an unchecked invoice on. Setting it "open" here would
    // skip the one check the queue exists for. (A paid-at-the-door bill is
    // already "paid" and still unchecked; the same rule holds for it.)
    if (awaitingVerification(existing) && body.status && body.status !== "void") return "pending" as const;
    const { lines, ...invoiceFields } = body;
    const patch: Partial<typeof invoicesTable.$inferInsert> = { ...invoiceFields };

    // Re-derive the due date whenever either half of the calculation moves, so
    // a corrected invoice date cannot leave a due date behind from the old one.
    if (invoiceFields.terms !== undefined || invoiceFields.invoiceDate !== undefined) {
      const invoiceDate = invoiceFields.invoiceDate ?? existing.invoiceDate ?? todayISO();
      const terms = invoiceFields.terms ?? existing.terms;
      if (invoiceFields.dueDate === undefined) patch.dueDate = dueDateFrom(invoiceDate, terms);
    }

    let released: number[] = [];
    if (lines) {
      await tx.delete(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, invoiceId));
      const rows = toLineRows(invoiceId, lines);
      if (rows.length) await tx.insert(invoiceLineItemsTable).values(rows);
      // A card surcharge the customer already paid goes back on before the
      // total is added up, so fixing a description cannot hand them a credit
      // for the fee.
      await ensureCardFeeLine(tx, invoiceId, rows.length);
      const kept = await tx
        .select({ total: invoiceLineItemsTable.total })
        .from(invoiceLineItemsTable)
        .where(eq(invoiceLineItemsTable.invoiceId, invoiceId));
      patch.total = sumLines(kept);
      released = await releaseJobsNoLongerOnInvoice(
        tx,
        invoiceId,
        new Set(rows.map((r) => r.jobId).filter((x): x is number => x != null)),
      );
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
    return { existing, row, released };
  });
  if (!outcome) return res.status(404).json({ error: "Invoice not found" });
  if (outcome === "pending") {
    return res.status(400).json({ error: "This invoice has not been verified yet. Press Verify instead." });
  }
  const { existing, row: fresh, released } = outcome;

  // One line in his words per save, so the invoice's history reads like a
  // story and not a column dump.
  const number = invoiceNumberOf(fresh);
  const changes: string[] = [];
  let action = "invoice_updated";
  if (body.status === "void" && existing.status !== "void") {
    action = "invoice_voided";
    changes.push(
      `Voided invoice #${number} (${money(existing.total)})` +
        (existing.amountPaid > 0 ? `; ${money(existing.amountPaid)} already paid stays on the account as credit` : ""),
    );
  } else if (body.status && existing.status === "void" && body.status !== "void") {
    action = "invoice_unvoided";
    changes.push(`Un-voided invoice #${number} (${money(fresh.total)})`);
  }
  if (body.lines) {
    changes.push(
      existing.total !== fresh.total
        ? `Edited the lines on invoice #${number}: was ${money(existing.total)}, now ${money(fresh.total)}`
        : `Edited the lines on invoice #${number} (${money(fresh.total)})`,
    );
    if (released.length) changes.push(`took job${released.length > 1 ? "s" : ""} #${released.join(", #")} off it`);
  }
  if (body.notes !== undefined && (body.notes ?? "") !== (existing.notes ?? "")) {
    changes.push(`changed the note to the customer on invoice #${number}`);
  }
  const dated: string[] = [];
  if (body.invoiceDate !== undefined && body.invoiceDate !== existing.invoiceDate) dated.push(`invoice date to ${body.invoiceDate}`);
  if (body.dueDate !== undefined && body.dueDate !== existing.dueDate) dated.push(`due date to ${body.dueDate}`);
  if (body.terms !== undefined && body.terms !== existing.terms) dated.push(`terms to ${body.terms || "none"}`);
  if (body.poNumber !== undefined && body.poNumber !== existing.poNumber) dated.push(`PO number to ${body.poNumber || "none"}`);
  if (dated.length) changes.push(`changed the ${dated.join(", ")} on invoice #${number}`);
  if (changes.length) {
    const description = changes.join("; ");
    await logAudit({
      clientId: fresh.clientId,
      actorName: req.appUser?.name,
      action,
      description: description.charAt(0).toUpperCase() + description.slice(1),
      entityType: "invoice",
      entityId: fresh.id,
    });
  }
  return res.json(await hydrateInvoice(fresh));
});

router.delete("/invoices/:id", async (req, res) => {
  const body = DeleteInvoiceBody.parse(req.body ?? {});
  const invoiceId = Number(req.params.id);
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .for("update");
    if (!existing) return { error: "not_found" as const };
    // Once a customer has seen it or paid on it, deleting it rewrites history
    // they hold a copy of. Void keeps the number and the record.
    const seen = existing.sentAt != null || existing.printedAt != null;
    const paid = existing.amountPaid > 0;
    if ((seen || paid) && !body.force) return { error: "refused" as const, seen, paid };

    // The money stays: an invoice can be a mistake, a cheque never is.
    await tx.update(paymentsTable).set({ invoiceId: null }).where(eq(paymentsTable.invoiceId, invoiceId));
    // Jobs it billed go back to completed-and-not-invoiced, where the unbilled
    // work report picks them up so they can be billed again.
    const jobs = await tx
      .update(jobsTable)
      .set({ invoiceId: null })
      .where(eq(jobsTable.invoiceId, invoiceId))
      .returning({ id: jobsTable.id });
    await tx.delete(invoicesTable).where(eq(invoicesTable.id, invoiceId));
    await recalcClientBalance(existing.clientId, tx);
    return { existing, jobIds: jobs.map((j) => j.id) };
  });
  if ("error" in outcome) {
    if (outcome.error === "not_found") return res.status(404).json({ error: "Invoice not found" });
    const why = [outcome.seen ? "already went out to the customer" : null, outcome.paid ? "has a payment on it" : null]
      .filter(Boolean)
      .join(" and ");
    return res.status(409).json({
      error: `This invoice ${why}. Void it instead, or delete anyway and any money paid stays on the account as credit.`,
    });
  }
  const { existing, jobIds } = outcome;
  await logAudit({
    clientId: existing.clientId,
    actorName: req.appUser?.name,
    action: "invoice_deleted",
    description:
      `Deleted invoice #${invoiceNumberOf(existing)} (${money(existing.total)})` +
      (existing.amountPaid > 0 ? `; ${money(existing.amountPaid)} paid on it stays on the account as credit` : "") +
      (jobIds.length ? `; job${jobIds.length > 1 ? "s" : ""} #${jobIds.join(", #")} back to not invoiced` : ""),
    entityType: "invoice",
    entityId: existing.id,
  });
  return res.status(204).end();
});

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
  const [exists] = await db.select({ id: invoicesTable.id }).from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!exists) return res.status(404).json({ error: "Invoice not found" });

  const outcome = await emailInvoice({
    invoiceId,
    actorName: req.appUser?.name,
    actorId: req.appUser?.id,
    toEmailOverride: body.toEmail,
    bulk: false,
  });
  if (outcome.status === "skipped") {
    const reasons: Record<typeof outcome.reason, string> = {
      void: "This invoice is void. Un-void it before sending.",
      not_verified: "This invoice has not been verified yet. Check it and press Verify first.",
      no_email: "No email address on file for this customer. Add one, or print the PDF instead.",
      already_sent: "This invoice was already emailed.",
    };
    return res.status(400).json({ error: reasons[outcome.reason] });
  }
  if (outcome.status === "failed") return res.status(502).json({ error: outcome.reason });
  return res.json({ sent: true, toEmail: outcome.toEmail, messageId: outcome.messageId });
});

router.post("/invoices/:id/verify", async (req, res) => {
  const invoiceId = Number(req.params.id);
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .for("update");
    if (!existing) return { error: "not_found" as const };
    if (existing.status === "void") return { error: "void" as const };
    if (existing.verifiedAt) return { error: "already" as const };
    const [client] = await tx.select().from(clientsTable).where(eq(clientsTable.id, existing.clientId));
    if (!client) return { error: "not_found" as const };

    // The clock on the bill starts when the bill goes out, not when the mower
    // did. Completion dates the invoice by the service date, and his bills go
    // out after the last job of the month, so a September 1st mow verified on
    // the 30th arrived already two weeks past due — in red, in the Past due
    // tab, with the past-due chaser able to fire the day after they got it.
    // The invoice date stays the day of the work, which is what the customer
    // is being billed for; only the due date moves, and only forwards.
    const reDue = dueDateFrom(todayISO(), existing.terms);
    const dueDate =
      reDue && (existing.dueDate == null || reDue > existing.dueDate) ? reDue : existing.dueDate;

    await tx
      .update(invoicesTable)
      .set({
        verifiedAt: new Date(),
        verifiedById: req.appUser?.id ?? null,
        deliveryMethod: deliveryMethodFor(client),
        dueDate,
        // Out of pending; recalcInvoice then settles open / partial / paid
        // from whatever was already paid at the door.
        status: existing.status === "pending" ? "open" : existing.status,
      })
      .where(eq(invoicesTable.id, invoiceId));
    await recalcInvoice(invoiceId, tx);
    await recalcClientBalance(existing.clientId, tx);
    const [row] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
    return { row, client };
  });
  if ("error" in outcome) {
    if (outcome.error === "not_found") return res.status(404).json({ error: "Invoice not found" });
    if (outcome.error === "void") return res.status(400).json({ error: "This invoice is void" });
    return res.status(400).json({ error: "This invoice was already verified" });
  }
  const { row, client } = outcome;
  const HOW: Record<string, string> = { email: "email", print: "print", both: "email and print" };
  const how = HOW[row.deliveryMethod ?? "email"] ?? row.deliveryMethod;
  await logAudit({
    clientId: row.clientId,
    actorName: req.appUser?.name,
    action: "invoice_verified",
    description:
      `Verified invoice #${invoiceNumberOf(row)} (${money(row.total)}) for ${client.name}; goes out by ${how}` +
      (row.dueDate ? `, due ${row.dueDate}` : ""),
    entityType: "invoice",
    entityId: row.id,
  });
  return res.json(await hydrateInvoice(row));
});

/**
 * Lines for a job that was completed but never billed, in the shape
 * createInvoiceForJob would have written: the service (its invoice
 * description, else its name), then each part. Every line carries the job id
 * so it can be pulled back off again.
 */
async function linesForMissedJob(tx: Executor, job: typeof jobsTable.$inferSelect): Promise<LineInput[]> {
  const [svc] = job.serviceId
    ? await tx.select().from(servicesTable).where(eq(servicesTable.id, job.serviceId))
    : [];
  const products = await tx.select().from(jobProductsTable).where(eq(jobProductsTable.jobId, job.id));
  const label = svc?.invoiceDescription?.trim() || svc?.name || "Service";
  const lines: LineInput[] = [
    { description: label, serviceDate: job.scheduledDate ?? null, quantity: 1, unitPrice: roundMoney(job.amount), jobId: job.id },
    ...products.map((p) => ({
      description: p.name,
      serviceDate: job.scheduledDate ?? null,
      quantity: p.quantity,
      unitPrice: p.price,
      jobId: job.id,
    })),
  ];
  // The discount the customer is promised on every visit of this service, the
  // same arithmetic completion does (off the service, not the parts) and the
  // same negative line. Re-billing a job — the bill it was on got deleted, or
  // its lines were edited off — used to quietly charge the full price.
  const discount = discountAmountFor(roundMoney(job.amount), job.discountType, job.discountValue);
  if (discount > 0) {
    const billed = roundMoney(lines.reduce((sum, line) => sum + (line.quantity ?? 1) * (line.unitPrice ?? 0), 0));
    // Never more than the work itself: a discount cannot pay the customer.
    const off = roundMoney(Math.min(discount, Math.max(0, billed)));
    if (off > 0) {
      lines.push({
        description: job.discountLabel?.trim() || "Discount",
        serviceDate: job.scheduledDate ?? null,
        quantity: 1,
        unitPrice: -off,
        jobId: job.id,
      });
    }
  }
  return lines;
}

/** The line a card surcharge prints as, on every path that writes one. */
const CARD_FEE_LINE = "Card processing fee";

/**
 * Put any card surcharge the customer was charged on the bill as its own line.
 *
 * A card payment taken on site after the job was closed adds its fee straight
 * to the invoice total with no line to show it (routes/jobs.ts). The next time
 * anything adds the lines up — a missed job, a fixed description, an undo — the
 * fee fell off the bill while the money stayed paid, so the customer ended up
 * with a credit for the fee they had agreed to. Written as a line it survives
 * every later edit, and they can see what it was.
 */
async function ensureCardFeeLine(tx: Executor, invoiceId: number, sortStart: number) {
  const [fees] = await tx
    .select({ total: sum(paymentsTable.cardFee) })
    .from(paymentsTable)
    .where(eq(paymentsTable.invoiceId, invoiceId));
  const charged = roundMoney(Number(fees?.total ?? 0));
  if (charged <= 0) return;
  const existing = await tx
    .select({ total: invoiceLineItemsTable.total })
    .from(invoiceLineItemsTable)
    .where(and(eq(invoiceLineItemsTable.invoiceId, invoiceId), eq(invoiceLineItemsTable.description, CARD_FEE_LINE)));
  const missing = roundMoney(charged - sumLines(existing));
  if (missing <= 0) return;
  await tx.insert(invoiceLineItemsTable).values({
    invoiceId,
    description: CARD_FEE_LINE,
    serviceDate: null,
    quantity: 1,
    unitPrice: missing,
    total: missing,
    sortOrder: sortStart,
    jobId: null,
  });
}

router.post("/invoices/:id/attach-job", async (req, res) => {
  const body = AttachJobToInvoiceBody.parse(req.body);
  const invoiceId = Number(req.params.id);
  const outcome = await db.transaction(async (tx) => {
    // Job first, then invoice — the same order undo-completion takes.
    const [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, body.jobId)).for("update");
    if (!job) return { error: "job_not_found" as const };
    const [invoice] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .for("update");
    if (!invoice) return { error: "not_found" as const };
    // A checked, paid bill is closed. One paid at the door but not checked yet
    // can still take a missed job: the office is looking at it for exactly that.
    if (invoice.status === "void" || (invoice.status === "paid" && !awaitingVerification(invoice))) {
      return { error: "closed" as const };
    }
    if (job.clientId !== invoice.clientId) return { error: "wrong_client" as const };
    if (job.status !== "completed") return { error: "not_completed" as const };
    if (job.invoiceId != null || job.id === invoice.jobId) return { error: "already_invoiced" as const };

    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${invoiceLineItemsTable.sortOrder}), -1) + 1` })
      .from(invoiceLineItemsTable)
      .where(eq(invoiceLineItemsTable.invoiceId, invoiceId));
    const rows = toLineRows(invoiceId, await linesForMissedJob(tx, job), Number(next));
    await tx.insert(invoiceLineItemsTable).values(rows);
    await tx.update(jobsTable).set({ invoiceId }).where(eq(jobsTable.id, job.id));
    // The money already collected on this job comes back with it: whatever
    // released the job left its on-site payments unattached, and a card
    // surcharge belongs on the bill that charges for the work.
    await tx
      .update(paymentsTable)
      .set({ invoiceId })
      .where(and(eq(paymentsTable.jobId, job.id), isNull(paymentsTable.invoiceId)));
    await ensureCardFeeLine(tx, invoiceId, Number(next) + rows.length);
    const all = await tx
      .select({ total: invoiceLineItemsTable.total })
      .from(invoiceLineItemsTable)
      .where(eq(invoiceLineItemsTable.invoiceId, invoiceId));
    await tx.update(invoicesTable).set({ total: sumLines(all) }).where(eq(invoicesTable.id, invoiceId));
    await recalcInvoice(invoiceId, tx);
    await recalcClientBalance(invoice.clientId, tx);
    const [row] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
    return { row, job, added: sumLines(rows), label: rows[0]!.description };
  });
  if ("error" in outcome) {
    const messages = {
      job_not_found: [404, "Job not found"],
      not_found: [404, "Invoice not found"],
      closed: [400, "This invoice is paid or void; put the job on a new invoice instead"],
      wrong_client: [400, "That job belongs to a different customer"],
      not_completed: [400, "Only a completed job can be billed"],
      already_invoiced: [400, "That job is already on an invoice"],
    } as const;
    const [status, error] = messages[outcome.error as keyof typeof messages];
    return res.status(status).json({ error });
  }
  const { row, job, added, label } = outcome;
  await logAudit({
    clientId: row.clientId,
    actorName: req.appUser?.name,
    action: "invoice_job_added",
    description: `Added missed job #${job.id} (${label}${job.scheduledDate ? ` on ${job.scheduledDate}` : ""}, ${money(added)}) to invoice #${invoiceNumberOf(row)}; now ${money(row.total)}`,
    entityType: "invoice",
    entityId: row.id,
  });
  return res.json(await hydrateInvoice(row));
});

router.get("/invoices/:id/audit", async (req, res) => {
  const invoiceId = Number(req.params.id);
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  const number = invoiceNumberOf(inv);
  // Rows stamped with the invoice, its payments and its job; any of this
  // customer's rows that name "#4912" in the sentence (a payment that was
  // later deleted still happened to this bill); and the older rows from
  // before events were stamped, which wrote "#<row id>" rather than the number.
  const rows = await db
    .select()
    .from(auditEventsTable)
    .where(
      or(
        and(eq(auditEventsTable.entityType, "invoice"), eq(auditEventsTable.entityId, invoiceId)),
        and(
          eq(auditEventsTable.entityType, "payment"),
          inArray(
            auditEventsTable.entityId,
            db.select({ id: paymentsTable.id }).from(paymentsTable).where(eq(paymentsTable.invoiceId, invoiceId)),
          ),
        ),
        inv.jobId != null ? and(eq(auditEventsTable.entityType, "job"), eq(auditEventsTable.entityId, inv.jobId)) : sql`false`,
        and(
          eq(auditEventsTable.clientId, inv.clientId),
          sql`${auditEventsTable.description} ~ ${`#${number}([^0-9]|$)`}`,
        ),
        and(
          eq(auditEventsTable.clientId, inv.clientId),
          isNull(auditEventsTable.entityType),
          sql`${auditEventsTable.description} ~ ${`#${inv.id}([^0-9]|$)`}`,
        ),
      ),
    )
    .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
    .limit(300);
  return res.json(rows.map((r) => ({ ...r, clientName: null })));
});

// ---- undo a completion ----

router.post("/jobs/:id/uncomplete", requireAuth, requireArea("invoices"), async (req, res) => {
  const body = UncompleteJobBody.parse(req.body ?? {});
  const jobId = Number(req.params.id);
  const outcome = await db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!job) return { error: "not_found" as const };
    if (job.status !== "completed") return { error: "not_completed" as const };

    // Its bill: the invoice made for it, or the one it was added to as a
    // missed job. Either way the row is found by the job, not trusted from
    // jobs.invoiceId alone, which has no FK and can dangle.
    let invoice: InvoiceRow | undefined;
    if (job.invoiceId != null) {
      [invoice] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, job.invoiceId)).for("update");
    }
    if (!invoice) {
      const [line] = await tx
        .select({ invoiceId: invoiceLineItemsTable.invoiceId })
        .from(invoiceLineItemsTable)
        .where(eq(invoiceLineItemsTable.jobId, jobId))
        .limit(1);
      if (line) {
        [invoice] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, line.invoiceId)).for("update");
      }
    }

    let invoiceVoided = false;
    let removed = 0;
    if (invoice && invoice.status !== "void") {
      // A bill the customer already has cannot quietly lose a line. Void it,
      // then undo the completion, and send them a fresh one.
      if (invoice.sentAt || invoice.printedAt) return { error: "already_sent" as const, invoice };
      const own = invoice.jobId === jobId;
      const gone = await tx
        .delete(invoiceLineItemsTable)
        .where(
          and(
            eq(invoiceLineItemsTable.invoiceId, invoice.id),
            own
              ? or(isNull(invoiceLineItemsTable.jobId), eq(invoiceLineItemsTable.jobId, jobId))
              : eq(invoiceLineItemsTable.jobId, jobId),
          ),
        )
        .returning({ total: invoiceLineItemsTable.total });
      removed = sumLines(gone);
      const left = await tx
        .select({ total: invoiceLineItemsTable.total })
        .from(invoiceLineItemsTable)
        .where(eq(invoiceLineItemsTable.invoiceId, invoice.id));
      if (left.length === 0) {
        // Nothing left to bill. Void rather than delete so the number and the
        // trail survive; money paid at the door becomes credit, as any void.
        invoiceVoided = true;
        await tx.update(invoicesTable).set({ status: "void", total: 0 }).where(eq(invoicesTable.id, invoice.id));
        await tx.update(paymentsTable).set({ invoiceId: null }).where(eq(paymentsTable.invoiceId, invoice.id));
      } else {
        // Same rule as an edit: a surcharge that was collected stays on the
        // bill as a line rather than dropping out of the total.
        await ensureCardFeeLine(tx, invoice.id, left.length);
        const rest = await tx
          .select({ total: invoiceLineItemsTable.total })
          .from(invoiceLineItemsTable)
          .where(eq(invoiceLineItemsTable.invoiceId, invoice.id));
        await tx.update(invoicesTable).set({ total: sumLines(rest) }).where(eq(invoicesTable.id, invoice.id));
      }
      await recalcInvoice(invoice.id, tx);
    }

    const back = {
      status: "scheduled" as const,
      completedAt: null,
      invoiceId: null,
      ...(body.sendTo === "waiting_list"
        ? // Same reset as the board's "send back to waiting list".
          { dispatched: false, scheduledDate: null, routeOrder: null }
        : {}),
    };
    const [restored] = await tx.update(jobsTable).set(back).where(eq(jobsTable.id, jobId)).returning();
    await recalcClientBalance(job.clientId, tx);
    return { job: restored, invoice, invoiceVoided, removed };
  });
  if ("error" in outcome) {
    if (outcome.error === "not_found") return res.status(404).json({ error: "Job not found" });
    if (outcome.error === "not_completed") return res.status(400).json({ error: "This job is not completed" });
    return res.status(400).json({
      error: `Invoice #${invoiceNumberOf((outcome as { invoice: InvoiceRow }).invoice)} already went out to the customer. Void it first, then undo the completion.`,
    });
  }
  const { job, invoice, invoiceVoided, removed } = outcome;
  const where = body.sendTo === "waiting_list" ? "the waiting list" : job.scheduledDate ? `the board for ${job.scheduledDate}` : "the board";
  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "job_uncompleted",
    description:
      `Undid the completion of job #${job.id}; back on ${where}` +
      (invoice && invoice.status !== "void"
        ? invoiceVoided
          ? `; invoice #${invoiceNumberOf(invoice)} voided (nothing left on it)`
          : `; ${money(removed)} taken off invoice #${invoiceNumberOf(invoice)}`
        : ""),
    entityType: invoice ? "invoice" : "job",
    entityId: invoice ? invoice.id : job.id,
  });
  return res.json({
    jobId: job.id,
    invoiceId: invoice?.id ?? null,
    invoiceNumber: invoice ? invoiceNumberOf(invoice) : null,
    invoiceVoided,
  });
});

// ---- payments ----

type PaymentRow = typeof paymentsTable.$inferSelect;

async function hydratePayments(rows: PaymentRow[]) {
  if (rows.length === 0) return [];
  const clientIds = [...new Set(rows.map((p) => p.clientId))];
  const invoiceIds = [...new Set(rows.map((p) => p.invoiceId).filter((x): x is number => x != null))];
  const [clients, invoices] = await Promise.all([
    db.select({ id: clientsTable.id, name: clientsTable.name }).from(clientsTable).where(inArray(clientsTable.id, clientIds)),
    invoiceIds.length
      ? db.select({ id: invoicesTable.id, number: invoicesTable.number }).from(invoicesTable).where(inArray(invoicesTable.id, invoiceIds))
      : Promise.resolve([]),
  ]);
  const cMap = new Map(clients.map((c) => [c.id, c.name]));
  const iMap = new Map(invoices.map((i) => [i.id, invoiceNumberOf(i)]));
  return rows.map((p) => ({
    ...p,
    clientName: cMap.get(p.clientId) ?? null,
    invoiceNumber: p.invoiceId != null ? (iMap.get(p.invoiceId) ?? null) : null,
  }));
}

async function hydratePayment(p: PaymentRow) {
  return (await hydratePayments([p]))[0]!;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

router.get("/payments", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const conds: SQL[] = [];
  if (q.clientId) conds.push(eq(paymentsTable.clientId, Number(q.clientId)));
  if (q.unapplied === "true") conds.push(isNull(paymentsTable.invoiceId));
  if (q.method?.trim()) conds.push(eq(paymentsTable.method, q.method.trim()));
  // A day is his day. Payment times are stored as UTC wall clock, so a cheque
  // keyed at 6 pm in Post Falls is stored on tomorrow's date; comparing the raw
  // timestamp to a date meant an evening payment could not be found by the day
  // it was taken. The boundaries are built in the office's timezone instead.
  const tz = officeTimeZone();
  const officeStart = (day: string, plusDays = 0) =>
    sql`((${day}::date + ${plusDays}::int)::timestamp at time zone ${tz}) at time zone 'UTC'`;
  if (q.from) {
    if (!DATE_ONLY.test(q.from)) return res.status(400).json({ error: "from must be YYYY-MM-DD" });
    conds.push(gte(paymentsTable.createdAt, officeStart(q.from)));
  }
  if (q.to) {
    if (!DATE_ONLY.test(q.to)) return res.status(400).json({ error: "to must be YYYY-MM-DD" });
    conds.push(lt(paymentsTable.createdAt, officeStart(q.to, 1)));
  }
  const search = (q.search ?? "").trim();
  if (search) {
    const like = `%${search}%`;
    const parts: SQL[] = [
      ilike(paymentsTable.reference, like),
      ilike(paymentsTable.notes, like),
      sql`cast(${paymentsTable.amount} as text) ilike ${like}`,
      inArray(
        paymentsTable.clientId,
        db.select({ id: clientsTable.id }).from(clientsTable).where(ilike(clientsTable.name, like)),
      ),
    ];
    // "#4912" or "4912" finds the payments on that invoice.
    const digits = /^#?(\d+)$/.exec(search);
    if (digits) {
      parts.push(
        inArray(
          paymentsTable.invoiceId,
          db.select({ id: invoicesTable.id }).from(invoicesTable).where(eq(invoicesTable.number, Number(digits[1]))),
        ),
      );
    }
    conds.push(or(...parts)!);
  }
  const rows = await db
    .select()
    .from(paymentsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(paymentsTable.createdAt), desc(paymentsTable.id));
  return res.json(await hydratePayments(rows));
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
      // Through recalcInvoice, not a hand-set status: a payment taken at the
      // door on a pending invoice must leave it pending for the office to check.
      await recalcInvoice(invoice.id, tx);
    }
    await recalcClientBalance(body.clientId, tx);
    return { payment, invoice, creditAmount };
  });
  if ("error" in result) {
    if (result.error === "not_found") return res.status(404).json({ error: "Invoice not found" });
    if (result.error === "wrong_client") return res.status(400).json({ error: "Invoice does not belong to this client" });
    return res.status(400).json({ error: "Cannot record a payment against a void invoice" });
  }
  const { payment, invoice, creditAmount } = result;
  await logAudit({
    clientId: payment.clientId,
    actorName: req.appUser?.name,
    action: "payment_recorded",
    description:
      `Recorded ${money(body.amount)} payment via ${payment.method}${payment.reference ? ` (ref ${payment.reference})` : ""}` +
      (invoice ? ` on invoice #${invoiceNumberOf(invoice)}` : " as credit on the account") +
      (invoice && creditAmount > 0 ? `; ${money(creditAmount)} over the balance kept as credit` : ""),
    entityType: "payment",
    entityId: payment.id,
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
    let appliedPaymentId = credit.id;
    if (appliedAmount > 0) {
      if (remainingCredit > 0) {
        await tx
          .update(paymentsTable)
          .set({ amount: remainingCredit })
          .where(eq(paymentsTable.id, credit.id));
        const [split] = await tx
          .insert(paymentsTable)
          .values({
            clientId: credit.clientId,
            invoiceId: invoice.id,
            jobId: credit.jobId,
            amount: appliedAmount,
            cardFee: 0,
            method: credit.method,
            reference: credit.reference,
            notes: credit.notes,
          })
          .returning();
        appliedPaymentId = split.id;
      } else {
        await tx
          .update(paymentsTable)
          .set({ invoiceId: invoice.id })
          .where(eq(paymentsTable.id, credit.id));
      }
      await recalcInvoice(invoice.id, tx);
    }

    await recalcClientBalance(credit.clientId, tx);
    return { appliedAmount, remainingCredit, clientId: credit.clientId, invoice, appliedPaymentId };
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
    description:
      `Applied ${money(result.appliedAmount)} of account credit to invoice #${invoiceNumberOf(result.invoice)}` +
      (result.remainingCredit > 0 ? `; ${money(result.remainingCredit)} still on the account` : ""),
    entityType: "payment",
    entityId: result.appliedPaymentId,
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
  let deleted: { payment: PaymentRow; invoice: InvoiceRow | null } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await db.transaction(async (tx) => {
      const [probe] = await tx
        .select({ invoiceId: paymentsTable.invoiceId })
        .from(paymentsTable)
        .where(eq(paymentsTable.id, paymentId));
      if (!probe) return "gone" as const;
      let invoice: InvoiceRow | null = null;
      if (probe.invoiceId != null) {
        const [locked] = await tx
          .select()
          .from(invoicesTable)
          .where(eq(invoicesTable.id, probe.invoiceId))
          .for("update");
        invoice = locked ?? null;
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
      return { payment, invoice };
    });
    if (outcome === "retry") continue;
    if (outcome !== "gone") deleted = outcome;
    break;
  }
  if (deleted) {
    const { payment, invoice } = deleted;
    await logAudit({
      clientId: payment.clientId,
      actorName: req.appUser?.name,
      action: "payment_deleted",
      description:
        `Deleted ${money(payment.amount)} payment via ${payment.method}${payment.reference ? ` (ref ${payment.reference})` : ""}` +
        (invoice ? ` from invoice #${invoiceNumberOf(invoice)}, which is owed again` : " that was credit on the account"),
      entityType: invoice ? "invoice" : "payment",
      entityId: invoice ? invoice.id : payment.id,
    });
  }
  return res.status(204).end();
});

export default router;
