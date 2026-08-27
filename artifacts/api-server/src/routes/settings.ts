import { Router, type IRouter } from "express";
import { db, companyProfileTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateCompanyProfileBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { supportedTokens } from "../lib/mergeTokens";
import { getCompanyProfile } from "../lib/companyProfile";

const router: IRouter = Router();

router.use(["/company-profile", "/merge-tokens"], requireAuth, requireAdmin);

router.get("/company-profile", async (_req, res) => {
  return res.json(await getCompanyProfile());
});

router.put("/company-profile", async (req, res) => {
  const body = UpdateCompanyProfileBody.parse(req.body);
  const current = await getCompanyProfile();
  const [row] = await db
    .update(companyProfileTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(companyProfileTable.id, current.id))
    .returning();
  return res.json(row);
});

/**
 * The token list is served rather than duplicated in the front end: the
 * renderer is the only thing that knows what it can actually fill, and a
 * hand-maintained list in the UI drifts from it silently — the office would be
 * shown a token that renders as literal text in a customer's letter.
 */
router.get("/merge-tokens", async (_req, res) => {
  return res.json(supportedTokens());
});

export default router;
