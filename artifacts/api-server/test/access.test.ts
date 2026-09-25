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
  invitationsTable,
  auditEventsTable,
  paymentsTable,
  ticketsTable,
  suggestedActionsTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";
import { can, normalizePermissions, areasFor, effectiveLevel } from "../src/lib/access.ts";
import { widestLevel, shownName, backfillContractorLevels, mergeAccountFields } from "../src/lib/userAccounts.ts";
import { resolveNewAccountAccess } from "../src/lib/invitations.ts";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;
// Inviting someone sends a real email through Gmail. Nothing in a test may
// ever mail anyone, so the Google credentials are stripped before the app
// loads: the send fails, the invitation row is still written, and the test
// checks exactly that outcome.
delete process.env.GOOGLE_REFRESH_TOKEN;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const STAMP = Date.now();
const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
  invitations: [] as number[],
  // Nothing cascades from a user to these, so they have to go first.
  tickets: [] as number[],
  suggestions: [] as number[],
};

type Row = { id: number; name: string };
let owner: Row;
let adminFull: Row;
let noBooks: Row;
let office: Row;
let officeReports: Row;
let mobile: Row;
let emailName: Row;
let ghost: Row;
let switchedOff: Row;
let client: { id: number };
let mobileJob: { id: number };
const JOB_DATE = "2026-05-05";

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
  // The client export comes back as CSV, not JSON.
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, body: text && isJson ? JSON.parse(text) : text || null };
}

const patch = (path: string, userId: number, data: unknown) =>
  api(path, userId, { method: "PATCH", body: JSON.stringify(data) });

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const base = { roleSource: "owner_assigned" as const, role: "admin" as const };
  const rows = await db
    .insert(usersTable)
    .values([
      { clerkId: `acc_owner_${STAMP}`, name: `Owner ${STAMP}`, role: "admin", roleSource: "owner", accessLevel: "full" },
      { clerkId: `acc_admin_${STAMP}`, name: `Admin ${STAMP}`, ...base, accessLevel: "full" },
      { clerkId: `acc_nobooks_${STAMP}`, name: `NoBooks ${STAMP}`, ...base, accessLevel: "full", permissions: ["!quickbooks"] },
      { clerkId: `acc_office_${STAMP}`, name: `Office ${STAMP}`, ...base, accessLevel: "office" },
      { clerkId: `acc_office_rep_${STAMP}`, name: `OfficeReports ${STAMP}`, ...base, accessLevel: "office", permissions: ["reports"] },
      { clerkId: `acc_mobile_${STAMP}`, name: `Mobile ${STAMP}`, role: "contractor", roleSource: "provisioned", accessLevel: "mobile" },
      // A sign-in that only gave us an email address for a name: what his
      // board used to show for a contractor.
      {
        clerkId: `acc_email_${STAMP}`,
        name: `dale.${STAMP}@example.invalid`,
        email: `dale.${STAMP}@example.invalid`,
        role: "contractor",
        roleSource: "provisioned",
        accessLevel: "mobile",
      },
      { clerkId: `acc_ghost_${STAMP}`, name: `Ghost ${STAMP}`, role: "contractor", roleSource: "provisioned", accessLevel: "mobile" },
      { clerkId: `acc_off_${STAMP}`, name: `Off ${STAMP}`, ...base, accessLevel: "full", active: false },
    ])
    .returning();
  [owner, adminFull, noBooks, office, officeReports, mobile, emailName, ghost, switchedOff] = rows;
  ids.users.push(...rows.map((r) => r.id));

  const [c] = await db
    .insert(clientsTable)
    .values({ name: `Zzaccess Client ${STAMP}`, status: "client", serviceAddress: `${STAMP} Access Way` })
    .returning();
  client = c;
  ids.clients.push(c.id);
  const [svc] = await db.insert(servicesTable).values({ name: `Access Mow ${STAMP}`, rate: 40 }).returning();
  ids.services.push(svc.id);
  await db.insert(jobsTable).values({
    clientId: c.id,
    serviceId: svc.id,
    assignedToId: emailName.id,
    scheduledDate: JOB_DATE,
    dispatched: true,
    amount: 40,
  });
  // A dispatched job on the mobile person's phone, for the clock-in check.
  const [mj] = await db
    .insert(jobsTable)
    .values({
      clientId: c.id,
      serviceId: svc.id,
      assignedToId: mobile.id,
      scheduledDate: "2026-05-06",
      dispatched: true,
      visibleToContractor: true,
      amount: 40,
    })
    .returning();
  mobileJob = mj;
});

after(async () => {
  if (ids.tickets.length) await db.delete(ticketsTable).where(inArray(ticketsTable.id, ids.tickets));
  if (ids.suggestions.length)
    await db.delete(suggestedActionsTable).where(inArray(suggestedActionsTable.id, ids.suggestions));
  if (ids.invitations.length) await db.delete(invitationsTable).where(inArray(invitationsTable.id, ids.invitations));
  await db.delete(auditEventsTable).where(like(auditEventsTable.description, `%${STAMP}%`));
  // clients cascade jobs
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

// ---------------------------------------------------------------- the rules --

test("permissions are kept honest: known areas only, once each, a denial beats a grant", () => {
  assert.deepEqual(normalizePermissions(["quickbooks", "QuickBooks ", "!quickbooks", "bogus", "reports"]), [
    "reports",
    "!quickbooks",
  ]);
  assert.deepEqual(normalizePermissions(null), []);
});

test("the owner can never be locked out, whatever is typed into permissions", () => {
  const adam = { role: "admin", roleSource: "owner", accessLevel: "office", permissions: ["!quickbooks", "!team"] };
  assert.equal(can(adam, "quickbooks"), true);
  assert.equal(can(adam, "team"), true);
});

test("full minus a denial, office plus a grant, mobile nothing, switched off nothing", () => {
  const full = { role: "admin", roleSource: "owner_assigned", accessLevel: "full", permissions: ["!quickbooks"] };
  assert.equal(can(full, "quickbooks"), false);
  assert.equal(can(full, "reports"), true);
  const off = { role: "admin", roleSource: "owner_assigned", accessLevel: "office", permissions: ["reports"] };
  assert.deepEqual(areasFor(off), ["dispatch", "clients", "invoices", "reports", "documents"]);
  assert.equal(can(off, "quickbooks"), false);
  assert.equal(can(off, "team"), false);
  const mob = { role: "contractor", roleSource: "provisioned", accessLevel: "mobile", permissions: ["quickbooks"] };
  assert.deepEqual(areasFor(mob), []);
  assert.equal(can({ ...full, active: false }, "dispatch"), false);
});

test("folding duplicate rows keeps the wider level and both sets of extras", () => {
  assert.deepEqual(
    widestLevel([
      { accessLevel: "office", permissions: ["reports"] },
      { accessLevel: "full", permissions: ["!quickbooks"] },
    ]),
    { accessLevel: "full", permissions: ["reports", "!quickbooks"] },
  );
});

test("the name shown is the short name, else the sign-in name, never a whole email address", () => {
  assert.equal(shownName({ name: "dale.h@example.com", displayName: null }), "dale.h");
  assert.equal(shownName({ name: "dale.h@example.com", displayName: " Dale " }), "Dale");
  assert.equal(shownName({ name: "Dale Hanson", displayName: "" }), "Dale Hanson");
});

// -------------------------------------------------------- what /me says --

test("/me carries the areas each person can open", async () => {
  const nb = await api("/me", noBooks.id);
  assert.equal(nb.status, 200);
  assert.ok(!nb.body.areas.includes("quickbooks"), "no QuickBooks for the second full user");
  assert.ok(nb.body.areas.includes("team"));
  assert.deepEqual(nb.body.permissions, ["!quickbooks"]);

  const of = await api("/me", office.id);
  assert.deepEqual(of.body.areas, ["dispatch", "clients", "invoices", "documents"]);

  const rep = await api("/me", officeReports.id);
  assert.ok(rep.body.areas.includes("reports"));

  const mob = await api("/me", mobile.id);
  assert.deepEqual(mob.body.areas, []);
  assert.equal(mob.body.accessLevel, "mobile");
});

// ------------------------------------------------- the guards on the API --

test("a full user with no QuickBooks is refused the books and nothing else", async () => {
  const books = await api("/quickbooks/status", noBooks.id);
  assert.equal(books.status, 403);
  assert.match(books.body.error, /QuickBooks is not turned on/);
  assert.equal((await api("/reports/catalogue", noBooks.id)).status, 200);
  assert.equal((await api("/company-profile", noBooks.id)).status, 200);
  const users = await api("/users", noBooks.id);
  assert.equal(users.status, 200);
  assert.ok(users.body.some((u: any) => u.id === owner.id && u.roleSource === "owner"), "team list is the full one");
});

test("an office user gets the day-to-day screens and is refused the owner's side", async () => {
  assert.equal((await api("/invoices", office.id)).status, 200);
  assert.equal((await api("/document-templates", office.id)).status, 200);
  assert.equal((await api("/dashboard/summary", office.id)).status, 200);
  const reports = await api("/reports/catalogue", office.id);
  assert.equal(reports.status, 403);
  assert.match(reports.body.error, /Reports is not turned on/);
  assert.equal((await api("/company-profile", office.id)).status, 403);
  assert.equal((await api("/quickbooks/status", office.id)).status, 403);
  assert.equal((await patch(`/users/${mobile.id}`, office.id, { displayName: "X" })).status, 403);
  assert.equal((await api("/invitations", office.id)).status, 403);
  // Still gets names for the dispatch dropdowns, without anyone's contact details.
  const users = await api("/users", office.id);
  assert.equal(users.status, 200);
  const row = users.body.find((u: any) => u.id === emailName.id);
  assert.ok(row);
  assert.equal(row.email, null);
  assert.deepEqual(row.areas, []);
});

test("granting Reports to an office user opens exactly that", async () => {
  assert.equal((await api("/reports/catalogue", officeReports.id)).status, 200);
  assert.equal((await api("/quickbooks/status", officeReports.id)).status, 403);
});

test("a mobile-only person has the phone app and nothing from the office", async () => {
  assert.equal((await api(`/my/jobs?date=${JOB_DATE}`, mobile.id)).status, 200);
  assert.equal((await api("/invoices", mobile.id)).status, 403);
  assert.equal((await api("/reports/catalogue", mobile.id)).status, 403);
  assert.equal((await api("/dashboard/summary", mobile.id)).status, 403);
  assert.equal((await patch(`/users/${mobile.id}`, mobile.id, { accessLevel: "full" })).status, 403);
});

test("the office routers open for an office user and stay shut for a mobile one", async () => {
  // Crew on the map, the search box, the bulk export: day-to-day work.
  assert.equal((await api("/team/locations", office.id)).status, 200);
  assert.equal((await api(`/search?q=${STAMP}`, office.id)).status, 200);
  assert.equal((await api("/clients/export", office.id)).status, 200);
  assert.equal((await api(`/clients/${client.id}/contacts`, office.id)).status, 200);
  assert.equal((await api(`/clients/${client.id}/client-services`, office.id)).status, 200);
  assert.equal((await api(`/clients/${client.id}/jobs`, office.id)).status, 200);
  const locs = await api("/team/locations", mobile.id);
  assert.equal(locs.status, 403);
  assert.match(locs.body.error, /Dispatch is not turned on/);
  const search = await api(`/search?q=${STAMP}`, mobile.id);
  assert.equal(search.status, 403);
  assert.match(search.body.error, /Clients is not turned on/);
  assert.equal((await api("/clients/export", mobile.id)).status, 403);
  assert.equal((await api(`/clients/${client.id}/contacts`, mobile.id)).status, 403);
  assert.equal((await api("/jobs/bulk-action", mobile.id, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await api("/jobs/bulk-assign", mobile.id, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await api("/waiting-list/build-route", mobile.id, { method: "POST", body: "{}" })).status, 403);
});

test("the colour a contractor's stops take is his to pick, and a bad one is refused", async () => {
  // "It will show up in a different color that I've designated for that
  // contractor. So I can see whose jobs are whose."
  const set = await patch(`/users/${mobile.id}`, owner.id, { color: "#16a34a" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.color, "#16a34a");

  const listed = await api("/users?includeInactive=true", owner.id);
  assert.equal(listed.body.find((u: any) => u.id === mobile.id)?.color, "#16a34a");

  // Back to the automatic colour.
  const cleared = await patch(`/users/${mobile.id}`, owner.id, { color: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.color, null);

  // Anything that is not a hex colour would render as nothing at all.
  assert.equal((await patch(`/users/${mobile.id}`, owner.id, { color: "greenish" })).status, 400);
});

test("a contractor can clock in and open job photos: no office guard leaks onto the phone app", async () => {
  // automation.ts used to guard every request that fell through it, which
  // turned a clock-in into "Admin access required". Its guard is scoped now;
  // this is the check that it stays that way whatever the mount order.
  const photos = await api(`/jobs/${mobileJob.id}/photos`, mobile.id);
  assert.equal(photos.status, 200, JSON.stringify(photos.body));
  assert.deepEqual(photos.body, []);
  const clockIn = await api(`/jobs/${mobileJob.id}/clock-in`, mobile.id, { method: "POST", body: "{}" });
  assert.equal(clockIn.status, 201, JSON.stringify(clockIn.body));
  assert.equal(clockIn.body.jobId, mobileJob.id);
  const again = await api(`/jobs/${mobileJob.id}/clock-in`, mobile.id, { method: "POST", body: "{}" });
  assert.equal(again.status, 409, "the second tap is refused, not 403");
  // Another crew's job is still not theirs.
  const jobs = await api(`/jobs?date=${JOB_DATE}&clientId=${client.id}`, adminFull.id);
  const other = await api(`/jobs/${jobs.body[0].id}/photos`, mobile.id);
  assert.equal(other.status, 403);
});

test("a customer with money on the books cannot be deleted; one with none can, and it is logged", async () => {
  const [paid] = await db
    .insert(clientsTable)
    .values({ name: `Zzaccess Paid ${STAMP}`, status: "client", serviceAddress: `${STAMP} Paid Way` })
    .returning();
  ids.clients.push(paid.id);
  await db.insert(paymentsTable).values({ clientId: paid.id, amount: 10, method: "cash" });
  const refused = await api(`/clients/${paid.id}`, adminFull.id, { method: "DELETE" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Set status to Former/);
  assert.equal((await api(`/clients/${paid.id}`, adminFull.id)).status, 200, "still there");

  const [empty] = await db
    .insert(clientsTable)
    .values({ name: `Zzaccess Empty ${STAMP}`, status: "lead", serviceAddress: `${STAMP} Empty Way` })
    .returning();
  assert.equal((await api(`/clients/${empty.id}`, mobile.id, { method: "DELETE" })).status, 403);
  const gone = await api(`/clients/${empty.id}`, adminFull.id, { method: "DELETE" });
  assert.equal(gone.status, 204);
  assert.equal((await api(`/clients/${empty.id}`, adminFull.id)).status, 404);
  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.action, "client_deleted"), like(auditEventsTable.description, `%Zzaccess Empty ${STAMP}%`)));
  assert.ok(audit, "the delete is on the audit trail");
});

test("someone turned off cannot use the app and drops out of the list unless asked for", async () => {
  const me = await api("/me", switchedOff.id);
  assert.equal(me.status, 403);
  assert.match(me.body.error, /turned off/);
  const active = await api("/users", adminFull.id);
  assert.ok(!active.body.some((u: any) => u.id === switchedOff.id));
  const all = await api("/users?includeInactive=true", adminFull.id);
  const row = all.body.find((u: any) => u.id === switchedOff.id);
  assert.ok(row);
  assert.equal(row.active, false);
});

// ----------------------------------------------------- editing a person --

test("changing a level sets the matching role, normalizes the extras and writes the audit line", async () => {
  const up = await patch(`/users/${office.id}`, adminFull.id, {
    accessLevel: "full",
    permissions: ["quickbooks", "!quickbooks", "nonsense"],
  });
  assert.equal(up.status, 200);
  assert.equal(up.body.accessLevel, "full");
  assert.equal(up.body.role, "admin");
  assert.equal(up.body.roleSource, "owner_assigned");
  assert.deepEqual(up.body.permissions, ["!quickbooks"]);
  assert.ok(!up.body.areas.includes("quickbooks"));
  assert.equal((await api("/quickbooks/status", office.id)).status, 403);
  assert.equal((await api("/reports/catalogue", office.id)).status, 200);

  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.action, "team.access_changed"), like(auditEventsTable.description, `Office ${STAMP}%`)));
  assert.ok(audit, "an access change is on the audit trail");
  assert.match(audit.description, /now full user/);
  assert.match(audit.description, /no QuickBooks/);

  // Down to the phone app: role follows, and the level comes back cleanly.
  const down = await patch(`/users/${office.id}`, adminFull.id, { accessLevel: "mobile" });
  assert.equal(down.body.role, "contractor");
  assert.equal(down.body.roleSource, "provisioned");
  assert.deepEqual(down.body.areas, []);
  assert.equal((await api("/invoices", office.id)).status, 403);

  const back = await patch(`/users/${office.id}`, adminFull.id, { accessLevel: "office", permissions: [] });
  assert.equal(back.body.role, "admin");
  assert.deepEqual(back.body.areas, ["dispatch", "clients", "invoices", "documents"]);
});

test("a plain role change from an older caller still lands on the right level", async () => {
  const r = await patch(`/users/${ghost.id}`, adminFull.id, { role: "admin" });
  assert.equal(r.status, 200);
  assert.equal(r.body.accessLevel, "full");
  const back = await patch(`/users/${ghost.id}`, adminFull.id, { role: "contractor" });
  assert.equal(back.body.accessLevel, "mobile");
});

test("nobody can fence, demote or switch off themselves", async () => {
  assert.equal((await patch(`/users/${adminFull.id}`, adminFull.id, { accessLevel: "mobile" })).status, 400);
  const fence = await patch(`/users/${adminFull.id}`, adminFull.id, { permissions: ["!team"] });
  assert.equal(fence.status, 400);
  assert.match(fence.body.error, /Team page/);
  assert.equal((await patch(`/users/${adminFull.id}`, adminFull.id, { active: false })).status, 400);
  // Fencing yourself out of something other than the Team page is allowed.
  const ok = await patch(`/users/${adminFull.id}`, adminFull.id, { permissions: ["!quickbooks"] });
  assert.equal(ok.status, 200);
  await patch(`/users/${adminFull.id}`, adminFull.id, { permissions: [] });
});

test("the configured owner always keeps everything", async () => {
  assert.equal((await patch(`/users/${owner.id}`, adminFull.id, { accessLevel: "office" })).status, 400);
  assert.equal((await patch(`/users/${owner.id}`, adminFull.id, { permissions: ["!quickbooks"] })).status, 400);
  assert.equal((await patch(`/users/${owner.id}`, adminFull.id, { active: false })).status, 400);
  assert.equal((await patch(`/users/${owner.id}`, adminFull.id, { role: "contractor" })).status, 400);
  // Details are fine.
  const ok = await patch(`/users/${owner.id}`, adminFull.id, { birthday: "1980-04-01" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.birthday, "1980-04-01");
});

test("a short name replaces the email address on the board; birthday and hire date are kept", async () => {
  const before = await api("/users", adminFull.id);
  const asIs = before.body.find((u: any) => u.id === emailName.id);
  assert.equal(asIs.name, `dale.${STAMP}`, "never a whole email address, even before a name is typed");

  const up = await patch(`/users/${emailName.id}`, adminFull.id, {
    displayName: "Dale",
    birthday: "1990-07-04",
    hireDate: "2024-03-15",
    phone: "208-555-0100",
  });
  assert.equal(up.status, 200);
  assert.equal(up.body.name, "Dale");
  assert.equal(up.body.fullName, `dale.${STAMP}@example.invalid`);
  assert.equal(up.body.birthday, "1990-07-04");
  assert.equal(up.body.hireDate, "2024-03-15");

  const jobs = await api(`/jobs?date=${JOB_DATE}&clientId=${client.id}`, adminFull.id);
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.length, 1);
  assert.equal(jobs.body[0].assignedToName, "Dale");

  const list = await api("/users", adminFull.id);
  const row = list.body.find((u: any) => u.id === emailName.id);
  assert.equal(row.name, "Dale");
  assert.equal(row.jobCount, 1);
});

test("turning someone off keeps their history; delete only when there is none", async () => {
  const withJobs = await api(`/users/${emailName.id}`, adminFull.id, { method: "DELETE" });
  assert.equal(withJobs.status, 400);
  assert.match(withJobs.body.error, /1 job on record/);

  const off = await patch(`/users/${emailName.id}`, adminFull.id, { active: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.active, false);
  const jobs = await api(`/jobs?date=${JOB_DATE}&clientId=${client.id}`, adminFull.id);
  assert.equal(jobs.body[0].assignedToName, "Dale", "the job still says who did it");
  assert.equal((await api("/me", emailName.id)).status, 403);
  await patch(`/users/${emailName.id}`, adminFull.id, { active: true });

  assert.equal((await api(`/users/${adminFull.id}`, adminFull.id, { method: "DELETE" })).status, 400);
  assert.equal((await api(`/users/${owner.id}`, adminFull.id, { method: "DELETE" })).status, 400);
  assert.equal((await api(`/users/${ghost.id}`, mobile.id, { method: "DELETE" })).status, 403);

  const gone = await api(`/users/${ghost.id}`, adminFull.id, { method: "DELETE" });
  assert.equal(gone.status, 204);
  const list = await api("/users?includeInactive=true", adminFull.id);
  assert.ok(!list.body.some((u: any) => u.id === ghost.id));
  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.action, "team.deleted"), like(auditEventsTable.description, `Ghost ${STAMP}%`)));
  assert.ok(audit);
});

// ------------------------------------------------------------ invitations --

test("an invitation carries the level and extras, and they apply on first sign-in", async () => {
  const email = `invite.${STAMP}@example.invalid`;
  const created = await api("/invitations", adminFull.id, {
    method: "POST",
    body: JSON.stringify({ email, accessLevel: "office", permissions: ["reports", "bogus"] }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ids.invitations.push(created.body.id);
  assert.equal(created.body.role, "admin");
  assert.equal(created.body.accessLevel, "office");
  assert.deepEqual(created.body.permissions, ["reports"]);
  // No Google credentials in this process, so nothing was mailed and the row says so.
  assert.equal(created.body.emailedAt, null);
  assert.ok(created.body.emailError);

  const listed = await api("/invitations", adminFull.id);
  assert.ok(listed.body.some((i: any) => i.id === created.body.id));

  const access = await db.transaction((tx) =>
    resolveNewAccountAccess(tx, email, { role: "contractor", roleSource: "provisioned" }),
  );
  assert.deepEqual(access, { role: "admin", roleSource: "owner_assigned", accessLevel: "office", permissions: ["reports"] });

  const nobody = await db.transaction((tx) =>
    resolveNewAccountAccess(tx, `nobody.${STAMP}@example.invalid`, { role: "contractor", roleSource: "provisioned" }),
  );
  assert.deepEqual(nobody, { role: "contractor", roleSource: "provisioned", accessLevel: "mobile", permissions: [] });

  // Someone who already has an account is edited on the Team page instead.
  const dup = await api("/invitations", adminFull.id, {
    method: "POST",
    body: JSON.stringify({ email: `dale.${STAMP}@example.invalid`, accessLevel: "mobile" }),
  });
  assert.equal(dup.status, 400);

  const revoked = await api(`/invitations/${created.body.id}`, adminFull.id, { method: "DELETE" });
  assert.equal(revoked.status, 204);
  ids.invitations.length = 0;
});

// ------------------------------------- rows from before the level column --

test("a contractor stamped with the old 'full' level is still mobile only, and reads that way on the Team page", async () => {
  // Every row already in the database when the level column was added was
  // stamped with the widest level there is, so all of his subcontractors look
  // like this. The role was always the truth; the level column was not.
  const [legacy] = await db
    .insert(usersTable)
    .values({
      clerkId: `acc_legacy_${STAMP}`,
      name: `Legacy ${STAMP}`,
      role: "contractor",
      roleSource: "provisioned",
      accessLevel: "full",
    })
    .returning();
  ids.users.push(legacy.id);

  assert.equal(effectiveLevel(legacy), "mobile");
  assert.equal(can(legacy, "quickbooks"), false);
  assert.deepEqual(areasFor(legacy), []);

  // The Team page seeds its Save from what it is shown, so this has to say
  // mobile: showing "full" is what turned a Save into an admin promotion.
  const list = await api("/users", adminFull.id);
  const row = list.body.find((u: any) => u.id === legacy.id);
  assert.equal(row.accessLevel, "mobile");
  assert.deepEqual(row.areas, []);
  const me = await api("/me", legacy.id);
  assert.equal(me.body.accessLevel, "mobile");
  assert.deepEqual(me.body.areas, []);
  assert.equal((await api("/invitations", legacy.id)).status, 403);

  // Folding duplicate rows must not write the old level back out either.
  assert.equal(
    mergeAccountFields(legacy as any, [{ ...legacy, accessLevel: "full", permissions: [] } as any]).accessLevel,
    "mobile",
  );

  // The boot cleanup puts the stored column back in step with the role.
  await backfillContractorLevels();
  const [realigned] = await db.select().from(usersTable).where(eq(usersTable.id, legacy.id));
  assert.equal(realigned.accessLevel, "mobile");

  // Typing a short name and pressing Save (the whole payload the page sends)
  // leaves them where they were instead of handing them the office.
  const saved = await patch(`/users/${legacy.id}`, adminFull.id, {
    displayName: `Dale ${STAMP}`,
    accessLevel: "mobile",
    permissions: [],
    active: true,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.role, "contractor");
  assert.equal(saved.body.accessLevel, "mobile");
  assert.deepEqual(saved.body.areas, []);
  assert.equal((await api("/invitations", legacy.id)).status, 403);
  // Nothing about their access moved, so nothing is claimed on the audit trail.
  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.action, "team.access_changed"), like(auditEventsTable.description, `Dale ${STAMP}%`)));
  assert.equal(audits.length, 0);
});

test("a note, a ticket or a reviewed suggestion keeps a person too: turned off, not a crash", async () => {
  const [helper] = await db
    .insert(usersTable)
    .values({
      clerkId: `acc_helper_${STAMP}`,
      name: `Helper ${STAMP}`,
      role: "contractor",
      roleSource: "provisioned",
      accessLevel: "mobile",
    })
    .returning();
  ids.users.push(helper.id);
  const [ticket] = await db
    .insert(ticketsTable)
    .values({ clientId: client.id, title: `Gate code ${STAMP}`, assignedToId: helper.id })
    .returning();
  ids.tickets.push(ticket.id);

  // The page only offers Delete when there is nothing at all on record.
  const list = await api("/users", adminFull.id);
  const row = list.body.find((u: any) => u.id === helper.id);
  assert.equal(row.jobCount, 0);
  assert.equal(row.historyCount, 1);

  const refused = await api(`/users/${helper.id}`, adminFull.id, { method: "DELETE" });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /notes or tickets on record/);
  assert.equal((await api("/me", helper.id)).status, 200, "still there, not half-deleted");

  // A reviewed suggestion holds them the same way.
  const [suggestion] = await db
    .insert(suggestedActionsTable)
    .values({
      source: "field_note",
      clientId: client.id,
      actionType: "skip",
      reason: `Zzaccess suggestion ${STAMP}`,
      reviewedById: helper.id,
    })
    .returning();
  ids.suggestions.push(suggestion.id);
  await db.delete(ticketsTable).where(eq(ticketsTable.id, ticket.id));
  ids.tickets.length = 0;
  const stillRefused = await api(`/users/${helper.id}`, adminFull.id, { method: "DELETE" });
  assert.equal(stillRefused.status, 400);
  assert.match(stillRefused.body.error, /notes or tickets on record/);

  // With nothing left pointing at them, they can go.
  await db.delete(suggestedActionsTable).where(eq(suggestedActionsTable.id, suggestion.id));
  ids.suggestions.length = 0;
  const gone = await api(`/users/${helper.id}`, adminFull.id, { method: "DELETE" });
  assert.equal(gone.status, 204, JSON.stringify(gone.body));
});

test("an invitation sent before levels existed still opens the office for the admin it named", async () => {
  // How the route wrote a row before the level column: a role and nothing
  // else, so the row carries whatever default the column was added with.
  const adminEmail = `legacy.admin.${STAMP}@example.invalid`;
  const crewEmail = `legacy.crew.${STAMP}@example.invalid`;
  const [oldAdmin, oldCrew] = await db
    .insert(invitationsTable)
    .values([
      { email: adminEmail, role: "admin", invitedByName: `Adam ${STAMP}` },
      { email: crewEmail, role: "contractor", invitedByName: `Adam ${STAMP}` },
    ])
    .returning();
  assert.equal(oldAdmin.accessLevel, "mobile", "what such a row actually holds");

  const asAdmin = await db.transaction((tx) =>
    resolveNewAccountAccess(tx, adminEmail, { role: "contractor", roleSource: "provisioned" }),
  );
  assert.deepEqual(asAdmin, {
    role: "admin",
    roleSource: "owner_assigned",
    accessLevel: "full",
    permissions: [],
  });
  // An admin with an empty office was the bug: every screen a "not turned on" card.
  assert.ok(areasFor(asAdmin).includes("team"));
  assert.ok(areasFor(asAdmin).includes("quickbooks"));

  const asCrew = await db.transaction((tx) =>
    resolveNewAccountAccess(tx, crewEmail, { role: "contractor", roleSource: "provisioned" }),
  );
  assert.deepEqual(asCrew, {
    role: "contractor",
    roleSource: "provisioned",
    accessLevel: "mobile",
    permissions: [],
  });

  await db.delete(invitationsTable).where(inArray(invitationsTable.id, [oldAdmin.id, oldCrew.id]));
});
