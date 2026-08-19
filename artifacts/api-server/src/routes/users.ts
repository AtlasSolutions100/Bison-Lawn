import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateUserBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/me", requireAuth, (req, res) => {
  return res.json(req.appUser);
});

router.get("/users", requireAuth, async (req, res) => {
  const users = await db.select().from(usersTable).orderBy(usersTable.name);
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
  if (existing.roleSource === "owner" && body.role && body.role !== "admin") {
    return res.status(400).json({ error: "The configured owner cannot be demoted" });
  }
  const roleSource =
    body.role == null
      ? existing.roleSource
      : existing.roleSource === "owner"
        ? "owner"
        : body.role === "admin"
          ? "owner_assigned"
          : "provisioned";
  const [user] = await db
    .update(usersTable)
    .set({ ...body, roleSource })
    .where(eq(usersTable.id, id))
    .returning();
  return res.json(user);
});

export default router;
