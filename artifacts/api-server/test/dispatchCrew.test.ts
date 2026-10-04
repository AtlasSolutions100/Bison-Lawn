import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  jobsTable,
  jobCrewTable,
  jobTimeEntriesTable,
  servicesTable,
  auditEventsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// The three dispatch-board changes that live on the server: a crew on a job
// ("document crew member on clean ups"), moving one stop's number and letting
// the rest shuffle ("without having to redo all the numbers"), and filtering
// the board by one of his custom customer fields.
//
// Same harness as integration.test.ts: NODE_ENV=test plus a per-process token
// opens the x-test-user-id bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[], services: [] as number[] };

// The crew and route-position lines that carry no clientId go by actor, the way
// dispatchActions.test.ts does, so a run cannot leave rows in the activity feed
// on the database that holds his 709 real customers.
const ADMIN_NAME = `Crew Admin ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let admin: { id: number };
let lead: { id: number };
let second: { id: number };
let third: { id: number };
let bigLawn: { id: number }; // Turf Sqft 12,000, gate code
let smallLawn: { id: number }; // Turf Sqft 4000
let noFields: { id: number }; // nothing on file
let service: { id: number };

const TODAY = new Date().toISOString().slice(0, 10);
const shift = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const TOMORROW = shift(1);

/**
 * A day of its own for each route test.
 *
 * A run is one sub's one day, so two tests sharing a date share a run and the
 * second one shuffles the first one's stops. Far enough out that nothing on his
 * real board is near them.
 */
let dayCursor = 400;
const freshDay = () => shift(dayCursor++);

async function api(path: string, userId: number | null, init: RequestInit = {}) {
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

const post = (path: string, userId: number, data?: unknown) =>
  api(path, userId, { method: "POST", body: JSON.stringify(data ?? {}) });
const put = (path: string, userId: number, data: unknown) =>
  api(path, userId, { method: "PUT", body: JSON.stringify(data) });

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const people = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_crew_admin_${stamp}`, name: ADMIN_NAME, role: "admin", roleSource: "owner_assigned" },
      // Account names are emails on purpose: every screen must show the short
      // name he set, never the login.
      { clerkId: `test_crew_lead_${stamp}`, name: "disa@example.com", displayName: "Disa", role: "contractor" },
      { clerkId: `test_crew_2nd_${stamp}`, name: "gabe@example.com", displayName: "Gabe", role: "contractor" },
      { clerkId: `test_crew_3rd_${stamp}`, name: "spencer@example.com", displayName: "Spencer", role: "contractor" },
    ])
    .returning();
  [admin, lead, second, third] = people;
  ids.users.push(...people.map((p) => p.id));

  const clients = await db
    .insert(clientsTable)
    .values([
      {
        name: `Crew Big Lawn ${stamp}`,
        status: "client",
        serviceAddress: "615 E 18th",
        city: "Post Falls",
        state: "ID",
        // Typed the way a real row is: a comma in the number, and the label
        // capitalised differently from the field in Settings.
        propertyData: { "turf sqft": "12,000", "Gate Code": "4417" },
      },
      {
        name: `Crew Small Lawn ${stamp}`,
        status: "client",
        serviceAddress: "22 Oak",
        city: "Hayden",
        state: "ID",
        propertyData: { "Turf Sqft": "4000" },
      },
      { name: `Crew No Fields ${stamp}`, status: "client", serviceAddress: "9 Pine", city: "Hayden", state: "ID" },
    ])
    .returning();
  [bigLawn, smallLawn, noFields] = clients;
  ids.clients.push(...clients.map((c) => c.id));

  const [svc] = await db
    .insert(servicesTable)
    .values({ name: `Crew Clean Up ${stamp}`, code: "CU9" })
    .returning();
  service = svc;
  ids.services.push(svc.id);
});

after(async () => {
  if (ids.clients.length) {
    await db.delete(auditEventsTable).where(inArray(auditEventsTable.clientId, ids.clients));
    // job_crew and job_time_entries cascade off the jobs, which cascade off the
    // clients.
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  await db.delete(auditEventsTable).where(eq(auditEventsTable.actorName, ADMIN_NAME));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

async function createJob(overrides: Partial<typeof jobsTable.$inferInsert> = {}) {
  const [job] = await db
    .insert(jobsTable)
    .values({
      clientId: bigLawn.id,
      serviceId: service.id,
      amount: 50,
      dispatched: true,
      scheduledDate: TODAY,
      assignedToId: lead.id,
      ...overrides,
    })
    .returning();
  return job;
}

const readJob = async (id: number) => (await db.select().from(jobsTable).where(eq(jobsTable.id, id)))[0] ?? null;

// ---------------------------------------------------------------- crew (D7)

test("the office puts more than one person on a clean up, and the lead stays the lead", async () => {
  const job = await createJob();
  const res = await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [second.id, third.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.leadId, lead.id);
  assert.deepEqual(
    res.body.crew.map((c: { name: string }) => c.name),
    ["Gabe", "Spencer"],
    "the short names he set, in a stable order — never the login email",
  );

  const after = await readJob(job.id);
  assert.equal(after?.assignedToId, lead.id, "the crew must never move who the job belongs to");

  const board = await api(`/jobs?from=${TODAY}&to=${TODAY}`, admin.id);
  const row = board.body.find((j: { id: number }) => j.id === job.id);
  assert.deepEqual(
    row.crew.map((c: { name: string }) => c.name),
    ["Gabe", "Spencer"],
    "the board reads the crew off the job it already loaded",
  );
});

test("the whole list replaces what was there, and the lead ticked by mistake is dropped quietly", async () => {
  const job = await createJob();
  await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [second.id, third.id] });

  // Down to one.
  const trimmed = await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [third.id] });
  assert.deepEqual(trimmed.body.crew.map((c: { name: string }) => c.name), ["Spencer"]);

  // The lead in the crew box is the same person said twice, not an error.
  const withLead = await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [lead.id, second.id] });
  assert.equal(withLead.status, 200);
  assert.deepEqual(withLead.body.crew.map((c: { id: number }) => c.id), [second.id]);

  // Nobody else on it.
  const cleared = await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [] });
  assert.deepEqual(cleared.body.crew, []);
  const rows = await db.select().from(jobCrewTable).where(eq(jobCrewTable.jobId, job.id));
  assert.equal(rows.length, 0, "clearing the crew leaves no rows behind to haunt a later report");
});

test("the same name twice in one call is one person on the crew", async () => {
  const job = await createJob();
  const res = await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [second.id, second.id, second.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.crew.length, 1, "two taps on Gabe must not put Gabe on the crew twice");
});

test("a name that is not in the team any more is refused, not stored", async () => {
  const job = await createJob();
  const res = await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [second.id, 99_000_123] });
  assert.equal(res.status, 400);
  const rows = await db.select().from(jobCrewTable).where(eq(jobCrewTable.jobId, job.id));
  assert.equal(rows.length, 0, "a refused call changes nothing, not even the half of it that was valid");
});

test("deciding who is on a crew is an office job", async () => {
  const job = await createJob();
  const res = await put(`/jobs/${job.id}/crew`, second.id, { userIds: [third.id] });
  assert.equal(res.status, 403);
});

test("a crew member sees the stop on his own day, and the lead still does", async () => {
  const job = await createJob();
  await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [third.id] });

  const his = await api(`/my/jobs?date=${TODAY}`, third.id);
  assert.ok(
    his.body.some((j: { id: number }) => j.id === job.id),
    "add crew members to the day and the second man has to see where to turn up",
  );

  const leads = await api(`/my/jobs?date=${TODAY}`, lead.id);
  assert.ok(leads.body.some((j: { id: number }) => j.id === job.id));

  const route = await api(`/my/route?date=${TODAY}`, third.id);
  assert.ok(route.body.stops.some((s: { jobId: number | null }) => s.jobId === job.id), "and on his route");

  // Somebody not on it still does not see it.
  const other = await api(`/my/jobs?date=${TODAY}`, second.id);
  assert.ok(!other.body.some((j: { id: number }) => j.id === job.id));
});

test("a job hidden from contractors stays hidden, crew or not", async () => {
  const job = await createJob({ visibleToContractor: false });
  await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [third.id] });
  const his = await api(`/my/jobs?date=${TODAY}`, third.id);
  assert.ok(!his.body.some((j: { id: number }) => j.id === job.id));
  const clock = await post(`/jobs/${job.id}/clock-in`, third.id);
  assert.equal(clock.status, 403, "the crew rule must not open a door the office closed");
});

test("the second man clocks his own hours on the clean up", async () => {
  const job = await createJob();
  await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [second.id] });

  const refused = await post(`/jobs/${job.id}/clock-in`, third.id);
  assert.equal(refused.status, 403, "somebody who was never on the job cannot clock onto it");

  const inRes = await post(`/jobs/${job.id}/clock-in`, second.id);
  assert.equal(inRes.status, 201);
  const outRes = await post(`/jobs/${job.id}/clock-out`, second.id);
  assert.equal(outRes.status, 200);

  const entries = await db.select().from(jobTimeEntriesTable).where(eq(jobTimeEntriesTable.jobId, job.id));
  assert.ok(
    entries.some((e) => e.userId === second.id),
    "without this the clean up's hours are one man's and the rest is a guess",
  );
});

test("a crew change is written on the customer's own history", async () => {
  const job = await createJob();
  await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [second.id] });
  const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, bigLawn.id));
  const line = events.find((e) => e.action === "job_crew_set" && e.description?.includes(`#${job.id}`));
  assert.ok(line, "who was meant to be at this clean up is exactly what gets asked afterwards");
  assert.ok(line!.description!.includes("Gabe"));
});

// -------------------------------------------------- one stop's number (D3)

/** A run of `count` stops for one sub on one day, numbered 1..count. */
async function buildRun(assignedToId: number | null, date: string, count: number) {
  const made = [];
  for (let i = 1; i <= count; i++) {
    made.push(await createJob({ assignedToId, scheduledDate: date, routeOrder: i }));
  }
  return made;
}

async function orderOf(jobIds: number[]) {
  const rows = await db.select().from(jobsTable).where(inArray(jobsTable.id, jobIds));
  const map = new Map(rows.map((r) => [r.id, r.routeOrder]));
  return jobIds.map((id) => map.get(id) ?? null);
}

test("typing a number on one stop shuffles the rest instead of leaving two the same", async () => {
  const run = await buildRun(lead.id, freshDay(), 5);
  // The fifth stop belongs second.
  const res = await post(`/jobs/${run[4].id}/route-position`, admin.id, { position: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.position, 2);
  assert.equal(res.body.runSize, 5);

  assert.deepEqual(await orderOf(run.map((j) => j.id)), [1, 3, 4, 5, 2]);
  const numbers = (await orderOf(run.map((j) => j.id))).slice().sort();
  assert.deepEqual(numbers, [1, 2, 3, 4, 5], "every stop has its own number — that was the whole complaint");
});

test("moving a stop down the run works the same way", async () => {
  const run = await buildRun(lead.id, freshDay(), 4);
  await post(`/jobs/${run[0].id}/route-position`, admin.id, { position: 3 });
  assert.deepEqual(await orderOf(run.map((j) => j.id)), [3, 1, 2, 4]);
});

test("a number past the end of the run puts the stop last rather than refusing it", async () => {
  const run = await buildRun(lead.id, freshDay(), 3);
  const res = await post(`/jobs/${run[0].id}/route-position`, admin.id, { position: 99 });
  assert.equal(res.body.position, 3, "he meant last, and saying no would send him back to renumber by hand");
  assert.deepEqual(await orderOf(run.map((j) => j.id)), [3, 1, 2]);
});

test("the shuffle stays inside one person's day", async () => {
  const day = freshDay();
  const nextDay = freshDay();
  const mine = await buildRun(lead.id, day, 3);
  const his = await buildRun(second.id, day, 3);
  const tomorrow = await buildRun(lead.id, nextDay, 3);

  await post(`/jobs/${mine[2].id}/route-position`, admin.id, { position: 1 });

  assert.deepEqual(await orderOf(mine.map((j) => j.id)), [2, 3, 1]);
  assert.deepEqual(await orderOf(his.map((j) => j.id)), [1, 2, 3], "Spencer's run is not Disa's");
  assert.deepEqual(await orderOf(tomorrow.map((j) => j.id)), [1, 2, 3], "and tomorrow is not today");
});

test("stops he has not numbered yet stay unnumbered", async () => {
  const day = freshDay();
  const run = await buildRun(lead.id, day, 2);
  const notInTheRun = await createJob({ assignedToId: lead.id, scheduledDate: day, routeOrder: null });
  const another = await createJob({ assignedToId: lead.id, scheduledDate: day, routeOrder: null });

  await post(`/jobs/${run[1].id}/route-position`, admin.id, { position: 1 });

  assert.deepEqual(await orderOf([run[1].id, run[0].id]), [1, 2]);
  assert.deepEqual(
    await orderOf([notInTheRun.id, another.id]),
    [null, null],
    "numbering a day he only part numbered IS the redo he asked to be rid of",
  );
});

test("a stop with no number can be dropped into the run", async () => {
  const day = freshDay();
  const run = await buildRun(lead.id, day, 3);
  const loose = await createJob({ assignedToId: lead.id, scheduledDate: day, routeOrder: null });
  const res = await post(`/jobs/${loose.id}/route-position`, admin.id, { position: 2 });
  assert.equal(res.body.position, 2);
  assert.equal(res.body.runSize, 4);
  assert.deepEqual(await orderOf([run[0].id, loose.id, run[1].id, run[2].id]), [1, 2, 3, 4]);
});

test("a cancelled stop holds no number in the run", async () => {
  const run = await buildRun(lead.id, freshDay(), 3);
  await db.update(jobsTable).set({ status: "cancelled" }).where(eq(jobsTable.id, run[1].id));
  const res = await post(`/jobs/${run[2].id}/route-position`, admin.id, { position: 1 });
  assert.equal(res.body.runSize, 2, "nobody drives a cancelled stop, so it is not one of the stops");
  assert.deepEqual(await orderOf([run[2].id, run[0].id]), [1, 2]);
});

test("the unassigned pile is its own run", async () => {
  const day = freshDay();
  const unassigned = await buildRun(null, day, 3);
  const assigned = await buildRun(lead.id, day, 2);
  await post(`/jobs/${unassigned[2].id}/route-position`, admin.id, { position: 1 });
  assert.deepEqual(await orderOf(unassigned.map((j) => j.id)), [2, 3, 1]);
  assert.deepEqual(await orderOf(assigned.map((j) => j.id)), [1, 2]);
});

test("a stop number starts at 1, and a job with no day has no place in a route", async () => {
  const job = await createJob({ routeOrder: 1, scheduledDate: freshDay() });
  assert.equal((await post(`/jobs/${job.id}/route-position`, admin.id, { position: 0 })).status, 400);
  assert.equal((await post(`/jobs/${job.id}/route-position`, admin.id, { position: -2 })).status, 400);

  const waiting = await createJob({ dispatched: false, scheduledDate: null, routeOrder: null });
  const res = await post(`/jobs/${waiting.id}/route-position`, admin.id, { position: 1 });
  assert.equal(res.status, 400);

  assert.equal((await post(`/jobs/90000123/route-position`, admin.id, { position: 1 })).status, 404);
});

test("re-ordering the route is an office job", async () => {
  const run = await buildRun(lead.id, freshDay(), 2);
  const res = await post(`/jobs/${run[0].id}/route-position`, lead.id, { position: 2 });
  assert.equal(res.status, 403);
  assert.deepEqual(await orderOf(run.map((j) => j.id)), [1, 2]);
});

test("moving a stop is on the record", async () => {
  const run = await buildRun(lead.id, freshDay(), 2);
  await post(`/jobs/${run[1].id}/route-position`, admin.id, { position: 1 });
  const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, bigLawn.id));
  assert.ok(events.some((e) => e.action === "job_route_position_set" && e.description?.includes(`#${run[1].id}`)));
});

// ------------------------------------------------- custom field filter (D4)

test("the board filters by one of his custom customer fields", async () => {
  const big = await createJob({ clientId: bigLawn.id, scheduledDate: TODAY });
  const small = await createJob({ clientId: smallLawn.id, scheduledDate: TODAY });
  const blank = await createJob({ clientId: noFields.id, scheduledDate: TODAY });

  const hasIt = await api(`/jobs?from=${TODAY}&to=${TODAY}&fieldLabel=Turf%20Sqft`, admin.id);
  const hasItIds = hasIt.body.map((j: { id: number }) => j.id);
  assert.ok(hasItIds.includes(big.id), "matched although the key is saved lowercase");
  assert.ok(hasItIds.includes(small.id));
  assert.ok(!hasItIds.includes(blank.id), "the point of the label on its own: who have I not measured");

  const overTenK = await api(`/jobs?from=${TODAY}&to=${TODAY}&fieldLabel=Turf+Sqft&fieldMin=10000`, admin.id);
  const overIds = overTenK.body.map((j: { id: number }) => j.id);
  assert.ok(overIds.includes(big.id), "12,000 with a comma in it is still twelve thousand");
  assert.ok(!overIds.includes(small.id));

  const upToFive = await api(`/jobs?from=${TODAY}&to=${TODAY}&fieldLabel=Turf+Sqft&fieldMax=5000`, admin.id);
  const upToIds = upToFive.body.map((j: { id: number }) => j.id);
  assert.ok(upToIds.includes(small.id));
  assert.ok(!upToIds.includes(big.id));

  const gate = await api(`/jobs?from=${TODAY}&to=${TODAY}&fieldLabel=gate+code&fieldValue=441`, admin.id);
  const gateIds = gate.body.map((j: { id: number }) => j.id);
  assert.ok(gateIds.includes(big.id), "part of the value, any case on the label");
  assert.ok(!gateIds.includes(small.id));

  const nobody = await api(`/jobs?from=${TODAY}&to=${TODAY}&fieldLabel=Turf+Sqft&fieldValue=zzz`, admin.id);
  assert.equal(nobody.body.length, 0);
});

test("the board shows every contractor's jobs when nobody is picked", async () => {
  const hers = await createJob({ assignedToId: lead.id, scheduledDate: TOMORROW });
  const his = await createJob({ assignedToId: second.id, scheduledDate: TOMORROW });
  const nobodys = await createJob({ assignedToId: null, scheduledDate: TOMORROW });

  const all = await api(`/jobs?from=${TOMORROW}&to=${TOMORROW}`, admin.id);
  const allIds = all.body.map((j: { id: number }) => j.id);
  for (const job of [hers, his, nobodys]) {
    assert.ok(allIds.includes(job.id), "opening the board is everybody's day, not one sub's");
  }

  const justHers = await api(`/jobs?from=${TOMORROW}&to=${TOMORROW}&assignedTo=${lead.id}`, admin.id);
  const justIds = justHers.body.map((j: { id: number }) => j.id);
  assert.ok(justIds.includes(hers.id));
  assert.ok(!justIds.includes(his.id), "and picking one is still there when he wants it");
});

test("the custom field columns are carried on the job the board already loaded", async () => {
  const job = await createJob({ clientId: bigLawn.id, scheduledDate: TODAY });
  const board = await api(`/jobs?from=${TODAY}&to=${TODAY}`, admin.id);
  const row = board.body.find((j: { id: number }) => j.id === job.id);
  assert.equal(row.clientPropertyData["Gate Code"], "4417", "turning a column on must not cost another request");
});

test("the second man handed the whole job is the lead, not the lead and the crew both", async () => {
  const job = await createJob({ assignedToId: lead.id });
  await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [second.id] });

  // The Assigned dropdown on the board: Gabe takes the job over. Four screens
  // can do this, so the board must read right whichever one he used.
  const handed = await api(`/jobs/${job.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ assignedToId: second.id }),
  });
  assert.equal(handed.status, 200);
  assert.equal(handed.body.assignedToName, "Gabe");
  assert.deepEqual(handed.body.crew, [], "the lead is not also one of the extra people on his own job");

  const board = await api(`/jobs?from=${TODAY}&to=${TODAY}`, admin.id);
  const row = board.body.find((j: { id: number }) => j.id === job.id);
  assert.deepEqual(row.crew, []);

  // And it is still his job on his own phone.
  const his = await api(`/my/jobs?date=${TODAY}`, second.id);
  assert.ok(his.body.some((j: { id: number }) => j.id === job.id));

  // Handed back, and the man who was riding along is riding along again.
  await api(`/jobs/${job.id}`, admin.id, { method: "PATCH", body: JSON.stringify({ assignedToId: lead.id }) });
  const back = await api(`/jobs/${job.id}`, admin.id);
  assert.deepEqual(back.body.crew.map((c: { name: string }) => c.name), ["Gabe"]);
});

// ------------------------------------------------- the fixes from the review

test("a sqft typed as a range does not take the whole board down", async () => {
  const day = freshDay();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // How some of the 709 came over from Service Autopilot: a range in the box,
  // a dash where somebody meant n/a, a stray second dot.
  const odd = await db
    .insert(clientsTable)
    .values([
      { name: `Crew Range Lawn ${stamp}`, status: "client", propertyData: { "Turf Sqft": "5000-6000" } },
      { name: `Crew Dash Lawn ${stamp}`, status: "client", propertyData: { "Turf Sqft": "n/a -" } },
      { name: `Crew Comma Range ${stamp}`, status: "client", propertyData: { "Turf Sqft": "4,500 - 5,000" } },
      { name: `Crew Two Dots ${stamp}`, status: "client", propertyData: { "Turf Sqft": "1.2.3" } },
    ])
    .returning();
  ids.clients.push(...odd.map((c) => c.id));
  for (const c of odd) await createJob({ clientId: c.id, scheduledDate: day });
  const big = await createJob({ clientId: bigLawn.id, scheduledDate: day });
  const small = await createJob({ clientId: smallLawn.id, scheduledDate: day });

  const over = await api(`/jobs?from=${day}&to=${day}&fieldLabel=Turf+Sqft&fieldMin=10000`, admin.id);
  assert.equal(over.status, 200, "one unreadable value used to return a 500 and no jobs at all");
  const overIds = over.body.map((j: { id: number }) => j.id);
  assert.ok(overIds.includes(big.id), "the lawns that DO have a number are what he asked for");
  assert.ok(!overIds.includes(small.id));
  assert.equal(
    over.body.filter((j: { clientId: number }) => odd.some((c) => c.id === j.clientId)).length,
    0,
    "'5000-6000' is not fifty million sqft — it is nothing usable, so it is out",
  );

  const under = await api(`/jobs?from=${day}&to=${day}&fieldLabel=Turf+Sqft&fieldMax=10000`, admin.id);
  assert.equal(under.status, 200);
  const underIds = under.body.map((j: { id: number }) => j.id);
  assert.ok(underIds.includes(small.id));
  assert.ok(!underIds.includes(big.id));

  const band = await api(`/jobs?from=${day}&to=${day}&fieldLabel=Turf+Sqft&fieldMin=3000&fieldMax=20000`, admin.id);
  assert.equal(band.status, 200);
  const bandIds = band.body.map((j: { id: number }) => j.id);
  assert.ok(bandIds.includes(big.id) && bandIds.includes(small.id));

  // The label on its own still finds them: the number is unreadable, the fact
  // that somebody wrote something in the box is not.
  const hasIt = await api(`/jobs?from=${day}&to=${day}&fieldLabel=Turf+Sqft`, admin.id);
  assert.equal(hasIt.body.length, 6, "all six have a Turf Sqft on file");
  const text = await api(`/jobs?from=${day}&to=${day}&fieldLabel=Turf+Sqft&fieldValue=5000-6000`, admin.id);
  assert.equal(text.body.length, 1, "and he can still search the box as text");

  // The waiting list shares this filter, so it shared the crash.
  const waiting = await api(`/waiting-list?fieldLabel=Turf+Sqft&fieldMin=10000`, admin.id);
  assert.equal(waiting.status, 200);
});

test("a cancelled stop cannot be dropped into the run", async () => {
  const day = freshDay();
  const run = await buildRun(lead.id, day, 3);
  const calledOff = await createJob({ assignedToId: lead.id, scheduledDate: day, routeOrder: null });
  await db.update(jobsTable).set({ status: "cancelled" }).where(eq(jobsTable.id, calledOff.id));

  const res = await post(`/jobs/${calledOff.id}/route-position`, admin.id, { position: 2 });
  assert.equal(res.status, 400, "nobody drives a cancelled stop, so it has no number to take");
  assert.deepEqual(await orderOf(run.map((j) => j.id)), [1, 2, 3], "and the real stops were not pushed down");
  assert.equal((await readJob(calledOff.id))?.routeOrder, null);

  // A stop cancelled after it was numbered is the same answer.
  await db.update(jobsTable).set({ status: "cancelled" }).where(eq(jobsTable.id, run[1].id));
  assert.equal((await post(`/jobs/${run[1].id}/route-position`, admin.id, { position: 1 })).status, 400);
  assert.deepEqual(await orderOf(run.map((j) => j.id)), [1, 2, 3]);

  // And the live stops still shuffle around each other with it out of the way.
  await post(`/jobs/${run[2].id}/route-position`, admin.id, { position: 1 });
  const numbers = await orderOf([run[2].id, run[0].id]);
  assert.deepEqual(numbers, [1, 2], "two stops, two numbers — never two of the same");
});

test("a number past the end of the run on the last stop answers with the number it already has", async () => {
  const run = await buildRun(lead.id, freshDay(), 5);
  // The box on the board reads the answer, not what he typed, so the answer has
  // to come back even when nothing moved — this is the state that left a 99
  // sitting in a box on stop 5.
  const res = await post(`/jobs/${run[4].id}/route-position`, admin.id, { position: 99 });
  assert.equal(res.status, 200);
  assert.equal(res.body.position, 5, "he meant last, and it already was last");
  assert.equal(res.body.runSize, 5);
  assert.equal(res.body.updated, 0, "nothing to write, so nothing was written");
  assert.deepEqual(await orderOf(run.map((j) => j.id)), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    res.body.stops.map((s: { routeOrder: number }) => s.routeOrder),
    [1, 2, 3, 4, 5],
  );
});

test("a man who leads some stops and rides along on others gets each run in one piece", async () => {
  const day = freshDay();
  // Gabe's own day: stops 4 and 5. Disa's day: stops 1 and 2, with Gabe riding.
  const mine = [
    await createJob({ assignedToId: second.id, scheduledDate: day, routeOrder: 4 }),
    await createJob({ assignedToId: second.id, scheduledDate: day, routeOrder: 5 }),
  ];
  const hers = await buildRun(lead.id, day, 2);
  for (const job of hers) await put(`/jobs/${job.id}/crew`, admin.id, { userIds: [second.id] });

  const his = await api(`/my/jobs?date=${day}`, second.id);
  assert.equal(his.status, 200);
  const order: { assignedToId: number; routeOrder: number }[] = his.body
    .filter((j: { id: number }) => [...mine, ...hers].some((k) => k.id === j.id))
    .map((j: { assignedToId: number; routeOrder: number }) => ({ assignedToId: j.assignedToId, routeOrder: j.routeOrder }));
  assert.equal(order.length, 4);
  const leads = order.map((o) => o.assignedToId);
  const blocks = leads.filter((id, i) => i === 0 || leads[i - 1] !== id);
  assert.equal(
    blocks.length,
    2,
    "one block of her stops and one block of his — a stop 1 of hers is not a stop 1 of his",
  );
  assert.equal(new Set(blocks).size, 2);
  for (let i = 1; i < order.length; i++) {
    if (order[i].assignedToId === order[i - 1].assignedToId) {
      assert.ok(order[i].routeOrder > order[i - 1].routeOrder, "and inside a run, his driving order");
    }
  }

  // His phone's route is the same two blocks, not the two shuffled together.
  const route = await api(`/my/route?date=${day}`, second.id);
  assert.equal(route.status, 200);
  const stopLeads = route.body.stops
    .filter((s: { jobId: number | null }) => s.jobId != null)
    .map((s: { jobId: number }) => [...mine, ...hers].find((k) => k.id === s.jobId)?.assignedToId)
    .filter((id: number | undefined) => id != null);
  assert.equal(stopLeads.length, 4);
  assert.equal(
    stopLeads.filter((id: number, i: number) => i === 0 || stopLeads[i - 1] !== id).length,
    2,
    "renumbering the stops 1..4 must not hide two different runs inside one list",
  );
});

test("the second office person can read the field list the board puts on its columns", async () => {
  // She has the dispatch board and not Settings. The board used to ask Settings
  // for the field names, got a no, and quietly dropped the Custom field filter
  // and every custom column — no message, just gone.
  const [office] = await db
    .insert(usersTable)
    .values({
      clerkId: `test_crew_office_${Date.now()}`,
      name: "office@example.com",
      displayName: "Office",
      role: "admin",
      roleSource: "owner_assigned",
      accessLevel: "office",
    })
    .returning();
  ids.users.push(office.id);

  assert.equal((await api(`/jobs?from=${TODAY}&to=${TODAY}`, office.id)).status, 200, "the board is hers");
  assert.equal(
    (await api(`/customer-fields`, office.id)).status,
    403,
    "the fuller list belongs to a Settings screen, and Settings is not hers",
  );
  const readable = await api(`/estimate-fields`, office.id);
  assert.equal(readable.status, 200, "so the board reads the list she is allowed to read");
  assert.ok(Array.isArray(readable.body));
});
