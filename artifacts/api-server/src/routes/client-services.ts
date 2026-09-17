import { Router, type IRouter } from "express";
import {
  db,
  clientsTable,
  clientServicesTable,
  servicesTable,
  packagesTable,
  jobsTable,
  usersTable,
} from "@workspace/db";
import type { ClientService, PackageItem, Service } from "@workspace/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  CreateClientServiceBody,
  UpdateClientServiceBody,
  PauseClientServiceBody,
  PreviewClientServicePriceBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { dateFieldError, logAudit, roundMoney } from "../lib/helpers";
import {
  cadenceLabel,
  contractorNoteFor,
  discountAmountFor,
  generateJobs,
  generatesJobs,
  propagateToFutureJobs,
  regenerateFutureJobs,
  removeFutureJobs,
  resolveServicePrice,
  todayLocal,
  weekOfMonthOf,
  weekParityOf,
  weekdayOf,
} from "../lib/jobGeneration";
import {
  renewClientService,
  renewRefusal,
  resumeClientService,
  runClientServiceDailyTasks,
} from "../lib/clientServiceTick";
import { hydrateJobs } from "./jobs";

/**
 * Services on a customer's account.
 *
 * This is his "job on the account": a mow every other Wednesday on odd
 * weeks with Eich, $58 a visit less a $5 loyalty discount, a note the crew
 * must read first, paused until the balance is paid. Everything the
 * AssignedServicesPanel on the client page edits lives here.
 *
 * /clients and /client-services are admin-only through the guard in
 * routes/clients.ts, which is mounted ahead of this router. The one
 * contractor route at the bottom carries its own requireAuth.
 */
const router: IRouter = Router();

// The same guard routes/clients.ts applies, repeated here so these paths fail
// closed even if the mount order ever changes. Cheap, and it never widens.
router.use(["/clients", "/client-services"], requireAuth, requireArea("clients"));

class BadRequest extends Error {
  status = 400;
}

/** The schedule fields have to agree with each other before anything is written. */
function validateSchedule(row: {
  scheduleType: string;
  startDate: string | null;
  endDate: string | null;
  firstServiceDate: string | null;
  seasonEndDate: string | null;
  renewDate: string | null;
  frequency: string | null;
  frequencyWeeks: number | null;
  weekday: number | null;
  monthlyWeek: number | null;
  noteStartDate: string | null;
  noteEndDate: string | null;
  contractMonths: number | null;
  contractTotal: number | null;
}) {
  for (const [label, value] of [
    ["Start date", row.startDate],
    ["End date", row.endDate],
    ["First service date", row.firstServiceDate],
    ["Season end date", row.seasonEndDate],
    ["Renew date", row.renewDate],
    ["Note start date", row.noteStartDate],
    ["Note end date", row.noteEndDate],
  ] as const) {
    const problem = dateFieldError(label, value);
    if (problem) throw new BadRequest(problem);
  }
  if (row.weekday != null && (!Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6)) {
    throw new BadRequest("Weekday must be 0 (Sunday) to 6 (Saturday)");
  }
  if (row.scheduleType === "recurring") {
    if (!row.firstServiceDate) {
      throw new BadRequest("Recurring services require a first service date and frequency in weeks");
    }
    if (!row.frequency && !row.frequencyWeeks) {
      throw new BadRequest("Recurring services require a first service date and frequency in weeks");
    }
    if (row.frequency && !["weekly", "biweekly", "monthly"].includes(row.frequency)) {
      throw new BadRequest("Frequency must be weekly, biweekly or monthly");
    }
    if (!row.frequency && (!Number.isInteger(row.frequencyWeeks) || (row.frequencyWeeks ?? 0) < 1)) {
      throw new BadRequest("Recurring frequency must be a whole number of weeks of at least 1");
    }
    if (row.frequency === "monthly" && row.monthlyWeek != null && ![1, 2, 3, 4].includes(row.monthlyWeek)) {
      throw new BadRequest("Week of the month must be 1 to 4");
    }
    if (row.seasonEndDate && row.seasonEndDate < row.firstServiceDate) {
      throw new BadRequest("Season end date cannot be before the first service date");
    }
  }
  if (row.scheduleType === "window") {
    if (!row.startDate || !row.endDate) throw new BadRequest("A waiting-list service needs a window start and end");
    if (row.endDate < row.startDate) throw new BadRequest("Window end cannot be before window start");
  }
  if (row.scheduleType === "contract") {
    if (!row.firstServiceDate) throw new BadRequest("A contract needs the date of the first payment");
    if (row.contractMonths !== 8 && row.contractMonths !== 12) {
      throw new BadRequest("A contract is split over 8 or 12 months");
    }
    if (row.contractTotal == null || row.contractTotal <= 0) throw new BadRequest("A contract needs the annual total");
  }
  if (row.noteStartDate && row.noteEndDate && row.noteEndDate < row.noteStartDate) {
    throw new BadRequest("Note end date cannot be before its start date");
  }
}

async function assertContractor(assignedToId: number | null | undefined) {
  if (assignedToId == null) return;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, assignedToId));
  if (!user) throw new BadRequest("That contractor no longer exists");
}

// ---- reading ----

/**
 * Everything the account page shows per row: names, cadence in words, the
 * retail / discount / net split and what is still ahead on the board.
 */
async function hydrateClientServices(rows: ClientService[]) {
  if (rows.length === 0) return [];
  const serviceIds = [...new Set(rows.map((r) => r.serviceId))];
  const packageIds = [...new Set(rows.map((r) => r.packageId).filter((x): x is number => x != null))];
  const userIds = [...new Set(rows.map((r) => r.assignedToId).filter((x): x is number => x != null))];
  const csIds = rows.map((r) => r.id);
  const today = todayLocal();

  const [services, packages, users, upcoming, history] = await Promise.all([
    db.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds)),
    packageIds.length ? db.select().from(packagesTable).where(inArray(packagesTable.id, packageIds)) : Promise.resolve([]),
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : Promise.resolve([]),
    db
      .select({
        csId: jobsTable.clientServiceId,
        count: sql<number>`count(*)`,
        total: sql<number>`coalesce(sum(${jobsTable.amount}), 0)`,
        next: sql<string | null>`min(coalesce(${jobsTable.scheduledDate}, ${jobsTable.windowStart}))`,
      })
      .from(jobsTable)
      .where(
        and(
          inArray(jobsTable.clientServiceId, csIds),
          inArray(jobsTable.status, ["scheduled", "on_the_way", "in_progress"]),
        ),
      )
      .groupBy(jobsTable.clientServiceId),
    db
      .select({
        csId: jobsTable.clientServiceId,
        count: sql<number>`count(*)`,
        last: sql<string | null>`max(${jobsTable.scheduledDate})`,
      })
      .from(jobsTable)
      .where(and(inArray(jobsTable.clientServiceId, csIds), eq(jobsTable.status, "completed")))
      .groupBy(jobsTable.clientServiceId),
  ]);
  const sMap = new Map(services.map((s) => [s.id, s]));
  const pMap = new Map(packages.map((p) => [p.id, p]));
  const uMap = new Map(users.map((u) => [u.id, u]));
  const upMap = new Map(upcoming.map((u) => [u.csId, u]));
  const histMap = new Map(history.map((h) => [h.csId, h]));

  return rows.map((cs) => {
    const svc = sMap.get(cs.serviceId);
    const u = cs.assignedToId ? uMap.get(cs.assignedToId) : null;
    const up = upMap.get(cs.id);
    const hist = histMap.get(cs.id);
    const billingMode = svc?.billingMode ?? "fixed";
    // Per visit. A time service's "retail" is its hourly rate times the
    // budgeted hours, which is the number the board shows before the clock
    // decides the real one.
    const retailAmount =
      cs.scheduleType === "contract"
        ? roundMoney((cs.contractTotal ?? 0) / (cs.contractMonths ?? 1))
        : billingMode === "time"
          ? roundMoney(cs.amount * (cs.budgetedHours ?? 0))
          : cs.amount;
    const discountAmount = discountAmountFor(retailAmount, cs.discountType, cs.discountValue);
    return {
      ...cs,
      serviceName: svc?.name ?? null,
      serviceCode: svc?.code ?? null,
      billingMode,
      packageName: cs.packageId ? (pMap.get(cs.packageId)?.name ?? null) : null,
      assignedToName: u ? (u.displayName?.trim() || u.name) : null,
      cadenceLabel: cadenceLabel(cs),
      weekParity:
        cs.weekParity ?? (cs.frequency === "biweekly" && cs.firstServiceDate ? weekParityOf(cs.firstServiceDate) : null),
      retailAmount,
      discountAmount,
      netAmount: roundMoney(retailAmount - discountAmount),
      upcomingCount: Number(up?.count ?? 0),
      upcomingTotal: roundMoney(Number(up?.total ?? 0)),
      nextDate: up?.next ?? null,
      completedCount: Number(hist?.count ?? 0),
      lastCompletedDate: hist?.last ?? null,
      noteActiveToday: contractorNoteFor(cs, today) != null,
      pausedAt: cs.pausedAt ? cs.pausedAt.toISOString() : null,
      lastRenewedAt: cs.lastRenewedAt ? cs.lastRenewedAt.toISOString() : null,
      createdAt: cs.createdAt.toISOString(),
    };
  });
}

async function hydrateOne(cs: ClientService) {
  return (await hydrateClientServices([cs]))[0];
}

router.get("/clients/:id/client-services", async (req, res) => {
  const rows = await db
    .select()
    .from(clientServicesTable)
    .where(eq(clientServicesTable.clientId, Number(req.params.id)))
    .orderBy(asc(clientServicesTable.packageId), asc(clientServicesTable.id));
  return res.json(await hydrateClientServices(rows));
});

/**
 * What a service would cost this customer, before anything is saved. The
 * assign dialog calls it as soon as a service is picked so the price box is
 * never sitting at 0.00 waiting for someone to go find the square footage.
 */
router.post("/clients/:id/service-price", async (req, res) => {
  const body = PreviewClientServicePriceBody.parse(req.body);
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, Number(req.params.id)));
  if (!client) return res.status(404).json({ error: "Client not found" });
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, body.serviceId));
  if (!svc) return res.status(404).json({ error: "Service not found" });
  try {
    const priced = await resolveServicePrice(db, svc, client, { quantity: body.quantity, sqft: body.sqft });
    return res.json({
      ...priced,
      rate: svc.rate,
      serviceName: svc.name,
      defaultStartDate: svc.defaultStartDate,
      defaultEndDate: svc.defaultEndDate,
      renewDate: svc.renewDate,
    });
  } catch (error) {
    if (error instanceof Error && (error as { status?: number }).status === 400) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
});

// ---- assigning ----

router.post("/clients/:id/client-services", async (req, res) => {
  const body = CreateClientServiceBody.parse(req.body);
  const clientId = Number(req.params.id);
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client) return res.status(404).json({ error: "Client not found" });

  // A package is a list of entries, and the same service can be on it more
  // than once ("Sprinkler timer adjustment" four times, each in its own month;
  // "core aeration" is Aeration twice). Every entry becomes its own row on the
  // account, carrying the entry's label so the office can tell them apart.
  // Packages saved before entries existed only carry the id list.
  let entries: PackageItem[] = [];
  let pkg: typeof packagesTable.$inferSelect | null = null;
  if (body.packageId) {
    [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, body.packageId));
    if (!pkg) return res.status(404).json({ error: "Package not found" });
    entries = pkg.items?.length ? pkg.items : pkg.serviceIds.map((serviceId) => ({ serviceId }));
  } else if (body.serviceId) {
    entries = [{ serviceId: body.serviceId }];
  } else {
    return res.status(400).json({ error: "serviceId or packageId is required" });
  }

  try {
    await assertContractor(body.assignedToId);
  } catch (error) {
    if (error instanceof BadRequest) return res.status(400).json({ error: error.message });
    throw error;
  }

  // Resolve and validate every row before writing anything. A half-created package
  // assignment is worse than a rejected one: the office sees some of the services
  // appear with no indication which ones are missing.
  const planned: { svc: Service; values: typeof clientServicesTable.$inferInsert; pricedFrom: string | null }[] = [];

  // A package's members get the request's values only where the request set
  // them; otherwise the package's own defaults. So a package can carry the
  // schedule and the office still overrides one field for one customer.
  const inherited = <K extends keyof typeof body>(key: K, packageValue: (typeof body)[K]) =>
    Object.prototype.hasOwnProperty.call(req.body, key) ? body[key] : packageValue;

  for (const entry of entries) {
    const serviceId = entry.serviceId;
    const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, serviceId));
    if (!svc) continue;

    let priced;
    try {
      priced = await resolveServicePrice(db, svc, client, {
        quantity: body.quantity,
        explicitAmount: body.amount,
        sqft: body.sqft,
      });
    } catch (error) {
      if (error instanceof Error && (error as { status?: number }).status === 400) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
    // The matrix could not price it because the customer has no measurement
    // on file. Falling back to the flat rate quietly is exactly what his old
    // CRM did, and the bill went out wrong; say so instead.
    if (priced.missingField && body.amount == null) {
      return res.status(400).json({
        error:
          `"${svc.name}" is priced from ${priced.missingField}, and this customer has no ${priced.missingField} on file. ` +
          `Add it under Property Details, or type a price.`,
      });
    }

    const scheduleType = inherited("scheduleType", pkg?.scheduleType as typeof body.scheduleType);
    if (!scheduleType) {
      return res.status(400).json({
        error: "scheduleType is required, and this package does not set one of its own",
      });
    }
    const firstServiceDate = inherited(
      "firstServiceDate",
      scheduleType === "recurring" || scheduleType === "contract" ? pkg?.startDate ?? null : null,
    );
    const frequencyWeeks = inherited("frequencyWeeks", pkg?.frequencyWeeks ?? null);
    // A plain "every 2 weeks" from an older caller becomes the named cadence
    // so the account reads the way he says it.
    const frequency =
      body.frequency ??
      (scheduleType === "recurring" && frequencyWeeks === 1
        ? "weekly"
        : scheduleType === "recurring" && frequencyWeeks === 2
          ? "biweekly"
          : null);
    const row = {
      clientId,
      serviceId,
      packageId: body.packageId ?? null,
      label: entry.label ?? null,
      quantity: body.quantity ?? 1,
      amount: priced.amount,
      scheduleType,
      // An entry's own window wins, even over dates typed at assign time: the
      // one date pair the office types is for the package as a whole, and the
      // four timer adjustments still have to land in June, July, August and
      // September rather than all in the same month.
      startDate: entry.windowStart || (inherited("startDate", pkg?.startDate ?? null) ?? null),
      endDate: entry.windowEnd || (inherited("endDate", pkg?.endDate ?? null) ?? null),
      frequencyWeeks: frequency === "weekly" ? 1 : frequency === "biweekly" ? 2 : frequency === "monthly" ? null : frequencyWeeks ?? null,
      firstServiceDate: firstServiceDate ?? null,
      seasonEndDate: inherited("seasonEndDate", pkg?.seasonEndDate ?? null) ?? null,
      renewDate: inherited("renewDate", pkg?.renewDate ?? null) ?? null,
      // Most specific estimate first: what the office typed, then the matrix
      // band this property actually falls in, then the service-wide figure.
      budgetedHours: body.budgetedHours ?? priced.budgetedHours ?? svc.billableHours ?? null,
      assignedToId: body.assignedToId ?? null,
      frequency,
      weekday: body.weekday ?? (firstServiceDate && frequency ? weekdayOf(firstServiceDate) : null),
      weekParity:
        body.weekParity ?? (frequency === "biweekly" && firstServiceDate ? weekParityOf(firstServiceDate) : null),
      monthlyWeek:
        body.monthlyWeek ?? (frequency === "monthly" && firstServiceDate ? weekOfMonthOf(firstServiceDate) : null),
      discountType: body.discountType ?? null,
      discountValue: body.discountValue ?? null,
      discountLabel: body.discountLabel?.trim() || null,
      contractorNote: body.contractorNote?.trim() || null,
      noteStartDate: body.noteStartDate || null,
      noteEndDate: body.noteEndDate || null,
      // A one-time job and a contract are finite: they only come back if he
      // says so. Defaulting these on repeated a spring clean-up a year later
      // and rolled a contract on top of its own unpaid months.
      autoRenew: body.autoRenew ?? (scheduleType === "one_time" || scheduleType === "contract" ? false : true),
      pricedFromLabel: priced.pricedFromLabel,
      pricedFromValue: priced.pricedFromValue,
      contractMonths: body.contractMonths ?? null,
      contractTotal: body.contractTotal ?? null,
    };
    try {
      validateSchedule(row);
      if (row.discountValue != null && row.discountValue < 0) throw new BadRequest("A discount cannot be negative");
      if (row.discountType === "percent" && (row.discountValue ?? 0) > 100) {
        throw new BadRequest("A percent discount cannot be more than 100%");
      }
    } catch (error) {
      if (error instanceof BadRequest) return res.status(400).json({ error: error.message });
      throw error;
    }
    planned.push({
      svc,
      values: row,
      pricedFrom: priced.pricedFromLabel ? `${priced.pricedFromLabel} ${priced.pricedFromValue}` : null,
    });
  }

  if (planned.length === 0) {
    return res.status(400).json({ error: "No matching services were found to assign" });
  }

  // One transaction for the whole assignment: a failure part-way through a
  // multi-service package must leave nothing behind.
  const created = await db.transaction(async (tx) => {
    const rows: { cs: ClientService; svc: Service; visits: number; pricedFrom: string | null }[] = [];
    for (const { svc, values, pricedFrom } of planned) {
      const [cs] = await tx.insert(clientServicesTable).values(values).returning();
      const visits = (await generateJobs(cs, svc, tx)).length;
      rows.push({ cs, svc, visits, pricedFrom });
    }
    return rows;
  });

  for (const { cs, svc, visits, pricedFrom } of created) {
    const who = cs.assignedToId ? ` with ${(await db.select().from(usersTable).where(eq(usersTable.id, cs.assignedToId)))[0]?.name ?? "a contractor"}` : "";
    await logAudit({
      clientId,
      actorName: req.appUser?.name,
      action: "service_assigned",
      description:
        `Assigned "${svc.name}" ($${cs.amount}${svc.billingMode === "time" ? "/hr" : ""}` +
        `${pricedFrom ? `, priced from ${pricedFrom}` : ""})${who} — ${cadenceLabel(cs)}, ${visits} visit(s) on the board` +
        (cs.discountValue ? `, ${cs.discountType === "percent" ? `${cs.discountValue}%` : `$${cs.discountValue}`} ${cs.discountLabel ?? "discount"}` : ""),
    });
  }
  return res.status(201).json(await hydrateClientServices(created.map(({ cs }) => cs)));
});

// ---- editing in place ----

/** Fields whose change means the visits have to be rebuilt rather than patched. */
const SCHEDULE_FIELDS = [
  "scheduleType",
  "startDate",
  "endDate",
  "firstServiceDate",
  "seasonEndDate",
  "frequency",
  "frequencyWeeks",
  "weekday",
  "weekParity",
  "monthlyWeek",
  "contractMonths",
  "contractTotal",
] as const;

const FIELD_LABELS: Record<string, string> = {
  amount: "price",
  budgetedHours: "billable hours",
  assignedToId: "contractor",
  frequency: "cadence",
  frequencyWeeks: "frequency",
  weekday: "weekday",
  weekParity: "odd/even week",
  monthlyWeek: "week of the month",
  firstServiceDate: "first service date",
  seasonEndDate: "season end",
  startDate: "window start",
  endDate: "window end",
  renewDate: "renew date",
  discountType: "discount type",
  discountValue: "discount",
  discountLabel: "discount label",
  contractorNote: "crew note",
  noteStartDate: "note start",
  noteEndDate: "note end",
  autoRenew: "auto-renew",
  active: "on/off",
  contractMonths: "contract months",
  contractTotal: "contract total",
  scheduleType: "schedule type",
  quantity: "quantity",
};

router.patch("/client-services/:id", async (req, res) => {
  const body = UpdateClientServiceBody.parse(req.body);
  const id = Number(req.params.id);
  const [existing] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, id));
  if (!existing) return res.status(404).json({ error: "Client service not found" });
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, existing.serviceId));
  if (!svc) return res.status(404).json({ error: "Service not found" });

  try {
    await assertContractor(body.assignedToId);
  } catch (error) {
    if (error instanceof BadRequest) return res.status(400).json({ error: error.message });
    throw error;
  }

  const patch: Partial<typeof clientServicesTable.$inferInsert> = { ...body };
  if (body.discountLabel !== undefined) patch.discountLabel = body.discountLabel?.trim() || null;
  if (body.contractorNote !== undefined) patch.contractorNote = body.contractorNote?.trim() || null;
  if (body.frequency !== undefined) {
    // Clearing the named cadence keeps the plain "every N weeks" the caller
    // sent (or the row's own N). Forcing it to 1 turned an every-4-weeks mow
    // into a weekly one the moment anything else on the row was saved.
    patch.frequencyWeeks =
      body.frequency === "weekly"
        ? 1
        : body.frequency === "biweekly"
          ? 2
          : body.frequency === "monthly"
            ? null
            : (body.frequencyWeeks ?? existing.frequencyWeeks);
  }
  // A price typed by hand is no longer "from the matrix".
  if (body.amount !== undefined && body.amount !== existing.amount) {
    patch.pricedFromLabel = null;
    patch.pricedFromValue = null;
  }
  const merged = { ...existing, ...patch } as ClientService;
  if (merged.frequency === "biweekly" && merged.weekParity == null && merged.firstServiceDate) {
    patch.weekParity = weekParityOf(merged.firstServiceDate);
    merged.weekParity = patch.weekParity;
  }
  if (merged.frequency && merged.weekday == null && merged.firstServiceDate) {
    patch.weekday = weekdayOf(merged.firstServiceDate);
    merged.weekday = patch.weekday;
  }
  try {
    validateSchedule(merged);
    if (merged.discountValue != null && merged.discountValue < 0) throw new BadRequest("A discount cannot be negative");
    if (merged.discountType === "percent" && (merged.discountValue ?? 0) > 100) {
      throw new BadRequest("A percent discount cannot be more than 100%");
    }
  } catch (error) {
    if (error instanceof BadRequest) return res.status(400).json({ error: error.message });
    throw error;
  }

  const changed = Object.keys(body).filter(
    (k) => JSON.stringify((existing as Record<string, unknown>)[k]) !== JSON.stringify((merged as Record<string, unknown>)[k]),
  );
  const scheduleChanged = changed.some((k) => (SCHEDULE_FIELDS as readonly string[]).includes(k));
  const switched = changed.includes("active");

  const outcome = await db.transaction(async (tx) => {
    const [cs] = await tx.update(clientServicesTable).set(patch).where(eq(clientServicesTable.id, id)).returning();
    let note = "";
    if (switched && !cs.active) {
      const removed = await removeFutureJobs(cs.id, tx);
      note = `; switched off, ${removed} upcoming visit(s) taken off the board`;
    } else if ((switched && cs.active) || (scheduleChanged && generatesJobs(cs))) {
      const visits = await regenerateFutureJobs(cs, svc, tx);
      note = `; upcoming visits rebuilt (${visits})`;
    } else if (changed.length) {
      await propagateToFutureJobs(cs, svc, tx);
    }
    return { cs, note };
  });

  if (changed.length) {
    const words = changed.map((k) => FIELD_LABELS[k] ?? k).join(", ");
    const priceBit = changed.includes("amount") ? ` (price ${existing.amount} → ${outcome.cs.amount})` : "";
    await logAudit({
      clientId: existing.clientId,
      actorName: req.appUser?.name,
      action: "service_updated",
      description: `Changed ${words} on "${svc.name}"${priceBit}${outcome.note}`,
    });
  }
  return res.json(await hydrateOne(outcome.cs));
});

router.delete("/client-services/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, id));
  if (!existing) return res.status(204).end();
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, existing.serviceId));
  await db.transaction(async (tx) => {
    // Only visits nobody has started: history stays on the account.
    await tx.delete(jobsTable).where(and(eq(jobsTable.clientServiceId, id), eq(jobsTable.status, "scheduled")));
    await tx.delete(clientServicesTable).where(eq(clientServicesTable.id, id));
  });
  await logAudit({
    clientId: existing.clientId,
    actorName: req.appUser?.name,
    action: "service_removed",
    description: `Removed "${svc?.name ?? `service #${existing.serviceId}`}" from the account; visits not yet done were taken off the board`,
  });
  return res.status(204).end();
});

// ---- history and upcoming ----

router.get("/client-services/:id/jobs", async (req, res) => {
  const id = Number(req.params.id);
  const [cs] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, id));
  if (!cs) return res.status(404).json({ error: "Client service not found" });
  const rows = await db.select().from(jobsTable).where(eq(jobsTable.clientServiceId, id));
  const hydrated = await hydrateJobs(rows);
  const dateOf = (j: (typeof hydrated)[number]) => j.scheduledDate ?? j.windowStart ?? "";
  const upcoming = hydrated
    .filter((j) => j.status === "scheduled" || j.status === "on_the_way" || j.status === "in_progress")
    .sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.id - b.id);
  const history = hydrated
    .filter((j) => j.status === "completed" || j.status === "skipped")
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || b.id - a.id);
  return res.json({ upcoming, history });
});

// ---- pause / resume / renew ----

router.post("/client-services/:id/pause", async (req, res) => {
  const body = PauseClientServiceBody.parse(req.body ?? {});
  const id = Number(req.params.id);
  const problem = dateFieldError("Resume date", body.pauseUntil);
  if (problem) return res.status(400).json({ error: problem });
  const [existing] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, id));
  if (!existing) return res.status(404).json({ error: "Client service not found" });
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, existing.serviceId));

  // The whole package pauses together when asked; one row otherwise.
  const targets =
    body.wholePackage && existing.packageId
      ? await db
          .select()
          .from(clientServicesTable)
          .where(and(eq(clientServicesTable.clientId, existing.clientId), eq(clientServicesTable.packageId, existing.packageId)))
      : [existing];

  const paused = await db.transaction(async (tx) => {
    const out: ClientService[] = [];
    for (const row of targets) {
      const [cs] = await tx
        .update(clientServicesTable)
        .set({
          pausedAt: new Date(),
          pauseUntil: body.pauseUntil ?? null,
          resumeWhenPaid: body.resumeWhenPaid ?? false,
          pauseReason: body.reason?.trim() || null,
        })
        .where(eq(clientServicesTable.id, row.id))
        .returning();
      await removeFutureJobs(cs.id, tx);
      out.push(cs);
    }
    return out;
  });

  const until = body.pauseUntil
    ? `until ${body.pauseUntil}`
    : body.resumeWhenPaid
      ? "until the account is paid"
      : "until someone resumes it";
  await logAudit({
    clientId: existing.clientId,
    actorName: req.appUser?.name,
    action: "service_paused",
    description:
      `Paused ${targets.length > 1 ? `the whole package (${targets.length} services)` : `"${svc?.name ?? "service"}"`} ${until}` +
      (body.reason ? ` — ${body.reason}` : "") +
      "; upcoming visits taken off the board",
  });
  return res.json(await hydrateOne(paused.find((p) => p.id === id) ?? paused[0]));
});

router.post("/client-services/:id/resume", async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, id));
  if (!existing) return res.status(404).json({ error: "Client service not found" });
  const resumed = await db.transaction((tx) =>
    resumeClientService(id, tx, { actorName: req.appUser?.name, reason: "resumed by the office" }),
  );
  if (!resumed) return res.status(404).json({ error: "Client service not found" });
  return res.json(await hydrateOne(resumed));
});

router.post("/client-services/:id/renew", async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, id));
  if (!existing) return res.status(404).json({ error: "Client service not found" });
  // A contract part-way through its term is not a season to roll over.
  const refusal = renewRefusal(existing);
  if (refusal) return res.status(400).json({ error: refusal });
  const renewed = await db.transaction((tx) => renewClientService(id, tx, { actorName: req.appUser?.name }));
  if (!renewed) return res.status(404).json({ error: "Client service not found" });
  return res.json(await hydrateOne(renewed));
});

/** The nightly check, on demand — for the office and for verifying it works. */
router.post("/client-services/run-daily", async (req, res) => {
  const result = await runClientServiceDailyTasks({ force: true });
  await logAudit({
    actorName: req.appUser?.name,
    action: "service_daily_run",
    description: `Ran the assigned-services check by hand: ${result.resumed} resumed, ${result.renewed} renewed`,
  });
  return res.json(result);
});

// ---- contractor: the must-read note ----

/**
 * The crew opened the note. Recorded on the visit so Start unlocks, and so
 * the office can see it was read if the instruction gets missed anyway.
 */
router.post("/my/jobs/:id/note-read", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, id));
  if (!job) return res.status(404).json({ error: "Job not found" });
  const isAdmin = req.appUser?.role === "admin";
  if (!isAdmin && !(job.assignedToId === req.appUser?.id && job.dispatched && job.visibleToContractor)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const [updated] = job.noteAcknowledgedAt
    ? [job]
    : await db.update(jobsTable).set({ noteAcknowledgedAt: new Date() }).where(eq(jobsTable.id, id)).returning();
  if (!job.noteAcknowledgedAt) {
    await logAudit({
      clientId: job.clientId,
      actorName: req.appUser?.name,
      action: "job_note_read",
      description: `${req.appUser?.name ?? "Someone"} opened the crew note on job #${id}`,
    });
  }
  return res.json((await hydrateJobs([updated]))[0]);
});

export default router;
