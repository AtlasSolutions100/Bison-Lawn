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
  paymentsTable,
} from "@workspace/db";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import {
  CreateClientBody,
  UpdateClientBody,
  CreateClientNoteBody,
  CreateClientServiceBody,
  UpdateClientServiceBody,
  EmailClientBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, calculatePrice, type Executor } from "../lib/helpers";
import { sendClientEmailViaGmail } from "../lib/clientEmail";

const router: IRouter = Router();

router.use(["/clients", "/client-services"], requireAuth, requireAdmin);

async function hydrateClient<T extends typeof clientsTable.$inferSelect>(client: T) {
  const [credit] = await db
    .select({ total: sql<number>`coalesce(sum(${paymentsTable.amount}), 0)` })
    .from(paymentsTable)
    .where(and(eq(paymentsTable.clientId, client.id), isNull(paymentsTable.invoiceId)));
  return { ...client, unappliedCredit: Number(credit?.total ?? 0) };
}

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
  return res.json(await Promise.all(rows.map(hydrateClient)));
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
  return res.json(await hydrateClient(client));
});

router.post("/clients/:id/email", async (req, res) => {
  const body = EmailClientBody.parse(req.body);
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, Number(req.params.id)));
  if (!client) return res.status(404).json({ error: "Client not found" });
  if (!client.email) return res.status(400).json({ error: "Client has no email address" });

  await sendClientEmailViaGmail({ toEmail: client.email, subject: body.subject, body: body.body });
  await logAudit({
    clientId: client.id,
    actorName: req.appUser?.name,
    action: "client_email_sent",
    description: `Sent email to ${client.email}`,
  });
  return res.json({ sent: true, to: client.email });
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reject anything that is not a real yyyy-mm-dd calendar date. Null and empty are
 * allowed — the caller decides which fields are required. Without this an invalid
 * string reaches `new Date(...)` during job generation and throws mid-write.
 */
function dateFieldError(label: string, value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (!ISO_DATE_RE.test(value)) return `${label} must be a date in yyyy-mm-dd format`;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Round-tripping also rejects real-looking but impossible dates like 2026-02-31.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return `${label} is not a real calendar date`;
  }
  return null;
}

/** Create jobs for a client-service based on its schedule type. */
async function generateJobs(
  cs: typeof clientServicesTable.$inferSelect,
  tx: Executor = db,
) {
  if (cs.scheduleType === "window") {
    // Waiting list entry: not dispatched, has a window
    await tx.insert(jobsTable).values({
      clientId: cs.clientId,
      clientServiceId: cs.id,
      serviceId: cs.serviceId,
      dispatched: false,
      windowStart: cs.startDate,
      windowEnd: cs.endDate,
      amount: cs.amount,
      budgetedHours: cs.budgetedHours,
    });
  } else if (cs.scheduleType === "recurring") {
    if (!cs.firstServiceDate || !cs.frequencyWeeks) {
      throw new Error("Recurring services require a first service date and frequency in weeks");
    }
    // Defensive: a non-positive interval would step backwards (or never advance)
    // and fill the board with 60 wrong jobs. The route validates this too.
    if (!Number.isInteger(cs.frequencyWeeks) || cs.frequencyWeeks < 1) {
      throw new Error("Recurring frequency must be a whole number of weeks of at least 1");
    }
    // Generate occurrences straight to the dispatch board until season end (cap 60)
    const end = cs.seasonEndDate ? new Date(cs.seasonEndDate) : null;
    let d = new Date(cs.firstServiceDate);
    let count = 0;
    while (count < 60 && (!end || d <= end)) {
      await tx.insert(jobsTable).values({
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
    await tx.insert(jobsTable).values({
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
  let pkg: typeof packagesTable.$inferSelect | null = null;
  if (body.packageId) {
    [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, body.packageId));
    if (!pkg) return res.status(404).json({ error: "Package not found" });
    serviceIds = pkg.serviceIds;
  } else if (body.serviceId) {
    serviceIds = [body.serviceId];
  } else {
    return res.status(400).json({ error: "serviceId or packageId is required" });
  }

  // Resolve and validate every row before writing anything. A half-created package
  // assignment is worse than a rejected one: the office sees some of the services
  // appear with no indication which ones are missing.
  const planned: {
    svc: typeof servicesTable.$inferSelect;
    values: typeof clientServicesTable.$inferInsert;
  }[] = [];

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
    const inherited = <K extends keyof typeof body>(
      key: K,
      packageValue: (typeof body)[K],
    ) => (Object.prototype.hasOwnProperty.call(req.body, key) ? body[key] : packageValue);
    const scheduleType = inherited("scheduleType", pkg?.scheduleType as typeof body.scheduleType);
    const startDate = inherited("startDate", pkg?.startDate ?? null);
    const firstServiceDate = inherited(
      "firstServiceDate",
      scheduleType === "recurring" ? pkg?.startDate ?? null : null,
    );
    const frequencyWeeks = inherited("frequencyWeeks", pkg?.frequencyWeeks ?? null);
    const seasonEndDate = inherited("seasonEndDate", pkg?.seasonEndDate ?? null);
    const renewDate = inherited("renewDate", pkg?.renewDate ?? null);
    const endDate = inherited("endDate", pkg?.endDate ?? null);
    if (!scheduleType) {
      return res.status(400).json({
        error: "scheduleType is required, and this package does not set one of its own",
      });
    }
    for (const [label, value] of [
      ["Start date", startDate],
      ["End date", endDate],
      ["First service date", firstServiceDate],
      ["Season end date", seasonEndDate],
      ["Renew date", renewDate],
    ] as const) {
      const problem = dateFieldError(label, value);
      if (problem) return res.status(400).json({ error: problem });
    }
    if (scheduleType === "recurring") {
      if (!firstServiceDate || !frequencyWeeks) {
        return res.status(400).json({
          error: "Recurring services require a first service date and frequency in weeks",
        });
      }
      // A zero or negative interval steps backwards and would silently fill the
      // dispatch board with 60 wrong jobs.
      if (!Number.isInteger(frequencyWeeks) || frequencyWeeks < 1) {
        return res.status(400).json({
          error: "Recurring frequency must be a whole number of weeks of at least 1",
        });
      }
      // Safe as strings: both are validated yyyy-mm-dd.
      if (seasonEndDate && seasonEndDate < firstServiceDate) {
        return res.status(400).json({
          error: "Season end date cannot be before the first service date",
        });
      }
    }

    planned.push({
      svc,
      values: {
        clientId,
        serviceId,
        packageId: body.packageId ?? null,
        quantity: body.quantity ?? 1,
        amount,
        scheduleType,
        startDate,
        endDate,
        frequencyWeeks,
        firstServiceDate,
        seasonEndDate,
        renewDate,
        budgetedHours: body.budgetedHours ?? svc.billableHours ?? null,
      },
    });
  }

  if (planned.length === 0) {
    return res.status(400).json({ error: "No matching services were found to assign" });
  }

  // One transaction for the whole assignment: a failure part-way through a
  // multi-service package must leave nothing behind.
  const created = await db.transaction(async (tx) => {
    const rows: { cs: typeof clientServicesTable.$inferSelect; name: string }[] = [];
    for (const { svc, values } of planned) {
      const [cs] = await tx.insert(clientServicesTable).values(values).returning();
      await generateJobs(cs, tx);
      rows.push({ cs, name: svc.name });
    }
    return rows;
  });

  for (const { cs, name } of created) {
    await logAudit({
      clientId,
      actorName: req.appUser?.name,
      action: "service_assigned",
      description: `Assigned service "${name}" ($${cs.amount})`,
    });
  }
  return res.status(201).json(
    await Promise.all(created.map(({ cs }) => clientServiceWithName(cs))),
  );
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
