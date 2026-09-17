import { Router, type IRouter } from "express";
import { db, servicesTable, packagesTable, estimateFieldsTable, type PackageItem } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  CreateServiceBody,
  UpdateServiceBody,
  CalculateServicePriceBody,
  CreatePackageBody,
  UpdatePackageBody,
  BulkAdjustServicePricesBody,
  CopyServiceMatrixBody,
  BuildMatrixFromRuleBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import {
  priceService,
  isPriceableFieldType,
  isPricedBand,
  dateFieldError,
  logAudit,
  scalePrice,
  scaleEquations,
  bandsFromRule,
  type PriceScale,
} from "../lib/helpers";

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

/**
 * The code and the invoice description are typed, so a stray space must not
 * become a different code, and an emptied box means "none" rather than "".
 */
function textFields(body: { code?: string | null; invoiceDescription?: string | null }) {
  return {
    ...(body.code !== undefined ? { code: body.code?.trim() || null } : {}),
    ...(body.invoiceDescription !== undefined
      ? { invoiceDescription: body.invoiceDescription?.trim() || null }
      : {}),
  };
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
    .values({ ...body, ...textFields(body), vendorName: body.vendorName?.trim() || null })
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
    ...textFields(body),
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
      const listed = pkg.serviceIds.includes(serviceId) || pkg.items.some((item) => item.serviceId === serviceId);
      if (!listed) continue;
      await tx
        .update(packagesTable)
        .set({
          serviceIds: pkg.serviceIds.filter((id) => id !== serviceId),
          items: pkg.items.filter((item) => item.serviceId !== serviceId),
        })
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

/** "×1.5", "+$5", "+10%", ", rounded to $0.50" — for the audit line and the toast. */
function scaleLabel(scale: PriceScale) {
  const change =
    scale.mode === "multiply" ? `×${scale.value}` : scale.mode === "add" ? `+$${scale.value}` : `+${scale.value}%`;
  return scale.roundTo ? `${change}, rounded to $${scale.roundTo}` : change;
}

/**
 * "Copy a matrix from one service to another (Bison App 1 -> 2..8), optionally
 * multiplied (one-time mow = 1.5x mowing)". He types the bands once and pushes
 * them onto the sister services; the maths is in scaleEquations. Nothing is
 * written unless `apply` is set, so the office sees exactly what each target
 * gets first, and a target that already has priced bands is only replaced
 * when `overwrite` says so — a hand-typed matrix is not something to lose to
 * one click.
 */
router.post("/services/:id/copy-matrix", async (req, res) => {
  const body = CopyServiceMatrixBody.parse(req.body);
  const sourceId = Number(req.params.id);
  const [source] = await db.select().from(servicesTable).where(eq(servicesTable.id, sourceId));
  if (!source) return res.status(404).json({ error: "Service not found" });

  const mode = body.mode ?? "multiply";
  const scale: PriceScale = {
    mode,
    value: body.value ?? (mode === "multiply" ? 1 : 0),
    roundTo: body.roundTo ?? null,
  };
  if (mode === "multiply" && !(scale.value > 0)) {
    return res.status(400).json({ error: "Multiply by a number above zero." });
  }
  if (!source.pricingEquations.some(isPricedBand)) {
    return res.status(400).json({ error: `"${source.name}" has no priced bands to copy.` });
  }

  // Copying a service onto itself is a no-op at best and a scaled self-overwrite
  // at worst, so it is dropped rather than refused.
  const targetIds = [...new Set(body.targetServiceIds)].filter((id) => id !== sourceId);
  if (targetIds.length === 0) {
    return res.status(400).json({ error: "Pick at least one other service to copy the matrix to." });
  }
  const found = await db.select().from(servicesTable).where(inArray(servicesTable.id, targetIds));
  const byId = new Map(found.map((s) => [s.id, s]));
  const missing = targetIds.filter((id) => !byId.has(id));
  if (missing.length) {
    return res.status(404).json({ error: `Service ${missing.join(", ")} not found` });
  }

  const equations = scaleEquations(source.pricingEquations, scale, { scaleCost: true });
  const copyField = body.copyPricingField ?? true;
  const targets = targetIds.map((id) => {
    const service = byId.get(id)!;
    return {
      service,
      existingBands: service.pricingEquations.filter(isPricedBand).length,
      pricingFieldChanged: copyField && (service.pricingFieldId ?? null) !== (source.pricingFieldId ?? null),
    };
  });

  const apply = body.apply === true;
  if (apply) {
    const clobbered = targets.filter((t) => t.existingBands > 0);
    if (clobbered.length && body.overwrite !== true) {
      return res.status(400).json({
        error: `${clobbered.map((t) => `"${t.service.name}"`).join(", ")} already ${clobbered.length === 1 ? "has" : "have"} a matrix. Tick "replace what is there" to overwrite it.`,
      });
    }
    await db.transaction(async (tx) => {
      for (const { service } of targets) {
        await tx
          .update(servicesTable)
          .set({
            pricingEquations: equations,
            ...(copyField ? { pricingFieldId: source.pricingFieldId ?? null } : {}),
          })
          .where(eq(servicesTable.id, service.id));
      }
    });
    await logAudit({
      action: "service_matrix_copied",
      description: `Copied the "${source.name}" matrix (${equations.length} bands, ${scaleLabel(scale)}) to ${targets.map((t) => `"${t.service.name}"`).join(", ")}`,
      actorName: req.appUser?.name,
    });
  }

  return res.json({
    applied: apply,
    sourceServiceId: source.id,
    sourceServiceName: source.name,
    targets: targets.map((t) => ({
      serviceId: t.service.id,
      serviceName: t.service.name,
      existingBands: t.existingBands,
      equations,
      pricingFieldChanged: t.pricingFieldChanged,
    })),
  });
});

/**
 * "Rate matrix rule: $X per 1000 sqft up to Y; Bison application: $X per 500
 * up to Y." Pure: nothing is saved, the bands come back for the form so the
 * tool works on a service that has not been created yet, and he can edit any
 * row before Save.
 */
router.post("/services/matrix-from-rule", async (req, res) => {
  const body = BuildMatrixFromRuleBody.parse(req.body);
  try {
    return res.json({ equations: bandsFromRule(body) });
  } catch (error) {
    const message = serviceBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
});

// A service priced by equations ignores `rate` entirely (see priceService in
// lib/helpers.ts), so a seasonal repricing that only touched `rate` would
// silently do nothing for exactly the services that matter most. basePrice and
// incrementPrice are money; baseSqft/incrementSqft/upToSqft are measurements
// (or, for upToSqft, a measurement threshold) and must not be touched.
router.post("/services/bulk-price-adjust", async (req, res) => {
  const body = BulkAdjustServicePricesBody.parse(req.body);
  const apply = body.apply === true;
  const scale: PriceScale = {
    mode: body.mode === "percent" ? "percent" : "add",
    value: body.amount,
    roundTo: body.roundTo,
  };

  const services = body.serviceIds?.length
    ? await db.select().from(servicesTable).where(inArray(servicesTable.id, body.serviceIds))
    : await db.select().from(servicesTable);

  const changes = services.map((service) => {
    const newRate = scalePrice(service.rate, scale);
    // The same scaling a copied matrix gets, for the same reason: an empty
    // row left by an "Add tier" click carries no money, and "+$5 for the
    // season" must not turn it into a $5 band. Mowing's last row is one of
    // those, and a $5 open-ended band would then price every big property at
    // $5 on every estimate, job and invoice raised from it.
    const newEquations = scaleEquations(service.pricingEquations, scale);
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

/**
 * A package is a list of entries, and the same service may be on it more than
 * once — "Sprinkler timer adjustment" four times with a window each, "core
 * aeration" as Aeration twice. `items` is what is stored; `serviceIds` is
 * derived from it (one id per entry, repeats kept, same order) so older
 * readers of the id list see the same package. A caller that only sends ids
 * gets plain entries made from them.
 */
function entriesFrom(
  body: { items?: PackageItem[]; serviceIds?: number[] },
  // The package's own window, so an entry can be judged against the dates it
  // will actually inherit at assign time.
  packageWindow: { startDate?: string | null; endDate?: string | null } = {},
): PackageItem[] | undefined {
  const items: PackageItem[] | undefined =
    body.items ?? body.serviceIds?.map((serviceId): PackageItem => ({ serviceId }));
  if (!items) return undefined;
  const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
  items.forEach((item, index) => {
    // Name the entry in every complaint. A sprinkler package carries the same
    // service four times, and "window end cannot be before window start" with
    // nothing else told the office to check all four by hand.
    const which = item.label?.trim() ? `Entry ${index + 1} "${item.label.trim()}"` : `Entry ${index + 1}`;
    for (const [label, value] of [
      ["Window start", item.windowStart],
      ["Window end", item.windowEnd],
    ] as const) {
      const problem = dateFieldError(label, value);
      if (problem) throw bad(`${which}: ${problem}`);
    }
    if (item.windowStart && item.windowEnd && item.windowEnd < item.windowStart) {
      throw bad(`${which}: an entry's window cannot end before it starts`);
    }
    // Assigning the package fills in whichever side the entry leaves blank
    // from the package's own dates (see routes/client-services.ts), so a
    // half-filled window that ends before the package begins saves happily
    // here and then kills the whole assignment later — not one entry, the
    // lot. Refuse it while he is still looking at the entry that caused it.
    const start = item.windowStart || packageWindow.startDate || null;
    const end = item.windowEnd || packageWindow.endDate || null;
    if (start && end && end < start) {
      throw bad(
        `${which}: that window would run ${start} to ${end}, which is outside the package's ${packageWindow.startDate ?? "?"} to ${packageWindow.endDate ?? "?"}. Give the entry both dates, or widen the package.`,
      );
    }
  });
  return items.map((item) => ({
    serviceId: item.serviceId,
    label: item.label?.trim() || null,
    windowStart: item.windowStart || null,
    windowEnd: item.windowEnd || null,
  }));
}

async function withServices(pkg: typeof packagesTable.$inferSelect) {
  // Rows saved before entries existed only carry the id list.
  const entries: PackageItem[] = pkg.items?.length ? pkg.items : pkg.serviceIds.map((serviceId) => ({ serviceId }));
  const wanted = [...new Set(entries.map((item) => item.serviceId))];
  const found = wanted.length
    ? await db.select().from(servicesTable).where(inArray(servicesTable.id, wanted))
    : [];
  const byId = new Map(found.map((s) => [s.id, s]));
  // `service_ids` is a plain jsonb array with no foreign key, so deleting a
  // service used to leave its id sitting in every package that referenced it.
  // The package then went on claiming a service that no longer existed —
  // reported as "Sprinkler Package says price 5 services but only should be 3".
  // Deleting now cleans up after itself, but rows that already carry a dangling
  // id have to report honestly too, so resolve the ids and return what is
  // actually there. Order is the author's, which `inArray` does not preserve,
  // and a repeated entry stays repeated: `services` has one element per entry.
  const items = entries.filter((item) => byId.has(item.serviceId));
  return {
    ...pkg,
    items,
    serviceIds: items.map((item) => item.serviceId),
    services: items.map((item) => byId.get(item.serviceId)!),
  };
}

router.get("/packages", async (_req, res) => {
  const pkgs = await db.select().from(packagesTable).orderBy(packagesTable.name);
  return res.json(await Promise.all(pkgs.map(withServices)));
});

router.post("/packages", async (req, res) => {
  const body = CreatePackageBody.parse(req.body);
  let items: PackageItem[];
  try {
    items = entriesFrom(body, { startDate: body.startDate, endDate: body.endDate }) ?? [];
  } catch (error) {
    const message = serviceBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  const [pkg] = await db.insert(packagesTable).values({
    name: body.name,
    description: body.description,
    serviceIds: items.map((item) => item.serviceId),
    items,
    scheduleType: body.scheduleType,
    startDate: body.startDate,
    endDate: body.endDate,
    frequencyWeeks: body.frequencyWeeks,
    seasonEndDate: body.seasonEndDate,
    renewDate: body.renewDate,
  }).returning();
  await logAudit({
    action: "package_created",
    description: `Created package "${pkg.name}" with ${items.length} ${items.length === 1 ? "entry" : "entries"}`,
    actorName: req.appUser?.name,
  });
  return res.status(201).json(await withServices(pkg));
});

router.patch("/packages/:id", async (req, res) => {
  const body = UpdatePackageBody.parse(req.body);
  // The window the entries will be judged against is whatever the package ends
  // up with: the dates in this edit if he retyped them, else the saved ones.
  const [existing] = await db
    .select()
    .from(packagesTable)
    .where(eq(packagesTable.id, Number(req.params.id)));
  if (!existing) return res.status(404).json({ error: "Package not found" });
  let items: PackageItem[] | undefined;
  try {
    items = entriesFrom(body, {
      // Explicit null means he cleared the package window, which is not the
      // same as leaving it alone.
      startDate: body.startDate !== undefined ? body.startDate : existing.startDate,
      endDate: body.endDate !== undefined ? body.endDate : existing.endDate,
    });
  } catch (error) {
    const message = serviceBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  const [pkg] = await db
    .update(packagesTable)
    .set({
      name: body.name,
      description: body.description,
      ...(items ? { serviceIds: items.map((item) => item.serviceId), items } : {}),
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
  await logAudit({
    action: "package_updated",
    description: items
      ? `Updated package "${pkg.name}" — now ${items.length} ${items.length === 1 ? "entry" : "entries"}`
      : `Updated package "${pkg.name}"`,
    actorName: req.appUser?.name,
  });
  return res.json(await withServices(pkg));
});

router.delete("/packages/:id", async (req, res) => {
  await db.delete(packagesTable).where(eq(packagesTable.id, Number(req.params.id)));
  return res.status(204).end();
});

export default router;
