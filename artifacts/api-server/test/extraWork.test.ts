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
  jobProductsTable,
  auditEventsTable,
  billingSettingsTable,
} from "@workspace/db";
import { eq, inArray, desc } from "drizzle-orm";

process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
};

let admin: { id: number };
let contractorA: { id: number };
let contractorB: { id: number };
let client: { id: number };
let offerable: { id: number };
let notOfferable: { id: number };

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

async function setCardFee(enabled: boolean, percent: number) {
  const rows = await db.select().from(billingSettingsTable).limit(1);
  if (rows.length === 0) {
    await db.insert(billingSettingsTable).values({ cardFeeEnabled: enabled, cardFeePercent: percent });
  } else {
    await db
      .update(billingSettingsTable)
      .set({ cardFeeEnabled: enabled, cardFeePercent: percent })
      .where(eq(billingSettingsTable.id, rows[0].id));
  }
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
      { clerkId: `xw_admin_${stamp}`, name: "XW Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `xw_contractor_a_${stamp}`, name: "XW Contractor A", role: "contractor" },
      { clerkId: `xw_contractor_b_${stamp}`, name: "XW Contractor B", role: "contractor" },
    ])
    .returning();
  admin = a;
  contractorA = ca;
  contractorB = cb;
  ids.users.push(a.id, ca.id, cb.id);

  const [c] = await db
    .insert(clientsTable)
    .values({ name: "Extra Work Client", status: "client" })
    .returning();
  client = c;
  ids.clients.push(c.id);

  const [s1, s2] = await db
    .insert(servicesTable)
    .values([
      {
        name: `Bush Trim ${stamp}`,
        rate: 100,
        contractorOfferable: true,
        contractorPrice: 45,
      },
      { name: `Aeration ${stamp}`, rate: 200, contractorOfferable: false },
    ])
    .returning();
  offerable = s1;
  notOfferable = s2;
  ids.services.push(s1.id, s2.id);
});

after(async () => {
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
      clientId: client.id,
      amount: 60,
      assignedToId: contractorA.id,
      dispatched: true,
      scheduledDate: TODAY,
      ...overrides,
    })
    .returning();
  return job;
}

test("offerable services list only contains office-approved services with field prices", async () => {
  const res = await api("/my/offerable-services", contractorA.id);
  assert.equal(res.status, 200);
  const mine = res.body.find((s: any) => s.id === offerable.id);
  assert.ok(mine);
  assert.equal(mine.price, 45); // contractorPrice overrides rate
  assert.ok(!res.body.some((s: any) => s.id === notOfferable.id));
});

test("contractor adds approved extra work; invoice and audit trail include it", async () => {
  const job = await createJob();
  const res = await api(`/my/jobs/${job.id}/extra-work`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ serviceId: offerable.id, quantity: 2 }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, offerable.name ?? res.body.name);
  assert.equal(res.body.price, 45);
  assert.equal(res.body.quantity, 2);
  assert.equal(res.body.serviceId, offerable.id);

  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.clientId, client.id))
    .orderBy(desc(auditEventsTable.id))
    .limit(1);
  assert.equal(audit.action, "extra_work_added");

  // completing the job folds the extra work into the invoice total
  const done = await api(`/jobs/${job.id}/complete`, contractorA.id, { method: "POST" });
  assert.equal(done.status, 200);
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.jobId, job.id));
  assert.equal(inv.total, 60 + 2 * 45);
});

test("extra work is rejected for unapproved services, foreign jobs, and completed jobs", async () => {
  const job = await createJob();

  const unapproved = await api(`/my/jobs/${job.id}/extra-work`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ serviceId: notOfferable.id }),
  });
  assert.equal(unapproved.status, 400);

  const foreign = await api(`/my/jobs/${job.id}/extra-work`, contractorB.id, {
    method: "POST",
    body: JSON.stringify({ serviceId: offerable.id }),
  });
  assert.equal(foreign.status, 403);

  await api(`/jobs/${job.id}/complete`, contractorA.id, { method: "POST" });
  const late = await api(`/my/jobs/${job.id}/extra-work`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ serviceId: offerable.id }),
  });
  assert.equal(late.status, 400);
});

test("on-site cash payment records against the job invoice and balance without a fee", async () => {
  await setCardFee(true, 3);
  const job = await createJob({ amount: 80 });
  await api(`/jobs/${job.id}/complete`, contractorA.id, { method: "POST" });

  const res = await api(`/my/jobs/${job.id}/payments`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ amount: 80, method: "cash" }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.amount, 80);
  assert.equal(res.body.cardFee, 0);
  assert.equal(res.body.cardFeePercent, null);

  const [jobRow] = await db.select().from(jobsTable).where(eq(jobsTable.id, job.id));
  assert.equal(res.body.invoiceId, jobRow.invoiceId);
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, jobRow.invoiceId!));
  assert.equal(inv.status, "paid");
});

test("a payment collected before completion is attached to the invoice created at completion", async () => {
  await setCardFee(false, 3);
  const job = await createJob({ amount: 120 });

  // contractor collects payment while the job is still in progress
  const pay = await api(`/my/jobs/${job.id}/payments`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ amount: 120, method: "cash" }),
  });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.invoiceId, null);
  assert.equal(pay.body.jobId, job.id);

  const done = await api(`/jobs/${job.id}/complete`, contractorA.id, { method: "POST" });
  assert.equal(done.status, 200);

  const [jobRow] = await db.select().from(jobsTable).where(eq(jobsTable.id, job.id));
  const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, pay.body.id));
  assert.equal(payment.invoiceId, jobRow.invoiceId);
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, jobRow.invoiceId!));
  assert.equal(inv.status, "paid");
  assert.equal(inv.amountPaid, 120);
});

test("a payment racing a concurrent completion still lands on the completion invoice", async () => {
  await setCardFee(false, 3);
  const job = await createJob({ amount: 90 });

  // Simulate completion holding the job row lock while a field payment arrives:
  // inside a transaction, lock the job, then fire the payment request (which
  // must block on the lock), then perform completion's invoice work and commit.
  let paymentPromise: Promise<{ status: number; body: any }> | null = null;
  let invoiceId = 0;
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, job.id)).for("update");
    assert.ok(locked);

    paymentPromise = api(`/my/jobs/${job.id}/payments`, contractorA.id, {
      method: "POST",
      body: JSON.stringify({ amount: 90, method: "cash" }),
    });
    // give the payment handler time to reach its row lock and block
    await new Promise((r) => setTimeout(r, 300));

    // completion's work, mirroring POST /jobs/:id/complete
    const [inv] = await tx
      .insert(invoicesTable)
      .values({ clientId: job.clientId, jobId: job.id, total: 90 })
      .returning();
    invoiceId = inv.id;
    await tx
      .update(jobsTable)
      .set({ status: "completed", completedAt: new Date(), invoiceId: inv.id })
      .where(eq(jobsTable.id, job.id));
  });

  const pay = await paymentPromise!;
  assert.equal(pay.status, 201);
  // the payment saw the committed completion and attached to its invoice
  assert.equal(pay.body.invoiceId, invoiceId);

  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  assert.equal(inv.status, "paid");
  assert.equal(inv.amountPaid, 90);
});

test("card fee before completion reconciles invoice total, amountPaid, and balance", async () => {
  await setCardFee(true, 3);
  const [feeClient] = await db
    .insert(clientsTable)
    .values({ name: "Fee Client Pre", status: "client" })
    .returning();
  ids.clients.push(feeClient.id);
  const job = await createJob({ amount: 100, clientId: feeClient.id });

  const res = await api(`/my/jobs/${job.id}/payments`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ amount: 100, method: "credit_card", reference: "4242" }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.baseAmount, 100);
  assert.equal(res.body.cardFee, 3);
  assert.equal(res.body.amount, 103);
  assert.equal(res.body.cardFeePercent, 3);
  assert.match(res.body.notes ?? "", /card processing fee/);

  // completion folds the surcharge into the invoice: everything reconciles
  await api(`/jobs/${job.id}/complete`, contractorA.id, { method: "POST" });
  const [jobRow] = await db.select().from(jobsTable).where(eq(jobsTable.id, job.id));
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, jobRow.invoiceId!));
  assert.equal(inv.total, 103);
  assert.equal(inv.amountPaid, 103);
  assert.equal(inv.status, "paid");
  const [balClient] = await db.select().from(clientsTable).where(eq(clientsTable.id, feeClient.id));
  assert.equal(balClient.accountBalance, 0);
  await setCardFee(false, 3);
});

test("card fee after completion bumps the invoice total and reconciles the balance", async () => {
  await setCardFee(true, 3);
  const [feeClient] = await db
    .insert(clientsTable)
    .values({ name: "Fee Client Post", status: "client" })
    .returning();
  ids.clients.push(feeClient.id);
  const job = await createJob({ amount: 200, clientId: feeClient.id });
  await api(`/jobs/${job.id}/complete`, contractorA.id, { method: "POST" });

  const res = await api(`/my/jobs/${job.id}/payments`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ amount: 200, method: "credit_card" }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.amount, 206);
  assert.equal(res.body.cardFee, 6);

  const [jobRow] = await db.select().from(jobsTable).where(eq(jobsTable.id, job.id));
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, jobRow.invoiceId!));
  assert.equal(inv.total, 206);
  assert.equal(inv.amountPaid, 206);
  assert.equal(inv.status, "paid");
  const [balClient] = await db.select().from(clientsTable).where(eq(clientsTable.id, feeClient.id));
  assert.equal(balClient.accountBalance, 0);

  // fee disabled: no surcharge for card payments
  await setCardFee(false, 3);
  const job2 = await createJob({ amount: 50, clientId: feeClient.id });
  const noFee = await api(`/my/jobs/${job2.id}/payments`, contractorA.id, {
    method: "POST",
    body: JSON.stringify({ amount: 50, method: "credit_card" }),
  });
  assert.equal(noFee.status, 201);
  assert.equal(noFee.body.cardFee, 0);
  assert.equal(noFee.body.amount, 50);
});

test("contractors cannot take payment on unrelated jobs or read financial data", async () => {
  const job = await createJob();
  const denied = await api(`/my/jobs/${job.id}/payments`, contractorB.id, {
    method: "POST",
    body: JSON.stringify({ amount: 50, method: "cash" }),
  });
  assert.equal(denied.status, 403);

  // no payment row was created
  const payments = await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, client.id));
  assert.ok(!payments.some((p) => p.amount === 50));

  // admin-only financial surfaces stay closed to contractors
  assert.equal((await api("/invoices", contractorA.id)).status, 403);
  assert.equal((await api("/payments", contractorA.id)).status, 403);
});

test("billing settings are readable by contractors but only writable by admins", async () => {
  const read = await api("/billing-settings", contractorA.id);
  assert.equal(read.status, 200);
  assert.ok("cardFeeEnabled" in read.body && "cardFeePercent" in read.body);

  const denied = await api("/billing-settings", contractorA.id, {
    method: "PATCH",
    body: JSON.stringify({ cardFeeEnabled: true, cardFeePercent: 5 }),
  });
  assert.equal(denied.status, 403);

  const ok = await api("/billing-settings", admin.id, {
    method: "PATCH",
    body: JSON.stringify({ cardFeeEnabled: true, cardFeePercent: 2.5 }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cardFeePercent, 2.5);
  await setCardFee(false, 3);
});
