import { Router, type IRouter } from "express";
import {
  db,
  auditEventsTable,
  clientsTable,
  clientNotesTable,
  emailSendsTable,
  estimatesTable,
  invoicesTable,
  jobsTable,
  paymentsTable,
  servicesTable,
  ticketsTable,
  usersTable,
} from "@workspace/db";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { UpdateClientNoteBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { addDays, localDay } from "../lib/automationRunner";
import { balanceOf } from "../lib/invoiceDocument";
import { discountAmountFor } from "../lib/jobGeneration";
import { logAudit } from "../lib/helpers";
import { hydrateJobs } from "./jobs";
import { shownName } from "../lib/userAccounts";

/**
 * The client page's Jobs bar and Activity timeline, and the open/closed state
 * on notes. His current CRM shows one list — visits, invoices, payments,
 * emails, estimates, notes — filtered by a date range, and he reads a
 * customer's story off it. Everything here is office-only: a contractor has no
 * business on the client record at all.
 */
const router: IRouter = Router();

router.use(["/clients", "/client-activity", "/client-notes", "/notes"], requireAuth, requireArea("clients"));

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * yyyy-mm-dd of an instant, on the office's calendar (Pacific).
 *
 * A blowout finished at 6:30 PM on the 15th is 1:30 AM UTC on the 16th. Off
 * the UTC clock it landed on the timeline under the 16th, the card said
 * "Sep 16" while the row under it said "Sep 15, 6:30 PM", and a range ending
 * on the 15th lost the visit altogether. Same for a check keyed in after 5,
 * an email that went out at night, a note typed after supper.
 */
function dayOf(at: Date): string {
  return localDay(at);
}

/** A date N days before today on the office's calendar, yyyy-mm-dd. */
function daysAgo(n: number): string {
  return addDays(localDay(new Date()), -n);
}

type ActivityKind = "visit" | "invoice" | "payment" | "email" | "estimate" | "ticket" | "note" | "event";
const ALL_KINDS: ActivityKind[] = ["visit", "invoice", "payment", "email", "estimate", "ticket", "note", "event"];

type ActivityItem = {
  kind: ActivityKind;
  date: string;
  at: string | null;
  title: string;
  detail: string | null;
  amount: number | null;
  status: string | null;
  actorName: string | null;
  refKind: "job" | "invoice" | "payment" | "email" | "estimate" | "ticket" | "note" | "audit";
  refId: number;
};

const money = (n: number) => `$${n.toFixed(2)}`;

router.get("/clients/:id/jobs", async (req, res) => {
  const clientId = Number(req.params.id);
  const rows = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.clientId, clientId))
    // Newest date at the top whatever kind of date the job has: a dispatched
    // job has a day, a waiting-list job only has a window.
    .orderBy(desc(jobsTable.scheduledDate), desc(jobsTable.windowStart), desc(jobsTable.id));
  return res.json(await hydrateJobs(rows));
});

router.get("/client-activity", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const clientId = Number(q.clientId);
  if (!q.clientId || !Number.isInteger(clientId)) {
    return res.status(400).json({ error: "clientId is required" });
  }

  for (const [label, value] of [["from", q.from], ["to", q.to]] as const) {
    if (value && !ISO_DATE_RE.test(value)) {
      return res.status(400).json({ error: `${label} must be a date in yyyy-mm-dd format` });
    }
  }
  // 90 days when the office does not say: a customer since 2019 has more
  // rows than anyone wants to scroll, and "recently" is what he means.
  const from = q.from || daysAgo(90);
  const to = q.to || "9999-12-31";
  const kinds = new Set<ActivityKind>(
    q.kinds
      ? (q.kinds.split(",").map((k) => k.trim()) as ActivityKind[]).filter((k) => ALL_KINDS.includes(k))
      : ALL_KINDS,
  );

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client) return res.status(404).json({ error: "Client not found" });

  // One query per table, all by client id. A single customer's rows are
  // hundreds, not millions, so the range filter is applied in memory where
  // the mixed date-only and timestamp columns are easiest to treat alike.
  const [jobs, invoices, payments, emails, estimates, tickets, notes, audit] = await Promise.all([
    kinds.has("visit") ? db.select().from(jobsTable).where(eq(jobsTable.clientId, clientId)) : [],
    kinds.has("invoice") ? db.select().from(invoicesTable).where(eq(invoicesTable.clientId, clientId)) : [],
    kinds.has("payment") ? db.select().from(paymentsTable).where(eq(paymentsTable.clientId, clientId)) : [],
    kinds.has("email") ? db.select().from(emailSendsTable).where(eq(emailSendsTable.clientId, clientId)) : [],
    kinds.has("estimate") ? db.select().from(estimatesTable).where(eq(estimatesTable.clientId, clientId)) : [],
    kinds.has("ticket") ? db.select().from(ticketsTable).where(eq(ticketsTable.clientId, clientId)) : [],
    kinds.has("note") ? db.select().from(clientNotesTable).where(eq(clientNotesTable.clientId, clientId)) : [],
    kinds.has("event") ? db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, clientId)) : [],
  ]);

  const serviceIds = [...new Set(jobs.map((j) => j.serviceId).filter((x): x is number => x != null))];
  const userIds = [
    ...new Set(
      [...jobs.map((j) => j.assignedToId), ...tickets.map((t) => t.assignedToId)].filter(
        (x): x is number => x != null,
      ),
    ),
  ];
  const [services, users] = await Promise.all([
    serviceIds.length ? db.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds)) : [],
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : [],
  ]);
  const sName = new Map(services.map((s) => [s.id, s.name]));
  const uName = new Map(users.map((u) => [u.id, shownName(u)]));

  const items: ActivityItem[] = [];

  for (const j of jobs) {
    // A completed visit belongs to the day it was done; a scheduled one to its
    // day on the board; a waiting-list one to the start of its window.
    const date = j.completedAt ? dayOf(j.completedAt) : (j.scheduledDate ?? j.windowStart ?? dayOf(j.createdAt));
    const who = j.assignedToId ? uName.get(j.assignedToId) : null;
    items.push({
      kind: "visit",
      date,
      at: j.completedAt ? j.completedAt.toISOString() : null,
      title: j.serviceId ? (sName.get(j.serviceId) ?? "Job") : "Job",
      detail: [who ? `by ${who}` : "unassigned", !j.dispatched ? "waiting list" : null].filter(Boolean).join(" · "),
      // What the visit is worth to him after the discount on the assigned
      // service, because that is what the invoice next to it says. The job row
      // keeps the retail price; showing that here made a $50 mow with a $5
      // loyalty discount read $50 beside its own $45 invoice.
      amount: j.amount - discountAmountFor(j.amount, j.discountType, j.discountValue),
      status: j.status,
      actorName: who ?? null,
      refKind: "job",
      refId: j.id,
    });
  }

  for (const inv of invoices) {
    const balance = balanceOf(inv);
    items.push({
      kind: "invoice",
      date: inv.invoiceDate ?? dayOf(inv.createdAt),
      at: inv.createdAt.toISOString(),
      title: `Invoice #${inv.number ?? inv.id}`,
      detail: inv.status === "void" ? "void" : balance > 0 ? `${money(balance)} still owed` : "paid in full",
      amount: inv.total,
      status: inv.status,
      actorName: null,
      refKind: "invoice",
      refId: inv.id,
    });
  }

  for (const p of payments) {
    items.push({
      kind: "payment",
      date: dayOf(p.createdAt),
      at: p.createdAt.toISOString(),
      title: `Payment (${p.method.replace(/_/g, " ")})`,
      detail: [p.reference ? `ref ${p.reference}` : null, p.invoiceId ? `on invoice #${p.invoiceId}` : "on account"]
        .filter(Boolean)
        .join(" · "),
      amount: p.amount,
      status: null,
      actorName: null,
      refKind: "payment",
      refId: p.id,
    });
  }

  for (const e of emails) {
    const when = e.sentAt ?? e.createdAt;
    // "Opened" is the thing he wants to know — the pixel tells us, and an
    // email that was never opened is the one worth a phone call.
    const status =
      e.status === "sent" ? (e.openedAt ? "opened" : "unopened") : e.status === "skipped" ? "skipped" : "failed";
    const detailParts = [e.toEmail ? `to ${e.toEmail}` : null];
    if (e.openedAt) detailParts.push(`opened ${e.openedAt.toISOString()}`);
    if (e.status === "skipped" && e.skipReason) detailParts.push(e.skipReason.replace(/_/g, " "));
    if (e.status === "failed" && e.error) detailParts.push(e.error);
    items.push({
      kind: "email",
      date: dayOf(when),
      at: when.toISOString(),
      title: e.subject ?? "Email",
      detail: detailParts.filter(Boolean).join(" · ") || null,
      amount: null,
      status,
      actorName: null,
      refKind: "email",
      refId: e.id,
    });
  }

  for (const est of estimates) {
    const when = est.sentAt ?? est.createdAt;
    items.push({
      kind: "estimate",
      date: dayOf(when),
      at: when.toISOString(),
      title: `Estimate #${est.id}`,
      detail: est.sentToEmail ? `sent to ${est.sentToEmail}` : "not sent yet",
      amount: est.status === "accepted" && est.acceptedTotal != null ? est.acceptedTotal : est.total,
      status: est.status,
      actorName: null,
      refKind: "estimate",
      refId: est.id,
    });
  }

  for (const t of tickets) {
    const who = t.assignedToId ? uName.get(t.assignedToId) : null;
    items.push({
      kind: "ticket",
      date: t.dueDate ?? dayOf(t.createdAt),
      at: t.createdAt.toISOString(),
      title: t.title,
      detail: [t.description, who ? `for ${who}` : null].filter(Boolean).join(" · ") || null,
      amount: null,
      status: t.status,
      actorName: who ?? null,
      refKind: "ticket",
      refId: t.id,
    });
  }

  for (const n of notes) {
    items.push({
      kind: "note",
      date: dayOf(n.createdAt),
      at: n.createdAt.toISOString(),
      title: n.body.length > 80 ? `${n.body.slice(0, 77)}...` : n.body,
      detail: n.body.length > 80 ? n.body : null,
      amount: null,
      status: n.status,
      actorName: n.authorName,
      refKind: "note",
      refId: n.id,
    });
  }

  for (const a of audit) {
    items.push({
      kind: "event",
      date: dayOf(a.createdAt),
      at: a.createdAt.toISOString(),
      title: a.description,
      detail: a.action.replace(/_/g, " "),
      amount: null,
      status: null,
      actorName: a.actorName,
      refKind: "audit",
      refId: a.id,
    });
  }

  const inRange = items.filter((i) => i.date >= from && i.date <= to);
  inRange.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const at = (b.at ?? "").localeCompare(a.at ?? "");
    return at !== 0 ? at : b.refId - a.refId;
  });
  return res.json(inRange.slice(0, 500));
});

router.patch("/client-notes/:id", async (req, res) => {
  const body = UpdateClientNoteBody.parse(req.body);
  const id = Number(req.params.id);
  const [existing] = await db.select().from(clientNotesTable).where(eq(clientNotesTable.id, id));
  if (!existing) return res.status(404).json({ error: "Note not found" });
  const [note] = await db
    .update(clientNotesTable)
    .set({ status: body.status, closedAt: body.status === "closed" ? new Date() : null })
    .where(eq(clientNotesTable.id, id))
    .returning();
  if (existing.status !== note.status) {
    await logAudit({
      clientId: note.clientId,
      actorName: req.appUser?.name,
      action: body.status === "closed" ? "note_closed" : "note_reopened",
      description: body.status === "closed" ? "Closed a note" : "Reopened a note",
    });
  }
  return res.json({ ...note, clientName: null });
});

// Oldest first: the note that has waited longest is the one he should look at.
router.get("/notes/open", async (_req, res) => {
  const rows = await db
    .select()
    .from(clientNotesTable)
    .where(eq(clientNotesTable.status, "open"))
    .orderBy(asc(clientNotesTable.createdAt))
    .limit(200);
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const clients = clientIds.length
    ? await db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds))
    : [];
  const cName = new Map(clients.map((c) => [c.id, c.name]));
  return res.json(rows.map((r) => ({ ...r, clientName: cName.get(r.clientId) ?? null })));
});

export default router;
