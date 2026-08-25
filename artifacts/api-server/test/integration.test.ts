import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  jobsTable,
  invoicesTable,
  paymentsTable,
  servicesTable,
  estimatesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  claimEstimateDelivery,
  finalizeEstimateDelivery,
  recordEstimateProviderAccepted,
  releaseEstimateDelivery,
} from "../src/lib/estimateDeliveryState.ts";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

// created row ids for cleanup
const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
};

let admin: { id: number };
let contractorA: { id: number };
let contractorB: { id: number };
let clientWithCoords: { id: number };
let clientNoCoords: { id: number };
let service: { id: number };

const TODAY = new Date().toISOString().slice(0, 10);

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
  return { status: res.status, body: text ? JSON.parse(text) : null };
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
      { clerkId: `test_admin_${stamp}`, name: "Test Admin", role: "admin", roleSource: "owner_assigned" },
      {
        clerkId: `test_contractor_a_${stamp}`,
        name: "Contractor A",
        role: "contractor",
        baseAddress: "100 Depot St",
        baseLat: 32.7767,
        baseLng: -96.797,
      },
      { clerkId: `test_contractor_b_${stamp}`, name: "Contractor B", role: "contractor" },
    ])
    .returning();
  admin = a;
  contractorA = ca;
  contractorB = cb;
  ids.users.push(a.id, ca.id, cb.id);

  const [c1, c2] = await db
    .insert(clientsTable)
    .values([
      {
        name: "Route Client One",
        status: "client",
        serviceAddress: "1 Elm St",
        lat: 32.78,
        lng: -96.8,
      },
      { name: "No Coords Client", status: "client", serviceAddress: "2 Oak St" },
    ])
    .returning();
  clientWithCoords = c1;
  clientNoCoords = c2;
  ids.clients.push(c1.id, c2.id);

  const [svc] = await db
    .insert(servicesTable)
    .values({ name: `Test Mow ${stamp}` })
    .returning();
  service = svc;
  ids.services.push(svc.id);
});

after(async () => {
  // clients cascade jobs/invoices/payments/audit events
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

async function createJob(overrides: Partial<typeof jobsTable.$inferInsert> = {}) {
  const [job] = await db
    .insert(jobsTable)
    .values({
      clientId: clientWithCoords.id,
      serviceId: service.id,
      amount: 50,
      ...overrides,
    })
    .returning();
  return job;
}

test("unauthenticated requests are rejected", async () => {
  const res = await api("/me", null);
  assert.equal(res.status, 401);
});

test("the test bypass rejects a missing or wrong capability token", async () => {
  const noToken = await fetch(`${baseUrl}/api/me`, {
    headers: { "x-test-user-id": String(admin.id) },
  });
  assert.equal(noToken.status, 401);
  const wrongToken = await fetch(`${baseUrl}/api/me`, {
    headers: { "x-test-user-id": String(admin.id), "x-test-auth-token": "wrong" },
  });
  assert.equal(wrongToken.status, 401);
});

test("configured primary and secondary owner emails resolve to admin access", async () => {
  const { resolveOwnerAccess } = await import("../src/lib/ownerAccess.ts");
  for (const key of ["APP_OWNER_EMAIL", "APP_SECONDARY_OWNER_EMAIL"] as const) {
    const email = process.env[key];
    assert.ok(email, `${key} must be configured`);
    const access = resolveOwnerAccess({
      configuredOwnerEmails: [process.env.APP_OWNER_EMAIL, process.env.APP_SECONDARY_OWNER_EMAIL],
      currentPrimaryEmail: email!,
      profileAvailable: true,
      currentRole: "contractor",
      currentRoleSource: "provisioned",
    });
    assert.deepEqual(access, { role: "admin", roleSource: "owner" });
  }
});

test("contractors cannot reach admin-only job listings", async () => {
  const res = await api("/jobs", contractorA.id);
  assert.equal(res.status, 403);
});

test("contractors see only their own dispatched, visible jobs", async () => {
  const mine = await createJob({ assignedToId: contractorA.id, dispatched: true, scheduledDate: TODAY });
  await createJob({ assignedToId: contractorB.id, dispatched: true, scheduledDate: TODAY });
  await createJob({ assignedToId: contractorA.id, dispatched: false, scheduledDate: TODAY });
  await createJob({
    assignedToId: contractorA.id,
    dispatched: true,
    scheduledDate: TODAY,
    visibleToContractor: false,
  });

  const res = await api(`/my/jobs?date=${TODAY}`, contractorA.id);
  assert.equal(res.status, 200);
  const jobIds = res.body.map((j: any) => j.id);
  assert.ok(jobIds.includes(mine.id));
  for (const j of res.body) {
    assert.equal(j.assignedToId, contractorA.id);
    assert.equal(j.dispatched, true);
    assert.equal(j.visibleToContractor, true);
  }

  // contractor B cannot fetch contractor A's job directly
  const forbidden = await api(`/jobs/${mine.id}`, contractorB.id);
  assert.equal(forbidden.status, 403);
});

test("dispatching waiting-list work assigns, dates, and dispatches jobs", async () => {
  const waiting = await createJob({ dispatched: false, scheduledDate: null });
  const res = await api("/jobs/dispatch", admin.id, {
    method: "POST",
    body: JSON.stringify({ jobIds: [waiting.id], date: TODAY, assignedToId: contractorA.id }),
  });
  assert.equal(res.status, 200);
  const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, waiting.id));
  assert.equal(row.dispatched, true);
  assert.equal(row.scheduledDate, TODAY);
  assert.equal(row.assignedToId, contractorA.id);

  // contractors cannot dispatch
  const denied = await api("/jobs/dispatch", contractorA.id, {
    method: "POST",
    body: JSON.stringify({ jobIds: [waiting.id], date: TODAY }),
  });
  assert.equal(denied.status, 403);
});

test("completing a job creates exactly one invoice, even when repeated", async () => {
  const job = await createJob({
    assignedToId: contractorA.id,
    dispatched: true,
    scheduledDate: TODAY,
    amount: 75,
  });
  const first = await api(`/jobs/${job.id}/complete`, contractorA.id, { method: "POST" });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "completed");

  const second = await api(`/jobs/${job.id}/complete`, contractorA.id, { method: "POST" });
  assert.equal(second.status, 200);

  const invoices = await db.select().from(invoicesTable).where(eq(invoicesTable.jobId, job.id));
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].total, 75);

  // an unassigned contractor cannot complete someone else's job
  const other = await createJob({ assignedToId: contractorA.id, dispatched: true, scheduledDate: TODAY });
  const denied = await api(`/jobs/${other.id}/complete`, contractorB.id, { method: "POST" });
  assert.equal(denied.status, 403);
});

test("payments and voids recalculate invoice status and client balance", async () => {
  const [client] = await db
    .insert(clientsTable)
    .values({ name: "Billing Client", status: "client" })
    .returning();
  ids.clients.push(client.id);

  const inv = await api("/invoices", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, total: 100 }),
  });
  assert.equal(inv.status, 201);

  const pay = await api("/payments", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, invoiceId: inv.body.id, amount: 40, method: "cash" }),
  });
  assert.equal(pay.status, 201);

  let [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv.body.id));
  assert.equal(row.status, "partial");
  assert.equal(row.amountPaid, 40);
  let [c] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
  assert.equal(c.accountBalance, 60);

  // voiding the invoice removes it from the balance
  const voided = await api(`/invoices/${inv.body.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ status: "void" }),
  });
  assert.equal(voided.status, 200);
  [c] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
  assert.equal(c.accountBalance, -40);

  // payments against a void invoice are rejected
  const rejected = await api("/payments", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, invoiceId: inv.body.id, amount: 10, method: "cash" }),
  });
  assert.equal(rejected.status, 400);

  // deleting the payment restores the balance
  const paymentId = pay.body.id;
  const del = await api(`/payments/${paymentId}`, admin.id, { method: "DELETE" });
  assert.equal(del.status, 204);
  [c] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
  assert.equal(c.accountBalance, 0);
});

test("contractor route includes home base, stop types, names, and leg distances", async () => {
  const date = "2091-05-01"; // isolated date so no other jobs interfere
  const j1 = await createJob({ assignedToId: contractorA.id, dispatched: true, scheduledDate: date });
  const j2 = await createJob({
    assignedToId: contractorA.id,
    dispatched: true,
    scheduledDate: date,
    clientId: clientNoCoords.id,
  });

  const res = await api(`/my/route?date=${date}`, contractorA.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.optimized, true);
  assert.equal(res.body.baseAddress, "100 Depot St");
  assert.equal(res.body.stops.length, 3);

  const [base, first, last] = res.body.stops;
  assert.equal(base.type, "base");
  assert.equal(base.name, "Home Base");
  assert.equal(base.order, 1);
  assert.ok(base.distanceToNextKm != null && base.distanceToNextKm > 0);

  assert.equal(first.type, "job");
  assert.equal(first.jobId, j1.id);
  assert.equal(first.name, "Route Client One");
  assert.equal(first.hasCoordinates, true);

  assert.equal(last.jobId, j2.id);
  assert.equal(last.name, "No Coords Client");
  assert.equal(last.hasCoordinates, false);
  assert.equal(last.distanceToNextKm, null);

  assert.ok(res.body.totalDistanceKm > 0);

  // contractor B has no jobs that day: empty, un-optimized route
  const empty = await api(`/my/route?date=${date}`, contractorB.id);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.stops.length, 0);
  assert.equal(empty.body.optimized, false);
});

test("un-optimized routes keep deterministic dispatch order for null routeOrder", async () => {
  const date = "2091-06-01";
  // contractor B has no home base, so their route is never optimized
  const b1 = await createJob({ assignedToId: contractorB.id, dispatched: true, scheduledDate: date });
  const b2 = await createJob({ assignedToId: contractorB.id, dispatched: true, scheduledDate: date });
  const b3 = await createJob({
    assignedToId: contractorB.id,
    dispatched: true,
    scheduledDate: date,
    routeOrder: 1,
  });

  const res = await api(`/my/route?date=${date}`, contractorB.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.optimized, false);
  // explicit routeOrder first, then null routeOrder by ascending id
  assert.deepEqual(
    res.body.stops.map((s: any) => s.jobId),
    [b3.id, b1.id, b2.id],
  );
});

test("estimate PDF downloads and a secure customer response can be recorded only once", async () => {
  const token = `estimate-response-${Date.now()}`;
  const [estimate] = await db
    .insert(estimatesTable)
    .values({
      clientId: clientWithCoords.id,
      status: "sent",
      total: 80,
      lines: [{ fieldId: 1, label: "Mowing", value: "1 visit", calculatedPrice: 80 }],
      sentAt: new Date(),
      sentToEmail: "customer@example.com",
      responseTokenHash: createHash("sha256").update(token).digest("hex"),
    })
    .returning();

  const pdf = await fetch(`${baseUrl}/api/estimates/${estimate.id}/pdf`, {
    headers: { "x-test-user-id": String(admin.id), "x-test-auth-token": TEST_AUTH_TOKEN },
  });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-type") ?? "", /application\/pdf/);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");

  const confirmation = await fetch(
    `${baseUrl}/api/public/estimates/${encodeURIComponent(token)}/respond?action=accept`,
  );
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /Confirm Acceptance/);
  let [stillSent] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, estimate.id));
  assert.equal(stillSent.status, "sent");

  const accepted = await fetch(
    `${baseUrl}/api/public/estimates/${encodeURIComponent(token)}/respond`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=accept",
    },
  );
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /Estimate accepted/);

  const declinedAfterAccept = await fetch(
    `${baseUrl}/api/public/estimates/${encodeURIComponent(token)}/respond`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=decline",
    },
  );
  assert.equal(declinedAfterAccept.status, 200);
  assert.match(await declinedAfterAccept.text(), /Estimate already accepted/);

  const [stored] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, estimate.id));
  assert.equal(stored.status, "accepted");
  assert.ok(stored.respondedAt);

  const badToken = await fetch(`${baseUrl}/api/public/estimates/not-valid/respond?action=accept`);
  assert.equal(badToken.status, 404);
});

test("estimate delivery rejects concurrent sends and preserves final customer responses", async () => {
  const [sending, accepted] = await db
    .insert(estimatesTable)
    .values([
      {
        clientId: clientWithCoords.id,
        status: "draft",
        total: 10,
        lines: [{ fieldId: 1, label: "Test", value: "1", calculatedPrice: 10 }],
        deliveryState: "sending",
      },
      {
        clientId: clientWithCoords.id,
        status: "accepted",
        total: 20,
        lines: [{ fieldId: 1, label: "Accepted", value: "1", calculatedPrice: 20 }],
        respondedAt: new Date(),
      },
    ])
    .returning();

  for (const estimate of [sending, accepted]) {
    const result = await api(`/estimates/${estimate.id}/send`, admin.id, {
      method: "POST",
      body: JSON.stringify({ toEmail: "customer@example.com", message: "Test" }),
    });
    assert.equal(result.status, 409);
  }

  const [stillAccepted] = await db
    .select()
    .from(estimatesTable)
    .where(eq(estimatesTable.id, accepted.id));
  assert.equal(stillAccepted.status, "accepted");
  assert.ok(stillAccepted.respondedAt);
});

test("provider-accepted delivery can only be reconciled, never sent twice", async () => {
  const pendingHash = createHash("sha256").update("provider-accepted-no-duplicate").digest("hex");
  const [estimate] = await db
    .insert(estimatesTable)
    .values({
      clientId: clientWithCoords.id,
      status: "draft",
      total: 25,
      lines: [{ fieldId: 1, label: "No duplicate", value: "1", calculatedPrice: 25 }],
    })
    .returning();
  await claimEstimateDelivery(estimate.id, pendingHash);
  await recordEstimateProviderAccepted(
    estimate.id,
    pendingHash,
    "customer@example.com",
    "gmail-no-duplicate",
  );

  const resend = await api(`/estimates/${estimate.id}/send`, admin.id, {
    method: "POST",
    body: JSON.stringify({ toEmail: "customer@example.com", message: "Duplicate attempt" }),
  });
  assert.equal(resend.status, 409);
  assert.match(resend.body.error, /Reconcile/i);

  const [stored] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, estimate.id));
  assert.equal(stored.deliveryState, "provider_accepted");
  assert.equal(stored.pendingResponseTokenHash, pendingHash);
  assert.equal(stored.deliveryAttempts, 1);
  assert.equal(stored.gmailMessageId, "gmail-no-duplicate");
});

test("a failed resend keeps the previously delivered customer response link active", async () => {
  const oldHash = createHash("sha256").update("old-active-token").digest("hex");
  const pendingHash = createHash("sha256").update("new-pending-token").digest("hex");
  const [estimate] = await db
    .insert(estimatesTable)
    .values({
      clientId: clientWithCoords.id,
      status: "sent",
      total: 30,
      lines: [{ fieldId: 1, label: "Existing offer", value: "1", calculatedPrice: 30 }],
      responseTokenHash: oldHash,
      deliveryState: "sent",
      sentAt: new Date(),
    })
    .returning();

  const claimed = await claimEstimateDelivery(estimate.id, pendingHash);
  assert.equal(claimed?.deliveryState, "sending");
  assert.equal(claimed?.responseTokenHash, oldHash);
  assert.equal(claimed?.pendingResponseTokenHash, pendingHash);

  const released = await releaseEstimateDelivery(estimate.id, pendingHash, "PDF generation failed");
  assert.equal(released?.deliveryState, "failed");
  assert.equal(released?.pendingResponseTokenHash, null);
  assert.equal(released?.responseTokenHash, oldHash);

  const oldLink = await fetch(
    `${baseUrl}/api/public/estimates/old-active-token/respond?action=accept`,
  );
  assert.equal(oldLink.status, 200);
  assert.match(await oldLink.text(), /Confirm Acceptance/);
});

test("accepting during a resend cannot be overwritten when Gmail completes", async () => {
  const oldToken = "race-old-active-token";
  const oldHash = createHash("sha256").update(oldToken).digest("hex");
  const pendingToken = "race-new-pending-token";
  const pendingHash = createHash("sha256").update(pendingToken).digest("hex");
  const [estimate] = await db
    .insert(estimatesTable)
    .values({
      clientId: clientWithCoords.id,
      status: "sent",
      total: 45,
      lines: [{ fieldId: 1, label: "Race offer", value: "1", calculatedPrice: 45 }],
      responseTokenHash: oldHash,
      deliveryState: "sent",
      sentAt: new Date(),
    })
    .returning();

  await claimEstimateDelivery(estimate.id, pendingHash);
  const accepted = await fetch(
    `${baseUrl}/api/public/estimates/${oldToken}/respond`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=accept",
    },
  );
  assert.equal(accepted.status, 200);

  await recordEstimateProviderAccepted(
    estimate.id,
    pendingHash,
    "customer@example.com",
    "gmail-race-test",
  );
  const finalized = await finalizeEstimateDelivery(
    estimate.id,
    pendingHash,
    "customer@example.com",
    "gmail-race-test",
  );
  assert.equal(finalized?.status, "accepted");
  assert.ok(finalized?.respondedAt);
  assert.equal(finalized?.responseTokenHash, pendingHash);
  assert.equal(finalized?.pendingResponseTokenHash, null);
  assert.equal(finalized?.deliveryState, "sent");

  const newLink = await fetch(
    `${baseUrl}/api/public/estimates/${pendingToken}/respond?action=accept`,
  );
  assert.equal(newLink.status, 200);
  assert.match(await newLink.text(), /Estimate already accepted/);
});

test("provider-accepted and interrupted sends can be reconciled without a duplicate email", async () => {
  for (const state of ["provider_accepted", "sending"] as const) {
    const token = `recovery-${state}-${Date.now()}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const [estimate] = await db
      .insert(estimatesTable)
      .values({
        clientId: clientWithCoords.id,
        status: "draft",
        total: 55,
        lines: [{ fieldId: 1, label: "Recovery offer", value: "1", calculatedPrice: 55 }],
      })
      .returning();
    await claimEstimateDelivery(estimate.id, hash);
    if (state === "provider_accepted") {
      await recordEstimateProviderAccepted(
        estimate.id,
        hash,
        "customer@example.com",
        `gmail-recovery-${estimate.id}`,
      );
      const pendingLink = await fetch(
        `${baseUrl}/api/public/estimates/${token}/respond?action=accept`,
      );
      assert.equal(pendingLink.status, 200);
      assert.match(await pendingLink.text(), /Confirm Acceptance/);
    }

    const reconciled = await api(`/estimates/${estimate.id}/reconcile-delivery`, admin.id, {
      method: "POST",
    });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.deliveryState, "sent");
    assert.equal(reconciled.body.status, "sent");

    const recoveredLink = await fetch(
      `${baseUrl}/api/public/estimates/${token}/respond?action=accept`,
    );
    assert.equal(recoveredLink.status, 200);
    assert.match(await recoveredLink.text(), /Confirm Acceptance/);
  }
});
