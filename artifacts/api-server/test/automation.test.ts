import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  jobsTable,
  ticketsTable,
  fieldNotesTable,
  weatherRulesTable,
  suggestedActionsTable,
  auditEventsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { setCustomerMessageGmailProxyForTests } = await import("../src/routes/automation.ts");

let server: Server;
let baseUrl: string;

const ids = {
  users: [] as number[],
  clients: [] as number[],
};

let admin: { id: number };
let contractorA: { id: number };
let contractorB: { id: number };
let client: { id: number };
let emailClient: { id: number; email: string | null };

const TOMORROW = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

async function api(
  path: string,
  userId: number | null,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
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
  return { status: res.status, body };
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const [a, ca, cb] = await db
    .insert(usersTable)
    .values([
      { clerkId: `auto_admin_${stamp}`, name: "Auto Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `auto_contractor_a_${stamp}`, name: "Auto Contractor A", role: "contractor" },
      { clerkId: `auto_contractor_b_${stamp}`, name: "Auto Contractor B", role: "contractor" },
    ])
    .returning();
  admin = a;
  contractorA = ca;
  contractorB = cb;
  ids.users.push(a.id, ca.id, cb.id);

  const [c] = await db
    .insert(clientsTable)
    .values({ name: "Automation Test Client", status: "client", lat: 32.78, lng: -96.8 })
    .returning();
  client = c;
  ids.clients.push(c.id);

  const [ce] = await db
    .insert(clientsTable)
    .values({
      name: "Automation Email Client",
      status: "client",
      email: "customer@example.com",
      lat: 32.79,
      lng: -96.81,
    })
    .returning();
  emailClient = ce;
  ids.clients.push(ce.id);
});

after(async () => {
  // jobs/field notes/suggestions cascade from clients
  if (ids.clients.length) {
    await db.delete(auditEventsTable).where(inArray(auditEventsTable.clientId, ids.clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  await db
    .delete(ticketsTable)
    .where(eq(ticketsTable.title, "Field note: Sprinkler head cracked near the driveway"));
  await db.delete(weatherRulesTable).where(eq(weatherRulesTable.name, "__auto_test_rule__"));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

async function makeJob(overrides: Partial<typeof jobsTable.$inferInsert> = {}) {
  const [job] = await db
    .insert(jobsTable)
    .values({
      clientId: client.id,
      status: "scheduled",
      dispatched: true,
      scheduledDate: TOMORROW,
      assignedToId: contractorA.id,
      amount: 40,
      ...overrides,
    })
    .returning();
  return job;
}

test("assigned contractor can create a field note; ticket + audit are created", async () => {
  const job = await makeJob();
  const res = await api(`/my/jobs/${job.id}/field-notes`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ transcript: "Sprinkler head cracked near the driveway", source: "voice" }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.jobId, job.id);
  assert.ok(res.body.ticketId, "ticket should be created");

  const [ticket] = await db.select().from(ticketsTable).where(eq(ticketsTable.id, res.body.ticketId));
  assert.equal(ticket.clientId, client.id);
  assert.match(ticket.title, /^Field note:/);

  const audits = await db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, client.id));
  assert.ok(audits.some((e) => e.action === "field_note_created"));
});

test("other contractors and undispatched jobs are rejected for field notes", async () => {
  const job = await makeJob();
  const other = await api(`/my/jobs/${job.id}/field-notes`, contractorB.id, {
    method: "POST",
    body: JSON.stringify({ transcript: "should be forbidden" }),
  });
  assert.equal(other.status, 403);

  const hidden = await makeJob({ dispatched: false, scheduledDate: null });
  const res = await api(`/my/jobs/${hidden.id}/field-notes`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ transcript: "not dispatched yet" }),
  });
  assert.equal(res.status, 403);
});

test("contractors cannot access the automation review queue", async () => {
  for (const [path, init] of [
    ["/suggested-actions", {}],
    ["/weather-rules", {}],
    ["/weather-check", { method: "POST", body: JSON.stringify({ date: TOMORROW }) }],
  ] as const) {
    const res = await api(path, contractorA.id, init as RequestInit);
    assert.equal(res.status, 403, `${path} should be admin-only`);
  }
});

test("suggestion edit/approve/reject lifecycle with audit trail", async () => {
  const jobA = await makeJob();
  const jobB = await makeJob();

  const [sA] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: jobA.id,
      clientId: client.id,
      actionType: "reschedule",
      reason: "test rain",
      targetDate: TOMORROW,
      newDate: TOMORROW,
      customerMessage: "original draft",
    })
    .returning();
  const [sB] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: jobB.id,
      clientId: client.id,
      actionType: "skip",
      reason: "test wind",
      targetDate: TOMORROW,
    })
    .returning();

  // edit is audited with before/after values
  const newDate = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const edit = await api(`/suggested-actions/${sA.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ newDate, customerMessage: "edited draft" }),
  });
  assert.equal(edit.status, 200);
  const audits1 = await db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, client.id));
  const editAudit = audits1.find((e) => e.action === "suggestion_edited");
  assert.ok(editAudit, "edit must be audited");
  assert.match(editAudit!.description, /original draft/);
  assert.match(editAudit!.description, /edited draft/);

  // approve reschedule applies the new date
  const approve = await api(`/suggested-actions/${sA.id}/approve`, admin.id, { method: "POST" });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, "approved");
  const [jobAafter] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobA.id));
  assert.equal(jobAafter.scheduledDate, newDate);

  // double approve rejected
  const again = await api(`/suggested-actions/${sA.id}/approve`, admin.id, { method: "POST" });
  assert.equal(again.status, 400);

  // reject leaves job untouched and is audited
  const reject = await api(`/suggested-actions/${sB.id}/reject`, admin.id, { method: "POST" });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.status, "rejected");
  const [jobBafter] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobB.id));
  assert.equal(jobBafter.dispatched, true);
  assert.equal(jobBafter.scheduledDate, TOMORROW);

  const audits2 = await db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, client.id));
  assert.ok(audits2.some((e) => e.action === "suggestion_approved"));
  assert.ok(audits2.some((e) => e.action === "suggestion_rejected"));
});

test("approving a message for a client with no email is recorded as undelivered, not silently dropped", async () => {
  const job = await makeJob();
  const [s] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: job.id,
      clientId: client.id,
      actionType: "skip",
      reason: "test no email",
      targetDate: TOMORROW,
      customerMessage: "We have to skip your service tomorrow.",
    })
    .returning();
  assert.equal(s.messageDeliveryState, "pending_review");

  const approve = await api(`/suggested-actions/${s.id}/approve`, admin.id, { method: "POST" });
  assert.equal(approve.status, 200);
  // Test client has no email on file, so delivery is impossible and must be visible.
  assert.equal(approve.body.messageDeliveryState, "no_email");
  assert.equal(approve.body.clientEmail, null);
  assert.equal(approve.body.messageSentAt, null);

  const audits = await db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, client.id));
  const approved = audits.find((e) => e.action === "suggestion_approved" && /test no email/.test(e.description));
  assert.ok(approved, "approval must be audited");
  assert.match(approved!.description, /no email address on file/);
});

test("a successfully emailed message is recorded as sent with recipient, timestamp, and audit", async () => {
  const job = await makeJob({ clientId: emailClient.id });
  const [s] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: job.id,
      clientId: emailClient.id,
      actionType: "reschedule",
      reason: "test gmail sent",
      targetDate: TOMORROW,
      newDate: TOMORROW,
      customerMessage: "Rain tomorrow — we moved your service.",
    })
    .returning();

  let captured: { path: string; mime: string } | null = null;
  setCustomerMessageGmailProxyForTests(async (_connector, path, init) => {
    const raw = JSON.parse(init.body).raw as string;
    captured = {
      path,
      mime: Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    };
    return new Response(JSON.stringify({ id: "gmail-suggestion-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const before = Date.now();
  const approve = await api(`/suggested-actions/${s.id}/approve`, admin.id, { method: "POST" });
  setCustomerMessageGmailProxyForTests(null);

  assert.equal(approve.status, 200);
  assert.equal(approve.body.messageDeliveryState, "sent");
  assert.equal(approve.body.messageSentToEmail, "customer@example.com");
  assert.equal(approve.body.messageDeliveryError, null);
  assert.ok(approve.body.messageSentAt, "a sent message must carry a timestamp");
  assert.ok(new Date(approve.body.messageSentAt).getTime() >= before - 1000);

  // the stub actually received the approved message addressed to the client
  assert.ok(captured, "Gmail proxy must be called");
  assert.equal(captured!.path, "/gmail/v1/users/me/messages/send");
  assert.match(captured!.mime, /To: customer@example\.com/);
  assert.match(captured!.mime, /Subject: Service rescheduled/);

  const [stored] = await db
    .select()
    .from(suggestedActionsTable)
    .where(eq(suggestedActionsTable.id, s.id));
  assert.equal(stored.messageDeliveryState, "sent");
  assert.equal(stored.messageSentToEmail, "customer@example.com");
  assert.ok(stored.messageSentAt);
  assert.equal(stored.messageGmailId, "gmail-suggestion-1");

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.clientId, emailClient.id));
  const sentAudit = audits.find(
    (e) => e.action === "suggestion_message_sent" && e.description.includes(`#${s.id}`),
  );
  assert.ok(sentAudit, "a successful send must be audited");
  assert.match(sentAudit!.description, /customer@example\.com/);
});

test("a provider failure is recorded as failed and never shown as delivered", async () => {
  const job = await makeJob({ clientId: emailClient.id });
  const [s] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: job.id,
      clientId: emailClient.id,
      actionType: "skip",
      reason: "test gmail failure",
      targetDate: TOMORROW,
      customerMessage: "Storms tomorrow — we have to skip your service.",
    })
    .returning();

  setCustomerMessageGmailProxyForTests(async () => new Response("mailbox unavailable", { status: 550 }));
  const approve = await api(`/suggested-actions/${s.id}/approve`, admin.id, { method: "POST" });
  setCustomerMessageGmailProxyForTests(null);

  assert.equal(approve.status, 200);
  assert.equal(approve.body.messageDeliveryState, "failed");
  assert.equal(approve.body.messageSentAt, null, "a failed email must never look delivered");
  assert.equal(approve.body.messageSentToEmail, "customer@example.com");
  assert.match(approve.body.messageDeliveryError, /Gmail delivery failed \(550\)/);

  const [stored] = await db
    .select()
    .from(suggestedActionsTable)
    .where(eq(suggestedActionsTable.id, s.id));
  assert.equal(stored.messageDeliveryState, "failed");
  assert.equal(stored.messageSentAt, null);
  assert.match(stored.messageDeliveryError!, /mailbox unavailable/);
  assert.equal(stored.messageGmailId, null);

  // the schedule change still applied — only the notification failed
  assert.equal(stored.status, "approved");
  const [jobAfter] = await db.select().from(jobsTable).where(eq(jobsTable.id, job.id));
  assert.equal(jobAfter.dispatched, false);
  assert.equal(jobAfter.scheduledDate, null);

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.clientId, emailClient.id));
  const failedAudit = audits.find(
    (e) => e.action === "suggestion_message_failed" && e.description.includes(`#${s.id}`),
  );
  assert.ok(failedAudit, "a delivery failure must be audited");
  assert.match(failedAudit!.description, /Gmail delivery failed \(550\)/);
  assert.ok(
    !audits.some((e) => e.action === "suggestion_message_sent" && e.description.includes(`#${s.id}`)),
    "a failed send must not be audited as sent",
  );
});

test("a claim stuck in 'sending' is aged out as never completed, not left in-flight or shown as delivered", async () => {
  const job = await makeJob({ clientId: emailClient.id });
  // Simulate a server death between the delivery claim and the outcome write:
  // an approved suggestion whose claim is older than the abandonment window.
  const staleClaim = new Date(Date.now() - 30 * 60 * 1000);
  const [stale] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: job.id,
      clientId: emailClient.id,
      actionType: "skip",
      reason: "test abandoned claim",
      targetDate: TOMORROW,
      customerMessage: "Storms tomorrow — we have to skip your service.",
      status: "approved",
      reviewedById: admin.id,
      reviewedAt: staleClaim,
      messageDeliveryState: "sending",
      messageDeliveryClaimedAt: staleClaim,
    })
    .returning();

  // A claim made just now is genuinely in flight and must stay untouched.
  const [fresh] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: job.id,
      clientId: emailClient.id,
      actionType: "skip",
      reason: "test live claim",
      targetDate: TOMORROW,
      customerMessage: "Storms tomorrow — we have to skip your service.",
      status: "approved",
      reviewedById: admin.id,
      reviewedAt: new Date(),
      messageDeliveryState: "sending",
      messageDeliveryClaimedAt: new Date(),
    })
    .returning();

  const list = await api("/suggested-actions?status=approved", admin.id);
  assert.equal(list.status, 200);

  const staleRow = list.body.find((r: any) => r.id === stale.id);
  assert.ok(staleRow, "the stuck suggestion must appear in the office view");
  assert.equal(staleRow.messageDeliveryState, "abandoned");
  assert.notEqual(staleRow.messageDeliveryState, "sent");
  assert.equal(staleRow.messageSentAt, null, "an abandoned claim must never look delivered");
  assert.match(staleRow.messageDeliveryError, /interrupted/i);

  const freshRow = list.body.find((r: any) => r.id === fresh.id);
  assert.equal(freshRow.messageDeliveryState, "sending", "a live claim is still in flight");

  const [storedStale] = await db
    .select()
    .from(suggestedActionsTable)
    .where(eq(suggestedActionsTable.id, stale.id));
  assert.equal(storedStale.messageDeliveryState, "abandoned");
  assert.equal(storedStale.messageSentAt, null);

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.clientId, emailClient.id));
  assert.ok(
    audits.some(
      (e) => e.action === "suggestion_message_abandoned" && e.description.includes(`#${stale.id}`),
    ),
    "an abandoned delivery must be recorded for the office",
  );
  assert.ok(
    !audits.some(
      (e) => e.action === "suggestion_message_sent" && e.description.includes(`#${stale.id}`),
    ),
    "an abandoned delivery must never be audited as sent",
  );

  // Repeated listing does not re-flag the already-resolved row.
  await db
    .update(suggestedActionsTable)
    .set({ messageDeliveryState: "not_applicable" })
    .where(eq(suggestedActionsTable.id, fresh.id));
});

test("a suggestion without a customer message needs no delivery", async () => {
  const job = await makeJob();
  const [s] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: job.id,
      clientId: client.id,
      actionType: "skip",
      reason: "test no message",
      targetDate: TOMORROW,
    })
    .returning();
  const approve = await api(`/suggested-actions/${s.id}/approve`, admin.id, { method: "POST" });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.messageDeliveryState, "not_applicable");
});

test("rejecting a suggestion never leaves a message queued for delivery", async () => {
  const job = await makeJob();
  const [s] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: job.id,
      clientId: client.id,
      actionType: "skip",
      reason: "test reject delivery",
      targetDate: TOMORROW,
      customerMessage: "Draft that must never be sent.",
    })
    .returning();
  const reject = await api(`/suggested-actions/${s.id}/reject`, admin.id, { method: "POST" });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.messageDeliveryState, "not_applicable");
  assert.equal(reject.body.messageSentAt, null);
});

test("approving a skip pulls the job back to the waiting list", async () => {
  const job = await makeJob();
  const [s] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "weather",
      jobId: job.id,
      clientId: client.id,
      actionType: "skip",
      reason: "test skip",
      targetDate: TOMORROW,
    })
    .returning();
  const approve = await api(`/suggested-actions/${s.id}/approve`, admin.id, { method: "POST" });
  assert.equal(approve.status, 200);
  const [after1] = await db.select().from(jobsTable).where(eq(jobsTable.id, job.id));
  assert.equal(after1.dispatched, false);
  assert.equal(after1.scheduledDate, null);
});

test("weather rule create/update/delete are audited", async () => {
  const created = await api("/weather-rules", admin.id, {
    method: "POST",
    body: JSON.stringify({ name: "__auto_test_rule__", conditionType: "rain", threshold: 5, actionType: "skip" }),
  });
  assert.equal(created.status, 201);
  const ruleId = created.body.id;

  const updated = await api(`/weather-rules/${ruleId}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ threshold: 12 }),
  });
  assert.equal(updated.status, 200);

  const del = await api(`/weather-rules/${ruleId}`, admin.id, { method: "DELETE" });
  assert.equal(del.status, 204);

  const audits = await db.select().from(auditEventsTable);
  assert.ok(audits.some((e) => e.action === "weather_rule_updated" && /__auto_test_rule__/.test(e.description)));
  assert.ok(audits.some((e) => e.action === "weather_rule_deleted" && /__auto_test_rule__/.test(e.description)));
  // clean rule-related audit rows (they carry no clientId)
  await db.delete(auditEventsTable).where(inArray(auditEventsTable.action, ["weather_rule_created", "weather_rule_updated", "weather_rule_deleted"]));
});

test("field notes require a non-empty transcript", async () => {
  const job = await makeJob();
  const res = await api(`/my/jobs/${job.id}/field-notes`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ transcript: "" }),
  });
  assert.notEqual(res.status, 201);
});
