import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql, sum } from "drizzle-orm";
import {
  db,
  clientsTable,
  documentTemplatesTable,
  emailSendsTable,
  invoiceLineItemsTable,
  invoicesTable,
  paymentsTable,
  type CompanyProfile,
} from "@workspace/db";
import { defaultGmailProxy, sendRawGmailMessage, type GmailProxy } from "./gmail";
import {
  GMAIL_MAX_MESSAGE_BYTES,
  describeBytes,
  encodeBase64Lines,
  safeFileName,
} from "./estimateDelivery";
import { getCompanyProfile } from "./companyProfile";
import { renderTemplate } from "./mergeTokens";
import { logAudit } from "./helpers";
import { todayISO } from "./invoiceNumbers";
import {
  balanceOf,
  createInvoiceEmailHtml,
  createInvoicePdf,
  daysPastDueOf,
  invoiceEmailSubject,
  invoiceNumberOf,
  type InvoiceDocumentData,
} from "./invoiceDocument";
import { logger } from "./logger";

/**
 * File name the customer sees on the attachment.
 *
 * Company name first because the invoice lands in a folder alongside every
 * other trade's paperwork, and "Invoice 4848.pdf" on its own is unfindable six
 * months later when they are looking for who mowed the lawn.
 */
function attachmentFileName(invoiceNumber: number, company: CompanyProfile | undefined) {
  const prefix = (company?.name ?? "").trim().replace(/\s+/g, "-");
  return safeFileName(`${prefix ? `${prefix}-` : ""}Invoice-${invoiceNumber}.pdf`, "invoice.pdf");
}

export async function sendInvoiceViaGmail(
  {
    toEmail,
    subject,
    html,
    pdf,
    invoiceNumber,
    company,
  }: {
    toEmail: string;
    subject: string;
    html: string;
    pdf: Buffer;
    invoiceNumber: number;
    company?: CompanyProfile;
  },
  proxy: GmailProxy = defaultGmailProxy,
) {
  const boundary = `bison_invoice_${randomBytes(12).toString("hex")}`;
  const fileName = attachmentFileName(invoiceNumber, company);
  const mime = [
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64Lines(html),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${fileName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${fileName}"`,
    "",
    encodeBase64Lines(pdf),
    `--${boundary}--`,
  ].join("\r\n");

  const messageBytes = Buffer.byteLength(mime);
  if (messageBytes > GMAIL_MAX_MESSAGE_BYTES) {
    throw new Error(
      `This invoice email is ${describeBytes(messageBytes)}, over the ` +
        `${describeBytes(GMAIL_MAX_MESSAGE_BYTES)} Gmail accepts.`,
    );
  }

  return sendRawGmailMessage(mime, proxy);
}

// ---- the "Bison bill" document ----------------------------------------------

export const BISON_BILL_TEMPLATE_KEY = "bison-bill";

/**
 * The email body every invoice goes out with, in his words and his tokens. The
 * payment disclosure paragraphs are the ones from his service contract, so
 * the bill and the contract say the same thing about late fees.
 *
 * Seeded on first send if it is missing, and never overwritten after: once it
 * exists it is his to edit in Settings > Documents like any other letter.
 */
export const BISON_BILL_DEFAULT = {
  name: "Bison bill",
  subject: "Invoice #[invoicenumber] | [companyname]",
  body: `Dear [clientfname],

Thank you for your business. Invoice #[invoicenumber] dated [invoicedate] is attached as a PDF, and the detail is below. The balance due on this invoice is [invoicebalance]. Your account balance is [accountbalance].

Payment Terms: Payments are due upon receipt of the invoice. Invoices are sent after the last completed job of the month.

Late Payments: In the event of late payment, a late fee of 3% may be applied to the outstanding balance. Late fees will accrue for each month the payment remains outstanding.

Suspension of Services: Failure to make timely payments may result in the suspension of lawn care services until the outstanding balance, including any accrued late fees, is settled.

Collections Procedures: If payment remains outstanding for 45 days after the due date, the client agrees that the service provider may take necessary actions to collect the overdue amount. This may include engaging a collections agency or pursuing legal means to recover the debt.

Thank you for choosing [companyname].

[signatureline]
[companyname]
[companyphonenumber]
[companyemail]`,
};

/** The Bison bill template row, creating it from the default the first time. */
export async function ensureBisonBillTemplate() {
  const [existing] = await db
    .select()
    .from(documentTemplatesTable)
    .where(eq(documentTemplatesTable.key, BISON_BILL_TEMPLATE_KEY))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(documentTemplatesTable)
    .values({
      key: BISON_BILL_TEMPLATE_KEY,
      name: BISON_BILL_DEFAULT.name,
      kind: "notice",
      category: "client",
      subject: BISON_BILL_DEFAULT.subject,
      body: BISON_BILL_DEFAULT.body,
      isSeeded: true,
      updatedAt: sql`now()`,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await db
    .select()
    .from(documentTemplatesTable)
    .where(eq(documentTemplatesTable.key, BISON_BILL_TEMPLATE_KEY))
    .limit(1);
  return raced!;
}

/** Subject and letter text for one invoice, with every token filled in. */
export async function renderBisonBill(data: InvoiceDocumentData) {
  const template = await ensureBisonBillTemplate();
  const company = data.company ?? (await getCompanyProfile());
  const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const context = {
    client: data.client,
    company,
    invoice: { ...data.invoice, daysOverdue: daysPastDueOf(data.invoice, todayISO()) },
    // Tokens the shared renderer does not know about, filled here so the bill
    // can quote them. Hand-typed values win in renderTemplate, which is what
    // `extra` is for.
    extra: {
      accountbalance: money(data.client.accountBalance),
      invoiceterms: (data.invoice.terms ?? "").trim(),
      ponumber: (data.invoice.poNumber ?? "").trim(),
      accountnumber: (data.client.accountNumber ?? "").trim(),
    },
  };
  return {
    templateId: template.id,
    subject: template.subject?.trim()
      ? renderTemplate(template.subject, context)
      : invoiceEmailSubject(data.invoice, company),
    body: renderTemplate(template.body, context),
  };
}

// ---- sending -----------------------------------------------------------------

/** Bills that have actually been issued: not void, and checked, emailed or printed. */
const issuedInvoice = () =>
  and(
    ne(invoicesTable.status, "void"),
    or(
      sql`${invoicesTable.verifiedAt} is not null`,
      sql`${invoicesTable.sentAt} is not null`,
      sql`${invoicesTable.printedAt} is not null`,
    ),
  )!;

/**
 * What each customer owes on the bills they have actually been given.
 *
 * `clients.accountBalance` counts every invoice that is not void, so last
 * night's completion is on it before anybody has checked the bill, let alone
 * sent it. That figure prints on the payment coupon and goes out in the letter
 * as [accountbalance] — asking the customer for money for work they have never
 * been billed for, and disagreeing with the statement on their own page.
 * Money taken at the door against an unissued bill is set aside with it, so a
 * job paid on the spot reads as nothing owed rather than as a credit.
 */
export async function billedAccountBalances(clientIds: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(clientIds)];
  if (ids.length === 0) return new Map();
  const round = (n: number) => Math.round(n * 100) / 100;
  const [billed, paid] = await Promise.all([
    db
      .select({
        clientId: invoicesTable.clientId,
        // A bill he wrote off, or handed to collections, counts at what was
        // actually paid on it — the same arithmetic recalcClientBalance uses.
        // Nobody is still waiting on the rest, so the coupon must not ask the
        // customer for it; counting it at zero instead would leave its own
        // part-payment on its own and quote them a credit they do not have.
        total: sql<string>`coalesce(sum(case
          when ${invoicesTable.status} in ('written_off', 'collections') then ${invoicesTable.amountPaid}
          else ${invoicesTable.total}
        end), 0)`,
      })
      .from(invoicesTable)
      .where(and(inArray(invoicesTable.clientId, ids), issuedInvoice()))
      .groupBy(invoicesTable.clientId),
    db
      .select({ clientId: paymentsTable.clientId, total: sum(paymentsTable.amount) })
      .from(paymentsTable)
      .where(
        and(
          inArray(paymentsTable.clientId, ids),
          or(
            isNull(paymentsTable.invoiceId),
            inArray(
              paymentsTable.invoiceId,
              db.select({ id: invoicesTable.id }).from(invoicesTable).where(issuedInvoice()),
            ),
          ),
        ),
      )
      .groupBy(paymentsTable.clientId),
  ]);
  const owed = new Map(billed.map((row) => [row.clientId, Number(row.total ?? 0)]));
  const credit = new Map(paid.map((row) => [row.clientId, Number(row.total ?? 0)]));
  return new Map(ids.map((id) => [id, round((owed.get(id) ?? 0) - (credit.get(id) ?? 0))]));
}

/** Invoice, its client and its lines — everything either document builder needs. */
export async function loadInvoiceForDocument(invoiceId: number): Promise<InvoiceDocumentData | null> {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!invoice) return null;
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, invoice.clientId));
  if (!client) return null;
  const lines = await db
    .select()
    .from(invoiceLineItemsTable)
    .where(eq(invoiceLineItemsTable.invoiceId, invoiceId))
    .orderBy(asc(invoiceLineItemsTable.sortOrder), asc(invoiceLineItemsTable.id));
  // The coupon and the letter quote the balance the customer has been billed
  // for, never one that includes a bill still sitting in Needs verification.
  const balances = await billedAccountBalances([client.id]);
  return {
    invoice,
    client: { ...client, accountBalance: balances.get(client.id) ?? 0 },
    lines,
    company: await getCompanyProfile(),
  };
}

export type InvoiceEmailOutcome =
  | { status: "sent"; toEmail: string; messageId: string | null }
  | { status: "skipped"; reason: "no_email" | "not_verified" | "void" | "already_sent" | "written_off" }
  | { status: "failed"; reason: string };

/**
 * Email one invoice: Bison bill body, PDF attached, one email_sends row, sentAt
 * stamped only once Gmail accepted it, and an audit line either way.
 *
 * `bulk` is the "Email all" button. It never resends, because a batch is where
 * a mistake goes out forty times; a single Send press from the office is
 * deliberate, so it may override that — the office is looking at that one
 * customer when it clicks.
 *
 * Do-not-email does not stop a bill. That box is for the notices we send in
 * batches — the board, the waiting list, the automations — and his customer
 * page says so in as many words ("bulk emails skip this customer, invoices
 * still go out"). Skipping the bill as well left it stuck in To email for good:
 * it never reached To print either, so the only way the customer ever saw it
 * was if somebody noticed and pressed Send by hand. A customer who wants paper
 * gets it by setting their invoice delivery to print.
 */
export async function emailInvoice(
  opts: {
    invoiceId: number;
    actorName?: string | null;
    actorId?: number | null;
    toEmailOverride?: string | null;
    batchId?: string | null;
    bulk: boolean;
  },
  proxy: GmailProxy = defaultGmailProxy,
): Promise<InvoiceEmailOutcome> {
  const data = await loadInvoiceForDocument(opts.invoiceId);
  if (!data) return { status: "failed", reason: "Invoice not found" };
  const { invoice, client } = data;
  const number = invoiceNumberOf(invoice);

  if (invoice.status === "void") return { status: "skipped", reason: "void" };
  // A balance he has written off, or handed to a collector, is not his to ask
  // for any more: emailing the bill again would chase money he already decided
  // to stop chasing.
  if (invoice.status === "written_off" || invoice.status === "collections") {
    return { status: "skipped", reason: "written_off" };
  }
  // An invoice that has already been sent or printed was checked by the act of
  // going out; older bills carry no verifiedAt at all, and refusing to resend
  // one of those told the office a bill the customer is holding "has not been
  // verified yet".
  const neverIssued = invoice.sentAt == null && invoice.printedAt == null;
  if (neverIssued && (invoice.status === "pending" || !invoice.verifiedAt)) {
    return { status: "skipped", reason: "not_verified" };
  }
  if (opts.bulk && invoice.sentAt) return { status: "skipped", reason: "already_sent" };

  const recordSkip = async (skipReason: "no_email", toEmail: string | null) => {
    await db.insert(emailSendsTable).values({
      clientId: client.id,
      sentById: opts.actorId ?? null,
      source: "invoice",
      batchId: opts.batchId ?? null,
      toEmail,
      subject: invoiceEmailSubject(invoice, data.company),
      status: "skipped",
      skipReason,
    });
  };

  // Billing email first: that is the address the customer chose for bills, and
  // it is routinely a bookkeeper rather than the person whose lawn it is.
  const toEmail = (opts.toEmailOverride ?? client.billingEmail ?? client.email ?? "").trim();
  if (!toEmail) {
    await recordSkip("no_email", null);
    return { status: "skipped", reason: "no_email" };
  }
  const bill = await renderBisonBill(data);
  const pdf = await createInvoicePdf(data);
  const html = createInvoiceEmailHtml(data, { bodyText: bill.body });

  let messageId: string | null = null;
  try {
    const sent = await sendInvoiceViaGmail(
      { toEmail, subject: bill.subject, html, pdf, invoiceNumber: number, company: data.company },
      proxy,
    );
    messageId = sent?.id ?? null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Could not send the invoice.";
    logger.error({ err, invoiceId: invoice.id }, "failed to send invoice email");
    await db.insert(emailSendsTable).values({
      clientId: client.id,
      templateId: bill.templateId,
      sentById: opts.actorId ?? null,
      source: "invoice",
      batchId: opts.batchId ?? null,
      toEmail,
      subject: bill.subject,
      status: "failed",
      error: reason.slice(0, 1000),
    });
    await logAudit({
      clientId: client.id,
      actorName: opts.actorName,
      action: "invoice_send_failed",
      description: `Could not email invoice #${number} to ${toEmail}: ${reason}`,
      entityType: "invoice",
      entityId: invoice.id,
    });
    return { status: "failed", reason };
  }

  // Stamped only after Gmail accepted it. Marking it sent before the send would
  // hide a failed invoice from the office in the one view built to catch them.
  const now = new Date();
  await db.update(invoicesTable).set({ sentAt: now }).where(eq(invoicesTable.id, invoice.id));
  await db.insert(emailSendsTable).values({
    clientId: client.id,
    templateId: bill.templateId,
    sentById: opts.actorId ?? null,
    source: "invoice",
    batchId: opts.batchId ?? null,
    toEmail,
    subject: bill.subject,
    status: "sent",
    gmailMessageId: messageId,
    openToken: randomUUID(),
    sentAt: now,
  });
  await logAudit({
    clientId: client.id,
    actorName: opts.actorName,
    action: "invoice_sent",
    description: `Emailed invoice #${number} ($${balanceOf(invoice).toFixed(2)} due) to ${toEmail}`,
    entityType: "invoice",
    entityId: invoice.id,
  });
  return { status: "sent", toEmail, messageId };
}

export type InvoiceBatchOutcome = {
  invoiceId: number;
  number: number;
  clientName: string | null;
  reason: string;
};

/**
 * "Email all": one Gmail call per invoice, in order, never in parallel. The
 * owner's Gmail is the sender and a burst of forty parallel sends is exactly
 * how a mailbox gets rate-limited halfway through a run, leaving him unsure
 * which half went.
 */
export async function emailInvoices(
  opts: { invoiceIds: number[]; actorName?: string | null; actorId?: number | null },
  proxy: GmailProxy = defaultGmailProxy,
) {
  const batchId = randomUUID();
  let sent = 0;
  const failed: InvoiceBatchOutcome[] = [];
  const skipped: InvoiceBatchOutcome[] = [];

  for (const invoiceId of opts.invoiceIds) {
    const [row] = await db
      .select({
        id: invoicesTable.id,
        number: invoicesTable.number,
        clientName: clientsTable.name,
      })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(clientsTable.id, invoicesTable.clientId))
      .where(eq(invoicesTable.id, invoiceId));
    const label = {
      invoiceId,
      number: row ? (row.number ?? row.id) : invoiceId,
      clientName: row?.clientName ?? null,
    };
    const outcome = await emailInvoice(
      { invoiceId, actorName: opts.actorName, actorId: opts.actorId, batchId, bulk: true },
      proxy,
    );
    if (outcome.status === "sent") sent += 1;
    else if (outcome.status === "skipped") skipped.push({ ...label, reason: outcome.reason });
    else failed.push({ ...label, reason: outcome.reason });
  }

  if (opts.invoiceIds.length > 1 || sent > 1) {
    await logAudit({
      actorName: opts.actorName,
      action: "invoices_emailed",
      description: `Emailed ${sent} of ${opts.invoiceIds.length} invoices (${skipped.length} skipped, ${failed.length} failed)`,
    });
  }
  return { batchId, sent, failed, skipped };
}
