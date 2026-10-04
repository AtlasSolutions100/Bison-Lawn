import { Router, type IRouter } from "express";
import { db, chargePresetsTable, jobsTable, jobProductsTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import {
  CreateProductPresetBody,
  UpdateProductPresetBody,
  AddMyJobProductBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, roundMoney } from "../lib/helpers";
import { ensureProductPresetsOnce } from "../lib/settingsSeeds";

/**
 * Parts and fees on a job: the bag fee, the sprinkler parts.
 *
 * The office keeps a short list of presets (charge_presets rows with kind
 * 'product'); the contractor picks one on the job card, types how many, and
 * the line lands on the invoice when the job completes. Prices are copied
 * onto the job when the line is added, so a later price change never
 * rewrites a visit that already happened.
 */
const router: IRouter = Router();

router.use("/product-presets", requireAuth, requireAdmin);

function presetOut(p: typeof chargePresetsTable.$inferSelect) {
  return {
    id: p.id,
    label: p.label,
    defaultPrice: p.defaultPrice,
    kind: p.kind,
    unit: p.unit,
    contractorCanAdd: p.contractorCanAdd,
    sortOrder: p.sortOrder,
  };
}

router.get("/product-presets", async (_req, res) => {
  // His own examples — "Small bags, pinecones, beagle to add to with sprinkler
  // parts" — are on the list the first time he opens it, at $0 until he sets
  // the prices. Once, ever: deleting one must not bring it back on a restart.
  await ensureProductPresetsOnce();
  const rows = await db
    .select()
    .from(chargePresetsTable)
    .where(eq(chargePresetsTable.kind, "product"))
    .orderBy(asc(chargePresetsTable.sortOrder), asc(chargePresetsTable.label), asc(chargePresetsTable.id));
  return res.json(rows.map(presetOut));
});

router.post("/product-presets", async (req, res) => {
  const body = CreateProductPresetBody.parse(req.body);
  const label = body.label.trim();
  if (!label) return res.status(400).json({ error: "A part needs a name" });
  if (body.defaultPrice < 0) return res.status(400).json({ error: "A part's price cannot be negative" });
  const [preset] = await db
    .insert(chargePresetsTable)
    .values({
      label,
      defaultPrice: roundMoney(body.defaultPrice),
      kind: "product",
      unit: body.unit?.trim() || null,
      contractorCanAdd: body.contractorCanAdd ?? true,
      sortOrder: body.sortOrder ?? null,
    })
    .returning();
  await logAudit({
    actorName: req.appUser?.name,
    action: "product_preset_created",
    description: `Added part/fee "${label}" at $${preset.defaultPrice}${preset.unit ? ` per ${preset.unit}` : ""}${preset.contractorCanAdd ? ", contractors may add it" : ""}`,
  });
  return res.status(201).json(presetOut(preset));
});

router.patch("/product-presets/:id", async (req, res) => {
  const body = UpdateProductPresetBody.parse(req.body);
  const id = Number(req.params.id);
  const [existing] = await db
    .select()
    .from(chargePresetsTable)
    .where(and(eq(chargePresetsTable.id, id), eq(chargePresetsTable.kind, "product")));
  if (!existing) return res.status(404).json({ error: "Part not found" });
  if (body.label !== undefined && !body.label.trim()) return res.status(400).json({ error: "A part needs a name" });
  if (body.defaultPrice !== undefined && body.defaultPrice < 0) {
    return res.status(400).json({ error: "A part's price cannot be negative" });
  }
  const [preset] = await db
    .update(chargePresetsTable)
    .set({
      ...(body.label !== undefined ? { label: body.label.trim() } : {}),
      ...(body.defaultPrice !== undefined ? { defaultPrice: roundMoney(body.defaultPrice) } : {}),
      ...(body.unit !== undefined ? { unit: body.unit?.trim() || null } : {}),
      ...(body.contractorCanAdd !== undefined ? { contractorCanAdd: body.contractorCanAdd } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
    })
    .where(eq(chargePresetsTable.id, id))
    .returning();
  await logAudit({
    actorName: req.appUser?.name,
    action: "product_preset_updated",
    description: `Changed part/fee "${preset.label}" (now $${preset.defaultPrice}${preset.contractorCanAdd ? ", contractors may add it" : ", office only"})`,
  });
  return res.json(presetOut(preset));
});

router.delete("/product-presets/:id", async (req, res) => {
  const id = Number(req.params.id);
  // Job lines keep their own copy of the name and price, so nothing already
  // billed changes.
  const [gone] = await db
    .delete(chargePresetsTable)
    .where(and(eq(chargePresetsTable.id, id), eq(chargePresetsTable.kind, "product")))
    .returning();
  if (gone) {
    await logAudit({
      actorName: req.appUser?.name,
      action: "product_preset_deleted",
      description: `Removed part/fee "${gone.label}" from the list`,
    });
  }
  return res.status(204).end();
});

// ---- contractor side ----

/** The parts the office lets the crew add on their own. */
router.get("/my/products", requireAuth, async (_req, res) => {
  // Seeded here too, not only on the office screen: the crew member on a
  // clean up is as likely to be the first person to open the list as he is,
  // and an empty list on site is the one place he cannot fix it from.
  await ensureProductPresetsOnce();
  const rows = await db
    .select()
    .from(chargePresetsTable)
    .where(and(eq(chargePresetsTable.kind, "product"), eq(chargePresetsTable.contractorCanAdd, true)))
    .orderBy(asc(chargePresetsTable.sortOrder), asc(chargePresetsTable.label));
  return res.json(rows.map((p) => ({ id: p.id, label: p.label, price: p.defaultPrice, unit: p.unit })));
});

/**
 * Same shape as adding extra work: the contractor may only touch a job that is
 * theirs, dispatched and visible, and never one that is already invoiced.
 */
router.post("/my/jobs/:id/products", requireAuth, async (req, res) => {
  const body = AddMyJobProductBody.parse(req.body);
  const jobId = Number(req.params.id);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) return res.status(404).json({ error: "Job not found" });
  const isAdmin = req.appUser?.role === "admin";
  if (!isAdmin && !(job.assignedToId === req.appUser?.id && job.dispatched && job.visibleToContractor)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const [preset] = await db
    .select()
    .from(chargePresetsTable)
    .where(and(eq(chargePresetsTable.id, body.presetId), eq(chargePresetsTable.kind, "product")));
  if (!preset || (!isAdmin && !preset.contractorCanAdd)) {
    return res.status(400).json({ error: "That part is not on the list you can add on site" });
  }
  const quantity = body.quantity ?? 1;
  if (!(quantity > 0)) return res.status(400).json({ error: "Quantity must be more than zero" });

  // Lock the job so a concurrent completion can't invoice while we add the part.
  const product = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!locked || locked.status === "completed") return null;
    const [p] = await tx
      .insert(jobProductsTable)
      .values({ jobId, chargePresetId: preset.id, name: preset.label, price: preset.defaultPrice, quantity })
      .returning();
    return p;
  });
  if (!product) {
    return res.status(400).json({ error: "Job is completed and invoiced; parts can no longer be added" });
  }
  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "product_added",
    description: `Added ${quantity} × "${preset.label}" ($${preset.defaultPrice}${preset.unit ? ` per ${preset.unit}` : " each"}) to job #${jobId} — $${roundMoney(quantity * preset.defaultPrice)} on the invoice`,
  });
  return res.status(201).json(product);
});

export default router;
