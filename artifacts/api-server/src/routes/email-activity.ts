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
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";

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

// Everything below is the office's activity screen.
router.use("/email-activity", requireAuth, requireAdmin);

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

/**
 * One row per bulk send. A batch is whatever went out together: the twelve
 * blow-out letters he sent from the board, or one automation's run for the
 * day. He reads "42 of 44 sent, 21 opened" from this list and clicks in to
 * see who.
 */
router.get("/email-activity/batches", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = await db
    .select({
      batchId: emailSendsTable.batchId,
      source: emailSendsTable.source,
      templateId: emailSendsTable.templateId,
      sentById: emailSendsTable.sentById,
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
    })
    .from(emailSendsTable)
    .where(isNotNull(emailSendsTable.batchId))
    .groupBy(emailSendsTable.batchId, emailSendsTable.source, emailSendsTable.templateId, emailSendsTable.sentById)
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
          .select({ batchId: emailSendsTable.batchId, ruleName: automationRulesTable.name })
          .from(automationSendsTable)
          .innerJoin(emailSendsTable, eq(emailSendsTable.id, automationSendsTable.emailSendId))
          .innerJoin(automationRulesTable, eq(automationRulesTable.id, automationSendsTable.ruleId))
          .where(inArray(emailSendsTable.batchId, batchIds))
          .groupBy(emailSendsTable.batchId, automationRulesTable.name)
      : Promise.resolve([]),
  ]);
  const templateNames = new Map(templates.map((t) => [t.id, t.name]));
  const userNames = new Map(users.map((u) => [u.id, u.name]));
  const ruleNames = new Map(ruleLinks.map((r) => [r.batchId, r.ruleName]));

  return res.json(
    rows.map((r) => ({
      batchId: r.batchId!,
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
    })),
  );
});

/** Who was in one batch, and whether each of them has opened it yet. */
router.get("/email-activity/batches/:batchId", async (req, res) => {
  const batchId = String(req.params.batchId);
  const rows = await db
    .select({ send: emailSendsTable, clientName: clientsTable.name })
    .from(emailSendsTable)
    .leftJoin(clientsTable, eq(clientsTable.id, emailSendsTable.clientId))
    .where(eq(emailSendsTable.batchId, batchId))
    .orderBy(asc(emailSendsTable.id));
  if (!rows.length) return res.status(404).json({ error: "That send is not in the log" });

  return res.json(
    rows.map(({ send, clientName }) => ({
      id: send.id,
      clientId: send.clientId,
      clientName: clientName ?? "(deleted customer)",
      toEmail: send.toEmail,
      subject: send.subject,
      status: send.status,
      skipReason: send.skipReason,
      error: send.error,
      openedAt: send.openedAt ? send.openedAt.toISOString() : null,
      openCount: send.openCount,
      sentAt: send.sentAt ? send.sentAt.toISOString() : null,
      createdAt: send.createdAt.toISOString(),
    })),
  );
});

export default router;
