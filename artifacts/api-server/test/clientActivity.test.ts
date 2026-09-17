import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  servicesTable,
  jobsTable,
  emailSendsTable,
  estimatesTable,
  auditEventsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

/**
 * The customer page's Jobs bar, Activity timeline, open/closed notes, tickets
 * and account-level photos (2026-09-15 walkthrough, sections M1, M4, M5).
 * Everything goes through the HTTP routes with the test-only auth header, the
 * way integration.test.ts does it. No mail is ever sent: the email rows here
 * are written straight to the table to stand in for sends that already went.
 */
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;
// Uploads land in a scratch folder that is thrown away at the end, never in
// the real photo store.
const STORAGE_DIR = mkdtempSync(join(tmpdir(), "bison-activity-test-"));
process.env.FILE_STORAGE_DIR = STORAGE_DIR;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[], services: [] as number[], emailSends: [] as number[] };

let admin: { id: number; name: string };
let contractor: { id: number; name: string };
let client: { id: number; name: string };
let service: { id: number; name: string };

async function api(
  path: string,
  userId: number | null,
  init: RequestInit = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(userId != null
        ? { "x-test-user-id": String(userId), "x-test-auth-token": TEST_AUTH_TOKEN }
        : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

const get = (path: string, userId?: number) => api(path, userId ?? admin.id);
const post = (path: string, data: unknown, userId?: number) =>
  api(path, userId ?? admin.id, { method: "POST", body: JSON.stringify(data) });
const patch = (path: string, data: unknown, userId?: number) =>
  api(path, userId ?? admin.id, { method: "PATCH", body: JSON.stringify(data) });

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
const TODAY = isoDay(0);
const YESTERDAY = isoDay(-1);

/**
 * The office is in the Idaho panhandle, which is Pacific. A visit finished at
 * 10 PM on the 15th is 5 AM UTC on the 16th, and it belongs to the 15th on
 * every screen he looks at.
 */
const EVENING_UTC_DAY = isoDay(-2);
const EVENING_LOCAL_DAY = isoDay(-3);
const EVENING_COMPLETED_AT = new Date(`${EVENING_UTC_DAY}T05:00:00.000Z`);
const pacificDay = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(at);

// A 1x1 transparent PNG, the smallest real image there is.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_PDF = Buffer.from("%PDF-1.4\n% backflow test form\n%%EOF\n").toString("base64");

let completedJob: { id: number };
let futureJob: { id: number };
let waitingJob: { id: number };
let eveningJob: { id: number };
let discountedJob: { id: number };
let invoiceId: number;
let noteId: number;
let ticketId: number;

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const [a, c] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_act_admin_${stamp}`, name: "Activity Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `test_act_contractor_${stamp}`, name: "Activity Contractor", role: "contractor" },
    ])
    .returning();
  admin = a;
  contractor = c;
  ids.users.push(a.id, c.id);

  const [cl] = await db
    .insert(clientsTable)
    .values({ name: `Test Activity Customer ${stamp}`, status: "client", serviceAddress: "7322 N Breaux Dr", email: "koby@radiantaisoftware.com" })
    .returning();
  client = cl;
  ids.clients.push(cl.id);

  const [svc] = await db.insert(servicesTable).values({ name: `Test Blowout ${stamp}` }).returning();
  service = svc;
  ids.services.push(svc.id);

  // One visit of each kind: done yesterday, on the board next week, and on
  // the waiting list with only a window.
  const [done, future, waiting] = await db
    .insert(jobsTable)
    .values([
      {
        clientId: client.id,
        serviceId: service.id,
        amount: 45,
        status: "completed",
        dispatched: true,
        scheduledDate: YESTERDAY,
        completedAt: new Date(`${YESTERDAY}T17:00:00.000Z`),
        assignedToId: contractor.id,
      },
      { clientId: client.id, serviceId: service.id, amount: 55, status: "scheduled", dispatched: true, scheduledDate: isoDay(7), assignedToId: contractor.id },
      { clientId: client.id, serviceId: service.id, amount: 65, status: "scheduled", dispatched: false, windowStart: isoDay(20), windowEnd: isoDay(30) },
    ])
    .returning();
  completedJob = done;
  futureJob = future;
  waitingJob = waiting;

  // A blowout finished at 10 PM Pacific: that is 5 AM UTC the next morning, so
  // the office's day and the UTC day disagree. And a mow with the $5 loyalty
  // discount on the assigned service, to pin what the row is worth.
  const [evening, discounted] = await db
    .insert(jobsTable)
    .values([
      {
        clientId: client.id,
        serviceId: service.id,
        amount: 75,
        status: "completed",
        dispatched: true,
        scheduledDate: EVENING_LOCAL_DAY,
        completedAt: EVENING_COMPLETED_AT,
        assignedToId: contractor.id,
      },
      {
        clientId: client.id,
        serviceId: service.id,
        amount: 50,
        discountType: "amount",
        discountValue: 5,
        status: "completed",
        dispatched: true,
        scheduledDate: YESTERDAY,
        completedAt: new Date(`${YESTERDAY}T17:00:00.000Z`),
        assignedToId: contractor.id,
      },
    ])
    .returning();
  eveningJob = evening;
  discountedJob = discounted;

  // Three emails that already went out: one the customer opened, one they
  // never opened, one skipped because they asked not to be emailed.
  const sends = await db
    .insert(emailSendsTable)
    .values([
      { clientId: client.id, source: "invoice", toEmail: "koby@radiantaisoftware.com", subject: "Bison Bill", status: "sent", sentAt: new Date(), openedAt: new Date(), openCount: 1 },
      { clientId: client.id, source: "dispatch", toEmail: "koby@radiantaisoftware.com", subject: "Your Sprinkler Blow Out is on Schedule", status: "sent", sentAt: new Date() },
      { clientId: client.id, source: "automation", toEmail: null, subject: "Spring letter", status: "skipped", skipReason: "do_not_email" },
    ])
    .returning();
  ids.emailSends.push(...sends.map((s) => s.id));

  await db.insert(estimatesTable).values({
    clientId: client.id,
    status: "sent",
    total: 120,
    lines: [],
    sentAt: new Date(),
    sentToEmail: "koby@radiantaisoftware.com",
  });
});

after(async () => {
  // Email rows keep their id when the client goes (set null), so they are
  // removed by hand; everything else hangs off the client and cascades.
  if (ids.emailSends.length) await db.delete(emailSendsTable).where(inArray(emailSendsTable.id, ids.emailSends));
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---- the Jobs bar ----

test("the client jobs list carries waiting-list jobs that GET /jobs leaves out", async () => {
  const mine = await get(`/clients/${client.id}/jobs`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const jobIds = mine.body.map((j: any) => j.id);
  assert.ok(jobIds.includes(completedJob.id));
  assert.ok(jobIds.includes(futureJob.id));
  assert.ok(jobIds.includes(waitingJob.id), "waiting-list job must be on the customer's list");

  const waiting = mine.body.find((j: any) => j.id === waitingJob.id);
  assert.equal(waiting.dispatched, false);
  assert.equal(waiting.serviceName, service.name);
  const done = mine.body.find((j: any) => j.id === completedJob.id);
  assert.equal(done.assignedToName, contractor.name);
  assert.equal(done.amount, 45);

  const board = await get(`/jobs?clientId=${client.id}`);
  assert.equal(board.status, 200);
  assert.ok(!board.body.some((j: any) => j.id === waitingJob.id), "the board list stays dispatched-only");
});

test("contractors cannot read a customer's job list", async () => {
  const res = await get(`/clients/${client.id}/jobs`, contractor.id);
  assert.equal(res.status, 403);
});

// ---- notes open / closed ----

test("an open note shows on the cross-customer open list until it is closed", async () => {
  const created = await post(`/clients/${client.id}/notes`, { body: "Check the backflow paperwork", status: "open" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "open");
  noteId = created.body.id;

  const record = await post(`/clients/${client.id}/notes`, { body: "Gate code is 4412" });
  assert.equal(record.body.status, "closed", "a plain note starts closed");

  const open = await get("/notes/open");
  assert.equal(open.status, 200);
  const mine = open.body.find((n: any) => n.id === noteId);
  assert.ok(mine, "open note is on the dashboard list");
  assert.equal(mine.clientName, client.name);
  assert.ok(!open.body.some((n: any) => n.id === record.body.id), "closed notes stay off it");

  const closed = await patch(`/client-notes/${noteId}`, { status: "closed" });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.status, "closed");
  assert.ok(closed.body.closedAt);

  const after = await get("/notes/open");
  assert.ok(!after.body.some((n: any) => n.id === noteId));

  const reopened = await patch(`/client-notes/${noteId}`, { status: "open" });
  assert.equal(reopened.body.status, "open");
  assert.equal(reopened.body.closedAt, null);

  const audit = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, client.id), inArray(auditEventsTable.action, ["note_closed", "note_reopened"])));
  assert.deepEqual(audit.map((a) => a.action).sort(), ["note_closed", "note_reopened"]);
});

test("note status changes are office-only and need a real note", async () => {
  assert.equal((await patch(`/client-notes/${noteId}`, { status: "closed" }, contractor.id)).status, 403);
  assert.equal((await patch(`/client-notes/999999999`, { status: "closed" })).status, 404);
  assert.equal((await patch(`/client-notes/${noteId}`, { status: "maybe" })).status, 400);
  assert.equal((await get("/notes/open", contractor.id)).status, 403);
});

// ---- tickets on the client page ----

test("a ticket added from the account is listed under that customer", async () => {
  const created = await post("/tickets", { clientId: client.id, title: "Call about the gate", dueDate: isoDay(3), assignedToId: contractor.id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ticketId = created.body.id;
  assert.equal(created.body.clientName, client.name);
  assert.equal(created.body.assignedToName, contractor.name);

  const list = await get(`/tickets?clientId=${client.id}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.some((t: any) => t.id === ticketId));
  assert.ok(list.body.every((t: any) => t.clientId === client.id), "filter must hold to one customer");

  const done = await patch(`/tickets/${ticketId}`, { status: "done" });
  assert.equal(done.body.status, "done");
});

// ---- the activity timeline ----

test("the timeline unions visits, invoices, payments, emails, estimates, tickets, notes and events", async () => {
  const inv = await post("/invoices", { clientId: client.id, total: 80 });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  invoiceId = inv.body.id;
  const pay = await post("/payments", { clientId: client.id, invoiceId, amount: 30, method: "check", reference: "chk 101" });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));

  const res = await get(`/client-activity?clientId=${client.id}&from=${isoDay(-400)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const items: any[] = res.body;

  const kinds = new Set(items.map((i) => i.kind));
  for (const k of ["visit", "invoice", "payment", "email", "estimate", "ticket", "note", "event"]) {
    assert.ok(kinds.has(k), `timeline is missing ${k}`);
  }

  // Newest first, whatever kind of row it is.
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i - 1].date >= items[i].date, `out of order at ${i}: ${items[i - 1].date} then ${items[i].date}`);
  }

  const visit = items.find((i) => i.refKind === "job" && i.refId === completedJob.id);
  assert.equal(visit.date, YESTERDAY, "a completed visit belongs to the day it was done");
  assert.equal(visit.title, service.name);
  assert.equal(visit.amount, 45);
  assert.equal(visit.status, "completed");
  assert.match(visit.detail, new RegExp(`by ${contractor.name}`));

  const waiting = items.find((i) => i.refKind === "job" && i.refId === waitingJob.id);
  assert.equal(waiting.date, isoDay(20), "a waiting-list visit belongs to the start of its window");
  assert.match(waiting.detail, /waiting list/);

  const invoice = items.find((i) => i.refKind === "invoice" && i.refId === invoiceId);
  assert.equal(invoice.amount, 80);
  assert.match(invoice.detail, /\$50\.00 still owed/);

  const payment = items.find((i) => i.kind === "payment");
  assert.equal(payment.amount, 30);
  assert.match(payment.title, /check/);
  assert.match(payment.detail, /chk 101/);
  assert.match(payment.detail, new RegExp(`invoice #${invoiceId}`));

  const emails = items.filter((i) => i.kind === "email");
  const byStatus = Object.fromEntries(emails.map((e) => [e.title, e.status]));
  assert.equal(byStatus["Bison Bill"], "opened");
  assert.equal(byStatus["Your Sprinkler Blow Out is on Schedule"], "unopened");
  assert.equal(byStatus["Spring letter"], "skipped");
  assert.match(emails.find((e) => e.title === "Spring letter").detail, /do not email/);
  assert.match(emails.find((e) => e.title === "Bison Bill").detail, /opened/);

  const estimate = items.find((i) => i.kind === "estimate");
  assert.equal(estimate.amount, 120);
  assert.equal(estimate.status, "sent");

  const ticket = items.find((i) => i.refKind === "ticket" && i.refId === ticketId);
  assert.equal(ticket.date, isoDay(3), "a ticket sits on its due day");
  assert.equal(ticket.status, "done");

  const note = items.find((i) => i.refKind === "note" && i.refId === noteId);
  assert.equal(note.status, "open");
  assert.equal(note.actorName, admin.name);

  assert.ok(items.some((i) => i.kind === "event" && i.title === "Added a note"), "audit rows show as events");
});

test("the date range and the kinds filter narrow the timeline", async () => {
  const empty = await get(`/client-activity?clientId=${client.id}&from=${isoDay(60)}&to=${isoDay(60)}`);
  assert.deepEqual(empty.body, []);

  const past = await get(`/client-activity?clientId=${client.id}&from=${isoDay(-400)}&to=${YESTERDAY}`);
  assert.ok(past.body.some((i: any) => i.refKind === "job" && i.refId === completedJob.id));
  assert.ok(!past.body.some((i: any) => i.refKind === "job" && i.refId === futureJob.id), "a future visit is outside a range that ends yesterday");

  const moneyOnly = await get(`/client-activity?clientId=${client.id}&kinds=invoice,payment`);
  assert.ok(moneyOnly.body.length >= 2);
  assert.ok(moneyOnly.body.every((i: any) => i.kind === "invoice" || i.kind === "payment"));

  // The default window is the last 90 days plus everything still to come.
  const defaults = await get(`/client-activity?clientId=${client.id}`);
  assert.ok(defaults.body.some((i: any) => i.refKind === "job" && i.refId === futureJob.id));
});

test("an evening visit sits on the office's day, not the UTC one", async () => {
  // Sanity on the fixture itself: 5 AM UTC really is the previous evening here.
  assert.equal(pacificDay(EVENING_COMPLETED_AT), EVENING_LOCAL_DAY);
  assert.notEqual(EVENING_UTC_DAY, EVENING_LOCAL_DAY);

  const res = await get(`/client-activity?clientId=${client.id}&from=${isoDay(-400)}`);
  const visit = res.body.find((i: any) => i.refKind === "job" && i.refId === eveningJob.id);
  assert.ok(visit, "the 10 PM visit is on the timeline");
  assert.equal(visit.date, EVENING_LOCAL_DAY, "a visit finished at 10 PM belongs to that evening's day");

  // A range that ends on the day he did the work must still contain it.
  const upToThatDay = await get(
    `/client-activity?clientId=${client.id}&from=${isoDay(-400)}&to=${EVENING_LOCAL_DAY}`,
  );
  assert.ok(
    upToThatDay.body.some((i: any) => i.refKind === "job" && i.refId === eveningJob.id),
    "a range ending on the day of the visit must keep it",
  );

  // Everything the timeline stamps off a timestamp uses the same calendar.
  const noteItem = res.body.find((i: any) => i.refKind === "note" && i.refId === noteId);
  assert.equal(noteItem.date, pacificDay(new Date(noteItem.at)), "a note is dated on the office's day too");
  const payment = res.body.find((i: any) => i.kind === "payment");
  assert.equal(payment.date, pacificDay(new Date(payment.at)), "a payment is dated on the office's day too");
});

test("the visit amount is what it bills at, after the discount on the assigned service", async () => {
  const res = await get(`/client-activity?clientId=${client.id}&from=${isoDay(-400)}`);
  const visit = res.body.find((i: any) => i.refKind === "job" && i.refId === discountedJob.id);
  assert.ok(visit, "the discounted visit is on the timeline");
  assert.equal(visit.amount, 45, "a $50 mow with $5 off is worth $45 on the timeline");

  const plain = res.body.find((i: any) => i.refKind === "job" && i.refId === completedJob.id);
  assert.equal(plain.amount, 45, "a visit with no discount is untouched");

  // The job row itself keeps the retail price, and hands the Jobs bar the
  // discount so it can show and total the net.
  const jobs = await get(`/clients/${client.id}/jobs`);
  const row = jobs.body.find((j: any) => j.id === discountedJob.id);
  assert.equal(row.amount, 50, "history keeps what the service lists at");
  assert.equal(row.discountAmount, 5);
  assert.equal(row.amount - row.discountAmount, 45, "the Jobs bar nets these two");
  const plainRow = jobs.body.find((j: any) => j.id === completedJob.id);
  assert.equal(plainRow.discountAmount, 0);
});

test("estimate and photo timestamps come across as instants the page can date", async () => {
  // The client page dates these itself; slicing ten characters off them would
  // give the UTC day, which is the next day on any evening send or upload.
  const ests = await get(`/estimates?clientId=${client.id}`);
  assert.equal(ests.status, 200, JSON.stringify(ests.body));
  const sent = ests.body.find((e: any) => e.sentAt);
  assert.ok(sent, "the seeded estimate went out");
  assert.match(sent.sentAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "sentAt is a full instant, not a day");

  const up = await post(`/clients/${client.id}/photos`, { contentType: "image/png", dataBase64: TINY_PNG });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.match(up.body.takenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "takenAt is a full instant, not a day");
  assert.equal((await api(`/photos/${up.body.id}`, admin.id, { method: "DELETE" })).status, 204);
});

test("the timeline refuses bad input and non-office users", async () => {
  assert.equal((await get(`/client-activity`)).status, 400);
  assert.equal((await get(`/client-activity?clientId=${client.id}&from=yesterday`)).status, 400);
  assert.equal((await get(`/client-activity?clientId=999999999`)).status, 404);
  assert.equal((await get(`/client-activity?clientId=${client.id}`, contractor.id)).status, 403);
});

// ---- photos and files on the account ----

test("the office can save a photo straight to the customer and relabel it", async () => {
  const up = await post(`/clients/${client.id}/photos`, { contentType: "image/png", dataBase64: TINY_PNG, kind: "before", caption: "Shut-off by the front door" });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.jobId, null, "an account upload has no job behind it");
  assert.equal(up.body.clientId, client.id);
  assert.equal(up.body.kind, "before");
  assert.equal(up.body.uploadedByName, admin.name);
  assert.equal(up.body.url, `/api/photos/${up.body.id}/content`);

  const list = await get(`/clients/${client.id}/photos`);
  assert.ok(list.body.some((p: any) => p.id === up.body.id));

  const bytes = await api(`/photos/${up.body.id}/content`, admin.id);
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get("content-type"), "image/png");

  const relabelled = await patch(`/photos/${up.body.id}`, { kind: "after" });
  assert.equal(relabelled.status, 200, JSON.stringify(relabelled.body));
  assert.equal(relabelled.body.kind, "after");
  assert.equal(relabelled.body.caption, "Shut-off by the front door", "caption survives a relabel");

  const activity = await get(`/client-activity?clientId=${client.id}&kinds=event`);
  assert.ok(activity.body.some((i: any) => /before photo added to/.test(i.title)), "the upload is on the timeline");

  // A contractor never reaches an account-level upload: no job, no access.
  assert.equal((await api(`/photos/${up.body.id}/content`, contractor.id)).status, 403);
  assert.equal((await patch(`/photos/${up.body.id}`, { kind: "other" }, contractor.id)).status, 403);

  const del = await api(`/photos/${up.body.id}`, admin.id, { method: "DELETE" });
  assert.equal(del.status, 204);
  assert.equal((await get(`/clients/${client.id}/photos`)).body.some((p: any) => p.id === up.body.id), false);
});

test("a PDF is a file on the account; bad uploads are refused", async () => {
  const pdf = await post(`/clients/${client.id}/photos`, { contentType: "application/pdf", dataBase64: TINY_PDF, caption: "Backflow test 2026" });
  assert.equal(pdf.status, 201, JSON.stringify(pdf.body));
  assert.equal(pdf.body.contentType, "application/pdf");
  assert.equal(pdf.body.kind, "other", "a file takes the default label");
  const activity = await get(`/client-activity?clientId=${client.id}&kinds=event`);
  assert.ok(activity.body.some((i: any) => /file added to/.test(i.title) && /Backflow test 2026/.test(i.title)));

  const stored = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
  assert.ok(stored.length);
  assert.ok(existsSync(STORAGE_DIR), "uploads went to the scratch store");

  assert.equal((await post(`/clients/${client.id}/photos`, { contentType: "image/gif", dataBase64: TINY_PNG })).status, 400);
  assert.equal((await post(`/clients/${client.id}/photos`, { contentType: "image/png", dataBase64: "" })).status, 400);
  assert.equal((await post(`/clients/999999999/photos`, { contentType: "image/png", dataBase64: TINY_PNG })).status, 404);
  assert.equal((await post(`/clients/${client.id}/photos`, { contentType: "image/png", dataBase64: TINY_PNG }, contractor.id)).status, 403);
  assert.equal((await get(`/clients/${client.id}/photos`, contractor.id)).status, 403);

  assert.equal((await api(`/photos/${pdf.body.id}`, admin.id, { method: "DELETE" })).status, 204);
});
