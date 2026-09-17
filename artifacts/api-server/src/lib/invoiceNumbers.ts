import { sql } from "drizzle-orm";
import { db, invoicesTable } from "@workspace/db";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Where numbering starts when the table holds no numbered invoice yet.
 *
 * His most recent invoice at handover was #4848. Starting a fresh sequence at 1
 * would put our #1 alongside his #4848 in the same customer's inbox, which
 * reads as a different company or a mistake. Overridable so a second client on
 * this codebase can start from their own history instead.
 */
const DEFAULT_FIRST_NUMBER = 4900;

/** His standard terms when a customer has none written down. */
const DEFAULT_TERMS_DAYS = 15;

function configuredFirstNumber(): number {
  const raw = process.env.INVOICE_NUMBER_START?.trim();
  if (!raw) return DEFAULT_FIRST_NUMBER;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FIRST_NUMBER;
}

/**
 * The next invoice number, allocated inside the caller's transaction.
 *
 * Deliberately not a Postgres sequence: the starting point depends on the
 * history the office is migrating from, and a gap-free run of numbers matters
 * to them — a sequence hands out numbers to transactions that later roll back,
 * so an abandoned invoice would silently burn #4901 and their books would show
 * a hole they cannot explain to an accountant.
 *
 * MAX + 1 under the row lock the caller already holds is gap-free by
 * construction. It serialises invoice creation, which at this volume (a few
 * hundred a month) costs nothing.
 */
export async function nextInvoiceNumber(tx: Executor = db): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${invoicesTable.number})` })
    .from(invoicesTable);
  const highest = row?.max ?? null;
  return highest == null ? configuredFirstNumber() : Number(highest) + 1;
}

/**
 * Due date from an issue date and a terms string.
 *
 * Understands the "Net N" forms his customers are on and returns null for
 * anything else, which leaves the invoice with no printed due date rather than
 * inventing one. "Due on receipt" is intentionally null: the due date IS the
 * invoice date, and printing them twice reads as a typo.
 */
export function dueDateFrom(invoiceDate: string, terms: string | null | undefined): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(invoiceDate.trim());
  if (!parts) return null;
  const trimmed = (terms ?? "").trim();
  // 2026-09-15 walkthrough: the past-due automation counts days from the due
  // date, so every invoice needs one. "Due on receipt" is due the day it is
  // issued, and a customer with no terms on file is on his standard Net 15 —
  // leaving either blank meant those invoices could never go past due.
  if (/^\s*due\s+(on|upon)\s+receipt\s*$/i.test(trimmed)) return invoiceDate.trim();
  const match = /^\s*net\s*(\d{1,3})\s*$/i.exec(trimmed);
  if (!match && trimmed) return null;
  const days = match ? Number(match[1]) : DEFAULT_TERMS_DAYS;
  // UTC arithmetic on a date-only value: no timezone is involved, so none should
  // be allowed to shift the result across a day boundary.
  const base = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The clock the office keeps. Anything that has to land on one of his days —
 * an invoice date, the day a payment was taken — is worked out in this zone.
 */
export const officeTimeZone = () => process.env.APP_TIME_ZONE || "America/Los_Angeles";

/**
 * Today as a date-only string in the office's timezone.
 *
 * Post Falls, Coeur d'Alene and Hayden are all in the Idaho panhandle, which is
 * Pacific — not Mountain, despite the rest of Idaho. Defaulting to UTC or to the
 * server's clock would date an invoice raised on a weekday evening as the next
 * day, which is exactly the kind of discrepancy a customer queries.
 *
 * Note: `weatherScheduler.ts` independently hardcodes America/Chicago for when
 * its daily job fires. That is a different question (when a background task
 * runs) but the two should probably agree; left alone here rather than changing
 * a scheduler's firing time as a side effect of invoice work.
 */
export function todayISO(timeZone = officeTimeZone()): string {
  // en-CA formats as YYYY-MM-DD, which is the shape stored in the date columns.
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
