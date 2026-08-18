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
  const [user] = await db
    .update(usersTable)
    .set(body)
    .where(eq(usersTable.id, Number(req.params.id)))
    .returning();
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json(user);
});

export default router;
