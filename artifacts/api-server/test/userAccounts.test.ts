import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  userIdentitiesTable,
  clientsTable,
  jobsTable,
  ticketsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { resolveAccountForClerkId, reconcileUserAccounts, dedupeUsersByPerson, strongestAccess } =
  await import("../src/lib/userAccounts.ts");
const { resolveIdentityAccess } = await import("../src/middlewares/requireAuth.ts");

let server: Server;
let baseUrl: string;

const stamp = Date.now();
const ids = { users: [] as number[], clients: [] as number[] };

// The person who signs in two different ways.
const SHARED_EMAIL = `dual-signin-${stamp}@example.com`;
const CLERK_PASSWORD_IDENTITY = `test_dual_password_${stamp}`;
const CLERK_GOOGLE_IDENTITY = `test_dual_google_${stamp}`;

let owner: { id: number };

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

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [ownerRow] = await db
    .insert(usersTable)
    .values({
      clerkId: `test_owner_${stamp}`,
      name: "Test Owner",
      email: `owner-${stamp}@example.com`,
      role: "admin",
      roleSource: "owner_assigned",
    })
    .returning();
  owner = ownerRow!;
  ids.users.push(ownerRow!.id);
});

after(async () => {
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  const leftovers = await db.select().from(usersTable);
  const cleanupIds = leftovers
    .filter((u) => u.clerkId.startsWith("test_") && u.clerkId.endsWith(String(stamp)))
    .map((u) => u.id);
  const allIds = [...new Set([...ids.users, ...cleanupIds])];
  if (allIds.length) await db.delete(usersTable).where(inArray(usersTable.id, allIds));
  await db
    .delete(userIdentitiesTable)
    .where(
      inArray(userIdentitiesTable.clerkId, [CLERK_PASSWORD_IDENTITY, CLERK_GOOGLE_IDENTITY]),
    );
  server.close();
  await pool.end();
});

test("merging keeps the strongest access so cleanup cannot lock the owner out", () => {
  assert.deepEqual(
    strongestAccess([
      { role: "contractor", roleSource: "provisioned" },
      { role: "admin", roleSource: "owner" },
    ]),
    { role: "admin", roleSource: "owner" },
  );
  assert.deepEqual(
    strongestAccess([
      { role: "admin", roleSource: "provisioned" },
      { role: "admin", roleSource: "owner_assigned" },
    ]),
    { role: "admin", roleSource: "owner_assigned" },
  );
});

test("the team list shows one entry per person and keeps accounts without an email", () => {
  const rows = [
    { id: 2, email: "Dup@Example.com " },
    { id: 1, email: "dup@example.com" },
    { id: 3, email: null },
    { id: 4, email: null },
  ];
  const deduped = dedupeUsersByPerson(rows);
  assert.deepEqual(
    deduped.map((r) => r.id).sort((a, b) => a - b),
    [1, 3, 4],
  );
});

test("a second sign-in identity joins the existing account instead of creating one", async () => {
  const first = await resolveAccountForClerkId(
    CLERK_PASSWORD_IDENTITY,
    { name: "Dual Signin", email: SHARED_EMAIL, emailVerified: true },
    { role: "contractor", roleSource: "provisioned" },
  );
  assert.ok(first);
  ids.users.push(first.id);

  const second = await resolveAccountForClerkId(
    CLERK_GOOGLE_IDENTITY,
    { name: "Dual Signin", email: SHARED_EMAIL.toUpperCase(), emailVerified: true },
    { role: "contractor", roleSource: "provisioned" },
  );
  assert.ok(second);
  assert.equal(second.id, first.id, "both Clerk identities resolve to the same account");

  const identities = await db
    .select()
    .from(userIdentitiesTable)
    .where(eq(userIdentitiesTable.userId, first.id));
  assert.deepEqual(
    identities.map((i) => i.clerkId).sort(),
    [CLERK_GOOGLE_IDENTITY, CLERK_PASSWORD_IDENTITY].sort(),
  );
});

test("an unverified owner email does not bootstrap owner access", async () => {
  const configuredOwner = process.env.APP_OWNER_EMAIL;
  assert.ok(configuredOwner, "an owner email must be configured for this test to mean anything");

  // Anyone can put the owner's address on a new Clerk identity; only Clerk
  // confirming it makes it evidence of who is signing in.
  const unverified = resolveIdentityAccess(
    { name: "Owner Claimant", email: configuredOwner, emailVerified: false },
    { role: "contractor", roleSource: "provisioned" },
  );
  assert.equal(unverified.role, "contractor");
  assert.equal(unverified.roleSource, "provisioned");

  const verified = resolveIdentityAccess(
    { name: "Real Owner", email: configuredOwner, emailVerified: true },
    { role: "contractor", roleSource: "provisioned" },
  );
  assert.equal(verified.role, "admin");
  assert.equal(verified.roleSource, "owner");

  // Nor can an unverified claim be used to create an owner-level account.
  const claimant = await resolveAccountForClerkId(
    `test_owner_claim_${stamp}`,
    { name: "Owner Claimant", email: configuredOwner, emailVerified: false },
    unverified,
  );
  assert.ok(claimant);
  ids.users.push(claimant.id);
  assert.equal(claimant.role, "contractor");
  assert.equal(claimant.roleSource, "provisioned");
  assert.equal(claimant.email, null);
});

test("an unverified email cannot claim someone else's account", async () => {
  const impostorClerkId = `test_impostor_${stamp}`;
  const impostor = await resolveAccountForClerkId(
    impostorClerkId,
    { name: "Impostor", email: SHARED_EMAIL, emailVerified: false },
    { role: "contractor", roleSource: "provisioned" },
  );
  assert.ok(impostor);
  ids.users.push(impostor.id);

  const [victim] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, CLERK_PASSWORD_IDENTITY));
  assert.ok(victim);
  assert.notEqual(impostor.id, victim.id, "an unverified address must not join the existing account");
  assert.equal(impostor.role, "contractor");
  assert.equal(impostor.email, null, "an unverified address is not stored on the account");
});

test("pre-existing duplicate accounts merge, keeping history and references", async () => {
  const olderClerkId = `test_legacy_older_${stamp}`;
  const newerClerkId = `test_legacy_newer_${stamp}`;
  const email = `legacy-dupe-${stamp}@example.com`;

  const [older] = await db
    .insert(usersTable)
    .values({
      clerkId: olderClerkId,
      name: "Legacy Person",
      email,
      role: "admin",
      roleSource: "owner_assigned",
    })
    .returning();
  const [newer] = await db
    .insert(usersTable)
    .values({
      clerkId: newerClerkId,
      name: "Legacy Person",
      email: email.toUpperCase(),
      role: "admin",
      roleSource: "owner_assigned",
      phone: "555-0143",
    })
    .returning();
  ids.users.push(older!.id, newer!.id);

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `Dupe Merge Client ${stamp}`, status: "client" })
    .returning();
  ids.clients.push(client!.id);
  const [job] = await db
    .insert(jobsTable)
    .values({ clientId: client!.id, amount: 40, assignedToId: newer!.id })
    .returning();
  const [ticket] = await db
    .insert(ticketsTable)
    .values({ clientId: client!.id, title: `Dupe ticket ${stamp}`, assignedToId: newer!.id })
    .returning();

  const result = await reconcileUserAccounts();
  assert.ok(result.accountsMerged >= 1);

  const remaining = await db.select().from(usersTable).where(inArray(usersTable.id, [older!.id, newer!.id]));
  assert.equal(remaining.length, 1, "duplicates collapse into one account");
  assert.equal(remaining[0]!.id, older!.id, "the original account survives");
  assert.equal(remaining[0]!.phone, "555-0143", "details from the duplicate are kept");

  const [movedJob] = await db.select().from(jobsTable).where(eq(jobsTable.id, job!.id));
  assert.equal(movedJob!.assignedToId, older!.id, "work assigned to the duplicate follows the person");
  const [movedTicket] = await db.select().from(ticketsTable).where(eq(ticketsTable.id, ticket!.id));
  assert.equal(movedTicket!.assignedToId, older!.id);

  // Both sign-in methods still resolve, now to the single surviving account.
  for (const clerkId of [olderClerkId, newerClerkId]) {
    const resolved = await resolveAccountForClerkId(
      clerkId,
      { name: "Legacy Person", email, emailVerified: true },
      { role: "contractor", roleSource: "provisioned" },
    );
    assert.equal(resolved?.id, older!.id);
  }
});

test("demoting a person with two sign-in identities removes admin from both", async () => {
  const clerkPassword = `test_demote_password_${stamp}`;
  const clerkGoogle = `test_demote_google_${stamp}`;
  const email = `demote-me-${stamp}@example.com`;

  // Two rows exist because the app used to key accounts on Clerk identity.
  const [rowA] = await db
    .insert(usersTable)
    .values({
      clerkId: clerkPassword,
      name: "Two Identities",
      email,
      role: "admin",
      roleSource: "owner_assigned",
    })
    .returning();
  const [rowB] = await db
    .insert(usersTable)
    .values({
      clerkId: clerkGoogle,
      name: "Two Identities",
      email,
      role: "admin",
      roleSource: "owner_assigned",
    })
    .returning();
  ids.users.push(rowA!.id, rowB!.id);

  const list = await api("/users", owner.id);
  assert.equal(list.status, 200);
  const entries = list.body.filter((u: any) => u.email === email);
  assert.equal(entries.length, 1, "the team list shows one entry for the person");

  const res = await api(`/users/${entries[0].id}`, owner.id, {
    method: "PATCH",
    body: JSON.stringify({ role: "contractor" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, "contractor");

  // Signing in through either identity now lands on a contractor account.
  for (const clerkId of [clerkPassword, clerkGoogle]) {
    const resolved = await resolveAccountForClerkId(
      clerkId,
      { name: "Two Identities", email, emailVerified: true },
      { role: "contractor", roleSource: "provisioned" },
    );
    assert.ok(resolved);
    assert.equal(resolved.role, "contractor", `${clerkId} must lose admin access`);
    assert.equal(resolved.roleSource, "provisioned");
  }

  const rows = await db.select().from(usersTable).where(inArray(usersTable.id, [rowA!.id, rowB!.id]));
  assert.ok(rows.every((r) => r.role === "contractor"));
});

test("an admin cannot remove their own admin access", async () => {
  const res = await api(`/users/${owner.id}`, owner.id, {
    method: "PATCH",
    body: JSON.stringify({ role: "contractor" }),
  });
  assert.equal(res.status, 400);
  const [row] = await db.select().from(usersTable).where(eq(usersTable.id, owner.id));
  assert.equal(row!.role, "admin");
});

test("the configured owner cannot be demoted through a duplicate row", async () => {
  const email = `owner-dupe-${stamp}@example.com`;
  const [ownerRow] = await db
    .insert(usersTable)
    .values({
      clerkId: `test_owner_dupe_primary_${stamp}`,
      name: "Owner Person",
      email,
      role: "admin",
      roleSource: "owner",
    })
    .returning();
  const [dupRow] = await db
    .insert(usersTable)
    .values({
      clerkId: `test_owner_dupe_secondary_${stamp}`,
      name: "Owner Person",
      email,
      role: "admin",
      roleSource: "owner_assigned",
    })
    .returning();
  ids.users.push(ownerRow!.id, dupRow!.id);

  const res = await api(`/users/${dupRow!.id}`, owner.id, {
    method: "PATCH",
    body: JSON.stringify({ role: "contractor" }),
  });
  assert.equal(res.status, 400);
  const rows = await db
    .select()
    .from(usersTable)
    .where(inArray(usersTable.id, [ownerRow!.id, dupRow!.id]));
  assert.ok(rows.every((r) => r.role === "admin"));
});
