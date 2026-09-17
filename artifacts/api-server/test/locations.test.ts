import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  jobsTable,
  servicesTable,
  userLocationsTable,
  jobTimeEntriesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// "Where is my guy?" — the phone reports, the office reads. Same harness as
// integration.test.ts: NODE_ENV=test plus a per-process token opens the
// x-test-user-id bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { todayLocal } = await import("../src/lib/jobGeneration.ts");

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[], services: [] as number[] };

let admin: { id: number };
let dale: { id: number };
let bob: { id: number };
let house: { id: number };
let service: { id: number };
let daleJob: { id: number };
let bobJob: { id: number };

const TODAY = new Date().toISOString().slice(0, 10);

// The house is at 32.78 / -96.8. A driveway away is well inside 150 m; across
// town is about 13 km north.
const AT_HOUSE = { lat: 32.7803, lng: -96.8002 };
const ACROSS_TOWN = { lat: 32.9, lng: -96.8 };

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

const report = (userId: number, data: unknown) =>
  api("/my/location", userId, { method: "POST", body: JSON.stringify(data) });

async function crew() {
  const r = await api(`/team/locations?date=${TODAY}`, admin.id);
  assert.equal(r.status, 200);
  return r.body as any[];
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const [a, d, b] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_loc_admin_${stamp}`, name: "Loc Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `test_loc_dale_${stamp}`, name: `dale_${stamp}@example.com`, displayName: "Dale", role: "contractor" },
      { clerkId: `test_loc_bob_${stamp}`, name: `Bob ${stamp}`, role: "contractor" },
    ])
    .returning();
  admin = a;
  dale = d;
  bob = b;
  ids.users.push(a.id, d.id, b.id);

  const [h] = await db
    .insert(clientsTable)
    .values({ name: `Loc House ${stamp}`, status: "client", serviceAddress: "615 E 18th Ave", lat: 32.78, lng: -96.8 })
    .returning();
  house = h;
  ids.clients.push(h.id);

  const [svc] = await db.insert(servicesTable).values({ name: `Loc Mow ${stamp}` }).returning();
  service = svc;
  ids.services.push(svc.id);

  const [j1, j2] = await db
    .insert(jobsTable)
    .values([
      {
        clientId: house.id,
        serviceId: service.id,
        amount: 50,
        scheduledDate: TODAY,
        status: "on_the_way",
        assignedToId: dale.id,
        dispatched: true,
        visibleToContractor: true,
      },
      {
        clientId: house.id,
        serviceId: service.id,
        amount: 50,
        scheduledDate: TODAY,
        status: "scheduled",
        assignedToId: bob.id,
        dispatched: true,
        visibleToContractor: true,
      },
    ])
    .returning();
  daleJob = j1;
  bobJob = j2;
});

after(async () => {
  // user_locations and job_time_entries cascade from users / jobs; jobs from clients
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

test("a phone must be signed in to report", async () => {
  const r = await report(null as unknown as number, { ...AT_HOUSE });
  assert.equal(r.status, 401);
});

test("a report needs a real coordinate", async () => {
  const r = await report(dale.id, { lat: 200, lng: -96.8 });
  assert.equal(r.status, 400);
});

test("contractors cannot read where the crew is; only the office can", async () => {
  const r = await api(`/team/locations?date=${TODAY}`, dale.id);
  assert.equal(r.status, 403);
});

test("nobody has reported yet: the office sees the person with no position rather than nothing", async () => {
  const rows = await crew();
  const row = rows.find((r) => r.userId === dale.id);
  assert.ok(row, "Dale is listed even before his phone says anything");
  assert.equal(row.status, "unknown");
  assert.equal(row.lat, null);
  assert.equal(row.source, "none");
  assert.equal(row.userName, "Dale", "the board name, never the email");
});

test("at the house: a report within 150 m of an on-the-way job reads as at_job and names the house", async () => {
  const r = await report(dale.id, { ...AT_HOUSE, accuracyM: 12, jobId: daleJob.id });
  assert.equal(r.status, 204);

  const row = (await crew()).find((x) => x.userId === dale.id);
  assert.equal(row.status, "at_job");
  assert.equal(row.source, "live");
  assert.equal(row.jobId, daleJob.id);
  assert.equal(row.jobAddress, "615 E 18th Ave");
  assert.ok(row.ageSeconds != null && row.ageSeconds < 60, `fresh, got ${row.ageSeconds}`);
  assert.equal(row.accuracyM, 12);
});

test("across town with a job going reads as en_route to that job", async () => {
  const r = await report(dale.id, { ...ACROSS_TOWN, jobId: daleJob.id });
  assert.equal(r.status, 204);
  const row = (await crew()).find((x) => x.userId === dale.id);
  assert.equal(row.status, "en_route");
  assert.equal(row.jobId, daleJob.id);
  assert.equal(row.jobStatus, "on_the_way");
});

test("a report older than ten minutes is called stale, not current", async () => {
  const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString();
  const r = await report(dale.id, { ...AT_HOUSE, recordedAt: twentyMinAgo });
  assert.equal(r.status, 204);
  const row = (await crew()).find((x) => x.userId === dale.id);
  // The latest row by recordedAt is the across-town one from the previous
  // test, which is still fresh — so the office still sees en_route. Push the
  // clock forward by inserting an even newer stale fix directly.
  assert.ok(["en_route", "stale"].includes(row.status));
  await db.delete(userLocationsTable).where(eq(userLocationsTable.userId, dale.id));
  await db.insert(userLocationsTable).values({
    userId: dale.id,
    lat: AT_HOUSE.lat,
    lng: AT_HOUSE.lng,
    recordedAt: new Date(Date.now() - 20 * 60_000),
  });
  const again = (await crew()).find((x) => x.userId === dale.id);
  assert.equal(again.status, "stale");
  assert.ok(again.ageSeconds >= 19 * 60, `age ${again.ageSeconds}`);
});

test("a phone clock in the future or from an hour ago is clamped to now", async () => {
  await db.delete(userLocationsTable).where(eq(userLocationsTable.userId, dale.id));
  const r = await report(dale.id, { ...AT_HOUSE, recordedAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(r.status, 204);
  const row = (await crew()).find((x) => x.userId === dale.id);
  assert.equal(row.status, "at_job");
  assert.ok(row.ageSeconds < 60);
});

test("a job id that is not the sender's own is dropped, the fix itself is kept", async () => {
  const r = await report(bob.id, { ...AT_HOUSE, jobId: daleJob.id });
  assert.equal(r.status, 204);
  const [row] = await db.select().from(userLocationsTable).where(eq(userLocationsTable.userId, bob.id));
  assert.ok(row);
  assert.equal(row.jobId, null);
});

test("at the house with no job going (only scheduled) reads as idle — 'at' means at one of today's active stops", async () => {
  const row = (await crew()).find((x) => x.userId === bob.id);
  assert.equal(row.status, "idle");
  assert.equal(row.jobId, null);
});

test("the last clock-in fix stands in when the phone has never reported live", async () => {
  await db.delete(userLocationsTable).where(eq(userLocationsTable.userId, bob.id));
  await db.insert(jobTimeEntriesTable).values({
    jobId: bobJob.id,
    userId: bob.id,
    clockInLat: ACROSS_TOWN.lat,
    clockInLng: ACROSS_TOWN.lng,
  });
  const row = (await crew()).find((x) => x.userId === bob.id);
  assert.equal(row.source, "clock");
  assert.equal(row.lat, ACROSS_TOWN.lat);
  assert.equal(row.status, "idle");
});

test("people with a position come first, freshest first", async () => {
  const rows = await crew();
  const ages = rows.map((x) => x.ageSeconds as number | null);
  for (let i = 1; i < ages.length; i++) {
    const prev = ages[i - 1] ?? Infinity;
    const cur = ages[i] ?? Infinity;
    assert.ok(prev <= cur, `row ${i - 1} (${prev}) should be no older than row ${i} (${cur})`);
  }
  const mine = rows.filter((x) => [dale.id, bob.id].includes(x.userId));
  assert.ok(mine.every((x) => x.ageSeconds != null), "both have a position now");
});

test("with no date on the request the board is our day, not Greenwich's", async () => {
  // Evening here is already tomorrow in UTC, and the old default asked for
  // tomorrow's jobs — so a man standing in a driveway read as "idle".
  const [localJob] = await db
    .insert(jobsTable)
    .values({
      clientId: house.id,
      serviceId: service.id,
      amount: 50,
      scheduledDate: todayLocal(),
      status: "in_progress",
      assignedToId: bob.id,
      dispatched: true,
      visibleToContractor: true,
    })
    .returning();
  const r = await report(bob.id, { ...AT_HOUSE, jobId: localJob.id });
  assert.equal(r.status, 204);

  const noDate = await api("/team/locations", admin.id);
  assert.equal(noDate.status, 200);
  const row = (noDate.body as any[]).find((x) => x.userId === bob.id);
  assert.equal(row.status, "at_job", "at the house of a job that is going today");
  assert.equal(row.jobId, localJob.id);

  const spelledOut = await api(`/team/locations?date=${todayLocal()}`, admin.id);
  const same = (spelledOut.body as any[]).find((x) => x.userId === bob.id);
  assert.equal(same.status, row.status, "no date means today, spelled out or not");
  assert.equal(same.jobId, row.jobId);
});

test("history is pruned to a week on each report", async () => {
  await db.insert(userLocationsTable).values({
    userId: dale.id,
    lat: AT_HOUSE.lat,
    lng: AT_HOUSE.lng,
    recordedAt: new Date(Date.now() - 8 * 86_400_000),
  });
  await report(dale.id, { ...AT_HOUSE });
  const rows = await db.select().from(userLocationsTable).where(eq(userLocationsTable.userId, dale.id));
  assert.ok(rows.every((r) => Date.now() - r.recordedAt.getTime() < 7 * 86_400_000), "the week-old row is gone");
});
