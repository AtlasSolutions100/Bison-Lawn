import { randomBytes } from "node:crypto";
import {
  db,
  clientsTable,
  emailSendsTable,
  jobsTable,
  servicesTable,
  type Client,
  type CompanyProfile,
  type DocumentTemplate,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { sendClientEmailViaGmail } from "./clientEmail";
import { getCompanyProfile } from "./companyProfile";
import { brandAssetUrl, companyAddressLines, companyContactLine } from "./estimateDocument";
import { defaultGmailProxy, type GmailProxy } from "./gmail";
import { logAudit } from "./helpers";
import { renderTemplate, type MergeContext } from "./mergeTokens";
import { richTextHtml, stripMarkers } from "./richText";

/**
 * One way to email a document template to customers, whoever asks for it.
 *
 * The board, the waiting list, the client page, the invoice screen and the
 * automations all come through here, so "42 of 44 sent — 2 have no email" is
 * counted the same way everywhere and every email lands in email_sends where
 * the activity screen can find it.
 */
export type DocumentSendSource = "dispatch" | "waiting_list" | "client_page" | "automation" | "invoice";

export type DocumentSendSkip = {
  clientId: number;
  clientName: string;
  reason: "no_email" | "do_not_email" | "failed";
};

export type DocumentSendResult = {
  batchId: string;
  sent: number;
  skipped: DocumentSendSkip[];
};

/** One email to send: which customer, and what the tokens should say for them. */
export type DocumentRecipient = {
  client: Client;
  /** Invoice / estimate / job details for this one email. Client and company are filled here. */
  context?: Omit<MergeContext, "client" | "company">;
};

export type RecipientOutcome = {
  clientId: number;
  clientName: string;
  status: "sent" | "failed" | "skipped";
  skipReason: "no_email" | "do_not_email" | null;
  error: string | null;
  emailSendId: number | null;
  /**
   * Gmail took the letter, whatever happened afterwards.
   *
   * "Failed" covers two very different things: Gmail refused it (nobody got
   * anything, try again), and Gmail sent it but we could not write down that
   * we sent it (the customer has the letter). An automation that cannot tell
   * them apart retries the second one tomorrow and the customer gets the same
   * past-due notice twice.
   */
  delivered: boolean;
};

// The mail provider used for document sends. Tests swap in a stub so the
// sent / failed / skipped counting can be exercised without touching Gmail.
let documentGmailProxy: GmailProxy = defaultGmailProxy;

/** Swap the Gmail proxy used for document sends (tests only). */
export function setDocumentSendGmailProxyForTests(proxy: GmailProxy | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The document send Gmail proxy can only be replaced in tests");
  }
  documentGmailProxy = proxy ?? defaultGmailProxy;
}

/**
 * A way for tests to blow the whole send up before anybody is emailed — the
 * database going away between the automation claiming a customer's notice and
 * the letter going out. It has to be provable that the claim is handed back,
 * because a claim left behind silences that customer's notice for good.
 */
let breakBeforeSendForTests: (() => void | Promise<void>) | null = null;
export function setDocumentSendBreakageForTests(fn: (() => void | Promise<void>) | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Document sends can only be broken on purpose in tests");
  }
  breakBeforeSendForTests = fn;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The public origin, or null when none is configured (then nothing can be tracked). */
function publicOrigin(): string | null {
  const raw = process.env.APP_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function newBatchId(): string {
  return `b_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** Where the open pixel for one email points, or null when the app has no public address. */
export function openPixelUrl(openToken: string): string | null {
  const origin = publicOrigin();
  return origin ? `${origin}/api/public/email-open/${openToken}.gif` : null;
}

/**
 * His rendered letter inside the Bison email shell: wordmark on top, the
 * company band, the body as paragraphs, the emblem and company block below.
 *
 * The template already carries his own address block, sign-off and footer as
 * text — that is how he writes them — so the shell does not add a second
 * sign-off the way the spring letter does. It only adds the artwork and the
 * company details that a plain text body cannot.
 */
export function documentEmailHtml(params: { bodyText: string; company: CompanyProfile; pixelUrl?: string | null }) {
  const { bodyText, company, pixelUrl } = params;
  const wordmark = brandAssetUrl("logo-wordmark.png");
  const emblem = brandAssetUrl("logo-emblem.png");
  const addressLines = companyAddressLines(company);
  const contactLine = companyContactLine(company);

  // **bold**, *italic* and "- " bullets are honoured, because the bodies he
  // pastes in already carry them. Escaping happens first, inside richTextHtml.
  const paragraphs = richTextHtml(bodyText);

  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:620px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
      <div style="padding:26px 32px 18px;text-align:center">
        ${
          wordmark
            ? `<img src="${escapeHtml(wordmark)}" alt="${escapeHtml(company.name)}" width="240" style="display:inline-block;width:240px;max-width:100%;height:auto;border:0" />`
            : ""
        }
      </div>
      <div style="background:#215343;color:#fff;padding:20px 32px">
        <h1 style="margin:0;font-size:22px">${escapeHtml(company.name)}</h1>
      </div>
      <div style="padding:32px;font-size:15px">
        ${paragraphs}
      </div>
      <div style="background:#f7f5f1;padding:24px 32px;text-align:center;border-top:1px solid #e7e2dc">
        ${
          emblem
            ? `<img src="${escapeHtml(emblem)}" alt="" width="56" style="display:inline-block;width:56px;height:auto;border:0" />`
            : ""
        }
        ${addressLines.length ? `<p style="margin:8px 0 0;font-size:12px;color:#6f675f">${addressLines.map(escapeHtml).join("<br />")}</p>` : ""}
        ${contactLine ? `<p style="margin:6px 0 0;font-size:12px;color:#6f675f">${escapeHtml(contactLine)}</p>` : ""}
      </div>
    </div>
    ${pixelUrl ? `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />` : ""}
  </body></html>`;
}

/**
 * Which address a document goes to. Bills chase the billing email when the
 * customer gave one (the CPA, the property manager); everything else goes to
 * the customer's own address, falling back to the billing one so a customer
 * who only ever gave us a billing email still hears from us.
 */
export function recipientEmail(client: Client, forBilling: boolean): string | null {
  const own = client.email?.trim() || null;
  const billing = client.billingEmail?.trim() || null;
  return forBilling ? (billing ?? own) : (own ?? billing);
}

/**
 * Render and send one template to a list of recipients, recording every one.
 *
 * Sequential and never aborting, exactly like the spring-letter run: the
 * whole value of the result is that the office knows who was reached and who
 * was not, so one customer failing must not cost the customers behind them.
 */
export async function deliverDocument(params: {
  template: DocumentTemplate;
  recipients: DocumentRecipient[];
  source: DocumentSendSource;
  batchId?: string;
  sentById?: number | null;
  actorName?: string | null;
  /** Tokens typed in by the sender, applied to every recipient. */
  tokens?: Record<string, string> | null;
}): Promise<{ batchId: string; outcomes: RecipientOutcome[] }> {
  const { template, recipients, source } = params;
  const batchId = params.batchId ?? newBatchId();
  if (breakBeforeSendForTests) await breakBeforeSendForTests();
  const company = await getCompanyProfile();
  const forBilling = source === "invoice";
  const outcomes: RecipientOutcome[] = [];

  for (const recipient of recipients) {
    const { client } = recipient;
    const outcome: RecipientOutcome = {
      clientId: client.id,
      clientName: client.name,
      status: "skipped",
      skipReason: null,
      error: null,
      emailSendId: null,
      delivered: false,
    };

    const invoiceContext = Boolean(recipient.context?.invoice);
    const toEmail = recipientEmail(client, forBilling || invoiceContext);
    let subject = template.name;
    let openToken: string | null = null;
    let gmailMessageId: string | null = null;

    try {
      if (client.doNotEmail) {
        outcome.skipReason = "do_not_email";
      } else if (!toEmail) {
        outcome.skipReason = "no_email";
      } else {
        const context: MergeContext = {
          ...(recipient.context ?? {}),
          client,
          company,
          extra: { ...(recipient.context?.extra ?? {}), ...(params.tokens ?? {}) },
        };
        subject = template.subject ? renderTemplate(template.subject, context) : template.name;
        const bodyText = renderTemplate(template.body, context);
        openToken = randomBytes(16).toString("base64url");
        const html = documentEmailHtml({ bodyText, company, pixelUrl: openPixelUrl(openToken) });
        // The text half of the email loses the markers: a reader whose mail
        // client shows that half should not be looking at asterisks.
        const sent = await sendClientEmailViaGmail(
          { toEmail, subject, body: stripMarkers(bodyText), html },
          documentGmailProxy,
        );
        gmailMessageId = sent.id ?? null;
        outcome.status = "sent";
        outcome.delivered = true;
      }
    } catch (cause) {
      outcome.status = "failed";
      outcome.error = (cause instanceof Error ? cause.message : "Email delivery failed").slice(0, 500);
      openToken = null;
    }

    // Recording the attempt must not decide the run's fate either. A letter
    // Gmail accepted but we could not record is reported as unconfirmed.
    try {
      const [row] = await db
        .insert(emailSendsTable)
        .values({
          clientId: client.id,
          templateId: template.id,
          sentById: params.sentById ?? null,
          source,
          batchId,
          toEmail,
          subject,
          status: outcome.status,
          skipReason: outcome.skipReason,
          error: outcome.error,
          gmailMessageId,
          openToken,
          sentAt: outcome.status === "sent" ? new Date() : null,
        })
        .returning({ id: emailSendsTable.id });
      outcome.emailSendId = row?.id ?? null;
    } catch (cause) {
      const note = cause instanceof Error ? cause.message : "unknown error";
      if (outcome.status === "sent") {
        outcome.status = "failed";
        outcome.error = `Email was accepted but the attempt could not be recorded, so delivery is unconfirmed: ${note}`.slice(0, 500);
      }
    }

    try {
      if (outcome.status === "sent") {
        await logAudit({
          clientId: client.id,
          actorName: params.actorName ?? null,
          action: "document_emailed",
          description: `Emailed "${template.name}" to ${toEmail} (subject: ${subject})`,
        });
      } else if (outcome.status === "failed") {
        await logAudit({
          clientId: client.id,
          actorName: params.actorName ?? null,
          action: "document_email_failed",
          description: `Could not email "${template.name}" to ${toEmail ?? "(no address)"}: ${outcome.error ?? "unknown error"}`,
        });
      }
    } catch {
      // The email_sends row is the record that matters; a missed audit line
      // must not turn a delivered email into a reported failure.
    }

    outcomes.push(outcome);
  }

  return { batchId, outcomes };
}

/** Fold per-recipient outcomes into the shape the board and the client page show. */
export function summarize(batchId: string, outcomes: RecipientOutcome[]): DocumentSendResult {
  return {
    batchId,
    sent: outcomes.filter((o) => o.status === "sent").length,
    skipped: outcomes
      .filter((o) => o.status !== "sent")
      .map((o) => ({
        clientId: o.clientId,
        clientName: o.clientName,
        reason: o.status === "failed" ? ("failed" as const) : (o.skipReason ?? ("no_email" as const)),
      })),
  };
}

/**
 * Send a template to a set of customers (contract C1).
 *
 * `jobIds` fill the job tokens — "[servicedate]" on a blow-out day letter —
 * and add those jobs' customers to the list, so the board can hand over a
 * selection of jobs without first working out whose they are. A customer
 * with two selected jobs gets one email, for the first of them.
 */
export async function sendDocumentToClients(params: {
  template: DocumentTemplate;
  clientIds: number[];
  jobIds?: number[] | null;
  tokens?: Record<string, string> | null;
  source: DocumentSendSource;
  sentById?: number | null;
  actorName?: string | null;
}): Promise<DocumentSendResult> {
  const jobIds = [...new Set(params.jobIds ?? [])];
  const jobByClient = new Map<number, { scheduledDate: string | null; serviceName: string | null }>();
  if (jobIds.length) {
    const jobs = await db
      .select({ clientId: jobsTable.clientId, scheduledDate: jobsTable.scheduledDate, serviceName: servicesTable.name })
      .from(jobsTable)
      .leftJoin(servicesTable, eq(jobsTable.serviceId, servicesTable.id))
      .where(inArray(jobsTable.id, jobIds));
    for (const job of jobs) {
      if (!jobByClient.has(job.clientId)) {
        jobByClient.set(job.clientId, { scheduledDate: job.scheduledDate, serviceName: job.serviceName });
      }
    }
  }

  const clientIds = [...new Set([...params.clientIds, ...jobByClient.keys()])];
  const clients = clientIds.length
    ? await db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds))
    : [];
  const byId = new Map(clients.map((c) => [c.id, c]));

  const recipients: DocumentRecipient[] = [];
  for (const id of clientIds) {
    const client = byId.get(id);
    if (!client) continue;
    recipients.push({ client, context: { job: jobByClient.get(id) ?? null } });
  }

  const { batchId, outcomes } = await deliverDocument({
    template: params.template,
    recipients,
    source: params.source,
    sentById: params.sentById,
    actorName: params.actorName,
    tokens: params.tokens,
  });
  return summarize(batchId, outcomes);
}
