import { Router, type IRouter } from "express";
import {
  db,
  jobsTable,
  jobProductsTable,
  clientsTable,
  servicesTable,
  usersTable,
  invoicesTable,
  paymentsTable,
} from "@workspace/db";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  CreateJobBody,
  UpdateJobBody,
  DispatchJobsBody,
  AddJobProductBody,
  AddExtraWorkBody,
  RecordOnSitePaymentBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import {
  logAudit,
  recalcClientBalance,
  recalcInvoice,
  optimizeRoute,
  haversineKm,
  getBillingSettings,
} from "../lib/helpers";

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
      // Saved property details, keyed by field label — "Gate Code",
      // "Sprinkler Zones", "Turf Sqft". Reported by a sub: the gate code was on
      // the client page but not on his job card, so he had to ring the office
      // from the driveway. These are facts about the property the person
      // standing at it needs, and there is nothing financial in here, so the
      // whole map goes rather than a hand-picked list of labels — a new detail
      // Adam adds tomorrow should reach the crew without a code change.
      clientPropertyData: (c?.propertyData ?? {}) as Record<string, string>,
      serviceName: r.serviceId ? (sMap.get(r.serviceId)?.name ?? null) : null,
      assignedToName: r.assignedToId ? (uMap.get(r.assignedToId)?.name ?? null) : null,
      products: products.filter((p) => p.jobId === r.id),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      skippedAt: r.skippedAt ? r.skippedAt.toISOString() : null,
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
    )
    .orderBy(asc(jobsTable.routeOrder), asc(jobsTable.id));
  const jobs = await hydrateJobs(rows);

  const withCoords = jobs.filter((j) => j.clientLat != null && j.clientLng != null);
  const withoutCoords = jobs.filter((j) => j.clientLat == null || j.clientLng == null);

  const hasBase = user.baseLat != null && user.baseLng != null;
  const optimized = hasBase && withCoords.length > 0;

  let ordered = jobs;
  let totalDistanceKm = 0;
  // distance (km) from each ordered job with coordinates to the next stop; null when unknown
  const legKm = new Map<number, number>();
  if (optimized) {
    const base = { lat: user.baseLat!, lng: user.baseLng! };
    const pts = withCoords.map((j) => ({ lat: j.clientLat!, lng: j.clientLng! }));
    const order = optimizeRoute(base, pts);
    const orderedCoords = order.map((i) => withCoords[i]);
    ordered = [...orderedCoords, ...withoutCoords];
    let cur = base;
    let prevId: number | null = null; // base handled separately below
    for (const j of orderedCoords) {
      const d = haversineKm(cur.lat, cur.lng, j.clientLat!, j.clientLng!);
      totalDistanceKm += d;
      if (prevId === null) {
        legKm.set(-1, d); // leg from base to first job
      } else {
        legKm.set(prevId, d);
      }
      prevId = j.id;
      cur = { lat: j.clientLat!, lng: j.clientLng! };
    }
  } else {
    // deterministic dispatch order: routeOrder (nulls last), then id
    ordered = [...jobs].sort(
      (a, b) =>
        (a.routeOrder ?? Number.MAX_SAFE_INTEGER) - (b.routeOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.id - b.id,
    );
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const jobStops = ordered.map((j, i) => ({
    order: optimized ? i + 2 : i + 1,
    type: "job" as const,
    jobId: j.id,
    name: j.clientName ?? j.serviceName ?? `Job #${j.id}`,
    clientName: j.clientName ?? null,
    address: j.clientAddress ?? null,
    lat: j.clientLat ?? null,
    lng: j.clientLng ?? null,
    hasCoordinates: j.clientLat != null && j.clientLng != null,
    distanceToNextKm: legKm.has(j.id) ? round1(legKm.get(j.id)!) : null,
  }));

  const stops = optimized
    ? [
        {
          order: 1,
          type: "base" as const,
          jobId: null,
          name: "Home Base",
          clientName: null,
          address: user.baseAddress ?? null,
          lat: user.baseLat ?? null,
          lng: user.baseLng ?? null,
          hasCoordinates: true,
          distanceToNextKm: legKm.has(-1) ? round1(legKm.get(-1)!) : null,
        },
        ...jobStops,
      ]
    : jobStops;

  return res.json({
    baseAddress: user.baseAddress ?? null,
    totalDistanceKm: round1(totalDistanceKm),
    optimized,
    stops,
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

router.get("/my/offerable-services", async (_req, res) => {
  const rows = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.contractorOfferable, true))
    .orderBy(asc(servicesTable.name));
  return res.json(
    rows.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      price: s.contractorPrice ?? s.rate,
    })),
  );
});

router.post("/my/jobs/:id/extra-work", async (req, res) => {
  const body = AddExtraWorkBody.parse(req.body);
  const jobId = Number(req.params.id);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!canAccessJob(req, job)) return res.status(403).json({ error: "Forbidden" });

  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, body.serviceId));
  // Contractors may only add services the office has approved for field offers
  if (!svc || !svc.contractorOfferable) {
    return res.status(400).json({ error: "This service is not available to offer on site" });
  }
  const quantity = body.quantity ?? 1;
  const price = svc.contractorPrice ?? svc.rate;

  // Lock the job so a concurrent completion can't invoice while we add work
  const product = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!locked || locked.status === "completed") return null;
    const [p] = await tx
      .insert(jobProductsTable)
      .values({ jobId, serviceId: svc.id, name: svc.name, price, quantity })
      .returning();
    return p;
  });
  if (!product) {
    return res.status(400).json({ error: "Job is completed and invoiced; work can no longer be added" });
  }
  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "extra_work_added",
    description: `Added on-site extra work "${svc.name}" (${quantity} × $${price}) to job #${jobId}`,
  });
  return res.status(201).json(product);
});

router.post("/my/jobs/:id/payments", async (req, res) => {
  const body = RecordOnSitePaymentBody.parse(req.body);
  const jobId = Number(req.params.id);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) return res.status(404).json({ error: "Job not found" });
  // Contractors can only take payment for jobs assigned to them
  if (!canAccessJob(req, job)) return res.status(403).json({ error: "Forbidden" });

  const settings = await getBillingSettings();
  const applyFee = body.method === "credit_card" && settings.cardFeeEnabled && settings.cardFeePercent > 0;
  const baseAmount = Math.round(body.amount * 100) / 100;
  const cardFee = applyFee ? Math.round(baseAmount * settings.cardFeePercent) / 100 : 0;
  const total = Math.round((baseAmount + cardFee) * 100) / 100;

  const feeNote = applyFee
    ? `Includes $${cardFee.toFixed(2)} card processing fee (${settings.cardFeePercent}%).`
    : null;
  const notes = [body.notes, feeNote].filter(Boolean).join(" ") || null;

  // Lock the job row so payment recording serializes with completion: we either
  // see the completion invoice (and attach to it) or insert before completion
  // commits, in which case completion's own pass attaches this payment.
  const payment = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!locked) return null;
    // Attach to the job's invoice when it exists, belongs to the client, and isn't void
    let invoice: typeof invoicesTable.$inferSelect | null = null;
    if (locked.invoiceId != null) {
      // Locked, not just read: we are about to change its total and its paid
      // figure, and an office payment on the same invoice must not interleave.
      const [inv] = await tx
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, locked.invoiceId))
        .for("update");
      if (inv && inv.clientId === locked.clientId && inv.status !== "void") invoice = inv;
    }
    // The card surcharge is a real charge: add it to the invoice total so
    // amountPaid and the customer balance reconcile to the disclosed amount.
    if (invoice && cardFee > 0) {
      await tx
        .update(invoicesTable)
        .set({ total: Math.round((invoice.total + cardFee) * 100) / 100 })
        .where(eq(invoicesTable.id, invoice.id));
    }
    const [p] = await tx
      .insert(paymentsTable)
      .values({
        clientId: locked.clientId,
        invoiceId: invoice?.id ?? null,
        jobId,
        amount: total,
        cardFee,
        method: body.method,
        reference: body.reference ?? null,
        notes,
      })
      .returning();
    // Same transaction as the insert: the payment and every figure derived from
    // it must commit together, or a crash in between leaves the invoice and the
    // client balance permanently understating what the contractor collected.
    if (p.invoiceId) await recalcInvoice(p.invoiceId, tx);
    await recalcClientBalance(p.clientId, tx);
    return p;
  });
  if (!payment) return res.status(404).json({ error: "Job not found" });
  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "payment_recorded",
    description: `On-site payment of $${total} via ${body.method} for job #${jobId}${feeNote ? ` — ${feeNote}` : ""}`,
  });
  return res.status(201).json({
    ...payment,
    createdAt: payment.createdAt.toISOString(),
    baseAmount,
    cardFee,
    cardFeePercent: applyFee ? settings.cardFeePercent : null,
  });
});

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
    // skipReason travels with status: skipped since the contractor on site is the
    // one who knows why — but it must never become a general-purpose notes field.
    if (keys.some((k) => k !== "status" && k !== "skipReason")) {
      return res.status(403).json({ error: "Contractors can only update job status" });
    }
  }

  const update: typeof body & { skippedAt?: Date | null } = { ...body };
  if (body.status === "skipped") {
    update.skippedAt = new Date();
  } else if (body.status && existing.status === "skipped") {
    // Moving off skipped (e.g. rescheduled) retires the old reason so it doesn't
    // linger and get mistaken for the reason behind whatever happens next.
    update.skipReason = null;
    update.skippedAt = null;
  }

  const [job] = await db
    .update(jobsTable)
    .set(update)
    .where(eq(jobsTable.id, Number(req.params.id)))
    .returning();
  if (body.status && body.status !== existing.status) {
    await logAudit({
      clientId: job.clientId,
      actorName: req.appUser?.name,
      action: "job_status",
      description:
        body.status === "skipped" && body.skipReason
          ? `Job #${job.id} status changed to skipped — ${body.skipReason}`
          : `Job #${job.id} status changed to ${body.status.replace(/_/g, " ")}`,
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
  // A skipped visit did no work — invoicing it would bill for a no-show. The
  // office must explicitly move it off "skipped" (e.g. reschedule) before it
  // can ever be completed.
  if (existing.status === "skipped") {
    return res.status(400).json({ error: "This job was skipped and cannot be completed. Reschedule it first." });
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
    if (locked.status === "skipped") return { job: locked, invoice: null, skipped: true as const };

    const products = await tx.select().from(jobProductsTable).where(eq(jobProductsTable.jobId, id));
    const productTotal = products.reduce((s, p) => s + p.price * p.quantity, 0);
    // fold card surcharges from payments collected before completion into the invoice total
    const pendingPayments = await tx
      .select()
      .from(paymentsTable)
      .where(and(eq(paymentsTable.jobId, id), isNull(paymentsTable.invoiceId)));
    const pendingFees = pendingPayments.reduce((s, p) => s + p.cardFee, 0);
    const total = Math.round((locked.amount + productTotal + pendingFees) * 100) / 100;

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

    // Attach any on-site payments collected before completion to the new invoice
    await tx
      .update(paymentsTable)
      .set({ invoiceId: invoice.id })
      .where(and(eq(paymentsTable.jobId, id), isNull(paymentsTable.invoiceId)));

    const today = new Date().toISOString().slice(0, 10);
    const [job] = await tx
      .update(jobsTable)
      .set({ status: "completed", completedAt: new Date(), invoiceId: invoice.id })
      .where(eq(jobsTable.id, id))
      .returning();

    await tx.update(clientsTable).set({ lastServiceDate: today }).where(eq(clientsTable.id, locked.clientId));
    // Reflect the pre-completion payments just attached above, before this
    // commits. Done outside the transaction, a failure here would leave the job
    // invoiced but the invoice and balance showing nothing paid.
    await recalcInvoice(invoice.id, tx);
    await recalcClientBalance(locked.clientId, tx);
    return { job, invoice };
  });

  if (!result) return res.status(404).json({ error: "Job not found" });
  if ("skipped" in result && result.skipped) {
    // Lost the race: a concurrent request skipped this job after our pre-lock
    // check but before we took the row lock. Same rule applies — no invoice.
    return res.status(400).json({ error: "This job was skipped and cannot be completed. Reschedule it first." });
  }
  if (result.invoice) {
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
