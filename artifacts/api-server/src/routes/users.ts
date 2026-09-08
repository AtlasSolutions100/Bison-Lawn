import { Router, type IRouter } from "express";
import { db, usersTable, invitationsTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { CreateInvitationBody, RevokeInvitationParams, UpdateUserBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import {
  dedupeUsersByPerson,
  mergeAccountsForEmail,
  normalizeEmailKey,
} from "../lib/userAccounts";
import { findUserByEmailKey, listInvitations, upsertInvitation } from "../lib/invitations";
import { sendInvitationEmail } from "../lib/invitationEmail";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/me", requireAuth, (req, res) => {
  return res.json(req.appUser);
});

router.get("/users", requireAuth, async (req, res) => {
  const all = await db.select().from(usersTable).orderBy(usersTable.name);
  // One entry per person, even if duplicate rows are still awaiting cleanup.
  const users = dedupeUsersByPerson(all);
  if (req.appUser!.role !== "admin") {
    // Contractors only need names/roles for display — hide contact + home-base data
    return res.json(
      users.map((u) => ({
        id: u.id,
        clerkId: "",
        name: u.name,
        role: u.role,
        email: null,
        phone: null,
        baseAddress: null,
        baseLat: null,
        baseLng: null,
      })),
    );
  }
  return res.json(users);
});

router.patch("/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const body = UpdateUserBody.parse(req.body);
  const id = Number(req.params.id);
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) return res.status(404).json({ error: "User not found" });

  const emailKey = normalizeEmailKey(existing.email);
  const demoting = body.role != null && body.role !== "admin";

  // An admin who demoted their own account would lose access to the team page
  // and could not undo it.
  if (
    demoting &&
    (existing.id === req.appUser!.id ||
      (emailKey !== null && emailKey === normalizeEmailKey(req.appUser!.email)))
  ) {
    return res.status(400).json({ error: "You cannot remove your own admin access" });
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

  if (demoting && targets.some((t) => t.roleSource === "owner")) {
    return res.status(400).json({ error: "The configured owner cannot be demoted" });
  }

  // Every account this person can sign in with gets the same role, so removing
  // access actually removes it.
  const updated = await db.transaction(async (tx) => {
    const rows = [];
    for (const target of targets) {
      const roleSource =
        body.role == null
          ? target.roleSource
          : target.roleSource === "owner"
            ? "owner"
            : body.role === "admin"
              ? "owner_assigned"
              : "provisioned";
      const [row] = await tx
        .update(usersTable)
        .set({ ...body, roleSource })
        .where(eq(usersTable.id, target.id))
        .returning();
      if (row) rows.push(row);
    }
    return rows;
  });

  const user = updated.find((u) => u.id === id) ?? updated[0];
  return res.json(user);
});

router.get("/invitations", requireAuth, requireAdmin, async (_req, res) => {
  return res.json(await listInvitations());
});

router.post("/invitations", requireAuth, requireAdmin, async (req, res) => {
  const body = CreateInvitationBody.parse(req.body);
  const emailKey = normalizeEmailKey(body.email);
  if (!emailKey) return res.status(400).json({ error: "Email is required" });

  // An invitation exists to grant a person who has never signed in a role in
  // advance; someone who already has a verified account is edited on the
  // Team page instead, so their access change is a deliberate act there.
  const existingUser = await findUserByEmailKey(emailKey);
  if (existingUser) {
    return res.status(400).json({
      error: "This person already has an account — edit their role on the Team page instead.",
    });
  }

  const invitation = await upsertInvitation({
    email: emailKey,
    role: body.role ?? "contractor",
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
  return res.status(201).json(stamped ?? invitation);
});

router.post("/invitations/:id/resend", requireAuth, requireAdmin, async (req, res) => {
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

router.delete("/invitations/:id", requireAuth, requireAdmin, async (req, res) => {
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
