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
  packagesTable,
  clientServicesTable,
} from "@workspace/db";
import { eq, inArray, isNull, and } from "drizzle-orm";

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
  packages: [] as number[],
};

let admin: { id: number };
let client: { id: number };
let service: { id: number };
let windowPackage: { id: number };

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

async function balanceOf(clientId: number) {
  const [row] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
  return row.accountBalance;
}

async function newInvoice(total: number) {
  const res = await api("/invoices", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, total }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as number;
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const [a] = await db
    .insert(usersTable)
    .values([
      { clerkId: `cs_admin_${stamp}`, name: "CS Admin", role: "admin", roleSource: "owner_assigned" },
    ])
    .returning();
  admin = a;
  ids.users.push(a.id);

  const [c] = await db
    .insert(clientsTable)
    .values({ name: `Credit Client ${stamp}`, status: "client" })
    .returning();
  client = c;
  ids.clients.push(c.id);

  const [s] = await db
    .insert(servicesTable)
    .values({ name: `Credit Service ${stamp}`, rate: 50 })
    .returning();
  service = s;
  ids.services.push(s.id);

  const [p] = await db
    .insert(packagesTable)
    .values({
      name: `Window Package ${stamp}`,
      serviceIds: [s.id],
      scheduleType: "window",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    })
    .returning();
  windowPackage = p;
  ids.packages.push(p.id);
});

after(async () => {
  if (ids.clients.length) {
    await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, ids.clients));
    await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, ids.clients));
    await db.delete(jobsTable).where(inArray(jobsTable.clientId, ids.clients));
    await db.delete(clientServicesTable).where(inArray(clientServicesTable.clientId, ids.clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  if (ids.packages.length) await db.delete(packagesTable).where(inArray(packagesTable.id, ids.packages));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

// ---- overpayment and credit ----

test("overpaying an invoice pays it exactly and banks the rest as credit", async () => {
  const invoiceId = await newInvoice(100);
  const res = await api("/payments", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, invoiceId, amount: 150, method: "check" }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  assert.equal(inv.status, "paid");
  assert.equal(inv.amountPaid, 100, "invoice must never record more paid than its total");

  const credits = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.clientId, client.id), isNull(paymentsTable.invoiceId)));
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amount, 50);

  // 100 invoiced - 150 received
  assert.equal(await balanceOf(client.id), -50);

  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, client.id));
  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, client.id));
});

test("voiding a paid invoice returns its payment to the account as credit", async () => {
  const invoiceId = await newInvoice(80);
  await api("/payments", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, invoiceId, amount: 80, method: "check" }),
  });
  assert.equal(await balanceOf(client.id), 0);

  const res = await api(`/invoices/${invoiceId}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ status: "void" }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  assert.equal(inv.status, "void");
  assert.equal(inv.amountPaid, 0, "a void invoice keeps no payments");

  const credits = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.clientId, client.id), isNull(paymentsTable.invoiceId)));
  assert.equal(credits.length, 1, "the payment should have been detached, not deleted");
  assert.equal(credits[0].amount, 80);

  // The money was still received, so it is credit — not an invented zero balance.
  assert.equal(await balanceOf(client.id), -80);

  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, client.id));
  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, client.id));
});

test("voiding a partly paid invoice detaches only what was actually received", async () => {
  const invoiceId = await newInvoice(100);
  await api("/payments", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, invoiceId, amount: 40, method: "check" }),
  });
  let [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  assert.equal(inv.status, "partial");
  assert.equal(await balanceOf(client.id), 60);

  await api(`/invoices/${invoiceId}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ status: "void" }),
  });

  [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  assert.equal(inv.amountPaid, 0);
  const credits = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.clientId, client.id), isNull(paymentsTable.invoiceId)));
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amount, 40);
  assert.equal(await balanceOf(client.id), -40, "the 40 received is credit; the 100 debt is cancelled");

  // Un-voiding restores the debt but deliberately leaves the money as credit for
  // the office to apply, rather than guessing it belongs back on this invoice.
  const reopened = await api(`/invoices/${invoiceId}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ status: "open" }),
  });
  assert.equal(reopened.status, 200);
  [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  assert.equal(inv.status, "open");
  assert.equal(inv.amountPaid, 0);
  assert.equal(await balanceOf(client.id), 60, "100 owed less 40 still held as credit");

  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, client.id));
  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, client.id));
});

test("deleting an applied payment reopens the invoice and restores the balance", async () => {
  const invoiceId = await newInvoice(120);
  const pay = await api("/payments", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, invoiceId, amount: 120, method: "cash" }),
  });
  assert.equal(await balanceOf(client.id), 0);

  const del = await api(`/payments/${pay.body.id}`, admin.id, { method: "DELETE" });
  assert.equal(del.status, 204);

  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  assert.equal(inv.amountPaid, 0);
  assert.equal(inv.status, "open");
  assert.equal(await balanceOf(client.id), 120);

  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, client.id));
});

test("simultaneous payments on different invoices both survive in the balance", async () => {
  const first = await newInvoice(100);
  const second = await newInvoice(60);
  assert.equal(await balanceOf(client.id), 160);

  // Different invoices means different row locks, so only the client-row lock
  // stops these two from each writing a balance computed without the other.
  const [a, b] = await Promise.all([
    api("/payments", admin.id, {
      method: "POST",
      body: JSON.stringify({ clientId: client.id, invoiceId: first, amount: 100, method: "check" }),
    }),
    api("/payments", admin.id, {
      method: "POST",
      body: JSON.stringify({ clientId: client.id, invoiceId: second, amount: 60, method: "check" }),
    }),
  ]);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));

  assert.equal(await balanceOf(client.id), 0, "one payment was lost from the balance");

  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, client.id));
  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, client.id));
});

test("voiding an invoice while its payment is being deleted does not deadlock", async () => {
  const invoiceId = await newInvoice(90);
  const pay = await api("/payments", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, invoiceId, amount: 90, method: "check" }),
  });

  // Void locks the invoice then its payments; delete must take the same order or
  // Postgres aborts one of them. Whichever lands first, the end state is the same.
  const [voided, deleted] = await Promise.all([
    api(`/invoices/${invoiceId}`, admin.id, {
      method: "PATCH",
      body: JSON.stringify({ status: "void" }),
    }),
    api(`/payments/${pay.body.id}`, admin.id, { method: "DELETE" }),
  ]);
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  assert.equal(deleted.status, 204);

  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  assert.equal(inv.status, "void");
  const remaining = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.clientId, client.id));
  assert.equal(remaining.length, 0, "the payment was deleted either before or after the void");
  assert.equal(await balanceOf(client.id), 0, "no debt (void) and no money received");

  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, client.id));
});

// ---- schedule validation ----

async function assignService(payload: Record<string, unknown>) {
  return api(`/clients/${client.id}/client-services`, admin.id, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function countAssignments() {
  const rows = await db
    .select()
    .from(clientServicesTable)
    .where(eq(clientServicesTable.clientId, client.id));
  return rows.length;
}

test("a recurring assignment missing its date and frequency is rejected, not downgraded", async () => {
  const before = await countAssignments();
  const res = await assignService({ serviceId: service.id, scheduleType: "recurring" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /first service date/i);
  assert.equal(await countAssignments(), before, "nothing should have been written");
});

test("a non-positive recurring frequency is rejected before any jobs are generated", async () => {
  const before = await countAssignments();
  for (const frequencyWeeks of [0, -2, 1.5]) {
    const res = await assignService({
      serviceId: service.id,
      scheduleType: "recurring",
      firstServiceDate: "2026-06-01",
      frequencyWeeks,
    });
    assert.equal(res.status, 400, `frequency ${frequencyWeeks} should be rejected`);
  }
  assert.equal(await countAssignments(), before);
});

test("an impossible calendar date is rejected instead of throwing mid-write", async () => {
  const before = await countAssignments();
  const res = await assignService({
    serviceId: service.id,
    scheduleType: "recurring",
    firstServiceDate: "2026-02-31",
    frequencyWeeks: 2,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /calendar date/i);
  assert.equal(await countAssignments(), before, "the assignment must not be left behind");
});

test("a season end before the first service date is rejected", async () => {
  const res = await assignService({
    serviceId: service.id,
    scheduleType: "recurring",
    firstServiceDate: "2026-06-01",
    frequencyWeeks: 2,
    seasonEndDate: "2026-05-01",
  });
  assert.equal(res.status, 400);
});

test("a package supplies the schedule type when the request omits it", async () => {
  const res = await assignService({ packageId: windowPackage.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.length, 1);

  const [row] = await db
    .select()
    .from(clientServicesTable)
    .where(eq(clientServicesTable.id, res.body[0].id));
  assert.equal(row.scheduleType, "window", "the package's schedule type should be inherited");
  assert.equal(row.startDate, "2026-05-01");
  assert.equal(row.endDate, "2026-05-31");
  assert.equal(row.packageId, windowPackage.id);
});

test("an explicit value in the request beats the package default", async () => {
  // Inside the package's window: a start after the inherited end is now refused
  // (a window that ends before it starts never shows on the waiting list).
  const res = await assignService({ packageId: windowPackage.id, startDate: "2026-05-15" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [row] = await db
    .select()
    .from(clientServicesTable)
    .where(eq(clientServicesTable.id, res.body[0].id));
  assert.equal(row.startDate, "2026-05-15");
  assert.equal(row.scheduleType, "window", "unspecified fields still come from the package");
});
