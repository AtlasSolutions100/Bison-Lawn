import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { UpdateUserBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import {
  dedupeUsersByPerson,
  mergeAccountsForEmail,
  normalizeEmailKey,
} from "../lib/userAccounts";

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

export default router;
