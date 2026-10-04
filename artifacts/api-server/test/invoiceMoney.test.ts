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
  invoiceLineItemsTable,
  paymentsTable,
  servicesTable,
  estimateFieldsTable,
  billingSettingsTable,
  auditEventsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { balanceOf } = await import("../src/lib/invoiceDocument.ts");
const { owesNothing, isWriteOff } = await import("../src/lib/invoiceStatus.ts");
const { recalcClientBalance } = await import("../src/lib/helpers.ts");

/**
 * The money side of his 2026-09-28 notes: unlock a bill that already went out,
 * get rid of a balance he will never collect without deleting the invoice,
 * take a payment at the door, find the customer by anything on their account,
 * price a service off that customer's matrix, and read one running total that
 * explains itself.
 *
 * The cases that matter here are the ones that cost money if they are wrong:
 * writing off a part-paid bill must take off only the unpaid part, a sub who
 * was never trusted with cash must be refused, and unlocking must not quietly
 * leave a bill looking sent.
 */

let server: Server;
let baseUrl: string;

const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
  fields: [] as number[],
};

let admin: { id: number };
let sub: { id: number }; // mobile-only, not trusted with money until he says so
let strangerSub: { id: number }; // never sent to this property
let wagner: { id: number; name: string }; // the Jackie Wagner case
let other: { id: number };
let summary: { id: number }; // kept clean so the running total adds up exactly
let mowing: { id: number };
let flatService: { id: number };
let turfLabel: string;
let originalFieldPaymentIds: number[] = [];

async function api(
  path: string,
  init: RequestInit & { asUser?: number } = {},
): Promise<{ status: number; body: any }> {
  const { asUser, ...rest } = init;
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      "x-test-user-id": String(asUser ?? admin.id),
      "x-test-auth-token": TEST_AUTH_TOKEN,
      ...(rest.headers ?? {}),
    },
  });
  const raw = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: type.includes("json") && raw.length ? JSON.parse(raw.toString()) : null };
}

const post = (path: string, body?: unknown, asUser?: number) =>
  api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), asUser });
const patch = (path: string, body: unknown, asUser?: number) =>
  api(path, { method: "PATCH", body: JSON.stringify(body), asUser });

/** A bill that has already been checked and emailed, the way a real one gets there. */
async function sentInvoice(clientId: number, total: number, paid = 0) {
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      clientId,
      total,
      amountPaid: paid,
      status: paid >= total ? "paid" : paid > 0 ? "partial" : "open",
      invoiceDate: "2026-08-01",
      dueDate: "2026-08-16",
      terms: "Net 15",
      verifiedAt: new Date("2026-08-02T10:00:00Z"),
      verifiedById: admin.id,
      deliveryMethod: "email",
      sentAt: new Date("2026-08-02T11:00:00Z"),
    })
    .returning();
  await db.insert(invoiceLineItemsTable).values({
    invoiceId: inv.id,
    description: "Weekly mowing",
    quantity: 1,
    unitPrice: total,
    total,
    sortOrder: 0,
  });
  if (paid > 0) {
    await db.insert(paymentsTable).values({ clientId, invoiceId: inv.id, amount: paid, method: "check" });
  }
  await recalcClientBalance(clientId);
  return inv;
}

const auditActions = async (clientId: number) =>
  (await db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, clientId))).map((e) => ({
    action: e.action,
    description: e.description,
  }));

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const people = await db
    .insert(usersTable)
    .values([
      { clerkId: `im_admin_${stamp}`, name: "Money Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `im_sub_${stamp}`, name: "Disa Nelson", role: "contractor", accessLevel: "mobile", permissions: [] },
      { clerkId: `im_other_${stamp}`, name: "Spencer Eich", role: "contractor", accessLevel: "mobile", permissions: [] },
    ])
    .returning();
  [admin, sub, strangerSub] = people;
  ids.users.push(...people.map((p) => p.id));

  const [turf] = await db
    .insert(estimateFieldsTable)
    .values({ label: `Turf Sqft ${stamp}`, fieldType: "calculable" })
    .returning();
  turfLabel = turf.label;
  ids.fields.push(turf.id);

  const clients = await db
    .insert(clientsTable)
    .values([
      {
        name: `Jackie Wagner ${stamp}`,
        status: "client",
        accountNumber: `SA-${stamp}`,
        serviceAddress: "615 E 18th Ave",
        city: "Post Falls",
        postalCode: "83854",
        phone: "(208) 555-0142",
        email: "koby@radiantaisoftware.com",
        invoiceDelivery: "email",
        billingTerms: "Net 15",
        propertyData: { [turfLabel]: "6,200" },
      },
      {
        name: `Hayden Holdings ${stamp}`,
        status: "client",
        serviceAddress: "9 Lakeview Dr",
        city: "Hayden",
        email: "koby@radiantaisoftware.com",
        invoiceDelivery: "email",
        propertyData: {},
      },
      {
        name: `Summary Customer ${stamp}`,
        status: "client",
        serviceAddress: "41 Ramsey Rd",
        city: "Coeur d'Alene",
        email: "koby@radiantaisoftware.com",
        invoiceDelivery: "email",
        propertyData: {},
      },
    ])
    .returning();
  [wagner, other, summary] = clients;
  ids.clients.push(...clients.map((c) => c.id));

  const services = await db
    .insert(servicesTable)
    .values([
      {
        name: `Matrix Mowing ${stamp}`,
        rate: 45,
        invoiceDescription: "Weekly mowing and trim",
        pricingFieldId: turf.id,
        // Up to 5,000 sqft $49; up to 10,000 sqft $63. Wagner's 6,200 lands in
        // the second band, so her bill must say $63 and not the $45 flat rate.
        pricingEquations: [
          { upToSqft: 5000, basePrice: 49, baseSqft: 0, incrementPrice: 0, incrementSqft: 0, budgetedHours: 0.5, budgetedCost: null },
          { upToSqft: 10000, basePrice: 63, baseSqft: 0, incrementPrice: 0, incrementSqft: 0, budgetedHours: 1, budgetedCost: null },
        ],
      },
      { name: `Flat Cleanup ${stamp}`, rate: 120, invoiceDescription: "Spring clean up" },
    ])
    .returning();
  [mowing, flatService] = services;
  ids.services.push(...services.map((s) => s.id));

  // His real card fee, switched on, and the field-payment list emptied so the
  // refusal below is the one a brand new sub would hit. Both are put back after.
  const [settings] = await db.select().from(billingSettingsTable);
  originalFieldPaymentIds = settings?.fieldPaymentUserIds ?? [];
  if (settings) {
    await db
      .update(billingSettingsTable)
      .set({ cardFeeEnabled: true, cardFeePercent: 3, fieldPaymentUserIds: [] })
      .where(eq(billingSettingsTable.id, settings.id));
  }
});

after(async () => {
  const [settings] = await db.select().from(billingSettingsTable);
  if (settings) {
    await db
      .update(billingSettingsTable)
      .set({ fieldPaymentUserIds: originalFieldPaymentIds })
      .where(eq(billingSettingsTable.id, settings.id));
  }
  if (ids.clients.length) {
    await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, ids.clients));
    const mine = await db.select({ id: invoicesTable.id }).from(invoicesTable).where(inArray(invoicesTable.clientId, ids.clients));
    if (mine.length) {
      await db.delete(invoiceLineItemsTable).where(inArray(invoiceLineItemsTable.invoiceId, mine.map((i) => i.id)));
    }
    await db.delete(jobsTable).where(inArray(jobsTable.clientId, ids.clients));
    await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, ids.clients));
    await db.delete(auditEventsTable).where(inArray(auditEventsTable.clientId, ids.clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.fields.length) await db.delete(estimateFieldsTable).where(inArray(estimateFieldsTable.id, ids.fields));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

// ---- A4: what a status means for the money ---------------------------------

test("balanceOf owes nothing on void, written off and collections, and keeps counting on the rest", () => {
  assert.equal(balanceOf({ total: 300, amountPaid: 100, status: "open" }), 200);
  assert.equal(balanceOf({ total: 300, amountPaid: 100, status: "void" }), 0);
  assert.equal(balanceOf({ total: 300, amountPaid: 100, status: "written_off" }), 0);
  assert.equal(balanceOf({ total: 300, amountPaid: 100, status: "collections" }), 0);
  // Overpaid never reads as a negative balance on the bill; the extra is credit.
  assert.equal(balanceOf({ total: 100, amountPaid: 140, status: "open" }), 0);
  assert.ok(owesNothing("written_off") && owesNothing("collections") && owesNothing("void"));
  assert.ok(!owesNothing("open") && !owesNothing("partial") && !owesNothing("paid"));
  assert.ok(isWriteOff("collections") && !isWriteOff("void"));
});

// ---- M1: unlock a sent invoice ---------------------------------------------

test("unlocking a sent bill puts it back in Needs verification and remembers the copy the customer holds", async () => {
  const inv = await sentInvoice(other.id, 180);

  const before = await api(`/invoices/${inv.id}`);
  assert.equal(before.body.needsVerification, false, "a sent bill is not waiting on anybody");

  const unlocked = await post(`/invoices/${inv.id}/unlock`, { reason: "Wrong price on the aeration line" });
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
  assert.equal(unlocked.body.needsVerification, true, "back in Needs verification");
  assert.equal(unlocked.body.sentAt, null, "it no longer looks emailed");
  assert.equal(unlocked.body.verifiedAt, null, "and it has to be checked again");
  assert.ok(unlocked.body.previouslySentAt, "the day they got the old copy is kept");
  assert.equal(unlocked.body.unlockedByName, "Money Admin", "with the name of whoever did it");
  assert.equal(unlocked.body.status, "pending", "an unpaid unlocked bill reads as pending again");

  const queue = await api(`/invoices?queue=pending&clientId=${other.id}`);
  assert.ok((queue.body as { id: number }[]).some((i) => i.id === inv.id), "and it is in the queue he looks at");
  const emailable = await api(`/invoices?queue=to_email&clientId=${other.id}`);
  assert.ok(!(emailable.body as { id: number }[]).some((i) => i.id === inv.id), "nothing emails it until it is verified again");

  const sendNow = await post(`/invoices/${inv.id}/send`, {});
  assert.equal(sendNow.status, 400, "and it cannot be sent while unverified");

  const audit = await auditActions(other.id);
  const line = audit.find((a) => a.action === "invoice_unlocked");
  assert.ok(line, "unlocking is audited");
  assert.match(line!.description, /customer already has the copy/i);
  assert.match(line!.description, /Wrong price on the aeration line/);
  assert.match(line!.description, /back in Needs verification/i);

  // Verifying it again sends it back to the email queue, which is the whole
  // point: the customer must get the new one.
  const reverified = await post(`/invoices/${inv.id}/verify`, {});
  assert.equal(reverified.status, 200, JSON.stringify(reverified.body));
  const again = await api(`/invoices?queue=to_email&clientId=${other.id}`);
  assert.ok((again.body as { id: number }[]).some((i) => i.id === inv.id), "it is waiting to be emailed again");
});

test("unlock refuses the bills where it would mean nothing", async () => {
  const pendingOne = await db
    .insert(invoicesTable)
    .values({ clientId: other.id, total: 50, status: "pending", invoiceDate: "2026-08-20" })
    .returning();
  const already = await post(`/invoices/${pendingOne[0].id}/unlock`, {});
  assert.equal(already.status, 400);
  assert.match(already.body.error, /already in Needs verification/i);

  const voided = await sentInvoice(other.id, 90);
  await patch(`/invoices/${voided.id}`, { status: "void" });
  const onVoid = await post(`/invoices/${voided.id}/unlock`, {});
  assert.equal(onVoid.status, 400);
  assert.match(onVoid.body.error, /void/i);

  const missing = await post(`/invoices/999999999/unlock`, {});
  assert.equal(missing.status, 404);
});

// ---- M2: the Jackie Wagner case -------------------------------------------

test("writing off a part-paid balance takes off only the part nobody will pay", async () => {
  const inv = await sentInvoice(wagner.id, 300, 100);
  const [beforeClient] = await db.select().from(clientsTable).where(eq(clientsTable.id, wagner.id));
  const before = beforeClient.accountBalance;

  const done = await post(`/invoices/${inv.id}/write-off`, { how: "written_off", reason: "House sold, no forwarding address" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, "written_off");
  assert.equal(done.body.balance, 0, "it owes nothing");
  assert.equal(done.body.amountPaid, 100, "the money she did pay stays on the bill");
  assert.equal(done.body.writtenOffAmount, 200, "and the account says what was let go");
  assert.equal(done.body.writeOffLabel, "Written off");
  assert.equal(done.body.writtenOffByName, "Money Admin");
  assert.equal(done.body.writeOffReason, "House sold, no forwarding address");

  const lines = await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, inv.id));
  assert.equal(lines.length, 1, "the bill and its lines are still there — nothing was deleted");

  const [afterClient] = await db.select().from(clientsTable).where(eq(clientsTable.id, wagner.id));
  assert.equal(
    Math.round((before - afterClient.accountBalance) * 100) / 100,
    200,
    "exactly the unpaid $200 comes off what she owes, not the whole $300",
  );

  const open = await api(`/invoices?queue=open&clientId=${wagner.id}`);
  assert.ok(!(open.body as { id: number }[]).some((i) => i.id === inv.id), "it is out of Open");
  const pastDue = await api(`/invoices?queue=past_due&clientId=${wagner.id}`);
  assert.ok(!(pastDue.body as { id: number }[]).some((i) => i.id === inv.id), "and out of Past due, so he stops ringing her");
  const writtenOff = await api(`/invoices?queue=written_off&clientId=${wagner.id}`);
  assert.ok((writtenOff.body as { id: number }[]).some((i) => i.id === inv.id), "it has its own tab");

  const audit = await auditActions(wagner.id);
  const line = audit.find((a) => a.action === "invoice_written_off");
  assert.ok(line, "the write-off is audited");
  assert.match(line!.description, /\$200\.00/, "with the amount");
  assert.match(line!.description, /House sold/, "and the reason");
  assert.match(line!.description, /\$100\.00 already paid stays/);

  // Putting it back is the undo a wrong write-off needs.
  const back = await post(`/invoices/${inv.id}/write-off`, { how: "restore" });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.status, "partial", "the status follows the money again");
  assert.equal(back.body.balance, 200, "and the balance is owed once more");
  const [restored] = await db.select().from(clientsTable).where(eq(clientsTable.id, wagner.id));
  assert.equal(Math.round(restored.accountBalance * 100) / 100, Math.round(before * 100) / 100);
  assert.ok((await auditActions(wagner.id)).some((a) => a.action === "invoice_write_off_undone"));
});

test("collections is the same arithmetic with its own answer to why", async () => {
  const inv = await sentInvoice(wagner.id, 150);
  const done = await post(`/invoices/${inv.id}/write-off`, { how: "collections", reason: "Passed to Pacific Recovery" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, "collections");
  assert.equal(done.body.balance, 0);
  assert.equal(done.body.writeOffLabel, "Sent to collections");

  const twice = await post(`/invoices/${inv.id}/write-off`, { how: "collections" });
  assert.equal(twice.status, 400, "doing it twice is refused rather than audited twice");

  const nothingOwed = await sentInvoice(wagner.id, 80, 80);
  const paid = await post(`/invoices/${nothingOwed.id}/write-off`, { how: "written_off" });
  assert.equal(paid.status, 400);
  assert.match(paid.body.error, /Nothing is owed/i);

  assert.ok((await auditActions(wagner.id)).some((a) => a.action === "invoice_sent_to_collections"));

  // A written-off bill is not a bill anybody pays against.
  const pay = await post(`/payments`, { clientId: wagner.id, invoiceId: inv.id, amount: 10, method: "cash" });
  assert.ok(pay.status >= 400, `a payment on a written-off bill is refused (got ${pay.status})`);
});

// ---- M4: find the customer, price the service -----------------------------

test("the customer is found by anything on their account, and each match says what matched", async () => {
  const byAddress = await api(`/invoices/customer-search?q=615 E 18th`);
  assert.equal(byAddress.status, 200, JSON.stringify(byAddress.body));
  const addressHit = (byAddress.body as any[]).find((c) => c.id === wagner.id);
  assert.ok(addressHit, "his own property address finds her");
  assert.equal(addressHit.matchedOn, "address");

  const byAccount = await api(`/invoices/customer-search?q=${encodeURIComponent(`SA-${wagner.name.split(" ").pop()}`)}`);
  assert.equal(byAccount.status, 200);

  const [row] = await db.select().from(clientsTable).where(eq(clientsTable.id, wagner.id));
  const exact = await api(`/invoices/customer-search?q=${encodeURIComponent(row.accountNumber!)}`);
  assert.equal(exact.body[0].id, wagner.id, "an exact account number comes back first");
  assert.equal(exact.body[0].matchedOn, "account number");

  // Typed the way it is on the cheque stub, with no brackets or dashes.
  const byPhone = await api(`/invoices/customer-search?q=2085550142`);
  assert.ok((byPhone.body as any[]).some((c) => c.id === wagner.id), "digits alone find the phone number");

  const byZip = await api(`/invoices/customer-search?q=83854`);
  assert.ok((byZip.body as any[]).some((c) => c.id === wagner.id));

  const nothing = await api(`/invoices/customer-search?q=`);
  assert.equal(nothing.status, 400, "an empty search is a question, not a list of 709 people");
});

test("adding a service to a bill prices it off that customer's matrix, not the flat rate", async () => {
  const priced = await post(`/invoices/price-service`, { clientId: wagner.id, serviceId: mowing.id });
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  assert.equal(priced.body.unitPrice, 63, "6,200 sqft lands in the second band");
  assert.equal(priced.body.flatRate, 45, "and the flat rate it did NOT use is shown");
  assert.equal(priced.body.fromMatrix, true);
  assert.equal(priced.body.pricedFromLabel, turfLabel);
  assert.equal(priced.body.pricedFromValue, 6200);
  assert.equal(priced.body.description, "Weekly mowing and trim", "the line reads the way the bill prints");

  // A measurement he re-took on site beats the one on file.
  const remeasured = await post(`/invoices/price-service`, { clientId: wagner.id, serviceId: mowing.id, measurement: 4000 });
  assert.equal(remeasured.body.unitPrice, 49);
  assert.equal(remeasured.body.pricedFromValue, 4000);

  // Quantity is kept separate, because the invoice line prints a rate and a count.
  const three = await post(`/invoices/price-service`, { clientId: wagner.id, serviceId: mowing.id, quantity: 3 });
  assert.equal(three.body.unitPrice, 63, "the rate per visit, not the total");
  assert.equal(three.body.total, 189);

  // No measurement on this account: the flat rate, and it says so instead of
  // quietly charging the wrong price.
  const missing = await post(`/invoices/price-service`, { clientId: other.id, serviceId: mowing.id });
  assert.equal(missing.body.unitPrice, 45);
  assert.equal(missing.body.fromMatrix, false);
  assert.equal(missing.body.missingField, turfLabel);

  // A service with no matrix at all is just its rate, with nothing missing.
  const flat = await post(`/invoices/price-service`, { clientId: other.id, serviceId: flatService.id });
  assert.equal(flat.body.unitPrice, 120);
  assert.equal(flat.body.missingField, null);

  const noCustomer = await post(`/invoices/price-service`, { clientId: 999999999, serviceId: mowing.id });
  assert.equal(noCustomer.status, 404);
});

// ---- M3: take a payment in the field --------------------------------------

test("a sub who was never trusted with money is refused, in words he can act on", async () => {
  const [job] = await db
    .insert(jobsTable)
    .values({
      clientId: wagner.id,
      serviceId: mowing.id,
      assignedToId: sub.id,
      status: "in_progress",
      dispatched: true,
      visibleToContractor: true,
      scheduledDate: "2026-09-28",
      amount: 63,
    })
    .returning();

  const options = await api(`/my/jobs/${job.id}/field-payment`, { asUser: sub.id });
  assert.equal(options.status, 200, "the screen still loads, so it can say why");
  assert.equal(options.body.allowed, false);
  assert.match(options.body.reason, /Ask Adam to tick you/i);
  assert.equal(options.body.invoices.length, 0, "and it does not hand him the customer's bills");

  const tried = await post(`/my/jobs/${job.id}/field-payment`, { amount: 50, method: "cash" }, sub.id);
  assert.equal(tried.status, 403, "and the write is refused, not just the screen");

  // Somebody else's job is a flat no even once he is trusted with money.
  await patch(`/billing-settings`, { fieldPaymentUserIds: [sub.id, strangerSub.id] });
  const notTheirs = await api(`/my/jobs/${job.id}/field-payment`, { asUser: strangerSub.id });
  assert.equal(notTheirs.status, 403);
  assert.match(notTheirs.body.error, /not yours/i);

  const settingsAudit = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "billing_settings_updated"));
  assert.ok(
    settingsAudit.some((a) => /Disa Nelson/.test(a.description ?? "")),
    "who he trusted with money is audited by name",
  );

  await db.delete(jobsTable).where(eq(jobsTable.id, job.id));
});

test("a trusted sub takes the cheque for last month's bill, with the card fee disclosed and added", async () => {
  const bill = await sentInvoice(wagner.id, 220);
  const [job] = await db
    .insert(jobsTable)
    .values({
      clientId: wagner.id,
      serviceId: mowing.id,
      assignedToId: sub.id,
      status: "in_progress",
      dispatched: true,
      visibleToContractor: true,
      scheduledDate: "2026-09-28",
      amount: 63,
    })
    .returning();

  const options = await api(`/my/jobs/${job.id}/field-payment`, { asUser: sub.id });
  assert.equal(options.body.allowed, true);
  assert.equal(options.body.cardFeeEnabled, true);
  assert.equal(options.body.cardFeePercent, 3);
  assert.ok(
    (options.body.invoices as { id: number }[]).some((i) => i.id === bill.id),
    "the bill the customer is actually paying is on the list, not only today's job",
  );

  const taken = await post(`/my/jobs/${job.id}/field-payment`, { amount: 100, method: "credit_card", invoiceId: bill.id, reference: "4242" }, sub.id);
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  assert.equal(taken.body.baseAmount, 100);
  assert.equal(taken.body.cardFee, 3, "3% of $100");
  assert.equal(taken.body.amount, 103, "what the customer handed over");
  assert.equal(taken.body.invoiceBalance, 120, "$220 plus the $3 fee, less the $103 taken");

  const feeLine = (await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, bill.id))).find(
    (l) => l.description === "Card processing fee",
  );
  assert.ok(feeLine, "the surcharge is a line on the bill, so it survives the next edit");
  assert.equal(feeLine!.total, 3);

  // Cash takes no fee.
  const cash = await post(`/my/jobs/${job.id}/field-payment`, { amount: 20, method: "cash", invoiceId: bill.id }, sub.id);
  assert.equal(cash.status, 201, JSON.stringify(cash.body));
  assert.equal(cash.body.cardFee, 0);
  assert.equal(cash.body.amount, 20);

  // More than the bill: the rest is theirs, kept as credit rather than making
  // the invoice read as overpaid.
  const over = await post(`/my/jobs/${job.id}/field-payment`, { amount: 150, method: "check", invoiceId: bill.id, reference: "1182" }, sub.id);
  assert.equal(over.status, 201, JSON.stringify(over.body));
  assert.equal(over.body.invoiceBalance, 0, "the bill is settled");
  assert.equal(over.body.creditLeft, 50, "and $50 sits on the account");

  const [after] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, bill.id));
  assert.equal(after.status, "paid");

  const audit = await auditActions(wagner.id);
  const line = audit.find((a) => /in the field/.test(a.description ?? ""));
  assert.ok(line, "every field payment is audited");
  assert.match(line!.description, /card fee at 3%/);

  await db.delete(jobsTable).where(eq(jobsTable.id, job.id));
});

// ---- M5: the running total -------------------------------------------------

test("the running total explains every part of what the customer stands at", async () => {
  const bill = await sentInvoice(summary.id, 400, 150); // issued, part paid
  await db
    .insert(invoicesTable)
    .values({ clientId: summary.id, total: 75, status: "pending", invoiceDate: "2026-09-27" })
    .returning();
  await db.insert(paymentsTable).values({ clientId: summary.id, invoiceId: null, amount: 60, method: "check" });
  const [doneJob] = await db
    .insert(jobsTable)
    .values({ clientId: summary.id, serviceId: mowing.id, status: "completed", scheduledDate: "2026-09-26", amount: 90 })
    .returning();

  const res = await api(`/invoices/account-summary?clientId=${summary.id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body;

  assert.equal(s.owedNow, 250, "the $400 bill less the $150 paid on it");
  assert.equal(s.pastDue, 250, "and it is past its August due date");
  assert.equal(s.credit, 60, "money we are holding for them");
  assert.equal(s.notYetInvoiced, 90, "work finished with no bill on it");
  assert.equal(s.awaitingVerification, 75, "a bill we raised and have not checked is our delay, not their debt");
  assert.equal(s.notInvoicedJobCount, 1);
  assert.equal(s.runningTotal, Math.round((s.owedNow - s.credit) * 100) / 100, "the figure he quotes: owed less credit");
  assert.equal(
    s.withEverything,
    Math.round((s.runningTotal + s.awaitingVerification + s.notYetInvoiced) * 100) / 100,
    "and the whole picture adds up from the parts",
  );

  // Every figure comes back with the word that explains it, so the screen can
  // never label a number something the server did not mean.
  const byKey = new Map((s.parts as { key: string; label: string; explain: string; amount: number }[]).map((p) => [p.key, p]));
  for (const key of ["owedNow", "pastDue", "credit", "awaitingVerification", "notYetInvoiced", "writtenOff", "runningTotal"]) {
    const part = byKey.get(key);
    assert.ok(part, `${key} is on the strip`);
    assert.ok(part!.label.length > 0 && part!.explain.length > 0, `${key} says what it is in words`);
    assert.equal(part!.amount, s[key], `${key} on the strip is the same number as the field`);
  }

  // A written-off balance shows as given up on, and stops counting as owed.
  const owedBefore = s.owedNow;
  await post(`/invoices/${bill.id}/write-off`, { how: "written_off", reason: "Not worth the stamp" });
  const after = await api(`/invoices/account-summary?clientId=${summary.id}`);
  assert.equal(after.body.writtenOff, 250, "$400 less the $150 she paid");
  assert.equal(
    Math.round((owedBefore - after.body.owedNow) * 100) / 100,
    250,
    "and that much came off what they owe",
  );

  const noCustomer = await api(`/invoices/account-summary?clientId=999999999`);
  assert.equal(noCustomer.status, 404);
  const noId = await api(`/invoices/account-summary`);
  assert.equal(noId.status, 400);

  await db.delete(jobsTable).where(eq(jobsTable.id, doneJob.id));
});

// ---- the holes found after the build, each one real money ------------------

/** A throwaway customer of his own, so the arithmetic below is exact. */
async function freshClient(label: string) {
  const [row] = await db
    .insert(clientsTable)
    .values({
      name: `${label} ${Date.now()}`,
      status: "client",
      serviceAddress: "12 Seltice Way",
      city: "Post Falls",
      email: "koby@radiantaisoftware.com",
      invoiceDelivery: "email",
      propertyData: {},
    })
    .returning();
  ids.clients.push(row.id);
  return row;
}

/** A visit the sub can take money on: his, dispatched, visible to him. */
async function fieldJob(clientId: number, scheduledDate = "2026-09-28") {
  const [job] = await db
    .insert(jobsTable)
    .values({
      clientId,
      serviceId: mowing.id,
      assignedToId: sub.id,
      status: "in_progress",
      dispatched: true,
      visibleToContractor: true,
      scheduledDate,
      amount: 63,
    })
    .returning();
  return job;
}

test("a card payment put on the account credits what the customer bought, not the processor's cut too", async () => {
  const prepay = await freshClient("Prepay Customer");
  await patch(`/billing-settings`, { fieldPaymentUserIds: [sub.id] });
  const job = await fieldJob(prepay.id);

  // "No bill - put it on the account", amount 100, credit card, fee on at 3%.
  const taken = await post(
    `/my/jobs/${job.id}/field-payment`,
    { amount: 100, method: "credit_card", invoiceId: null, reference: "4242" },
    sub.id,
  );
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  assert.equal(taken.body.invoiceId, null, "nothing to attach it to");
  assert.equal(taken.body.baseAmount, 100);
  assert.equal(taken.body.cardFee, 0, "no bill to show the surcharge on, so no surcharge is taken");
  assert.equal(taken.body.amount, 100, "the customer hands over the $100 and nothing more");
  assert.equal(taken.body.accountBalance, -100, "and stands $100 in credit, not $103");

  const rows = await db.select().from(paymentsTable).where(eq(paymentsTable.clientId, prepay.id));
  assert.equal(rows.length, 1, "one payment row");
  assert.equal(rows[0].amount, 100, "credited the $100 they paid for");
  assert.equal(rows[0].cardFee, 0);
  const [afterClient] = await db.select().from(clientsTable).where(eq(clientsTable.id, prepay.id));
  assert.equal(Math.round(afterClient.accountBalance * 100) / 100, -100);
  const options = await api(`/my/jobs/${job.id}/field-payment`, { asUser: sub.id });
  assert.equal(options.body.credit, 100, "the credit the office can spend is the money that came in");

  const onAccount = (await db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, prepay.id))).find(
    (a) => a.action === "payment_recorded",
  );
  assert.ok(onAccount, "it is still audited");
  assert.match(onAccount!.description!, /kept as credit on the account/);
  assert.ok(!/card fee/.test(onAccount!.description!), "and the line does not claim a fee nobody was charged");

  // With a bill to carry the line, the fee is charged and disclosed exactly as
  // it was before - that path was never the broken one.
  const bill = await sentInvoice(prepay.id, 200);
  const onBill = await post(`/my/jobs/${job.id}/field-payment`, { amount: 100, method: "credit_card", invoiceId: bill.id }, sub.id);
  assert.equal(onBill.status, 201, JSON.stringify(onBill.body));
  assert.equal(onBill.body.cardFee, 3, "3% of $100");
  assert.equal(onBill.body.amount, 103, "what the customer handed over");
  const feeLine = (await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, bill.id))).find(
    (l) => l.description === "Card processing fee",
  );
  assert.ok(feeLine, "the surcharge is a line the customer can read");
  const [end] = await db.select().from(clientsTable).where(eq(clientsTable.id, prepay.id));
  assert.equal(
    Math.round(end.accountBalance * 100) / 100,
    0,
    "the $200 bill plus its $3 fee, less the $100 credit and the $103 taken - the books close",
  );

  await db.delete(jobsTable).where(eq(jobsTable.id, job.id));
});

test("the dashboard's open invoice figure drops a balance he wrote off", async () => {
  const start = (await api(`/dashboard/summary`)).body.openInvoiceTotal as number;
  const inv = await sentInvoice(wagner.id, 300, 100);

  const billed = await api(`/dashboard/summary`);
  assert.equal(billed.status, 200, JSON.stringify(billed.body));
  assert.equal(
    Math.round((billed.body.openInvoiceTotal - start) * 100) / 100,
    200,
    "the $200 still owed is on the headline figure",
  );

  await post(`/invoices/${inv.id}/write-off`, { how: "written_off", reason: "House sold, no forwarding address" });
  const after = await api(`/dashboard/summary`);
  assert.equal(
    Math.round((after.body.openInvoiceTotal - start) * 100) / 100,
    0,
    "and once he gives up on it, the first screen agrees with every other total",
  );
  const open = await api(`/invoices?queue=open&clientId=${wagner.id}`);
  assert.ok(!(open.body as { id: number }[]).some((i) => i.id === inv.id), "the list he clicks through to says the same");

  // Collections is the same arithmetic.
  const handed = await sentInvoice(wagner.id, 120);
  await post(`/invoices/${handed.id}/write-off`, { how: "collections" });
  const both = await api(`/dashboard/summary`);
  assert.equal(Math.round((both.body.openInvoiceTotal - start) * 100) / 100, 0);
});

test("the dispatch board stops telling the crew to ask for a balance he wrote off", async () => {
  const client = await freshClient("Dispatch Customer");
  const inv = await sentInvoice(client.id, 200);
  const [job] = await db
    .insert(jobsTable)
    .values({ clientId: client.id, serviceId: mowing.id, status: "scheduled", dispatched: true, scheduledDate: "2026-09-29", amount: 63 })
    .returning();

  const before = await api(`/jobs?clientId=${client.id}&date=2026-09-29`);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const card = (before.body as any[]).find((j) => j.id === job.id);
  assert.ok(card, "the stop is on the board");
  assert.equal(card.lastInvoiceBalance, 200, "while it is owed, the crew are told the $200");

  await post(`/invoices/${inv.id}/write-off`, { how: "written_off", reason: "Not worth the stamp" });
  const after = await api(`/jobs?clientId=${client.id}&date=2026-09-29`);
  const card2 = (after.body as any[]).find((j) => j.id === job.id);
  assert.ok(card2);
  assert.equal(card2.lastInvoiceNumber, inv.number ?? inv.id, "it is still the last bill they were sent");
  assert.equal(card2.lastInvoiceBalance, 0, "but nothing is owed on it any more");
  assert.equal(
    Math.round((card2.clientBalance ?? 0) * 100) / 100,
    0,
    "so the two money figures on the same card no longer contradict each other",
  );

  await db.delete(jobsTable).where(eq(jobsTable.id, job.id));
});

test("a bill written off before it was ever checked leaves the Needs verification queue", async () => {
  const client = await freshClient("Unchecked Customer");
  const [raw] = await db
    .insert(invoicesTable)
    .values({ clientId: client.id, total: 75, status: "pending", invoiceDate: "2026-09-27", deliveryMethod: "email" })
    .returning();
  await db.insert(invoiceLineItemsTable).values({
    invoiceId: raw.id,
    description: "Spring clean up",
    quantity: 1,
    unitPrice: 75,
    total: 75,
    sortOrder: 0,
  });
  await recalcClientBalance(client.id);

  const queued = await api(`/invoices?queue=pending&clientId=${client.id}`);
  assert.ok((queued.body as { id: number }[]).some((i) => i.id === raw.id), "it starts in Needs verification");

  const off = await post(`/invoices/${raw.id}/write-off`, { how: "written_off", reason: "Customer moved, no address" });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.needsVerification, false, "it is not waiting on him any more");

  const again = await api(`/invoices?queue=pending&clientId=${client.id}`);
  assert.ok(!(again.body as { id: number }[]).some((i) => i.id === raw.id), "and it is out of the tab and its count");
  const givenUp = await api(`/invoices?queue=written_off&clientId=${client.id}`);
  assert.ok((givenUp.body as { id: number }[]).some((i) => i.id === raw.id), "it sits in Written off instead");
  const strip = await api(`/invoices/account-summary?clientId=${client.id}`);
  assert.equal(strip.body.awaitingVerification, 0, "the tab and the running total finally say the same thing");
  assert.equal(strip.body.writtenOff, 75);

  // A bill he checked and then gave up on used to print, and stamp itself
  // printed, the way emailing it already refuses to.
  const sent = await sentInvoice(client.id, 90);
  await post(`/invoices/${sent.id}/write-off`, { how: "collections" });
  const pdf = await api(`/invoices/print.pdf?ids=${sent.id}`);
  assert.equal(pdf.status, 400, "nothing he handed to a collector goes in an envelope");
  assert.match(pdf.body.error, /written off/i);
  const [stamp] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, sent.id));
  assert.equal(stamp.printedAt, null, "and it is not stamped as printed");
});

test("the unlock line names the day the customer's copy went out in his own time zone", async () => {
  const client = await freshClient("Evening Send Customer");
  const inv = await sentInvoice(client.id, 140);
  // Emailed at half five in the evening in Post Falls, which is already the
  // next day in UTC - the hour a one-man office actually sends bills.
  await db
    .update(invoicesTable)
    .set({ sentAt: new Date("2026-08-03T00:30:00Z"), printedAt: null })
    .where(eq(invoicesTable.id, inv.id));

  const unlocked = await post(`/invoices/${inv.id}/unlock`, { reason: "Wrong price on the aeration line" });
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));

  const [line] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.entityId, inv.id), eq(auditEventsTable.action, "invoice_unlocked")));
  assert.ok(line, "unlocking is audited");
  assert.match(line.description!, /copy from 2026-08-02/, "the day it went out, not the UTC day after");
  assert.ok(!/2026-08-03/.test(line.description!), "the banner on the bill says Aug 2 and the history must agree");
});

test("a written-off bill's lines are locked, so the figure he let go cannot drift", async () => {
  const client = await freshClient("Locked Customer");
  const inv = await sentInvoice(client.id, 300, 100);
  const off = await post(`/invoices/${inv.id}/write-off`, { how: "written_off", reason: "Never going to see it" });
  assert.equal(off.body.writtenOffAmount, 200, "the history says $200 was let go");

  const edit = await patch(`/invoices/${inv.id}`, {
    lines: [{ description: "Weekly mowing", quantity: 1, unitPrice: 500, serviceDate: null }],
  });
  assert.equal(edit.status, 400, JSON.stringify(edit.body));
  assert.match(edit.body.error, /written off/i);
  assert.match(edit.body.error, /back to owed/i, "and it says what to do instead");
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv.id));
  assert.equal(row.total, 300, "nothing moved");
  assert.equal((await api(`/invoices/${inv.id}`)).body.writtenOffAmount, 200);

  // Putting it back to owed opens it up again, which is the way through.
  await post(`/invoices/${inv.id}/write-off`, { how: "restore" });
  const allowed = await patch(`/invoices/${inv.id}`, {
    lines: [{ description: "Weekly mowing", quantity: 1, unitPrice: 500, serviceDate: null }],
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.total, 500);
});

test("the timeline says a bill was written off, not that it was paid in full", async () => {
  const client = await freshClient("Timeline Customer");
  const written = await sentInvoice(client.id, 300, 100);
  const collected = await sentInvoice(client.id, 150);
  const settled = await sentInvoice(client.id, 80, 80);
  await post(`/invoices/${written.id}/write-off`, { how: "written_off", reason: "House sold" });
  await post(`/invoices/${collected.id}/write-off`, { how: "collections" });

  const res = await api(`/client-activity?clientId=${client.id}&kinds=invoice&from=2026-01-01`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byId = new Map((res.body as any[]).filter((i) => i.refKind === "invoice").map((i) => [i.refId, i]));
  assert.equal(byId.get(written.id)?.detail, "Written off", "it says what happened to her $200");
  assert.equal(byId.get(written.id)?.amount, 300, "beside the $300 the bill was for");
  assert.equal(byId.get(collected.id)?.detail, "Sent to collections");
  assert.equal(byId.get(settled.id)?.detail, "paid in full", "a bill they really paid still reads paid in full");
});
