import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  documentTemplatesTable,
  emailSendsTable,
  automationRulesTable,
  automationSendsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const stamp = Date.now();
const ids = { users: [] as number[], clients: [] as number[], templates: [] as number[], rules: [] as number[] };

let admin: { id: number; name: string };
let noDocuments: { id: number };
let contractor: { id: number };
let sarah: { id: number; name: string };
let ridge: { id: number; name: string };
let nancy: { id: number; name: string };
let otis: { id: number; name: string };
let template: { id: number; name: string };

// Two batches of our own plus a one-off with no batch id, so the screen can be
// checked without touching the 709 real customers in the local database.
const BOARD_BATCH = `test_board_${stamp}`;
const AUTO_BATCH = `test_auto_${stamp}`;
const OLD_BATCH = `test_old_${stamp}`;
const SENT_TOKEN = `tok_sent_${stamp}`;
const FAILED_TOKEN = `tok_failed_${stamp}`;
const SOLO_TOKEN = `tok_solo_${stamp}`;
let soloId = 0;
let boardRowIds: number[] = [];

// The crew's "on my way" notice: one batch per job, no pixel in the email.
const CREW_BATCH_A = `on-the-way:ea_a_${stamp}`;
const CREW_BATCH_B = `on-the-way:ea_b_${stamp}`;
// One press of "Email all" over three bills, one of them with no address.
const INVOICE_BATCH = `test_invoice_${stamp}`;
// The letter he sent a fortnight ago, sitting behind everything above it.
const REMINDER_BATCH = `test_reminder_${stamp}`;
let reminderTemplate: { id: number; name: string };

async function api(path: string, userId: number | null, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(userId != null ? { "x-test-user-id": String(userId), "x-test-auth-token": TEST_AUTH_TOKEN } : {}),
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
  return { status: res.status, body };
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const users = await db
    .insert(usersTable)
    .values([
      { clerkId: `ea_admin_${stamp}`, name: "Email Activity Admin", role: "admin", roleSource: "owner_assigned" },
      // An office person Adam kept away from documents: the sidebar hides the
      // link for them, so the screen has to refuse them too.
      { clerkId: `ea_nodocs_${stamp}`, name: "No Documents Nora", role: "admin", roleSource: "owner_assigned", accessLevel: "full", permissions: ["!documents"] },
      { clerkId: `ea_sub_${stamp}`, name: "Sub On A Phone", role: "contractor", roleSource: "owner_assigned", accessLevel: "mobile" },
    ])
    .returning();
  [admin, noDocuments, contractor] = users as any;
  ids.users.push(...users.map((u) => u.id));

  const clients = await db
    .insert(clientsTable)
    .values([
      { name: `EA Sarah ${stamp}`, status: "client", email: "koby@radiantaisoftware.com", serviceAddress: "12 Elm St", city: "Post Falls", state: "ID", postalCode: "83854", phone: "208-555-0101" },
      { name: `EA Ridgeline ${stamp}`, status: "client", email: "kobystull123@gmail.com", city: "Hayden", state: "ID" },
      { name: `EA Nancy ${stamp}`, status: "client", email: null, serviceAddress: "9 Larch Ln" },
      { name: `EA Otis ${stamp}`, status: "client", email: "koby@radiantaisoftware.com", doNotEmail: true } as any,
    ])
    .returning();
  [sarah, ridge, nancy, otis] = clients as any;
  ids.clients.push(...clients.map((c) => c.id));

  const [t] = await db
    .insert(documentTemplatesTable)
    .values({
      key: `__test_email_activity_${stamp}`,
      name: `EA Sprinkler Blow Out ${stamp}`,
      kind: "notice",
      category: "client",
      subject: "Blow out day",
      body: "Your blow out is on [servicedate].",
      isSeeded: false,
    })
    .returning();
  template = t;
  ids.templates.push(t.id);

  const [rule] = await db
    .insert(automationRulesTable)
    .values({ name: `EA Past Due ${stamp}`, enabled: false, trigger: "invoice_past_due", offsetDays: 2, templateId: t.id })
    .returning();
  ids.rules.push(rule.id);

  const older = new Date(Date.now() - 60 * 60 * 1000);
  const newer = new Date(Date.now() - 5 * 60 * 1000);

  // The board batch: two went out (one of them opened), one blew up at the
  // mail server, one was left out because there is no address on file.
  const boardRows = await db
    .insert(emailSendsTable)
    .values([
      { clientId: sarah.id, templateId: t.id, sentById: admin.id, source: "dispatch", batchId: BOARD_BATCH, toEmail: "koby@radiantaisoftware.com", subject: "Blow out day", status: "sent", openToken: SENT_TOKEN, sentAt: older, createdAt: older },
      { clientId: ridge.id, templateId: t.id, sentById: admin.id, source: "dispatch", batchId: BOARD_BATCH, toEmail: "kobystull123@gmail.com", subject: "Blow out day", status: "sent", openToken: `tok_unopened_${stamp}`, sentAt: older, createdAt: older },
      { clientId: otis.id, templateId: t.id, sentById: admin.id, source: "dispatch", batchId: BOARD_BATCH, toEmail: "koby@radiantaisoftware.com", subject: "Blow out day", status: "failed", error: "mailbox full", openToken: FAILED_TOKEN, createdAt: older },
      { clientId: nancy.id, templateId: t.id, sentById: admin.id, source: "dispatch", batchId: BOARD_BATCH, status: "skipped", skipReason: "no_email", createdAt: older },
    ] as any)
    .returning({ id: emailSendsTable.id });
  boardRowIds = boardRows.map((r) => r.id);

  const [autoSend] = await db
    .insert(emailSendsTable)
    .values({ clientId: sarah.id, templateId: t.id, source: "automation", batchId: AUTO_BATCH, toEmail: "koby@radiantaisoftware.com", subject: "Past due", status: "sent", openToken: `tok_auto_${stamp}`, sentAt: newer, createdAt: newer } as any)
    .returning();
  await db.insert(automationSendsTable).values({ ruleId: rule.id, subjectKey: `ea_${stamp}`, emailSendId: autoSend.id });

  // One bill emailed to one customer on its own: no batch id at all. It is not
  // a batch, so it stays out of the list until he asks for it — but he must be
  // able to ask for it ("did Jackie get her bill?").
  const [solo] = await db
    .insert(emailSendsTable)
    .values({ clientId: sarah.id, source: "invoice", batchId: null, toEmail: "koby@radiantaisoftware.com", subject: "Your bill", status: "sent", openToken: SOLO_TOKEN, sentAt: newer, createdAt: newer } as any)
    .returning();
  soloId = solo.id;

  // The crew notice. sms.ts writes it with no open token and the email itself
  // carries no pixel, so nothing can ever come back about it — and it is one
  // batch per job, which is what buries a letter in the list.
  await db.insert(emailSendsTable).values([
    { clientId: sarah.id, sentById: contractor.id, source: "crew", batchId: CREW_BATCH_A, toEmail: "koby@radiantaisoftware.com", subject: "On my way", status: "sent", sentAt: newer, createdAt: newer },
    { clientId: ridge.id, sentById: contractor.id, source: "crew", batchId: CREW_BATCH_B, toEmail: "kobystull123@gmail.com", subject: "On my way", status: "sent", sentAt: newer, createdAt: newer },
  ] as any);

  // "Email all" over three bills, one customer with no address on file. The
  // left-out row carries no document, exactly the way invoiceDelivery writes
  // it, so the whole run used to come back as two separate lines.
  await db.insert(emailSendsTable).values([
    { clientId: sarah.id, templateId: t.id, sentById: admin.id, source: "invoice", batchId: INVOICE_BATCH, toEmail: "koby@radiantaisoftware.com", subject: "Invoice 1001", status: "sent", openToken: `tok_inv_a_${stamp}`, sentAt: newer, createdAt: newer },
    { clientId: ridge.id, templateId: t.id, sentById: admin.id, source: "invoice", batchId: INVOICE_BATCH, toEmail: "kobystull123@gmail.com", subject: "Invoice 1002", status: "sent", openToken: `tok_inv_b_${stamp}`, sentAt: newer, createdAt: newer },
    { clientId: nancy.id, sentById: admin.id, source: "invoice", batchId: INVOICE_BATCH, status: "skipped", skipReason: "no_email", createdAt: newer },
  ] as any);

  const [reminder] = await db
    .insert(documentTemplatesTable)
    .values({
      key: `__test_email_activity_reminder_${stamp}`,
      name: `EA Blowout Reminder ${stamp}`,
      kind: "notice",
      category: "client",
      subject: "Time to blow the lines out",
      body: "Call us to book your blow out.",
      isSeeded: false,
    })
    .returning();
  reminderTemplate = reminder;
  ids.templates.push(reminder.id);

  const fortnightAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  await db.insert(emailSendsTable).values([
    { clientId: sarah.id, templateId: reminder.id, sentById: admin.id, source: "dispatch", batchId: REMINDER_BATCH, toEmail: "koby@radiantaisoftware.com", subject: "Time to blow the lines out", status: "sent", openToken: `tok_rem_a_${stamp}`, sentAt: fortnightAgo, createdAt: fortnightAgo },
    { clientId: ridge.id, templateId: reminder.id, sentById: admin.id, source: "dispatch", batchId: REMINDER_BATCH, toEmail: "kobystull123@gmail.com", subject: "Time to blow the lines out", status: "sent", openToken: `tok_rem_b_${stamp}`, sentAt: fortnightAgo, createdAt: fortnightAgo },
  ] as any);
});

after(async () => {
  if (ids.clients.length) {
    await db.delete(emailSendsTable).where(inArray(emailSendsTable.clientId, ids.clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  if (ids.rules.length) await db.delete(automationRulesTable).where(inArray(automationRulesTable.id, ids.rules));
  if (ids.templates.length) await db.delete(documentTemplatesTable).where(inArray(documentTemplatesTable.id, ids.templates));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

test("the screen is for the office, and only for someone allowed into documents", async () => {
  for (const path of [`/email-activity/batches`, `/email-activity/summary`, `/email-activity/batches/${BOARD_BATCH}`, `/email-activity/batches/${BOARD_BATCH}/overview`]) {
    assert.equal((await api(path, null)).status, 401, `${path} needs a session`);
    assert.equal((await api(path, contractor.id)).status, 403, `${path} is not for a phone-only sub`);
    const denied = await api(path, noDocuments.id);
    assert.equal(denied.status, 403, `${path} refuses an office user without documents`);
    assert.match(denied.body.error, /Documents is not turned on/);
  }
});

test("every batch is listed newest first with his counts, and a send with no batch is not one", async () => {
  const res = await api("/email-activity/batches?limit=500", admin.id);
  assert.equal(res.status, 200);
  const rows: any[] = res.body;

  const board = rows.find((r) => r.batchId === BOARD_BATCH);
  const auto = rows.find((r) => r.batchId === AUTO_BATCH);
  assert.ok(board && auto, "both of our batches are listed");

  assert.equal(board.total, 4);
  assert.equal(board.sent, 2);
  assert.equal(board.failed, 1);
  assert.equal(board.skipped, 1);
  assert.equal(board.opened, 0, "nobody has loaded the pictures yet");
  assert.equal(board.source, "dispatch");
  assert.equal(board.sourceLabel, "Dispatch board");
  assert.equal(board.templateName, template.name);
  assert.equal(board.sentByName, "Email Activity Admin");
  assert.equal(board.ruleName, null);

  assert.equal(auto.sourceLabel, "Automation");
  assert.match(auto.ruleName, /EA Past Due/, "an automation's run says which rule sent it");
  assert.equal(auto.sentByName, null, "nobody pressed send on an automation");

  assert.ok(
    rows.indexOf(auto) < rows.indexOf(board),
    "the newer batch comes first",
  );

  // The one-off bill is not a batch, so it is not in this list by default.
  assert.ok(rows.every((r) => r.batchId != null && !r.single));
  assert.ok(!rows.some((r) => r.batchId === `one:${soloId}`));
});

test("an email sent to one customer on their own is one tick away, and opens like any other", async () => {
  const withSingles = await api("/email-activity/batches?includeSingles=true&limit=500", admin.id);
  assert.equal(withSingles.status, 200);
  const solo = withSingles.body.find((r: any) => r.batchId === `one:${soloId}`);
  assert.ok(solo, "the one-off bill is listed once he asks for it");
  assert.equal(solo.single, true);
  assert.equal(solo.total, 1);
  assert.equal(solo.sent, 1);
  assert.equal(solo.sourceLabel, "Invoice");
  assert.equal(solo.subject, "Your bill");

  // A batch is still a batch with the box ticked, and never a line per person.
  const board = withSingles.body.find((r: any) => r.batchId === BOARD_BATCH);
  assert.equal(board.total, 4);
  assert.equal(board.single, false);

  // Its own results page works the same way, so the name on it still walks
  // through to the account.
  const overview = await api(`/email-activity/batches/one:${soloId}/overview`, admin.id);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.total, 1);
  const rows = await api(`/email-activity/batches/one:${soloId}`, admin.id);
  assert.equal(rows.body.length, 1, "one email is one line, not every send to that customer");
  assert.equal(rows.body[0].clientId, sarah.id);
  assert.equal(rows.body[0].id, soloId);

  // A made-up key is a missing send, not a crash.
  for (const key of ["one:0", "one:999999999999", `one:not-a-number`]) {
    assert.equal((await api(`/email-activity/batches/${encodeURIComponent(key)}/overview`, admin.id)).status, 404, key);
    assert.equal((await api(`/email-activity/batches/${encodeURIComponent(key)}`, admin.id)).status, 404, key);
  }
});

test("he can narrow the list by where it was sent from and by the name of the document", async () => {
  const fromAutomation = await api("/email-activity/batches?source=automation&limit=500", admin.id);
  const autoIds = fromAutomation.body.map((r: any) => r.batchId);
  assert.ok(autoIds.includes(AUTO_BATCH));
  assert.ok(!autoIds.includes(BOARD_BATCH), "a board send is not an automation");
  assert.ok(fromAutomation.body.every((r: any) => r.source === "automation"));

  const byDocument = await api(`/email-activity/batches?q=${encodeURIComponent(`Blow Out ${stamp}`)}&limit=500`, admin.id);
  const docIds = byDocument.body.map((r: any) => r.batchId);
  assert.ok(docIds.includes(BOARD_BATCH));
  assert.ok(docIds.includes(AUTO_BATCH), "both batches used that document");

  const byRule = await api(`/email-activity/batches?q=${encodeURIComponent(`EA Past Due ${stamp}`)}&limit=500`, admin.id);
  assert.deepEqual(byRule.body.map((r: any) => r.batchId), [AUTO_BATCH], "searching an automation's name finds its run");

  const nothing = await api(`/email-activity/batches?q=zzz_not_a_document_${stamp}`, admin.id);
  assert.deepEqual(nothing.body, []);

  const one = await api("/email-activity/batches?limit=1", admin.id);
  assert.equal(one.body.length, 1, "the limit is honoured");

  const tooMany = await api("/email-activity/batches?limit=99999", admin.id);
  assert.equal(tooMany.status, 200, "a silly limit is clamped, not refused");
});

test("opening a batch gives him the customers with their address, the time it went and whether they opened it", async () => {
  const res = await api(`/email-activity/batches/${BOARD_BATCH}`, admin.id);
  assert.equal(res.status, 200);
  const rows: any[] = res.body;
  assert.equal(rows.length, 4);

  const sarahRow = rows.find((r) => r.clientId === sarah.id);
  assert.equal(sarahRow.clientName, sarah.name);
  assert.equal(sarahRow.clientAddress, "12 Elm St, Post Falls, ID 83854");
  assert.equal(sarahRow.clientPhone, "208-555-0101");
  assert.equal(sarahRow.status, "sent");
  assert.ok(sarahRow.sentAt, "the time it went out is on the row");
  assert.equal(sarahRow.openedAt, null);
  assert.equal(sarahRow.openCount, 0);

  // Town and state with no street line still reads as something he can place.
  const ridgeRow = rows.find((r) => r.clientId === ridge.id);
  assert.equal(ridgeRow.clientAddress, "Hayden, ID");
  assert.equal(ridgeRow.clientPhone, null);

  const otisRow = rows.find((r) => r.clientId === otis.id);
  assert.equal(otisRow.status, "failed");
  assert.equal(otisRow.error, "mailbox full");

  const nancyRow = rows.find((r) => r.clientId === nancy.id);
  assert.equal(nancyRow.status, "skipped");
  assert.equal(nancyRow.skipReason, "no_email");
  assert.equal(nancyRow.toEmail, null);
  assert.equal(nancyRow.clientAddress, "9 Larch Ln", "no town on file is not an empty line");

  // Every name on the list is a way into the account.
  assert.ok(rows.every((r) => typeof r.clientId === "number"));

  const missing = await api(`/email-activity/batches/nope_${stamp}`, admin.id);
  assert.equal(missing.status, 404);
});

test("a batch's own results page can be opened on its own", async () => {
  const res = await api(`/email-activity/batches/${BOARD_BATCH}/overview`, admin.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.batchId, BOARD_BATCH);
  assert.equal(res.body.total, 4);
  assert.equal(res.body.sent, 2);
  assert.equal(res.body.sourceLabel, "Dispatch board");
  assert.equal(res.body.templateName, template.name);

  const list = await api("/email-activity/batches?limit=500", admin.id);
  const fromList = list.body.find((r: any) => r.batchId === BOARD_BATCH);
  assert.deepEqual(res.body, fromList, "the page on its own says exactly what the list says");

  const missing = await api(`/email-activity/batches/nope_${stamp}/overview`, admin.id);
  assert.equal(missing.status, 404);
});

test("an open only counts for an email that actually went out, and keeps the first time", async () => {
  process.env.APP_PUBLIC_URL = "https://crm.example.test";

  await fetch(`${baseUrl}/api/public/email-open/${SENT_TOKEN}.gif`);
  await fetch(`${baseUrl}/api/public/email-open/${SENT_TOKEN}.gif`);
  // The pixel answers the mail client first and writes afterwards.
  await new Promise((r) => setTimeout(r, 300));

  const [row] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.openToken, SENT_TOKEN));
  assert.ok(row?.openedAt, "the first open is stamped");
  assert.equal(row?.openCount, 2, "a second look counts up");
  const firstOpen = row!.openedAt!.getTime();

  await fetch(`${baseUrl}/api/public/email-open/${SENT_TOKEN}.gif`);
  await new Promise((r) => setTimeout(r, 300));
  const [again] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.openToken, SENT_TOKEN));
  assert.equal(again!.openedAt!.getTime(), firstOpen, "the time shown stays the time they first opened it");

  // A failed send never reached anyone, so its pixel must not invent an open.
  await fetch(`${baseUrl}/api/public/email-open/${FAILED_TOKEN}.gif`);
  await new Promise((r) => setTimeout(r, 300));
  const [failed] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.openToken, FAILED_TOKEN));
  assert.equal(failed?.openedAt, null);
  assert.equal(failed?.openCount, 0);

  // And an unknown token is still a picture, not a broken image in an inbox.
  const unknown = await fetch(`${baseUrl}/api/public/email-open/not-a-real-token-${stamp}.gif`);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.headers.get("content-type"), "image/gif");

  // Now the counts he reads off the screen move with it.
  const board = (await api(`/email-activity/batches/${BOARD_BATCH}/overview`, admin.id)).body;
  assert.equal(board.opened, 1, "one of the two that went out has been opened");
  const rows = (await api(`/email-activity/batches/${BOARD_BATCH}`, admin.id)).body;
  const sarahRow = rows.find((r: any) => r.clientId === sarah.id);
  assert.ok(sarahRow.openedAt);
  assert.equal(sarahRow.openCount, 3);
});

test("the totals across the top count a window of days, not all of history", async () => {
  const month = (await api("/email-activity/summary?days=30", admin.id)).body;
  const everything = (await api("/email-activity/summary?days=3650", admin.id)).body;
  assert.equal(month.days, 30);
  assert.equal(everything.days, 3650);
  assert.ok(month.total >= 6, "our batches and the one-off bill are inside the last 30 days");
  assert.ok(month.opened >= 1);
  // The tiles count every email that went out, and say how many of them were
  // one at a time, because 21 of 30 means nothing if it quietly left the bills out.
  assert.ok(month.singles >= 1, "a bill sent on its own still counts in the totals");

  // Something from last season. It belongs in "everything" and not in the month.
  const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  await db
    .insert(emailSendsTable)
    .values({ clientId: sarah.id, source: "letter", batchId: OLD_BATCH, toEmail: "koby@radiantaisoftware.com", status: "sent", sentAt: longAgo, createdAt: longAgo } as any);

  const monthAfter = (await api("/email-activity/summary?days=30", admin.id)).body;
  const everythingAfter = (await api("/email-activity/summary?days=3650", admin.id)).body;
  assert.ok(everythingAfter.total >= monthAfter.total + 1, "last season's letter is only in the long view");
  assert.ok(everythingAfter.batches >= monthAfter.batches + 1);

  // The list itself is not windowed — he can still search an old send.
  const list = await api("/email-activity/batches?limit=500", admin.id);
  assert.ok(list.body.some((r: any) => r.batchId === OLD_BATCH), "the old batch is still findable");

  // A silly window is clamped rather than refused.
  assert.equal((await api("/email-activity/summary?days=0", admin.id)).body.days, 30);
  assert.equal((await api("/email-activity/summary?days=99999", admin.id)).body.days, 3650);
});

test("an email that went out with no pixel in it is left out of the open rate", async () => {
  const list = (await api("/email-activity/batches?limit=500", admin.id)).body as any[];

  // Every crew notice goes out without a pixel, so there is nothing for the
  // percent to be out of — it must not read as nobody opening anything.
  const crew = list.find((r) => r.batchId === CREW_BATCH_A);
  assert.ok(crew, "the crew notice is still listed");
  assert.equal(crew.sent, 1, "it did go out");
  assert.equal(crew.trackable, 0, "but we never asked whether it was read");
  assert.equal(crew.opened, 0);

  // The letter went out with a pixel on every copy, so both count.
  const board = list.find((r) => r.batchId === BOARD_BATCH);
  assert.equal(board.sent, 2);
  assert.equal(board.trackable, 2, "both of the two that went out carried a pixel");
  const reminder = list.find((r) => r.batchId === REMINDER_BATCH);
  assert.equal(reminder.trackable, 2);

  // A bill we had to leave out never reached anybody, so it is not one we can
  // ask about either.
  const bills = list.find((r) => r.batchId === INVOICE_BATCH);
  assert.equal(bills.trackable, 2, "the two bills that went, not the one left out");

  // The tiles across the top do the same sum. His two crew notices are in
  // `sent` and out of `trackable`, which is what the Opened percent is over.
  const month = (await api("/email-activity/summary?days=30", admin.id)).body;
  assert.ok(month.sent >= month.trackable + 2, "the crew notices are sent but not askable");
  assert.ok(month.opened <= month.trackable, "we can never have more opens than asks");

  // And on the results list, a row with no pixel is flagged so the screen can
  // stop printing "not opened yet" about a customer nobody ever asked.
  const crewRows = (await api(`/email-activity/batches/${encodeURIComponent(CREW_BATCH_A)}`, admin.id)).body as any[];
  assert.equal(crewRows.length, 1);
  assert.equal(crewRows[0].status, "sent");
  assert.equal(crewRows[0].trackable, false, "no read receipt on this one");

  const boardRows = (await api(`/email-activity/batches/${BOARD_BATCH}`, admin.id)).body as any[];
  assert.equal(boardRows.find((r) => r.clientId === sarah.id).trackable, true);
  assert.equal(boardRows.find((r) => r.clientId === otis.id).trackable, false, "a failed send is not one we asked about");
  assert.equal(boardRows.find((r) => r.clientId === nancy.id).trackable, false, "nor is one we left out");
});

test("one press of Email all is one line, even when somebody had no address", async () => {
  const list = (await api("/email-activity/batches?limit=500", admin.id)).body as any[];

  const lines = list.filter((r) => r.batchId === INVOICE_BATCH);
  assert.equal(lines.length, 1, "one run is one line, not one line per document");
  assert.equal(lines[0].total, 3);
  assert.equal(lines[0].sent, 2);
  assert.equal(lines[0].skipped, 1);
  assert.equal(lines[0].templateName, template.name, "the bill it sent, read off the rows that went");
  assert.equal(lines[0].sentByName, "Email Activity Admin");

  // No line on this screen may ever share its link with another line.
  const keys = list.map((r) => r.batchId);
  assert.equal(new Set(keys).size, keys.length, "every line has its own key");

  // The header of the results page has to agree with the list underneath it:
  // it used to say "2 of 2 sent" above three people with one left out.
  const overview = (await api(`/email-activity/batches/${INVOICE_BATCH}/overview`, admin.id)).body;
  assert.equal(overview.total, 3);
  assert.equal(overview.sent, 2);
  assert.equal(overview.skipped, 1);
  assert.deepEqual(overview, lines[0], "the page on its own says exactly what the list says");
  const rows = (await api(`/email-activity/batches/${INVOICE_BATCH}`, admin.id)).body as any[];
  assert.equal(rows.length, overview.total, "the header counts the same people the list shows");
});

test("the search finds an older send even when newer ones fill the page", async () => {
  // Five batches went out after the reminder letter, so a short page cannot
  // reach it. This is the crew notices burying a letter, in miniature.
  const short = (await api("/email-activity/batches?limit=3", admin.id)).body as any[];
  assert.equal(short.length, 3, "the limit is honoured");
  assert.ok(!short.some((r) => r.batchId === REMINDER_BATCH), "the letter is past the end of the page");

  // Searching for it finds it anyway — the box at the top of the page says it
  // will, so the search has to run before the page is cut off.
  const found = (await api(`/email-activity/batches?limit=3&q=${encodeURIComponent(`Blowout Reminder ${stamp}`)}`, admin.id)).body as any[];
  assert.deepEqual(found.map((r) => r.batchId), [REMINDER_BATCH]);
  assert.equal(found[0].templateName, reminderTemplate.name);
  assert.equal(found[0].total, 2);
  assert.equal(found[0].sent, 2);

  // The same for who pressed send, which is also stitched on after the grouping.
  const bySender = (await api(`/email-activity/batches?limit=3&q=${encodeURIComponent("Email Activity Admin")}`, admin.id)).body as any[];
  assert.ok(bySender.some((r) => r.batchId === BOARD_BATCH), "a search by sender reaches past the page too");

  // And the words on the screen: "Crew on the way" is our label, not anything
  // in the database, so it has to come back as the crew's notices.
  const byLabel = (await api(`/email-activity/batches?limit=500&q=${encodeURIComponent("crew on the way")}`, admin.id)).body as any[];
  const labelled = byLabel.map((r) => r.batchId);
  assert.ok(labelled.includes(CREW_BATCH_A) && labelled.includes(CREW_BATCH_B));
  assert.ok(byLabel.every((r) => r.source === "crew"));

  // A percent sign typed in the box is a percent sign, not "match everything".
  const literal = (await api(`/email-activity/batches?limit=500&q=${encodeURIComponent(`zz%zz_${stamp}`)}`, admin.id)).body as any[];
  assert.deepEqual(literal, [], "a wildcard typed by hand is searched for, not obeyed");
});

test("a one: key never answers for an email that belongs to a batch", async () => {
  // Hand-typed into the address bar off a bookmark. It used to draw the
  // letter's own name and then claim "1 of 1 sent" for a send that went to
  // everybody on the board.
  const inBatch = boardRowIds[0];
  assert.ok(inBatch, "we have a row id from inside the board batch");
  assert.equal((await api(`/email-activity/batches/one:${inBatch}/overview`, admin.id)).status, 404);
  assert.equal((await api(`/email-activity/batches/one:${inBatch}`, admin.id)).status, 404);

  // The real one-on-its-own still answers, so the fix did not shut the door
  // on "did Jackie get her bill?".
  const solo = await api(`/email-activity/batches/one:${soloId}/overview`, admin.id);
  assert.equal(solo.status, 200);
  assert.equal(solo.body.total, 1);
  assert.equal(solo.body.single, true);
});
