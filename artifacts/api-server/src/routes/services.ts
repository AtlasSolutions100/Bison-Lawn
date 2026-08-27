import { Router, type IRouter } from "express";
import { db, servicesTable, packagesTable, estimateFieldsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  CreateServiceBody,
  UpdateServiceBody,
  CalculateServicePriceBody,
  CreatePackageBody,
  UpdatePackageBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { priceService, isPriceableFieldType } from "../lib/helpers";

const router: IRouter = Router();

router.use(["/services", "/packages"], requireAuth, requireAdmin);

/**
 * A null pricingFieldId means "turf square footage" and needs no lookup. A
 * non-null one must name a real, numeric field — otherwise the equations end
 * up evaluated against a field like Gate Code that has no number, silently
 * pricing as NaN. Thrown errors carry status 400 the same way estimates.ts's
 * validators do, so the route handlers below can turn them into a real message
 * instead of an opaque 500.
 */
async function assertPriceableField(pricingFieldId: number | null | undefined) {
  if (pricingFieldId == null) return;
  const [field] = await db.select().from(estimateFieldsTable).where(eq(estimateFieldsTable.id, pricingFieldId));
  if (!field) {
    throw Object.assign(new Error(`Estimate field ${pricingFieldId} not found`), { status: 400 });
  }
  if (!isPriceableFieldType(field.fieldType)) {
    throw Object.assign(
      new Error(`"${field.label}" is a ${field.fieldType} field and has no number to price against.`),
      { status: 400 },
    );
  }
}

/** Our own 400s carry a message; a schema failure would otherwise be an opaque 500. */
function serviceBadRequestMessage(error: unknown): string | null {
  if (error instanceof Error && (error as { status?: number }).status === 400) return error.message;
  return null;
}

router.get("/services", async (_req, res) => {
  return res.json(await db.select().from(servicesTable).orderBy(servicesTable.name));
});

router.post("/services", async (req, res) => {
  const body = CreateServiceBody.parse(req.body);
  try {
    await assertPriceableField(body.pricingFieldId);
  } catch (error) {
    const message = serviceBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  const [svc] = await db
    .insert(servicesTable)
    .values({ ...body, vendorName: body.vendorName?.trim() || null })
    .returning();
  return res.status(201).json(svc);
});

router.get("/services/:id", async (req, res) => {
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, Number(req.params.id)));
  if (!svc) return res.status(404).json({ error: "Service not found" });
  return res.json(svc);
});

router.patch("/services/:id", async (req, res) => {
  const body = UpdateServiceBody.parse(req.body);
  try {
    await assertPriceableField(body.pricingFieldId);
  } catch (error) {
    const message = serviceBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  const values = {
    ...body,
    ...(body.vendorName !== undefined ? { vendorName: body.vendorName?.trim() || null } : {}),
  };
  const [svc] = await db
    .update(servicesTable)
    .set(values)
    .where(eq(servicesTable.id, Number(req.params.id)))
    .returning();
  if (!svc) return res.status(404).json({ error: "Service not found" });
  return res.json(svc);
});

router.delete("/services/:id", async (req, res) => {
  await db.delete(servicesTable).where(eq(servicesTable.id, Number(req.params.id)));
  return res.status(204).end();
});

router.post("/services/:id/price", async (req, res) => {
  const body = CalculateServicePriceBody.parse(req.body);
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, Number(req.params.id)));
  if (!svc) return res.status(404).json({ error: "Service not found" });
  // The request/response body shape (`sqft`) predates per-field pricing and is
  // fixed by the OpenAPI spec, but the number it carries is whatever unit
  // svc.pricingFieldId designates now — echo the resolved field back so a
  // caller (the Services admin screen's live tester) can label the number
  // correctly instead of assuming square footage.
  const [field] = svc.pricingFieldId != null
    ? await db.select().from(estimateFieldsTable).where(eq(estimateFieldsTable.id, svc.pricingFieldId))
    : [];
  let result: ReturnType<typeof priceService>;
  try {
    result = priceService(svc, field ?? null, body.sqft);
  } catch (error) {
    const message = serviceBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  return res.json({
    price: result.price,
    sqft: body.sqft,
    equationIndex: result.equationIndex,
    pricingFieldId: field?.id ?? null,
    pricingFieldLabel: field?.label ?? null,
  });
});

// ---- packages ----

async function withServices(pkg: typeof packagesTable.$inferSelect) {
  const services = pkg.serviceIds.length
    ? await db.select().from(servicesTable).where(inArray(servicesTable.id, pkg.serviceIds))
    : [];
  return { ...pkg, services };
}

router.get("/packages", async (_req, res) => {
  const pkgs = await db.select().from(packagesTable).orderBy(packagesTable.name);
  return res.json(await Promise.all(pkgs.map(withServices)));
});

router.post("/packages", async (req, res) => {
  const body = CreatePackageBody.parse(req.body);
  const [pkg] = await db.insert(packagesTable).values({
    name: body.name,
    description: body.description,
    serviceIds: body.serviceIds,
    scheduleType: body.scheduleType,
    startDate: body.startDate,
    endDate: body.endDate,
    frequencyWeeks: body.frequencyWeeks,
    seasonEndDate: body.seasonEndDate,
    renewDate: body.renewDate,
  }).returning();
  return res.status(201).json(await withServices(pkg));
});

router.patch("/packages/:id", async (req, res) => {
  const body = UpdatePackageBody.parse(req.body);
  const [pkg] = await db
    .update(packagesTable)
    .set({
      name: body.name,
      description: body.description,
      serviceIds: body.serviceIds,
      scheduleType: body.scheduleType,
      startDate: body.startDate,
      endDate: body.endDate,
      frequencyWeeks: body.frequencyWeeks,
      seasonEndDate: body.seasonEndDate,
      renewDate: body.renewDate,
    })
    .where(eq(packagesTable.id, Number(req.params.id)))
    .returning();
  if (!pkg) return res.status(404).json({ error: "Package not found" });
  return res.json(await withServices(pkg));
});

router.delete("/packages/:id", async (req, res) => {
  await db.delete(packagesTable).where(eq(packagesTable.id, Number(req.params.id)));
  return res.status(204).end();
});

export default router;
