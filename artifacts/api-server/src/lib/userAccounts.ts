import {
  db,
  usersTable,
  userIdentitiesTable,
  jobsTable,
  fieldNotesTable,
  suggestedActionsTable,
  ticketsTable,
  type User,
} from "@workspace/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { redeemPendingInvitation, resolveNewAccountAccess } from "./invitations";
import { effectiveLevel } from "./access";

// Exported so lib/invitations.ts can type its transaction-scoped helpers
// without importing this module at runtime (it only needs the type).
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ClerkIdentityInput = {
  name: string;
  email: string | null;
  /**
   * Whether Clerk has verified the email address. Unverified addresses cannot
   * be used to join an existing account — otherwise anyone could sign up with a
   * colleague's address and inherit their access.
   */
  emailVerified: boolean;
} | null;

/**
 * A person is identified by their verified email address, case- and
 * whitespace-insensitively. Accounts without an email cannot be matched to a
 * person, so they are always treated as distinct.
 */
export function normalizeEmailKey(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

const ROLE_RANK: Record<string, number> = { admin: 2, contractor: 1 };
const ROLE_SOURCE_RANK: Record<string, number> = {
  owner: 3,
  owner_assigned: 2,
  provisioned: 1,
};

type AccessFields = { role: string; roleSource: string };

/**
 * Same idea for the level and extras: when duplicate rows of one person are
 * folded together, the one with the wider level wins and the extras of both
 * rows are kept, so a merge can only ever keep access — never quietly narrow
 * it. Narrowing is done on purpose on the Team page.
 */
const LEVEL_RANK: Record<string, number> = { full: 3, office: 2, mobile: 1 };

export function widestLevel(
  accounts: readonly { accessLevel: string; permissions: string[] | null }[],
): { accessLevel: string; permissions: string[] } {
  let accessLevel = "mobile";
  const permissions = new Set<string>();
  for (const a of accounts) {
    if ((LEVEL_RANK[a.accessLevel] ?? 0) > (LEVEL_RANK[accessLevel] ?? 0)) accessLevel = a.accessLevel;
    for (const p of a.permissions ?? []) permissions.add(p);
  }
  return { accessLevel, permissions: [...permissions] };
}

/**
 * Merging accounts must never silently drop access — otherwise cleaning up
 * duplicates could lock the configured owner out of their own app. The
 * strongest access among the merged rows wins; taking access away is done
 * deliberately through the team page, which updates every row for the person.
 */
export function strongestAccess(accounts: readonly AccessFields[]): AccessFields {
  return accounts.reduce<AccessFields>(
    (best, candidate) => {
      const betterRole = (ROLE_RANK[candidate.role] ?? 0) > (ROLE_RANK[best.role] ?? 0);
      const sameRole = candidate.role === best.role;
      const betterSource =
        (ROLE_SOURCE_RANK[candidate.roleSource] ?? 0) > (ROLE_SOURCE_RANK[best.roleSource] ?? 0);
      if (betterRole || (sameRole && betterSource)) {
        return { role: candidate.role, roleSource: candidate.roleSource };
      }
      return best;
    },
    { role: "contractor", roleSource: "provisioned" },
  );
}

const FILLABLE_FIELDS = [
  "name",
  "email",
  "phone",
  "baseAddress",
  "baseLat",
  "baseLng",
  "displayName",
  "birthday",
  "hireDate",
] as const;

/**
 * The name the rest of the app shows for a person: the short name Adam typed
 * on the Team page, else whatever the sign-in gave us. His complaint was a
 * contractor showing up on the dispatch board as an email address — when the
 * sign-in name is only an email, the part before the @ is at least a name.
 */
export function shownName(user: { name: string; displayName?: string | null }): string {
  const display = user.displayName?.trim();
  if (display) return display;
  const name = user.name.trim();
  if (name.includes("@")) return name.split("@")[0] || name;
  return name;
}

/**
 * The surviving row keeps its own values; duplicates only fill in blanks, so a
 * phone number or home base entered on the newer account is not lost.
 */
export function mergeAccountFields(canonical: User, duplicates: readonly User[]) {
  const access = strongestAccess([canonical, ...duplicates]);
  const level = widestLevel([canonical, ...duplicates]);
  const merged: Partial<User> = {
    ...access,
    ...level,
    // A merge must not leave the role and the level disagreeing: folding a
    // contractor row that still carries the old "full" default would write
    // that level back out and make them look like a full user on the Team
    // page. The role is the truth.
    accessLevel: effectiveLevel({ ...access, accessLevel: level.accessLevel, permissions: null }),
  };
  for (const field of FILLABLE_FIELDS) {
    if (canonical[field] != null && canonical[field] !== "") continue;
    const donor = duplicates.find((d) => d[field] != null && d[field] !== "");
    if (donor) (merged as Record<string, unknown>)[field] = donor[field];
  }
  return merged;
}

/** The oldest row survives: it is the one history and references point at. */
export function pickCanonical(accounts: readonly User[]): { canonical: User; duplicates: User[] } {
  const sorted = [...accounts].sort((a, b) => a.id - b.id);
  return { canonical: sorted[0]!, duplicates: sorted.slice(1) };
}

/**
 * Keeps one entry per person for display. Accounts without an email cannot be
 * matched to a person and are always kept.
 */
export function dedupeUsersByPerson<T extends { id: number; email: string | null }>(
  users: readonly T[],
): T[] {
  const byEmail = new Map<string, T>();
  const result: T[] = [];
  for (const user of users) {
    const key = normalizeEmailKey(user.email);
    if (key === null) {
      result.push(user);
      continue;
    }
    const existing = byEmail.get(key);
    if (!existing) {
      byEmail.set(key, user);
      result.push(user);
      continue;
    }
    // Keep the oldest row so the entry matches the merged account.
    if (user.id < existing.id) {
      result[result.indexOf(existing)] = user;
      byEmail.set(key, user);
    }
  }
  return result;
}

/**
 * Serializes provisioning/merging for one person so two simultaneous sign-ins
 * cannot each create an account for the same email.
 */
async function lockEmail(tx: Tx, emailKey: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app-user:${emailKey}`}))`);
}

function usersWithEmailKey(tx: Tx | typeof db, emailKey: string) {
  return tx
    .select()
    .from(usersTable)
    .where(sql`lower(trim(${usersTable.email})) = ${emailKey}`);
}

/**
 * Points every reference to `duplicates` at `canonical`, moves their sign-in
 * identities over, and deletes the now-empty rows. Runs inside the caller's
 * transaction so a partial merge can never be observed.
 */
async function absorbDuplicates(tx: Tx, canonical: User, duplicates: readonly User[]) {
  const dupIds = duplicates.map((d) => d.id);
  if (dupIds.length === 0) return canonical;

  await tx
    .update(jobsTable)
    .set({ assignedToId: canonical.id })
    .where(inArray(jobsTable.assignedToId, dupIds));
  await tx
    .update(fieldNotesTable)
    .set({ authorId: canonical.id })
    .where(inArray(fieldNotesTable.authorId, dupIds));
  await tx
    .update(suggestedActionsTable)
    .set({ reviewedById: canonical.id })
    .where(inArray(suggestedActionsTable.reviewedById, dupIds));
  await tx
    .update(ticketsTable)
    .set({ assignedToId: canonical.id })
    .where(inArray(ticketsTable.assignedToId, dupIds));

  // Existing identities follow the person...
  await tx
    .update(userIdentitiesTable)
    .set({ userId: canonical.id })
    .where(inArray(userIdentitiesTable.userId, dupIds));
  // ...and each duplicate's own Clerk id keeps resolving after its row is gone.
  await tx
    .insert(userIdentitiesTable)
    .values(duplicates.map((d) => ({ userId: canonical.id, clerkId: d.clerkId })))
    .onConflictDoUpdate({
      target: userIdentitiesTable.clerkId,
      set: { userId: canonical.id },
    });

  const [updated] = await tx
    .update(usersTable)
    .set(mergeAccountFields(canonical, duplicates))
    .where(eq(usersTable.id, canonical.id))
    .returning();
  await tx.delete(usersTable).where(inArray(usersTable.id, dupIds));
  return updated ?? canonical;
}

/**
 * Collapses every account sharing `emailKey` into one. Safe to call repeatedly.
 */
export async function mergeAccountsForEmail(emailKey: string): Promise<User | null> {
  return db.transaction(async (tx) => {
    await lockEmail(tx, emailKey);
    const accounts = await usersWithEmailKey(tx, emailKey);
    if (accounts.length === 0) return null;
    const { canonical, duplicates } = pickCanonical(accounts);
    if (duplicates.length === 0) return canonical;
    return absorbDuplicates(tx, canonical, duplicates);
  });
}

async function findUserByClerkId(
  clerkId: string,
): Promise<{ user: User; linked: boolean } | null> {
  const [match] = await db
    .select({ user: usersTable })
    .from(userIdentitiesTable)
    .innerJoin(usersTable, eq(usersTable.id, userIdentitiesTable.userId))
    .where(eq(userIdentitiesTable.clerkId, clerkId));
  if (match) return { user: match.user, linked: true };
  // Accounts created before identities existed still carry their primary id.
  const [legacy] = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId));
  return legacy ? { user: legacy, linked: false } : null;
}

/**
 * Resolves the app account for a verified Clerk identity, creating one only
 * when the person is genuinely new. A second sign-in method for a known email
 * is attached to the existing account instead of becoming a separate one.
 */
export async function resolveAccountForClerkId(
  clerkId: string,
  identity: ClerkIdentityInput,
  newAccountAccess: AccessFields,
): Promise<User | null> {
  const existing = await findUserByClerkId(clerkId);
  if (existing) {
    if (!existing.linked) {
      // Backfill the identity row for accounts provisioned before identities.
      await db
        .insert(userIdentitiesTable)
        .values({ userId: existing.user.id, clerkId })
        .onConflictDoNothing({ target: userIdentitiesTable.clerkId });
    }
    return existing.user;
  }

  const emailKey = identity?.emailVerified ? normalizeEmailKey(identity.email) : null;
  if (emailKey === null) {
    const [created] = await db
      .insert(usersTable)
      .values({
        clerkId,
        name: identity?.name ?? "New User",
        // An unverified address is not proof of identity, so it is not stored
        // on the account where it could later be treated as the same person.
        email: identity?.emailVerified ? identity.email : null,
        role: newAccountAccess.role,
        roleSource: newAccountAccess.roleSource,
        // No verified email means no invitation to look up: the owner is a
        // full user, anyone else starts in the phone app.
        accessLevel: newAccountAccess.roleSource === "owner" ? "full" : "mobile",
      })
      .onConflictDoNothing({ target: usersTable.clerkId })
      .returning();
    const user = created ?? (await findUserByClerkId(clerkId))?.user ?? null;
    if (user) {
      await db
        .insert(userIdentitiesTable)
        .values({ userId: user.id, clerkId })
        .onConflictDoNothing({ target: userIdentitiesTable.clerkId });
    }
    return user;
  }

  return db.transaction(async (tx) => {
    await lockEmail(tx, emailKey);
    const accounts = await usersWithEmailKey(tx, emailKey);
    let user: User | undefined;
    if (accounts.length > 0) {
      const { canonical, duplicates } = pickCanonical(accounts);
      user = await absorbDuplicates(tx, canonical, duplicates);
    } else {
      // A genuinely new person: fold in any pending invitation for this
      // (already verified) email before deciding their starting role.
      const access = await resolveNewAccountAccess(tx, emailKey, newAccountAccess);
      [user] = await tx
        .insert(usersTable)
        .values({
          clerkId,
          name: identity?.name ?? "New User",
          // An unverified address is not proof of identity, so it is not stored
        // on the account where it could later be treated as the same person.
        email: identity?.emailVerified ? identity.email : null,
          role: access.role,
          roleSource: access.roleSource,
          accessLevel: access.accessLevel,
          permissions: access.permissions,
        })
        .onConflictDoNothing({ target: usersTable.clerkId })
        .returning();
      if (!user) {
        [user] = await tx.select().from(usersTable).where(eq(usersTable.clerkId, clerkId));
      }
      // Scoped to acceptedAt IS NULL, so this is a harmless no-op when there
      // was no invitation (or it was already redeemed by a race).
      if (user) await redeemPendingInvitation(tx, emailKey, user.id);
    }
    if (!user) return null;
    await tx
      .insert(userIdentitiesTable)
      .values({ userId: user.id, clerkId })
      .onConflictDoUpdate({ target: userIdentitiesTable.clerkId, set: { userId: user.id } });
    return user;
  });
}

/**
 * Puts the stored level back in step with the role for anyone it drifted on.
 * The level column arrived after his subcontractors were already in the
 * database, so every one of them was stamped with the widest level there is.
 * Nothing let them into the office (the role still ruled), but the Team page
 * read the column, so they showed as full users and one Save would have made
 * that real. Safe to run again: it only touches rows that disagree.
 */
export async function backfillContractorLevels(): Promise<number> {
  const fixed = await db
    .update(usersTable)
    .set({ accessLevel: "mobile" })
    .where(and(eq(usersTable.role, "contractor"), ne(usersTable.accessLevel, "mobile")))
    .returning({ id: usersTable.id });
  return fixed.length;
}

/**
 * One-time-per-boot cleanup: registers identities for pre-existing accounts,
 * merges any duplicate accounts already in the database, and puts any drifted
 * access level back in step with its role.
 */
export async function reconcileUserAccounts(): Promise<{
  identitiesBackfilled: number;
  accountsMerged: number;
  levelsRealigned: number;
}> {
  const levelsRealigned = await backfillContractorLevels();
  const users = await db.select().from(usersTable);
  let identitiesBackfilled = 0;
  if (users.length > 0) {
    const inserted = await db
      .insert(userIdentitiesTable)
      .values(users.map((u) => ({ userId: u.id, clerkId: u.clerkId })))
      .onConflictDoNothing({ target: userIdentitiesTable.clerkId })
      .returning({ id: userIdentitiesTable.id });
    identitiesBackfilled = inserted.length;
  }

  const seen = new Map<string, number>();
  const duplicateKeys: string[] = [];
  for (const user of users) {
    const key = normalizeEmailKey(user.email);
    if (key === null) continue;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) duplicateKeys.push(key);
  }

  let accountsMerged = 0;
  for (const key of duplicateKeys) {
    const before = seen.get(key) ?? 0;
    await mergeAccountsForEmail(key);
    accountsMerged += before - 1;
  }
  return { identitiesBackfilled, accountsMerged, levelsRealigned };
}
