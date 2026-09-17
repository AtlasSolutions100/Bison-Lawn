import { Router, type IRouter } from "express";
import {
  db,
  usersTable,
  invitationsTable,
  jobsTable,
  fieldNotesTable,
  ticketsTable,
  suggestedActionsTable,
  type User,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import {
  CreateInvitationBody,
  DeleteUserParams,
  RevokeInvitationParams,
  UpdateUserBody,
} from "@workspace/api-zod";
import { requireAuth, requireArea } from "../middlewares/requireAuth";
import {
  dedupeUsersByPerson,
  mergeAccountsForEmail,
  normalizeEmailKey,
  shownName,
} from "../lib/userAccounts";
import { findUserByEmailKey, listInvitations, upsertInvitation } from "../lib/invitations";
import { sendInvitationEmail } from "../lib/invitationEmail";
import { logger } from "../lib/logger";
import { logAudit } from "../lib/helpers";
import {
  AREA_LABELS,
  areasFor,
  can,
  effectiveLevel,
  isAccessLevel,
  normalizePermissions,
  roleForLevel,
  type AccessLevel,
} from "../lib/access";

const router: IRouter = Router();

const LEVEL_WORDS: Record<string, string> = {
  full: "full user",
  office: "office user",
  mobile: "mobile only",
};

/** What a permission list reads like in the audit trail: "no QuickBooks, plus Reports". */
function describePermissions(permissions: string[]): string {
  const denied = permissions.filter((p) => p.startsWith("!")).map((p) => AREA_LABELS[p.slice(1) as keyof typeof AREA_LABELS] ?? p.slice(1));
  const granted = permissions.filter((p) => !p.startsWith("!")).map((p) => AREA_LABELS[p as keyof typeof AREA_LABELS] ?? p);
  const parts = [];
  if (granted.length) parts.push(`plus ${granted.join(", ")}`);
  if (denied.length) parts.push(`no ${denied.join(", ")}`);
  return parts.join(", ");
}

/**
 * The one shape every user response takes. `name` is what the rest of the
 * app shows (his short name, never an email); `areas` is worked out here so
 * the sidebar, the route guards and the Team page can never disagree.
 */
function present(user: User, extra: { jobCount?: number; historyCount?: number } = {}) {
  return {
    ...user,
    name: shownName(user),
    fullName: user.name,
    // Never the raw column: a row whose level disagrees with its role (every
    // contractor who existed before the level column did) has to read as what
    // it really is, or the Team page shows a subcontractor as a full user and
    // pressing Save makes it true.
    accessLevel: effectiveLevel(user),
    permissions: normalizePermissions(user.permissions),
    areas: areasFor(user),
    ...extra,
  };
}

/**
 * What still points at a person, per row id: the jobs they were sent on plus
 * the notes they left, the tickets on their plate and the suggestions they
 * reviewed. Jobs are counted on their own because that is the number the Team
 * page says out loud; the rest matter because the database will not let a row
 * go while they exist, and a delete that trips over one is a 500 in his face
 * instead of "turn them off instead".
 */
async function historyCounts(userIds: number[]): Promise<{
  jobs: Map<number, number>;
  total: Map<number, number>;
}> {
  const jobs = new Map<number, number>();
  const total = new Map<number, number>();
  if (userIds.length === 0) return { jobs, total };
  const n = sql<number>`count(*)::int`;
  const [jobRows, noteRows, ticketRows, reviewRows] = await Promise.all([
    db
      .select({ userId: jobsTable.assignedToId, n })
      .from(jobsTable)
      .where(inArray(jobsTable.assignedToId, userIds))
      .groupBy(jobsTable.assignedToId),
    db
      .select({ userId: fieldNotesTable.authorId, n })
      .from(fieldNotesTable)
      .where(inArray(fieldNotesTable.authorId, userIds))
      .groupBy(fieldNotesTable.authorId),
    db
      .select({ userId: ticketsTable.assignedToId, n })
      .from(ticketsTable)
      .where(inArray(ticketsTable.assignedToId, userIds))
      .groupBy(ticketsTable.assignedToId),
    db
      .select({ userId: suggestedActionsTable.reviewedById, n })
      .from(suggestedActionsTable)
      .where(inArray(suggestedActionsTable.reviewedById, userIds))
      .groupBy(suggestedActionsTable.reviewedById),
  ]);
  for (const row of jobRows) {
    if (row.userId == null) continue;
    jobs.set(row.userId, row.n);
  }
  for (const row of [...jobRows, ...noteRows, ...ticketRows, ...reviewRows]) {
    if (row.userId == null) continue;
    total.set(row.userId, (total.get(row.userId) ?? 0) + row.n);
  }
  return { jobs, total };
}

router.get("/me", requireAuth, (req, res) => {
  return res.json(present(req.appUser!));
});

router.get("/users", requireAuth, async (req, res) => {
  const includeInactive = req.query.includeInactive === "true";
  const all = await db.select().from(usersTable).orderBy(usersTable.name);
  // One entry per person, even if duplicate rows are still awaiting cleanup.
  // Someone Adam turned off stays out of every dropdown unless the Team page
  // asks for them by name.
  const users = dedupeUsersByPerson(all).filter((u) => includeInactive || u.active);
  if (!can(req.appUser!, "team")) {
    // Contractors only need names/roles for display — hide contact + home-base data
    return res.json(
      users.map((u) => ({
        id: u.id,
        clerkId: "",
        name: shownName(u),
        role: u.role,
        accessLevel: effectiveLevel(u),
        permissions: [],
        areas: [],
        active: u.active,
        email: null,
        phone: null,
        baseAddress: null,
        baseLat: null,
        baseLng: null,
      })),
    );
  }
  // How much history each person has, so the page can offer Delete only when
  // there is none to lose.
  const counts = await historyCounts(all.map((u) => u.id));
  const rowsByEmail = new Map<string, number[]>();
  for (const u of all) {
    const key = normalizeEmailKey(u.email);
    if (key) rowsByEmail.set(key, [...(rowsByEmail.get(key) ?? []), u.id]);
  }
  return res.json(
    users.map((u) => {
      const key = normalizeEmailKey(u.email);
      const rowIds = key ? (rowsByEmail.get(key) ?? [u.id]) : [u.id];
      const jobCount = rowIds.reduce((sum, id) => sum + (counts.jobs.get(id) ?? 0), 0);
      const historyCount = rowIds.reduce((sum, id) => sum + (counts.total.get(id) ?? 0), 0);
      return present(u, { jobCount, historyCount });
    }),
  );
});

router.patch("/users/:id", requireAuth, requireArea("team"), async (req, res) => {
  const body = UpdateUserBody.parse(req.body);
  const id = Number(req.params.id);
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) return res.status(404).json({ error: "User not found" });

  const emailKey = normalizeEmailKey(existing.email);
  const isSelf =
    existing.id === req.appUser!.id ||
    (emailKey !== null && emailKey === normalizeEmailKey(req.appUser!.email));

  // The level is the thing Adam picks; the role follows it. A plain role
  // change (older callers) still works and picks the matching level.
  let accessLevel: AccessLevel | undefined;
  let role: "admin" | "contractor" | undefined;
  if (body.accessLevel != null) {
    if (!isAccessLevel(body.accessLevel)) return res.status(400).json({ error: "Unknown access level" });
    accessLevel = body.accessLevel;
    role = roleForLevel(accessLevel);
  } else if (body.role != null) {
    role = body.role;
    accessLevel =
      role === "contractor" ? "mobile" : existing.accessLevel === "mobile" ? "full" : (existing.accessLevel as AccessLevel);
  }
  const permissions = body.permissions != null ? normalizePermissions(body.permissions) : undefined;
  const active = body.active;

  const demoting = role != null && role !== "admin";

  // An admin who demoted, switched off or fenced their own account would lose
  // the Team page and could not undo it.
  if (isSelf) {
    if (demoting) return res.status(400).json({ error: "You cannot remove your own admin access" });
    if (active === false) return res.status(400).json({ error: "You cannot turn off your own account" });
    const after = {
      ...existing,
      accessLevel: accessLevel ?? existing.accessLevel,
      permissions: permissions ?? existing.permissions,
    };
    if (!can(after, "team")) {
      return res.status(400).json({ error: "You cannot take the Team page away from yourself" });
    }
  }

  // Collapse any leftover duplicate rows first so the change lands on one
  // account instead of whichever sign-in identity was clicked.
  if (emailKey !== null) await mergeAccountsForEmail(emailKey);

  const targets = emailKey
    ? await db
        .select()
        .from(usersTable)
        .where(sql`lower(trim(${usersTable.email})) = ${emailKey}`)
    : [existing];
  if (targets.length === 0) return res.status(404).json({ error: "User not found" });

  // The configured owner always has everything: no demoting, no switching
  // off, no "office" level and no denials. Otherwise a slip on this page could
  // lock Adam out of his own books.
  if (targets.some((t) => t.roleSource === "owner")) {
    if (demoting) return res.status(400).json({ error: "The configured owner cannot be demoted" });
    if (active === false) return res.status(400).json({ error: "The configured owner cannot be turned off" });
    if ((accessLevel != null && accessLevel !== "full") || permissions?.some((p) => p.startsWith("!"))) {
      return res.status(400).json({ error: "The configured owner always has every part of the app" });
    }
  }

  const { role: _r, accessLevel: _l, permissions: _p, active: _a, ...details } = body;

  // Every account this person can sign in with gets the same access, so
  // removing access actually removes it.
  const updated = await db.transaction(async (tx) => {
    const rows = [];
    for (const target of targets) {
      const roleSource =
        role == null
          ? target.roleSource
          : target.roleSource === "owner"
            ? "owner"
            : role === "admin"
              ? "owner_assigned"
              : "provisioned";
      const [row] = await tx
        .update(usersTable)
        .set({
          ...details,
          ...(role != null ? { role } : {}),
          ...(accessLevel != null ? { accessLevel } : {}),
          ...(permissions != null ? { permissions } : {}),
          ...(active != null ? { active } : {}),
          roleSource,
        })
        .where(eq(usersTable.id, target.id))
        .returning();
      if (row) rows.push(row);
    }
    return rows;
  });

  const user = updated.find((u) => u.id === id) ?? updated[0]!;

  // Compared against the level that was really in force, not the stored
  // column: a legacy contractor row says "full" while the app treated them as
  // mobile, and writing "now mobile only" for that would be a lie.
  const existingLevel = effectiveLevel(existing);
  const accessChanged =
    (accessLevel != null && accessLevel !== existingLevel) ||
    (permissions != null && permissions.join(",") !== normalizePermissions(existing.permissions).join(",")) ||
    (active != null && active !== existing.active);
  if (accessChanged) {
    const bits = [];
    if (active != null && active !== existing.active) bits.push(active ? "turned back on" : "turned off (history kept)");
    if (accessLevel != null && accessLevel !== existingLevel) bits.push(`now ${LEVEL_WORDS[accessLevel] ?? accessLevel}`);
    if (permissions != null) {
      const words = describePermissions(permissions);
      bits.push(words ? `extras: ${words}` : "no extras");
    }
    await logAudit({
      actorName: req.appUser!.name,
      action: "team.access_changed",
      description: `${shownName(user)}: ${bits.join("; ")}`,
    });
  }

  return res.json(present(user));
});

router.delete("/users/:id", requireAuth, requireArea("team"), async (req, res) => {
  const { id } = DeleteUserParams.parse(req.params);
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) return res.status(404).json({ error: "User not found" });

  const emailKey = normalizeEmailKey(existing.email);
  if (
    existing.id === req.appUser!.id ||
    (emailKey !== null && emailKey === normalizeEmailKey(req.appUser!.email))
  ) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }

  const targets = emailKey
    ? await db.select().from(usersTable).where(sql`lower(trim(${usersTable.email})) = ${emailKey}`)
    : [existing];
  if (targets.some((t) => t.roleSource === "owner")) {
    return res.status(400).json({ error: "The configured owner cannot be deleted" });
  }

  // Jobs are the history worth keeping: who mowed what, what got billed.
  // Someone with jobs on record is turned off, not deleted, so that history
  // still says a name. Notes, tickets and reviewed suggestions count the same
  // way: the database holds on to them, so a delete that ignored them used to
  // come back as "Something went wrong" with no idea what to do about it.
  const targetIds = targets.map((t) => t.id);
  const counts = await historyCounts(targetIds);
  const jobs = targetIds.reduce((sum, id) => sum + (counts.jobs.get(id) ?? 0), 0);
  const total = targetIds.reduce((sum, id) => sum + (counts.total.get(id) ?? 0), 0);
  if (jobs > 0) {
    return res.status(400).json({
      error: `${shownName(existing)} has ${jobs} job${jobs === 1 ? "" : "s"} on record. Turn them off instead so the history stays.`,
    });
  }
  if (total > 0) {
    return res.status(400).json({
      error: `${shownName(existing)} has notes or tickets on record. Turn them off instead so the history stays.`,
    });
  }

  try {
    await db.delete(usersTable).where(inArray(usersTable.id, targetIds));
  } catch (err) {
    // If something added later still points at this row, say the useful thing
    // rather than "Something went wrong. Please try again."
    if ((err as { code?: string } | null)?.code === "23503") {
      return res.status(400).json({
        error: `${shownName(existing)} has history on record. Turn them off instead so the history stays.`,
      });
    }
    throw err;
  }
  await logAudit({
    actorName: req.appUser!.name,
    action: "team.deleted",
    description: `${shownName(existing)} removed from the team (nothing on record)`,
  });
  return res.status(204).end();
});

router.get("/invitations", requireAuth, requireArea("team"), async (_req, res) => {
  return res.json(await listInvitations());
});

router.post("/invitations", requireAuth, requireArea("team"), async (req, res) => {
  const body = CreateInvitationBody.parse(req.body);
  const emailKey = normalizeEmailKey(body.email);
  if (!emailKey) return res.status(400).json({ error: "Email is required" });

  // An invitation exists to grant a person who has never signed in a role in
  // advance; someone who already has a verified account is edited on the
  // Team page instead, so their access change is a deliberate act there.
  const existingUser = await findUserByEmailKey(emailKey);
  if (existingUser) {
    return res.status(400).json({
      error: "This person already has an account — edit their access on the Team page instead.",
    });
  }

  // The level is what the form sends now; a bare role from an older caller
  // still maps to the level it always meant.
  const accessLevel: AccessLevel =
    body.accessLevel != null && isAccessLevel(body.accessLevel)
      ? body.accessLevel
      : body.role === "admin"
        ? "full"
        : "mobile";
  const permissions = normalizePermissions(body.permissions ?? []);

  const invitation = await upsertInvitation({
    email: emailKey,
    role: roleForLevel(accessLevel),
    accessLevel,
    permissions,
    note: body.note ?? null,
    invitedById: req.appUser!.id,
    invitedByName: req.appUser!.name,
  });

  // Actually tell them. Creating the row used to be the whole of "Invite",
  // which is why a contractor was reported waiting for an email that had never
  // been sent. The row is still worth keeping if the mail fails — the role
  // applies the moment they sign in either way — so the outcome is recorded on
  // the invitation rather than failing the request.
  const sent = await sendInvitationEmail({
    email: emailKey,
    role: invitation.role,
    invitedByName: req.appUser!.name,
    note: invitation.note,
  });
  const [stamped] = await db
    .update(invitationsTable)
    .set({ emailedAt: sent.emailed ? new Date() : null, emailError: sent.error })
    .where(eq(invitationsTable.id, invitation.id))
    .returning();
  if (!sent.emailed) {
    logger.error({ err: sent.error, email: emailKey }, "invitation email failed");
  }
  await logAudit({
    actorName: req.appUser!.name,
    action: "team.invited",
    description: `${emailKey} invited as ${LEVEL_WORDS[accessLevel]}${describePermissions(permissions) ? ` (${describePermissions(permissions)})` : ""}`,
  });
  return res.status(201).json(stamped ?? invitation);
});

router.post("/invitations/:id/resend", requireAuth, requireArea("team"), async (req, res) => {
  const { id } = RevokeInvitationParams.parse(req.params);
  const [invitation] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, id));
  if (!invitation) return res.status(404).json({ error: "Invitation not found" });
  if (invitation.acceptedAt) {
    return res.status(400).json({ error: "This invitation was already accepted." });
  }

  const sent = await sendInvitationEmail({
    email: invitation.email,
    role: invitation.role,
    invitedByName: invitation.invitedByName,
    note: invitation.note,
  });
  const [stamped] = await db
    .update(invitationsTable)
    .set({ emailedAt: sent.emailed ? new Date() : null, emailError: sent.error })
    .where(eq(invitationsTable.id, id))
    .returning();
  return res.json(stamped);
});

router.delete("/invitations/:id", requireAuth, requireArea("team"), async (req, res) => {
  const { id } = RevokeInvitationParams.parse(req.params);
  const [invitation] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, id));
  if (!invitation) return res.status(404).json({ error: "Invitation not found" });

  // An accepted invitation is a historical record of how that person got
  // their role, not a live grant — revoking it must never look like it
  // touched (or could touch) the account it already produced.
  if (invitation.acceptedAt) {
    return res.status(400).json({ error: "This invitation was already accepted and cannot be revoked" });
  }

  await db.delete(invitationsTable).where(eq(invitationsTable.id, id));
  return res.status(204).end();
});

export default router;
