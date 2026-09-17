import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  jobsTable,
  servicesTable,
  auditEventsTable,
  documentTemplatesTable,
  emailSendsTable,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

// The bulk actions bar on the dispatch board and the waiting list, the filters
// both screens share, the cancelled status, and "Email selected" from the
// board. Same harness as integration.test.ts: NODE_ENV=test plus a per-process
// token opens the x-test-user-id bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { setDocumentSendGmailProxyForTests } = await import("../src/lib/documentSend.ts");

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[], services: [] as number[], templates: [] as number[] };

// The batch line a bulk action writes belongs to no customer ("Moved 2 jobs to
// …"), so deleting the test's clients cannot take it with them. Stamping the
// actor gives `after` something to delete by, instead of leaving a dozen
// orphaned rows in the activity feed on the database with his 709 customers.
const ADMIN_NAME = `Dispatch Admin ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let admin: { id: number };
let contractor: { id: number };
let clientA: { id: number }; // Post Falls, Idaho, tagged, has email
let clientB: { id: number }; // Washington branch, no email
let service: { id: number };

const TODAY = new Date().toISOString().slice(0, 10);
const shift = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const TOMORROW = shift(1);
const NEXT_WEEK = shift(7);
const LAST_WEEK = shift(-7);
const LAST_MONTH = shift(-30);

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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = (path: string, userId: number, data: unknown) =>
  api(path, userId, { method: "POST", body: JSON.stringify(data) });

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const [a, c] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_da_admin_${stamp}`, name: ADMIN_NAME, role: "admin", roleSource: "owner_assigned" },
      // The account name is an email on purpose: the board must show the
      // display name, never this.
      {
        clerkId: `test_da_contractor_${stamp}`,
        name: "mick@example.com",
        displayName: "Mick",
        role: "contractor",
      },
    ])
    .returning();
  admin = a;
  contractor = c;
  ids.users.push(a.id, c.id);

  const [ca, cb] = await db
    .insert(clientsTable)
    .values([
      {
        name: `Bulk Client A ${stamp}`,
        status: "client",
        serviceAddress: "10 Elm St",
        city: "Post Falls",
        state: "ID",
        mapCode: "PF",
        tags: ["backflow"],
        email: "koby@radiantaisoftware.com",
        lat: 47.71,
        lng: -116.95,
      },
      {
        name: `Bulk Client B ${stamp}`,
        status: "client",
        serviceAddress: "20 Oak St",
        city: "Spokane",
        state: "WA",
        mapCode: "SPK",
        tags: [],
        email: null,
      },
    ])
    .returning();
  clientA = ca;
  clientB = cb;
  ids.clients.push(ca.id, cb.id);

  const [svc] = await db
    .insert(servicesTable)
    .values({ name: `Bulk Blowout ${stamp}`, code: "BA7" })
    .returning();
  service = svc;
  ids.services.push(svc.id);
});

after(async () => {
  setDocumentSendGmailProxyForTests(null);
  if (ids.clients.length) {
    await db.delete(emailSendsTable).where(inArray(emailSendsTable.clientId, ids.clients));
    await db.delete(auditEventsTable).where(inArray(auditEventsTable.clientId, ids.clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  // The batch lines (`jobs_bulk_*` from /jobs/bulk-action and /jobs/bulk-assign)
  // carry no clientId, so nothing above reaches them. They go by actor.
  await db.delete(auditEventsTable).where(eq(auditEventsTable.actorName, ADMIN_NAME));
  // Runs before the name was stamped left their rows behind; sweep those too so
  // the dashboard activity feed is not a list of this file's test batches.
  await db
    .delete(auditEventsTable)
    .where(and(eq(auditEventsTable.actorName, "Dispatch Admin"), isNull(auditEventsTable.clientId)));
  if (ids.templates.length) await db.delete(documentTemplatesTable).where(inArray(documentTemplatesTable.id, ids.templates));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

/**
 * Captures every MIME message instead of handing it to Gmail, the same stub
 * test/documentSend.test.ts uses, so "42 of 44 sent" can be counted here
 * without a mailbox.
 */
function capturingProxy() {
  const seen: { to: string; raw: string }[] = [];
  const proxy = async (_connector: string, _path: string, init: { body: string }) => {
    const raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString();
    const to = /^To: (.+)$/m.exec(raw)?.[1] ?? "";
    seen.push({ to, raw });
    return new Response(JSON.stringify({ id: `gmail-${seen.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, proxy: proxy as unknown as Parameters<typeof setDocumentSendGmailProxyForTests>[0] };
}

async function createJob(overrides: Partial<typeof jobsTable.$inferInsert> = {}) {
  const [job] = await db
    .insert(jobsTable)
    .values({
      clientId: clientA.id,
      serviceId: service.id,
      amount: 50,
      dispatched: true,
      scheduledDate: TODAY,
      ...overrides,
    })
    .returning();
  return job;
}

async function readJob(id: number) {
  const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, id));
  return row ?? null;
}

test("bulk actions are for the office only", async () => {
  const job = await createJob();
  const res = await post("/jobs/bulk-action", contractor.id, { jobIds: [job.id], action: "cancel" });
  assert.equal(res.status, 403);
  assert.equal((await readJob(job.id))!.status, "scheduled");
});

test("an empty selection and a move with no date are refused", async () => {
  const empty = await post("/jobs/bulk-action", admin.id, { jobIds: [], action: "cancel" });
  assert.equal(empty.status, 400);
  const job = await createJob();
  const noDate = await post("/jobs/bulk-action", admin.id, { jobIds: [job.id], action: "move" });
  assert.equal(noDate.status, 400);
  assert.match(noDate.body.error, /date/i);
});

test("move changes the date on the whole selection and leaves completed jobs alone", async () => {
  const a = await createJob();
  const b = await createJob();
  const done = await createJob({ status: "completed" });
  const res = await post("/jobs/bulk-action", admin.id, {
    jobIds: [a.id, b.id, done.id],
    action: "move",
    scheduledDate: TOMORROW,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 2);
  assert.deepEqual(res.body.skippedIds, [done.id]);
  assert.equal((await readJob(a.id))!.scheduledDate, TOMORROW);
  assert.equal((await readJob(b.id))!.scheduledDate, TOMORROW);
  assert.equal((await readJob(done.id))!.scheduledDate, TODAY);
});

test("assign puts a contractor on the selection and the board shows the display name, not the email", async () => {
  const a = await createJob({ scheduledDate: NEXT_WEEK });
  const res = await post("/jobs/bulk-action", admin.id, {
    jobIds: [a.id],
    action: "assign",
    assignedToId: contractor.id,
  });
  assert.equal(res.status, 200);
  const board = await api(`/jobs?date=${NEXT_WEEK}&assignedTo=${contractor.id}`, admin.id);
  const row = board.body.find((j: any) => j.id === a.id);
  assert.ok(row, "assigned job is on the board");
  assert.equal(row.assignedToName, "Mick");
  assert.equal(row.serviceCode, "BA7");
  assert.equal(row.clientEmail, "koby@radiantaisoftware.com");
  assert.equal(row.clientMapCode, "PF");
  assert.equal(row.clientState, "ID");
  assert.deepEqual(row.clientTags, ["backflow"]);

  const unassign = await post("/jobs/bulk-action", admin.id, { jobIds: [a.id], action: "assign", assignedToId: null });
  assert.equal(unassign.status, 200);
  assert.equal((await readJob(a.id))!.assignedToId, null);

  const missing = await post("/jobs/bulk-action", admin.id, { jobIds: [a.id], action: "assign" });
  assert.equal(missing.status, 400);
});

test("dispatch takes waiting-list jobs onto the board for a date and contractor", async () => {
  const waiting = await createJob({ dispatched: false, scheduledDate: null, windowStart: LAST_WEEK, windowEnd: NEXT_WEEK });
  const before = await api(`/waiting-list?date=${TODAY}`, admin.id);
  assert.ok(before.body.some((j: any) => j.id === waiting.id), "in the window today");

  const res = await post("/jobs/bulk-action", admin.id, {
    jobIds: [waiting.id],
    action: "dispatch",
    scheduledDate: TOMORROW,
    assignedToId: contractor.id,
  });
  assert.equal(res.status, 200);
  const row = (await readJob(waiting.id))!;
  assert.equal(row.dispatched, true);
  assert.equal(row.scheduledDate, TOMORROW);
  assert.equal(row.assignedToId, contractor.id);

  const after = await api(`/waiting-list?date=${TODAY}`, admin.id);
  assert.ok(!after.body.some((j: any) => j.id === waiting.id), "gone from the waiting list");
});

test("waiting_list sends a job back with no date, no route number and a clean status", async () => {
  const job = await createJob({
    routeOrder: 3,
    status: "skipped",
    skipReason: "gate locked",
    skippedAt: new Date(),
    windowStart: LAST_WEEK,
    windowEnd: NEXT_WEEK,
  });
  const res = await post("/jobs/bulk-action", admin.id, { jobIds: [job.id], action: "waiting_list" });
  assert.equal(res.status, 200);
  const row = (await readJob(job.id))!;
  assert.equal(row.dispatched, false);
  assert.equal(row.scheduledDate, null);
  assert.equal(row.routeOrder, null);
  assert.equal(row.status, "scheduled");
  assert.equal(row.skipReason, null);
  const list = await api(`/waiting-list?date=${TODAY}`, admin.id);
  assert.ok(list.body.some((j: any) => j.id === job.id), "back on the waiting list");
});

test("cancel is terminal, audited on the customer, and blocks completion", async () => {
  const job = await createJob();
  const done = await createJob({ status: "completed" });
  const res = await post("/jobs/bulk-action", admin.id, {
    jobIds: [job.id, done.id],
    action: "cancel",
    reason: "customer moved",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1);
  assert.deepEqual(res.body.skippedIds, [done.id]);
  const row = (await readJob(job.id))!;
  assert.equal(row.status, "cancelled");
  assert.equal(row.cancelReason, "customer moved");
  assert.ok(row.cancelledAt);

  const audit = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, clientA.id), eq(auditEventsTable.action, "job_cancelled")));
  assert.ok(audit.some((e) => e.description.includes(`#${job.id}`) && e.description.includes("customer moved")));

  const complete = await post(`/jobs/${job.id}/complete`, admin.id, {});
  assert.equal(complete.status, 400);
  assert.match(complete.body.error, /cancelled/);

  // Cancelled jobs are listed only when asked for.
  const board = await api(`/jobs?date=${TODAY}&status=cancelled`, admin.id);
  assert.ok(board.body.some((j: any) => j.id === job.id));

  // Cancelling twice changes nothing and is reported as left alone.
  const again = await post("/jobs/bulk-action", admin.id, { jobIds: [job.id], action: "cancel" });
  assert.equal(again.body.updated, 0);
  assert.deepEqual(again.body.skippedIds, [job.id]);
});

test("a contractor cannot cancel and never sees a cancelled job on their phone", async () => {
  const mine = await createJob({ assignedToId: contractor.id, scheduledDate: NEXT_WEEK });
  const patch = await api(`/jobs/${mine.id}`, contractor.id, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" }),
  });
  assert.equal(patch.status, 403);

  const office = await api(`/jobs/${mine.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled", cancelReason: "rained out for the season" }),
  });
  assert.equal(office.status, 200);
  assert.equal(office.body.status, "cancelled");
  assert.ok(office.body.cancelledAt);

  const phone = await api(`/my/jobs?date=${NEXT_WEEK}`, contractor.id);
  assert.ok(!phone.body.some((j: any) => j.id === mine.id));

  // Putting it back on the board clears the reason.
  const back = await api(`/jobs/${mine.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ status: "scheduled" }),
  });
  assert.equal(back.body.cancelReason, null);
  assert.equal(back.body.cancelledAt, null);
});

test("skip runs the free-skip rule per job and reports the verdicts", async () => {
  // A fresh customer so nothing else this year counts against them.
  const [fresh] = await db
    .insert(clientsTable)
    .values({ name: `Skip Client ${Date.now()}`, status: "client" })
    .returning();
  ids.clients.push(fresh.id);
  const first = await createJob({ clientId: fresh.id });
  const second = await createJob({ clientId: fresh.id });
  const already = await createJob({ clientId: fresh.id, status: "skipped", skippedAt: new Date(LAST_MONTH) });

  const res = await post("/jobs/bulk-action", admin.id, {
    jobIds: [first.id, second.id, already.id],
    action: "skip",
    reason: "too wet",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 2);
  assert.deepEqual(res.body.skippedIds, [already.id]);
  assert.equal(res.body.skipNotices.length, 2);
  const rows = [await readJob(first.id), await readJob(second.id)];
  assert.ok(rows.every((r) => r!.status === "skipped" && r!.skipReason === "too wet"));
  // The earlier skip already used the free one, so both of these are chargeable.
  assert.ok(rows.every((r) => r!.skipBillable === true));
});

test("delete removes the selection but never an invoiced job", async () => {
  const gone = await createJob();
  const done = await createJob({ status: "completed" });
  const res = await post("/jobs/bulk-action", admin.id, { jobIds: [gone.id, done.id], action: "delete" });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1);
  assert.equal(await readJob(gone.id), null);
  assert.ok(await readJob(done.id));
});

test("add_note appends to what is there and can flag it important", async () => {
  const plain = await createJob({ notes: "Gate on the left" });
  const empty = await createJob();
  const res = await post("/jobs/bulk-action", admin.id, {
    jobIds: [plain.id, empty.id],
    action: "add_note",
    note: "NO EMAIL - call or text",
    notesImportant: true,
  });
  assert.equal(res.status, 200);
  assert.equal((await readJob(plain.id))!.notes, "Gate on the left\nNO EMAIL - call or text");
  assert.equal((await readJob(empty.id))!.notes, "NO EMAIL - call or text");
  assert.equal((await readJob(empty.id))!.notesImportant, true);

  const blank = await post("/jobs/bulk-action", admin.id, { jobIds: [plain.id], action: "add_note", note: "  " });
  assert.equal(blank.status, 400);
});

test("set route order: clear the numbers, then number the stops in click order", async () => {
  const a = await createJob({ routeOrder: 5, scheduledDate: NEXT_WEEK });
  const b = await createJob({ routeOrder: 6, scheduledDate: NEXT_WEEK });
  const c = await createJob({ routeOrder: 7, scheduledDate: NEXT_WEEK });

  const both = await post("/jobs/bulk-assign", admin.id, { jobIds: [a.id], clearRouteOrder: true, routeOrderFrom: 1 });
  assert.equal(both.status, 400);

  const clear = await post("/jobs/bulk-assign", admin.id, { jobIds: [a.id, b.id, c.id], clearRouteOrder: true });
  assert.equal(clear.status, 200);
  assert.equal((await readJob(a.id))!.routeOrder, null);
  assert.equal((await readJob(c.id))!.routeOrder, null);

  const number = await post("/jobs/bulk-assign", admin.id, { jobIds: [c.id, a.id, b.id], routeOrderFrom: 1 });
  assert.equal(number.status, 200);
  assert.equal((await readJob(c.id))!.routeOrder, 1);
  assert.equal((await readJob(a.id))!.routeOrder, 2);
  assert.equal((await readJob(b.id))!.routeOrder, 3);

  const board = await api(`/jobs?from=${NEXT_WEEK}&to=${NEXT_WEEK}`, admin.id);
  const order = board.body.filter((j: any) => [a.id, b.id, c.id].includes(j.id)).map((j: any) => j.id);
  assert.deepEqual(order, [c.id, a.id, b.id]);
});

test("board filters: branch, map code, tag, has-notes, search, and a date range in day order", async () => {
  const day = shift(14);
  const day2 = shift(15);
  const idaho = await createJob({ scheduledDate: day2, notes: "Dog in yard", routeOrder: 1 });
  const wash = await createJob({ clientId: clientB.id, scheduledDate: day, routeOrder: 9 });

  const byBranch = await api(`/jobs?from=${day}&to=${day2}&branch=wa`, admin.id);
  assert.deepEqual(byBranch.body.map((j: any) => j.id), [wash.id]);

  const byMap = await api(`/jobs?from=${day}&to=${day2}&mapCode=pf`, admin.id);
  assert.deepEqual(byMap.body.map((j: any) => j.id), [idaho.id]);

  const byTag = await api(`/jobs?from=${day}&to=${day2}&tag=Backflow`, admin.id);
  assert.deepEqual(byTag.body.map((j: any) => j.id), [idaho.id]);

  const noted = await api(`/jobs?from=${day}&to=${day2}&hasNotes=true`, admin.id);
  assert.deepEqual(noted.body.map((j: any) => j.id), [idaho.id]);

  const searched = await api(`/jobs?from=${day}&to=${day2}&search=oak%20st`, admin.id);
  assert.deepEqual(searched.body.map((j: any) => j.id), [wash.id]);

  const byCity = await api(`/jobs?from=${day}&to=${day2}&city=spokane`, admin.id);
  assert.deepEqual(byCity.body.map((j: any) => j.id), [wash.id]);

  // Range: the earlier day comes first even though its route number is higher.
  const range = await api(`/jobs?from=${day}&to=${day2}`, admin.id);
  const seen = range.body.filter((j: any) => [idaho.id, wash.id].includes(j.id)).map((j: any) => j.id);
  assert.deepEqual(seen, [wash.id, idaho.id]);
});

test("waiting list: only inside the window, past windows on request, cancelled hidden unless asked", async () => {
  const open = await createJob({ dispatched: false, scheduledDate: null, windowStart: LAST_WEEK, windowEnd: NEXT_WEEK });
  const future = await createJob({ dispatched: false, scheduledDate: null, windowStart: NEXT_WEEK, windowEnd: shift(30) });
  const expired = await createJob({ dispatched: false, scheduledDate: null, windowStart: LAST_MONTH, windowEnd: LAST_WEEK });
  const cancelled = await createJob({
    dispatched: false,
    scheduledDate: null,
    windowStart: LAST_WEEK,
    windowEnd: NEXT_WEEK,
    status: "cancelled",
  });
  const other = await createJob({
    dispatched: false,
    scheduledDate: null,
    clientId: clientB.id,
    serviceId: null,
    windowStart: LAST_WEEK,
    windowEnd: NEXT_WEEK,
    assignedToId: contractor.id,
  });

  const today = await api(`/waiting-list?date=${TODAY}`, admin.id);
  const todayIds = today.body.map((j: any) => j.id);
  assert.ok(todayIds.includes(open.id));
  assert.ok(todayIds.includes(other.id));
  assert.ok(!todayIds.includes(future.id), "window not open yet");
  assert.ok(!todayIds.includes(expired.id), "window closed");
  assert.ok(!todayIds.includes(cancelled.id), "cancelled is not waiting");

  const past = await api(`/waiting-list?window=past`, admin.id);
  const pastIds = past.body.map((j: any) => j.id);
  assert.ok(pastIds.includes(expired.id));
  assert.ok(!pastIds.includes(open.id));

  const wasCancelled = await api(`/waiting-list?date=${TODAY}&status=cancelled`, admin.id);
  assert.ok(wasCancelled.body.some((j: any) => j.id === cancelled.id));

  const byService = await api(`/waiting-list?date=${TODAY}&serviceId=${service.id}`, admin.id);
  const svcIds = byService.body.map((j: any) => j.id);
  assert.ok(svcIds.includes(open.id));
  assert.ok(!svcIds.includes(other.id));

  const byContractor = await api(`/waiting-list?date=${TODAY}&assignedTo=${contractor.id}`, admin.id);
  assert.deepEqual(byContractor.body.map((j: any) => j.id), [other.id]);

  const byBranch = await api(`/waiting-list?date=${TODAY}&branch=WA`, admin.id);
  assert.deepEqual(byBranch.body.map((j: any) => j.id), [other.id]);

  const row = today.body.find((j: any) => j.id === other.id);
  assert.equal(row.assignedToName, "Mick");
  assert.equal(row.clientEmail, null);
  assert.equal(row.clientDoNotEmail, false);
  assert.equal(row.dispatched, false);

  // O2: the whole expired batch cancelled in one go.
  const cancelPast = await post("/jobs/bulk-action", admin.id, {
    jobIds: pastIds.filter((id: number) => id === expired.id),
    action: "cancel",
    reason: "window passed",
  });
  assert.equal(cancelPast.body.updated, 1);
  const afterCancel = await api(`/waiting-list?window=past`, admin.id);
  assert.ok(!afterCancel.body.some((j: any) => j.id === expired.id));
});

/** The html part, decoded, so the merged date can be asserted on. */
function htmlPartOf(raw: string): string {
  const parts = raw.split(/--bison_client_[a-f0-9]+/);
  const htmlPart = parts.find((p) => p.includes("text/html"));
  assert.ok(htmlPart, "message has an html part");
  const b64 = htmlPart.split("\r\n\r\n")[1]?.trim() ?? "";
  return Buffer.from(b64, "base64").toString();
}

test("email selected from the board: sent count, who has no email, and the NO EMAIL note on their jobs", async () => {
  const stamp = Date.now();
  const [tpl] = await db
    .insert(documentTemplatesTable)
    .values({
      key: `test-blowout-${stamp}`,
      name: `Blowout day ${stamp}`,
      kind: "notice",
      category: "client",
      subject: "Sprinkler blowout on [servicedate]",
      body: "Hi [clientfname], we blow out your sprinklers on [servicedate].",
    })
    .returning();
  ids.templates.push(tpl.id);
  const day = shift(20);
  const a = await createJob({ scheduledDate: day });
  const b = await createJob({ clientId: clientB.id, scheduledDate: day });

  const { seen, proxy } = capturingProxy();
  setDocumentSendGmailProxyForTests(proxy);
  try {
    const forbidden = await post(`/document-templates/${tpl.id}/send`, contractor.id, {
      clientIds: [clientA.id],
      source: "dispatch",
    });
    assert.equal(forbidden.status, 403);

    const res = await post(`/document-templates/${tpl.id}/send`, admin.id, {
      clientIds: [clientA.id, clientB.id],
      jobIds: [a.id, b.id],
      tokens: { servicedate: "October 3, 2026" },
      source: "dispatch",
    });
    assert.equal(res.status, 200);
    // "Sent 1 of 2 — 1 has no email": the count the office reads back.
    assert.equal(res.body.sent, 1);
    assert.equal(res.body.skipped.length, 1);
    assert.equal(res.body.skipped[0].clientId, clientB.id);
    assert.equal(res.body.skipped[0].reason, "no_email");
    assert.equal(seen.length, 1);
    assert.match(seen[0].to, /koby@radiantaisoftware\.com/);
    // The date he typed in the dialog wins over the job's own date.
    assert.match(htmlPartOf(seen[0].raw), /October 3, 2026/);
  } finally {
    setDocumentSendGmailProxyForTests(null);
  }

  // The follow-up the dialog offers: flag the ones to ring instead.
  const note = await post("/jobs/bulk-action", admin.id, {
    jobIds: [b.id],
    action: "add_note",
    note: "NO EMAIL - call or text instead",
    notesImportant: true,
  });
  assert.equal(note.body.updated, 1);
  const row = (await readJob(b.id))!;
  assert.equal(row.notes, "NO EMAIL - call or text instead");
  assert.equal(row.notesImportant, true);
});

test("the route builder never picks up a cancelled waiting-list job", async () => {
  const live = await createJob({ dispatched: false, scheduledDate: null, windowStart: LAST_WEEK, windowEnd: NEXT_WEEK });
  const dead = await createJob({
    dispatched: false,
    scheduledDate: null,
    windowStart: LAST_WEEK,
    windowEnd: NEXT_WEEK,
    status: "cancelled",
  });
  const res = await post("/waiting-list/build-route", admin.id, { scheduledDate: shift(3), serviceId: service.id, apply: false });
  assert.equal(res.status, 200);
  const picked = res.body.selected.map((s: { jobId: number }) => s.jobId);
  assert.ok(picked.includes(live.id));
  assert.ok(!picked.includes(dead.id));
});

test("a half-typed year is refused instead of parking the job in year 2", async () => {
  // Clicking into the year of a date box and typing "2" hands over
  // "0002-09-16", which is a well-formed date. Saved, the job is off every
  // board and every list forever, because the board asks for a date range.
  const job = await createJob();
  const patch = await api(`/jobs/${job.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ scheduledDate: "0002-09-16" }),
  });
  assert.equal(patch.status, 400);
  assert.match(patch.body.error, /date/i);
  assert.equal((await readJob(job.id))!.scheduledDate, TODAY);

  const moved = await post("/jobs/bulk-action", admin.id, {
    jobIds: [job.id],
    action: "move",
    scheduledDate: "0002-09-16",
  });
  assert.equal(moved.status, 400);
  assert.equal((await readJob(job.id))!.scheduledDate, TODAY);

  const route = await post("/waiting-list/build-route", admin.id, { scheduledDate: "0002-09-16", apply: false });
  assert.equal(route.status, 400);

  // A real date still goes through.
  const good = await api(`/jobs/${job.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ scheduledDate: TOMORROW }),
  });
  assert.equal(good.status, 200);
  assert.equal((await readJob(job.id))!.scheduledDate, TOMORROW);
});

test("a waiting-list job cannot be skipped, so the customer's free skip is still there", async () => {
  const [fresh] = await db
    .insert(clientsTable)
    .values({ name: `Waiting Skip ${Date.now()}`, status: "client" })
    .returning();
  ids.clients.push(fresh.id);
  const waiting = await createJob({
    clientId: fresh.id,
    dispatched: false,
    scheduledDate: null,
    windowStart: LAST_WEEK,
    windowEnd: NEXT_WEEK,
  });

  const res = await post("/jobs/bulk-action", admin.id, { jobIds: [waiting.id], action: "skip", reason: "too wet" });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 0);
  assert.deepEqual(res.body.skippedIds, [waiting.id]);
  const row = (await readJob(waiting.id))!;
  assert.equal(row.status, "scheduled");
  assert.equal(row.skippedAt, null);
  assert.equal(row.skipReason, null);

  // Still on the list, and still dispatchable.
  const list = await api(`/waiting-list?date=${TODAY}`, admin.id);
  assert.ok(list.body.some((j: any) => j.id === waiting.id));

  // Nothing was spent: their first real skip on the board is the free one.
  const onBoard = await createJob({ clientId: fresh.id });
  const real = await post("/jobs/bulk-action", admin.id, { jobIds: [onBoard.id], action: "skip", reason: "gate locked" });
  assert.equal(real.body.updated, 1);
  assert.equal((await readJob(onBoard.id))!.skipBillable, false);
});

test("a new day retires a skip or a cancel, so the visit can be completed", async () => {
  const skipped = await createJob({
    status: "skipped",
    skipReason: "too wet",
    skippedAt: new Date(),
    skipBillable: false,
  });
  const res = await post("/jobs/bulk-action", admin.id, { jobIds: [skipped.id], action: "move", scheduledDate: TOMORROW });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1);
  const row = (await readJob(skipped.id))!;
  assert.equal(row.scheduledDate, TOMORROW);
  assert.equal(row.status, "scheduled");
  assert.equal(row.skipReason, null);
  assert.equal(row.skippedAt, null);
  assert.equal(row.skipBillable, null);
  // The whole point: "reschedule it first" was done, so Complete works now.
  const complete = await post(`/jobs/${skipped.id}/complete`, admin.id, {});
  assert.equal(complete.status, 200);

  // Same coming off the waiting list: a cancelled job dispatched to a day lands
  // clean, not cancelled on the crew's phone.
  const cancelled = await createJob({
    dispatched: false,
    scheduledDate: null,
    status: "cancelled",
    cancelReason: "customer moved",
    cancelledAt: new Date(),
    windowStart: LAST_WEEK,
    windowEnd: NEXT_WEEK,
  });
  const back = await post("/jobs/bulk-action", admin.id, {
    jobIds: [cancelled.id],
    action: "dispatch",
    scheduledDate: TOMORROW,
  });
  assert.equal(back.body.updated, 1);
  const two = (await readJob(cancelled.id))!;
  assert.equal(two.status, "scheduled");
  assert.equal(two.cancelReason, null);
  assert.equal(two.cancelledAt, null);

  // A job part-way through its day keeps the status it has.
  const running = await createJob({ status: "in_progress" });
  await post("/jobs/bulk-action", admin.id, { jobIds: [running.id], action: "move", scheduledDate: TOMORROW });
  assert.equal((await readJob(running.id))!.status, "in_progress");
});

test("'windows that passed' is our day, not the server's UTC day", async () => {
  // On a UTC server the day rolls over at five in the afternoon here, and the
  // tidy-up list would then hold every window that is still open today — with
  // "Select all" and Cancel right next to it.
  const utcToday = new Date().toISOString().slice(0, 10);
  const dayIn = (zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
  const zone = ["Etc/GMT+12", "Pacific/Kiritimati"].find((z) => dayIn(z) !== utcToday);
  assert.ok(zone, "one of these zones is always on a different day to UTC");
  const localToday = dayIn(zone);
  const dayBefore = (d: string) => {
    const t = new Date(`${d}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() - 1);
    return t.toISOString().slice(0, 10);
  };

  const stillOpen = await createJob({
    dispatched: false,
    scheduledDate: null,
    windowStart: LAST_MONTH,
    windowEnd: localToday,
  });
  const closed = await createJob({
    dispatched: false,
    scheduledDate: null,
    windowStart: LAST_MONTH,
    windowEnd: dayBefore(localToday),
  });

  const previous = process.env.APP_TIME_ZONE;
  process.env.APP_TIME_ZONE = zone;
  try {
    const past = await api(`/waiting-list?window=past`, admin.id);
    const pastIds = past.body.map((j: any) => j.id);
    assert.ok(!pastIds.includes(stillOpen.id), "a window ending today is still open, whatever UTC says");
    assert.ok(pastIds.includes(closed.id), "yesterday's window has passed");
  } finally {
    if (previous === undefined) delete process.env.APP_TIME_ZONE;
    else process.env.APP_TIME_ZONE = previous;
  }
});

test("the batch audit line names who did it, so a run can clear up after itself", async () => {
  const job = await createJob();
  await post("/jobs/bulk-action", admin.id, { jobIds: [job.id], action: "add_note", note: "gate code 1234" });
  await post("/jobs/bulk-assign", admin.id, { jobIds: [job.id], clearRouteOrder: true });
  const mine = await db.select().from(auditEventsTable).where(eq(auditEventsTable.actorName, ADMIN_NAME));
  // No clientId on these, so `after` has nothing else to delete them by.
  assert.ok(mine.some((e) => e.action === "jobs_bulk_add_note" && e.clientId === null));
  assert.ok(mine.some((e) => e.action === "jobs_bulk_assigned"));
});
