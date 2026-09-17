import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  clientsTable,
  clientContactsTable,
  usersTable,
  jobsTable,
  servicesTable,
  smsMessagesTable,
  ticketsTable,
  documentTemplatesTable,
  emailSendsTable,
} from "@workspace/db";
import type { SmsMessage } from "@workspace/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  SendClientSmsBody,
  SendJobSmsBody,
  SetUserSmsNumberBody,
  ReceiveInboundSmsBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit } from "../lib/helpers";
import {
  SMS_ENV_KEYS,
  formatPhone,
  normalizePhone,
  officeNumber,
  parseReplyRef,
  phoneKey,
  routeInboundSms,
  sendSms,
  smsConfigured,
  smsProviderName,
  smsSendable,
  twilioSignatureMatches,
} from "../lib/sms";
import { renderTemplate } from "../lib/mergeTokens";
import { getCompanyProfile } from "../lib/companyProfile";
import { documentEmailHtml } from "../lib/documentSend";
import { sendClientEmailViaGmail } from "../lib/clientEmail";
import { defaultGmailProxy, type GmailProxy } from "../lib/gmail";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const NOT_ON = "Texting is not switched on for this server. Set SMS_PROVIDER=twilio and the Twilio keys — Settings explains what it costs.";

function publicOrigin(req: Request): string {
  const configured = process.env.APP_PUBLIC_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to the request's own host
    }
  }
  return `${req.protocol}://${req.get("host")}`;
}

/**
 * Last ten digits of a free-text phone column, for matching an inbound sender
 * in SQL. The backslash is doubled on purpose: a template literal cooks '\D'
 * down to 'D', and Postgres would then strip the letter D instead of every
 * non-digit — and never match a single customer.
 */
const last10 = (column: unknown) => sql`right(regexp_replace(coalesce(${column}, ''), '\\D', '', 'g'), 10)`;

async function clientByPhone(from: string): Promise<{ id: number; name: string } | null> {
  const key = phoneKey(from);
  if (!key) return null;
  const [direct] = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(sql`${last10(clientsTable.phone)} = ${key}`)
    .orderBy(desc(clientsTable.id))
    .limit(1);
  if (direct) return direct;
  // A spouse or property manager texting from the extra contact's phone.
  const [viaContact] = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientContactsTable)
    .innerJoin(clientsTable, eq(clientsTable.id, clientContactsTable.clientId))
    .where(sql`${last10(clientContactsTable.phone)} = ${key}`)
    .limit(1);
  return viaContact ?? null;
}

// ---------------------------------------------------------------- inbound --
// Declared ABOVE every requireAuth line, and this router is mounted ahead of
// jobsRouter (see routes/index.ts): the provider posting a customer's reply
// has no session. It proves itself with the request signature instead.
router.post("/public/sms/inbound", async (req, res) => {
  const token = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  if (!token) return res.status(503).json({ error: NOT_ON });

  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
    if (typeof v === "string") params[k] = v;
  }
  const url = `${publicOrigin(req)}${req.originalUrl}`;
  if (!twilioSignatureMatches(url, params, token, req.get("x-twilio-signature"))) {
    req.log.warn({ url }, "inbound sms rejected: bad signature");
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = ReceiveInboundSmsBody.parse(params);
  const from = normalizePhone(body.From);
  const to = normalizePhone(body.To);
  const text = (body.Body ?? "").trim();
  const ack = () => res.type("text/xml").send("<Response/>");
  if (!from || !to) return ack();

  // The provider retries when it does not get a 200 quickly; the same text
  // must not be forwarded twice.
  if (body.MessageSid) {
    const [dup] = await db
      .select({ id: smsMessagesTable.id })
      .from(smsMessagesTable)
      .where(eq(smsMessagesTable.providerMessageId, body.MessageSid))
      .limit(1);
    if (dup) return ack();
  }

  const owners = await db.select().from(usersTable).where(isNotNull(usersTable.smsProxyNumber));
  const owner = owners.find((u) => phoneKey(u.smsProxyNumber) === phoneKey(to)) ?? null;
  const line = owner
    ? { userId: owner.id, userName: owner.displayName?.trim() || owner.name, userPhone: normalizePhone(owner.phone), proxyNumber: to }
    : null;
  const isOfficeLine = phoneKey(officeNumber()) === phoneKey(to);
  const fromContractor = line?.userPhone != null && phoneKey(from) === phoneKey(line.userPhone);
  const client = fromContractor ? null : await clientByPhone(from);
  const media = Number(body.NumMedia ?? "0") || 0;

  const [inbound] = await db
    .insert(smsMessagesTable)
    .values({
      direction: "inbound",
      clientId: client?.id ?? null,
      userId: line?.userId ?? null,
      fromNumber: from,
      toNumber: to,
      // Pictures are not fetched or stored; the office is told one was sent.
      body: text || (media > 0 ? `(picture message — ${media} attachment${media === 1 ? "" : "s"} not kept)` : "(empty)"),
      status: "received",
      providerMessageId: body.MessageSid ?? null,
    })
    .returning();

  type Thread = { clientId: number | null; clientName: string | null; customerNumber: string } | null;
  let referenced: Thread = null;
  let lastCustomer: Thread = null;
  if (line && fromContractor) {
    const { messageId } = parseReplyRef(text);
    if (messageId != null) {
      const [ref] = await db.select().from(smsMessagesTable).where(eq(smsMessagesTable.id, messageId));
      if (ref && ref.userId === line.userId) {
        const customerNumber = ref.direction === "inbound" ? ref.fromNumber : ref.toNumber;
        // Off by one on the number in the message: that id is the forward we
        // sent HIM, not the customer's text, so answering it would text
        // himself. Left unmatched, and he is told the number is wrong.
        if (phoneKey(customerNumber) !== phoneKey(line.userPhone)) {
          referenced = { clientId: ref.clientId, clientName: null, customerNumber };
        }
      }
    }
    const [last] = await db
      .select()
      .from(smsMessagesTable)
      .where(
        and(
          eq(smsMessagesTable.userId, line.userId),
          eq(smsMessagesTable.direction, "inbound"),
          ne(smsMessagesTable.id, inbound.id),
          ne(smsMessagesTable.fromNumber, line.userPhone!),
          gt(smsMessagesTable.createdAt, new Date(Date.now() - 86_400_000)),
        ),
      )
      .orderBy(desc(smsMessagesTable.createdAt))
      .limit(1);
    if (last) lastCustomer = { clientId: last.clientId, clientName: null, customerNumber: last.fromNumber };
  }

  const decision = routeInboundSms({
    inboundId: inbound.id,
    from,
    to,
    body: inbound.body,
    line,
    isOfficeLine,
    client,
    referenced,
    lastCustomer,
  });

  switch (decision.kind) {
    case "reply_to_customer": {
      const sent = await sendSms({
        to: decision.to,
        from: decision.from,
        body: decision.text,
        clientId: decision.clientId,
        userId: line!.userId,
      });
      await logAudit({
        clientId: decision.clientId,
        actorName: line!.userName,
        action: "client_sms_sent",
        description: `${line!.userName} texted ${formatPhone(decision.to)} from ${formatPhone(decision.from)}${sent.status === "failed" ? ` — failed: ${sent.error}` : ""}`,
      });
      break;
    }
    case "no_thread":
      await sendSms({ to: decision.to, from: decision.from, body: decision.text, userId: line!.userId });
      break;
    case "forward_to_contractor": {
      const relay = await sendSms({ to: decision.to, from: decision.from, body: decision.text, userId: line!.userId });
      await db
        .update(smsMessagesTable)
        .set(relay.status === "sent" ? { status: "forwarded" } : { error: `Could not forward: ${relay.error}` })
        .where(eq(smsMessagesTable.id, inbound.id));
      await logAudit({
        clientId: decision.clientId,
        actorName: null,
        action: "client_sms_received",
        description: `Text from ${client?.name ?? formatPhone(from)} to ${line!.userName}'s number${relay.status === "sent" ? ", forwarded to their phone" : ` — could not be forwarded (${relay.error})`}`,
      });
      break;
    }
    case "office_ticket":
      await db.insert(ticketsTable).values({
        clientId: decision.clientId,
        title: decision.title,
        description: decision.description,
      });
      await logAudit({
        clientId: decision.clientId,
        actorName: null,
        action: "client_sms_received",
        description: `Text from ${client?.name ?? formatPhone(from)} — a ticket was opened for the office`,
      });
      break;
    case "opt_out":
      await logAudit({
        clientId: decision.clientId,
        actorName: null,
        action: "client_sms_opt_out",
        description: `${client?.name ?? formatPhone(from)} texted STOP — the provider will block further texts to them`,
      });
      break;
    case "unroutable":
      logger.warn({ to, reason: decision.reason }, "inbound sms could not be routed");
      break;
  }
  return ack();
});

// ----------------------------------------------------------------- status --
router.get("/sms/status", requireAuth, async (req, res) => {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(isNotNull(usersTable.smsProxyNumber));
  return res.json({
    configured: smsConfigured(),
    provider: smsProviderName(),
    officeNumber: officeNumber(),
    myNumber: normalizePhone(req.appUser!.smsProxyNumber),
    numbersAssigned: count,
    webhookUrl: `${publicOrigin(req)}/api/public/sms/inbound`,
    envKeys: SMS_ENV_KEYS.map(({ key, note }) => ({ key, note, set: Boolean(process.env[key]?.trim()) })),
  });
});

// ----------------------------------------------------------------- office --
async function hydrate(rows: SmsMessage[]) {
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is number => x != null))];
  const users = userIds.length
    ? await db.select({ id: usersTable.id, name: usersTable.name, displayName: usersTable.displayName }).from(usersTable).where(inArray(usersTable.id, userIds))
    : [];
  const names = new Map(users.map((u) => [u.id, u.displayName?.trim() || u.name]));
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    clientId: r.clientId,
    userId: r.userId,
    userName: r.userId != null ? (names.get(r.userId) ?? null) : null,
    jobId: r.jobId,
    fromNumber: r.fromNumber,
    toNumber: r.toNumber,
    body: r.body,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  }));
}

router.get("/clients/:id/sms", requireAuth, requireAdmin, async (req, res) => {
  const rows = await db
    .select()
    .from(smsMessagesTable)
    .where(eq(smsMessagesTable.clientId, Number(req.params.id)))
    .orderBy(asc(smsMessagesTable.createdAt));
  return res.json(await hydrate(rows));
});

router.post("/clients/:id/sms", requireAuth, requireAdmin, async (req, res) => {
  const body = SendClientSmsBody.parse(req.body);
  if (!smsSendable()) return res.status(503).json({ error: NOT_ON });
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, Number(req.params.id)));
  if (!client) return res.status(404).json({ error: "Client not found" });

  const to = normalizePhone(body.toPhone?.trim() || client.phone);
  if (!to) return res.status(400).json({ error: "No mobile number — add one to the customer, or type one in." });

  let from: string | null;
  let onBehalfOf: { id: number; name: string } | null = null;
  if (body.fromUserId != null) {
    const [person] = await db.select().from(usersTable).where(eq(usersTable.id, body.fromUserId));
    if (!person) return res.status(404).json({ error: "That person is not on the team." });
    from = normalizePhone(person.smsProxyNumber);
    if (!from) {
      return res.status(400).json({ error: `${person.displayName?.trim() || person.name} has no texting number yet — give them one on the Team page.` });
    }
    onBehalfOf = { id: person.id, name: person.displayName?.trim() || person.name };
  } else {
    from = officeNumber() ?? normalizePhone(req.appUser!.smsProxyNumber);
    if (!from) return res.status(400).json({ error: "No office texting number is set (SMS_OFFICE_NUMBER)." });
  }

  const sent = await sendSms({ to, from, body: body.body, clientId: client.id, userId: onBehalfOf?.id ?? null });
  await logAudit({
    clientId: client.id,
    actorName: req.appUser?.name,
    action: "client_sms_sent",
    description:
      `Texted ${formatPhone(to)} from ${onBehalfOf ? `${onBehalfOf.name}'s number` : "the office number"} ${formatPhone(from)}` +
      (sent.status === "failed" ? ` — failed: ${sent.error}` : ""),
  });
  return res.json({ sent: sent.status === "sent", to, from, messageId: sent.id, error: sent.error });
});

// ------------------------------------------------------------ team numbers --
router.put("/users/:id/sms-number", requireAuth, requireAdmin, async (req, res) => {
  const body = SetUserSmsNumberBody.parse(req.body);
  const id = Number(req.params.id);
  const [person] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!person) return res.status(404).json({ error: "User not found" });

  let number: string | null = null;
  if (body.smsProxyNumber?.trim()) {
    number = normalizePhone(body.smsProxyNumber);
    if (!number) {
      return res.status(400).json({ error: "That is not a phone number we can text from. Use 10 digits, like 208-555-0142." });
    }
    // One number, one person — otherwise a customer's reply has two places to go.
    const others = await db.select().from(usersTable).where(and(isNotNull(usersTable.smsProxyNumber), ne(usersTable.id, id)));
    const taken = others.find((u) => phoneKey(u.smsProxyNumber) === phoneKey(number));
    if (taken) return res.status(400).json({ error: `${taken.displayName?.trim() || taken.name} already has that number.` });
    if (phoneKey(number) === phoneKey(officeNumber())) {
      return res.status(400).json({ error: "That is the office number. A person needs their own." });
    }
  }

  const [updated] = await db.update(usersTable).set({ smsProxyNumber: number }).where(eq(usersTable.id, id)).returning();
  const who = person.displayName?.trim() || person.name;
  await logAudit({
    actorName: req.appUser?.name,
    action: "sms_number_set",
    description: number ? `Gave ${who} the texting number ${formatPhone(number)}` : `Took away ${who}'s texting number`,
  });
  return res.json(updated);
});

// ------------------------------------------------------------- contractor --
type JobRow = typeof jobsTable.$inferSelect;

/**
 * Same rule jobs.ts applies to every other contractor action on a job. Kept
 * as a copy for the same reason time-tracking.ts keeps one: that module owns
 * its own predicate, and if the rule changes there it must change here too.
 */
function canAccessJob(req: Request, job: JobRow): boolean {
  if (req.appUser?.role === "admin") return true;
  return job.assignedToId === req.appUser?.id && job.dispatched === true && job.visibleToContractor === true;
}

async function loadAccessibleJob(req: Request, res: Response): Promise<JobRow | null> {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, Number(req.params.id)));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return null;
  }
  if (!canAccessJob(req, job)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return job;
}

router.post("/jobs/:id/sms", requireAuth, async (req, res) => {
  const body = SendJobSmsBody.parse(req.body);
  const job = await loadAccessibleJob(req, res);
  if (!job) return;
  if (!smsSendable()) return res.status(503).json({ error: NOT_ON });
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, job.clientId));
  if (!client) return res.status(404).json({ error: "Client not found" });

  const to = normalizePhone(client.phone);
  if (!to) return res.status(400).json({ error: "This customer has no mobile number on file." });
  // Their own masked number, so the reply comes back to them. The office
  // number is the fallback, and then the reply lands with the office instead.
  const from = normalizePhone(req.appUser!.smsProxyNumber) ?? officeNumber();
  if (!from) return res.status(400).json({ error: "You do not have a texting number yet — ask the office." });

  const sent = await sendSms({ to, from, body: body.body, clientId: client.id, userId: req.appUser!.id, jobId: job.id });
  await logAudit({
    clientId: client.id,
    actorName: req.appUser?.name,
    action: "client_sms_sent",
    description: `${req.appUser?.name ?? "Someone"} texted ${formatPhone(to)} about job #${job.id} from ${formatPhone(from)}${sent.status === "failed" ? ` — failed: ${sent.error}` : ""}`,
  });
  return res.json({ sent: sent.status === "sent", to, from, messageId: sent.id, error: sent.error });
});

// ------------------------------------------------ "Crew is on their way" --
// Feedback 49. Not a text — texting needs a paid provider — but an email of
// the "on the way" document, sent by the person who just tapped On The Way.
// Offered, never automatic: a wrong tap should not email a customer.

const ON_THE_WAY_KEY = "on-the-way";

let crewNoticeGmailProxy: GmailProxy = defaultGmailProxy;

/** Swap the Gmail proxy used for the on-the-way email (tests only). */
export function setCrewNoticeGmailProxyForTests(proxy: GmailProxy | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The crew notice Gmail proxy can only be replaced in tests");
  }
  crewNoticeGmailProxy = proxy ?? defaultGmailProxy;
}

/** The document, created the first time it is needed so the office can edit it in Settings. */
async function onTheWayTemplate() {
  const [existing] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.key, ON_THE_WAY_KEY));
  if (existing) return existing;
  const [created] = await db
    .insert(documentTemplatesTable)
    .values({
      key: ON_THE_WAY_KEY,
      name: "On the way",
      kind: "notice",
      category: "client",
      isSeeded: true,
      subject: "We're on our way | [companyname]",
      body:
        "Hi [clientfname],\n\n" +
        "[contractorname] from [companyname] is on the way to [physicaladdress1] for your [servicename]. " +
        "You do not need to be home — we will take care of everything.\n\n" +
        "If today does not work, call or text us at [companyphonenumber].\n\n" +
        "[signatureline]\n[companyname]",
    })
    .onConflictDoNothing({ target: documentTemplatesTable.key })
    .returning();
  if (created) return created;
  const [raced] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.key, ON_THE_WAY_KEY));
  return raced!;
}

async function noticeState(job: JobRow) {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, job.clientId));
  const template = await onTheWayTemplate();
  const [already] = await db
    .select({ createdAt: emailSendsTable.createdAt })
    .from(emailSendsTable)
    .where(and(eq(emailSendsTable.batchId, `${ON_THE_WAY_KEY}:${job.id}`), eq(emailSendsTable.status, "sent")))
    .orderBy(desc(emailSendsTable.createdAt))
    .limit(1);
  const reason = already
    ? "already_sent"
    : job.status !== "on_the_way"
      ? "not_on_the_way"
      : !client?.email?.trim()
        ? "no_email"
        : client.doNotEmail
          ? "do_not_email"
          : null;
  return { client, template, reason, sentAt: already?.createdAt.toISOString() ?? null };
}

router.get("/my/jobs/:id/on-the-way-notice", requireAuth, async (req, res) => {
  const job = await loadAccessibleJob(req, res);
  if (!job) return;
  const { template, reason, sentAt } = await noticeState(job);
  return res.json({ canSend: reason === null, reason, sentAt, templateName: template.name });
});

router.post("/my/jobs/:id/on-the-way-notice", requireAuth, async (req, res) => {
  const job = await loadAccessibleJob(req, res);
  if (!job) return;
  const { client, template, reason } = await noticeState(job);
  if (reason || !client) return res.json({ sent: false, reason: reason ?? "no_email" });

  const [service] = job.serviceId
    ? await db.select({ name: servicesTable.name }).from(servicesTable).where(eq(servicesTable.id, job.serviceId))
    : [];
  const company = await getCompanyProfile();
  const me = req.appUser!;
  const context = {
    client,
    company,
    job: { scheduledDate: job.scheduledDate, serviceName: service?.name ?? "service" },
    extra: { contractorname: me.displayName?.trim() || me.name },
  };
  const subject = renderTemplate(template.subject ?? "We're on our way | [companyname]", context);
  const text = renderTemplate(template.body, context);
  const toEmail = client.email!.trim();

  let gmailMessageId: string | null = null;
  let error: string | null = null;
  try {
    const result = await sendClientEmailViaGmail(
      // The same shell the office's letters go out in, which adds no hello and
      // no sign-off of its own: the document already says both, and a customer
      // must not read "Hi Sarah Thompson, Hi Sarah,".
      { toEmail, subject, body: text, html: documentEmailHtml({ bodyText: text, company }) },
      crewNoticeGmailProxy,
    );
    gmailMessageId = result.id ?? null;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobId: job.id }, "on-the-way notice failed");
  }
  await db.insert(emailSendsTable).values({
    clientId: client.id,
    templateId: template.id,
    sentById: me.id,
    source: "crew",
    batchId: `${ON_THE_WAY_KEY}:${job.id}`,
    toEmail,
    subject,
    status: error ? "failed" : "sent",
    error,
    gmailMessageId,
    // Stamped like every other sent email, so the office's email list shows
    // when it went out instead of a blank.
    sentAt: error ? null : new Date(),
  });
  await logAudit({
    clientId: client.id,
    actorName: me.name,
    action: "on_the_way_notice",
    description: error
      ? `Tried to email ${client.name} that ${me.name} is on the way (job #${job.id}) — failed: ${error}`
      : `Emailed ${client.name} that ${me.name} is on the way (job #${job.id})`,
  });
  return res.json(error ? { sent: false, reason: "failed" } : { sent: true, reason: null });
});

export default router;
