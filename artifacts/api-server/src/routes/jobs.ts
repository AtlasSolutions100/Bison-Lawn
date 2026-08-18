import { Router, type IRouter } from "express";
import {
  db,
  jobsTable,
  jobProductsTable,
  clientsTable,
  servicesTable,
  usersTable,
  invoicesTable,
} from "@workspace/db";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  CreateJobBody,
  UpdateJobBody,
  DispatchJobsBody,
  AddJobProductBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, recalcClientBalance, optimizeRoute, haversineKm } from "../lib/helpers";

const router: IRouter = Router();

router.use(requireAuth);

type JobRow = typeof jobsTable.$inferSelect;

async function hydrateJobs(rows: JobRow[]) {
  if (rows.length === 0) return [];
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const serviceIds = [...new Set(rows.map((r) => r.serviceId).filter((x): x is number => x != null))];
  const userIds = [...new Set(rows.map((r) => r.assignedToId).filter((x): x is number => x != null))];
  const jobIds = rows.map((r) => r.id);

  const [clients, services, users, products] = await Promise.all([
    db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds)),
    serviceIds.length ? db.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds)) : Promise.resolve([]),
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : Promise.resolve([]),
    db.select().from(jobProductsTable).where(inArray(jobProductsTable.jobId, jobIds)),
  ]);

  const cMap = new Map(clients.map((c) => [c.id, c]));
  const sMap = new Map(services.map((s) => [s.id, s]));
  const uMap = new Map(users.map((u) => [u.id, u]));

  return rows.map((r) => {
    const c = cMap.get(r.clientId);
    return {
      ...r,
      clientName: c?.name ?? null,
      clientAddress: c?.serviceAddress ?? null,
      clientBalance: c?.accountBalance ?? null,
      clientLat: c?.lat ?? null,
      clientLng: c?.lng ?? null,
      city: c?.city ?? null,
      lastServiceDate: c?.lastServiceDate ?? null,
      mapNote: r.mapNote ?? c?.mapNote ?? null,
      serviceName: r.serviceId ? (sMap.get(r.serviceId)?.name ?? null) : null,
      assignedToName: r.assignedToId ? (uMap.get(r.assignedToId)?.name ?? null) : null,
      products: products.filter((p) => p.jobId === r.id),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    };
  });
}

router.get("/waiting-list", requireAdmin, async (req, res) => {
  const { date, from, to } = req.query as Record<string, string | undefined>;
  const conds = [eq(jobsTable.dispatched, false)];
  if (date) {
    conds.push(lte(jobsTable.windowStart, date), gte(jobsTable.windowEnd, date));
  }
  if (from) conds.push(gte(jobsTable.windowEnd, from));
  if (to) conds.push(lte(jobsTable.windowStart, to));
  const rows = await db.select().from(jobsTable).where(and(...conds)).orderBy(asc(jobsTable.windowStart));
  return res.json(await hydrateJobs(rows));
});

router.get("/jobs", requireAdmin, async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const conds = [eq(jobsTable.dispatched, true)];
  if (q.date) conds.push(eq(jobsTable.scheduledDate, q.date));
  if (q.from) conds.push(gte(jobsTable.scheduledDate, q.from));
  if (q.to) conds.push(lte(jobsTable.scheduledDate, q.to));
  if (q.assignedTo) conds.push(eq(jobsTable.assignedToId, Number(q.assignedTo)));
  if (q.status) conds.push(eq(jobsTable.status, q.status));
  if (q.serviceId) conds.push(eq(jobsTable.serviceId, Number(q.serviceId)));
  if (q.clientId) conds.push(eq(jobsTable.clientId, Number(q.clientId)));
  let rows = await db
    .select()
    .from(jobsTable)
    .where(and(...conds))
    .orderBy(asc(jobsTable.routeOrder), asc(jobsTable.id));
  let hydrated = await hydrateJobs(rows);
  if (q.city) hydrated = hydrated.filter((j) => j.city?.toLowerCase() === q.city!.toLowerCase());
  return res.json(hydrated);
});

router.post("/jobs", requireAdmin, async (req, res) => {
  const body = CreateJobBody.parse(req.body);
  const dispatched = !!body.scheduledDate;
  const [job] = await db
    .insert(jobsTable)
    .values({ ...body, dispatched, notesImportant: body.notesImportant ?? false })
    .returning();
  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "job_created",
    description: `Created job #${job.id}${job.scheduledDate ? ` for ${job.scheduledDate}` : ""}`,
  });
  return res.status(201).json((await hydrateJobs([job]))[0]);
});

router.post("/jobs/dispatch", requireAdmin, async (req, res) => {
  const body = DispatchJobsBody.parse(req.body);
  if (body.jobIds.length === 0) return res.json([]);
  const set: Record<string, unknown> = { dispatched: true, scheduledDate: body.date };
  if (body.assignedToId != null) set.assignedToId = body.assignedToId;
  const rows = await db.update(jobsTable).set(set).where(inArray(jobsTable.id, body.jobIds)).returning();
  for (const j of rows) {
    await logAudit({
      clientId: j.clientId,
      actorName: req.appUser?.name,
      action: "job_dispatched",
      description: `Dispatched job #${j.id} to ${body.date}`,
    });
  }
  return res.json(await hydrateJobs(rows));
});

// contractor endpoints
router.get("/my/jobs", async (req, res) => {
  const { date, from, to } = req.query as Record<string, string | undefined>;
  const conds = [
    eq(jobsTable.assignedToId, req.appUser!.id),
    eq(jobsTable.dispatched, true),
    eq(jobsTable.visibleToContractor, true),
  ];
  if (date) conds.push(eq(jobsTable.scheduledDate, date));
  if (from) conds.push(gte(jobsTable.scheduledDate, from));
  if (to) conds.push(lte(jobsTable.scheduledDate, to));
  const rows = await db
    .select()
    .from(jobsTable)
    .where(and(...conds))
    .orderBy(asc(jobsTable.routeOrder), asc(jobsTable.id));
  return res.json(await hydrateJobs(rows));
});

router.get("/my/route", async (req, res) => {
  const date = String(req.query.date ?? "");
  if (!date) return res.status(400).json({ error: "date is required" });
  const user = req.appUser!;
  const rows = await db
    .select()
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.assignedToId, user.id),
        eq(jobsTable.dispatched, true),
        eq(jobsTable.scheduledDate, date),
        eq(jobsTable.visibleToContractor, true),
      ),
    );
  const jobs = await hydrateJobs(rows);

  const withCoords = jobs.filter((j) => j.clientLat != null && j.clientLng != null);
  const withoutCoords = jobs.filter((j) => j.clientLat == null || j.clientLng == null);

  let ordered = jobs;
  let totalDistanceKm = 0;
  if (user.baseLat != null && user.baseLng != null && withCoords.length > 0) {
    const base = { lat: user.baseLat, lng: user.baseLng };
    const pts = withCoords.map((j) => ({ lat: j.clientLat!, lng: j.clientLng! }));
    const order = optimizeRoute(base, pts);
    const orderedCoords = order.map((i) => withCoords[i]);
    ordered = [...orderedCoords, ...withoutCoords];
    let cur = base;
    for (const j of orderedCoords) {
      totalDistanceKm += haversineKm(cur.lat, cur.lng, j.clientLat!, j.clientLng!);
      cur = { lat: j.clientLat!, lng: j.clientLng! };
    }
  } else {
    ordered = [...jobs].sort((a, b) => (a.routeOrder ?? 0) - (b.routeOrder ?? 0));
  }

  return res.json({
    baseAddress: user.baseAddress ?? null,
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    stops: ordered.map((j, i) => ({
      order: i + 1,
      jobId: j.id,
      clientName: j.clientName,
      address: j.clientAddress,
      lat: j.clientLat,
      lng: j.clientLng,
    })),
  });
});

/**
 * Central contractor access predicate: contractors may only touch jobs that
 * are assigned to them, dispatched, and visible to contractors. Admins are
 * unrestricted.
 */
function canAccessJob(req: { appUser?: { id: number; role: string } }, job: JobRow): boolean {
  if (req.appUser?.role === "admin") return true;
  return (
    job.assignedToId === req.appUser?.id && job.dispatched === true && job.visibleToContractor === true
  );
}

router.get("/jobs/:id", async (req, res) => {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, Number(req.params.id)));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!canAccessJob(req, job)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return res.json((await hydrateJobs([job]))[0]);
});

router.patch("/jobs/:id", async (req, res) => {
  const body = UpdateJobBody.parse(req.body);
  if (body.status === "completed") {
    // Completion must go through POST /jobs/:id/complete so invoicing stays atomic
    return res.status(400).json({ error: "Use the complete endpoint to finish a job" });
  }
  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, Number(req.params.id)));
  if (!existing) return res.status(404).json({ error: "Job not found" });

  const isAdmin = req.appUser!.role === "admin";
  if (!isAdmin) {
    // contractors may only update the status of their own visible, dispatched jobs
    if (!canAccessJob(req, existing)) return res.status(403).json({ error: "Forbidden" });
    const keys = Object.keys(body);
    if (keys.some((k) => k !== "status")) {
      return res.status(403).json({ error: "Contractors can only update job status" });
    }
  }

  const [job] = await db
    .update(jobsTable)
    .set(body)
    .where(eq(jobsTable.id, Number(req.params.id)))
    .returning();
  if (body.status && body.status !== existing.status) {
    await logAudit({
      clientId: job.clientId,
      actorName: req.appUser?.name,
      action: "job_status",
      description: `Job #${job.id} status changed to ${body.status.replace(/_/g, " ")}`,
    });
  }
  return res.json((await hydrateJobs([job]))[0]);
});

router.delete("/jobs/:id", requireAdmin, async (req, res) => {
  await db.delete(jobsTable).where(eq(jobsTable.id, Number(req.params.id)));
  return res.status(204).end();
});

router.post("/jobs/:id/complete", async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Job not found" });
  if (!canAccessJob(req, existing)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (existing.status === "completed") {
    return res.json((await hydrateJobs([existing]))[0]);
  }

  // Atomic completion: lock the job row, re-check status, and create the
  // invoice inside one transaction so concurrent requests can't double-invoice.
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, id))
      .for("update");
    if (!locked) return null;
    if (locked.status === "completed") return { job: locked, invoice: null };

    const products = await tx.select().from(jobProductsTable).where(eq(jobProductsTable.jobId, id));
    const productTotal = products.reduce((s, p) => s + p.price * p.quantity, 0);
    const total = Math.round((locked.amount + productTotal) * 100) / 100;

    let serviceName: string | null = null;
    if (locked.serviceId) {
      const [svc] = await tx.select().from(servicesTable).where(eq(servicesTable.id, locked.serviceId));
      serviceName = svc?.name ?? null;
    }

    const [invoice] = await tx
      .insert(invoicesTable)
      .values({
        clientId: locked.clientId,
        jobId: id,
        total,
        notes: serviceName ? `Invoice for ${serviceName}` : null,
      })
      .returning();

    const today = new Date().toISOString().slice(0, 10);
    const [job] = await tx
      .update(jobsTable)
      .set({ status: "completed", completedAt: new Date(), invoiceId: invoice.id })
      .where(eq(jobsTable.id, id))
      .returning();

    await tx.update(clientsTable).set({ lastServiceDate: today }).where(eq(clientsTable.id, locked.clientId));
    return { job, invoice };
  });

  if (!result) return res.status(404).json({ error: "Job not found" });
  if (result.invoice) {
    await recalcClientBalance(result.job.clientId);
    await logAudit({
      clientId: result.job.clientId,
      actorName: req.appUser?.name,
      action: "job_completed",
      description: `Completed job #${id}; invoice #${result.invoice.id} for $${result.invoice.total}`,
    });
  }
  return res.json((await hydrateJobs([result.job]))[0]);
});

router.post("/jobs/:id/products", async (req, res) => {
  const body = AddJobProductBody.parse(req.body);
  const jobId = Number(req.params.id);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!canAccessJob(req, job)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (job.status === "completed") {
    return res.status(400).json({ error: "Job is completed and invoiced; products can no longer be changed" });
  }
  // Lock the job row and recheck status in the same transaction so a
  // concurrent completion can't invoice while we add a product.
  const product = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!locked || locked.status === "completed") return null;
    const [p] = await tx
      .insert(jobProductsTable)
      .values({ jobId, name: body.name, price: body.price, quantity: body.quantity ?? 1 })
      .returning();
    return p;
  });
  if (!product) {
    return res.status(400).json({ error: "Job is completed and invoiced; products can no longer be changed" });
  }
  return res.status(201).json(product);
});

router.delete("/job-products/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [product] = await db.select().from(jobProductsTable).where(eq(jobProductsTable.id, id));
  if (!product) return res.status(204).end();
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, product.jobId));
  if (!job) return res.status(204).end();
  if (!canAccessJob(req, job)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (job.status === "completed") {
    return res.status(400).json({ error: "Job is completed and invoiced; products can no longer be changed" });
  }
  const deleted = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, product.jobId)).for("update");
    if (!locked || locked.status === "completed") return false;
    await tx.delete(jobProductsTable).where(eq(jobProductsTable.id, id));
    return true;
  });
  if (!deleted) {
    return res.status(400).json({ error: "Job is completed and invoiced; products can no longer be changed" });
  }
  return res.status(204).end();
});

export default router;
