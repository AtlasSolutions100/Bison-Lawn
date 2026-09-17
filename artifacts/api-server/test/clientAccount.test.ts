import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { db, pool, usersTable, clientsTable, letterSendsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

/**
 * The client account after the 2026-09-15 walkthrough: master accounts with
 * related properties, contacts, do-not-email, sales details, the map pin and
 * the billing rules. Everything goes through the HTTP routes with the
 * test-only auth header, the way integration.test.ts does it.
 */
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[] };

let admin: { id: number };
let contractor: { id: number };
let master: { id: number; name: string };
let propertyA: { id: number; name: string };
let propertyB: { id: number; name: string };
let other: { id: number; name: string };

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

const patch = (path: string, data: unknown) =>
  api(path, admin.id, { method: "PATCH", body: JSON.stringify(data) });
const post = (path: string, data: unknown) =>
  api(path, admin.id, { method: "POST", body: JSON.stringify(data) });

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const [a, c] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_acct_admin_${stamp}`, name: "Account Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `test_acct_contractor_${stamp}`, name: "Account Contractor", role: "contractor" },
    ])
    .returning();
  admin = a;
  contractor = c;
  ids.users.push(a.id, c.id);

  const [m, pa, pb, o] = await db
    .insert(clientsTable)
    .values([
      { name: `Test HOA Master ${stamp}`, status: "client", serviceAddress: "1 Board Rd" },
      { name: `Test Property A ${stamp}`, status: "client", serviceAddress: "10 Breaux Dr" },
      { name: `Test Property B ${stamp}`, status: "client", serviceAddress: "12 Breaux Dr" },
      { name: `Test Neighbour ${stamp}`, status: "client", serviceAddress: "99 Elm St" },
    ])
    .returning();
  master = m;
  propertyA = pa;
  propertyB = pb;
  other = o;
  ids.clients.push(m.id, pa.id, pb.id, o.id);
});

after(async () => {
  // Clients cascade their invoices, contacts and audit rows.
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---- master account and related properties ----

test("a property goes under a master account and both sides can see it", async () => {
  const linked = await patch(`/clients/${propertyA.id}`, { parentClientId: master.id });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.parentClientId, master.id);
  assert.equal(linked.body.parentClientName, master.name);

  const m = await api(`/clients/${master.id}`, admin.id);
  assert.equal(m.body.relatedPropertyCount, 1);
  assert.equal(m.body.parentClientId, null);
});

test("a customer cannot be their own master", async () => {
  const r = await patch(`/clients/${propertyA.id}`, { parentClientId: propertyA.id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /own master/);
});

test("master accounts go one level deep only", async () => {
  // A is a property under the master, so it cannot be a master for B.
  const underProperty = await patch(`/clients/${propertyB.id}`, { parentClientId: propertyA.id });
  assert.equal(underProperty.status, 400);
  assert.match(underProperty.body.error, /already a property/);

  // The master has a property under it, so it cannot itself go under someone.
  const masterUnderOther = await patch(`/clients/${master.id}`, { parentClientId: other.id });
  assert.equal(masterUnderOther.status, 400);
  assert.match(masterUnderOther.body.error, /Take those properties off first/);

  const missing = await patch(`/clients/${propertyB.id}`, { parentClientId: 999_999_999 });
  assert.equal(missing.status, 400);
});

test("each property keeps its own invoices and the master sees the total", async () => {
  const linkedB = await patch(`/clients/${propertyB.id}`, { parentClientId: master.id });
  assert.equal(linkedB.status, 200);

  const invA = await post("/invoices", { clientId: propertyA.id, total: 100 });
  assert.equal(invA.status, 201, JSON.stringify(invA.body));
  const invB = await post("/invoices", { clientId: propertyB.id, total: 50.5 });
  assert.equal(invB.status, 201, JSON.stringify(invB.body));

  const m = await api(`/clients/${master.id}`, admin.id);
  assert.equal(m.body.accountBalance, 0, "the master owes nothing of its own");
  assert.equal(m.body.relatedBalanceTotal, 150.5, "but sees what the properties owe in all");
  assert.equal(m.body.relatedPropertyCount, 2);

  const related = await api(`/clients/${master.id}/related`, admin.id);
  assert.equal(related.status, 200);
  assert.deepEqual(
    related.body.map((c: any) => [c.name, c.accountBalance]),
    [
      [propertyA.name, 100],
      [propertyB.name, 50.5],
    ],
  );

  // Nothing moved onto the master's own ledger.
  const masterInvoices = await api(`/invoices?clientId=${master.id}`, admin.id);
  assert.equal(masterInvoices.status, 200);
  assert.equal(masterInvoices.body.length, 0);

  // A property's own page shows its own balance and its own master, not the total.
  const a = await api(`/clients/${propertyA.id}`, admin.id);
  assert.equal(a.body.accountBalance, 100);
  assert.equal(a.body.relatedBalanceTotal, 100);
  assert.equal(a.body.parentClientName, master.name);
});

test("the list route carries the same figures without breaking", async () => {
  const list = await api(`/clients?search=${encodeURIComponent(master.name)}`, admin.id);
  assert.equal(list.status, 200);
  const row = list.body.find((c: any) => c.id === master.id);
  assert.ok(row);
  assert.equal(row.relatedBalanceTotal, 150.5);
});

test("taking a property off the master is audited on both accounts", async () => {
  const r = await patch(`/clients/${propertyA.id}`, { parentClientId: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.parentClientId, null);
  assert.equal(r.body.parentClientName, null);

  const m = await api(`/clients/${master.id}`, admin.id);
  assert.equal(m.body.relatedBalanceTotal, 50.5);
  assert.equal(m.body.relatedPropertyCount, 1);

  const auditA = await api(`/clients/${propertyA.id}/audit`, admin.id);
  const actions = auditA.body.map((e: any) => e.action);
  assert.ok(actions.includes("master_account_set"), "linking was audited");
  assert.ok(actions.includes("master_account_removed"), "unlinking was audited");
  const removed = auditA.body.find((e: any) => e.action === "master_account_removed");
  assert.match(removed.description, new RegExp(master.name));

  const auditM = await api(`/clients/${master.id}/audit`, admin.id);
  const masterActions = auditM.body.map((e: any) => e.action);
  assert.ok(masterActions.includes("related_property_added"));
  assert.ok(masterActions.includes("related_property_removed"));
});

test("deleting a master leaves its properties standing on their own", async () => {
  const [m2] = await db
    .insert(clientsTable)
    .values({ name: `Test Master Two ${Date.now()}`, status: "client" })
    .returning();
  ids.clients.push(m2.id);
  const linked = await patch(`/clients/${propertyA.id}`, { parentClientId: m2.id });
  assert.equal(linked.status, 200);

  const gone = await api(`/clients/${m2.id}`, admin.id, { method: "DELETE" });
  assert.equal(gone.status, 204);
  const [a] = await db.select().from(clientsTable).where(eq(clientsTable.id, propertyA.id));
  assert.ok(a, "the property was not deleted with the master");
  assert.equal(a.parentClientId, null);
});

// ---- contacts ----

test("contacts: add, edit, remove, all audited", async () => {
  const created = await post(`/clients/${propertyA.id}/contacts`, {
    name: "  Duffy Mitchell ",
    role: "CPA",
    email: "kobystull123@gmail.com",
    birthday: "03-14",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.name, "Duffy Mitchell", "trimmed");
  assert.equal(created.body.role, "CPA");
  assert.equal(created.body.birthday, "03-14");
  assert.equal(created.body.phone, null);

  const list = await api(`/clients/${propertyA.id}/contacts`, admin.id);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);

  const edited = await patch(`/client-contacts/${created.body.id}`, { phone: "208-555-0100", role: "" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.phone, "208-555-0100");
  assert.equal(edited.body.role, null, "blank clears the field");
  assert.equal(edited.body.name, "Duffy Mitchell", "untouched fields stay");

  const removed = await api(`/client-contacts/${created.body.id}`, admin.id, { method: "DELETE" });
  assert.equal(removed.status, 204);
  const after = await api(`/clients/${propertyA.id}/contacts`, admin.id);
  assert.equal(after.body.length, 0);
  const again = await api(`/client-contacts/${created.body.id}`, admin.id, { method: "DELETE" });
  assert.equal(again.status, 404);

  const audit = await api(`/clients/${propertyA.id}/audit`, admin.id);
  const actions = audit.body.map((e: any) => e.action);
  for (const expected of ["contact_added", "contact_updated", "contact_removed"]) {
    assert.ok(actions.includes(expected), `${expected} was audited`);
  }
});

test("contacts: a name is required and a birthday must be a real date", async () => {
  const blank = await post(`/clients/${propertyA.id}/contacts`, { name: "   " });
  assert.equal(blank.status, 400);
  const badDate = await post(`/clients/${propertyA.id}/contacts`, { name: "Someone", birthday: "March 14" });
  assert.equal(badDate.status, 400);
  assert.match(badDate.body.error, /yyyy-mm-dd/);
  const badMonth = await post(`/clients/${propertyA.id}/contacts`, { name: "Someone", birthday: "1990-13-01" });
  assert.equal(badMonth.status, 400);
  const noClient = await post(`/clients/999999999/contacts`, { name: "Someone" });
  assert.equal(noClient.status, 404);
});

test("contacts are office-only", async () => {
  const r = await api(`/clients/${propertyA.id}/contacts`, contractor.id);
  assert.ok([401, 403].includes(r.status), `got ${r.status}`);
  const anon = await api(`/clients/${propertyA.id}/contacts`, null);
  assert.equal(anon.status, 401);
});

// ---- do not email ----

test("do-not-email is a switch on the account and is audited both ways", async () => {
  const on = await patch(`/clients/${propertyA.id}`, { doNotEmail: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.doNotEmail, true);
  const off = await patch(`/clients/${propertyA.id}`, { doNotEmail: false });
  assert.equal(off.body.doNotEmail, false);

  const audit = await api(`/clients/${propertyA.id}/audit`, admin.id);
  const actions = audit.body.map((e: any) => e.action);
  assert.ok(actions.includes("do_not_email_on"));
  assert.ok(actions.includes("do_not_email_off"));
  const onLine = audit.body.find((e: any) => e.action === "do_not_email_on");
  assert.match(onLine.description, /invoices still go out/i);
});

test("the spring letter run skips a do-not-email customer by name, before any mail is tried", async () => {
  // Property B has no email at all, so if the switch were ignored the run would
  // fail it with "No email address" rather than skip it. The switch must win.
  await patch(`/clients/${propertyB.id}`, { doNotEmail: true });
  const { deliverSpringLetters } = await import("../src/lib/letterDelivery.ts");
  const run = await deliverSpringLetters([propertyB.id]);
  assert.equal(run.sent, 0);
  assert.equal(run.outcomes.length, 1);
  assert.equal(run.outcomes[0].clientName, propertyB.name);
  assert.match(run.outcomes[0].error ?? "", /Do not email/);
  const [record] = await db.select().from(letterSendsTable).where(eq(letterSendsTable.clientId, propertyB.id));
  assert.equal(record.status, "skipped");
  assert.equal(record.sentToEmail, null);
  await patch(`/clients/${propertyB.id}`, { doNotEmail: false });
});

// ---- sales ----

test("sources are whatever customers already carry, and referred-by points at a customer", async () => {
  const stamp = Date.now();
  const sourceA = `Door Hanger ${stamp}`;
  const sourceB = `Google Adwords ${stamp}`;
  assert.equal((await patch(`/clients/${propertyA.id}`, { source: sourceA })).status, 200);
  assert.equal((await patch(`/clients/${propertyB.id}`, { source: sourceB })).status, 200);
  assert.equal((await patch(`/clients/${other.id}`, { source: "" })).status, 200, "blank is allowed");

  const sources = await api("/clients/sources", admin.id);
  assert.equal(sources.status, 200);
  assert.ok(sources.body.includes(sourceA));
  assert.ok(sources.body.includes(sourceB));
  assert.ok(!sources.body.includes(""), "blank never shows up as a choice");
  const sorted = [...sources.body].sort((x: string, y: string) => x.localeCompare(y));
  assert.deepEqual(sources.body, sorted, "A to Z");

  const self = await patch(`/clients/${propertyA.id}`, { referredByClientId: propertyA.id });
  assert.equal(self.status, 400);
  const missing = await patch(`/clients/${propertyA.id}`, { referredByClientId: 999_999_999 });
  assert.equal(missing.status, 400);
  const ok = await patch(`/clients/${propertyA.id}`, { referredByClientId: other.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.referredByClientName, other.name);
  const cleared = await patch(`/clients/${propertyA.id}`, { referredByClientId: null });
  assert.equal(cleared.body.referredByClientName, null);
});

// ---- map pin ----

test("latitude and longitude are checked, and go together", async () => {
  const tooFar = await patch(`/clients/${propertyA.id}`, { lat: 95, lng: -116.8 });
  assert.equal(tooFar.status, 400);
  const tooWide = await patch(`/clients/${propertyA.id}`, { lat: 47.7, lng: -181 });
  assert.equal(tooWide.status, 400);
  const half = await patch(`/clients/${propertyA.id}`, { lat: 47.7, lng: null });
  assert.equal(half.status, 400);
  assert.match(half.body.error, /go together/);

  const ok = await patch(`/clients/${propertyA.id}`, { lat: 47.7376681798218, lng: -116.828796201061 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.lat, 47.7376681798218);
  assert.equal(ok.body.lng, -116.828796201061);

  const cleared = await patch(`/clients/${propertyA.id}`, { lat: null, lng: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.lat, null);
});

// ---- billing ----

test("invoices by email need an address; print never does", async () => {
  // Property B has no email of any kind.
  const email = await patch(`/clients/${propertyB.id}`, { invoiceDelivery: "email" });
  assert.equal(email.status, 400);
  assert.match(email.body.error, /billing email or a notification email/);
  const both = await patch(`/clients/${propertyB.id}`, { invoiceDelivery: "both" });
  assert.equal(both.status, 400);
  const print = await patch(`/clients/${propertyB.id}`, { invoiceDelivery: "print" });
  assert.equal(print.status, 200);

  // A billing email on its own is enough.
  const withBilling = await patch(`/clients/${propertyB.id}`, {
    billingEmail: "koby@radiantaisoftware.com",
    invoiceDelivery: "email",
  });
  assert.equal(withBilling.status, 200, JSON.stringify(withBilling.body));

  // Taking the only address away while delivery is still email is refused.
  const takeAway = await patch(`/clients/${propertyB.id}`, { billingEmail: null });
  assert.equal(takeAway.status, 400);
});

test("an imported row that already breaks the rule can still be edited elsewhere", async () => {
  // Straight into the table, the way the import did it: email delivery, no address.
  await db
    .update(clientsTable)
    .set({ invoiceDelivery: "email", email: null, billingEmail: null })
    .where(eq(clientsTable.id, other.id));
  const r = await patch(`/clients/${other.id}`, { mapCode: "PF", preferredPaymentMethod: "venmo", state: "WA" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.preferredPaymentMethod, "venmo");
  assert.equal(r.body.state, "WA");

  const bad = await patch(`/clients/${other.id}`, { preferredPaymentMethod: "bitcoin" });
  assert.equal(bad.status, 400);
});

test("on an imported row, changing only the phone still saves even though the card resends the blank email", async () => {
  // The Personal info card always sends the email box, filled in or not. On an
  // imported row that is already set to email with no address, resending the
  // same blank email is not a change and must not cost the office the phone
  // number it actually typed.
  await db
    .update(clientsTable)
    .set({ invoiceDelivery: "email", email: null, billingEmail: null })
    .where(eq(clientsTable.id, other.id));

  const overviewSave = await patch(`/clients/${other.id}`, {
    name: other.name,
    phone: "208-555-0142",
    email: null,
    serviceAddress: "99 Elm St",
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
  });
  assert.equal(overviewSave.status, 200, JSON.stringify(overviewSave.body));
  assert.equal(overviewSave.body.phone, "208-555-0142", "the phone change was kept");
  assert.equal(overviewSave.body.invoiceDelivery, "email", "delivery left alone");

  // Resending the same delivery it already has is not a change either.
  const sameDelivery = await patch(`/clients/${other.id}`, { invoiceDelivery: "email", email: null });
  assert.equal(sameDelivery.status, 200, JSON.stringify(sameDelivery.body));

  // But actually moving a row to email with nowhere to send it is still refused.
  await db.update(clientsTable).set({ invoiceDelivery: "print" }).where(eq(clientsTable.id, other.id));
  const switchOn = await patch(`/clients/${other.id}`, { invoiceDelivery: "email", email: null });
  assert.equal(switchOn.status, 400);
  assert.match(switchOn.body.error, /billing email or a notification email/);
});

test("saving a contact with nothing changed hands it back instead of failing", async () => {
  const created = await post(`/clients/${propertyA.id}/contacts`, { name: "Empty Save Test", role: "HOA" });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const empty = await patch(`/client-contacts/${created.body.id}`, {});
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.id, created.body.id);
  assert.equal(empty.body.name, "Empty Save Test", "nothing was wiped");
  assert.equal(empty.body.role, "HOA");

  const gone = await patch(`/client-contacts/999999999`, {});
  assert.equal(gone.status, 404);

  await api(`/client-contacts/${created.body.id}`, admin.id, { method: "DELETE" });
});

test("the customer page throws its edit boxes away when you switch customers", async () => {
  // One page serves every /clients/:id, so a customer coming back out of the
  // react-query cache never shows "Loading" — without a key the edit boxes keep
  // the customer you were just looking at, and Save writes their name and
  // address onto this one. This is the only guard the web side has for it.
  const page = await readFile(
    new URL("../../bison-crm/src/pages/client-detail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    page,
    /<div key=\{client\.id\} className="flex flex-col h-\[calc\(100vh-2rem\)\]"/,
    "the client page body must be keyed on client.id so every card re-seeds",
  );
});

test("creating a customer checks the same links and pin", async () => {
  const badPin = await post("/clients", { name: `Test Create ${Date.now()}`, lat: 200, lng: 0 });
  assert.equal(badPin.status, 400);
  const badMaster = await post("/clients", { name: `Test Create ${Date.now()}`, parentClientId: 999_999_999 });
  assert.equal(badMaster.status, 400);

  const ok = await post("/clients", {
    name: `Test Created Property ${Date.now()}`,
    parentClientId: master.id,
    source: "Postcard",
    doNotEmail: true,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  ids.clients.push(ok.body.id);
  assert.equal(ok.body.parentClientName, master.name);
  assert.equal(ok.body.doNotEmail, true);
  assert.equal(ok.body.relatedBalanceTotal, 0);
});
