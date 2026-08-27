import { Router, type IRouter } from "express";
import { db, feedbackTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { CreateFeedbackBody, ListFeedbackQueryParams, UpdateFeedbackBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { notifyFeedback } from "../lib/feedbackNotification";

const router: IRouter = Router();

/**
 * Submitting is open to any signed-in user, reading is admin-only.
 *
 * Contractors are the people most likely to notice that something on the job
 * board is wrong, and requiring them to email the office is exactly the friction
 * that means it never gets reported. They must not be able to read what everyone
 * else submitted, though — feedback routinely names other people.
 */
router.post("/feedback", requireAuth, async (req, res) => {
  const body = CreateFeedbackBody.parse(req.body);
  const user = req.appUser!;

  const [row] = await db
    .insert(feedbackTable)
    .values({
      userId: user.id,
      // Copied by value: this has to stay readable after the person leaves and
      // their user row is removed.
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      // Trusted from the client because only the client knows which screen the
      // person was looking at. It is a hint for reproduction, never a security
      // boundary, so a wrong value costs nothing.
      page: body.page ?? null,
      category: body.category ?? "idea",
      message: body.message.trim(),
    })
    .returning();

  // Not awaited: the person who typed this has already been told it was
  // received, and the row is safely stored and visible on /feedback regardless.
  // Blocking the response on Gmail would make submitting feel slow and could
  // fail a request whose real work already succeeded. notifyFeedback never
  // throws, so there is no unhandled rejection to catch here.
  void notifyFeedback(row);

  return res.status(201).json(row);
});

router.get("/feedback", requireAuth, requireAdmin, async (req, res) => {
  const query = ListFeedbackQueryParams.parse(req.query);
  const rows = await db
    .select()
    .from(feedbackTable)
    .where(query.status ? eq(feedbackTable.status, query.status) : undefined)
    .orderBy(desc(feedbackTable.createdAt));
  return res.json(rows);
});

router.patch("/feedback/:id", requireAuth, requireAdmin, async (req, res) => {
  const body = UpdateFeedbackBody.parse(req.body);
  const id = Number(req.params.id);
  const [row] = await db
    .update(feedbackTable)
    .set(body)
    .where(eq(feedbackTable.id, id))
    .returning();
  if (!row) return res.status(404).json({ error: "Feedback not found" });
  return res.json(row);
});

export default router;
