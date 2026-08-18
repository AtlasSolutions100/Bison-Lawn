import { Router, type IRouter } from "express";
import {
  db,
  clientsTable,
  clientNotesTable,
  auditEventsTable,
  clientServicesTable,
  servicesTable,
  packagesTable,
  jobsTable,
} from "@workspace/db";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import {
  CreateClientBody,
  UpdateClientBody,
  CreateClientNoteBody,
  CreateClientServiceBody,
  UpdateClientServiceBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, calculatePrice } from "../lib/helpers";

const router: IRouter = Router();

router.use(requireAuth, requireAdmin);

router.get("/clients", async (req, res) => {
  const { status, search } = req.query as { status?: string; search?: string };
  const conds = [];
  if (status) conds.push(eq(clientsTable.status, status));
  if (search)
    conds.push(
      or(
        ilike(clientsTable.name, `%${search}%`),
        ilike(clientsTable.serviceAddress, `%${search}%`),
        ilike(clientsTable.city, `%${search}%`),
        ilike(clientsTable.email, `%${search}%`),
        ilike(clientsTable.phone, `%${search}%`),
      ),
    );
  const rows = await db
    .select()
    .from(clientsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(clientsTable.name);
  return res.json(rows);
});

router.post("/clients", async (req, res) => {
  const body = CreateClientBody.parse(req.body);
  const [client] = await db.insert(clientsTable).values(body).returning();
  await logAudit({
    clientId: client.id,
    actorName: req.appUser?.name,
    action: "client_created",
    description: `Created ${client.status === "lead" ? "lead" : "client"} "${client.name}"`,
  });
  return res.status(201).json(client);
});

router.get("/clients/:id", async (req, res) => {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, Number(req.params.id)));
  if (!client) return res.status(404).json({ error: "Client not found" });
  return res.json(client);
});

router.patch("/clients/:id", async (req, res) => {
  const body = UpdateClientBody.parse(req.body);
  const [client] = await db
    .update(clientsTable)
    .set(body)
    .where(eq(clientsTable.id, Number(req.params.id)))
    .returning();
  if (!client) return res.status(404).json({ error: "Client not found" });
  const changed = Object.keys(body).join(", ");
  await logAudit({
    clientId: client.id,
    actorName: req.appUser?.name,
    action: "client_updated",
    description: `Updated ${changed || "client"}`,
  });
  return res.json(client);
});

router.delete("/clients/:id", async (req, res) => {
  await db.delete(clientsTable).where(eq(clientsTable.id, Number(req.params.id)));
  return res.status(204).end();
});

router.get("/clients/:id/notes", async (req, res) => {
  const rows = await db
    .select()
    .from(clientNotesTable)
    .where(eq(clientNotesTable.clientId, Number(req.params.id)))
    .orderBy(desc(clientNotesTable.createdAt));
  return res.json(rows);
});

router.post("/clients/:id/notes", async (req, res) => {
  const body = CreateClientNoteBody.parse(req.body);
  const clientId = Number(req.params.id);
  const [note] = await db
    .insert(clientNotesTable)
    .values({ clientId, body: body.body, authorName: req.appUser?.name ?? null })
    .returning();
  await logAudit({
    clientId,
    actorName: req.appUser?.name,
    action: "note_added",
    description: "Added a note",
  });
  return res.status(201).json(note);
});

router.get("/clients/:id/audit", async (req, res) => {
  const clientId = Number(req.params.id);
  const rows = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.clientId, clientId))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(200);
  return res.json(rows.map((r) => ({ ...r, clientName: null })));
});

// ---- client services ----

async function clientServiceWithName(cs: typeof clientServicesTable.$inferSelect) {
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, cs.serviceId));
  let packageName: string | null = null;
  if (cs.packageId) {
    const [p] = await db.select().from(packagesTable).where(eq(packagesTable.id, cs.packageId));
    packageName = p?.name ?? null;
  }
  return { ...cs, serviceName: svc?.name ?? null, packageName };
}

router.get("/clients/:id/client-services", async (req, res) => {
  const rows = await db
    .select()
    .from(clientServicesTable)
    .where(eq(clientServicesTable.clientId, Number(req.params.id)));
  return res.json(await Promise.all(rows.map(clientServiceWithName)));
});

/** Create jobs for a client-service based on its schedule type. */
async function generateJobs(cs: typeof clientServicesTable.$inferSelect) {
  if (cs.scheduleType === "window") {
    // Waiting list entry: not dispatched, has a window
    await db.insert(jobsTable).values({
      clientId: cs.clientId,
      clientServiceId: cs.id,
      serviceId: cs.serviceId,
      dispatched: false,
      windowStart: cs.startDate,
      windowEnd: cs.endDate,
      amount: cs.amount,
      budgetedHours: cs.budgetedHours,
    });
  } else if (cs.scheduleType === "recurring" && cs.firstServiceDate && cs.frequencyWeeks) {
    // Generate occurrences straight to the dispatch board until season end (cap 60)
    const end = cs.seasonEndDate ? new Date(cs.seasonEndDate) : null;
    let d = new Date(cs.firstServiceDate);
    let count = 0;
    while (count < 60 && (!end || d <= end)) {
      await db.insert(jobsTable).values({
        clientId: cs.clientId,
        clientServiceId: cs.id,
        serviceId: cs.serviceId,
        dispatched: true,
        scheduledDate: d.toISOString().slice(0, 10),
        amount: cs.amount,
        budgetedHours: cs.budgetedHours,
      });
      d = new Date(d.getTime() + cs.frequencyWeeks * 7 * 24 * 3600 * 1000);
      count++;
      if (!end && count >= 1) break; // no season end: only create the first occurrence
    }
  } else {
    // one_time
    await db.insert(jobsTable).values({
      clientId: cs.clientId,
      clientServiceId: cs.id,
      serviceId: cs.serviceId,
      dispatched: !!cs.firstServiceDate,
      scheduledDate: cs.firstServiceDate,
      amount: cs.amount,
      budgetedHours: cs.budgetedHours,
    });
  }
}

router.post("/clients/:id/client-services", async (req, res) => {
  const body = CreateClientServiceBody.parse(req.body);
  const clientId = Number(req.params.id);

  let serviceIds: number[] = [];
  if (body.packageId) {
    const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, body.packageId));
    if (!pkg) return res.status(404).json({ error: "Package not found" });
    serviceIds = pkg.serviceIds;
  } else if (body.serviceId) {
    serviceIds = [body.serviceId];
  } else {
    return res.status(400).json({ error: "serviceId or packageId is required" });
  }

  const created = [];
  for (const serviceId of serviceIds) {
    const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, serviceId));
    if (!svc) continue;
    let amount = body.amount ?? null;
    if (amount == null) {
      if (body.sqft != null && svc.pricingEquations.length > 0) {
        amount = calculatePrice(svc.pricingEquations, body.sqft).price;
      } else {
        amount = svc.rate * (body.quantity ?? svc.quantity ?? 1);
      }
    }
    const [cs] = await db
      .insert(clientServicesTable)
      .values({
        clientId,
        serviceId,
        packageId: body.packageId ?? null,
        quantity: body.quantity ?? 1,
        amount,
        scheduleType: body.scheduleType,
        startDate: body.startDate ?? null,
        endDate: body.endDate ?? null,
        frequencyWeeks: body.frequencyWeeks ?? null,
        firstServiceDate: body.firstServiceDate ?? null,
        seasonEndDate: body.seasonEndDate ?? null,
        renewDate: body.renewDate ?? null,
        budgetedHours: body.budgetedHours ?? svc.billableHours ?? null,
      })
      .returning();
    await generateJobs(cs);
    await logAudit({
      clientId,
      actorName: req.appUser?.name,
      action: "service_assigned",
      description: `Assigned service "${svc.name}" ($${amount})`,
    });
    created.push(await clientServiceWithName(cs));
  }
  return res.status(201).json(created);
});

router.patch("/client-services/:id", async (req, res) => {
  const body = UpdateClientServiceBody.parse(req.body);
  const [cs] = await db
    .update(clientServicesTable)
    .set(body)
    .where(eq(clientServicesTable.id, Number(req.params.id)))
    .returning();
  if (!cs) return res.status(404).json({ error: "Client service not found" });
  return res.json(await clientServiceWithName(cs));
});

router.delete("/client-services/:id", async (req, res) => {
  const id = Number(req.params.id);
  // remove not-yet-completed jobs tied to this client-service
  await db
    .delete(jobsTable)
    .where(and(eq(jobsTable.clientServiceId, id), eq(jobsTable.status, "scheduled")));
  await db.delete(clientServicesTable).where(eq(clientServicesTable.id, id));
  return res.status(204).end();
});

export default router;
