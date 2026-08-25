import { Router, type IRouter } from "express";
import { db, servicesTable, packagesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  CreateServiceBody,
  UpdateServiceBody,
  CalculateServicePriceBody,
  CreatePackageBody,
  UpdatePackageBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { calculatePrice } from "../lib/helpers";

const router: IRouter = Router();

router.use(["/services", "/packages"], requireAuth, requireAdmin);

router.get("/services", async (_req, res) => {
  return res.json(await db.select().from(servicesTable).orderBy(servicesTable.name));
});

router.post("/services", async (req, res) => {
  const body = CreateServiceBody.parse(req.body);
  const [svc] = await db.insert(servicesTable).values(body).returning();
  return res.status(201).json(svc);
});

router.get("/services/:id", async (req, res) => {
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, Number(req.params.id)));
  if (!svc) return res.status(404).json({ error: "Service not found" });
  return res.json(svc);
});

router.patch("/services/:id", async (req, res) => {
  const body = UpdateServiceBody.parse(req.body);
  const [svc] = await db
    .update(servicesTable)
    .set(body)
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
  const result = calculatePrice(svc.pricingEquations, body.sqft);
  return res.json({ price: result.price, sqft: body.sqft, equationIndex: result.equationIndex });
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
