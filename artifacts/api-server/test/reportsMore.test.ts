/**
 * The four reports from his 2026-09-28 notes: cash and accrual (R1), time to
 * complete jobs (R2), spread of crews (R3), square footage per day per crew
 * (R4).
 *
 * The window is March and April 2027 on purpose. Every figure below is asserted
 * exactly — totals included — and that is only honest if nothing else in the
 * database falls in the range, so the range is a couple of seasons past the
 * last real job.
 *
 * The regression half matters as much as the new half: adding reports adds
 * words to the question router, and a new report that quietly steals "how many
 * square feet each week" from the weekly one would be a bug he would find
 * before we did. Those four routings are pinned at the bottom.
 */
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  servicesTable,
  jobsTable,
  jobCrewTable,
  jobTimeEntriesTable,
  invoicesTable,
  paymentsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;
// The question box has to route these without a model, the way his server runs.
delete process.env.XAI_API_KEY;
// His day, so the evening payment below lands where he expects it.
process.env.APP_TIME_ZONE = "America/Los_Angeles";

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[], services: [] as number[] };

let admin: { id: number };
let contractor: { id: number };
let crewA: { id: number };
let crewB: { id: number };
let turfClient: { id: number };
let noTurfClient: { id: number };
let service: { id: number };
let invOpen: number;
let invPaid: number;
let invVoid: number;
let invPending: number;

const STAMP = Date.now();
const FROM = "2027-03-01";
const TO = "2027-04-30";
const DAY1 = "2027-03-01";
const DAY2 = "2027-03-02";

async function api(
  path: string,
  userId: number | null,
  init: RequestInit = {},
): Promise<{ status: number; body: any; text: string; headers: Headers }> {
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
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, body: isJson && text ? JSON.parse(text) : null, text, headers: res.headers };
}

const run = (key: string, from = FROM, to = TO, extra = "") =>
  api(`/reports/run?key=${key}&from=${from}&to=${to}${extra}`, admin.id);

const ask = (question: string) =>
  api("/reports/ask", admin.id, { method: "POST", body: JSON.stringify({ question, from: FROM, to: TO }) });

const CREW_A = `Spread Alpha ${STAMP}`;
const CREW_B = `Spread Bravo ${STAMP}`;
const SERVICE = `Spread Mowing ${STAMP}`;

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a, c, ca, cb] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_more_admin_${STAMP}`, name: "More Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `test_more_sub_${STAMP}`, name: "More Contractor", role: "contractor" },
      { clerkId: `test_more_crew_a_${STAMP}`, name: CREW_A, role: "contractor" },
      { clerkId: `test_more_crew_b_${STAMP}`, name: CREW_B, role: "contractor" },
    ])
    .returning();
  admin = a;
  contractor = c;
  crewA = ca;
  crewB = cb;
  ids.users.push(a.id, c.id, ca.id, cb.id);

  const [tc, ntc] = await db
    .insert(clientsTable)
    .values([
      {
        name: `Zzspread Turf ${STAMP}`,
        status: "client",
        serviceAddress: `${STAMP} Spread Lane`,
        city: "Hayden",
        // Typed by hand, the way the Service Autopilot import left it.
        propertyData: { "Turf Sqft": "7,500 sq ft" },
      },
      {
        // No usable turf figure: the stop still counts, the square footage does not.
        name: `Zzspread Noturf ${STAMP}`,
        status: "client",
        serviceAddress: `${STAMP} Noturf Lane`,
        city: "Post Falls",
        propertyData: { "Turf Sqft": "." },
      },
    ])
    .returning();
  turfClient = tc;
  noTurfClient = ntc;
  ids.clients.push(tc.id, ntc.id);

  const [svc] = await db
    .insert(servicesTable)
    .values({
      name: SERVICE,
      rate: 45,
      // One open-ended band carrying a 1.5 hour budget. The job that has no
      // budgeted_hours of its own has to pick this up, the same as job cost does.
      pricingEquations: [
        { upToSqft: null, basePrice: 45, baseSqft: 5000, incrementPrice: 0, incrementSqft: 0, budgetedHours: 1.5, budgetedCost: 30 },
      ],
    })
    .returning();
  service = svc;
  ids.services.push(svc.id);

  const base = { serviceId: svc.id, dispatched: true };
  const [a1, a2] = await db
    .insert(jobsTable)
    .values([
      // Two men on one job: 3 crew hours, but only 2 hours on site.
      { ...base, clientId: tc.id, status: "completed", scheduledDate: DAY1, assignedToId: ca.id, amount: 100, budgetedHours: 2 },
      // No budget of its own, so the matrix band's 1.5 hours has to show.
      { ...base, clientId: tc.id, status: "completed", scheduledDate: DAY1, assignedToId: ca.id, amount: 60 },
      // Completed but never clocked: a stop and revenue, no time at all.
      { ...base, clientId: tc.id, status: "completed", scheduledDate: DAY2, assignedToId: cb.id, amount: 80, budgetedHours: 1 },
      // No turf figure on the customer: counts as a stop, adds no square footage.
      { ...base, clientId: ntc.id, status: "completed", scheduledDate: DAY2, assignedToId: cb.id, amount: 40 },
      // Skipped: he still routed the man there, so it is a stop and not revenue.
      { ...base, clientId: tc.id, status: "skipped", scheduledDate: DAY2, assignedToId: ca.id, amount: 50, skipReason: "Gate locked", skipBillable: true },
      // Cancelled: nobody ever drove to it, so it is not a stop.
      { ...base, clientId: tc.id, status: "cancelled", scheduledDate: DAY1, assignedToId: cb.id, amount: 70 },
      // Outside the window entirely.
      { ...base, clientId: tc.id, status: "completed", scheduledDate: "2027-06-01", assignedToId: ca.id, amount: 999 },
    ])
    .returning();

  await db.insert(jobTimeEntriesTable).values([
    // Alpha 8 to 10, Bravo 8:30 to 9:30 — 3 crew hours over 2 hours on site.
    { jobId: a1.id, userId: ca.id, clockInAt: new Date("2027-03-01T15:00:00Z"), clockOutAt: new Date("2027-03-01T17:00:00Z") },
    { jobId: a1.id, userId: cb.id, clockInAt: new Date("2027-03-01T15:30:00Z"), clockOutAt: new Date("2027-03-01T16:30:00Z") },
    // Half an hour on his own.
    { jobId: a2.id, userId: ca.id, clockInAt: new Date("2027-03-01T18:00:00Z"), clockOutAt: new Date("2027-03-01T18:30:00Z") },
    // Still on site: an open entry must never be counted, or a forgotten
    // clock-out grows all day and ruins every average on the page.
    { jobId: a2.id, userId: cb.id, clockInAt: new Date("2027-03-01T19:00:00Z") },
  ]);

  invOpen = 940000 + (STAMP % 9000);
  invPaid = invOpen + 1;
  invVoid = invOpen + 2;
  invPending = invOpen + 3;
  const [open, paid] = await db
    .insert(invoicesTable)
    .values([
      { clientId: tc.id, number: invOpen, total: 500, amountPaid: 200, status: "open", invoiceDate: "2027-03-10" },
      { clientId: tc.id, number: invPaid, total: 300, amountPaid: 300, status: "paid", invoiceDate: "2027-04-05" },
      // Void: never a bill, so the month never earned it.
      { clientId: ntc.id, number: invVoid, total: 150, amountPaid: 0, status: "void", invoiceDate: "2027-04-20" },
      // Sitting in the verify queue: the work is done, so accrual counts it.
      { clientId: ntc.id, number: invPending, total: 90, amountPaid: 0, status: "pending", invoiceDate: "2027-03-15" },
    ])
    .returning();

  await db.insert(paymentsTable).values([
    { clientId: tc.id, invoiceId: open.id, amount: 200, cardFee: 6, method: "credit_card", reference: `CARD${STAMP}`, createdAt: new Date("2027-03-11T18:00:00Z") },
    { clientId: tc.id, invoiceId: paid.id, amount: 300, method: "check", reference: `CHK${STAMP}`, createdAt: new Date("2027-04-06T12:00:00Z") },
    // 7 pm on the last day of the range, his time. By UTC it is the 1st of May
    // and it used to drop off the report he opens that same evening.
    { clientId: ntc.id, amount: 40, method: "venmo", reference: `EVE${STAMP}`, createdAt: new Date("2027-05-01T02:00:00Z") },
    // 7 pm the following evening: genuinely outside the range.
    { clientId: ntc.id, amount: 25, method: "cash", reference: `OUT${STAMP}`, createdAt: new Date("2027-05-02T02:00:00Z") },
  ]);
});

after(async () => {
  // clients cascade jobs, time entries, invoices and payments
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

const NEW_KEYS = [
  "cash_report",
  "accrual_report",
  "cash_vs_accrual_by_month",
  "time_to_complete_by_service",
  "time_to_complete_by_contractor",
  "crew_spread",
  "sqft_by_day",
  "sqft_by_day_by_contractor",
];

test("the four new reports are in the catalogue, each with a question and columns, and the office alone sees them", async () => {
  const res = await api("/reports/catalogue", admin.id);
  assert.equal(res.status, 200);
  const keys = res.body.reports.map((r: any) => r.key);
  for (const key of NEW_KEYS) assert.ok(keys.includes(key), `catalogue is missing ${key}`);
  for (const r of res.body.reports) {
    assert.ok(r.asks.length > 0, `${r.key} has no picker sentence`);
    assert.ok(r.columns.length > 0, `${r.key} has no columns`);
  }
  // Reports are the owner's side of the desk.
  for (const key of NEW_KEYS) {
    assert.equal((await api(`/reports/run?key=${key}&from=${FROM}&to=${TO}`, contractor.id)).status, 403);
  }
});

test("R1 cash report: money received, on the day he took it, net of the card fee", async () => {
  const res = await run("cash_report");
  assert.equal(res.status, 200, res.text);
  const mine = (res.body.rows as any[]).filter((r) => [turfClient.id, noTurfClient.id].includes(r.clientId));
  assert.equal(mine.length, 3);

  const card = mine.find((r) => r.reference === `CARD${STAMP}`);
  assert.equal(card.date, "2027-03-11");
  assert.equal(card.method, "credit_card");
  assert.equal(card.invoice, `Invoice #${invOpen}`);
  assert.equal(card.amount, 200);
  assert.equal(card.cardFee, 6);
  // The surcharge came in and went straight back out to the processor.
  assert.equal(card.net, 194);

  // Taken at 7 pm on the last day of the range. UTC calls it the 1st of May.
  const evening = mine.find((r) => r.reference === `EVE${STAMP}`);
  assert.ok(evening, "the 7 pm payment is missing from the day it was taken");
  assert.equal(evening.date, "2027-04-30");
  // Nothing to match it against yet, and that is not an error.
  assert.equal(evening.invoice, "");

  // 7 pm the next evening is outside the range.
  assert.ok(!(res.body.rows as any[]).some((r) => r.reference === `OUT${STAMP}`));

  assert.deepEqual(res.body.totals, { amount: 540, cardFee: 6, net: 534 });
});

test("R1 accrual report: money invoiced on the invoice's own date, with what is still owed", async () => {
  const res = await run("accrual_report");
  assert.equal(res.status, 200, res.text);
  const mine = (res.body.rows as any[]).filter((r) => [turfClient.id, noTurfClient.id].includes(r.clientId));

  const open = mine.find((r) => r.invoice === `Invoice #${invOpen}`);
  assert.equal(open.date, "2027-03-10");
  assert.equal(open.total, 500);
  assert.equal(open.paid, 200);
  assert.equal(open.balance, 300);

  const paid = mine.find((r) => r.invoice === `Invoice #${invPaid}`);
  assert.equal(paid.balance, 0);

  // Waiting in the verify queue: the work is done, so the period earned it.
  const pending = mine.find((r) => r.invoice === `Invoice #${invPending}`);
  assert.ok(pending, "an unverified invoice still belongs on the accrual report");
  assert.equal(pending.status, "pending");
  assert.equal(pending.balance, 90);

  // Void was never a bill.
  assert.ok(!mine.some((r) => r.invoice === `Invoice #${invVoid}`));
  assert.equal(mine.length, 3);
  assert.deepEqual(res.body.totals, { total: 890, paid: 500, balance: 390 });
});

test("R1 the two sit side by side by month, and the gap is the whole point", async () => {
  const res = await run("cash_vs_accrual_by_month");
  assert.equal(res.status, 200, res.text);
  const byMonth = Object.fromEntries((res.body.rows as any[]).map((r) => [r.month, r]));

  // March: $590 billed, $200 in. He billed far more than he collected.
  assert.deepEqual(byMonth["2027-03"], {
    month: "2027-03", invoices: 2, invoiced: 590, writtenOff: 0, payments: 1, received: 200, gap: -390,
  });
  // April: $300 billed, $340 in, because March's bill was paid in April. That
  // is the difference between the two reports, in one line.
  assert.deepEqual(byMonth["2027-04"], {
    month: "2027-04", invoices: 1, invoiced: 300, writtenOff: 0, payments: 2, received: 340, gap: 40,
  });
  for (const row of res.body.rows as any[]) {
    assert.equal(row.gap, Math.round((row.received - row.invoiced) * 100) / 100);
  }
});

test("R2 time to complete, by service: time on site and crew hours are different numbers", async () => {
  const res = await run("time_to_complete_by_service");
  assert.equal(res.status, 200, res.text);
  const row = (res.body.rows as any[]).find((r) => r.service === SERVICE);
  assert.ok(row, "the service is missing from the report");
  // Only the two clocked jobs. The completed-but-never-clocked ones are not
  // counted as nought hours, which would make the crew look twice as fast.
  assert.equal(row.jobs, 2);
  // Both of them had a budget, so the variance is over the lot of them.
  assert.equal(row.budgetedJobs, 2);
  // Two men for two hours is three crew hours and two hours on site.
  assert.equal(row.avgOnSiteHours, 1.25);
  assert.equal(row.avgCrewHours, 1.75);
  assert.equal(row.avgCrew, 1.5);
  assert.equal(row.totalCrewHours, 3.5);
  // 2 hours on one job, and the matrix band's 1.5 on the job with no budget.
  assert.equal(row.avgBudgetedHours, 1.75);
  assert.equal(row.varianceHours, 0);
  assert.equal(row.fastestHours, 0.5);
  assert.equal(row.slowestHours, 2);
});

test("R2 time to complete, by contractor: his own clock, and the jobs he shared", async () => {
  const res = await run("time_to_complete_by_contractor");
  assert.equal(res.status, 200, res.text);
  const alpha = (res.body.rows as any[]).find((r) => r.contractor === CREW_A);
  const bravo = (res.body.rows as any[]).find((r) => r.contractor === CREW_B);

  assert.equal(alpha.jobs, 2);
  assert.equal(alpha.budgetedJobs, 2);
  assert.equal(alpha.totalHours, 2.5);
  assert.equal(alpha.avgHours, 1.25);
  assert.equal(alpha.avgBudgetedHours, 1.75);
  assert.equal(alpha.varianceHours, -0.5);
  assert.equal(alpha.fastestHours, 0.5);
  assert.equal(alpha.slowestHours, 2);
  // One of the two had another man on it, so the budget comparison on that row
  // is a whole job's budget against one man's hours.
  assert.equal(alpha.sharedJobs, 1);

  // Bravo clocked an hour helping on Alpha's job, and nothing else.
  assert.equal(bravo.jobs, 1);
  assert.equal(bravo.totalHours, 1);
  assert.equal(bravo.sharedJobs, 1);
  // The open entry on the second job is not counted at all.
  assert.ok(!(res.body.rows as any[]).some((r) => r.contractor === CREW_B && r.totalHours > 1));
});

test("R3 spread of crews: stops, days, hours, revenue and each man's share", async () => {
  const res = await run("crew_spread");
  assert.equal(res.status, 200, res.text);
  const alpha = (res.body.rows as any[]).find((r) => r.contractor === CREW_A);
  const bravo = (res.body.rows as any[]).find((r) => r.contractor === CREW_B);

  // Two completed and one skipped. The cancelled visit is nobody's stop.
  assert.equal(alpha.stops, 3);
  assert.equal(alpha.completed, 2);
  assert.equal(alpha.skipped, 1);
  assert.equal(alpha.days, 2);
  assert.equal(alpha.stopsPerDay, 1.5);
  assert.equal(alpha.revenue, 160);
  assert.equal(alpha.hours, 2.5);

  assert.equal(bravo.stops, 2);
  assert.equal(bravo.completed, 2);
  assert.equal(bravo.skipped, 0);
  assert.equal(bravo.days, 1);
  assert.equal(bravo.revenue, 120);
  assert.equal(bravo.revenuePerStop, 60);
  // His hour came off somebody else's job, and it is still his hour.
  assert.equal(bravo.hours, 1);

  // Who is loaded and who is light, as a share of the whole.
  assert.equal(alpha.shareOfStops, 60);
  assert.equal(bravo.shareOfStops, 40);
  assert.equal(alpha.shareOfRevenue, 57.1);
  assert.equal(bravo.shareOfRevenue, 42.9);
  assert.deepEqual(res.body.totals, { stops: 5, completed: 4, skipped: 1, hours: 3.5, revenue: 280 });
});

test("R4 square footage per day per crew, from the same turf reading as the weekly report", async () => {
  const perCrew = await run("sqft_by_day_by_contractor");
  assert.equal(perCrew.status, 200, perCrew.text);
  const rows = perCrew.body.rows as any[];

  const alphaDay1 = rows.find((r) => r.day === DAY1 && r.contractor === CREW_A);
  assert.equal(alphaDay1.jobs, 2);
  assert.equal(alphaDay1.jobsWithSqft, 2);
  assert.equal(alphaDay1.sqft, 15000);
  assert.equal(alphaDay1.revenue, 160);

  const bravoDay2 = rows.find((r) => r.day === DAY2 && r.contractor === CREW_B);
  // Two stops, one of which has no turf figure: the stop counts, the footage
  // does not. 7,500 and not 7,500 + nothing-as-zero.
  assert.equal(bravoDay2.jobs, 2);
  assert.equal(bravoDay2.jobsWithSqft, 1);
  assert.equal(bravoDay2.sqft, 7500);
  assert.equal(bravoDay2.revenue, 120);

  // The skipped and cancelled visits did no square footage.
  assert.ok(!rows.some((r) => r.day === DAY2 && r.contractor === CREW_A));

  const perDay = await run("sqft_by_day");
  assert.equal(perDay.status, 200, perDay.text);
  const day1 = (perDay.body.rows as any[]).find((r) => r.day === DAY1);
  assert.equal(day1.sqft, 15000);
  assert.equal(day1.contractors, 1);
  assert.equal((perDay.body.rows as any[]).find((r) => r.day === DAY2).sqft, 7500);

  // The same reading as the week it sits in, so the two can never disagree.
  const week = await run("sqft_by_week");
  const weekRow = (week.body.rows as any[]).find((r) => r.week === "2027-03-01");
  assert.equal(weekRow.sqft, 22500);
});

/**
 * The cases below each get their own window, a few weeks past the fixture
 * above, so every figure in both halves of the file stays exactly asserted.
 */
const HELP_FROM = "2027-05-10";
const HELP_TO = "2027-05-20";
const LEAD = `Spread Lead ${STAMP}`;
const HELPER = `Spread Helper ${STAMP}`;
const BENCH = `Spread Bench ${STAMP}`;

test("R3 the second man in the truck gets his own line, and his hours are in the total", async () => {
  const [lead, helper, bench] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_more_lead_${STAMP}`, name: LEAD, role: "contractor" },
      { clerkId: `test_more_helper_${STAMP}`, name: HELPER, role: "contractor" },
      { clerkId: `test_more_bench_${STAMP}`, name: BENCH, role: "contractor" },
    ])
    .returning();
  ids.users.push(lead.id, helper.id, bench.id);

  const [client] = await db
    .insert(clientsTable)
    .values({
      name: `Zzspread Helped ${STAMP}`,
      status: "client",
      serviceAddress: `${STAMP} Helper Lane`,
      city: "Hayden",
      propertyData: { "Turf Sqft": "7,500 sq ft" },
    })
    .returning();
  ids.clients.push(client.id);

  const base = { clientId: client.id, serviceId: service.id, dispatched: true, status: "completed" as const };
  const [j1, j2] = await db
    .insert(jobsTable)
    .values([
      { ...base, scheduledDate: "2027-05-11", assignedToId: lead.id, amount: 200 },
      { ...base, scheduledDate: "2027-05-12", assignedToId: lead.id, amount: 300 },
    ])
    .returning();
  // A fall clean-up with two more men on it. Neither of them is the lead, which
  // is the whole point of the crew table.
  await db.insert(jobCrewTable).values([
    { jobId: j1.id, userId: helper.id },
    { jobId: j2.id, userId: bench.id },
  ]);
  await db.insert(jobTimeEntriesTable).values([
    { jobId: j1.id, userId: lead.id, clockInAt: new Date("2027-05-11T15:00:00Z"), clockOutAt: new Date("2027-05-11T16:00:00Z") },
    { jobId: j2.id, userId: lead.id, clockInAt: new Date("2027-05-12T15:00:00Z"), clockOutAt: new Date("2027-05-12T20:00:00Z") },
    // Three hours helping on a job that is not his. He leads nothing.
    { jobId: j1.id, userId: helper.id, clockInAt: new Date("2027-05-11T15:00:00Z"), clockOutAt: new Date("2027-05-11T18:00:00Z") },
  ]);

  const res = await run("crew_spread", HELP_FROM, HELP_TO);
  assert.equal(res.status, 200, res.text);
  const rows = res.body.rows as any[];
  const leadRow = rows.find((r) => r.contractor === LEAD);
  const helperRow = rows.find((r) => r.contractor === HELPER);
  const benchRow = rows.find((r) => r.contractor === BENCH);

  assert.equal(leadRow.stops, 2);
  assert.equal(leadRow.hours, 6);
  assert.equal(leadRow.revenue, 500);

  // He was never the name on a visit, so he used to have no line at all and his
  // three hours were nowhere on the page.
  assert.ok(helperRow, "a man with hours and no stops of his own is missing from the report");
  assert.equal(helperRow.stops, 0);
  assert.equal(helperRow.completed, 0);
  assert.equal(helperRow.days, 0);
  assert.equal(helperRow.revenue, 0);
  assert.equal(helperRow.hours, 3);
  // No stops, so there is no stops-per-day and no money-per-stop to give.
  assert.equal(helperRow.stopsPerDay, null);
  assert.equal(helperRow.revenuePerStop, null);
  assert.equal(helperRow.shareOfStops, 0);

  // On the truck and never clocked: a line of noughts is the answer, not silence.
  assert.ok(benchRow, "a crew member with no clock entries is missing from the report");
  assert.equal(benchRow.stops, 0);
  assert.equal(benchRow.hours, 0);

  // The share columns still read against the leads, so the board is unchanged.
  assert.equal(leadRow.shareOfStops, 100);
  assert.equal(leadRow.shareOfRevenue, 100);

  // The hours total is the company's hours, and the other report agrees.
  assert.deepEqual(res.body.totals, { stops: 2, completed: 2, skipped: 0, hours: 9, revenue: 500 });
  const time = await run("time_to_complete_by_contractor", HELP_FROM, HELP_TO);
  assert.equal(time.body.totals.totalHours, 9);
});

test("R2 variance only counts the jobs that had a budget, so an unbudgeted job is not an overrun", async () => {
  const FROM2 = "2027-05-21";
  const TO2 = "2027-05-31";
  const SVC2 = `Spread Nobudget ${STAMP}`;
  const MAN2 = `Spread Solo ${STAMP}`;

  const [man] = await db
    .insert(usersTable)
    .values({ clerkId: `test_more_solo_${STAMP}`, name: MAN2, role: "contractor" })
    .returning();
  ids.users.push(man.id);
  // No bands at all, so nothing can lend a budget to the job that has none.
  const [svc2] = await db
    .insert(servicesTable)
    .values({ name: SVC2, rate: 60, pricingEquations: [] })
    .returning();
  ids.services.push(svc2.id);
  const [client] = await db
    .insert(clientsTable)
    .values({
      name: `Zzspread Nobudget ${STAMP}`,
      status: "client",
      serviceAddress: `${STAMP} Nobudget Lane`,
      city: "Post Falls",
      propertyData: {},
    })
    .returning();
  ids.clients.push(client.id);

  const base = { clientId: client.id, serviceId: svc2.id, dispatched: true, status: "completed" as const };
  const [budgeted, unbudgeted] = await db
    .insert(jobsTable)
    .values([
      // Priced at an hour and done in an hour: dead on budget.
      { ...base, scheduledDate: "2027-05-22", assignedToId: man.id, amount: 100, budgetedHours: 1 },
      // Nobody ever wrote a number on this one.
      { ...base, scheduledDate: "2027-05-23", assignedToId: man.id, amount: 100 },
    ])
    .returning();
  await db.insert(jobTimeEntriesTable).values([
    { jobId: budgeted.id, userId: man.id, clockInAt: new Date("2027-05-22T15:00:00Z"), clockOutAt: new Date("2027-05-22T16:00:00Z") },
    { jobId: unbudgeted.id, userId: man.id, clockInAt: new Date("2027-05-23T15:00:00Z"), clockOutAt: new Date("2027-05-23T20:00:00Z") },
  ]);

  const byService = await run("time_to_complete_by_service", FROM2, TO2);
  assert.equal(byService.status, 200, byService.text);
  const svcRow = (byService.body.rows as any[]).find((r) => r.service === SVC2);
  assert.equal(svcRow.jobs, 2);
  // Only one of the two could be compared to anything.
  assert.equal(svcRow.budgetedJobs, 1);
  assert.equal(svcRow.avgBudgetedHours, 1);
  // Both jobs are still in the hours he reads: 1 and 5 over two jobs.
  assert.equal(svcRow.avgCrewHours, 3);
  assert.equal(svcRow.totalCrewHours, 6);
  // The budgeted job came in exactly on its hour, so the service is not over.
  assert.equal(svcRow.varianceHours, 0);

  const byMan = await run("time_to_complete_by_contractor", FROM2, TO2);
  const manRow = (byMan.body.rows as any[]).find((r) => r.contractor === MAN2);
  assert.equal(manRow.jobs, 2);
  assert.equal(manRow.budgetedJobs, 1);
  assert.equal(manRow.avgBudgetedHours, 1);
  assert.equal(manRow.avgHours, 3);
  assert.equal(manRow.totalHours, 6);
  assert.equal(manRow.varianceHours, 0);

  // A group where nothing at all had a budget still has no variance to show.
  await db.delete(jobsTable).where(inArray(jobsTable.id, [budgeted.id]));
  const after = await run("time_to_complete_by_service", FROM2, TO2);
  const only = (after.body.rows as any[]).find((r) => r.service === SVC2);
  assert.equal(only.budgetedJobs, 0);
  assert.equal(only.avgBudgetedHours, null);
  assert.equal(only.varianceHours, null);
});

test("R4 a day nobody's name is on says so, and a two-man day counts two crews", async () => {
  const FROM3 = "2027-06-10";
  const TO3 = "2027-06-20";
  const [lead, second] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_more_turf_lead_${STAMP}`, name: `Spread Turf Lead ${STAMP}`, role: "contractor" },
      { clerkId: `test_more_turf_2nd_${STAMP}`, name: `Spread Turf Second ${STAMP}`, role: "contractor" },
    ])
    .returning();
  ids.users.push(lead.id, second.id);
  const [client] = await db
    .insert(clientsTable)
    .values({
      name: `Zzspread Turfday ${STAMP}`,
      status: "client",
      serviceAddress: `${STAMP} Turfday Lane`,
      city: "Hayden",
      propertyData: { "Turf Sqft": "7,500 sq ft" },
    })
    .returning();
  ids.clients.push(client.id);

  const base = { clientId: client.id, serviceId: service.id, dispatched: true, status: "completed" as const };
  const [, twoMan] = await db
    .insert(jobsTable)
    .values([
      // Done, and nobody's name on it — which is most of his board today.
      { ...base, scheduledDate: "2027-06-11", amount: 220 },
      { ...base, scheduledDate: "2027-06-12", assignedToId: lead.id, amount: 220 },
    ])
    .returning();
  await db.insert(jobCrewTable).values({ jobId: twoMan.id, userId: second.id });

  const res = await run("sqft_by_day", FROM3, TO3);
  assert.equal(res.status, 200, res.text);
  const rows = res.body.rows as any[];

  const unassigned = rows.find((r) => r.day === "2027-06-11");
  assert.equal(unassigned.sqft, 7500);
  // It used to say "0 crews" did 7,500 square feet.
  assert.equal(unassigned.contractors, null);

  // The lead plus the other man in the truck is two crews, not one.
  assert.equal(rows.find((r) => r.day === "2027-06-12").contractors, 2);
});

test("R1 money he wrote off is called out, so the gap is not read as money still coming in", async () => {
  const FROM4 = "2027-07-10";
  const TO4 = "2027-07-20";
  const number = invOpen + 4;
  await db.insert(invoicesTable).values({
    clientId: turfClient.id,
    number,
    total: 500,
    amountPaid: 0,
    // The Jackie Wagner case: the work was done and he is never seeing the money.
    status: "written_off",
    invoiceDate: "2027-07-15",
  });

  const res = await run("cash_vs_accrual_by_month", FROM4, TO4);
  assert.equal(res.status, 200, res.text);
  const row = (res.body.rows as any[]).find((r) => r.month === "2027-07");
  // The month still earned it — a write-off in the autumn does not un-bill July.
  assert.equal(row.invoiced, 500);
  assert.equal(row.received, 0);
  assert.equal(row.gap, -500);
  // And the line says why that gap is never closing.
  assert.equal(row.writtenOff, 500);
  assert.equal(res.body.totals.writtenOff, 500);

  // The per-invoice report already agrees nothing is owed on it.
  const accrual = await run("accrual_report", FROM4, TO4);
  const inv = (accrual.body.rows as any[]).find((r) => r.invoice === `Invoice #${number}`);
  assert.equal(inv.status, "written_off");
  assert.equal(inv.total, 500);
  assert.equal(inv.balance, 0);

  // An ordinary month shows nothing in that column.
  const march = (await run("cash_vs_accrual_by_month")).body.rows as any[];
  assert.equal(march.find((r) => r.month === "2027-03").writtenOff, 0);
});

test("the new reports export to a spreadsheet with a header and a totals line", async () => {
  const res = await run("cash_report", FROM, TO, "&format=csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(res.headers.get("content-disposition") ?? "", /cash_report-2027-03-01-to-2027-04-30\.csv/);
  const lines = res.text.trim().split(/\r?\n/);
  assert.equal(lines[0], "Date paid,Customer,Paid by,Ref,Against,Amount,Card fee,Net");
  assert.ok(lines.some((l) => l.includes(`CARD${STAMP}`) && l.endsWith(",200,6,194")));
  assert.ok(lines[lines.length - 1].startsWith("Total,"));

  const spread = await run("crew_spread", FROM, TO, "&format=csv");
  assert.equal(spread.status, 200);
  assert.ok(spread.text.startsWith("Contractor,Stops,Done,Skipped,Days out,Stops / day,Clocked hrs"));
});

test("a range with nothing in it is an empty report, not an error", async () => {
  for (const key of NEW_KEYS) {
    const res = await run(key, "2027-07-01", "2027-07-02");
    assert.equal(res.status, 200, `${key}: ${res.text}`);
    assert.equal(res.body.rows.length, 0, `${key} invented rows out of an empty range`);
  }
  assert.equal((await run("cash_report", TO, FROM)).status, 400);
  assert.equal((await run("cash_report", "junk", TO)).status, 400);
});

test("the plain-English box finds each new report, with no model on the server", async () => {
  const cash = await ask("Cash report: what money came in?");
  assert.equal(cash.status, 200, cash.text);
  assert.equal(cash.body.reportKey, "cash_report");
  assert.equal(cash.body.assistantUsed, false);
  assert.ok(cash.body.rows.length > 0);

  assert.equal((await ask("Accrual report: what did I invoice?")).body.reportKey, "accrual_report");
  assert.equal((await ask("How long do jobs actually take, by service?")).body.reportKey, "time_to_complete_by_service");
  assert.equal((await ask("How is the work spread across the crews?")).body.reportKey, "crew_spread");
  assert.equal((await ask("How many square feet did each crew do in a day?")).body.reportKey, "sqft_by_day_by_contractor");

  // Asked in his own words rather than off the chip.
  assert.equal((await ask("show me the cash report for this period")).body.reportKey, "cash_report");
  assert.equal((await ask("how long does a cleanup actually take on site")).body.reportKey, "time_to_complete_by_service");
  assert.equal((await ask("who is loaded and who is light")).body.reportKey, "crew_spread");
});

test("the reports that already worked still answer the questions they used to", async () => {
  // New square-footage and money words must not steal these.
  assert.equal((await ask("How many square feet did we mow each week?")).body.reportKey, "sqft_by_week");
  assert.equal((await ask("which emails bounced last month")).body.reportKey, "email_failures");
  assert.equal((await ask("how much revenue did we lose to skipped jobs by contractor")).body.reportKey, "skips_by_contractor");
  assert.equal((await ask("show me the job cost per job")).body.reportKey, "job_costs");
  assert.equal((await ask("Which payments are unapplied, prepaid or overpaid?")).body.reportKey, "unapplied_payments");
});

test("the Reports page states the difference between cash and accrual on screen", async () => {
  // No browser here, so this is a guard on the page itself. He asked for both
  // reports; two similar-looking totals with no sentence between them is how he
  // ends up trusting the wrong one.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../bison-crm/src/pages/reports.tsx", import.meta.url), "utf8");
  assert.match(src, /counts a payment on the day you took it/);
  assert.match(src, /counts\s*\n?\s*an invoice on its invoice date, paid or not/);
  for (const key of ["cash_report", "accrual_report", "cash_vs_accrual_by_month"]) {
    assert.ok(src.includes(`'${key}'`), `the page does not know about ${key}`);
  }
  // Shown both when he picks the report and when the question box lands on it.
  assert.equal(src.match(/<MoneyBasisNote \/>/g)?.length, 2);
});
