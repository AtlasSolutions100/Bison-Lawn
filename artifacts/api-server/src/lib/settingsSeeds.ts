import { db, auditEventsTable, chargePresetsTable, ticketCategoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logAudit } from "./helpers";

/**
 * The two lists he handed us on 2026-09-28, seeded so he opens the screen and
 * finds his own words instead of an empty box with an Add button.
 *
 * Both seeds run at most once ever, marked in the audit trail rather than
 * guarded by "is the table empty". Emptiness is the wrong question: after he
 * deletes a category he does not use, a restart would put it straight back,
 * and arguing with the app about its own list is exactly the kind of thing
 * that makes him stop trusting it.
 */

/**
 * His list, in his order and his spelling: "Ticket Categories, Account Issue,
 * Billing, Cancel Request, Change Service, Email, Estimate, other, Reschedule
 * request, Review, Schedule Service, Terminate service, Upsell, Marketing."
 *
 * Not alphabetised. He typed them in the order he thinks about them, and the
 * list is short enough to read, so the order is his.
 */
export const TICKET_CATEGORY_SEEDS = [
  "Account Issue",
  "Billing",
  "Cancel Request",
  "Change Service",
  "Email",
  "Estimate",
  "Other",
  "Reschedule request",
  "Review",
  "Schedule Service",
  "Terminate service",
  "Upsell",
  "Marketing",
] as const;

const TICKET_CATEGORY_SEED_MARKER = "ticket_categories_seeded";

/**
 * The parts he named: "Customer Lines — Products, Examples. Small bags,
 * pinecones, beagle to add to with sprinkler parts."
 *
 * Seeded at $0 on purpose. We do not know what he charges for a bag, and a
 * guessed price is worse than a blank one: a guess rides onto a customer's
 * invoice the first time a crew member adds it, whereas a zero is obvious on
 * the Settings screen and on the job line, and he fixes it in one box.
 */
export const PRODUCT_PRESET_SEEDS: { label: string; unit: string }[] = [
  { label: "Small bags", unit: "bag" },
  { label: "Pinecones", unit: "bag" },
  { label: "Sprinkler parts", unit: "each" },
];

const PRODUCT_PRESET_SEED_MARKER = "product_presets_seeded";

/** Whether a one-time seed has already run, by its audit marker. */
async function alreadySeeded(marker: string): Promise<boolean> {
  const [done] = await db
    .select({ id: auditEventsTable.id })
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, marker))
    .limit(1);
  return done != null;
}

async function seedTicketCategories(): Promise<number> {
  if (await alreadySeeded(TICKET_CATEGORY_SEED_MARKER)) return 0;

  // Anything already on the list wins: this runs for the first time against a
  // database that may already have categories somebody typed by hand.
  const existing = await db.select({ name: ticketCategoriesTable.name }).from(ticketCategoriesTable);
  const taken = new Set(existing.map((row) => row.name.trim().toLowerCase()));
  const rows = TICKET_CATEGORY_SEEDS.filter((name) => !taken.has(name.toLowerCase())).map((name, index) => ({
    name,
    sortOrder: (taken.size + index + 1) * 10,
  }));
  if (rows.length) await db.insert(ticketCategoriesTable).values(rows);
  await logAudit({
    action: TICKET_CATEGORY_SEED_MARKER,
    description: `Put your ticket category list in Settings (${rows.length} categories)`,
  });
  return rows.length;
}

async function seedProductPresets(): Promise<number> {
  if (await alreadySeeded(PRODUCT_PRESET_SEED_MARKER)) return 0;

  const existing = await db
    .select({ label: chargePresetsTable.label })
    .from(chargePresetsTable)
    .where(eq(chargePresetsTable.kind, "product"));
  const taken = new Set(existing.map((row) => row.label.trim().toLowerCase()));
  const rows = PRODUCT_PRESET_SEEDS.filter((seed) => !taken.has(seed.label.toLowerCase())).map((seed, index) => ({
    label: seed.label,
    defaultPrice: 0,
    kind: "product",
    unit: seed.unit,
    // The crew is who adds these on site; that is the whole point of the list.
    contractorCanAdd: true,
    sortOrder: (taken.size + index + 1) * 10,
  }));
  if (rows.length) await db.insert(chargePresetsTable).values(rows);
  await logAudit({
    action: PRODUCT_PRESET_SEED_MARKER,
    description: `Started your parts and fees list with ${rows.length} of your examples — set the prices in Settings`,
  });
  return rows.length;
}

let ticketCategoriesRun: Promise<number> | null = null;
let productPresetsRun: Promise<number> | null = null;

/** Share one run between concurrent callers so the seed cannot race itself. */
function once(
  slot: () => Promise<number> | null,
  set: (value: Promise<number> | null) => void,
  work: () => Promise<number>,
): Promise<number> {
  const current = slot();
  if (current) return current;
  const run = work().catch((err) => {
    // Let the next caller try again rather than pinning a failure for the life
    // of the process.
    set(null);
    throw err;
  });
  set(run);
  return run;
}

export function ensureTicketCategoriesOnce(): Promise<number> {
  return once(
    () => ticketCategoriesRun,
    (value) => { ticketCategoriesRun = value; },
    seedTicketCategories,
  );
}

export function ensureProductPresetsOnce(): Promise<number> {
  return once(
    () => productPresetsRun,
    (value) => { productPresetsRun = value; },
    seedProductPresets,
  );
}
