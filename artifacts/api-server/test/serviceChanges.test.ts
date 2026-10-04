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
  auditEventsTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";

process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const {
  effectiveRenewDate,
  isMonthDay,
  monthDayOf,
  resolveSeasonDate,
  resolveSeasonWindow,
  seasonDateError,
  seasonStartOf,
  todayLocal,
} = await import("../src/lib/jobGeneration.ts");

let server: Server;
let baseUrl: string;

const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
  packages: [] as number[],
  fields: [] as number[],
};

const stamp = Date.now();
const TODAY = todayLocal();
const YEAR = Number(TODAY.slice(0, 4));

let admin: { id: number };
let eich: { id: number };
let turfLabel: string;

/** Everything in this file names itself with the stamp, so cleanup is exact. */
let mowing: { id: number };
let pushMow: { id: number };
let seasonMow: { id: number };
let finishMow: { id: number };
let historyMow: { id: number };
let blowout: { id: number };

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

function plus(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const weekdayOfDate = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();
const mmdd = (isoDate: string) => isoDate.slice(5);

/** The two bands his mowing matrix actually has, so a 6,200 lawn is $58. */
const BANDS = (small: number, big: number, bigHours: number) => [
  { upToSqft: 5000, basePrice: small, baseSqft: 0, incrementPrice: 0, incrementSqft: 0, budgetedHours: 0.5, budgetedCost: null },
  { upToSqft: 10000, basePrice: big, baseSqft: 0, incrementPrice: 0, incrementSqft: 0, budgetedHours: bigHours, budgetedCost: null },
];

async function newClient(name: string, sqft: string | null) {
  const [c] = await db
    .insert(clientsTable)
    .values({
      name: `${name} ${stamp}`,
      status: "client",
      propertyData: sqft == null ? {} : { [turfLabel]: sqft },
    })
    .returning();
  ids.clients.push(c.id);
  return c;
}

const scheduledJobs = (csId: number) =>
  db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.clientServiceId, csId), eq(jobsTable.status, "scheduled")))
    .orderBy(jobsTable.scheduledDate);

const allJobs = (csId: number) =>
  db.select().from(jobsTable).where(eq(jobsTable.clientServiceId, csId)).orderBy(jobsTable.scheduledDate);

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a, e] = await db
    .insert(usersTable)
    .values([
      { clerkId: `sc_admin_${stamp}`, name: "SC Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `sc_eich_${stamp}`, name: "sc_eich@example.com", displayName: "Eich", role: "contractor" },
    ])
    .returning();
  admin = a;
  eich = e;
  ids.users.push(a.id, e.id);

  turfLabel = `SC Turf Sqft ${stamp}`;
  const [turf] = await db
    .insert(estimateFieldsTable)
    .values({ label: turfLabel, fieldType: "calculable" })
    .returning();
  ids.fields.push(turf.id);

  const made = await db
    .insert(servicesTable)
    .values([
      // The renew date lives on the service from the start: "renew date is not
      // client specific but Product based".
      { name: `SC Mowing ${stamp}`, code: "SCMOW", rate: 40, billableHours: 0.75, pricingFieldId: turf.id, pricingEquations: BANDS(45, 58, 1), renewDate: "03-01" },
      { name: `SC Push Mowing ${stamp}`, code: "SCPUSH", rate: 40, billableHours: 0.75, pricingFieldId: turf.id, pricingEquations: BANDS(45, 58, 1) },
      { name: `SC Season Mowing ${stamp}`, code: "SCSEAS", rate: 50, pricingFieldId: turf.id },
      { name: `SC Finish Mowing ${stamp}`, code: "SCFIN", rate: 50 },
      { name: `SC History Mowing ${stamp}`, code: "SCHIST", rate: 40, pricingFieldId: turf.id, pricingEquations: BANDS(45, 58, 1) },
      { name: `SC Blow-out ${stamp}`, code: "SCBLOW", rate: 90 },
    ])
    .returning();
  [mowing, pushMow, seasonMow, finishMow, historyMow, blowout] = made;
  ids.services.push(...made.map((s) => s.id));
});

after(async () => {
  for (const clientId of ids.clients) {
    await db.delete(jobsTable).where(eq(jobsTable.clientId, clientId));
    await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, clientId));
    await db.delete(auditEventsTable).where(eq(auditEventsTable.clientId, clientId));
  }
  // The service-wide pushes log with no client on them, so they are found by
  // the stamp every name in this file carries.
  await db.delete(auditEventsTable).where(like(auditEventsTable.description, `%${stamp}%`));
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.packages.length) await db.delete(packagesTable).where(inArray(packagesTable.id, ids.packages));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.fields.length) await db.delete(estimateFieldsTable).where(inArray(estimateFieldsTable.id, ids.fields));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---- S2: a package needs no year ----

test("a date he means every year is read as a month and day, and a wrong one is still refused", () => {
  assert.equal(isMonthDay("10-01"), true);
  assert.equal(isMonthDay("2026-10-01"), false, "a full date is not year-free");
  assert.equal(isMonthDay("13-01"), false, "there is no month 13");
  assert.equal(monthDayOf("2026-10-01"), "10-01");
  assert.equal(monthDayOf("10-01"), "10-01");
  assert.equal(monthDayOf("October"), null);

  assert.equal(seasonDateError("Start date", "10-01"), null);
  assert.equal(seasonDateError("Start date", "02-29"), null, "a leap day with no year is legal");
  assert.equal(seasonDateError("Start date", ""), null, "blank is not an error, it is blank");
  assert.match(seasonDateError("Start date", "02-30") ?? "", /not a real calendar date/);
  assert.match(seasonDateError("Start date", "10/01") ?? "", /mm-dd for the same day every year/);
});

test("a year-free date resolves into the season it belongs to, and a window stays one window over New Year", () => {
  // Judged from May, October is still ahead of us this year.
  assert.equal(resolveSeasonDate("10-01", "2026-05-01"), "2026-10-01");
  // Judged from November, it has gone by, so it means next October.
  assert.equal(resolveSeasonDate("10-01", "2026-11-05"), "2027-10-01");
  // A full date is what he typed and nobody moves it.
  assert.equal(resolveSeasonDate("2026-10-01", "2026-11-05"), "2026-10-01");
  // Unless it is a date that came off a service years ago, where only the
  // month and day were ever meant.
  assert.equal(resolveSeasonDate("2020-03-01", "2026-05-01", { rollStale: true }), "2027-03-01");

  // Blow-outs run November into February: one window, not an error.
  assert.deepEqual(resolveSeasonWindow("11-01", "02-28", "2026-12-15"), {
    startDate: "2026-11-01",
    endDate: "2027-02-28",
  });
  // A window entirely behind us is next year's.
  assert.deepEqual(resolveSeasonWindow("04-01", "06-30", "2026-08-01"), {
    startDate: "2027-04-01",
    endDate: "2027-06-30",
  });
  // A window still open stays where it is.
  assert.deepEqual(resolveSeasonWindow("04-01", "06-30", "2026-05-15"), {
    startDate: "2026-04-01",
    endDate: "2026-06-30",
  });
});

test("a package saves with no year on it, and assigning it lands the window in a real season", async () => {
  const bad = await post("/packages", admin.id, {
    name: `SC Bad Package ${stamp}`,
    items: [{ serviceId: blowout.id, windowStart: "02-30", windowEnd: "03-15" }],
    scheduleType: "window",
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.error, /not a real calendar date/);

  const made = await post("/packages", admin.id, {
    name: `SC Sprinkler Package ${stamp}`,
    scheduleType: "window",
    startDate: "10-01",
    endDate: "11-30",
    renewDate: "03-01",
    items: [
      { serviceId: blowout.id, label: "Blow-out — October", windowStart: "10-01", windowEnd: "10-31" },
      { serviceId: blowout.id, label: "Blow-out — November", windowStart: "11-01", windowEnd: "11-30" },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  ids.packages.push(made.body.id);
  assert.equal(made.body.startDate, "10-01", "saved exactly as he typed it — no year");

  const customer = await newClient("SC Package Customer", "6,200");
  const assigned = await post(`/clients/${customer.id}/client-services`, admin.id, {
    packageId: made.body.id,
    assignedToId: eich.id,
  });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  assert.equal(assigned.body.length, 2);
  for (const row of assigned.body) {
    assert.match(row.startDate, /^\d{4}-(10|11)-01$/, `${row.label} got a real year: ${row.startDate}`);
    assert.match(row.endDate, /^\d{4}-(10-31|11-30)$/);
    // Both sides of the window land in the same season.
    assert.ok(row.endDate >= row.startDate, `${row.startDate} to ${row.endDate}`);
    // And the window it resolved to has not already finished.
    assert.ok(row.endDate >= TODAY, `${row.label} should not be assigned into a season already over`);
    assert.match(row.renewDate ?? "", /^\d{4}-03-01$/, "the package's renew date got a year too");
  }
});

// ---- S3: the renew date belongs to the service ----

test("the renew date on the service governs every customer who has it, and only a date typed for one customer wins", () => {
  const row = {
    renewDate: null,
    renewDateOverridden: false,
    scheduleType: "recurring",
    startDate: null,
    firstServiceDate: "2026-04-15",
  } as const;
  // "03-01" on the service means the March after this customer's season.
  assert.equal(effectiveRenewDate(row, "03-01"), "2027-03-01");
  // Change it on the service and this row follows, with nothing written to it.
  assert.equal(effectiveRenewDate(row, "11-15"), "2026-11-15");
  // A date the office deliberately typed for this one customer wins.
  assert.equal(
    effectiveRenewDate({ ...row, renewDate: "2026-12-01", renewDateOverridden: true }, "03-01"),
    "2026-12-01",
  );
  // A row carrying its own date but no override flag (every imported row) and
  // a service with nothing to say still renews on its own date.
  assert.equal(effectiveRenewDate({ ...row, renewDate: "2026-12-01" }, null), "2026-12-01");
  assert.equal(effectiveRenewDate(row, null), null);
});

test("changing the renew date on the service moves every account that has it; emptying the box on one account puts it back", async () => {
  const customer = await newClient("SC Renew Customer", "6,200");
  const assigned = await post(`/clients/${customer.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "recurring",
    firstServiceDate: `${YEAR + 1}-04-15`,
    seasonEndDate: `${YEAR + 1}-09-30`,
    frequency: "weekly",
    weekday: weekdayOfDate(`${YEAR + 1}-04-15`),
  });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  const row = assigned.body[0];
  assert.equal(row.renewDateOverridden, false, "nobody typed a date for this customer");
  assert.equal(row.renewDateFromService, true);
  assert.equal(row.effectiveRenewDate, `${YEAR + 2}-03-01`, "the March after their season");

  // One change on the service, every customer follows.
  const moved = await patch(`/services/${mowing.id}`, admin.id, { renewDate: "11-15" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const after1 = await api(`/clients/${customer.id}/client-services`, admin.id);
  const seen = after1.body.find((r: any) => r.id === row.id);
  assert.equal(seen.effectiveRenewDate, `${YEAR + 1}-11-15`, "followed the service with nothing written to the row");
  assert.equal(seen.renewDateFromService, true);
  const [raw] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, row.id));
  assert.equal(raw.renewDateOverridden, false, "the row was never touched");

  // A date typed for this one customer is theirs.
  const typed = await patch(`/client-services/${row.id}`, admin.id, { renewDate: `${YEAR + 1}-12-01` });
  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  assert.equal(typed.body.renewDateOverridden, true);
  assert.equal(typed.body.effectiveRenewDate, `${YEAR + 1}-12-01`);
  assert.equal(typed.body.renewDateFromService, false);

  // Saving the service's own date back is not an override.
  const same = await patch(`/client-services/${row.id}`, admin.id, { renewDate: `${YEAR + 1}-11-15` });
  assert.equal(same.body.renewDateOverridden, false, "that is the service's date, not this customer's");
  assert.equal(same.body.renewDateFromService, true);

  // And emptying the box follows the service again.
  const cleared = await patch(`/client-services/${row.id}`, admin.id, { renewDate: null });
  assert.equal(cleared.body.renewDateOverridden, false);
  assert.equal(cleared.body.effectiveRenewDate, `${YEAR + 1}-11-15`);
});

// ---- S1: ask before pushing a service change onto the customers who have it ----

let bigPush: { id: number };
let smallPush: { id: number };
let typedPush: { id: number };
let noMeasurePush: { id: number };
const pushRows: Record<string, any> = {};

test("every account on a service, and what a change would make of it, before anything is pushed", async () => {
  bigPush = await newClient("SC Push Big", "6,200");
  smallPush = await newClient("SC Push Small", "3,000");
  typedPush = await newClient("SC Push Typed", "6,200");
  noMeasurePush = await newClient("SC Push No Measure", null);

  const recurring = (extra: Record<string, unknown> = {}) => ({
    serviceId: pushMow.id,
    scheduleType: "recurring",
    firstServiceDate: TODAY,
    seasonEndDate: plus(TODAY, 56),
    frequency: "weekly",
    weekday: weekdayOfDate(TODAY),
    assignedToId: eich.id,
    ...extra,
  });
  for (const [key, client, extra] of [
    ["big", bigPush, {}],
    ["small", smallPush, {}],
    // A price the office typed for a reason, which a push must not walk over.
    ["typed", typedPush, { amount: 99 }],
  ] as const) {
    const res = await post(`/clients/${client.id}/client-services`, admin.id, recurring(extra));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    pushRows[key] = res.body[0];
  }
  // The assign screen refuses a matrix service for a customer with no
  // measurement on file, so this one can only arrive the way the 709 Service
  // Autopilot customers did — imported, on the flat rate, with nothing under
  // Property Details. A push has to cope with those, because he has them.
  const [imported] = await db
    .insert(clientServicesTable)
    .values({
      clientId: noMeasurePush.id,
      serviceId: pushMow.id,
      scheduleType: "recurring",
      firstServiceDate: TODAY,
      seasonEndDate: plus(TODAY, 56),
      frequency: "weekly",
      weekday: weekdayOfDate(TODAY),
      amount: 40,
      assignedToId: eich.id,
    })
    .returning();
  pushRows.noMeasure = imported;
  assert.equal(pushRows.big.amount, 58, "priced from their own 6,200");
  assert.equal(pushRows.small.amount, 45, "and theirs from 3,000");
  assert.equal(pushRows.typed.amount, 99);
  assert.equal(pushRows.noMeasure.amount, 40, "no measurement on file, so the flat rate");

  // Mowing goes up $5 a band, and the big band's budget goes to 1.25 h.
  await db.update(servicesTable).set({ pricingEquations: BANDS(50, 63, 1.25) }).where(eq(servicesTable.id, pushMow.id));

  const impact = await api(`/services/${pushMow.id}/assigned-impact`, admin.id);
  assert.equal(impact.status, 200, JSON.stringify(impact.body));
  assert.equal(impact.body.clientCount, 4, "he is told how many customers before he answers");
  assert.equal(impact.body.rowCount, 4);
  assert.equal(impact.body.matrixPriced, true);
  assert.ok(impact.body.upcomingVisits > 0, "and how many visits are involved");
  assert.equal(impact.body.handTypedCount, 1);
  assert.equal(impact.body.missingFieldCount, 1);

  const rowFor = (clientId: number) => impact.body.rows.find((r: any) => r.clientId === clientId);
  // Each customer is re-priced against their OWN lawn, not slammed to one number.
  assert.equal(rowFor(bigPush.id).fromAmount, 58);
  assert.equal(rowFor(bigPush.id).toAmount, 63);
  assert.equal(rowFor(bigPush.id).toHours, 1.25);
  assert.equal(rowFor(smallPush.id).fromAmount, 45);
  assert.equal(rowFor(smallPush.id).toAmount, 50);
  assert.equal(rowFor(smallPush.id).toHours, 0.5);
  assert.equal(rowFor(typedPush.id).handTyped, true);
  assert.equal(rowFor(noMeasurePush.id).missingField, turfLabel);
  // "N accounts would change" has to be the number the button then pushes:
  // the two lawns the matrix re-prices. The typed price and the customer with
  // no measurement are counted on their own lines, because the push leaves
  // both alone.
  assert.equal(impact.body.priceDiffers, 2, "the same number the push moves, not one it then skips");
  assert.equal(impact.body.hoursDiffers, 2);
});

test("nothing is pushed until he says so, and then only the accounts it should touch", async () => {
  const preview = await post(`/services/${pushMow.id}/push-to-assigned`, admin.id, {
    fields: ["price", "hours"],
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.applied, false);
  assert.equal(preview.body.clientCount, 2, "the big and the small lawn");
  assert.ok(preview.body.visitsUpdated > 0);
  const skipReason = (clientId: number) =>
    preview.body.skipped.find((r: any) => r.clientId === clientId)?.reason ?? "";
  assert.match(skipReason(typedPush.id), /typed by hand/);
  assert.match(skipReason(noMeasurePush.id), new RegExp(`no ${turfLabel} on file`));

  // Not one row moved on a preview.
  const [stillBig] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, pushRows.big.id));
  assert.equal(stillBig.amount, 58, "a preview writes nothing");

  const applied = await post(`/services/${pushMow.id}/push-to-assigned`, admin.id, {
    fields: ["price", "hours"],
    apply: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.applied, true);
  assert.equal(applied.body.clientCount, 2);

  const [big] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, pushRows.big.id));
  assert.equal(big.amount, 63);
  assert.equal(big.budgetedHours, 1.25);
  assert.equal(big.pricedFromLabel, turfLabel, "and the account still says where the number came from");
  assert.equal(big.pricedFromValue, 6200);
  const [small] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, pushRows.small.id));
  assert.equal(small.amount, 50);
  const [typed] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, pushRows.typed.id));
  assert.equal(typed.amount, 99, "the price the office typed is still the price");

  // The visits still ahead of them carry the new price.
  const visits = await scheduledJobs(pushRows.big.id);
  assert.ok(visits.length > 0);
  assert.ok(visits.every((j) => j.amount === 63), visits.map((j) => `${j.scheduledDate}:${j.amount}`).join(" "));

  // "Every write that moves money" — on the account, in his words.
  const onAccount = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, bigPush.id), eq(auditEventsTable.action, "service_change_pushed")));
  assert.equal(onAccount.length, 1);
  assert.match(onAccount[0].description, /price \$58 → \$63/);
  assert.match(onAccount[0].description, /upcoming visit/);
  const wide = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "service_changes_pushed"));
  assert.ok(
    wide.some((a) => a.description.includes(`${stamp}`) && /to 2 customers/.test(a.description)),
    wide.map((a) => a.description).join(" | "),
  );

  // Asked again with nothing left to do, it says so rather than inventing work.
  const again = await post(`/services/${pushMow.id}/push-to-assigned`, admin.id, { fields: ["price", "hours"] });
  assert.equal(again.body.clientCount, 0);
  assert.ok(again.body.skipped.every((r: any) => r.reason != null));

  // And the typed price only moves when he says to include it.
  const includeTyped = await post(`/services/${pushMow.id}/push-to-assigned`, admin.id, {
    fields: ["price"],
    clientServiceIds: [pushRows.typed.id],
    includeCustomPrices: true,
    apply: true,
  });
  assert.equal(includeTyped.body.clientCount, 1);
  const [typedNow] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, pushRows.typed.id));
  assert.equal(typedNow.amount, 63);

  const nothingPicked = await post(`/services/${pushMow.id}/push-to-assigned`, admin.id, { fields: [] });
  assert.equal(nothingPicked.status, 400);
});

// ---- S4: one season end for everybody, and an early finish for one ----

test("one season end for every customer on the service, with the visits past it called off", async () => {
  const everyone = await newClient("SC Season Everyone", "6,200");
  const early = await newClient("SC Season Early", "6,200");
  const rows: Record<string, any> = {};
  for (const [key, client, seasonEnd] of [
    ["everyone", everyone, plus(TODAY, 56)],
    // This one already decided to stop early, and a bulk push must leave them be.
    ["early", early, plus(TODAY, 14)],
  ] as const) {
    const res = await post(`/clients/${client.id}/client-services`, admin.id, {
      serviceId: seasonMow.id,
      scheduleType: "recurring",
      firstServiceDate: TODAY,
      seasonEndDate: seasonEnd,
      frequency: "weekly",
      weekday: weekdayOfDate(TODAY),
      assignedToId: eich.id,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    rows[key] = res.body[0];
  }

  const lastDay = plus(TODAY, 28);
  const expectCancelled = (await scheduledJobs(rows.everyone.id)).filter((j) => j.scheduledDate > lastDay).length;
  assert.ok(expectCancelled > 0, "there have to be visits past it for this to mean anything");

  const preview = await post(`/services/${seasonMow.id}/season-end`, admin.id, { seasonEndDate: mmdd(lastDay) });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.applied, false);
  assert.equal(preview.body.customersChanged, 1, "the early finisher is not a change");
  assert.equal(preview.body.visitsCancelled, expectCancelled);
  const previewRow = (clientId: number) => preview.body.rows.find((r: any) => r.clientId === clientId);
  assert.equal(previewRow(everyone.id).to, lastDay, "the year-free date landed in this customer's season");
  assert.equal(previewRow(early.id).leftAlone, true);
  assert.equal(previewRow(early.id).visitsCancelled, 0);
  const [untouched] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, rows.everyone.id));
  assert.equal(untouched.seasonEndDate, plus(TODAY, 56), "a preview writes nothing");

  const applied = await post(`/services/${seasonMow.id}/season-end`, admin.id, {
    seasonEndDate: mmdd(lastDay),
    reason: "Season's over",
    apply: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.applied, true);
  assert.equal(applied.body.visitsCancelled, expectCancelled);

  const [svcNow] = await db.select().from(servicesTable).where(eq(servicesTable.id, seasonMow.id));
  assert.equal(svcNow.seasonEndDate, mmdd(lastDay), "the service keeps it year-free, because it is the same day every year");
  const [everyoneNow] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, rows.everyone.id));
  assert.equal(everyoneNow.seasonEndDate, lastDay);
  const [earlyNow] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, rows.early.id));
  assert.equal(earlyNow.seasonEndDate, plus(TODAY, 14), "they decided to stop early and still do");

  const after = await allJobs(rows.everyone.id);
  const past = after.filter((j) => j.scheduledDate > lastDay);
  assert.equal(past.length, expectCancelled);
  assert.ok(past.every((j) => j.status === "cancelled"), "called off, not deleted");
  assert.ok(past.every((j) => j.cancelReason === "Season's over"), "and the reason is on each one");
  assert.ok(
    after.filter((j) => j.scheduledDate <= lastDay).every((j) => j.status === "scheduled"),
    "the visits up to the last day are untouched",
  );

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, everyone.id), eq(auditEventsTable.action, "service_season_end_pushed")));
  assert.equal(audits.length, 1);
  assert.match(audits[0].description, new RegExp(`now ends ${lastDay}`));

  const refused = await post(`/services/${seasonMow.id}/season-end`, admin.id, { seasonEndDate: "02-30" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not a real calendar date/);
});

test("one customer finishes early: their last day, and the visits after it cancelled", async () => {
  const quitter = await newClient("SC Finish Early", null);
  const res = await post(`/clients/${quitter.id}/client-services`, admin.id, {
    serviceId: finishMow.id,
    scheduleType: "recurring",
    firstServiceDate: TODAY,
    seasonEndDate: plus(TODAY, 70),
    frequency: "weekly",
    weekday: weekdayOfDate(TODAY),
    assignedToId: eich.id,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = res.body[0];

  const lastDay = plus(TODAY, 21);
  const expectCancelled = (await scheduledJobs(row.id)).filter((j) => j.scheduledDate > lastDay).length;
  assert.ok(expectCancelled > 0);

  // A date before the season even starts is a mistake, and says so.
  const silly = await post(`/client-services/${row.id}/finish-season`, admin.id, { lastDate: plus(TODAY, -7) });
  assert.equal(silly.status, 400);
  assert.match(silly.body.error, /cannot finish on/);
  // A last day is one day, so it needs a year.
  const noYear = await post(`/client-services/${row.id}/finish-season`, admin.id, { lastDate: mmdd(lastDay) });
  assert.equal(noYear.status, 400);

  const preview = await post(`/client-services/${row.id}/finish-season`, admin.id, { lastDate: lastDay });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.applied, false);
  assert.equal(preview.body.visitsCancelled, expectCancelled, "he is told what it takes off the board first");
  assert.equal(preview.body.seasonEndWas, plus(TODAY, 70));
  const [untouched] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, row.id));
  assert.equal(untouched.seasonEndDate, plus(TODAY, 70));

  const applied = await post(`/client-services/${row.id}/finish-season`, admin.id, {
    lastDate: lastDay,
    reason: "Selling the house",
    apply: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.visitsCancelled, expectCancelled);
  assert.equal(applied.body.service.seasonEndDate, lastDay);

  const after = await allJobs(row.id);
  const past = after.filter((j) => j.scheduledDate > lastDay);
  assert.ok(past.length > 0);
  assert.ok(past.every((j) => j.status === "cancelled" && j.cancelReason === "Selling the house"));
  assert.ok(after.filter((j) => j.scheduledDate <= lastDay).every((j) => j.status === "scheduled"));

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, quitter.id), eq(auditEventsTable.action, "service_season_finished_early")));
  assert.equal(audits.length, 1);
  assert.match(audits[0].description, /Selling the house/);
});

// ---- S5: the account reads down the year, not down the id list ----

test("the packages and services on an account are listed by when their window starts", async () => {
  const customer = await newClient("SC Order Customer", "6,200");
  // Created latest-first on purpose: the old list was in id order.
  const october = await post(`/clients/${customer.id}/client-services`, admin.id, {
    serviceId: blowout.id,
    scheduleType: "window",
    startDate: `${YEAR + 1}-10-01`,
    endDate: `${YEAR + 1}-10-31`,
  });
  const june = await post(`/clients/${customer.id}/client-services`, admin.id, {
    serviceId: mowing.id,
    scheduleType: "recurring",
    firstServiceDate: `${YEAR + 1}-06-05`,
    seasonEndDate: `${YEAR + 1}-09-30`,
    frequency: "weekly",
    weekday: weekdayOfDate(`${YEAR + 1}-06-05`),
  });
  const april = await post(`/clients/${customer.id}/client-services`, admin.id, {
    serviceId: blowout.id,
    scheduleType: "window",
    startDate: `${YEAR + 1}-04-10`,
    endDate: `${YEAR + 1}-04-30`,
  });
  for (const r of [october, june, april]) assert.equal(r.status, 201, JSON.stringify(r.body));

  const listed = await api(`/clients/${customer.id}/client-services`, admin.id);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.map((r: any) => r.id),
    [april.body[0].id, june.body[0].id, october.body[0].id],
    "April, June, October — the order the work happens in, not the order they were typed",
  );
  assert.deepEqual(
    listed.body.map((r: any) => r.seasonStart),
    [`${YEAR + 1}-04-10`, `${YEAR + 1}-06-05`, `${YEAR + 1}-10-01`],
  );

  // A package stays together and sits where its earliest entry falls.
  const pkg = await post("/packages", admin.id, {
    name: `SC Order Package ${stamp}`,
    scheduleType: "window",
    startDate: `${YEAR + 1}-05-01`,
    endDate: `${YEAR + 1}-08-31`,
    items: [
      { serviceId: blowout.id, label: "First", windowStart: `${YEAR + 1}-05-01`, windowEnd: `${YEAR + 1}-05-31` },
      { serviceId: blowout.id, label: "Second", windowStart: `${YEAR + 1}-08-01`, windowEnd: `${YEAR + 1}-08-31` },
    ],
  });
  assert.equal(pkg.status, 201, JSON.stringify(pkg.body));
  ids.packages.push(pkg.body.id);
  const assigned = await post(`/clients/${customer.id}/client-services`, admin.id, { packageId: pkg.body.id });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

  const withPackage = await api(`/clients/${customer.id}/client-services`, admin.id);
  const order = withPackage.body.map((r: any) => r.label ?? `#${r.id}`);
  assert.deepEqual(
    order,
    [`#${april.body[0].id}`, "First", "Second", `#${june.body[0].id}`, `#${october.body[0].id}`],
    "the package is one block from May, so its August entry comes before the June single service",
  );
});

// ---- S6: last year's details stay on the account ----

test("renewing keeps last season on the account instead of replacing it", async () => {
  const customer = await newClient("SC History Customer", "6,200");
  const res = await post(`/clients/${customer.id}/client-services`, admin.id, {
    serviceId: historyMow.id,
    scheduleType: "recurring",
    firstServiceDate: `${YEAR - 1}-05-01`,
    seasonEndDate: `${YEAR - 1}-09-30`,
    frequency: "weekly",
    weekday: weekdayOfDate(`${YEAR - 1}-05-01`),
    assignedToId: eich.id,
    discountType: "amount",
    discountValue: 5,
    discountLabel: "Loyalty discount",
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = res.body[0];
  assert.equal(row.amount, 58);
  assert.deepEqual(row.pastSeasons, [], "nothing has closed yet");

  // Two mows actually done last season, so the snapshot has something to say.
  await db.insert(jobsTable).values([
    { clientId: customer.id, clientServiceId: row.id, serviceId: historyMow.id, scheduledDate: `${YEAR - 1}-05-01`, status: "completed", amount: 58, assignedToId: eich.id },
    { clientId: customer.id, clientServiceId: row.id, serviceId: historyMow.id, scheduledDate: `${YEAR - 1}-05-08`, status: "completed", amount: 58, assignedToId: eich.id },
  ]);

  const renewed = await post(`/client-services/${row.id}/renew`, admin.id, {});
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal(renewed.body.firstServiceDate, `${YEAR}-05-01`, "rolled into the new season");
  assert.equal(renewed.body.pastSeasons.length, 1, "and last year did not go with it");

  const last = renewed.body.pastSeasons[0];
  assert.equal(last.year, YEAR - 1);
  assert.equal(last.firstServiceDate, `${YEAR - 1}-05-01`);
  assert.equal(last.seasonEndDate, `${YEAR - 1}-09-30`);
  assert.equal(last.amount, 58, "what a visit cost that year, never recomputed");
  assert.equal(last.assignedToName, "Eich", "who had it, by the name he reads");
  assert.equal(last.completedVisits, 2);
  assert.equal(last.completedTotal, 116);
  assert.equal(last.discountLabel, "Loyalty discount");
  assert.match(last.cadence, /Weekly/i);

  // The visits themselves never moved, so the history list is as long as ever.
  const jobs = await allJobs(row.id);
  assert.ok(jobs.filter((j) => j.status === "completed").length === 2);

  // The account still reads the closed season after a second rollover, and a
  // price change since then does not rewrite what the customer actually had.
  await db.update(clientServicesTable).set({ amount: 70 }).where(eq(clientServicesTable.id, row.id));
  const again = await post(`/client-services/${row.id}/renew`, admin.id, {});
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.pastSeasons.length, 2);
  assert.equal(again.body.pastSeasons[0].amount, 58, "last year is a snapshot, not a recalculation");
  assert.equal(again.body.pastSeasons[1].year, YEAR);
  assert.equal(again.body.pastSeasons[1].amount, 70);

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, customer.id), eq(auditEventsTable.action, "service_renewed")));
  assert.ok(audits.length >= 2, "one line per rollover");
  assert.ok(
    audits.some((a) => a.description.includes(`The ${YEAR - 1} season stays on the account`)),
    audits.map((a) => a.description).join(" | "),
  );

  // And seasonStart is what the ordering reads, now pointing at the new season.
  assert.equal(seasonStartOf({ scheduleType: "recurring", startDate: null, firstServiceDate: `${YEAR + 1}-05-01` }), `${YEAR + 1}-05-01`);
});

// ---- S4 again: the rows the bulk season end was getting wrong ----

test("the bulk season end reads the year off today, not off a row the renewal never rolled", async () => {
  const [staleSvc] = await db
    .insert(servicesTable)
    .values({ name: `SC Stale Mowing ${stamp}`, code: "SCSTALE", rate: 50 })
    .returning();
  ids.services.push(staleSvc.id);

  const lastDay = plus(TODAY, 21);
  const md = mmdd(lastDay);
  // What the date he typed means for a season that is running right now.
  const expected = resolveSeasonDate(md, TODAY)!;
  assert.ok(expected >= TODAY, `${expected} has to be a day still ahead of us`);

  // The row the nightly renewal skips: auto-renew off, paused, or a one-off.
  // It still carries LAST spring's start date, and its visits are this year's.
  const staleClient = await newClient("SC Stale Season", null);
  const [stale] = await db
    .insert(clientServicesTable)
    .values({
      clientId: staleClient.id,
      serviceId: staleSvc.id,
      scheduleType: "recurring",
      firstServiceDate: `${YEAR - 1}-04-20`,
      seasonEndDate: `${YEAR}-12-31`,
      frequency: "weekly",
      frequencyWeeks: 1,
      weekday: weekdayOfDate(TODAY),
      amount: 50,
      autoRenew: false,
    })
    .returning();
  const soon = plus(TODAY, 7);
  const later = plus(TODAY, 35);
  await db.insert(jobsTable).values([
    { clientId: staleClient.id, clientServiceId: stale.id, serviceId: staleSvc.id, scheduledDate: soon, status: "scheduled", amount: 50 },
    { clientId: staleClient.id, clientServiceId: stale.id, serviceId: staleSvc.id, scheduledDate: later, status: "scheduled", amount: 50 },
  ]);

  // The row that most needs the new date: its finish is LAST year's, which is
  // not somebody who decided to stop early.
  const lastYearClient = await newClient("SC Last Year Finish", null);
  const [lastYear] = await db
    .insert(clientServicesTable)
    .values({
      clientId: lastYearClient.id,
      serviceId: staleSvc.id,
      scheduleType: "recurring",
      firstServiceDate: `${YEAR}-05-01`,
      seasonEndDate: `${YEAR - 1}-10-15`,
      frequency: "weekly",
      frequencyWeeks: 1,
      weekday: weekdayOfDate(TODAY),
      amount: 50,
    })
    .returning();

  // And somebody who really does finish early, this season, who must be left be.
  const earlyClient = await newClient("SC Really Early", null);
  const [early] = await db
    .insert(clientServicesTable)
    .values({
      clientId: earlyClient.id,
      serviceId: staleSvc.id,
      scheduleType: "recurring",
      firstServiceDate: TODAY,
      seasonEndDate: plus(TODAY, 7),
      frequency: "weekly",
      frequencyWeeks: 1,
      weekday: weekdayOfDate(TODAY),
      amount: 50,
    })
    .returning();

  const preview = await post(`/services/${staleSvc.id}/season-end`, admin.id, { seasonEndDate: md });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const rowFor = (csId: number) => preview.body.rows.find((r: any) => r.clientServiceId === csId);
  assert.equal(rowFor(stale.id).to, expected, "a row still on last spring's start gets THIS season's date");
  assert.equal(rowFor(lastYear.id).leftAlone, false, "last year's finish is not an early finish");
  assert.equal(rowFor(lastYear.id).to, expected);
  assert.equal(rowFor(early.id).leftAlone, true, "a date earlier in this same season is still left alone");

  const applied = await post(`/services/${staleSvc.id}/season-end`, admin.id, { seasonEndDate: md, apply: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));

  const [staleNow] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, stale.id));
  assert.equal(staleNow.seasonEndDate, expected, "never a season end in a year that is already over");
  const kept = await scheduledJobs(stale.id);
  assert.deepEqual(
    kept.map((j) => j.scheduledDate),
    [soon],
    "the visits up to the new last day stay on the board",
  );
  const all = await allJobs(stale.id);
  assert.equal(all.find((j) => j.scheduledDate === later)?.status, "cancelled");
  const [earlyNow] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, early.id));
  assert.equal(earlyNow.seasonEndDate, plus(TODAY, 7));

  // A full date already behind us would call off the rest of everybody's year.
  const past = await post(`/services/${staleSvc.id}/season-end`, admin.id, { seasonEndDate: `${YEAR - 1}-10-15` });
  assert.equal(past.status, 400, JSON.stringify(past.body));
  assert.match(past.body.error, /already gone by/);
});

test("a paused account is left out of the bulk season end, the way the service page says it is", async () => {
  const [pauseSvc] = await db
    .insert(servicesTable)
    .values({ name: `SC Paused Mowing ${stamp}`, code: "SCPAUSE", rate: 50 })
    .returning();
  ids.services.push(pauseSvc.id);

  const customer = await newClient("SC Paused Season", null);
  const res = await post(`/clients/${customer.id}/client-services`, admin.id, {
    serviceId: pauseSvc.id,
    scheduleType: "recurring",
    firstServiceDate: TODAY,
    seasonEndDate: plus(TODAY, 70),
    frequency: "weekly",
    weekday: weekdayOfDate(TODAY),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = res.body[0];
  const paused = await post(`/client-services/${row.id}/pause`, admin.id, { reason: "Not this year" });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  const [afterPause] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, row.id));
  assert.equal(afterPause.active, true, "pausing leaves the row active, which is why it has to be filtered out");
  assert.ok(afterPause.pausedAt != null);

  const applied = await post(`/services/${pauseSvc.id}/season-end`, admin.id, {
    seasonEndDate: mmdd(plus(TODAY, 21)),
    apply: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.rows, [], "a switched-off customer is not in the push at all");
  const [stillPaused] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, row.id));
  assert.equal(stillPaused.seasonEndDate, plus(TODAY, 70), "nothing was written on the paused row");
  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, customer.id), eq(auditEventsTable.action, "service_season_end_pushed")));
  assert.equal(audits.length, 0, "and he was not told their season moved");
});

// ---- S1 again: a flat-rate service has prices typed by hand too ----

test("a price negotiated by hand on a flat-rate service is left alone unless he says to include it", async () => {
  const [flat] = await db
    .insert(servicesTable)
    .values({ name: `SC Flat Clean-Up ${stamp}`, code: "SCFLAT", rate: 220, billableHours: 2 })
    .returning();
  ids.services.push(flat.id);

  const rows: Record<string, any> = {};
  for (const [key, amount] of [["plainA", null], ["plainB", null], ["cut", 180]] as const) {
    const client = await newClient(`SC Flat ${key}`, null);
    const res = await post(`/clients/${client.id}/client-services`, admin.id, {
      serviceId: flat.id,
      scheduleType: "recurring",
      firstServiceDate: TODAY,
      seasonEndDate: plus(TODAY, 56),
      frequency: "weekly",
      weekday: weekdayOfDate(TODAY),
      ...(amount == null ? {} : { amount }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    rows[key] = res.body[0];
  }
  assert.equal(rows.plainA.amount, 220, "on the service's rate, nobody typed it");
  assert.equal(rows.cut.amount, 180, "and this one was negotiated down");

  // Fall clean-up goes up $20.
  const raised = await patch(`/services/${flat.id}`, admin.id, { rate: 240 });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));

  const impact = await api(`/services/${flat.id}/assigned-impact?fromRate=220`, admin.id);
  assert.equal(impact.status, 200, JSON.stringify(impact.body));
  assert.equal(impact.body.matrixPriced, false);
  assert.equal(impact.body.handTypedCount, 1, "the negotiated one, and only that one");
  assert.equal(impact.body.priceDiffers, 2, "the two on the old rate — the same number the push will move");
  const impactRow = (csId: number) => impact.body.rows.find((r: any) => r.clientServiceId === csId);
  assert.equal(impactRow(rows.cut.id).handTyped, true);
  assert.equal(impactRow(rows.plainA.id).handTyped, false);

  const applied = await post(`/services/${flat.id}/push-to-assigned`, admin.id, {
    fields: ["price"],
    fromRate: 220,
    apply: true,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.clientCount, 2, "the number on the button is the number that moved");
  const [cutNow] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, rows.cut.id));
  assert.equal(cutNow.amount, 180, "the price somebody agreed with the customer is still the price");
  const [plainNow] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, rows.plainA.id));
  assert.equal(plainNow.amount, 240);
  assert.match(
    applied.body.skipped.find((r: any) => r.clientServiceId === rows.cut.id)?.reason ?? "",
    /typed by hand/,
  );

  // And it still moves when he ticks to include it.
  const included = await post(`/services/${flat.id}/push-to-assigned`, admin.id, {
    fields: ["price"],
    clientServiceIds: [rows.cut.id],
    includeCustomPrices: true,
    fromRate: 220,
    apply: true,
  });
  assert.equal(included.body.clientCount, 1);
  const [cutAfter] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, rows.cut.id));
  assert.equal(cutAfter.amount, 240);

  // Nobody picked is nobody — never everybody.
  const nobody = await post(`/services/${flat.id}/push-to-assigned`, admin.id, {
    fields: ["price"],
    clientServiceIds: [],
    apply: true,
  });
  assert.equal(nobody.status, 400, JSON.stringify(nobody.body));
  assert.match(nobody.body.error, /No customers were picked/);
});

// ---- S3 again: what counts as a date typed for one customer ----

test("moving a customer's first service date does not pin their renew date off the service", async () => {
  const [renewSvc] = await db
    .insert(servicesTable)
    .values({ name: `SC Renew Anchor ${stamp}`, code: "SCANCH", rate: 50, renewDate: "03-01" })
    .returning();
  ids.services.push(renewSvc.id);

  const customer = await newClient("SC Renew Anchor Customer", null);
  const assigned = await post(`/clients/${customer.id}/client-services`, admin.id, {
    serviceId: renewSvc.id,
    scheduleType: "recurring",
    firstServiceDate: `${YEAR + 1}-04-15`,
    seasonEndDate: `${YEAR + 1}-09-30`,
    frequency: "weekly",
    weekday: weekdayOfDate(`${YEAR + 1}-04-15`),
  });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  const row = assigned.body[0];
  assert.equal(row.renewDateOverridden, false);
  assert.equal(row.effectiveRenewDate, `${YEAR + 2}-03-01`, "the March after their season");

  // He opens the row only to move the first mow, and the dialog sends the
  // renew date box back exactly as it came up.
  const moved = await patch(`/client-services/${row.id}`, admin.id, {
    renewDate: row.effectiveRenewDate,
    firstServiceDate: `${YEAR + 1}-02-01`,
    weekday: weekdayOfDate(`${YEAR + 1}-02-01`),
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.renewDateOverridden, false, "he changed a start date, not the renew date");
  assert.equal(moved.body.renewDateFromService, true);
  assert.equal(moved.body.effectiveRenewDate, `${YEAR + 1}-03-01`, "and it still follows the service");

  // Change it on the service and this customer still follows.
  const onService = await patch(`/services/${renewSvc.id}`, admin.id, { renewDate: "11-15" });
  assert.equal(onService.status, 200, JSON.stringify(onService.body));
  const listed = await api(`/clients/${customer.id}/client-services`, admin.id);
  const seen = listed.body.find((r: any) => r.id === row.id);
  assert.equal(seen.effectiveRenewDate, `${YEAR + 1}-11-15`);

  // Typing a date that is nobody's but theirs is still theirs.
  const typed = await patch(`/client-services/${row.id}`, admin.id, { renewDate: `${YEAR + 1}-12-20` });
  assert.equal(typed.body.renewDateOverridden, true);
});

test("a package's own renew date is the one the customer renews on, not the service's", async () => {
  const [pkgSvc] = await db
    .insert(servicesTable)
    .values({ name: `SC Pkg Renew Service ${stamp}`, code: "SCPKGR", rate: 90, renewDate: "09-01" })
    .returning();
  ids.services.push(pkgSvc.id);

  const made = await post("/packages", admin.id, {
    name: `SC Pkg Renew ${stamp}`,
    scheduleType: "window",
    startDate: "10-01",
    endDate: "11-30",
    renewDate: "03-15",
    items: [{ serviceId: pkgSvc.id, label: "Blow-out", windowStart: "10-01", windowEnd: "11-30" }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  ids.packages.push(made.body.id);

  const customer = await newClient("SC Pkg Renew Customer", null);
  // Nothing in the body says renewDate — the package's own date is the only
  // one anybody typed.
  const assigned = await post(`/clients/${customer.id}/client-services`, admin.id, { packageId: made.body.id });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  const row = assigned.body[0];
  const wanted = resolveSeasonDate("03-15", row.startDate, { rollStale: true });
  assert.equal(row.renewDate, wanted, "the package said March, so March it is");
  assert.equal(row.renewDateOverridden, true, "a date typed on the package is this customer's own");
  assert.equal(row.effectiveRenewDate, wanted, "and it is the date that governs, not the service's September");
  assert.equal(row.renewDateFromService, false);
});

// ---- S2 again: a date typed WITH a year is the year he asked for ----

test("only the side of a window he left year-free is ever moved", () => {
  // The start carries a year he typed on purpose; the end is year-free.
  assert.deepEqual(resolveSeasonWindow("2026-04-01", "05-30", "2026-10-03"), {
    startDate: "2026-04-01",
    endDate: "2026-05-30",
  });
  // A window he dated into next year is not dragged back to this one.
  assert.deepEqual(resolveSeasonWindow("2027-11-01", "12-30", "2026-10-03"), {
    startDate: "2027-11-01",
    endDate: "2027-12-30",
  });
  // The same the other way round: a full end date keeps its year and the
  // year-free start lands in that season.
  assert.deepEqual(resolveSeasonWindow("06-01", "2029-06-30", "2026-10-03"), {
    startDate: "2029-06-01",
    endDate: "2029-06-30",
  });
  // November into February still reads as one window when the end is dated.
  assert.deepEqual(resolveSeasonWindow("11-01", "2027-02-28", "2026-10-03"), {
    startDate: "2026-11-01",
    endDate: "2027-02-28",
  });
  // A year-free end with no start at all belongs to the season still ahead of
  // us, not the one four months gone.
  assert.deepEqual(resolveSeasonWindow(null, "05-30", "2026-10-03"), {
    startDate: null,
    endDate: "2027-05-30",
  });
  // And both sides year-free behave exactly as they did.
  assert.deepEqual(resolveSeasonWindow("04-01", "06-30", "2026-08-01"), {
    startDate: "2027-04-01",
    endDate: "2027-06-30",
  });
});

test("a service holds its renew date and season end written year-free, the way its own form types them", async () => {
  const [svc] = await db
    .insert(servicesTable)
    .values({ name: `SC Year Free ${stamp}`, code: "SCYRF", rate: 60 })
    .returning();
  ids.services.push(svc.id);

  const saved = await patch(`/services/${svc.id}`, admin.id, { renewDate: "03-01", seasonEndDate: "10-15" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.renewDate, "03-01", "the same day every year, kept as typed");
  assert.equal(saved.body.seasonEndDate, "10-15");
  const read = await api(`/services/${svc.id}`, admin.id);
  assert.equal(read.body.renewDate, "03-01");
  assert.equal(read.body.seasonEndDate, "10-15");
});
