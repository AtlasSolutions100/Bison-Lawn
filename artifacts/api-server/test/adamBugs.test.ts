import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  auditEventsTable,
  clientsTable,
  clientServicesTable,
  estimateFieldsTable,
  estimatesTable,
  invitationsTable,
  invoicesTable,
  invoiceLineItemsTable,
  jobsTable,
  servicesTable,
  usersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { resolveAccountForClerkId } = await import("../src/lib/userAccounts.ts");
const { todayLocal } = await import("../src/lib/jobGeneration.ts");
// The estimate builder's own copy of the pricing, run here against the real
// save route. It is a mirror, and a mirror nothing pins is a mirror that
// drifts: that drift is exactly how the screen said $1,260 while the saved
// quote said $2,660 for the same 28 mows.
const {
  calculableNeedsNumber,
  fieldLinePrice,
  prefillFieldValue,
  serviceLineMath,
} = await import("../../bison-crm/src/components/estimates/service-pricing.ts");

/**
 * The three bugs Adam reported on 2026-09-28 (notes B1, B2, B3).
 *
 * B1 "when creating an estimate the numbers don't match the matrix based on
 * clients account — example 615 E 18th": an estimate line, the price the same
 * service gets when it is assigned to the account, and the live tester on the
 * Services page all have to come out at the same number for the same lawn.
 * B2 "accepted contractor not popping up on dispatch board": whoever he just
 * added has to be someone he can send to a job.
 * B3 "creating invoice needs to show up on clients account": a bill he raises
 * is on the customer's account straight away.
 */

let server: Server;
let baseUrl: string;

const stamp = Date.now();
const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
  fields: [] as number[],
  estimates: [] as number[],
  clientServices: [] as number[],
  invoices: [] as number[],
  jobs: [] as number[],
  invitations: [] as number[],
};

let admin: { id: number };
/** His own property, with the square footage written the way the import wrote it. */
let client: { id: number; name: string };
let turf: { id: number; label: string };
let zones: { id: number; label: string };
let gateCode: { id: number; label: string };
let mowing: { id: number; name: string };
let blowOut: { id: number; name: string };
let flatRateService: { id: number; name: string };

const ACCOUNT_SQFT = 14500;
/** What his imported account actually holds for that field: a comma in it. */
const ACCOUNT_SQFT_AS_IMPORTED = "14,500";

async function api(path: string, userId: number | null, init: RequestInit = {}): Promise<{ status: number; body: any }> {
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

/** What the live tester on the Services page says this lawn costs. */
async function matrixTester(serviceId: number, value: number): Promise<number> {
  const res = await api(`/services/${serviceId}/price`, admin.id, {
    method: "POST",
    body: JSON.stringify({ sqft: value }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.price;
}

/** What one service line on a new estimate comes out at. */
async function estimateLine(line: Record<string, unknown>, extra: Record<string, unknown>[] = []) {
  const res = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [...extra, line] }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  ids.estimates.push(res.body.id);
  return res.body.lines[res.body.lines.length - 1];
}

/** What the assign-a-service dialog on the account offers as the price. */
async function assignedPrice(serviceId: number, opts: Record<string, unknown> = {}) {
  const res = await api(`/clients/${client.id}/service-price`, admin.id, {
    method: "POST",
    body: JSON.stringify({ serviceId, ...opts }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a] = await db
    .insert(usersTable)
    .values([{ clerkId: `test_bugs_admin_${stamp}`, name: "Bug Admin", role: "admin", roleSource: "owner_assigned" }])
    .returning();
  admin = a;
  ids.users.push(a.id);

  const fields = await db
    .insert(estimateFieldsTable)
    .values([
      { label: `Bug Turf Sqft ${stamp}`, fieldType: "calculable", pricePerUnit: 2, unitSize: 100, sortOrder: 90 },
      { label: `Bug Sprinkler Zones ${stamp}`, fieldType: "calculable", pricePerUnit: 12, unitSize: 1, sortOrder: 91 },
      { label: `Bug Gate Code ${stamp}`, fieldType: "text", sortOrder: 92 },
    ])
    .returning();
  [turf, zones, gateCode] = fields;
  ids.fields.push(...fields.map((f) => f.id));

  const services = await db
    .insert(servicesTable)
    .values([
      {
        name: `Bug Mowing ${stamp}`,
        rate: 45,
        pricingFieldId: turf.id,
        pricingEquations: [
          // A placeholder row left by an "Add tier" click — his real matrices
          // have them, and nothing may price a job off one.
          { upToSqft: 2000, basePrice: 0, baseSqft: 0, incrementPrice: 0, incrementSqft: 0 },
          { upToSqft: 5000, basePrice: 40, baseSqft: 5000, incrementPrice: 5, incrementSqft: 1000 },
          { upToSqft: null, basePrice: 70, baseSqft: 10000, incrementPrice: 6, incrementSqft: 1000 },
        ],
      },
      {
        // Priced by zone count, not square footage: the number the matrix wants
        // is not the same number for every service on the account.
        name: `Bug Blow-Out ${stamp}`,
        rate: 95,
        pricingFieldId: zones.id,
        pricingEquations: [{ upToSqft: null, basePrice: 95, baseSqft: 4, incrementPrice: 10, incrementSqft: 1 }],
      },
      { name: `Bug Fall Clean-Up ${stamp}`, rate: 220 },
    ])
    .returning();
  [mowing, blowOut, flatRateService] = services;
  ids.services.push(...services.map((s) => s.id));

  const [c] = await db
    .insert(clientsTable)
    .values({
      name: `Bug 615 E 18th ${stamp}`,
      status: "client",
      serviceAddress: "615 E 18th Ave",
      city: "Post Falls",
      email: "koby@radiantaisoftware.com",
      billingTerms: "Net 15",
      propertyData: { [turf.label]: ACCOUNT_SQFT_AS_IMPORTED, [gateCode.label]: "4417" },
    })
    .returning();
  client = c;
  ids.clients.push(c.id);
});

after(async () => {
  await db.delete(auditEventsTable).where(inArray(auditEventsTable.clientId, ids.clients));
  if (ids.invoices.length) {
    await db.delete(invoiceLineItemsTable).where(inArray(invoiceLineItemsTable.invoiceId, ids.invoices));
  }
  if (ids.clients.length) await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, ids.clients));
  if (ids.jobs.length) await db.delete(jobsTable).where(inArray(jobsTable.id, ids.jobs));
  if (ids.clientServices.length) {
    await db.delete(clientServicesTable).where(inArray(clientServicesTable.id, ids.clientServices));
  }
  if (ids.estimates.length) await db.delete(estimatesTable).where(inArray(estimatesTable.id, ids.estimates));
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.fields.length) await db.delete(estimateFieldsTable).where(inArray(estimateFieldsTable.id, ids.fields));
  if (ids.invitations.length) await db.delete(invitationsTable).where(inArray(invitationsTable.id, ids.invitations));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

// ---------------------------------------------------------------- B1 ----

test("B1: the estimate line, the assigned service and the matrix tester all say the same number", async () => {
  const tester = await matrixTester(mowing.id, ACCOUNT_SQFT);
  // 70 for the first 10,000, then 6 per 1,000 of the remaining 4,500.
  assert.equal(tester, 100, "the tester prices the top band");

  const assigned = await assignedPrice(mowing.id);
  assert.equal(assigned.amount, tester, "assigning it to the account gives the tester's price");
  assert.equal(assigned.pricedFromLabel, turf.label);
  assert.equal(assigned.pricedFromValue, ACCOUNT_SQFT, "the comma in the imported sqft is not a reason to give up");
  assert.equal(assigned.missingField, null);

  // The box on the line left empty, which is what a package drop-in or a
  // carried-over line sends. The estimate has to read the account the way the
  // assign dialog does instead of quietly quoting the flat rate.
  const blank = await estimateLine({ serviceId: mowing.id, label: mowing.name, value: "" });
  assert.equal(blank.unitPrice, tester, "an empty measurement falls back to the account, not to the flat rate");
  assert.equal(blank.calculatedPrice, tester);
  assert.equal(blank.value, String(ACCOUNT_SQFT), "the quote shows which number produced the rate");

  // The same measurement typed by hand, commas and all.
  const typed = await estimateLine({ serviceId: mowing.id, label: mowing.name, value: ACCOUNT_SQFT_AS_IMPORTED });
  assert.equal(typed.unitPrice, tester, "a typed '14,500' is the same lawn as 14500");
  assert.equal(typed.value, String(ACCOUNT_SQFT));
});

test("B1: a measurement typed on this estimate beats the one on file, and the line beats both", async () => {
  // He re-measured on site: 6,000 instead of the 14,500 the account holds.
  const remeasured = await estimateLine(
    { serviceId: mowing.id, label: mowing.name, value: "" },
    [{ fieldId: turf.id, label: turf.label, value: "6000" }],
  );
  const tester = await matrixTester(mowing.id, 6000);
  // Past the 5,000 band, so it is the open-ended one: $70 up to its own 10,000
  // base, with nothing added yet.
  assert.equal(tester, 70);
  assert.notEqual(tester, 100, "which is not what the account's 14,500 would have cost");
  assert.equal(remeasured.unitPrice, tester, "the estimate's own field wins over the account");

  // And a number typed on the line itself wins over everything.
  const online = await estimateLine(
    { serviceId: mowing.id, label: mowing.name, value: "3000" },
    [{ fieldId: turf.id, label: turf.label, value: "6000" }],
  );
  assert.equal(online.unitPrice, await matrixTester(mowing.id, 3000));
});

test("B1: an empty band never prices a job, on any path", async () => {
  // 1,500 sqft lands inside the placeholder band. Both the tester and the
  // estimate have to skip it and use the first band that carries money.
  const tester = await matrixTester(mowing.id, 1500);
  assert.equal(tester, 40, "the $0 placeholder row is not a price");
  const line = await estimateLine({ serviceId: mowing.id, label: mowing.name, value: "1500" });
  assert.equal(line.unitPrice, tester);
  const assigned = await assignedPrice(mowing.id, { sqft: 1500 });
  assert.equal(assigned.amount, tester);
});

test("B1: each service reads the detail it prices from, not whatever number is lying around", async () => {
  // The blow-out prices by zones, and this account has no zone count on file,
  // so it is the flat rate — and it says which detail is missing rather than
  // borrowing the mowing sqft.
  const assigned = await assignedPrice(blowOut.id);
  assert.equal(assigned.amount, 95);
  assert.equal(assigned.missingField, zones.label);

  const line = await estimateLine({ serviceId: blowOut.id, label: blowOut.name, value: "" });
  assert.equal(line.unitPrice, 95, "no zone count anywhere means the flat rate on the estimate too");

  // Fill the zone count in on the estimate and all three agree again.
  const withZones = await estimateLine(
    { serviceId: blowOut.id, label: blowOut.name, value: "" },
    [{ fieldId: zones.id, label: zones.label, value: "8" }],
  );
  const tester = await matrixTester(blowOut.id, 8);
  assert.equal(tester, 135, "95 for the first 4 zones plus 10 each for the next 4");
  assert.equal(withZones.unitPrice, tester);
});

test("B1: rate x quantity x visits still holds, and a service with no matrix is still a flat rate", async () => {
  const line = await estimateLine({ serviceId: mowing.id, label: mowing.name, value: "", quantity: 2, visits: 28 });
  assert.equal(line.unitPrice, 100);
  assert.equal(line.calculatedPrice, 100 * 2 * 28);

  const flat = await estimateLine({ serviceId: flatRateService.id, label: flatRateService.name, value: "" });
  assert.equal(flat.unitPrice, 220);
});

test("B1: a comma does not make a property detail unusable, and nonsense still is", async () => {
  const good = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [{ fieldId: turf.id, label: turf.label, value: "14,500" }] }),
  });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  ids.estimates.push(good.body.id);
  assert.equal(good.body.lines[0].value, "14500", "stored without the comma, so the account keeps a clean number");
  assert.equal(good.body.lines[0].calculatedPrice, 290, "14,500 / 100 x $2");

  const bad = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [{ fieldId: turf.id, label: turf.label, value: "about an acre" }] }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /needs a numeric value/);
});

test("B1: pointing a matrix at a detail that carries no number is still refused", async () => {
  const [textPriced] = await db
    .insert(servicesTable)
    .values({
      name: `Bug Gate Priced ${stamp}`,
      rate: 50,
      pricingFieldId: gateCode.id,
      pricingEquations: [{ upToSqft: null, basePrice: 60, baseSqft: 1, incrementPrice: 0, incrementSqft: 0 }],
    })
    .returning();
  ids.services.push(textPriced.id);
  const res = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [{ serviceId: textPriced.id, label: textPriced.name, value: "4417" }],
    }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /text field and has no number to price against/);
});

test("B1: a band whose whole price is its floor agrees on all three paths too", async () => {
  // "Never less than $49" with no base and no step under it. The floor is a
  // price, so the band is a real band — and the estimate builder draws this
  // number on screen from its own copy of the maths, so the three paths
  // agreeing here is what stops the quote he is reading and the quote the
  // customer gets being different again.
  const [floored] = await db
    .insert(servicesTable)
    .values({
      name: `Bug Floor Mow ${stamp}`,
      rate: 30,
      pricingFieldId: turf.id,
      pricingEquations: [
        { upToSqft: null, basePrice: 0, baseSqft: 0, incrementPrice: 5, incrementSqft: 1000, minPrice: 49 },
      ],
    })
    .returning();
  ids.services.push(floored.id);

  // 4,000 sqft works out at $20, so the floor is the whole price.
  const small = await matrixTester(floored.id, 4000);
  assert.equal(small, 49, "the floor, not the $20 the equation worked out");
  const smallLine = await estimateLine({ serviceId: floored.id, label: floored.name, value: "4000" });
  assert.equal(smallLine.unitPrice, small);
  assert.equal((await assignedPrice(floored.id, { sqft: 4000 })).amount, small);

  // 14,500 sqft is past the floor, so the equation takes over — which is the
  // sentence he could not write before.
  const big = await matrixTester(floored.id, ACCOUNT_SQFT);
  assert.equal(big, 75, "15 steps of 1,000 at $5, the floor already cleared");
  const bigLine = await estimateLine({ serviceId: floored.id, label: floored.name, value: "" });
  assert.equal(bigLine.unitPrice, big, "and the account's own sqft gets there with the box left empty");
  assert.equal((await assignedPrice(floored.id)).amount, big);
});

// ------------------------------------------- B1: screen vs what is saved ----

/** The services and property details exactly as the builder's screen reads them. */
async function screenData(): Promise<{ services: any[]; fields: any[] }> {
  const svc = await api("/services", admin.id);
  assert.equal(svc.status, 200, JSON.stringify(svc.body));
  const flds = await api("/estimate-fields", admin.id);
  assert.equal(flds.status, 200, JSON.stringify(flds.body));
  return { services: svc.body, fields: flds.body };
}

/** One line in the builder, the way the screen holds it before anything is saved. */
const draftLine = (service: any, value: string, quantity = "", visits = "") => ({
  key: 1,
  serviceId: service.id,
  label: service.name,
  value,
  quantity,
  visits,
  packageId: null,
  packageKey: null,
  packageName: null,
});

test("B1: with the sqft box empty, the price on the builder's screen is the price that gets saved", async () => {
  const { services, fields } = await screenData();
  const mow = services.find((s) => s.id === mowing.id);
  // What he does: add Weekly Mowing, type 28 mows, then clear the sqft box
  // because he wanted the plain flat rate for this one.
  const sources = { fields, fieldValues: {}, propertyData: { [turf.label]: ACCOUNT_SQFT_AS_IMPORTED } };
  const shown = serviceLineMath(mow, draftLine(mow, "", "1", "28"), sources);
  const saved = await estimateLine({ serviceId: mowing.id, label: mowing.name, value: "", quantity: 1, visits: 28 });

  assert.equal(shown.rate, saved.unitPrice, "the per-visit rate on screen is the one that gets stored");
  assert.equal(shown.total, saved.calculatedPrice, "and so is the line total");
  assert.equal(shown.total, 100 * 28, "$2,800, not the $1,260 the flat rate used to draw");
  assert.notEqual(shown.total, mow.rate * 28, "the flat rate is not what either side says");
  // The amber "no sqft to price from" note may not appear while there is one on
  // file, because the save is going to use it.
  assert.equal(shown.fromMatrix, true);
  assert.equal(shown.measuredFrom, "account", "and the screen can say where the number came from");
  assert.equal(shown.measurement, ACCOUNT_SQFT, "the comma in the imported sqft is not a reason to give up");
});

test("B1: the screen reads the measurement in the same order the save does", async () => {
  const { services, fields } = await screenData();
  const mow = services.find((s) => s.id === mowing.id);
  const account = { [turf.label]: ACCOUNT_SQFT_AS_IMPORTED };

  // Re-measured on site and ticked on this estimate: 6,000 beats the account.
  const ticked = { fields, fieldValues: { [turf.id]: { selected: true, value: "6000" } }, propertyData: account };
  const onEstimate = serviceLineMath(mow, draftLine(mow, ""), ticked);
  const savedOnEstimate = await estimateLine({ serviceId: mowing.id, label: mowing.name, value: "" }, [
    { fieldId: turf.id, label: turf.label, value: "6000" },
  ]);
  assert.equal(onEstimate.rate, savedOnEstimate.unitPrice, "6,000 sqft on both sides");
  assert.equal(onEstimate.measuredFrom, "estimate");

  // A detail he unticked is never sent, so it may not price the screen either —
  // the account is what the save falls back to, and the screen has to agree.
  const unticked = { fields, fieldValues: { [turf.id]: { selected: false, value: "6000" } }, propertyData: account };
  const offAccount = serviceLineMath(mow, draftLine(mow, ""), unticked);
  const savedOffAccount = await estimateLine({ serviceId: mowing.id, label: mowing.name, value: "" });
  assert.equal(offAccount.rate, savedOffAccount.unitPrice);
  assert.equal(offAccount.measuredFrom, "account");
  assert.notEqual(offAccount.rate, onEstimate.rate, "which is a different lawn from the 6,000 he unticked");

  // A number typed on the line beats both, commas and all.
  const typed = serviceLineMath(mow, draftLine(mow, "3,000"), ticked);
  const savedTyped = await estimateLine({ serviceId: mowing.id, label: mowing.name, value: "3,000" }, [
    { fieldId: turf.id, label: turf.label, value: "6000" },
  ]);
  assert.equal(typed.rate, savedTyped.unitPrice);
  assert.equal(typed.measuredFrom, "line");
});

test("B1: the flat-rate note on screen is only true when no detail anywhere has a number", async () => {
  const { services, fields } = await screenData();
  // The blow-out prices by zone count, and this account has no zone count on
  // file. It must not borrow the mowing sqft to look clever.
  const blow = services.find((s) => s.id === blowOut.id);
  const sources = { fields, fieldValues: {}, propertyData: { [turf.label]: ACCOUNT_SQFT_AS_IMPORTED } };
  const shown = serviceLineMath(blow, draftLine(blow, ""), sources);
  assert.equal(shown.fromMatrix, false, "so the amber note is the truth here");
  assert.equal(shown.measuredFrom, null);
  assert.equal(shown.rate, 95, "the flat rate");
  const saved = await estimateLine({ serviceId: blowOut.id, label: blowOut.name, value: "" });
  assert.equal(shown.rate, saved.unitPrice, "and the save says the same");
});

test("B1: a comma in an imported sqft does not hold the Save button down", async () => {
  const { fields } = await screenData();
  const turfField = fields.find((f) => f.id === turf.id);
  const gateField = fields.find((f) => f.id === gateCode.id);

  // What the prefill copies out of his imported account, verbatim.
  assert.equal(
    calculableNeedsNumber(turfField, ACCOUNT_SQFT_AS_IMPORTED),
    false,
    "the comma is a number, so Save stays live",
  );
  assert.equal(fieldLinePrice(turfField, ACCOUNT_SQFT_AS_IMPORTED), 290, "and the row shows $290, not 'Enter a number'");

  // The server has to come out at the same figure, or one of the two is lying.
  const saved = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [{ fieldId: turf.id, label: turf.label, value: ACCOUNT_SQFT_AS_IMPORTED }],
    }),
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  ids.estimates.push(saved.body.id);
  assert.equal(fieldLinePrice(turfField, ACCOUNT_SQFT_AS_IMPORTED), saved.body.lines[0].calculatedPrice);

  // Still blocked on what the server really refuses, and never on a detail
  // that was never a number.
  assert.equal(calculableNeedsNumber(turfField, "about an acre"), true);
  assert.equal(calculableNeedsNumber(turfField, ""), true);
  assert.equal(calculableNeedsNumber(gateField, ""), false, "a gate code was never a number");

  // The sqft box is a number box, which shows nothing at all for "14,500", so
  // the prefill puts the plain number in and he sees the measurement he has.
  assert.deepEqual(prefillFieldValue(turfField, ACCOUNT_SQFT_AS_IMPORTED), { selected: true, value: "14500" });
  assert.deepEqual(prefillFieldValue(gateField, "4,417-B"), { selected: true, value: "4,417-B" });
  assert.deepEqual(prefillFieldValue(turfField, undefined), { selected: false, value: "" });
});

// ---------------------------------------------------------------- B2 ----

test("B2: someone who accepts an office invitation can be sent to a job", async () => {
  const email = `bug-eich-${stamp}@example.com`;
  // What Adam types on the Team page: a full user, not a "contractor".
  const [invitation] = await db
    .insert(invitationsTable)
    .values({ email, role: "admin", accessLevel: "full", invitedById: admin.id, invitedByName: "Bug Admin" })
    .returning();
  ids.invitations.push(invitation.id);

  const accepted = await resolveAccountForClerkId(
    `test_bug_eich_${stamp}`,
    { name: "Adam Eich Test", email, emailVerified: true },
    { role: "contractor", roleSource: "provisioned" },
  );
  assert.ok(accepted, "the invitation provisions an account");
  ids.users.push(accepted.id);

  // This is the whole bug: accepting a full/office invitation makes the role
  // "admin", because the role follows the level he picked. A board that only
  // offered role 'contractor' could never offer the person he had just added.
  assert.equal(accepted.role, "admin");
  assert.equal(accepted.accessLevel, "full");
  assert.equal(accepted.active, true);

  const users = await api("/users", admin.id);
  assert.equal(users.status, 200);
  const listed = users.body.find((u: any) => u.id === accepted.id);
  assert.ok(listed, "the person is on GET /users, which is what the board reads");
  assert.notEqual(listed.role, "contractor", "so the old role filter hid them");

  // The rule the board uses now: every live account is offerable. Proven by
  // actually sending them to a job.
  const offerable = users.body.filter((u: any) => u.active !== false).map((u: any) => u.id);
  assert.ok(offerable.includes(accepted.id));

  const [job] = await db
    .insert(jobsTable)
    .values({ clientId: client.id, serviceId: mowing.id, amount: 100, dispatched: true, scheduledDate: todayLocal() })
    .returning();
  ids.jobs.push(job.id);

  const assign = await api("/jobs/bulk-action", admin.id, {
    method: "POST",
    body: JSON.stringify({ jobIds: [job.id], action: "assign", assignedToId: accepted.id }),
  });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));

  const board = await api(`/jobs?date=${todayLocal()}&assignedTo=${accepted.id}`, admin.id);
  assert.equal(board.status, 200);
  const onBoard = board.body.find((j: any) => j.id === job.id);
  assert.ok(onBoard, "the job is on his board under the person who accepted");
  assert.equal(onBoard.assignedToName, "Adam Eich Test");
});

test("B2: someone he switched off is not offered", async () => {
  const [off] = await db
    .insert(usersTable)
    .values({
      clerkId: `test_bug_off_${stamp}`,
      name: "Retired Sub",
      email: `bug-retired-${stamp}@example.com`,
      role: "contractor",
      roleSource: "provisioned",
      active: false,
    })
    .returning();
  ids.users.push(off.id);

  const users = await api("/users", admin.id);
  assert.equal(
    users.body.some((u: any) => u.id === off.id),
    false,
    "GET /users already keeps a switched-off person out of every dropdown",
  );
});

// ---------------------------------------------------------------- B3 ----

test("B3: a bill he raises is on the customer's account straight away", async () => {
  const before = await api(`/invoices?clientId=${client.id}`, admin.id);
  assert.equal(before.status, 200);
  const countBefore = before.body.length;

  const created = await api("/invoices", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      poNumber: "PO-615",
      lines: [
        { description: "Mowing — 8/12, 8/19, 8/26", quantity: 3, unitPrice: 50 },
        { description: "Haul-away", quantity: 1, unitPrice: 35 },
      ],
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ids.invoices.push(created.body.id);
  assert.equal(created.body.total, 185, "the lines are the invoice");
  assert.equal(created.body.terms, "Net 15", "terms come off the account and are snapshotted");
  // A bill the office typed line by line counts as checked, so it is not
  // parked in Needs verification where he would never see it on the account.
  assert.equal(created.body.needsVerification, false);

  const after = await api(`/invoices?clientId=${client.id}`, admin.id);
  assert.equal(after.body.length, countBefore + 1, "the Accounting panel's list has it");
  const listed = after.body.find((i: any) => i.id === created.body.id);
  assert.ok(listed);
  assert.equal(listed.balance, 185, "and it is owed");

  // The balance at the top of the account, which the panel and the bill both
  // read, counts it.
  const account = await api(`/clients/${client.id}`, admin.id);
  assert.equal(account.body.accountBalance, 185);

  // And the timeline, so "what happened on this account" shows it being raised.
  const activity = await api(`/client-activity?clientId=${client.id}`, admin.id);
  assert.equal(activity.status, 200);
  const invoiceItem = activity.body.find((i: any) => i.kind === "invoice" && i.refId === created.body.id);
  assert.ok(invoiceItem, "the bill is on the timeline");
  assert.equal(invoiceItem.amount, 185);
  const event = activity.body.find(
    (i: any) => i.kind === "event" && i.refKind === "audit" && /Created invoice/.test(i.title),
  );
  assert.ok(event, "and who raised it is written down");
  assert.match(event.title, /#\d+ for \$185\.00/);
});

test("B3: a bill nobody has checked yet is on the account, marked as not issued", async () => {
  // A completion the clock produced goes into Needs verification. It still has
  // to be visible on the account — he asked for bills to show up there — but it
  // is not something the customer owes until it has been looked at.
  const [pending] = await db
    .insert(invoicesTable)
    .values({ clientId: client.id, number: 999000 + (stamp % 1000), total: 60, status: "open" })
    .returning();
  ids.invoices.push(pending.id);

  const list = await api(`/invoices?clientId=${client.id}`, admin.id);
  const listed = list.body.find((i: any) => i.id === pending.id);
  assert.ok(listed, "an unverified bill is still on the account's list");
  assert.equal(listed.needsVerification, true, "flagged, so the panel can offer Verify and keep it out of the balance");
});

test("B3: an invoice for a customer who does not exist is refused, not silently filed", async () => {
  const res = await api("/invoices", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: 2147483000, lines: [{ description: "Mowing", quantity: 1, unitPrice: 50 }] }),
  });
  assert.equal(res.status, 404);
});
