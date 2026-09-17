import { Router, type IRouter } from "express";
import {
  db,
  companyProfileTable,
  documentTemplatesTable,
  servicesTable,
  clientsTable,
  estimatesTable,
  type Client,
  type DocumentTemplate,
} from "@workspace/db";
import { and, asc, desc, eq, isNotNull, ne } from "drizzle-orm";
import {
  UpdateCompanyProfileBody,
  CreateDocumentTemplateBody,
  UpdateDocumentTemplateBody,
  PreviewDocumentTemplateBody,
  SendDocumentTemplateBody,
} from "@workspace/api-zod";
import { requireAuth, requireArea } from "../middlewares/requireAuth";
import { supportedTokens, renderTemplate, unknownTokensIn } from "../lib/mergeTokens";
import { getCompanyProfile } from "../lib/companyProfile";
import { ensureDocumentTemplatesOnce } from "../lib/documentTemplateSeeds";
import { documentEmailHtml, sendDocumentToClients } from "../lib/documentSend";

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

export default router;
