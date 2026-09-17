import {
  db,
  auditEventsTable,
  clientsTable,
  invoicesTable,
  paymentsTable,
  billingSettingsTable,
} from "@workspace/db";
import type { BillingSettings } from "@workspace/db";
import type { EstimateField, PricingEquation } from "@workspace/db";
import { and, eq, ne, sum } from "drizzle-orm";

/** Round a monetary value to whole cents. */
export function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reject anything that is not a real yyyy-mm-dd calendar date. Null and empty are
 * allowed — the caller decides which fields are required. Without this an invalid
 * string reaches `new Date(...)` during job generation and throws mid-write.
 *
 * Shared, because a date typed on a package entry has to be judged by the same
 * rule as the one typed on the account it will become: a "2026-02-31" that a
 * package accepted only fails later, on the assignment, where nothing says
 * which entry it came from.
 */
export function dateFieldError(label: string, value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (!ISO_DATE_RE.test(value)) return `${label} must be a date in yyyy-mm-dd format`;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return `${label} is not a real calendar date`;
  }
  return null;
}

export async function logAudit(opts: {
  clientId?: number | null;
  actorName?: string | null;
  action: string;
  description: string;
  /** Which record this is about ('invoice' | 'payment' | 'job'), so that record can show its own history. */
  entityType?: string | null;
  entityId?: number | null;
}) {
  await db.insert(auditEventsTable).values({
    clientId: opts.clientId ?? null,
    actorName: opts.actorName ?? null,
    action: opts.action,
    description: opts.description,
    entityType: opts.entityType ?? null,
    entityId: opts.entityId ?? null,
  });
}

/**
 * Equation-based pricing: pick the first equation whose upToSqft covers
 * `value` (null = unbounded, checked last in array order). Price = basePrice
 * for the first baseSqft, plus incrementPrice per incrementSqft chunk
 * (rounded up) beyond that.
 *
 * The equation fields are still named *Sqft for historical reasons (no data
 * migration was done when this became configurable), but the maths only ever
 * cared about "a quantity of some unit" — it never actually required that
 * unit to be square footage. `value` is that quantity in whichever unit
 * `service.pricingFieldId` designates (an estimate field such as "Sprinkler
 * Zones"), or turf square footage when pricingFieldId is null. calculatePrice
 * itself has no way to check that a caller measured in the right unit — use
 * priceService() below when you have a Service row and want that checked for
 * you instead of silently pricing a zone count as if it were square footage.
 */
export function calculatePrice(
  equations: PricingEquation[],
  value: number,
): { price: number; equationIndex: number | null } {
  if (!equations || equations.length === 0) return { price: 0, equationIndex: null };

  // A band carrying no money at all is a placeholder — an empty row left by an
  // "Add tier" click or by an import that had nothing to put in it. It used to
  // match like any other band and price the job at zero: on the live system a
  // 30,000 sqft mow quoted $0.00, and so would the invoice raised when that job
  // completed. Only bands that actually carry a price may price a job.
  const priced = equations.filter((e) => e.basePrice > 0 || e.incrementPrice > 0);
  if (priced.length === 0) return { price: 0, equationIndex: null };

  let match = priced.find((e) => e.upToSqft != null && value <= e.upToSqft);
  // No ceiling reached: an open-ended band if there is one, otherwise the
  // largest band that has a price. That still under-prices a property bigger
  // than anything in the matrix, but it under-prices it visibly — a number the
  // office recognises as the top-band rate — rather than silently as nothing.
  if (!match) match = priced.find((e) => e.upToSqft == null) ?? priced[priced.length - 1];
  const eq_ = match;
  // Index into the caller's array, not the filtered one: callers read
  // budgetedHours back out of service.pricingEquations[equationIndex].
  const idx = equations.indexOf(eq_);
  let price = eq_.basePrice;
  if (value > eq_.baseSqft && eq_.incrementSqft > 0) {
    const extra = value - eq_.baseSqft;
    price += Math.ceil(extra / eq_.incrementSqft) * eq_.incrementPrice;
  }
  return { price: Math.round(price * 100) / 100, equationIndex: idx };
}

/**
 * "text" and "boolean" estimate fields (Gate Code, has-dog) carry no number,
 * so pointing a service's pricingFieldId at one would silently price as NaN.
 * "calculable" and "number" fields both carry a real quantity, so either is
 * fine as pricing input even though only "calculable" fields also have their
 * own pricePerUnit/unitSize for direct estimate-line pricing.
 */
export function isPriceableFieldType(fieldType: EstimateField["fieldType"]): boolean {
  return fieldType === "calculable" || fieldType === "number";
}

/**
 * calculatePrice() takes a bare number, which is exactly how the earlier
 * sqft-only version silently invited the bug this wrapper exists to prevent:
 * nothing stopped a caller from handing it a zone count while believing it
 * meant square footage. Callers that have a Service row and a raw input
 * should come through here instead, passing the EstimateField the service's
 * pricingFieldId resolves to (or null for turf sqft) — so "which field is
 * this number measured in" is answered once, explicitly, and a field that
 * cannot carry a number (text/boolean) is rejected instead of silently
 * pricing as NaN.
 */
export function priceService(
  service: { pricingEquations: PricingEquation[] },
  field: EstimateField | null,
  value: number,
): { price: number; equationIndex: number | null; field: EstimateField | null } {
  if (field && !isPriceableFieldType(field.fieldType)) {
    throw Object.assign(
      new Error(`"${field.label}" is a ${field.fieldType} field and has no number to price against.`),
      { status: 400 },
    );
  }
  return { ...calculatePrice(service.pricingEquations, value), field };
}

/** A band that carries money. Anything else is an empty row left by "Add tier". */
export function isPricedBand(equation: PricingEquation): boolean {
  return equation.basePrice > 0 || equation.incrementPrice > 0;
}

/**
 * How one price is changed when a matrix is copied or repriced: multiplied
 * ("one-time mow is 1.5x mowing"), plus a dollar amount, or plus a percent
 * (the season repricer). `roundTo` snaps the result to an increment so $49 x
 * 1.5 can come out as $73.50 or $74 rather than something the office would
 * never quote. Never negative — a discount cannot invent a service that pays
 * the customer.
 */
export type PriceScale = {
  mode: "multiply" | "add" | "percent";
  value: number;
  roundTo?: number | null;
};

export function scalePrice(amount: number, scale: PriceScale): number {
  let next =
    scale.mode === "multiply"
      ? amount * scale.value
      : scale.mode === "percent"
        ? amount * (1 + scale.value / 100)
        : amount + scale.value;
  if (scale.roundTo && scale.roundTo > 0) next = Math.round(next / scale.roundTo) * scale.roundTo;
  return roundMoney(Math.max(0, next));
}

/**
 * The bands of one service, scaled for another. "Bison App 1" is the matrix he
 * types once; Apps 2 to 8 are the same bands at a different price, and a
 * one-time mow is the mowing matrix at 1.5x. The measurements (To, base
 * quantity, step size) travel untouched; only money moves.
 *
 * - An empty band stays empty: "add $5" must not turn a placeholder row into a
 *   $5 band that then prices a job.
 * - The per-step increment scales with multiply/percent but not with add —
 *   adding $5 to every step would compound on a big property.
 * - Budgeted cost follows the rate on multiply/percent when `scaleCost` is on
 *   (his costs are 75-85% of the rate, so a 1.5x service costs 1.5x to
 *   deliver), and is left alone on add. Hours are never touched: the job takes
 *   as long as it takes whatever it is billed at.
 */
export function scaleEquations(
  equations: PricingEquation[],
  scale: PriceScale,
  options: { scaleCost?: boolean } = {},
): PricingEquation[] {
  const proportional = scale.mode !== "add";
  return equations.map((equation) => {
    if (!isPricedBand(equation)) return { ...equation };
    const scaled: PricingEquation = {
      ...equation,
      basePrice: scalePrice(equation.basePrice, scale),
      incrementPrice:
        proportional && equation.incrementPrice ? scalePrice(equation.incrementPrice, scale) : equation.incrementPrice,
    };
    if (options.scaleCost && proportional && equation.budgetedCost != null) {
      // Cents only: cost is an internal figure, not a quoted price.
      scaled.budgetedCost = scalePrice(equation.budgetedCost, { ...scale, roundTo: null });
    }
    return scaled;
  });
}

/**
 * His matrices are rules before they are tables: "$X per 1000 sqft up to Y"
 * for mowing, "$X per 500 up to Y" for a Bison application, then sometimes a
 * second, cheaper step above that ("$4.50 per 2k above 20k"). Typing forty
 * bands by hand to express one sentence is how the empty-row bug happened.
 * This builds the rows from the sentence; he edits after.
 *
 * The start price covers the first step. Each further step of `stepSize`
 * adds `pricePerStep`, up to `upTo` (a short last step when the ceiling is
 * not a multiple). A tier with no ceiling becomes one final "and up" band
 * that keeps stepping, using the base+increment form calculatePrice already
 * understands — so a property bigger than any ceiling still prices.
 */
export type MatrixRuleTier = { pricePerStep: number; stepSize: number; upTo?: number | null };
export type MatrixRule = {
  startPrice: number;
  firstTier: MatrixRuleTier;
  secondTier?: MatrixRuleTier | null;
  costPercent?: number | null;
};

/** Enough for 500 sqft steps up to 200,000 sqft; more than that is a typo. */
export const MAX_RULE_BANDS = 400;

export function bandsFromRule(rule: MatrixRule): PricingEquation[] {
  const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
  const costOf = (price: number) =>
    rule.costPercent != null && rule.costPercent > 0 ? roundMoney((price * rule.costPercent) / 100) : null;
  const band = (upToSqft: number | null, basePrice: number, extra: Partial<PricingEquation> = {}): PricingEquation => ({
    upToSqft,
    basePrice: roundMoney(basePrice),
    baseSqft: 0,
    incrementPrice: 0,
    incrementSqft: 0,
    budgetedHours: null,
    budgetedCost: costOf(basePrice),
    ...extra,
  });

  const tiers = [rule.firstTier, ...(rule.secondTier ? [rule.secondTier] : [])];
  for (const tier of tiers) {
    if (!(tier.stepSize > 0)) throw bad("Each step must be bigger than zero.");
    if (tier.pricePerStep < 0) throw bad("The price per step cannot be negative.");
  }
  if (rule.startPrice < 0) throw bad("The start price cannot be negative.");
  if (rule.firstTier.upTo == null && rule.secondTier) {
    throw bad("The first tier has no ceiling, so a second tier could never start. Give the first tier an up-to.");
  }

  const bands: PricingEquation[] = [];
  let price = rule.startPrice;
  // The first band is the start price for the first step (or the whole tier,
  // if the ceiling is lower than one step).
  let floor = rule.firstTier.upTo == null
    ? rule.firstTier.stepSize
    : Math.min(rule.firstTier.stepSize, rule.firstTier.upTo);
  if (!(floor > 0)) throw bad("The first tier's up-to must be bigger than zero.");
  bands.push(band(floor, price));

  for (const [index, tier] of tiers.entries()) {
    if (tier.upTo == null) {
      // "and up": base+increment from where the last band stopped.
      bands.push(
        band(null, price, { baseSqft: floor, incrementSqft: tier.stepSize, incrementPrice: roundMoney(tier.pricePerStep) }),
      );
      break;
    }
    if (tier.upTo <= floor) {
      // "$60 covers the first 4 zones, then $5 a zone after": the first tier's
      // whole ceiling is inside its own first step, so the start-price band
      // above already is that tier and there is nothing left to step through.
      // Only a *second* tier that stops at or below the first is really the
      // mistake this message is about.
      if (index === 0) continue;
      throw bad(`A tier's up-to (${tier.upTo}) must be above where the previous one stopped (${floor}).`);
    }
    while (floor < tier.upTo) {
      const top = Math.min(floor + tier.stepSize, tier.upTo);
      price += tier.pricePerStep;
      bands.push(band(top, price));
      floor = top;
      if (bands.length > MAX_RULE_BANDS) {
        throw bad(`That rule makes more than ${MAX_RULE_BANDS} bands. Use a bigger step or a lower ceiling.`);
      }
    }
  }
  return bands;
}

/**
 * A drizzle transaction handle, or the base db when no transaction is open.
 * Money helpers take one so a caller can fold them into its own transaction.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Recompute a client's account balance = sum(non-void invoice totals) - sum(payments).
 *
 * Payments are counted whether or not they are attached to an invoice: an unattached
 * payment is credit on the account, and credit legitimately pushes the balance below
 * zero. Voiding an invoice therefore has to detach its payments (see the void handler
 * in routes/billing.ts) — otherwise the invoice leaves the total while its payment
 * stays counted, inventing credit that was never received.
 */
export async function recalcClientBalance(clientId: number, tx: Executor = db) {
  // Serialize on the client row. This is a read-then-write aggregate, so without the
  // lock two payments landing on *different* invoices of the same client would each
  // sum a partial payment set and the later writer would persist a stale total.
  // Callers holding an invoice lock must take this one after it: the lock order is
  // always invoice -> client, so no two paths can deadlock against each other.
  //
  // "No key update", not "update": every payment or invoice row inserted just
  // before this call points at the client, and Postgres quietly holds a KEY
  // SHARE on the client for that. Two payments landing at once (the sub takes
  // cash while the office keys a check) would each hold a key share and then
  // each wait for the other's to clear — a deadlock and a 500 for one of them.
  // Nobody here changes the client's id, so the weaker lock is enough: it still
  // lets only one balance recalculation through at a time.
  await tx
    .select({ id: clientsTable.id })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId))
    .for("no key update");
  const [inv] = await tx
    .select({ total: sum(invoicesTable.total) })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.clientId, clientId), ne(invoicesTable.status, "void")));
  const [pay] = await tx
    .select({ total: sum(paymentsTable.amount) })
    .from(paymentsTable)
    .where(eq(paymentsTable.clientId, clientId));
  const balance = roundMoney(Number(inv?.total ?? 0) - Number(pay?.total ?? 0));
  await tx
    .update(clientsTable)
    .set({ accountBalance: balance })
    .where(eq(clientsTable.id, clientId));
  return balance;
}

/** Refresh an invoice's amountPaid + status from its payments. */
export async function recalcInvoice(invoiceId: number, tx: Executor = db) {
  const [inv] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!inv) return;
  if (inv.status === "void") {
    // A void invoice keeps no payments (they are detached to credit when it is
    // voided), so its paid figure is always zero rather than a stale leftover.
    if (inv.amountPaid !== 0) {
      await tx.update(invoicesTable).set({ amountPaid: 0 }).where(eq(invoicesTable.id, invoiceId));
    }
    return;
  }
  const [pay] = await tx
    .select({ total: sum(paymentsTable.amount) })
    .from(paymentsTable)
    .where(eq(paymentsTable.invoiceId, invoiceId));
  const paid = roundMoney(Number(pay?.total ?? 0));
  const total = roundMoney(inv.total);
  // Money in hand wins: a bill paid in full is paid, whether or not the office
  // has checked it yet. Checking is tracked by verifiedAt, not by the status,
  // so a paid-at-the-door bill still sits in Needs verification until he
  // presses Verify — and pressing Verify never un-pays it. Anything short of
  // the full amount on an unchecked bill stays pending: he has not billed the
  // rest yet, so it is not "open" or "partial" in any sense the customer sees.
  // Verify sets verifiedAt and then comes back through here to settle
  // open / partial from what was paid.
  const fullyPaid = paid > 0 && paid >= total;
  const status = fullyPaid
    ? "paid"
    : !inv.verifiedAt
      ? "pending"
      : paid <= 0
        ? "open"
        : "partial";
  await tx
    .update(invoicesTable)
    .set({ amountPaid: paid, status })
    .where(eq(invoicesTable.id, invoiceId));
}

/** Singleton billing settings row; created with defaults on first read. */
export async function getBillingSettings(): Promise<BillingSettings> {
  const [existing] = await db.select().from(billingSettingsTable).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(billingSettingsTable)
    .values({})
    .returning();
  return created;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Nearest-neighbor + 2-opt route over points starting from base. Returns visit order (indices). */
export function optimizeRoute(
  base: { lat: number; lng: number },
  points: { lat: number; lng: number }[],
): number[] {
  const n = points.length;
  if (n <= 1) return points.map((_, i) => i);

  const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
    haversineKm(a.lat, a.lng, b.lat, b.lng);

  // Nearest neighbor
  const visited = new Array(n).fill(false);
  const order: number[] = [];
  let cur = base;
  for (let k = 0; k < n; k++) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const d = dist(cur, points[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    visited[best] = true;
    order.push(best);
    cur = points[best];
  }

  // 2-opt improvement
  const tourDist = (ord: number[]) => {
    let d = dist(base, points[ord[0]]);
    for (let i = 0; i < ord.length - 1; i++) d += dist(points[ord[i]], points[ord[i + 1]]);
    return d;
  };
  let improved = true;
  let iterations = 0;
  while (improved && iterations < 200) {
    improved = false;
    iterations++;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        if (tourDist(candidate) < tourDist(order) - 1e-9) {
          order.splice(0, n, ...candidate);
          improved = true;
        }
      }
    }
  }
  return order;
}
