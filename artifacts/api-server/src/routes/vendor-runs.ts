import { Router, type IRouter } from "express";
import {
  clientServicesTable,
  clientsTable,
  db,
  jobProductsTable,
  jobsTable,
  paymentsTable,
  servicesTable,
} from "@workspace/db";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { CompleteVendorRunBody, ListVendorRunsQueryParams } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, recalcClientBalance, recalcInvoice } from "../lib/helpers";
import { createInvoiceForJob } from "../lib/invoiceFromJob";

const router: IRouter = Router();

router.use(["/vendor-runs"], requireAuth, requireAdmin);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string) {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

router.get("/vendor-runs", async (req, res) => {
  const query = ListVendorRunsQueryParams.parse(req.query);
  if ((query.from && !isRealDate(query.from)) || (query.to && !isRealDate(query.to))) {
    return res.status(400).json({ error: "from and to must be real dates in yyyy-mm-dd format" });
  }
  if (query.from && query.to && query.from > query.to) {
    return res.status(400).json({ error: "from cannot be after to" });
  }

  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, query.serviceId));
  if (!service) return res.status(404).json({ error: "Service not found" });

  const assignments = await db
    .select({
      clientService: clientServicesTable,
      clientName: clientsTable.name,
      city: clientsTable.city,
    })
    .from(clientServicesTable)
    .innerJoin(clientsTable, eq(clientsTable.id, clientServicesTable.clientId))
    .where(eq(clientServicesTable.serviceId, query.serviceId))
    .orderBy(clientsTable.name);

  const rows = [];
  const seenClients = new Set<number>();
  for (const assignment of assignments) {
    const cs = assignment.clientService;
    // A service can have been assigned twice historically. Reconciliation is
    // customer-based, so never show (or invite billing) the same person twice.
    if (seenClients.has(cs.clientId)) continue;
    seenClients.add(cs.clientId);
    const dateConditions = [];
    if (query.from) {
      dateConditions.push(
        or(
          gte(jobsTable.scheduledDate, query.from),
          gte(jobsTable.windowEnd, query.from),
        )!,
      );
    }
    if (query.to) {
      dateConditions.push(
        or(
          lte(jobsTable.scheduledDate, query.to),
          lte(jobsTable.windowStart, query.to),
        )!,
      );
    }
    const jobs = await db
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.clientServiceId, cs.id), ...dateConditions))
      .orderBy(desc(jobsTable.scheduledDate), desc(jobsTable.id));

    const invoiced = jobs.find((job) => job.invoiceId != null);
    const completed = jobs.find((job) => job.status === "completed");
    const current = invoiced ?? completed ?? jobs[0] ?? null;
    const [lastCompleted] = await db
      .select({ scheduledDate: jobsTable.scheduledDate })
      .from(jobsTable)
      .where(and(eq(jobsTable.clientServiceId, cs.id), eq(jobsTable.status, "completed")))
      .orderBy(desc(jobsTable.scheduledDate), desc(jobsTable.completedAt))
      .limit(1);

    rows.push({
      clientId: cs.clientId,
      clientName: assignment.clientName,
      city: assignment.city,
      clientServiceId: cs.id,
      amount: cs.amount,
      status: invoiced
        ? "invoiced"
        : completed
          ? "completed"
          : current
            ? "scheduled"
            : "not_scheduled",
      jobId: current?.id ?? null,
      invoiceId: invoiced?.invoiceId ?? null,
      lastCompletedDate: lastCompleted?.scheduledDate ?? null,
    });
  }
  return res.json(rows);
});

router.post("/vendor-runs/complete", async (req, res) => {
  const body = CompleteVendorRunBody.parse(req.body);
  if (!isRealDate(body.serviceDate)) {
    return res.status(400).json({ error: "serviceDate must be a real date in yyyy-mm-dd format" });
  }
  const [service] = await db.select().from(servicesTable).where(eq(servicesTable.id, body.serviceId));
  if (!service) return res.status(404).json({ error: "Service not found" });

  const outcomes: {
    clientId: number;
    clientName: string;
    status: "completed" | "skipped" | "failed";
    invoiceId: number | null;
    reason: string | null;
  }[] = [];

  for (const clientId of [...new Set(body.clientIds)]) {
    let clientName = `Client #${clientId}`;
    try {
      const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
      clientName = client?.name ?? clientName;
      if (!client) throw new Error("Customer not found");
      const [assignment] = await db
        .select()
        .from(clientServicesTable)
        .where(and(eq(clientServicesTable.clientId, clientId), eq(clientServicesTable.serviceId, body.serviceId)))
        .orderBy(clientServicesTable.id)
        .limit(1);
      if (!assignment) throw new Error("Customer does not have this service assigned");

      const result = await db.transaction(async (tx) => {
        // Serializes the no-job case without taking a table row lock out of the
        // required job -> invoice -> payment -> client lock order.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${body.serviceId}:${clientId}:${body.serviceDate}`}, 0))`,
        );

        const matchingJobs = await tx
          .select()
          .from(jobsTable)
          .where(
            and(
              eq(jobsTable.clientId, clientId),
              eq(jobsTable.serviceId, body.serviceId),
              or(
                eq(jobsTable.scheduledDate, body.serviceDate),
                and(
                  isNull(jobsTable.scheduledDate),
                  lte(jobsTable.windowStart, body.serviceDate),
                  gte(jobsTable.windowEnd, body.serviceDate),
                ),
              ),
            ),
          )
          .orderBy(desc(jobsTable.id))
          .for("update");
        let job = matchingJobs.find((candidate) => candidate.invoiceId != null) ?? matchingJobs[0];

        if (job?.invoiceId != null) {
          return { skipped: true as const, job, invoiceId: job.invoiceId };
        }
        if (!job) {
          [job] = await tx
            .insert(jobsTable)
            .values({
              clientId,
              clientServiceId: assignment.id,
              serviceId: body.serviceId,
              status: "scheduled",
              dispatched: true,
              scheduledDate: body.serviceDate,
              amount: assignment.amount,
              budgetedHours: assignment.budgetedHours,
              visibleToContractor: false,
            })
            .returning();
          // Keep the money path's first row lock explicitly on the job.
          [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, job.id)).for("update");
        } else if (job.scheduledDate !== body.serviceDate || !job.dispatched) {
          [job] = await tx
            .update(jobsTable)
            .set({ scheduledDate: body.serviceDate, dispatched: true })
            .where(eq(jobsTable.id, job.id))
            .returning();
        }

        const products = await tx.select().from(jobProductsTable).where(eq(jobProductsTable.jobId, job.id));
        const productTotal = products.reduce((sum, product) => sum + product.price * product.quantity, 0);
        const pendingPayments = await tx
          .select()
          .from(paymentsTable)
          .where(and(eq(paymentsTable.jobId, job.id), isNull(paymentsTable.invoiceId)));
        const pendingFees = pendingPayments.reduce((sum, payment) => sum + payment.cardFee, 0);
        const total = Math.round((job.amount + productTotal + pendingFees) * 100) / 100;

        const invoice = await createInvoiceForJob(tx, {
          clientId,
          jobId: job.id,
          serviceAmount: job.amount,
          serviceName: service.name,
          serviceDate: body.serviceDate,
          products: products.map((p) => ({ name: p.name, price: p.price, quantity: p.quantity })),
          pendingFees,
        });
        await tx
          .update(paymentsTable)
          .set({ invoiceId: invoice.id })
          .where(and(eq(paymentsTable.jobId, job.id), isNull(paymentsTable.invoiceId)));
        const [completedJob] = await tx
          .update(jobsTable)
          .set({ status: "completed", completedAt: new Date(), invoiceId: invoice.id })
          .where(eq(jobsTable.id, job.id))
          .returning();
        await tx.update(clientsTable).set({ lastServiceDate: body.serviceDate }).where(eq(clientsTable.id, clientId));
        await recalcInvoice(invoice.id, tx);
        await recalcClientBalance(clientId, tx);
        return { skipped: false as const, job: completedJob, invoiceId: invoice.id, total };
      });

      if (result.skipped) {
        outcomes.push({
          clientId,
          clientName,
          status: "skipped",
          invoiceId: result.invoiceId,
          reason: result.invoiceId
            ? "Already invoiced for this service on this date"
            : "This service was already billed",
        });
      } else {
        outcomes.push({ clientId, clientName, status: "completed", invoiceId: result.invoiceId, reason: null });
        await logAudit({
          clientId,
          actorName: req.appUser?.name,
          action: "job_completed",
          description: `Completed vendor job #${result.job.id}; invoice #${result.invoiceId} for $${result.total}`,
        });
      }
    } catch (error) {
      outcomes.push({
        clientId,
        clientName,
        status: "failed",
        invoiceId: null,
        reason: error instanceof Error ? error.message : "Unexpected error",
      });
    }
  }

  return res.json({
    completed: outcomes.filter((outcome) => outcome.status === "completed").length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    outcomes,
  });
});

export default router;
