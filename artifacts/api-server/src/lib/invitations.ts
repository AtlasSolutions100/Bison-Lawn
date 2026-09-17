import { db, invitationsTable, usersTable, type Invitation } from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "./userAccounts";
import { isAccessLevel, roleForLevel, type AccessLevel } from "./access";

export type InvitationRole = "admin" | "contractor";

/** Newest first, so a just-sent or just-updated invite is easy to find. */
export async function listInvitations(): Promise<Invitation[]> {
  return db.select().from(invitationsTable).orderBy(desc(invitationsTable.createdAt));
}

/**
 * A person who already has a verified account should be edited on the Team
 * page, not invited — an invitation only exists to grant access to someone
 * who has never signed in, so this lets the route refuse the redundant case.
 */
export async function findUserByEmailKey(emailKey: string) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(trim(${usersTable.email})) = ${emailKey}`);
  return user ?? null;
}

/**
 * One invitation per address (the table enforces it). Re-inviting an address
 * that is still pending updates that same row — role, note, inviter — rather
 * than failing, so a typo in the role is fixable without revoking first.
 * acceptedAt/acceptedByUserId are never touched here: once accepted, the row
 * is a historical record of how that person got their role, not a live invite.
 */
export async function upsertInvitation(input: {
  email: string;
  role: InvitationRole;
  accessLevel: string;
  permissions: string[];
  note: string | null;
  invitedById: number;
  invitedByName: string;
}): Promise<Invitation> {
  const [row] = await db
    .insert(invitationsTable)
    .values({
      email: input.email,
      role: input.role,
      accessLevel: input.accessLevel,
      permissions: input.permissions,
      note: input.note,
      invitedById: input.invitedById,
      invitedByName: input.invitedByName,
    })
    .onConflictDoUpdate({
      target: invitationsTable.email,
      set: {
        role: input.role,
        accessLevel: input.accessLevel,
        permissions: input.permissions,
        note: input.note,
        invitedById: input.invitedById,
        invitedByName: input.invitedByName,
      },
    })
    .returning();
  return row!;
}

/**
 * Decides the role a brand-new account should be provisioned with, folding in
 * any pending invitation for its (already verified) email. Called from inside
 * the same locked transaction that creates the account, so it can never race
 * a concurrent invite or sign-in for the same address.
 *
 * A configured owner email always wins: callers only pass a fallback whose
 * roleSource is already "owner" when the owner-bootstrap check matched, and
 * that case is returned untouched — an invitation can never downgrade it.
 */
export async function resolveNewAccountAccess(
  tx: Tx,
  emailKey: string,
  fallback: { role: string; roleSource: string },
): Promise<{ role: string; roleSource: string; accessLevel: string; permissions: string[] }> {
  // The owner is a full user with everything; someone who signed up on their
  // own with no invitation is a contractor, so mobile-only.
  if (fallback.roleSource === "owner") return { ...fallback, accessLevel: "full", permissions: [] };

  const [invitation] = await tx
    .select()
    .from(invitationsTable)
    .where(and(eq(invitationsTable.email, emailKey), isNull(invitationsTable.acceptedAt)));
  if (!invitation) return { ...fallback, accessLevel: "mobile", permissions: [] };

  // The level and the role have to agree, because the app reads both: the
  // role decides which app they land in and the level decides what is turned
  // on once they are there. An invitation sent before levels existed carries
  // the level the column was added with, so an office person invited back then
  // reads as {admin, mobile} — the office shell with every screen switched
  // off. Someone invited as an admin is a full user; otherwise the level
  // decides the role.
  const level = isAccessLevel(invitation.accessLevel) ? invitation.accessLevel : "mobile";
  const accessLevel: AccessLevel = invitation.role === "admin" && level === "mobile" ? "full" : level;
  // Mirrors the PATCH /users/:id convention: "owner_assigned" marks a
  // deliberate admin grant. Contractor is the unprivileged floor role, so an
  // invited contractor is just "provisioned" like anyone who signed up
  // unassigned — there is no access difference to mark.
  const role = roleForLevel(accessLevel);
  return {
    role,
    roleSource: role === "admin" ? "owner_assigned" : "provisioned",
    accessLevel,
    permissions: invitation.permissions ?? [],
  };
}

/**
 * Marks a pending invitation redeemed once the address's verified owner has
 * actually signed in. Scoped to acceptedAt IS NULL, so calling it again (e.g.
 * a second sign-in racing the first) is a harmless no-op rather than
 * overwriting who first accepted it.
 */
export async function redeemPendingInvitation(
  tx: Tx,
  emailKey: string,
  userId: number,
): Promise<void> {
  await tx
    .update(invitationsTable)
    .set({ acceptedAt: new Date(), acceptedByUserId: userId })
    .where(and(eq(invitationsTable.email, emailKey), isNull(invitationsTable.acceptedAt)));
}
