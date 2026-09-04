import { Router, type IRouter } from "express";
import { db, servicesTable, packagesTable, estimateFieldsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  CreateServiceBody,
  UpdateServiceBody,
  CalculateServicePriceBody,
  CreatePackageBody,
  UpdatePackageBody,
  BulkAdjustServicePricesBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { priceService, isPriceableFieldType, logAudit, roundMoney } from "../lib/helpers";

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
  const serviceId = Number(req.params.id);
  // Deleting the service and cleaning the packages that list it must be one
  // transaction: nothing else removes the id, because `packages.service_ids` is
  // jsonb with no foreign key to cascade. Left behind, the package keeps
  // claiming a service that is gone — two of Adam's packages were already in
  // that state, one of them ("Full Season Care") listing two services with
  // neither still existing.
  await db.transaction(async (tx) => {
    await tx.delete(servicesTable).where(eq(servicesTable.id, serviceId));
    const pkgs = await tx.select().from(packagesTable);
    for (const pkg of pkgs) {
      if (!pkg.serviceIds.includes(serviceId)) continue;
      await tx
        .update(packagesTable)
        .set({ serviceIds: pkg.serviceIds.filter((id) => id !== serviceId) })
        .where(eq(packagesTable.id, pkg.id));
    }
  });
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

/**
 * Applies a percent/fixed adjustment (then an optional round-to-increment) to
 * one money amount, never letting it go negative — a big enough discount
 * shouldn't be able to invent a service that pays the customer.
 */
function adjustAmount(amount: number, mode: "percent" | "fixed", adjustAmountBy: number, roundTo: number | null | undefined) {
  let next = mode === "percent" ? amount * (1 + adjustAmountBy / 100) : amount + adjustAmountBy;
  if (roundTo && roundTo > 0) next = Math.round(next / roundTo) * roundTo;
  return roundMoney(Math.max(0, next));
}

// A service priced by equations ignores `rate` entirely (see priceService in
// lib/helpers.ts), so a seasonal repricing that only touched `rate` would
// silently do nothing for exactly the services that matter most. basePrice and
// incrementPrice are money; baseSqft/incrementSqft/upToSqft are measurements
// (or, for upToSqft, a measurement threshold) and must not be touched.
router.post("/services/bulk-price-adjust", async (req, res) => {
  const body = BulkAdjustServicePricesBody.parse(req.body);
  const apply = body.apply === true;

  const services = body.serviceIds?.length
    ? await db.select().from(servicesTable).where(inArray(servicesTable.id, body.serviceIds))
    : await db.select().from(servicesTable);

  const changes = services.map((service) => {
    const newRate = adjustAmount(service.rate, body.mode, body.amount, body.roundTo);
    const newEquations = service.pricingEquations.map((equation) => ({
      ...equation,
      basePrice: adjustAmount(equation.basePrice, body.mode, body.amount, body.roundTo),
      incrementPrice: adjustAmount(equation.incrementPrice, body.mode, body.amount, body.roundTo),
    }));
    // A single before/after figure for the change list: the rate for a flat
    // service, or the first equation's base price for an equation-priced one
    // (what a customer with the base quantity actually pays), so equation-only
    // services still show a meaningful number instead of a flat 0 -> 0.
    const from = service.pricingEquations.length ? service.pricingEquations[0].basePrice : service.rate;
    const to = newEquations.length ? newEquations[0].basePrice : newRate;
    return { service, newRate, newEquations, from, to };
  });

  if (apply) {
    for (const change of changes) {
      await db
        .update(servicesTable)
        .set({ rate: change.newRate, pricingEquations: change.newEquations })
        .where(eq(servicesTable.id, change.service.id));
    }
    await logAudit({
      action: "services_bulk_price_adjusted",
      description: `${body.mode === "percent" ? `${body.amount}%` : `$${body.amount}`} adjustment applied to ${changes.length} service${changes.length === 1 ? "" : "s"}${body.roundTo ? `, rounded to $${body.roundTo}` : ""}`,
      actorName: req.appUser?.name,
    });
  }

  return res.json({
    applied: apply,
    changes: changes.map(({ service, from, to }) => ({
      serviceId: service.id,
      serviceName: service.name,
      from,
      to,
    })),
  });
});

// ---- packages ----

async function withServices(pkg: typeof packagesTable.$inferSelect) {
  const found = pkg.serviceIds.length
    ? await db.select().from(servicesTable).where(inArray(servicesTable.id, pkg.serviceIds))
    : [];
  const byId = new Map(found.map((s) => [s.id, s]));
  // `service_ids` is a plain jsonb array with no foreign key, so deleting a
  // service used to leave its id sitting in every package that referenced it.
  // The package then went on claiming a service that no longer existed —
  // reported as "Sprinkler Package says price 5 services but only should be 3".
  // Deleting now cleans up after itself, but rows that already carry a dangling
  // id have to report honestly too, so resolve the ids and return what is
  // actually there. Order is the author's, which `inArray` does not preserve.
  const services = pkg.serviceIds
    .map((id) => byId.get(id))
    .filter((s): s is NonNullable<typeof s> => s != null);
  return { ...pkg, serviceIds: services.map((s) => s.id), services };
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
