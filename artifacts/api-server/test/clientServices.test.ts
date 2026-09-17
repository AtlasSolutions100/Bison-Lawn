import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  servicesTable,
  packagesTable,
  estimateFieldsTable,
  clientServicesTable,
  jobsTable,
  jobProductsTable,
  jobTimeEntriesTable,
  invoicesTable,
  invoiceLineItemsTable,
  chargePresetsTable,
  auditEventsTable,
  automationRunsTable,
  paymentsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { isoWeekNumber, nthWeekdayOfMonth, recurringDates, discountAmountFor, todayLocal } = await import("../src/lib/jobGeneration.ts");
const { runClientServiceDailyTasks, renewClientService, renewalDueDate, isRenewalDue, contractLastInstallment } =
  await import("../src/lib/clientServiceTick.ts");

let server: Server;
let baseUrl: string;

const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
  packages: [] as number[],
  fields: [] as number[],
  presets: [] as number[],
};

let admin: { id: number };
let eich: { id: number };
let otherSub: { id: number };
let client: { id: number };
let noSqftClient: { id: number };
let mowing: { id: number };
let cleanup: { id: number };
let blowout: { id: number };
let pkg: { id: number };
let bagFee: { id: number };
let officeOnlyPart: { id: number };

const TODAY = new Date().toISOString().slice(0, 10);
const YEAR = Number(TODAY.slice(0, 4));

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

const post = (path: string, userId: number, body: unknown) =>
  api(path, userId, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, userId: number, body: unknown) =>
  api(path, userId, { method: "PATCH", body: JSON.stringify(body) });

async function jobsFor(csId: number) {
  return db.select().from(jobsTable).where(eq(jobsTable.clientServiceId, csId)).orderBy(jobsTable.scheduledDate, jobsTable.id);
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const [a, e, o] = await db
    .insert(usersTable)
    .values([
      { clerkId: `cs_admin_${stamp}`, name: "CS Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `cs_eich_${stamp}`, name: "eich@example.com", displayName: "Eich", role: "contractor" },
      { clerkId: `cs_other_${stamp}`, name: "CS Other Sub", role: "contractor" },
    ])
    .returning();
  admin = a;
  eich = e;
  otherSub = o;
  ids.users.push(a.id, e.id, o.id);

  // The customer's own measurement, keyed by the field's label the way the
  // client page saves it.
  const [turf] = await db
    .insert(estimateFieldsTable)
    .values({ label: `Turf Sqft ${stamp}`, fieldType: "calculable" })
    .returning();
  ids.fields.push(turf.id);

  const [c, c2] = await db
    .insert(clientsTable)
    .values([
      { name: "CS Mow Customer", status: "client", propertyData: { [turf.label]: "6,200" } },
      { name: "CS No Sqft Customer", status: "client", propertyData: {} },
    ])
    .returning();
  client = c;
  noSqftClient = c2;
  ids.clients.push(c.id, c2.id);

  const [m, cl, b] = await db
    .insert(servicesTable)
    .values([
      {
        name: `Mowing ${stamp}`,
        code: "MOWIN",
        rate: 40,
        billableHours: 0.75,
        pricingFieldId: turf.id,
        // Up to 5,000 sqft $45; up to 10,000 sqft $58 with 1 h budgeted.
        pricingEquations: [
          { upToSqft: 5000, basePrice: 45, baseSqft: 0, incrementPrice: 0, incrementSqft: 0, budgetedHours: 0.5, budgetedCost: null },
          { upToSqft: 10000, basePrice: 58, baseSqft: 0, incrementPrice: 0, incrementSqft: 0, budgetedHours: 1, budgetedCost: null },
        ],
      },
      { name: `Spring Clean-up ${stamp}`, code: "CLEAN", rate: 65, billingMode: "time", billableHours: 3 },
      { name: `Blow-out ${stamp}`, code: "BLOW", rate: 90, defaultStartDate: "2020-10-01", defaultEndDate: "2020-10-31" },
    ])
    .returning();
  mowing = m;
  cleanup = cl;
  blowout = b;
  ids.services.push(m.id, cl.id, b.id);

  const [p] = await db
    .insert(packagesTable)
    .values({
      name: `Sprinkler Package ${stamp}`,
      serviceIds: [b.id, b.id],
      items: [{ serviceId: b.id, label: "Blow-out — October" }, { serviceId: b.id, label: "Blow-out — November" }],
      scheduleType: "window",
      startDate: `${YEAR}-10-01`,
      endDate: `${YEAR}-11-30`,
    })
    .returning();
  pkg = p;
  ids.packages.push(p.id);

  const [bf, op] = await db
    .insert(chargePresetsTable)
    .values([
      { label: `Bag fee ${stamp}`, defaultPrice: 4.5, kind: "product", unit: "bag", contractorCanAdd: true },
      { label: `Valve ${stamp}`, defaultPrice: 120, kind: "product", unit: "each", contractorCanAdd: false },
    ])
    .returning();
  bagFee = bf;
  officeOnlyPart = op;
  ids.presets.push(bf.id, op.id);
});

after(async () => {
  for (const clientId of ids.clients) {
    const jobIds = (await db.select({ id: jobsTable.id }).from(jobsTable).where(eq(jobsTable.clientId, clientId))).map((j) => j.id);
    if (jobIds.length) {
      await db.delete(jobTimeEntriesTable).where(inArray(jobTimeEntriesTable.jobId, jobIds));
      await db.delete(jobProductsTable).where(inArray(jobProductsTable.jobId, jobIds));
    }
    await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
    const invoiceIds = (await db.select({ id: invoicesTable.id }).from(invoicesTable).where(eq(invoicesTable.clientId, clientId))).map((i) => i.id);
    if (invoiceIds.length) await db.delete(invoiceLineItemsTable).where(inArray(invoiceLineItemsTable.invoiceId, invoiceIds));
    await db.delete(invoicesTable).where(eq(invoicesTable.clientId, clientId));
    await db.delete(jobsTable).where(eq(jobsTable.clientId, clientId));
    await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, clientId));
    await db.delete(auditEventsTable).where(eq(auditEventsTable.clientId, clientId));
  }
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.packages.length) await db.delete(packagesTable).where(inArray(packagesTable.id, ids.packages));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.fields.length) await db.delete(estimateFieldsTable).where(inArray(estimateFieldsTable.id, ids.fields));
  if (ids.presets.length) await db.delete(chargePresetsTable).where(inArray(chargePresetsTable.id, ids.presets));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---- cadence arithmetic ----

test("ISO week parity matches the calendar his board labels", () => {
  // 2026-09-16 is a Wednesday in ISO week 38 (an even week).
  assert.equal(isoWeekNumber("2026-09-16"), 38);
  // 2027-01-01 is a Friday and still belongs to week 53 of 2026.
  assert.equal(isoWeekNumber("2027-01-01"), 53);
  assert.equal(isoWeekNumber("2027-01-04"), 1);
});

test("the Nth weekday of a month, and null when the month has no such day", () => {
  // September 2026: Tuesdays are the 1st, 8th, 15th, 22nd, 29th.
  assert.equal(nthWeekdayOfMonth(2026, 9, 2, 1), "2026-09-01");
  assert.equal(nthWeekdayOfMonth(2026, 9, 2, 4), "2026-09-22");
  // February 2026 has only four Sundays, so a fifth is null.
  assert.equal(nthWeekdayOfMonth(2026, 2, 0, 5), null);
});

test("bi-weekly on odd weeks lands only on odd ISO weeks, from a first date in an even week", () => {
  const dates = recurringDates(
    { firstServiceDate: "2026-09-16", seasonEndDate: "2026-11-30", frequency: "biweekly", frequencyWeeks: 2, weekday: 3, weekParity: "odd", monthlyWeek: null },
    null,
  );
  assert.equal(dates[0], "2026-09-23", "the first odd-week Wednesday after the 16th");
  for (const d of dates) {
    assert.equal(isoWeekNumber(d) % 2, 1, `${d} should be an odd week`);
    assert.equal(new Date(`${d}T00:00:00Z`).getUTCDay(), 3, `${d} should be a Wednesday`);
  }
  for (let i = 1; i < dates.length; i++) {
    const gap = (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 86400000;
    assert.equal(gap, 14);
  }
});

test("monthly in week 2 gives the second Tuesday of each month through the season end", () => {
  const dates = recurringDates(
    { firstServiceDate: "2026-04-14", seasonEndDate: "2026-07-31", frequency: "monthly", frequencyWeeks: null, weekday: 2, weekParity: null, monthlyWeek: 2 },
    null,
  );
  assert.deepEqual(dates, ["2026-04-14", "2026-05-12", "2026-06-09", "2026-07-14"]);
});

test("a recurring row with no season end runs to December 31 instead of one visit", () => {
  const dates = recurringDates(
    { firstServiceDate: "2026-11-02", seasonEndDate: null, frequency: "weekly", frequencyWeeks: 1, weekday: 1, weekParity: null, monthlyWeek: null },
    null,
  );
  assert.equal(dates.length, 9, "Nov 2 through Dec 28, weekly");
  assert.equal(dates[dates.length - 1], "2026-12-28");
});

test("discount math: dollars, percent, never more than the visit", () => {
  assert.equal(discountAmountFor(58, "amount", 5), 5);
  assert.equal(discountAmountFor(58, "percent", 10), 5.8);
  assert.equal(discountAmountFor(58, "amount", 100), 58);
  assert.equal(discountAmountFor(58, null, 5), 0);
  assert.equal(discountAmountFor(58, "amount", -5), 0);
});

// ---- pricing from the customer's field ----

test("the price fills in from the customer's Turf Sqft through the matrix, with the band's hours", async () => {
  const res = await post(`/clients/${client.id}/service-price`, admin.id, { serviceId: mowing.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.amount, 58, "6,200 sqft is in the up-to-10,000 band");
  assert.equal(res.body.budgetedHours, 1);
  assert.match(res.body.pricedFromLabel, /Turf Sqft/);
  assert.equal(res.body.pricedFromValue, 6200);
  assert.equal(res.body.missingField, null);
});

test("a customer with no measurement is refused, not quietly billed the flat rate", async () => {
  const preview = await post(`/clients/${noSqftClient.id}/service-price`, admin.id, { serviceId: mowing.id });
  assert.equal(preview.status, 200);
  assert.match(preview.body.missingField, /Turf Sqft/);

  const res = await post(`/clients/${noSqftClient.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "recurring",
    firstServiceDate: `${YEAR}-06-01`,
    frequency: "weekly",
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no Turf Sqft/);

  // A typed measurement gets past it.
  const typed = await post(`/clients/${noSqftClient.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "one_time",
    sqft: 3000,
  });
  assert.equal(typed.status, 201, JSON.stringify(typed.body));
  assert.equal(typed.body[0].amount, 45);
});

// ---- assigning: contractor, cadence, notes, discount ----

let mowRow: any;

test("assigning a bi-weekly mow puts every visit on Eich's board with the discount and the note", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "recurring",
    firstServiceDate: "2026-09-16",
    seasonEndDate: "2026-11-30",
    frequency: "biweekly",
    weekday: 3,
    weekParity: "odd",
    assignedToId: eich.id,
    discountType: "amount",
    discountValue: 5,
    discountLabel: "Loyalty discount",
    contractorNote: "Gate code 4412, dog in the back",
    noteStartDate: "2026-09-01",
    noteEndDate: "2026-10-15",
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  mowRow = res.body[0];
  assert.equal(mowRow.amount, 58, "priced from the customer's sqft");
  assert.equal(mowRow.assignedToName, "Eich", "the display name, never the email");
  assert.equal(mowRow.cadenceLabel, "Every other Wednesday (odd weeks)");
  assert.equal(mowRow.retailAmount, 58);
  assert.equal(mowRow.discountAmount, 5);
  assert.equal(mowRow.netAmount, 53);
  assert.equal(mowRow.serviceCode, "MOWIN");

  const jobs = await jobsFor(mowRow.id);
  assert.ok(jobs.length >= 5, `expected a season of visits, got ${jobs.length}`);
  for (const j of jobs) {
    assert.equal(j.assignedToId, eich.id);
    assert.equal(j.dispatched, true);
    assert.equal(j.amount, 58);
    assert.equal(j.discountValue, 5);
    assert.equal(j.discountLabel, "Loyalty discount");
    assert.equal(isoWeekNumber(j.scheduledDate!) % 2, 1, `${j.scheduledDate} must be an odd week`);
  }
  assert.equal(mowRow.upcomingCount, jobs.length);
});

test("the crew note reaches only the visits inside its date range, and Start is locked until it is opened", async () => {
  const mine = await api(`/my/jobs?from=2026-09-01&to=2026-12-31`, eich.id);
  assert.equal(mine.status, 200);
  const visits = mine.body.filter((j: any) => j.clientServiceId === mowRow.id);
  const inRange = visits.find((j: any) => j.scheduledDate <= "2026-10-15");
  const outOfRange = visits.find((j: any) => j.scheduledDate > "2026-10-15");
  assert.ok(inRange && outOfRange, "need a visit on each side of the note's end date");
  assert.equal(inRange.contractorNote, "Gate code 4412, dog in the back");
  assert.equal(outOfRange.contractorNote, null);

  const blocked = await patch(`/jobs/${inRange.id}`, eich.id, { status: "in_progress" });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /open the note/i);

  const otherSubTry = await post(`/my/jobs/${inRange.id}/note-read`, otherSub.id, {});
  assert.equal(otherSubTry.status, 403, "only the assigned contractor (or the office) can open it");

  const read = await post(`/my/jobs/${inRange.id}/note-read`, eich.id, {});
  assert.equal(read.status, 200);
  assert.ok(read.body.noteAcknowledgedAt);

  const started = await patch(`/jobs/${inRange.id}`, eich.id, { status: "in_progress" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  // Put it back so later tests see a clean scheduled visit.
  await patch(`/jobs/${inRange.id}`, admin.id, { status: "scheduled" });

  // A visit with no note in force is not gated.
  const free = await patch(`/jobs/${outOfRange.id}`, eich.id, { status: "in_progress" });
  assert.equal(free.status, 200);
  await patch(`/jobs/${outOfRange.id}`, admin.id, { status: "scheduled" });
});

test("completing a discounted visit prints the discount as its own line and the total is retail less discount", async () => {
  const jobs = await jobsFor(mowRow.id);
  const job = jobs[0];
  const res = await post(`/jobs/${job.id}/complete`, admin.id, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const lines = await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, res.body.invoiceId)).orderBy(invoiceLineItemsTable.sortOrder);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].total, 58);
  assert.equal(lines[1].description, "Loyalty discount");
  assert.equal(lines[1].total, -5);
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, res.body.invoiceId));
  assert.equal(inv.total, 53);
  assert.equal(inv.status, "pending", "waits for the office to verify");
});

test("editing price, hours and contractor reaches only the visits still ahead; the done one keeps its bill", async () => {
  const res = await patch(`/client-services/${mowRow.id}`, admin.id, {
    amount: 60,
    budgetedHours: 1.25,
    assignedToId: otherSub.id,
    discountType: "percent",
    discountValue: 10,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.pricedFromLabel, null, "a hand-typed price is no longer from the matrix");
  assert.equal(res.body.discountAmount, 6);
  assert.equal(res.body.netAmount, 54);

  const jobs = await jobsFor(mowRow.id);
  const done = jobs.find((j) => j.status === "completed")!;
  assert.equal(done.amount, 58, "history keeps what it was billed");
  assert.equal(done.assignedToId, eich.id);
  for (const j of jobs.filter((j) => j.status === "scheduled")) {
    assert.equal(j.amount, 60);
    assert.equal(j.budgetedHours, 1.25);
    assert.equal(j.assignedToId, otherSub.id);
    assert.equal(j.discountType, "percent");
  }
  const audit = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.clientId, client.id), eq(auditEventsTable.action, "service_updated")));
  assert.ok(audit.some((a) => /price 58 → 60/.test(a.description)), "the audit line says what the price was and is");
});

test("changing the cadence to monthly week 1 rebuilds the upcoming visits and keeps the completed one", async () => {
  const beforeDone = (await jobsFor(mowRow.id)).filter((j) => j.status === "completed").length;
  const res = await patch(`/client-services/${mowRow.id}`, admin.id, { frequency: "monthly", monthlyWeek: 1, weekday: 2 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.cadenceLabel, "Monthly, 1st Tuesday");
  const jobs = await jobsFor(mowRow.id);
  assert.equal(jobs.filter((j) => j.status === "completed").length, beforeDone);
  const upcoming = jobs.filter((j) => j.status === "scheduled" && j.scheduledDate! >= TODAY);
  assert.ok(upcoming.length >= 1);
  for (const j of upcoming) {
    assert.equal(new Date(`${j.scheduledDate}T00:00:00Z`).getUTCDay(), 2, `${j.scheduledDate} should be a Tuesday`);
    assert.ok(Number(j.scheduledDate!.slice(8, 10)) <= 7, `${j.scheduledDate} should be in the first week`);
  }
});

// ---- pause / resume / on-off ----

test("pausing takes upcoming visits off the board and 'resume when paid' brings them back once the balance is zero", async () => {
  const before = (await jobsFor(mowRow.id)).filter((j) => j.status === "scheduled").length;
  assert.ok(before > 0);
  await db.update(clientsTable).set({ accountBalance: 120 }).where(eq(clientsTable.id, client.id));

  const paused = await post(`/client-services/${mowRow.id}/pause`, admin.id, { reason: "Waiting on payment", resumeWhenPaid: true });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.ok(paused.body.pausedAt);
  assert.equal(paused.body.pauseReason, "Waiting on payment");
  assert.equal((await jobsFor(mowRow.id)).filter((j) => j.status === "scheduled").length, 0, "no visits while paused");

  const mine = await api(`/my/jobs?from=${YEAR}-01-01&to=${YEAR + 1}-12-31`, otherSub.id);
  assert.equal(mine.body.filter((j: any) => j.clientServiceId === mowRow.id && j.status === "scheduled").length, 0, "nothing on the sub's phone");

  // Still owing: the check leaves it paused.
  let run = await runClientServiceDailyTasks({ force: true });
  let [row] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, mowRow.id));
  assert.ok(row.pausedAt, "still paused while the balance is owed");

  await db.update(clientsTable).set({ accountBalance: 0 }).where(eq(clientsTable.id, client.id));
  run = await runClientServiceDailyTasks({ force: true });
  assert.ok(run.resumed >= 1);
  [row] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, mowRow.id));
  assert.equal(row.pausedAt, null);
  assert.ok((await jobsFor(mowRow.id)).filter((j) => j.status === "scheduled").length > 0, "visits are back");
});

test("pausing until a date resumes on that date through the nightly check", async () => {
  const paused = await post(`/client-services/${mowRow.id}/pause`, admin.id, { pauseUntil: TODAY });
  assert.equal(paused.status, 200);
  assert.equal((await jobsFor(mowRow.id)).filter((j) => j.status === "scheduled").length, 0);
  const run = await runClientServiceDailyTasks({ force: true, today: TODAY });
  assert.ok(run.resumed >= 1);
  const [row] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, mowRow.id));
  assert.equal(row.pausedAt, null);
});

test("switching a service off removes upcoming visits; on again rebuilds them", async () => {
  const off = await patch(`/client-services/${mowRow.id}`, admin.id, { active: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.active, false);
  assert.equal((await jobsFor(mowRow.id)).filter((j) => j.status === "scheduled").length, 0);
  const on = await patch(`/client-services/${mowRow.id}`, admin.id, { active: true });
  assert.equal(on.status, 200);
  assert.ok((await jobsFor(mowRow.id)).filter((j) => j.status === "scheduled").length > 0);
});

// ---- history and upcoming per service ----

test("a service lists its own upcoming visits and history", async () => {
  const res = await api(`/client-services/${mowRow.id}/jobs`, admin.id);
  assert.equal(res.status, 200);
  assert.ok(res.body.history.some((j: any) => j.status === "completed" && j.invoiceId));
  assert.ok(res.body.upcoming.length > 0);
  assert.ok(res.body.upcoming.every((j: any) => j.clientServiceId === mowRow.id));
});

// ---- time-billed ----

test("a time-billed job invoices hours x rate from the clock, refuses to close while clocked in, and the office can override", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: cleanup.id,
    scheduleType: "one_time",
    firstServiceDate: TODAY,
    assignedToId: eich.id,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cs = res.body[0];
  assert.equal(cs.billingMode, "time");
  assert.equal(cs.amount, 65, "the hourly rate");
  assert.equal(cs.retailAmount, 195, "rate x budgeted hours on the board");
  const [job] = await jobsFor(cs.id);
  assert.equal(job.billingMode, "time");
  assert.equal(job.hourlyRate, 65);
  assert.equal(job.amount, 195);

  const start = new Date(Date.now() - 2 * 3600 * 1000);
  await db.insert(jobTimeEntriesTable).values([
    { jobId: job.id, userId: eich.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 60 * 60000) },
    { jobId: job.id, userId: eich.id, clockInAt: new Date(start.getTime() + 60 * 60000), clockOutAt: null },
  ]);
  const blocked = await post(`/jobs/${job.id}/complete`, admin.id, {});
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /clocked in/i);

  // Close the open entry: 60 + 30 minutes on the clock in all.
  const open = (await db.select().from(jobTimeEntriesTable).where(eq(jobTimeEntriesTable.jobId, job.id))).find((e) => e.clockOutAt == null);
  if (open) await db.update(jobTimeEntriesTable).set({ clockOutAt: new Date(start.getTime() + 90 * 60000) }).where(eq(jobTimeEntriesTable.id, open.id));

  const hydrated = await api(`/my/jobs?date=${TODAY}`, eich.id);
  const mineJob = hydrated.body.find((j: any) => j.id === job.id);
  assert.equal(mineJob.clockedMinutes, 90);
  assert.equal(mineJob.clockOpen, false);

  const done = await post(`/jobs/${job.id}/complete`, admin.id, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.amount, 97.5, "1.5 h x $65");
  const lines = await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, done.body.invoiceId));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 1.5);
  assert.equal(lines[0].unitPrice, 65);
  assert.equal(lines[0].total, 97.5);
  assert.match(lines[0].description, /1\.5 hr @ \$65\.00\/hr/);

  // Office override: a second time job whose amount was set by hand bills that number.
  const res2 = await post(`/clients/${client.id}/client-services`, admin.id, { serviceId: cleanup.id, scheduleType: "one_time", firstServiceDate: TODAY });
  const [job2] = await jobsFor(res2.body[0].id);
  await db.insert(jobTimeEntriesTable).values({ jobId: job2.id, userId: eich.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 60 * 60000) });
  const adjusted = await patch(`/jobs/${job2.id}`, admin.id, { amount: 150 });
  assert.equal(adjusted.status, 200);
  assert.equal(adjusted.body.amountOverridden, true);
  const done2 = await post(`/jobs/${job2.id}/complete`, admin.id, {});
  assert.equal(done2.body.amount, 150);
});

test("a fixed-price service ignores the clock", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, { serviceId: blowout.id, scheduleType: "one_time", firstServiceDate: TODAY });
  const [job] = await jobsFor(res.body[0].id);
  assert.equal(job.billingMode, "fixed");
  await db.insert(jobTimeEntriesTable).values({ jobId: job.id, userId: eich.id, clockInAt: new Date(Date.now() - 3600000), clockOutAt: new Date() });
  const done = await post(`/jobs/${job.id}/complete`, admin.id, {});
  assert.equal(done.status, 200);
  assert.equal(done.body.amount, 90);
});

// ---- parts and fees (M2) ----

test("a contractor adds a bag fee x3 from the list; the price is the office's and the invoice line carries the quantity", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: blowout.id,
    scheduleType: "one_time",
    firstServiceDate: TODAY,
    assignedToId: eich.id,
    discountType: "amount",
    discountValue: 10,
    discountLabel: "Neighbor discount",
  });
  const [job] = await jobsFor(res.body[0].id);

  const list = await api(`/my/products`, eich.id);
  assert.equal(list.status, 200);
  assert.ok(list.body.some((p: any) => p.id === bagFee.id));
  assert.ok(!list.body.some((p: any) => p.id === officeOnlyPart.id), "office-only parts are not offered to the crew");

  const denied = await post(`/my/jobs/${job.id}/products`, eich.id, { presetId: officeOnlyPart.id, quantity: 1 });
  assert.equal(denied.status, 400);

  const wrongSub = await post(`/my/jobs/${job.id}/products`, otherSub.id, { presetId: bagFee.id, quantity: 1 });
  assert.equal(wrongSub.status, 403);

  const added = await post(`/my/jobs/${job.id}/products`, eich.id, { presetId: bagFee.id, quantity: 3 });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.price, 4.5);
  assert.equal(added.body.quantity, 3);
  assert.equal(added.body.chargePresetId, bagFee.id);

  // The office can use the same preset from the board, and free text still works.
  const office = await post(`/jobs/${job.id}/products`, admin.id, { presetId: officeOnlyPart.id, quantity: 1 });
  assert.equal(office.status, 201);
  assert.equal(office.body.price, 120);
  const bad = await post(`/jobs/${job.id}/products`, admin.id, { quantity: 1 });
  assert.equal(bad.status, 400);

  const done = await post(`/jobs/${job.id}/complete`, admin.id, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const lines = await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, done.body.invoiceId)).orderBy(invoiceLineItemsTable.sortOrder);
  const bag = lines.find((l) => l.description === bagFee.label)!;
  assert.equal(bag.quantity, 3);
  assert.equal(bag.total, 13.5);
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, done.body.invoiceId));
  assert.equal(inv.total, 90 + 13.5 + 120 - 10);
  assert.equal(lines[lines.length - 1].description, "Neighbor discount");

  const late = await post(`/my/jobs/${job.id}/products`, eich.id, { presetId: bagFee.id, quantity: 1 });
  assert.equal(late.status, 400, "no parts after the invoice exists");
});

// ---- packages, windows, contracts, renewal ----

test("a package puts each entry on the account, each switchable on its own, and a window job on the waiting list", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, { packageId: pkg.id, assignedToId: eich.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.length, 2);
  for (const row of res.body) {
    assert.equal(row.scheduleType, "window");
    assert.equal(row.packageId, pkg.id);
    assert.equal(row.assignedToId, eich.id);
    const [job] = await jobsFor(row.id);
    assert.equal(job.dispatched, false);
    assert.equal(job.windowStart, `${YEAR}-10-01`);
  }
  const off = await patch(`/client-services/${res.body[1].id}`, admin.id, { active: false });
  assert.equal(off.status, 200);
  assert.equal((await jobsFor(res.body[1].id)).length, 0);
  assert.equal((await jobsFor(res.body[0].id)).length, 1, "the other entry is untouched");

  // Pausing with wholePackage pauses the sibling too.
  const paused = await post(`/client-services/${res.body[0].id}/pause`, admin.id, { wholePackage: true, pauseUntil: `${YEAR + 1}-03-01` });
  assert.equal(paused.status, 200);
  const rows = await db.select().from(clientServicesTable).where(eq(clientServicesTable.packageId, pkg.id));
  assert.ok(rows.every((r) => r.pausedAt != null));
});

test("rescheduling a window moves the waiting-list job with it", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: blowout.id,
    scheduleType: "window",
    startDate: `${YEAR + 1}-10-01`,
    endDate: `${YEAR + 1}-10-31`,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const moved = await patch(`/client-services/${res.body[0].id}`, admin.id, { startDate: `${YEAR + 1}-11-01`, endDate: `${YEAR + 1}-11-30` });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const [job] = await jobsFor(res.body[0].id);
  assert.equal(job.windowStart, `${YEAR + 1}-11-01`);
  assert.equal(job.windowEnd, `${YEAR + 1}-11-30`);
  assert.equal(job.dispatched, false);
});

test("a contract is an annual amount split over 12 monthly lines that add up to the cent", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "contract",
    firstServiceDate: `${YEAR + 1}-01-15`,
    contractMonths: 12,
    contractTotal: 1000,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body[0].cadenceLabel, "Contract, 12 monthly payments");
  assert.equal(res.body[0].retailAmount, 83.33);
  const jobs = await jobsFor(res.body[0].id);
  assert.equal(jobs.length, 12);
  assert.equal(jobs[0].scheduledDate, `${YEAR + 1}-01-15`);
  assert.equal(jobs[11].scheduledDate, `${YEAR + 1}-12-15`);
  assert.ok(jobs.every((j) => j.visibleToContractor === false), "billing lines never reach a crew's phone");
  const sum = Math.round(jobs.reduce((s, j) => s + j.amount, 0) * 100) / 100;
  assert.equal(sum, 1000);

  const eight = await post(`/clients/${client.id}/client-services`, admin.id, { serviceId: mowing.id, scheduleType: "contract", firstServiceDate: `${YEAR + 1}-03-01`, contractMonths: 6, contractTotal: 600 });
  assert.equal(eight.status, 400, "only 8 or 12 months");
});

test("renewal rolls the dates a year, reprices from the matrix, puts next season on the board, and never runs twice in a day", async () => {
  // Last season's mow, priced from the matrix at 45, now the customer has more turf.
  const [cs] = await db
    .insert(clientServicesTable)
    .values({
      clientId: client.id,
      serviceId: mowing.id,
      scheduleType: "recurring",
      firstServiceDate: `${YEAR - 1}-05-01`,
      seasonEndDate: `${YEAR - 1}-10-31`,
      frequency: "weekly",
      frequencyWeeks: 1,
      weekday: 5,
      amount: 45,
      pricedFromLabel: "Turf Sqft",
      pricedFromValue: 3000,
      assignedToId: eich.id,
      autoRenew: true,
    })
    .returning();

  const renewed = await db.transaction((tx) => renewClientService(cs.id, tx, { today: `${YEAR}-04-01` }));
  assert.ok(renewed);
  assert.equal(renewed!.firstServiceDate, `${YEAR}-05-01`);
  assert.equal(renewed!.seasonEndDate, `${YEAR}-10-31`);
  assert.equal(renewed!.amount, 58, "repriced from the customer's current 6,200 sqft");
  assert.ok(renewed!.lastRenewedAt);
  const jobs = await jobsFor(cs.id);
  assert.ok(jobs.length >= 20, `a season of weekly visits, got ${jobs.length}`);
  assert.ok(jobs.every((j) => j.scheduledDate! >= `${YEAR}-05-01` && j.assignedToId === eich.id && j.amount === 58));

  // The daily runner claims the day once; a second call the same day does not renew again.
  const day = `${YEAR}-04-02`;
  await db.delete(automationRunsTable).where(and(eq(automationRunsTable.kind, "client_services"), eq(automationRunsTable.runDate, day)));
  const first = await runClientServiceDailyTasks({ today: day });
  assert.equal(first.renewalsRan, true);
  const second = await runClientServiceDailyTasks({ today: day });
  assert.equal(second.renewalsRan, false);
  await db.delete(automationRunsTable).where(and(eq(automationRunsTable.kind, "client_services"), eq(automationRunsTable.runDate, day)));

  // Auto-renew off: the runner leaves an expired row alone.
  const [stale] = await db
    .insert(clientServicesTable)
    .values({ clientId: client.id, serviceId: blowout.id, scheduleType: "window", startDate: `${YEAR - 1}-10-01`, endDate: `${YEAR - 1}-10-31`, amount: 90, autoRenew: false })
    .returning();
  const runDay = `${YEAR}-04-03`;
  await db.delete(automationRunsTable).where(and(eq(automationRunsTable.kind, "client_services"), eq(automationRunsTable.runDate, runDay)));
  await runClientServiceDailyTasks({ today: runDay });
  await db.delete(automationRunsTable).where(and(eq(automationRunsTable.kind, "client_services"), eq(automationRunsTable.runDate, runDay)));
  const [still] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, stale.id));
  assert.equal(still.startDate, `${YEAR - 1}-10-01`);
  assert.equal(still.lastRenewedAt, null);
});

test("removing a service takes its upcoming visits off the board and keeps history", async () => {
  const jobsBefore = await jobsFor(mowRow.id);
  const done = jobsBefore.filter((j) => j.status === "completed").length;
  assert.ok(done > 0);
  const res = await api(`/client-services/${mowRow.id}`, admin.id, { method: "DELETE" });
  assert.equal(res.status, 204);
  const remaining = await db.select().from(jobsTable).where(eq(jobsTable.clientId, client.id));
  assert.equal(remaining.filter((j) => j.status === "completed" && j.serviceId === mowing.id).length, done);
  const listed = await api(`/clients/${client.id}/client-services`, admin.id);
  assert.ok(!listed.body.some((r: any) => r.id === mowRow.id));
});

test("contractors cannot reach the account's services", async () => {
  const res = await api(`/clients/${client.id}/client-services`, eich.id);
  assert.equal(res.status, 403);
  const pause = await post(`/client-services/1/pause`, eich.id, {});
  assert.equal(pause.status, 403);
});

// ---- what the review found: nothing renews itself out from under him ----

async function rowById(id: number) {
  const [cs] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, id));
  return cs;
}

test("a contract runs its full term: the nightly check leaves it alone and the renew button says why", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "contract",
    firstServiceDate: `${YEAR}-09-01`,
    contractMonths: 12,
    contractTotal: 1200,
    // The date that came off the service; it must not shorten the contract.
    renewDate: `${YEAR + 1}-03-01`,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = res.body[0];
  assert.equal(row.autoRenew, false, "a contract only comes back if he switches it on");

  const cs = await rowById(row.id);
  assert.equal(contractLastInstallment(cs), `${YEAR + 1}-08-01`);
  assert.equal(renewalDueDate(cs), `${YEAR + 1}-08-01`, "the term, not the renew date typed on the row");
  // The bug: on Jan 1 (or the day after the renew date) the tick rolled the row
  // and deleted payments 5 through 12.
  const switchedOn = { ...cs, autoRenew: true };
  assert.equal(isRenewalDue(switchedOn, `${YEAR + 1}-01-01`), false);
  assert.equal(isRenewalDue(switchedOn, `${YEAR + 1}-03-02`), false);
  assert.equal(isRenewalDue(switchedOn, `${YEAR + 1}-08-02`), true, "after the last payment it may roll");

  const refused = await post(`/client-services/${row.id}/renew`, admin.id, {});
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, new RegExp(`still runs through ${YEAR + 1}-08-01`));

  const jobs = await jobsFor(row.id);
  assert.equal(jobs.length, 12, "all twelve payments still on the board");
  assert.equal(Math.round(jobs.reduce((sum, j) => sum + j.amount, 0) * 100) / 100, 1200);
  assert.equal(jobs[0].scheduledDate, `${YEAR}-09-01`);
  assert.equal(jobs[11].scheduledDate, `${YEAR + 1}-08-01`);
});

test("a renew date already gone by does not roll a brand-new assignment forward a year", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "recurring",
    firstServiceDate: `${YEAR}-04-20`,
    frequency: "weekly",
    weekday: 1,
    assignedToId: eich.id,
    // "It renews March 1" — typed on a row whose season started in April.
    renewDate: `${YEAR}-03-01`,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cs = await rowById(res.body[0].id);
  assert.equal(cs.autoRenew, true, "a recurring season still renews by itself");
  assert.equal(renewalDueDate(cs), `${YEAR}-12-31`, "a March date older than the first visit is not a season that ended");

  const midSeason = `${YEAR}-09-16`;
  assert.equal(isRenewalDue(cs, midSeason), false, "the mowing season is not over");
  assert.equal(
    isRenewalDue({ ...cs, seasonEndDate: `${YEAR}-08-31` }, midSeason),
    true,
    "a season that really has ended still rolls over",
  );
});

test("a one-time job does not put itself back on the board a year later", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: blowout.id,
    scheduleType: "one_time",
    firstServiceDate: `${YEAR}-05-10`,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cs = await rowById(res.body[0].id);
  assert.equal(cs.autoRenew, false, "done once");
  // Rows from an accepted estimate carry the column default (on), so the
  // nightly check has to refuse those too.
  assert.equal(isRenewalDue({ ...cs, autoRenew: true }, `${YEAR + 1}-01-01`), false);
});

// ---- what the review found: parts, cadence, discount, the date ----

test("a contractor cannot slip an office-only part or an estimate charge onto the job from the office route", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: blowout.id,
    scheduleType: "one_time",
    firstServiceDate: TODAY,
    assignedToId: eich.id,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [job] = await jobsFor(res.body[0].id);

  const officeOnly = await post(`/jobs/${job.id}/products`, eich.id, { presetId: officeOnlyPart.id, quantity: 1 });
  assert.equal(officeOnly.status, 400, JSON.stringify(officeOnly.body));
  assert.match(officeOnly.body.error, /add on site/i);

  const [charge] = await db
    .insert(chargePresetsTable)
    .values({ label: `Trip charge ${Date.now()}`, defaultPrice: 35, kind: "charge", contractorCanAdd: true })
    .returning();
  ids.presets.push(charge.id);
  const asCrew = await post(`/jobs/${job.id}/products`, eich.id, { presetId: charge.id, quantity: 1 });
  assert.equal(asCrew.status, 400, "an estimate charge is not a part");
  const asOffice = await post(`/jobs/${job.id}/products`, admin.id, { presetId: charge.id, quantity: 1 });
  assert.equal(asOffice.status, 400, "not even for the office");

  // The parts the office did open to the crew still work from here.
  const ok = await post(`/jobs/${job.id}/products`, eich.id, { presetId: bagFee.id, quantity: 2 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.price, 4.5);
  // And the office may still add the office-only part itself.
  const office = await post(`/jobs/${job.id}/products`, admin.id, { presetId: officeOnlyPart.id, quantity: 1 });
  assert.equal(office.status, 201, JSON.stringify(office.body));
});

test("saving the contractor on an every-4-weeks row leaves it every 4 weeks", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "recurring",
    firstServiceDate: `${YEAR + 1}-04-07`,
    seasonEndDate: `${YEAR + 1}-10-31`,
    frequencyWeeks: 4,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = res.body[0];
  assert.equal(row.frequency, null);
  assert.equal(row.frequencyWeeks, 4);
  assert.equal(row.cadenceLabel, "Every 4 weeks, Wednesday");
  const before = (await jobsFor(row.id)).map((j) => j.scheduledDate);
  assert.equal(before.length, 8, "Apr 7 to Oct 31, every four weeks");

  // Exactly the body the edit dialog now sends when only the contractor changed.
  const saved = await patch(`/client-services/${row.id}`, admin.id, {
    assignedToId: eich.id,
    frequency: null,
    frequencyWeeks: 4,
    weekday: null,
    weekParity: null,
    monthlyWeek: null,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.frequency, null);
  assert.equal(saved.body.frequencyWeeks, 4);
  assert.equal(saved.body.cadenceLabel, "Every 4 weeks, Wednesday");
  const after = await jobsFor(row.id);
  assert.deepEqual(after.map((j) => j.scheduledDate), before, "the visits did not turn weekly");
  assert.ok(after.every((j) => j.assignedToId === eich.id), "and the contractor change did reach them");
});

test("a percent discount comes off the service, not off the parts, and the invoice matches the board", async () => {
  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: blowout.id,
    scheduleType: "one_time",
    firstServiceDate: TODAY,
    assignedToId: eich.id,
    amount: 50,
    discountType: "percent",
    discountValue: 10,
    discountLabel: "Loyalty discount",
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body[0].discountAmount, 5, "the account page says $5");
  const [job] = await jobsFor(res.body[0].id);
  const bags = await post(`/my/jobs/${job.id}/products`, eich.id, { presetId: bagFee.id, quantity: 3 });
  assert.equal(bags.status, 201, JSON.stringify(bags.body));

  const done = await post(`/jobs/${job.id}/complete`, admin.id, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.discountAmount, 5, "the job card says $5 too");
  const lines = await db
    .select()
    .from(invoiceLineItemsTable)
    .where(eq(invoiceLineItemsTable.invoiceId, done.body.invoiceId))
    .orderBy(invoiceLineItemsTable.sortOrder);
  const discountLine = lines.find((l) => l.description === "Loyalty discount")!;
  assert.equal(discountLine.total, -5, "10% of the $50 service, not of the $13.50 of bags as well");
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, done.body.invoiceId));
  assert.equal(inv.total, 50 + 13.5 - 5);
});

test("today on the board is his own Pacific date, not the weather scheduler's Central one", () => {
  const zone = process.env.APP_TIME_ZONE || "America/Los_Angeles";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  assert.equal(todayLocal(), `${get("year")}-${get("month")}-${get("day")}`);
});

// ---- work an outside company does ----

test("a vendor service assigned by hand goes on the account but puts no stops on the board", async () => {
  // Accepting an estimate already knew that Acme Spray's applications are not
  // stops a sub drives to — they are completed in bulk from the vendor's own
  // invoice. Assigning the same service by hand did not, and put six phantom
  // fertilizer visits on the board.
  const [vendorSvc] = await db
    .insert(servicesTable)
    .values({ name: `Fertilizer ${Date.now()}`, rate: 75, vendorName: "Acme Spray" })
    .returning();
  ids.services.push(vendorSvc.id);

  const res = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: vendorSvc.id,
    scheduleType: "recurring",
    firstServiceDate: `${YEAR}-09-20`,
    seasonEndDate: `${YEAR}-10-31`,
    frequency: "weekly",
    amount: 75,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = res.body[0];

  assert.equal((await jobsFor(row.id)).length, 0, "an outside company's work is not a stop on our board");

  // Changing the schedule must not conjure them either.
  const saved = await patch(`/client-services/${row.id}`, admin.id, { frequency: "biweekly", weekParity: "odd" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await jobsFor(row.id)).length, 0, "still nothing on the board after a cadence change");

  // Our own crew's work is unaffected: same shape, no vendor.
  const ours = await post(`/clients/${client.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "recurring",
    firstServiceDate: `${YEAR}-09-20`,
    seasonEndDate: `${YEAR}-10-31`,
    frequency: "weekly",
    amount: 45,
  });
  assert.equal(ours.status, 201, JSON.stringify(ours.body));
  assert.ok((await jobsFor(ours.body[0].id)).length > 0, "our own crew still gets visits");
});
