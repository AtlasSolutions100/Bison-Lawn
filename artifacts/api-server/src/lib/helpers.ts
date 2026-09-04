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

export async function logAudit(opts: {
  clientId?: number | null;
  actorName?: string | null;
  action: string;
  description: string;
}) {
  await db.insert(auditEventsTable).values({
    clientId: opts.clientId ?? null,
    actorName: opts.actorName ?? null,
    action: opts.action,
    description: opts.description,
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
  await tx
    .select({ id: clientsTable.id })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId))
    .for("update");
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
  const status = paid <= 0 ? "open" : paid >= total ? "paid" : "partial";
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
