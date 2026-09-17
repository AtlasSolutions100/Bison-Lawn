import { Router, type IRouter } from "express";
import {
  db,
  clientsTable,
  auditEventsTable,
  invoicesTable,
  paymentsTable,
  jobsTable,
} from "@workspace/db";
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { BulkUpdateClientsBody, BulkDeleteClientsBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { logAudit } from "../lib/helpers";

/**
 * The Actions menu on the client list: export, bulk edit, delete.
 *
 * Its own router, mounted BEFORE clientsRouter in routes/index.ts. Express
 * matches in registration order and clients.ts registers `/clients/:id`, so
 * `/clients/export` mounted after it would be read as client id "export" and
 * come back 404. Being first also means clients.ts's blanket guard has not run
 * yet, hence the guard below.
 */
const router: IRouter = Router();

// Changing or deleting customers in bulk is an office job.
router.use(["/clients/export", "/clients/bulk-update", "/clients/bulk-delete"], requireAuth, requireArea("clients"));

/**
 * The same conditions GET /clients applies, so what comes out of the export is
 * what the list showed. Duplicated from clients.ts rather than shared because
 * that router is being reworked at the same time and this one must not depend
 * on its internals.
 */
function listConditions(query: { status?: string; search?: string; ids?: string }) {
  const conds = [];
  if (query.status) conds.push(eq(clientsTable.status, query.status));
  if (query.search) {
    const like = `%${query.search}%`;
    conds.push(
      or(
        ilike(clientsTable.name, like),
        ilike(clientsTable.serviceAddress, like),
        ilike(clientsTable.city, like),
        ilike(clientsTable.email, like),
        ilike(clientsTable.phone, like),
        ilike(clientsTable.mapCode, like),
        ilike(clientsTable.waterDistrict, like),
        sql`exists (select 1 from jsonb_array_elements_text(${clientsTable.tags}) tag where tag ilike ${like})`,
      ),
    );
  }
  const ids = parseIds(query.ids);
  if (ids) conds.push(inArray(clientsTable.id, ids));
  return conds;
}

/** "12,15,99" → [12, 15, 99]; undefined when nothing usable was sent. */
function parseIds(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const ids = [...new Set(raw.split(",").map((s) => Number(s.trim())))].filter(
    (n) => Number.isInteger(n) && n > 0,
  );
  return ids.length ? ids : null;
}

/**
 * One CSV cell. Quotes when the value carries a comma, quote or line break.
 *
 * A cell starting with = + - @ has to be defused or Excel runs it as a formula,
 * and a customer named "=HYPERLINK(...)" is exactly the kind of thing a web
 * form lets through. Two things it must not do while defusing:
 *  - a plain number is a number. A credit balance of -25.00 is normal, and
 *    marking it as text is how the Balance column stops adding up.
 *  - the defusing must not show. A leading apostrophe is a shortcut for typing
 *    into a cell, not something a CSV hides, so a phone saved as "+1 208 555
 *    0100" came out with a stray mark in front of it. ="..." is the form Excel
 *    reads as "this is text" when it opens a file.
 */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  let text = typeof value === "string" ? value : String(value);
  const plainNumber = /^[-+]?\d+(?:,\d{3})*(?:\.\d+)?$/.test(text);
  if (!plainNumber && /^[=+\-@\t\r]/.test(text)) text = `="${text.replace(/"/g, '""')}"`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * His calendar day, not UTC's. A customer added at 6:30 in the evening is on
 * the list as added that day, so the export has to say the same day — otherwise
 * everything he takes on after supper reads as tomorrow.
 */
const businessDay = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIME_ZONE || "America/Boise",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const CSV_COLUMNS: { header: string; pick: (c: typeof clientsTable.$inferSelect) => unknown }[] = [
  { header: "Id", pick: (c) => c.id },
  { header: "Name", pick: (c) => c.name },
  { header: "Status", pick: (c) => (c.status === "former_client" ? "former" : c.status) },
  { header: "Email", pick: (c) => c.email },
  { header: "Phone", pick: (c) => c.phone },
  { header: "Additional Contact", pick: (c) => c.additionalContact },
  { header: "Service Address", pick: (c) => c.serviceAddress },
  { header: "Address Line 2", pick: (c) => c.addressLine2 },
  { header: "City", pick: (c) => c.city },
  { header: "State", pick: (c) => c.state },
  { header: "Zip", pick: (c) => c.postalCode },
  { header: "Map Code", pick: (c) => c.mapCode },
  { header: "Water District", pick: (c) => c.waterDistrict },
  { header: "Tags", pick: (c) => (c.tags ?? []).join("; ") },
  { header: "Balance", pick: (c) => c.accountBalance.toFixed(2) },
  { header: "Name On Invoice", pick: (c) => c.nameOnInvoice },
  { header: "Billing Address 1", pick: (c) => c.billingAddressLine1 },
  { header: "Billing Address 2", pick: (c) => c.billingAddressLine2 },
  { header: "Billing City", pick: (c) => c.billingCity },
  { header: "Billing State", pick: (c) => c.billingState },
  { header: "Billing Zip", pick: (c) => c.billingPostalCode },
  { header: "Billing Email", pick: (c) => c.billingEmail },
  { header: "Account Number", pick: (c) => c.accountNumber },
  { header: "Terms", pick: (c) => c.billingTerms },
  { header: "Invoice Frequency", pick: (c) => c.invoiceFrequency },
  { header: "Invoice Delivery", pick: (c) => c.invoiceDelivery },
  { header: "Account Type", pick: (c) => c.accountType },
  { header: "Do Not Email", pick: (c) => (c.doNotEmail ? "yes" : "") },
  { header: "Source", pick: (c) => c.source },
  { header: "Office Note", pick: (c) => c.officeNote },
  { header: "Map / Crew Note", pick: (c) => c.mapNote },
  { header: "Last Service", pick: (c) => c.lastServiceDate },
  { header: "Added", pick: (c) => (c.createdAt ? businessDay(c.createdAt) : "") },
];

router.get("/clients/export", async (req, res) => {
  const query = req.query as { status?: string; search?: string; ids?: string };
  const conds = listConditions(query);
  const rows = await db
    .select()
    .from(clientsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(clientsTable.name);

  // His custom fields ("Turf sqft", "Gate code") are free-form per customer, so
  // the columns are whatever keys the exported rows actually carry. Case folded
  // because the import left "Turf sqft" and "turf sqft" on different customers.
  const propertyKeys = new Map<string, string>();
  for (const row of rows) {
    for (const key of Object.keys(row.propertyData ?? {})) {
      const folded = key.trim().toLowerCase();
      if (folded && !propertyKeys.has(folded)) propertyKeys.set(folded, key.trim());
    }
  }
  const propertyColumns = [...propertyKeys.entries()].sort((a, b) => a[1].localeCompare(b[1]));

  const lines = [
    [...CSV_COLUMNS.map((c) => c.header), ...propertyColumns.map(([, label]) => label)].map(csvCell).join(","),
  ];
  for (const row of rows) {
    const details = new Map(
      Object.entries(row.propertyData ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]),
    );
    lines.push(
      [
        ...CSV_COLUMNS.map((c) => c.pick(row)),
        ...propertyColumns.map(([folded]) => details.get(folded) ?? ""),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  const stamp = businessDay(new Date());
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="clients-${stamp}.csv"`);
  // The byte-order mark is what makes Excel read the file as UTF-8 instead of
  // turning "Coeur d'Alene" customers with accented names into mojibake.
  return res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
});

const STATUS_WORDS: Record<string, string> = {
  lead: "lead",
  client: "active client",
  former_client: "former client",
};

const FIELD_WORDS: Record<string, string> = {
  mapCode: "map code",
  waterDistrict: "water district",
  state: "branch / state",
  accountType: "account type",
  billingTerms: "terms",
  invoiceFrequency: "invoice frequency",
  invoiceDelivery: "invoice delivery",
  doNotEmail: "do-not-email",
};

/** Tags are stored lowercase (see the column comment in crm.ts). */
const normaliseTags = (tags: string[] | undefined) =>
  [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];

/**
 * Reads the raw body for presence, like /jobs/bulk-assign does: "not mentioned"
 * and "set to null" have to stay different things, or a bulk edit that only
 * meant to change the terms clears every other field in the dialog.
 */
router.post("/clients/bulk-update", async (req, res) => {
  const body = BulkUpdateClientsBody.parse(req.body);
  const clientIds = [...new Set(body.clientIds)].filter((id) => Number.isInteger(id));
  if (clientIds.length === 0) return res.status(400).json({ error: "Select at least one client" });

  const raw = (req.body ?? {}) as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);

  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  if (has("status") && body.status) {
    patch.status = body.status;
    changes.push(`Set status to ${STATUS_WORDS[body.status] ?? body.status}`);
  }
  for (const key of ["mapCode", "waterDistrict", "state", "accountType", "billingTerms", "invoiceFrequency", "invoiceDelivery"] as const) {
    if (!has(key)) continue;
    const value = typeof body[key] === "string" ? (body[key] as string).trim() : null;
    // Map codes are shorthand and always shown in caps; a blank means "clear".
    const stored = value ? (key === "mapCode" ? value.toUpperCase() : value) : null;
    patch[key] = stored;
    changes.push(stored ? `Set ${FIELD_WORDS[key]} to ${stored}` : `Cleared ${FIELD_WORDS[key]}`);
  }
  if (has("doNotEmail") && body.doNotEmail != null) {
    patch.doNotEmail = body.doNotEmail;
    changes.push(body.doNotEmail ? "Turned on do-not-email" : "Turned off do-not-email");
  }
  const addTags = normaliseTags(body.addTags);
  const removeTags = normaliseTags(body.removeTags);
  if (addTags.length) changes.push(`Added tag${addTags.length === 1 ? "" : "s"} ${addTags.join(", ")}`);
  if (removeTags.length) changes.push(`Removed tag${removeTags.length === 1 ? "" : "s"} ${removeTags.join(", ")}`);

  if (Object.keys(patch).length === 0 && !addTags.length && !removeTags.length) {
    return res.status(400).json({ error: "Nothing to change" });
  }

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: clientsTable.id, tags: clientsTable.tags })
      .from(clientsTable)
      .where(inArray(clientsTable.id, clientIds));
    if (rows.length === 0) return [] as number[];
    const found = rows.map((r) => r.id);

    if (Object.keys(patch).length > 0) {
      await tx.update(clientsTable).set(patch).where(inArray(clientsTable.id, found));
    }
    if (addTags.length || removeTags.length) {
      // Per row, because each customer keeps whatever tags they already had;
      // only the named ones are added on top or taken away.
      for (const row of rows) {
        const current = normaliseTags(row.tags ?? []);
        const next = [...new Set([...current, ...addTags])].filter((t) => !removeTags.includes(t));
        if (next.length !== current.length || next.some((t, i) => t !== current[i])) {
          await tx.update(clientsTable).set({ tags: next }).where(eq(clientsTable.id, row.id));
        }
      }
    }

    // One audit line per customer, in a single insert: the customer page reads
    // history by client id, and "changed with 39 others" is a real answer to
    // "why did this account go former?".
    const description = `${changes.join("; ")} (bulk edit of ${found.length} client${found.length === 1 ? "" : "s"})`;
    await tx.insert(auditEventsTable).values(
      found.map((clientId) => ({
        clientId,
        actorName: req.appUser?.name ?? null,
        action: "client_updated",
        description,
      })),
    );
    return found;
  });

  return res.json({ updated: updated.length, clientIds: updated });
});

/**
 * Delete cascades — invoices, payments, jobs, notes, photos, history all go
 * with the customer. That is what he asked for ("Delete Clients" on his old
 * Actions menu) but it is not a thing to do blind, so the same call counts
 * first when `preview` is set and the confirm dialog shows those numbers.
 */
router.post("/clients/bulk-delete", async (req, res) => {
  const body = BulkDeleteClientsBody.parse(req.body);
  const clientIds = [...new Set(body.clientIds)].filter((id) => Number.isInteger(id));
  if (clientIds.length === 0) return res.status(400).json({ error: "Select at least one client" });

  const countRows = async (table: typeof invoicesTable | typeof paymentsTable | typeof jobsTable) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(inArray(table.clientId, clientIds));
    return Number(row?.n ?? 0);
  };

  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(inArray(clientsTable.id, clientIds));
  const [invoices, payments, jobs] = await Promise.all([
    countRows(invoicesTable),
    countRows(paymentsTable),
    countRows(jobsTable),
  ]);

  if (body.preview || clients.length === 0) {
    return res.json({ preview: true, clients: clients.length, invoices, payments, jobs });
  }

  await db.transaction(async (tx) => {
    await tx.delete(clientsTable).where(inArray(clientsTable.id, clients.map((c) => c.id)));
  });

  // The per-client audit rows went with the clients, so the one line that
  // survives has to name who was deleted. Capped so a 700-row purge does not
  // write a novel.
  const named = clients.slice(0, 10).map((c) => `"${c.name}"`).join(", ");
  const more = clients.length > 10 ? ` and ${clients.length - 10} more` : "";
  await logAudit({
    actorName: req.appUser?.name ?? null,
    action: "clients_bulk_deleted",
    description:
      `Deleted ${clients.length} client${clients.length === 1 ? "" : "s"}: ${named}${more}` +
      ` (with ${invoices} invoice${invoices === 1 ? "" : "s"}, ${payments} payment${payments === 1 ? "" : "s"}, ${jobs} job${jobs === 1 ? "" : "s"})`,
  });

  return res.json({ preview: false, clients: clients.length, invoices, payments, jobs });
});

export default router;
