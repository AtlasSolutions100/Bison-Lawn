import { Router, type IRouter } from "express";
import {
  db,
  companyProfileTable,
  documentTemplatesTable,
  estimateFieldsTable,
  servicesTable,
  clientsTable,
  estimatesTable,
  ticketCategoriesTable,
  ticketsTable,
  type Client,
  type DocumentTemplate,
} from "@workspace/db";
import { and, asc, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  UpdateCompanyProfileBody,
  CreateDocumentTemplateBody,
  UpdateDocumentTemplateBody,
  PreviewDocumentTemplateBody,
  SendDocumentTemplateBody,
  CreateTicketCategoryBody,
  UpdateTicketCategoryBody,
  CreateCustomerFieldBody,
  UpdateCustomerFieldBody,
} from "@workspace/api-zod";
import { requireAuth, requireArea } from "../middlewares/requireAuth";
import { supportedTokens, renderTemplate, unknownTokensIn } from "../lib/mergeTokens";
import { getCompanyProfile } from "../lib/companyProfile";
import { ensureDocumentTemplatesOnce } from "../lib/documentTemplateSeeds";
import { ensureTicketCategoriesOnce } from "../lib/settingsSeeds";
import { documentEmailHtml, sendDocumentToClients } from "../lib/documentSend";
import { isPriceableFieldType, logAudit } from "../lib/helpers";

const router: IRouter = Router();

// Company settings are the owner's; document templates are day-to-day office
// work (letters, estimates), so they sit behind the documents area instead.
router.use(["/company-profile", "/merge-tokens"], requireAuth, requireArea("settings"));
router.use(["/document-templates"], requireAuth, requireArea("documents"));

router.get("/company-profile", async (_req, res) => {
  return res.json(await getCompanyProfile());
});

router.put("/company-profile", async (req, res) => {
  const body = UpdateCompanyProfileBody.parse(req.body);
  const current = await getCompanyProfile();
  const [row] = await db
    .update(companyProfileTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(companyProfileTable.id, current.id))
    .returning();
  return res.json(row);
});

/**
 * The token list is served rather than duplicated in the front end: the
 * renderer is the only thing that knows what it can actually fill, and a
 * hand-maintained list in the UI drifts from it silently — the office would be
 * shown a token that renders as literal text in a customer's letter.
 */
router.get("/merge-tokens", async (_req, res) => {
  return res.json(supportedTokens());
});

// ---- document templates ----

/**
 * Every template goes out with `unknownTokens` attached rather than leaving the
 * front end to work them out. Whether a token can be filled is a fact about the
 * renderer, and the renderer lives here — the office needs to be warned about
 * `[speciallowerprice]` before it reaches a customer as literal text, and that
 * warning must not depend on the UI keeping its own copy of the token list in
 * step with ours.
 *
 * The subject is checked alongside the body because it is rendered too, and an
 * unfillable token in a subject line is the most visible failure of the lot.
 */
function present(template: DocumentTemplate, serviceName: string | null) {
  return {
    ...template,
    serviceName,
    unknownTokens: unknownTokensIn(`${template.subject ?? ""}\n${template.body}`),
  };
}

async function serviceNameFor(serviceId: number | null): Promise<string | null> {
  if (serviceId == null) return null;
  const [service] = await db
    .select({ name: servicesTable.name })
    .from(servicesTable)
    .where(eq(servicesTable.id, serviceId));
  return service?.name ?? null;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "template";
}

/**
 * The key is a stable handle for code that wants one specific document, so it
 * has to stay unique even when the office names two templates the same thing.
 * Suffixing is preferred over rejecting the save: the name is what he cares
 * about, and refusing "Aeration notice" because a deleted one once had that key
 * is an obstacle with no upside for him.
 */
async function uniqueKey(desired: string): Promise<string> {
  const base = slugify(desired);
  for (let suffix = 1; suffix <= 50; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const [clash] = await db
      .select({ id: documentTemplatesTable.id })
      .from(documentTemplatesTable)
      .where(eq(documentTemplatesTable.key, candidate))
      .limit(1);
    if (!clash) return candidate;
  }
  return `${base}-${Date.now()}`;
}

const CATEGORIES = new Set(["client", "marketing", "estimate"]);

router.get("/document-templates", async (req, res) => {
  // His letters are part of the product: a fresh install shows them on first
  // open rather than after somebody remembers to run a seed.
  await ensureDocumentTemplatesOnce();
  const category = typeof req.query.category === "string" && CATEGORIES.has(req.query.category) ? req.query.category : null;
  const rows = await db
    .select({ template: documentTemplatesTable, serviceName: servicesTable.name })
    .from(documentTemplatesTable)
    .leftJoin(servicesTable, eq(servicesTable.id, documentTemplatesTable.serviceId))
    .where(category ? eq(documentTemplatesTable.category, category) : undefined)
    .orderBy(asc(documentTemplatesTable.name));
  return res.json(rows.map((row) => present(row.template, row.serviceName)));
});

router.post("/document-templates", async (req, res) => {
  const body = CreateDocumentTemplateBody.parse(req.body);
  const key = body.key?.trim() ? slugify(body.key) : await uniqueKey(body.name);
  const [existing] = await db
    .select({ id: documentTemplatesTable.id })
    .from(documentTemplatesTable)
    .where(eq(documentTemplatesTable.key, key))
    .limit(1);
  if (existing) return res.status(409).json({ error: `Another template already uses the key "${key}".` });

  const [template] = await db
    .insert(documentTemplatesTable)
    .values({
      key,
      name: body.name,
      kind: body.kind ?? "notice",
      category: body.category ?? "client",
      serviceId: body.serviceId ?? null,
      subject: body.subject ?? null,
      body: body.body,
      // Only shipped documents are seeded; anything created here is his own and
      // must never be treated as ours to overwrite.
      isSeeded: false,
      updatedAt: new Date(),
    })
    .returning();
  return res.status(201).json(present(template!, await serviceNameFor(template!.serviceId)));
});

router.patch("/document-templates/:id", async (req, res) => {
  const body = UpdateDocumentTemplateBody.parse(req.body);
  // Built field by field rather than spread, so that an omitted field is left
  // alone while an explicit `serviceId: null` really does detach the service.
  const values: Partial<typeof documentTemplatesTable.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) values.name = body.name;
  if (body.kind !== undefined) values.kind = body.kind;
  if (body.category !== undefined) values.category = body.category;
  if (body.serviceId !== undefined) values.serviceId = body.serviceId ?? null;
  if (body.subject !== undefined) values.subject = body.subject ?? null;
  if (body.body !== undefined) values.body = body.body;

  const [template] = await db
    .update(documentTemplatesTable)
    .set(values)
    .where(eq(documentTemplatesTable.id, Number(req.params.id)))
    .returning();
  if (!template) return res.status(404).json({ error: "Template not found" });
  return res.json(present(template, await serviceNameFor(template.serviceId)));
});

router.delete("/document-templates/:id", async (req, res) => {
  await db.delete(documentTemplatesTable).where(eq(documentTemplatesTable.id, Number(req.params.id)));
  return res.status(204).end();
});

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * A client whose details actually exercise the address block.
 *
 * When no client is named, previewing against whoever happens to sort first is
 * a poor test of the letter: a lead with nothing but a name renders an address
 * block that looks broken, and the owner cannot tell whether the fault is his
 * template or that record. Preferring a client with a street address on file
 * shows him the shape a real letter takes.
 */
async function representativeClient(): Promise<Client | null> {
  const [withAddress] = await db
    .select()
    .from(clientsTable)
    .where(and(isNotNull(clientsTable.serviceAddress), ne(clientsTable.serviceAddress, "")))
    .orderBy(desc(clientsTable.id))
    .limit(1);
  if (withAddress) return withAddress;
  const [anyClient] = await db.select().from(clientsTable).orderBy(asc(clientsTable.id)).limit(1);
  return anyClient ?? null;
}

/**
 * Stand-in quote content for previewing an estimate cover letter.
 *
 * His two estimate documents end with the quoted-services block and the total.
 * Previewing them with both empty hides the entire bottom half of the letter —
 * exactly the part that changes per customer — so this fills them from the
 * client's most recent estimate where there is one, and from the real service
 * catalogue otherwise. Real names and real prices, so what he checks is the
 * layout he will actually send, not a mock-up of it.
 */
async function sampleQuote(client: Client | null): Promise<{ servicesBlock: string; quoteTotal: number }> {
  const lineItems: { label: string; price: number }[] = [];
  let total: number | null = null;

  if (client) {
    const [estimate] = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.clientId, client.id))
      .orderBy(desc(estimatesTable.createdAt))
      .limit(1);
    if (estimate) {
      for (const line of estimate.lines) {
        if (line.calculatedPrice == null) continue;
        lineItems.push({ label: line.label, price: line.calculatedPrice });
      }
      if (lineItems.length) total = estimate.total;
    }
  }

  if (!lineItems.length) {
    const services = await db
      .select({ name: servicesTable.name, rate: servicesTable.rate })
      .from(servicesTable)
      .orderBy(asc(servicesTable.name))
      .limit(3);
    for (const service of services) lineItems.push({ label: service.name, price: service.rate });
  }

  // A brand-new install has no services either. A single obvious placeholder
  // beats a blank block, which reads as a bug in the template.
  if (!lineItems.length) lineItems.push({ label: "Sample service", price: 125 });

  return {
    servicesBlock: lineItems.map((item) => `${item.label} — ${money(item.price)}`).join("\n"),
    quoteTotal: total ?? lineItems.reduce((sum, item) => sum + item.price, 0),
  };
}

/**
 * Render a template the way a send would, against a real customer record.
 *
 * This is the only place the owner can see his own words with somebody's real
 * name, address and phone number in them before they go out. Everything else
 * about templating is guesswork until he has looked at this.
 */
router.post("/document-templates/:id/preview", async (req, res) => {
  const { clientId } = PreviewDocumentTemplateBody.parse(req.body ?? {});
  const [template] = await db
    .select()
    .from(documentTemplatesTable)
    .where(eq(documentTemplatesTable.id, Number(req.params.id)));
  if (!template) return res.status(404).json({ error: "Template not found" });

  let client: Client | null;
  if (clientId != null) {
    const [named] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
    if (!named) return res.status(404).json({ error: "Client not found" });
    client = named;
  } else {
    client = await representativeClient();
  }

  const company = await getCompanyProfile();
  const quote = template.kind === "estimate_cover" ? await sampleQuote(client) : {};
  const context = { client, company, ...quote };
  const bodyText = renderTemplate(template.body, context);

  return res.json({
    subject: template.subject ? renderTemplate(template.subject, context) : null,
    body: bodyText,
    // The same shell a real send uses, so the logo and company block he sees
    // here are the ones the customer gets.
    html: documentEmailHtml({ bodyText, company }),
    clientName: client?.name ?? null,
    unknownTokens: unknownTokensIn(`${template.subject ?? ""}\n${template.body}`),
  });
});

/**
 * Email a template to a list of customers (contract C1). The board, the
 * waiting list, the client page and the invoice screen all call this; the
 * result is the "42 of 44 sent" line with the names of who was skipped and
 * why, so he can call the two without an email.
 */
router.post("/document-templates/:id/send", async (req, res) => {
  const body = SendDocumentTemplateBody.parse(req.body);
  const [template] = await db
    .select()
    .from(documentTemplatesTable)
    .where(eq(documentTemplatesTable.id, Number(req.params.id)));
  if (!template) return res.status(404).json({ error: "Template not found" });

  const result = await sendDocumentToClients({
    template,
    clientIds: body.clientIds,
    jobIds: body.jobIds ?? null,
    tokens: body.tokens ?? null,
    source: body.source,
    sentById: req.appUser?.id ?? null,
    actorName: req.appUser?.name ?? null,
  });
  return res.json(result);
});

// ---- ticket categories (G1) ----
//
// "Ticket Categories, Account Issue, Billing, Cancel Request, Change Service,
// Email, Estimate, other, Reschedule request, Review, Schedule Service,
// Terminate service, Upsell, Marketing." His list, and he asked to be able to
// add his own, so it is a table rather than a constant in the code.

/** A ticket's category is the NAME, so the list has to keep names unique. */
async function categoryNameTaken(name: string, exceptId: number | null): Promise<boolean> {
  const rows = await db.select({ id: ticketCategoriesTable.id, name: ticketCategoriesTable.name }).from(ticketCategoriesTable);
  const folded = name.trim().toLowerCase();
  return rows.some((row) => row.name.trim().toLowerCase() === folded && row.id !== exceptId);
}

async function ticketCategoryList(includeInactive: boolean) {
  // The count comes from the tickets themselves rather than a stored total: a
  // category he is about to delete needs an honest "12 tickets are filed under
  // this" next to it, and a stale number there is worse than none.
  const counts = await db
    .select({ category: ticketsTable.category, total: sql<number>`count(*)::int` })
    .from(ticketsTable)
    .groupBy(ticketsTable.category);
  const byName = new Map(counts.filter((row) => row.category != null).map((row) => [row.category!, row.total]));
  const rows = await db
    .select()
    .from(ticketCategoriesTable)
    .orderBy(asc(ticketCategoriesTable.sortOrder), asc(ticketCategoriesTable.id));
  return rows
    .filter((row) => includeInactive || row.active)
    .map((row) => ({ ...row, ticketCount: byName.get(row.name) ?? 0 }));
}

// Reading the list is not a settings privilege: the board's own category
// filter and the New ticket picker need it, and a crew lead who can see
// tickets can already see what they are filed under.
router.get("/ticket-categories", requireAuth, async (req, res) => {
  await ensureTicketCategoriesOnce();
  return res.json(await ticketCategoryList(req.query.includeInactive === "true"));
});

// Changing the list is his.
router.use("/ticket-categories", requireAuth, requireArea("settings"));

router.post("/ticket-categories", async (req, res) => {
  const body = CreateTicketCategoryBody.parse(req.body);
  const name = body.name.trim();
  if (!name) return res.status(400).json({ error: "A category needs a name" });
  if (await categoryNameTaken(name, null)) {
    return res.status(409).json({ error: `"${name}" is already on the list.` });
  }
  const [last] = await db
    .select({ sortOrder: ticketCategoriesTable.sortOrder })
    .from(ticketCategoriesTable)
    .orderBy(desc(ticketCategoriesTable.sortOrder))
    .limit(1);
  const [category] = await db
    .insert(ticketCategoriesTable)
    .values({ name, sortOrder: body.sortOrder ?? (last?.sortOrder ?? 0) + 10 })
    .returning();
  await logAudit({
    actorName: req.appUser?.name,
    action: "ticket_category_created",
    description: `Added the ticket category "${name}"`,
  });
  return res.status(201).json({ ...category, ticketCount: 0 });
});

router.patch("/ticket-categories/:id", async (req, res) => {
  const body = UpdateTicketCategoryBody.parse(req.body);
  const id = Number(req.params.id);
  const [existing] = await db.select().from(ticketCategoriesTable).where(eq(ticketCategoriesTable.id, id));
  if (!existing) return res.status(404).json({ error: "Category not found" });

  const name = body.name?.trim();
  if (body.name !== undefined && !name) return res.status(400).json({ error: "A category needs a name" });
  if (name && (await categoryNameTaken(name, id))) {
    return res.status(409).json({ error: `"${name}" is already on the list.` });
  }

  const [category] = await db
    .update(ticketCategoriesTable)
    .set({
      ...(name ? { name } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    })
    .where(eq(ticketCategoriesTable.id, id))
    .returning();

  // A rename takes the tickets with it. He renames a category because he typed
  // it wrong or changed what he calls it, and leaving the old tickets behind
  // under the old spelling is how a filter quietly stops finding them.
  let refiled = 0;
  if (name && name !== existing.name) {
    const moved = await db
      .update(ticketsTable)
      .set({ category: name })
      .where(eq(ticketsTable.category, existing.name))
      .returning({ id: ticketsTable.id });
    refiled = moved.length;
    await logAudit({
      actorName: req.appUser?.name,
      action: "ticket_category_renamed",
      description:
        `Renamed the ticket category "${existing.name}" to "${name}"` +
        (refiled ? ` and moved ${refiled} ticket${refiled === 1 ? "" : "s"} onto the new name` : ""),
    });
  }
  if (body.active !== undefined && body.active !== existing.active) {
    await logAudit({
      actorName: req.appUser?.name,
      action: "ticket_category_updated",
      description: body.active
        ? `Turned the ticket category "${category.name}" back on`
        : `Turned off the ticket category "${category.name}" — tickets already filed under it keep it`,
    });
  }
  const counted = await ticketCategoryList(true);
  return res.json(counted.find((row) => row.id === id) ?? { ...category, ticketCount: 0, refiled });
});

router.delete("/ticket-categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  // The tickets keep the name they were filed under. Blanking them would lose
  // the one thing the category was for, and he can still filter on it.
  const [gone] = await db.delete(ticketCategoriesTable).where(eq(ticketCategoriesTable.id, id)).returning();
  if (gone) {
    await logAudit({
      actorName: req.appUser?.name,
      action: "ticket_category_deleted",
      description: `Took the ticket category "${gone.name}" off the list — tickets already filed under it keep it`,
    });
  }
  return res.status(204).end();
});

// ---- customer fields (G2) ----
//
// "Add Customer Field Effects all Clients."
//
// What he hit: the box at the bottom of a customer's Custom fields card adds a
// label to THAT customer's property_data and nowhere else, so the field he
// added for one house was missing from the next 708. The fields that do show
// on every customer are the estimate_fields rows — the account page, the
// estimate builder and the rate matrix all read them — and until now there was
// no way to add one from Settings. This is that way.
//
// Same table, on purpose. A second list of "customer fields" beside it would
// mean a field that shows on the account but cannot price a job, and he would
// have no way of telling which kind he had made.

type CustomerFieldUse = { label: string; filled: number };

/**
 * How many customers have a value saved against each label, counted straight
 * out of property_data. The label is the key, so this also finds the one-off
 * labels typed on a single customer — the ones he thought were global.
 */
async function propertyDataUse(): Promise<CustomerFieldUse[]> {
  const result = await db.execute(sql`
    select entry.key as label, count(*)::int as filled
    from clients c, jsonb_each_text(c.property_data) as entry(key, value)
    where btrim(entry.value) <> ''
    group by entry.key
    order by count(*) desc, entry.key
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    label: String(row.label),
    filled: Number(row.filled ?? 0),
  }));
}

/**
 * Which of his services work their price out from this field.
 *
 * A service pointed at a field is the one thing that field cannot be taken off
 * the list under, or retyped under. The column is "set null on delete", and a
 * blank pricing field does not mean "unknown" — it means turf square footage —
 * so deleting "Sprinkler Zones" would quietly start pricing a blow-out off a
 * 6,200 sq ft lawn instead of 6 zones, on every estimate, job and invoice after
 * it. Retyping the same field to Text or Yes/no leaves nothing to price against
 * at all and the price refuses with an error. Services already refuses to POINT
 * a service at a text field; this is the same rule from the other end.
 */
async function servicesPricedFrom(fieldId: number) {
  return db
    .select({ id: servicesTable.id, name: servicesTable.name })
    .from(servicesTable)
    .where(eq(servicesTable.pricingFieldId, fieldId));
}

/** "Turn-On, Blow-Out and Aeration" — a list he can read in a sentence. */
function andList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

router.use("/customer-fields", requireAuth, requireArea("settings"));

router.get("/customer-fields", async (_req, res) => {
  const [fields, use, [clientTotal]] = await Promise.all([
    db.select().from(estimateFieldsTable).orderBy(asc(estimateFieldsTable.sortOrder), asc(estimateFieldsTable.id)),
    propertyDataUse(),
    db.select({ total: sql<number>`count(*)::int` }).from(clientsTable),
  ]);
  const filledByLabel = new Map(use.map((entry) => [entry.label.trim().toLowerCase(), entry.filled]));
  const managedLabels = new Set(fields.map((field) => field.label.trim().toLowerCase()));
  return res.json({
    clientCount: clientTotal?.total ?? 0,
    // On the list: shows on every customer, every estimate and the matrix.
    managed: fields.map((field) => ({
      ...field,
      filledCount: filledByLabel.get(field.label.trim().toLowerCase()) ?? 0,
    })),
    // Not on the list: typed on one customer's card and living only there.
    // Shown so he can see what he has, and add any of them to everybody.
    unmanaged: use.filter((entry) => !managedLabels.has(entry.label.trim().toLowerCase())),
  });
});

/**
 * Add a field to every customer.
 *
 * Posting a label that already exists on one customer's card is how he adopts
 * it: the row makes the label official, and because the account page renders
 * managed fields by label, the values already saved against it appear under it
 * straight away instead of being stranded.
 */
router.post("/customer-fields", async (req, res) => {
  const body = CreateCustomerFieldBody.parse(req.body);
  const label = body.label.trim();
  if (!label) return res.status(400).json({ error: "A field needs a name" });
  const existing = await db.select().from(estimateFieldsTable);
  if (existing.some((field) => field.label.trim().toLowerCase() === label.toLowerCase())) {
    return res.status(409).json({ error: `"${label}" is already on the list, so it already shows on every customer.` });
  }
  const nextOrder = Math.max(0, ...existing.map((field) => field.sortOrder ?? 0)) + 10;
  const [field] = await db
    .insert(estimateFieldsTable)
    .values({
      label,
      fieldType: body.fieldType ?? "text",
      pricePerUnit: body.pricePerUnit ?? null,
      unitSize: body.unitSize ?? null,
      sortOrder: body.sortOrder ?? nextOrder,
    })
    .returning();
  const [adopted] = (await propertyDataUse()).filter(
    (entry) => entry.label.trim().toLowerCase() === label.toLowerCase(),
  );
  await logAudit({
    actorName: req.appUser?.name,
    action: "customer_field_created",
    description:
      `Added the customer field "${label}" — it now shows on every customer` +
      (adopted?.filled ? `, and the ${adopted.filled} who already had a value for it keep it` : ""),
  });
  return res.json({ ...field, filledCount: adopted?.filled ?? 0 });
});

router.patch("/customer-fields/:id", async (req, res) => {
  const body = UpdateCustomerFieldBody.parse(req.body);
  const id = Number(req.params.id);
  const [existing] = await db.select().from(estimateFieldsTable).where(eq(estimateFieldsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Field not found" });

  const label = body.label?.trim();
  if (body.label !== undefined && !label) return res.status(400).json({ error: "A field needs a name" });

  // Changing the kind of answer to Text or Yes/no on a field a service prices
  // from leaves that service with no number to work from: the price stops
  // working everywhere at once — the estimate line, assigning the service, the
  // invoice — until somebody flips it back. Say which services, so the drop-down
  // tells him what he would be breaking instead of breaking it.
  if (body.fieldType !== undefined && body.fieldType !== existing.fieldType && !isPriceableFieldType(body.fieldType)) {
    const pricedFrom = await servicesPricedFrom(id);
    if (pricedFrom.length) {
      return res.status(409).json({
        error:
          `"${existing.label}" is the number ${andList(pricedFrom.map((svc) => svc.name))} ` +
          `work${pricedFrom.length === 1 ? "s" : ""} the price out from, so it has to stay a number. ` +
          `Point ${pricedFrom.length === 1 ? "that service" : "those services"} at another field first.`,
      });
    }
  }
  if (label && label.toLowerCase() !== existing.label.toLowerCase()) {
    const all = await db.select({ label: estimateFieldsTable.label }).from(estimateFieldsTable);
    if (all.some((field) => field.label.trim().toLowerCase() === label.toLowerCase())) {
      return res.status(409).json({ error: `"${label}" is already on the list.` });
    }
  }

  const [field] = await db
    .update(estimateFieldsTable)
    .set({
      ...(label ? { label } : {}),
      ...(body.fieldType !== undefined ? { fieldType: body.fieldType } : {}),
      ...(body.pricePerUnit !== undefined ? { pricePerUnit: body.pricePerUnit } : {}),
      ...(body.unitSize !== undefined ? { unitSize: body.unitSize } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
    })
    .where(eq(estimateFieldsTable.id, id))
    .returning();

  // A rename carries the saved values with it, because the label IS the key in
  // property_data. Without this, renaming "Turf sqft" to "Turf Sqft" would
  // blank the square footage on every customer who had one and the matrix
  // would stop pricing — the exact failure that makes an app untrustworthy.
  // Matched without case, because the Service Autopilot import left the same
  // field spelled "turf sqft" on one customer and "Turf Sqft" on the next, and
  // everything that reads a customer's value for a field already ignores case.
  // A byte-exact move left those customers' numbers stranded under the old
  // spelling: the sqft report and the "who have I not measured" filter stopped
  // finding them while the screen still showed the value.
  let moved = 0;
  if (label && label !== existing.label) {
    const result = await db.execute(sql`
      update clients c
      set property_data = (
        select jsonb_object_agg(moved.key, moved.value order by moved.is_match, moved.is_exact)
        from (
          select
            case when lower(entry.key) = lower(${existing.label}) then ${label}::text else entry.key end as key,
            entry.value as value,
            (lower(entry.key) = lower(${existing.label}))::int as is_match,
            (entry.key = ${existing.label}::text)::int as is_exact
          from jsonb_each(c.property_data) as entry(key, value)
        ) as moved
      )
      where exists (
        select 1 from jsonb_each(c.property_data) as entry(key, value)
        where lower(entry.key) = lower(${existing.label})
      )
    `);
    moved = result.rowCount ?? 0;
    await logAudit({
      actorName: req.appUser?.name,
      action: "customer_field_renamed",
      description:
        `Renamed the customer field "${existing.label}" to "${label}"` +
        (moved ? ` and carried what ${moved} customer${moved === 1 ? "" : "s"} had saved under it across` : ""),
    });
  }
  return res.json({ ...field, movedValues: moved });
});

/**
 * Take a field off the list. The values stay on the customers who have them —
 * deleting a field is him saying "stop asking everybody for this", not "throw
 * away what we know about these houses". They show again as one-off labels on
 * the accounts that have them, and the list above says so.
 */
router.delete("/customer-fields/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [field] = await db.select().from(estimateFieldsTable).where(eq(estimateFieldsTable.id, id));
  if (!field) return res.status(204).end();
  const pricedFrom = await servicesPricedFrom(id);
  if (pricedFrom.length) {
    return res.status(409).json({
      error:
        `"${field.label}" is the number ${andList(pricedFrom.map((svc) => svc.name))} ` +
        `work${pricedFrom.length === 1 ? "s" : ""} the price out from. Taking it off the list would price ` +
        `${pricedFrom.length === 1 ? "it" : "them"} off Turf Sqft instead, which is not the same job. ` +
        `Point ${pricedFrom.length === 1 ? "that service" : "those services"} at another field first, on the Services screen.`,
    });
  }
  const [gone] = await db.delete(estimateFieldsTable).where(eq(estimateFieldsTable.id, id)).returning();
  if (gone) {
    await logAudit({
      actorName: req.appUser?.name,
      action: "customer_field_deleted",
      description:
        `Took the customer field "${gone.label}" off the list — customers who already had a value for it keep it`,
    });
  }
  return res.status(204).end();
});

export default router;
