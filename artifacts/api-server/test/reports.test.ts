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
  jobTimeEntriesTable,
  invoicesTable,
  paymentsTable,
  ticketsTable,
  estimatesTable,
  emailSendsTable,
  webRequestsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;
// The question box must work with no model at all; that path is what is tested.
delete process.env.XAI_API_KEY;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
  webRequests: [] as number[],
  emailSends: [] as number[],
};

let admin: { id: number };
let contractor: { id: number };
let crewA: { id: number };
let crewB: { id: number };
let mowClient: { id: number };
let formerClient: { id: number };
// Three customers whose turf figure was typed by hand, the way the Service
// Autopilot import left it.
let freeTextClient: { id: number };
let rangeClient: { id: number };
let dotOnlyClient: { id: number };
let service: { id: number };
let bandedService: { id: number };
let invoiceNumber: number;
let overpaidInvoiceNumber: number;

const STAMP = Date.now();
// A fixed window well away from today so nothing seeded by anyone else lands
// in it. 2026-06-01 is a Monday; the second job week starts 2026-06-08.
const FROM = "2026-06-01";
const TO = "2026-06-14";
const WEEK1 = "2026-06-02";
const WEEK2 = "2026-06-09";

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

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a, c, ca, cb] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_rep_admin_${STAMP}`, name: "Report Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `test_rep_contractor_${STAMP}`, name: "Report Contractor", role: "contractor" },
      { clerkId: `test_rep_crew_a_${STAMP}`, name: `Crew Alpha ${STAMP}`, role: "contractor" },
      { clerkId: `test_rep_crew_b_${STAMP}`, name: `Crew Bravo ${STAMP}`, role: "contractor" },
    ])
    .returning();
  admin = a;
  contractor = c;
  crewA = ca;
  crewB = cb;
  ids.users.push(a.id, c.id, ca.id, cb.id);

  const [mc, fc] = await db
    .insert(clientsTable)
    .values([
      {
        name: `Zzreport Mowing ${STAMP}`,
        status: "client",
        serviceAddress: `${STAMP} Report Lane`,
        city: "Hayden",
        // Free text on purpose: the report has to read "6,200 sq ft" as 6200.
        propertyData: { "Turf Sqft": "6,200 sq ft", Dog: "Yes" },
      },
      {
        name: `Zzreport Former ${STAMP}`,
        status: "former_client",
        serviceAddress: `${STAMP} Former Street`,
        city: "Post Falls",
        propertyData: {},
      },
    ])
    .returning();
  mowClient = mc;
  formerClient = fc;
  ids.clients.push(mc.id, fc.id);

  // Turf figures with more than one full stop, or a range, or nothing but a
  // stray character. Each one used to break or skew a report.
  const [ft, rg, dot] = await db
    .insert(clientsTable)
    .values([
      {
        name: `Zzturf Freetext ${STAMP}`,
        status: "client",
        serviceAddress: `${STAMP} Freetext Way`,
        city: "Hayden",
        propertyData: { "Turf Sqft": "approx. 6,200 sq. ft." },
      },
      {
        name: `Zzturf Range ${STAMP}`,
        status: "client",
        serviceAddress: `${STAMP} Range Way`,
        city: "Hayden",
        propertyData: { "Turf Sqft": "6,200-7,000" },
      },
      {
        name: `Zzturf Nothing ${STAMP}`,
        status: "client",
        serviceAddress: `${STAMP} Nothing Way`,
        city: "Hayden",
        propertyData: { "Turf Sqft": "." },
      },
    ])
    .returning();
  freeTextClient = ft;
  rangeClient = rg;
  dotOnlyClient = dot;
  ids.clients.push(ft.id, rg.id, dot.id);

  const [svc] = await db
    .insert(servicesTable)
    .values({
      name: `Report Mowing ${STAMP}`,
      rate: 45,
      // One band for everything, with a budget: 1.5 hours and $30 of cost.
      pricingEquations: [
        { upToSqft: null, basePrice: 45, baseSqft: 5000, incrementPrice: 0, incrementSqft: 0, budgetedHours: 1.5, budgetedCost: 30 },
      ],
    })
    .returning();
  service = svc;
  ids.services.push(svc.id);

  // Two bands far apart, so the band a job lands in says which number the
  // report read out of the customer's turf field.
  const [banded] = await db
    .insert(servicesTable)
    .values({
      name: `Report Banded ${STAMP}`,
      rate: 50,
      pricingEquations: [
        { upToSqft: 10000, basePrice: 50, baseSqft: 10000, incrementPrice: 0, incrementSqft: 0, budgetedHours: 1, budgetedCost: 20 },
        { upToSqft: null, basePrice: 500, baseSqft: 100000, incrementPrice: 0, incrementSqft: 0, budgetedHours: 9, budgetedCost: 900 },
      ],
    })
    .returning();
  bandedService = banded;
  ids.services.push(banded.id);

  const jobBase = { clientId: mc.id, serviceId: svc.id, dispatched: true };
  const [j1, j2, j3, , , ,] = await db
    .insert(jobsTable)
    .values([
      // Week 1: Alpha completes two, Bravo completes one.
      { ...jobBase, status: "completed", scheduledDate: WEEK1, assignedToId: ca.id, amount: 45, budgetedHours: 1.5 },
      { ...jobBase, status: "completed", scheduledDate: WEEK1, assignedToId: ca.id, amount: 55 },
      { ...jobBase, status: "completed", scheduledDate: WEEK1, assignedToId: cb.id, amount: 60 },
      // Week 2: Alpha completes one, skips one (past the free skip, so billable),
      // and one of Bravo's is cancelled.
      { ...jobBase, status: "completed", scheduledDate: WEEK2, assignedToId: ca.id, amount: 45 },
      { ...jobBase, status: "skipped", scheduledDate: WEEK2, assignedToId: ca.id, amount: 45, skipReason: "Gate locked", skipBillable: true },
      { ...jobBase, status: "cancelled", scheduledDate: WEEK2, assignedToId: cb.id, amount: 60 },
      // Outside the window: must never show.
      { ...jobBase, status: "skipped", scheduledDate: "2026-07-01", assignedToId: ca.id, amount: 999 },
    ])
    .returning();
  // j1 was clocked for two hours; j2 and j3 were never clocked.
  await db.insert(jobTimeEntriesTable).values({
    jobId: j1.id,
    userId: ca.id,
    clockInAt: new Date("2026-06-02T15:00:00Z"),
    clockOutAt: new Date("2026-06-02T17:00:00Z"),
  });
  void j2;
  void j3;

  // One completed job each for the hand-typed turf customers, nobody assigned
  // so the per-contractor rows above stay as they were.
  await db.insert(jobsTable).values(
    [ft.id, rg.id, dot.id].map((clientId) => ({
      clientId,
      serviceId: banded.id,
      dispatched: true,
      status: "completed" as const,
      scheduledDate: WEEK1,
      amount: 50,
    })),
  );

  invoiceNumber = 900000 + (STAMP % 90000);
  overpaidInvoiceNumber = invoiceNumber + 1;
  const [, overpaid] = await db
    .insert(invoicesTable)
    .values([
      { clientId: mc.id, number: invoiceNumber, total: 100, amountPaid: 0, status: "open", invoiceDate: WEEK1, poNumber: `PO-${STAMP}`, sentAt: new Date() },
      { clientId: fc.id, number: overpaidInvoiceNumber, total: 100, amountPaid: 130, status: "paid", invoiceDate: WEEK2 },
    ])
    .returning();

  await db.insert(paymentsTable).values([
    // Unapplied, inside the window.
    { clientId: mc.id, amount: 75.5, method: "check", reference: `CHK${STAMP}`, createdAt: new Date("2026-06-03T12:00:00Z") },
    // Unapplied, outside the window.
    { clientId: mc.id, amount: 20, method: "cash", createdAt: new Date("2026-08-01T12:00:00Z") },
    // Applied to the overpaid invoice: not unapplied, but the invoice is over.
    { clientId: fc.id, invoiceId: overpaid.id, amount: 130, method: "venmo", createdAt: new Date("2026-06-10T12:00:00Z") },
    // Taken at 7 pm his time on the last day of the range. By UTC that is the
    // 15th and it fell off the report he opened that evening.
    { clientId: ft.id, amount: 12.34, method: "cash", reference: `EVE${STAMP}`, createdAt: new Date("2026-06-15T02:00:00Z") },
  ]);

  await db.insert(ticketsTable).values({
    clientId: fc.id,
    title: `Zzreport sprinkler head ${STAMP}`,
    status: "open",
  });

  await db.insert(estimatesTable).values({
    clientId: mc.id,
    status: "accepted",
    total: 480,
    respondedAt: new Date(),
  });

  const sends = await db
    .insert(emailSendsTable)
    .values([
      {
        clientId: mc.id,
        source: "dispatch",
        toEmail: "koby@radiantaisoftware.com",
        subject: `Report test ${STAMP}`,
        status: "failed",
        error: "Gmail refused the address",
        createdAt: new Date("2026-06-05T12:00:00Z"),
      },
      { clientId: fc.id, source: "dispatch", status: "skipped", skipReason: "no_email", createdAt: new Date("2026-06-05T12:00:00Z") },
      {
        clientId: mc.id,
        source: "client_page",
        toEmail: "koby@radiantaisoftware.com",
        subject: `Recent failure ${STAMP}`,
        status: "failed",
        error: "Gmail refused the address",
      },
      // 6:30 pm on the 14th his time (the 15th by UTC): the last evening of
      // the range, which is exactly when he looks.
      {
        clientId: ft.id,
        source: "dispatch",
        toEmail: "koby@radiantaisoftware.com",
        subject: `Evening failure ${STAMP}`,
        status: "failed",
        error: "Gmail refused the address",
        createdAt: new Date("2026-06-15T01:30:00Z"),
      },
      // 9 pm on May 31st his time (June 1st by UTC): before the range starts.
      {
        clientId: ft.id,
        source: "dispatch",
        toEmail: "koby@radiantaisoftware.com",
        subject: `Night before ${STAMP}`,
        status: "failed",
        error: "Gmail refused the address",
        createdAt: new Date("2026-06-01T04:00:00Z"),
      },
    ])
    .returning();
  ids.emailSends.push(...sends.map((s) => s.id));

  const [wr] = await db
    .insert(webRequestsTable)
    .values({ externalId: `test_rep_wr_${STAMP}`, name: `Zzreport Web ${STAMP}`, status: "new" })
    .returning();
  ids.webRequests.push(wr.id);
});

after(async () => {
  if (ids.emailSends.length) await db.delete(emailSendsTable).where(inArray(emailSendsTable.id, ids.emailSends));
  if (ids.webRequests.length) await db.delete(webRequestsTable).where(inArray(webRequestsTable.id, ids.webRequests));
  // clients cascade jobs, time entries, invoices, payments, tickets, estimates
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

const run = (key: string, from = FROM, to = TO, extra = "") =>
  api(`/reports/run?key=${key}&from=${from}&to=${to}${extra}`, admin.id);

const rowsFor = (body: any, name: string, field = "contractor") =>
  (body.rows as any[]).filter((r) => r[field] === name);

test("the catalogue lists every report with its picker sentences, and only the office sees it", async () => {
  const res = await api("/reports/catalogue", admin.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.assistantAvailable, false);
  const keys = res.body.reports.map((r: any) => r.key);
  for (const key of [
    "skips_by_contractor",
    "skipped_jobs",
    "revenue_by_week_by_contractor",
    "sqft_by_week",
    "unapplied_payments",
    "email_failures",
    "job_costs",
    "job_costs_by_service",
  ]) {
    assert.ok(keys.includes(key), `catalogue is missing ${key}`);
  }
  for (const r of res.body.reports) {
    assert.ok(r.asks.length > 0, `${r.key} has no picker sentence`);
    assert.ok(r.columns.length > 0, `${r.key} has no columns`);
  }
  const denied = await api("/reports/catalogue", contractor.id);
  assert.equal(denied.status, 403);
});

test("a bad range is a 400 and an unknown key is a 404", async () => {
  assert.equal((await run("skips_by_contractor", "2026-06-14", "2026-06-01")).status, 400);
  assert.equal((await run("skips_by_contractor", "junk", TO)).status, 400);
  assert.equal((await run("no_such_report")).status, 404);
});

test("skipped and cancelled jobs per contractor, with the revenue lost", async () => {
  const res = await run("skips_by_contractor");
  assert.equal(res.status, 200);
  const [alpha] = rowsFor(res.body, `Crew Alpha ${STAMP}`);
  const [bravo] = rowsFor(res.body, `Crew Bravo ${STAMP}`);
  assert.deepEqual(
    { skipped: alpha.skipped, cancelled: alpha.cancelled, billableSkips: alpha.billableSkips, revenueLost: alpha.revenueLost, stillBillable: alpha.stillBillable },
    { skipped: 1, cancelled: 0, billableSkips: 1, revenueLost: 45, stillBillable: 45 },
  );
  assert.deepEqual(
    { skipped: bravo.skipped, cancelled: bravo.cancelled, revenueLost: bravo.revenueLost },
    { skipped: 0, cancelled: 1, revenueLost: 60 },
  );
  // The July skip is outside the window and its $999 must not be in anyone's row.
  assert.ok((res.body.rows as any[]).every((r) => r.revenueLost < 999));

  const detail = await run("skipped_jobs");
  const mine = (detail.body.rows as any[]).filter((r) => r.client === `Zzreport Mowing ${STAMP}`);
  assert.equal(mine.length, 2);
  const skipped = mine.find((r) => r.status === "skipped");
  assert.equal(skipped.reason, "Gate locked");
  assert.equal(skipped.billable, true);
  assert.equal(skipped.clientId, mowClient.id);
  assert.ok(detail.body.totals.amount >= 105);
});

test("revenue per week per contractor keys on the Monday of the job's week", async () => {
  const res = await run("revenue_by_week_by_contractor");
  assert.equal(res.status, 200);
  const alpha = rowsFor(res.body, `Crew Alpha ${STAMP}`);
  const byWeek = Object.fromEntries(alpha.map((r) => [r.week, r]));
  assert.equal(byWeek["2026-06-01"].jobs, 2);
  assert.equal(byWeek["2026-06-01"].revenue, 100);
  assert.equal(byWeek["2026-06-08"].jobs, 1);
  assert.equal(byWeek["2026-06-08"].revenue, 45);
  // Skipped and cancelled work is not revenue.
  const bravo = rowsFor(res.body, `Crew Bravo ${STAMP}`);
  assert.equal(bravo.length, 1);
  assert.equal(bravo[0].revenue, 60);
  for (const c of res.body.columns) assert.ok(["week", "contractor", "jobs", "revenue"].includes(c.key));
});

test("square footage per week reads the customer's turf figure out of free text", async () => {
  const res = await run("sqft_by_week");
  assert.equal(res.status, 200);
  const week1 = (res.body.rows as any[]).find((r) => r.week === "2026-06-01");
  const week2 = (res.body.rows as any[]).find((r) => r.week === "2026-06-08");
  // Other seed jobs may share the week, so the check is "at least ours".
  assert.ok(week1.sqft >= 3 * 6200, `week 1 sqft ${week1.sqft}`);
  assert.ok(week1.jobsWithSqft >= 3);
  assert.ok(week2.sqft >= 6200);
  assert.ok(res.body.totals.sqft >= 4 * 6200);

  const byService = await run("sqft_by_week_by_service");
  const ours = (byService.body.rows as any[]).filter((r) => r.service === `Report Mowing ${STAMP}`);
  assert.equal(ours.length, 2);
  assert.equal(ours.find((r) => r.week === "2026-06-01").sqft, 3 * 6200);
});

test("a turf figure typed by hand reads as its first number, and nothing blows up", async () => {
  const probes = [freeTextClient.id, rangeClient.id, dotOnlyClient.id];

  // "approx. 6,200 sq. ft." used to fail the number conversion and take the
  // whole report down with it — a 500 for every week one of those jobs is in.
  const res = await run("sqft_by_week");
  assert.equal(res.status, 200, res.text);
  const byService = await run("sqft_by_week_by_service");
  assert.equal(byService.status, 200, byService.text);
  const banded = (byService.body.rows as any[]).filter((r) => r.service === `Report Banded ${STAMP}`);
  assert.equal(banded.length, 1);
  // 6,200 each for the "approx." one and the range, and no figure at all for
  // the customer whose field holds a stray full stop: the job counts, the
  // square footage does not. The range used to add 62,007,000 sq ft.
  assert.equal(banded[0].sqft, 12400);
  assert.equal(banded[0].jobs, 3);
  assert.equal(banded[0].jobsWithSqft, 2);

  const costs = await run("job_costs");
  assert.equal(costs.status, 200, costs.text);
  const mine = (costs.body.rows as any[]).filter((r) => probes.includes(r.clientId));
  assert.equal(mine.length, 3);
  // 6,200 sqft belongs in the small band ($20 of cost, one hour), never the
  // open-ended one the glued-together digits used to pick.
  for (const row of mine.filter((r) => r.clientId !== dotOnlyClient.id)) {
    assert.equal(row.budgetedCost, 20, `${row.client} landed in the wrong band`);
    assert.equal(row.budgetedHours, 1);
  }
  const noFigure = mine.find((r) => r.clientId === dotOnlyClient.id);
  assert.equal(noFigure.budgetedCost, null);
  assert.equal(noFigure.budgetedHours, null);

  const bySvc = await run("job_costs_by_service");
  assert.equal(bySvc.status, 200, bySvc.text);
  const row = (bySvc.body.rows as any[]).find((r) => r.service === `Report Banded ${STAMP}`);
  assert.equal(row.budgetedCost, 40);

  // The same question through the box answers instead of failing.
  const ask = await api("/reports/ask", admin.id, {
    method: "POST",
    body: JSON.stringify({ question: "How many square feet did we mow each week?", from: FROM, to: TO }),
  });
  assert.equal(ask.status, 200, ask.text);
  assert.equal(ask.body.reportKey, "sqft_by_week");
  assert.ok(ask.body.rows.length > 0);
});

test("failed emails and unapplied payments are dated by his day, not by UTC", async () => {
  const emails = await run("email_failures");
  assert.equal(emails.status, 200);
  const evening = (emails.body.rows as any[]).find((r) => r.subject === `Evening failure ${STAMP}`);
  // 6:30 pm on the 14th his time. It is the last day of the range, so it has
  // to be in the report he opens that evening, dated the 14th.
  assert.ok(evening, "the evening failure is missing from the range it happened in");
  assert.equal(evening.date, "2026-06-14");
  // 9 pm on May 31st his time is before the range, even though UTC calls it June 1st.
  assert.ok(!(emails.body.rows as any[]).some((r) => r.subject === `Night before ${STAMP}`));

  const payments = await run("unapplied_payments");
  assert.equal(payments.status, 200);
  const evePayment = (payments.body.rows as any[]).find((r) => r.reference === `EVE${STAMP}`);
  assert.ok(evePayment, "the 7 pm payment is missing from the day it was taken");
  assert.equal(evePayment.date, "2026-06-14");
  assert.equal(evePayment.clientId, freeTextClient.id);
});

test("the search box only answers the keyboard shortcut once, though the layout mounts it twice", async () => {
  // No browser here, so this is a guard on the code: the phone header and the
  // desktop bar both keep a live GlobalSearch, and both listened for "/" and
  // Ctrl+K, so two search boxes opened stacked and closing one left the other
  // over the page. The handler now stops the sibling listener.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../bison-crm/src/components/global-search.tsx", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf("const onKey ="), src.indexOf("window.addEventListener('keydown', onKey)"));
  assert.ok(handler.length > 0, "the keydown handler moved; re-check the shortcut guard");
  assert.match(handler, /stopImmediatePropagation\(\)/);
  assert.ok(
    handler.indexOf("stopImmediatePropagation()") < handler.indexOf("setOpen(true)"),
    "the sibling listener must be stopped before the dialog opens",
  );
  assert.equal(src.match(/window\.addEventListener\('keydown'/g)?.length, 1);
});

test("unapplied, prepaid and overpaid payments, inside the range only", async () => {
  const res = await run("unapplied_payments");
  assert.equal(res.status, 200);
  const mine = (res.body.rows as any[]).filter((r) => [mowClient.id, formerClient.id].includes(r.clientId));
  const unapplied = mine.find((r) => r.kind === "unapplied");
  assert.equal(unapplied.amount, 75.5);
  assert.equal(unapplied.unused, 75.5);
  assert.equal(unapplied.reference, `CHK${STAMP}`);
  assert.equal(unapplied.method, "check");
  // The August cash payment is outside the window.
  assert.ok(!mine.some((r) => r.amount === 20));
  const over = mine.find((r) => r.kind === "overpaid");
  assert.equal(over.amount, 130);
  assert.equal(over.unused, 30);
  assert.equal(over.reference, `Invoice #${overpaidInvoiceNumber}`);
  assert.ok(res.body.totals.unused >= 105.5);
});

test("emails that did not send: failed and skipped, with the reason", async () => {
  const res = await run("email_failures");
  assert.equal(res.status, 200);
  const mine = (res.body.rows as any[]).filter((r) => [mowClient.id, formerClient.id].includes(r.clientId));
  const failed = mine.find((r) => r.status === "failed");
  assert.equal(failed.subject, `Report test ${STAMP}`);
  assert.equal(failed.reason, "Gmail refused the address");
  assert.equal(failed.toEmail, "koby@radiantaisoftware.com");
  const skipped = mine.find((r) => r.status === "skipped");
  assert.equal(skipped.reason, "no_email");
  // The failure dated today is outside the June window.
  assert.ok(!mine.some((r) => r.subject === `Recent failure ${STAMP}`));
});

test("job cost per job takes the budget from the matrix band and the actual from the clock", async () => {
  const res = await run("job_costs");
  assert.equal(res.status, 200);
  const mine = (res.body.rows as any[]).filter((r) => r.clientId === mowClient.id);
  assert.equal(mine.length, 4, "completed jobs only");
  const clocked = mine.find((r) => r.actualHours != null);
  assert.equal(clocked.actualHours, 2);
  assert.equal(clocked.budgetedHours, 1.5);
  assert.equal(clocked.budgetedCost, 30);
  assert.equal(clocked.varianceHours, 0.5);
  assert.equal(clocked.revenuePerHour, 22.5);
  assert.equal(clocked.marginAtBudget, 15);
  // Never clocked: the budget still shows from the band, the actual is blank,
  // and no variance is invented.
  const unclocked = mine.find((r) => r.actualHours == null);
  assert.equal(unclocked.budgetedHours, 1.5);
  assert.equal(unclocked.varianceHours, null);
  assert.equal(unclocked.revenuePerHour, null);

  const byService = await run("job_costs_by_service");
  const row = (byService.body.rows as any[]).find((r) => r.service === `Report Mowing ${STAMP}`);
  assert.equal(row.jobs, 4);
  assert.equal(row.measuredJobs, 1);
  assert.equal(row.revenue, 205);
  assert.equal(row.budgetedCost, 120);
  assert.equal(row.actualHours, 2);
  // Budget hours are summed over clocked jobs only, so the variance compares like with like.
  assert.equal(row.budgetedHours, 1.5);
  assert.equal(row.varianceHours, 0.5);
  assert.equal(row.marginAtBudget, 85);
});

test("format=csv returns a file with a header, the rows and a totals line", async () => {
  const res = await run("skips_by_contractor", FROM, TO, "&format=csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(res.headers.get("content-disposition") ?? "", /skips_by_contractor-2026-06-01-to-2026-06-14\.csv/);
  const lines = res.text.trim().split(/\r?\n/);
  assert.equal(lines[0], "Contractor,Skipped,Cancelled,Billable skips,Revenue lost,Still billable");
  assert.ok(lines.some((l) => l.startsWith(`Crew Alpha ${STAMP},1,0,1,45,45`)));
  assert.ok(lines[lines.length - 1].startsWith("Total,"));
});

test("the question box works without an AI key by matching words, and says so", async () => {
  const ask = (question: string) =>
    api("/reports/ask", admin.id, { method: "POST", body: JSON.stringify({ question, from: FROM, to: TO }) });

  const skips = await ask("how much revenue did we lose to skipped jobs by contractor");
  assert.equal(skips.status, 200);
  assert.equal(skips.body.reportKey, "skips_by_contractor");
  assert.equal(skips.body.assistantUsed, false);
  assert.ok(skips.body.rows.length > 0);
  assert.ok(skips.body.columns.length > 0);
  assert.match(skips.body.answer, /Skipped and cancelled jobs per contractor/);

  // A picker sentence lands on exactly its own report.
  const sqft = await ask("How many square feet did we mow each week?");
  assert.equal(sqft.body.reportKey, "sqft_by_week");
  const unapplied = await ask("Which payments are unapplied, prepaid or overpaid?");
  assert.equal(unapplied.body.reportKey, "unapplied_payments");
  const bounced = await ask("which emails bounced last month");
  assert.equal(bounced.body.reportKey, "email_failures");
  const cost = await ask("show me the job cost per job");
  assert.equal(cost.body.reportKey, "job_costs");

  const none = await ask("what is the weather like");
  assert.equal(none.status, 200);
  assert.equal(none.body.reportKey, null);
  assert.equal(none.body.rows.length, 0);

  assert.equal((await ask("")).status, 400);
  const badRange = await api("/reports/ask", admin.id, {
    method: "POST",
    body: JSON.stringify({ question: "skipped jobs", from: TO, to: FROM }),
  });
  assert.equal(badRange.status, 400);
});

test("global search finds former clients, invoices by number, payments by reference or amount, tickets and jobs by address", async () => {
  const former = await api(`/search?q=${encodeURIComponent(`Zzreport Former ${STAMP}`)}`, admin.id);
  assert.equal(former.status, 200);
  assert.equal(former.body.clients[0].id, formerClient.id);
  assert.equal(former.body.clients[0].status, "former_client");
  // The former client's name also matches her ticket and her overpaid invoice.
  assert.ok(former.body.tickets.some((t: any) => t.title === `Zzreport sprinkler head ${STAMP}`));
  assert.ok(former.body.invoices.some((i: any) => i.number === overpaidInvoiceNumber));

  const byNumber = await api(`/search?q=${invoiceNumber}`, admin.id);
  const inv = byNumber.body.invoices.find((i: any) => i.number === invoiceNumber);
  assert.ok(inv, "invoice found by its number");
  assert.equal(inv.clientId, mowClient.id);
  assert.equal(inv.balance, 100);

  const byPo = await api(`/search?q=PO-${STAMP}`, admin.id);
  assert.ok(byPo.body.invoices.some((i: any) => i.number === invoiceNumber));

  const byRef = await api(`/search?q=CHK${STAMP}`, admin.id);
  assert.equal(byRef.body.payments.length, 1);
  assert.equal(byRef.body.payments[0].amount, 75.5);
  assert.equal(byRef.body.payments[0].clientName, `Zzreport Mowing ${STAMP}`);

  const byAmount = await api(`/search?q=75.50`, admin.id);
  assert.ok(byAmount.body.payments.some((p: any) => p.reference === `CHK${STAMP}`));

  const byAddress = await api(`/search?q=${STAMP} Report Lane`, admin.id);
  assert.ok(byAddress.body.jobs.length >= 1);
  assert.ok(byAddress.body.jobs.every((j: any) => j.clientId === mowClient.id));
  assert.equal(byAddress.body.jobs[0].serviceName, `Report Mowing ${STAMP}`);
  assert.ok(byAddress.body.jobs.length <= 8, "capped per group");

  // He does not use one-time jobs at all today because of this: "waiting list
  // or one-time jobs will get lost because there's no way for me to search
  // those." Looking for a stray job he types the customer, or the service.
  const jobsByCustomer = await api(`/search?q=Zzreport Mowing ${STAMP}`, admin.id);
  assert.ok(jobsByCustomer.body.jobs.length >= 1, "a job is findable by its customer's name");
  assert.ok(jobsByCustomer.body.jobs.every((j: any) => j.clientId === mowClient.id));

  const jobsByService = await api(`/search?q=Report Mowing ${STAMP}`, admin.id);
  assert.ok(jobsByService.body.jobs.length >= 1, "a job is findable by its service name");
  assert.equal(jobsByService.body.jobs[0].serviceName, `Report Mowing ${STAMP}`);

  const byTicket = await api(`/search?q=sprinkler head ${STAMP}`, admin.id);
  assert.equal(byTicket.body.tickets[0].clientName, `Zzreport Former ${STAMP}`);

  assert.equal((await api("/search?q=z", admin.id)).status, 400);
  assert.equal((await api(`/search?q=${STAMP}`, contractor.id)).status, 403);
});

test("dashboard alerts count accepted estimates, invoices sent today, new web requests and failed emails", async () => {
  const res = await api("/dashboard/alerts", admin.id);
  assert.equal(res.status, 200);
  assert.ok(res.body.estimatesAccepted.items.some((e: any) => e.clientId === mowClient.id && e.total === 480));
  assert.ok(res.body.estimatesAccepted.count >= 1);
  const sent = res.body.invoicesSentToday.items.find((i: any) => i.number === invoiceNumber);
  assert.ok(sent, "the invoice sent today is listed");
  assert.equal(sent.clientName, `Zzreport Mowing ${STAMP}`);
  assert.ok(res.body.webRequests.items.some((w: any) => w.name === `Zzreport Web ${STAMP}`));
  // Only the failure from today is recent enough; the June one is history.
  const failed = res.body.failedEmails.items.filter((f: any) => f.clientId === mowClient.id);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].subject, `Recent failure ${STAMP}`);
  assert.equal((await api("/dashboard/alerts", contractor.id)).status, 403);
});
