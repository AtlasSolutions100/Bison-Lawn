import { Router, type IRouter } from "express";
import {
  db,
  automationRulesTable,
  automationSendsTable,
  clientsTable,
  documentTemplatesTable,
  emailSendsTable,
  usersTable,
} from "@workspace/db";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireAuth, requireAdmin, requireArea } from "../middlewares/requireAuth";
import { UpdateUnopenedAlertBody } from "@workspace/api-zod";
import { senderStatus } from "../lib/sendAs";
import {
  previewUnopenedAlert,
  runUnopenedAlert,
  updateUnopenedAlertSettings,
  type UnopenedScope,
} from "../lib/unopenedAlerts";
import { logAudit } from "../lib/helpers";

const router: IRouter = Router();

/**
 * A 1x1 transparent GIF. Served for every token, known or not: an unknown
 * token is most likely an old email whose row was cleaned up, and a broken
 * image in a customer's inbox is not a useful way to say so.
 */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * The open pixel. Public on purpose — the customer's mail client fetches it
 * with no session — and mounted ahead of the blanket requireAuth in
 * routes/index.ts for that reason.
 *
 * Opens are approximate. Gmail fetches images through its own proxy (one open
 * recorded, sometimes before anyone reads it), Apple Mail pre-fetches them,
 * and a text-only client never loads them at all. The UI says "opened" and
 * means "the pictures in this email were loaded at least once".
 */
router.get("/public/email-open/:token", async (req, res) => {
  const token = String(req.params.token ?? "").replace(/\.gif$/i, "");
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": String(PIXEL.length),
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  // Respond first; the customer's mail client should never wait on our database.
  res.status(200).end(PIXEL);

  if (!token || token.length > 64) return;
  try {
    await db
      .update(emailSendsTable)
      .set({
        openCount: sql`${emailSendsTable.openCount} + 1`,
        openedAt: sql`coalesce(${emailSendsTable.openedAt}, now())`,
      })
      .where(and(eq(emailSendsTable.openToken, token), eq(emailSendsTable.status, "sent")));
  } catch (err) {
    req.log?.warn({ err }, "could not record an email open");
  }
});

// Everything below is the office's Email Activity screen. Letters and bills
// going out to customers are the "documents" side of his desk, so the screen
// is gated the same way its sidebar link is — a link that opens a 403 is
// worse than no link.
router.use("/email-activity", requireAuth, requireAdmin, requireArea("documents"));

const SOURCE_LABELS: Record<string, string> = {
  dispatch: "Dispatch board",
  waiting_list: "Waiting list",
  client_page: "Client page",
  automation: "Automation",
  invoice: "Invoice",
  estimate: "Estimate",
  letter: "Spring letter",
  crew: "Crew on the way",
};

type BatchRow = {
  batchId: string;
  single: boolean;
  createdAt: string;
  source: string;
  sourceLabel: string;
  templateId: number | null;
  templateName: string | null;
  ruleName: string | null;
  subject: string | null;
  sentByName: string | null;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  opened: number;
  trackable: number;
};

/**
 * An email we are allowed to say "not opened" about. The pixel is the only
 * thing that ever tells us an email was read, and not every email carries one
 * — the crew's "on my way" notice goes out without one. Counting those as
 * "sent but not opened" dragged his open rate to almost nothing and printed
 * "not opened yet" beside a customer we never asked. Same rule the
 * unopened-email alert already goes by.
 */
const TRACKABLE = sql`${emailSendsTable.status} = 'sent' and ${emailSendsTable.openToken} is not null`;

/**
 * The key a row on this screen is found by. A send that went out with others
 * is found by its batch; a bill emailed to one customer on its own has no
 * batch at all, so it stands as its own line under "one:<row id>". Without
 * that, the one email he most often asks about — "did Jackie get her bill?" —
 * was the one email this screen could not show him.
 */
const GROUP_KEY = sql<string>`coalesce(${emailSendsTable.batchId}, 'one:' || ${emailSendsTable.id}::text)`;

/** The other half of GROUP_KEY: find the rows a key on the screen stands for. */
function rowsOfKey(key: string): SQL | null {
  const one = /^one:(\d+)$/.exec(key);
  if (!one) return eq(emailSendsTable.batchId, key);
  const id = Number(one[1]);
  // Beyond an int4 there is no such row, and asking Postgres anyway is an error
  // page instead of "that send is not in the log".
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) return null;
  // Only a send that went out on its own ever gets a "one:" key, so a hand-typed
  // one that lands on a row from a 44-person letter must be a missing send and
  // not that letter's name over "1 of 1 sent".
  return and(eq(emailSendsTable.id, id), isNull(emailSendsTable.batchId))!;
}

/**
 * One row per bulk send. A batch is whatever went out together: the twelve
 * blow-out letters he sent from the board, or one automation's run for the
 * day. He reads "42 of 44 sent, 21 opened" from this list and clicks in to
 * see who.
 */
async function loadBatches(where: SQL | undefined, limit: number): Promise<BatchRow[]> {
  const rows = await db
    .select({
      batchId: GROUP_KEY,
      // One run is one line, so the key is the only thing grouped on and the
      // rest is read off the rows. "Email all" writes the customer it had to
      // leave out with no document against it, and two subs can both press
      // "on my way" for the same job — grouping on those columns too split
      // one send into two lines and made the results page say "2 of 2 sent"
      // above a list of three people.
      source: sql<string>`min(${emailSendsTable.source})`,
      templateId: sql<number | null>`max(${emailSendsTable.templateId})`,
      sentById: sql<number | null>`min(${emailSendsTable.sentById})`,
      subject: sql<string | null>`min(${emailSendsTable.subject})`,
      // Mapped through the column on purpose. A bare aggregate comes back as
      // the raw Postgres text ("2026-09-16 19:02:44"), which Node then reads
      // in whatever timezone the server happens to run in — so the batch list
      // showed a time hours off from the same batch's detail screen.
      createdAt: sql`min(${emailSendsTable.createdAt})`.mapWith(emailSendsTable.createdAt),
      total: sql<number>`count(*)`,
      sent: sql<number>`count(*) filter (where ${emailSendsTable.status} = 'sent')`,
      failed: sql<number>`count(*) filter (where ${emailSendsTable.status} = 'failed')`,
      skipped: sql<number>`count(*) filter (where ${emailSendsTable.status} = 'skipped')`,
      opened: sql<number>`count(*) filter (where ${emailSendsTable.openedAt} is not null)`,
      trackable: sql<number>`count(*) filter (where ${TRACKABLE})`,
    })
    .from(emailSendsTable)
    .where(where)
    .groupBy(GROUP_KEY)
    .orderBy(desc(sql`min(${emailSendsTable.createdAt})`))
    .limit(limit);

  const templateIds = [...new Set(rows.map((r) => r.templateId).filter((x): x is number => x != null))];
  const userIds = [...new Set(rows.map((r) => r.sentById).filter((x): x is number => x != null))];
  const batchIds = rows.map((r) => r.batchId).filter((x): x is string => x != null);
  const [templates, users, ruleLinks] = await Promise.all([
    templateIds.length
      ? db.select({ id: documentTemplatesTable.id, name: documentTemplatesTable.name }).from(documentTemplatesTable).where(inArray(documentTemplatesTable.id, templateIds))
      : Promise.resolve([]),
    userIds.length
      ? db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds))
      : Promise.resolve([]),
    batchIds.length
      ? db
          .select({ batchId: GROUP_KEY, ruleName: automationRulesTable.name })
          .from(automationSendsTable)
          .innerJoin(emailSendsTable, eq(emailSendsTable.id, automationSendsTable.emailSendId))
          .innerJoin(automationRulesTable, eq(automationRulesTable.id, automationSendsTable.ruleId))
          .where(inArray(GROUP_KEY, batchIds))
          .groupBy(GROUP_KEY, automationRulesTable.name)
      : Promise.resolve([]),
  ]);
  const templateNames = new Map(templates.map((t) => [t.id, t.name]));
  const userNames = new Map(users.map((u) => [u.id, u.name]));
  const ruleNames = new Map(ruleLinks.map((r) => [r.batchId, r.ruleName]));

  return rows.map((r) => ({
    batchId: r.batchId!,
    single: r.batchId!.startsWith("one:"),
    createdAt: r.createdAt.toISOString(),
    source: r.source,
    sourceLabel: SOURCE_LABELS[r.source] ?? r.source,
    templateId: r.templateId,
    templateName: r.templateId != null ? (templateNames.get(r.templateId) ?? null) : null,
    ruleName: r.batchId ? (ruleNames.get(r.batchId) ?? null) : null,
    subject: r.subject,
    sentByName: r.sentById != null ? (userNames.get(r.sentById) ?? null) : null,
    total: Number(r.total),
    sent: Number(r.sent),
    failed: Number(r.failed),
    skipped: Number(r.skipped),
    opened: Number(r.opened),
    trackable: Number(r.trackable),
  }));
}

/**
 * What he types in the box, turned into SQL so it runs BEFORE the limit. It
 * used to run over the rows we had already pulled, so the letter he sent a
 * fortnight ago — sitting behind a few hundred crew notices — could not be
 * found by the search the foot of the page tells him to use.
 */
function matchesSearch(q: string): SQL {
  const like = `%${q.replace(/([%_\\])/g, "\\$1")}%`;
  const needle = q.toLowerCase();
  // "Dispatch board" and the rest are words we put on the screen, not words in
  // the database, so a search for them becomes a search for their source.
  const labelled = Object.entries(SOURCE_LABELS)
    .filter(([, label]) => label.toLowerCase().includes(needle))
    .map(([value]) => value);

  const send = alias(emailSendsTable, "q_send");
  const template = alias(documentTemplatesTable, "q_template");
  const sender = alias(usersTable, "q_sender");
  const autoSend = alias(automationSendsTable, "q_auto_send");
  const rule = alias(automationRulesTable, "q_rule");

  const keys = db
    .select({ key: sql`coalesce(${send.batchId}, 'one:' || ${send.id}::text)` })
    .from(send)
    .leftJoin(template, eq(template.id, send.templateId))
    .leftJoin(sender, eq(sender.id, send.sentById))
    .leftJoin(autoSend, eq(autoSend.emailSendId, send.id))
    .leftJoin(rule, eq(rule.id, autoSend.ruleId))
    .where(
      or(
        ilike(template.name, like),
        ilike(sender.name, like),
        ilike(send.subject, like),
        ilike(rule.name, like),
        labelled.length ? inArray(send.source, labelled) : undefined,
      ),
    );

  return sql`${GROUP_KEY} in (${keys})`;
}

/**
 * The line he read off his old screen out loud: "out of the 30 emails that
 * were sent, 30 were delivered and 21 were opened." Counted over a window of
 * days, because an all-time open rate tells him nothing about the letter that
 * went out on Monday.
 */
router.get("/email-activity/summary", async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 3650);
  const [row] = await db
    .select({
      batches: sql<number>`count(distinct ${emailSendsTable.batchId})`,
      total: sql<number>`count(*)`,
      sent: sql<number>`count(*) filter (where ${emailSendsTable.status} = 'sent')`,
      failed: sql<number>`count(*) filter (where ${emailSendsTable.status} = 'failed')`,
      skipped: sql<number>`count(*) filter (where ${emailSendsTable.status} = 'skipped')`,
      opened: sql<number>`count(*) filter (where ${emailSendsTable.openedAt} is not null)`,
      // The ones the open rate is allowed to be worked out of — see TRACKABLE.
      trackable: sql<number>`count(*) filter (where ${TRACKABLE})`,
      // Emails that went to one customer on their own, counted apart so the
      // tiles can say how much of the window was bulk and how much was one
      // bill at a time.
      singles: sql<number>`count(*) filter (where ${emailSendsTable.batchId} is null)`,
    })
    .from(emailSendsTable)
    .where(sql`${emailSendsTable.createdAt} >= now() - (${String(days)} || ' days')::interval`);

  return res.json({
    days,
    batches: Number(row?.batches ?? 0),
    singles: Number(row?.singles ?? 0),
    total: Number(row?.total ?? 0),
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
    skipped: Number(row?.skipped ?? 0),
    opened: Number(row?.opened ?? 0),
    trackable: Number(row?.trackable ?? 0),
  });
});

router.get("/email-activity/batches", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const source = typeof req.query.source === "string" && req.query.source.trim() ? req.query.source.trim() : null;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  // Off by default. The point of this screen is the sends that went out
  // together — one-off bills would bury them — but he asked for "all emails,
  // not just in clients account", so the one-offs are one tick away.
  const includeSingles = req.query.includeSingles === "true" || req.query.includeSingles === "1";

  const rows = await loadBatches(
    and(
      includeSingles ? undefined : isNotNull(emailSendsTable.batchId),
      source ? eq(emailSendsTable.source, source) : undefined,
      q ? matchesSearch(q) : undefined,
    ),
    limit,
  );

  return res.json(rows);
});

/**
 * One batch's own line. The results screen can be bookmarked and sent to
 * whoever asks "did they get the letter", so it has to be able to draw its
 * own header without the list in front of it.
 */
router.get("/email-activity/batches/:batchId/overview", async (req, res) => {
  const where = rowsOfKey(String(req.params.batchId));
  if (!where) return res.status(404).json({ error: "That send is not in the log" });
  const [row] = await loadBatches(where, 1);
  if (!row) return res.status(404).json({ error: "That send is not in the log" });
  return res.json(row);
});

/** Who was in one batch, and whether each of them has opened it yet. */
router.get("/email-activity/batches/:batchId", async (req, res) => {
  const where = rowsOfKey(String(req.params.batchId));
  if (!where) return res.status(404).json({ error: "That send is not in the log" });
  const rows = await db
    .select({
      send: emailSendsTable,
      clientName: clientsTable.name,
      serviceAddress: clientsTable.serviceAddress,
      city: clientsTable.city,
      state: clientsTable.state,
      postalCode: clientsTable.postalCode,
      phone: clientsTable.phone,
    })
    .from(emailSendsTable)
    .leftJoin(clientsTable, eq(clientsTable.id, emailSendsTable.clientId))
    .where(where)
    .orderBy(asc(emailSendsTable.id));
  if (!rows.length) return res.status(404).json({ error: "That send is not in the log" });

  return res.json(
    rows.map((r) => ({
      id: r.send.id,
      clientId: r.send.clientId,
      clientName: r.clientName ?? "(deleted customer)",
      // He knows his customers by where they live, not by their email
      // address, so the address rides along on every line of the list.
      clientAddress: oneLineAddress(r),
      clientPhone: r.phone ?? null,
      toEmail: r.send.toEmail,
      subject: r.send.subject,
      status: r.send.status,
      skipReason: r.send.skipReason,
      error: r.send.error,
      openedAt: r.send.openedAt ? r.send.openedAt.toISOString() : null,
      // Whether this one carried a pixel at all. Without it the screen said
      // "not opened yet" about an email nobody could ever answer for — a
      // flat-out wrong thing to print beside a customer's name.
      trackable: r.send.status === "sent" && r.send.openToken != null,
      openCount: r.send.openCount,
      sentAt: r.send.sentAt ? r.send.sentAt.toISOString() : null,
      createdAt: r.send.createdAt.toISOString(),
    })),
  );
});

function oneLineAddress(r: {
  serviceAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}): string | null {
  const town = [r.city, r.state].map((x) => x?.trim()).filter((x): x is string => !!x).join(", ");
  const tail = [town, r.postalCode?.trim()].filter((x): x is string => !!x).join(" ");
  const line = [r.serviceAddress?.trim(), tail].filter((x): x is string => !!x).join(", ");
  return line || null;
}

// ------------------------------------------------- who the email comes from ----

/**
 * "Document comes from Koby, needs from Bison Lawn Care."
 *
 * The honest answer to "which address do my customers see". Read-only; the
 * Settings page prints it word for word rather than claiming something we
 * cannot prove.
 */
router.get("/email-sender", requireAuth, requireAdmin, async (_req, res) => {
  return res.json(await senderStatus());
});

// ------------------------------------------------ unopened email alert ----

router.use("/unopened-alerts", requireAuth, requireAdmin, requireArea("settings"));

/** The rule, plus who it would tell about today, without telling anybody. */
router.get("/unopened-alerts", async (_req, res) => {
  return res.json(await previewUnopenedAlert());
});

router.put("/unopened-alerts", async (req, res) => {
  const body = UpdateUnopenedAlertBody.parse(req.body);
  const before = await previewUnopenedAlert();
  await updateUnopenedAlertSettings({
    enabled: body.enabled ?? undefined,
    afterDays: body.afterDays ?? undefined,
    scope: (body.scope as UnopenedScope | undefined) ?? undefined,
    notifyEmail: body.notifyEmail === undefined ? undefined : body.notifyEmail,
  });
  const after = await previewUnopenedAlert();
  // Switching a rule on or off is the kind of thing he will want to see in the
  // trail later — "when did this start emailing me?".
  if (body.enabled != null && body.enabled !== before.enabled) {
    await logAudit({
      actorName: req.appUser?.name,
      action: body.enabled ? "unopened_email_alert_on" : "unopened_email_alert_off",
      description: body.enabled
        ? `Turned on the alert that tells ${after.notifyEmail ?? "the office"} when an email has gone ${after.afterDays} days without being opened`
        : "Turned off the alert about emails that have not been opened",
    });
  }
  return res.json(after);
});

/** "Send it to me now" — the same email the rule would send, on demand. */
router.post("/unopened-alerts/run", async (req, res) => {
  const result = await runUnopenedAlert({ force: true });
  await logAudit({
    actorName: req.appUser?.name,
    action: "unopened_email_alert_run",
    description: result.error
      ? `Tried to send the unopened-email alert by hand and it failed: ${result.error}`
      : `Sent the unopened-email alert by hand — ${result.reported} email${result.reported === 1 ? "" : "s"} reported`,
  });
  return res.json({ ...result, preview: await previewUnopenedAlert() });
});

export default router;
