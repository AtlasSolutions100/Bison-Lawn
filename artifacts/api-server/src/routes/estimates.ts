import { Router, type IRouter } from "express";
import {
  db,
  chargePresetsTable,
  documentTemplatesTable,
  estimateFieldsTable,
  estimatesTable,
  clientsTable,
  jobPhotosTable,
  servicesTable,
} from "@workspace/db";
import type { CompanyProfile, EstimateLine, JobPhoto } from "@workspace/db";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import {
  CreateEstimateFieldBody,
  UpdateEstimateFieldBody,
  CreateChargePresetBody,
  UpdateChargePresetBody,
  CreateEstimateBody,
  UpdateEstimateBody,
  SendEstimateBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit, numericFieldValue, priceService, pricingFieldOf, roundMoney } from "../lib/helpers";
import {
  createEstimateEmailHtml,
  createEstimatePdf,
  lineMathLabel,
  quotedServicesBlock,
} from "../lib/estimateDocument";
import {
  ATTACHMENT_BUDGET_BYTES,
  describeBytes,
  encodedAttachmentBytes,
  renderDocumentPdf,
  sendEstimateViaGmail,
  type EmailAttachment,
} from "../lib/estimateDelivery";
import { readFile } from "../lib/fileStorage";
import { renderTemplate } from "../lib/mergeTokens";
import { putAcceptedEstimateOnAccount } from "../lib/estimateAcceptance";
import { getCompanyProfile } from "../lib/companyProfile";
import {
  claimEstimateDelivery,
  finalizeEstimateDelivery,
  reconcileEstimateDelivery,
  recordEstimateProviderAccepted,
  releaseEstimateDelivery,
} from "../lib/estimateDeliveryState";

const router: IRouter = Router();
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

async function loadEstimateDocument(id: number) {
  const [estimate] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, id));
  if (!estimate) return null;
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, estimate.clientId));
  if (!client) return null;
  const serviceIds = [
    ...new Set(
      (estimate.lines as EstimateLine[])
        .map((line) => line.serviceId)
        .filter((serviceId): serviceId is number => serviceId != null),
    ),
  ];
  const quotedServices = serviceIds.length
    ? await db
        .select({ id: servicesTable.id, name: servicesTable.name, description: servicesTable.description })
        .from(servicesTable)
        .where(inArray(servicesTable.id, serviceIds))
    : [];
  return { estimate, client, quotedServices };
}

async function loadPublicEstimate(token: string) {
  const hash = tokenHash(token);
  const [estimate] = await db
    .select()
    .from(estimatesTable)
    .where(
      or(
        eq(estimatesTable.responseTokenHash, hash),
        and(
          eq(estimatesTable.pendingResponseTokenHash, hash),
          eq(estimatesTable.deliveryState, "provider_accepted"),
        ),
      ),
    );
  if (!estimate) return null;
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, estimate.clientId));
  if (!client) return null;
  return {
    estimate,
    client,
    tokenSource: estimate.responseTokenHash === hash ? ("active" as const) : ("provider_accepted" as const),
    hash,
  };
}

export function publicAppOrigin() {
  const configured = process.env.APP_PUBLIC_URL?.replace(/\/+$/, "");
  if (configured) {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      throw new Error("APP_PUBLIC_URL must use HTTPS");
    }
    return parsed.origin;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_PUBLIC_URL is required in production");
  }
  // Development fallback only; production threw above without APP_PUBLIC_URL.
  return `http://localhost:${process.env.WEB_PORT ?? "5173"}`;
}

function responsePage(title: string, message: string, success: boolean, companyName = "Bison Lawn Care LLC") {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{margin:0;background:#f7f5f1;color:#2b2118;font-family:Arial,sans-serif;display:grid;min-height:100vh;place-items:center}.card{background:#fff;border:1px solid #e7e2dc;border-radius:16px;padding:42px;max-width:520px;text-align:center;box-shadow:0 12px 40px #2b211814}.mark{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;margin:0 auto 20px;background:${success ? "#eaf3ee" : "#f3ece8"};color:${success ? "#176b45" : "#864f36"};font-size:30px}h1{margin:0 0 12px}p{color:#6f675f;line-height:1.6}</style></head>
  <body><main class="card"><div class="mark">${success ? "✓" : "×"}</div><h1>${title}</h1><p>${message}</p><p>${escapeHtml(companyName)}</p></main></body></html>`;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const asMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * The lines a customer may choose between, with their index into `lines`.
 *
 * Only priced lines are offered. A zero-priced line is usually a recorded
 * measurement (gate code, "Dog: yes") rather than something to buy, and putting
 * a checkbox beside it invites a customer to "decline" a fact about their own
 * property.
 */
function selectableLines(lines: EstimateLine[]) {
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => (line.calculatedPrice ?? 0) !== 0);
}

/**
 * What the customer ticks: a standalone line is one choice, and every line
 * added together from one package is ONE choice carrying all of their indexes.
 * He sells the Sprinkler Package as a package; a customer who could keep the
 * turn-on and drop the blow-out has un-bundled it, and the package price no
 * longer holds. The members are still listed under the choice so they can see
 * what is in it.
 */
type ResponseChoice = {
  label: string;
  indexes: number[];
  total: number;
  members: { line: EstimateLine; index: number }[];
  packageKey: string | null;
};

function responseChoices(lines: EstimateLine[]): ResponseChoice[] {
  const choices: ResponseChoice[] = [];
  const byPackage = new Map<string, ResponseChoice>();
  for (const entry of selectableLines(lines)) {
    const key = entry.line.packageKey ?? null;
    if (!key) {
      choices.push({
        label: entry.line.label,
        indexes: [entry.index],
        total: entry.line.calculatedPrice ?? 0,
        members: [entry],
        packageKey: null,
      });
      continue;
    }
    let choice = byPackage.get(key);
    if (!choice) {
      choice = { label: entry.line.packageName ?? "Package", indexes: [], total: 0, members: [], packageKey: key };
      byPackage.set(key, choice);
      choices.push(choice);
    }
    choice.indexes.push(entry.index);
    choice.total = roundMoney(choice.total + (entry.line.calculatedPrice ?? 0));
    choice.members.push(entry);
  }
  return choices;
}

/** The "28 visits x $55.00" hint beside a line, for the response page. */
const mathHint = (line: EstimateLine) => {
  const math = lineMathLabel(line);
  return math ? ` <em>(${escapeHtml(math)})</em>` : "";
};

function responseConfirmationPage(
  token: string,
  action: "accept" | "decline",
  estimateId: number,
  lines: EstimateLine[],
  companyName: string,
) {
  const accepting = action === "accept";
  const selectable = selectableLines(lines);
  const choices = responseChoices(lines);

  /*
   * Per-line checkboxes, because his proposal promises them: "check the box
   * corresponding to each service ... uncheck the respective box".
   *
   * Every box starts checked, so a customer who simply confirms accepts the
   * whole estimate — identical to the behaviour before this existed. Unchecking
   * is purely additive, which means this cannot regress an estimate that would
   * have been accepted in full.
   *
   * Plain form controls with no JavaScript: this page opens from a link in an
   * email, on whatever browser the customer's mail app hands it to, and a quote
   * that silently fails to submit is a lost sale.
   *
   * The hidden "hadlines" field marks a form that carried checkboxes. Browsers
   * omit unchecked boxes entirely, so "every box unticked" and "this form never
   * had boxes" both arrive as a missing line field — without the marker,
   * unticking everything reads as accepting everything, which is exactly the
   * wrong way for that ambiguity to fall.
   *
   * A package is one box whose value names every line inside it, so the
   * customer takes or leaves the package whole; its services are listed
   * beneath so they know what they are agreeing to.
   */
  const lineRows = choices
    .map((choice) => {
      const detail = choice.packageKey
        ? `<span class="members">${choice.members
            .map(({ line }) => `${escapeHtml(line.label)}${mathHint(line)} — ${asMoney(line.calculatedPrice ?? 0)}`)
            .join("<br>")}</span>`
        : `${choice.members[0]!.line.value ? ` <em>(${escapeHtml(choice.members[0]!.line.value)})</em>` : ""}${mathHint(choice.members[0]!.line)}`;
      return `
      <label class="line">
        <input type="checkbox" name="line" value="${choice.indexes.join(",")}" checked>
        <span class="label">${escapeHtml(choice.label)}${choice.packageKey ? ' <em>(package)</em>' : ""}${detail}</span>
        <span class="price">${asMoney(choice.total)}</span>
      </label>`;
    })
    .join("");

  const total = selectable.reduce((sum, { line }) => sum + (line.calculatedPrice ?? 0), 0);

  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Respond to estimate</title>
  <style>body{margin:0;background:#f7f5f1;color:#2b2118;font-family:Arial,sans-serif;display:grid;min-height:100vh;place-items:center;padding:24px}.card{background:#fff;border:1px solid #e7e2dc;border-radius:16px;padding:42px;max-width:560px;width:100%;box-shadow:0 12px 40px #2b211814}h1{margin:0 0 12px;text-align:center}p{color:#6f675f;line-height:1.6}.line{display:flex;align-items:center;gap:12px;padding:12px 4px;border-bottom:1px solid #f0ece7}.line:last-of-type{border-bottom:0}.line input{width:20px;height:20px;flex:none}.label{flex:1}.label em{color:#6f675f;font-style:normal;font-size:14px}.members{display:block;color:#6f675f;font-size:13px;margin-top:4px;line-height:1.5}.price{font-weight:bold;white-space:nowrap}.total{display:flex;justify-content:space-between;padding:14px 4px;border-top:2px solid #2b2118;font-weight:bold;margin-top:4px}.button{border:0;border-radius:7px;padding:14px 26px;font-size:16px;font-weight:bold;cursor:pointer;background:${accepting ? "#215343" : "#864f36"};color:#fff;width:100%;margin-top:20px}.foot{text-align:center;margin-top:24px}</style></head>
  <body><main class="card"><h1>${accepting ? "Accept" : "Decline"} estimate #${estimateId}?</h1>
  ${
    accepting && selectable.length > 0
      ? `<p>Everything below is included. Uncheck anything you would rather not go ahead with, then confirm.</p>
         <form method="post" action="/api/public/estimates/${encodeURIComponent(token)}/respond">
         <input type="hidden" name="action" value="accept">
         <input type="hidden" name="hadlines" value="1">
         ${lineRows}
         <div class="total"><span>Total as quoted</span><span>${asMoney(total)}</span></div>
         <p style="font-size:13px">If you uncheck an item, your total will be lower than the figure above. Your choice cannot be changed through this link once submitted.</p>
         <button class="button" type="submit">Confirm Acceptance</button></form>`
      : `<p>Please confirm your response below. Your choice cannot be changed through this link after it is submitted.</p>
         <form method="post" action="/api/public/estimates/${encodeURIComponent(token)}/respond">
         <input type="hidden" name="action" value="${action}">
         <button class="button" type="submit">Confirm ${accepting ? "Acceptance" : "Decline"}</button></form>`
  }
  <p class="foot">${escapeHtml(companyName)}</p></main></body></html>`;
}

/**
 * Which line indexes the customer left ticked.
 *
 * Returns null when the form carried no `line` field at all — an estimate with
 * nothing selectable, or a client that stripped the inputs. Null means "all of
 * them", matching what accepting meant before this feature existed; treating a
 * missing field as "none selected" would silently cancel a sale the customer
 * thought they had just agreed to.
 */
function parseSelectedLines(
  raw: unknown,
  lines: EstimateLine[],
  formHadCheckboxes: boolean,
): number[] | null {
  // A form that offered checkboxes and came back with none ticked really means
  // none — browsers omit unchecked boxes entirely, so the absent field is the
  // only evidence, and only the marker tells it apart from a form that never
  // had boxes at all.
  if (raw === undefined) return formHadCheckboxes ? [] : null;
  const values = Array.isArray(raw) ? raw : [raw];
  const valid = new Set(selectableLines(lines).map(({ index }) => index));
  const chosen = values
    .flatMap((v) => String(v).split(","))
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && valid.has(n));
  // A package is accepted whole or not at all. Its box carries every member
  // index, so a normal submission already arrives complete; this closes the
  // gap where an edited form names one member and would un-bundle the price.
  const expanded = new Set(chosen);
  for (const choice of responseChoices(lines)) {
    if (choice.packageKey && choice.indexes.some((i) => expanded.has(i))) {
      for (const i of choice.indexes) expanded.add(i);
    }
  }
  return [...expanded].sort((a, b) => a - b);
}

// Public customer response routes. Tokens are random, only their SHA-256 hashes are stored.
// GET is deliberately read-only because email security scanners commonly prefetch links.
router.get("/public/estimates/:token/respond", async (req, res) => {
  const action = req.query.action;
  if (action !== "accept" && action !== "decline") {
    return res.status(400).send(responsePage("Invalid response", "This response link is not valid.", false));
  }
  const data = await loadPublicEstimate(req.params.token);
  if (!data) return res.status(404).send(responsePage("Link not found", "This estimate link is invalid or expired.", false));
  const { estimate } = data;
  if (estimate.status === "accepted" || estimate.status === "declined") {
    const accepted = estimate.status === "accepted";
    return res.send(
      responsePage(
        `Estimate already ${estimate.status}`,
        `Your response was recorded on ${estimate.respondedAt?.toLocaleDateString("en-US") ?? "an earlier date"}.`,
        accepted,
      ),
    );
  }
  const company = await getCompanyProfile();
  return res.send(
    responseConfirmationPage(
      req.params.token,
      action,
      estimate.id,
      estimate.lines as EstimateLine[],
      company.name,
    ),
  );
});

router.post("/public/estimates/:token/respond", async (req, res) => {
  const action = req.body.action;
  if (action !== "accept" && action !== "decline") {
    return res.status(400).send(responsePage("Invalid response", "This response is not valid.", false));
  }
  const data = await loadPublicEstimate(req.params.token);
  if (!data) return res.status(404).send(responsePage("Link not found", "This estimate link is invalid or expired.", false));
  const { estimate } = data;
  if (estimate.status === "accepted" || estimate.status === "declined") {
    return res.send(
      responsePage(
        `Estimate already ${estimate.status}`,
        `Your response was recorded on ${estimate.respondedAt?.toLocaleDateString("en-US") ?? "an earlier date"}.`,
        estimate.status === "accepted",
      ),
    );
  }
  const status = action === "accept" ? "accepted" : "declined";
  const providerAccepted = data.tokenSource === "provider_accepted";

  const lines = estimate.lines as EstimateLine[];
  const selectable = selectableLines(lines);
  const formHadCheckboxes = req.body.hadlines === "1";
  const selected =
    action === "accept" ? parseSelectedLines(req.body.line, lines, formHadCheckboxes) : null;

  // Unticking everything is a decline in all but name. Recording it as an
  // acceptance worth $0 would leave the office chasing a sale that does not
  // exist, so send them back rather than guessing which they meant.
  if (action === "accept" && selected !== null && selected.length === 0 && selectable.length > 0) {
    const company = await getCompanyProfile();
    return res.send(
      responseConfirmationPage(
        req.params.token,
        "accept",
        estimate.id,
        lines,
        company.name,
      ).replace(
        "Everything below is included.",
        "Please keep at least one item ticked, or use the decline link in your email if you do not want any of it.",
      ),
    );
  }

  const acceptedLines = action === "accept" ? selected : null;
  const acceptedTotal =
    action === "accept"
      ? acceptedLines === null
        ? estimate.total
        : lines.reduce(
            (sum, line, index) =>
              acceptedLines.includes(index) ? sum + (line.calculatedPrice ?? 0) : sum,
            0,
          )
      : null;

  const [updated] = await db
    .update(estimatesTable)
    .set(
      providerAccepted
        ? {
            status,
            respondedAt: new Date(),
            responseTokenHash: data.hash,
            pendingResponseTokenHash: null,
            deliveryState: "sent",
            acceptedLines,
            acceptedTotal,
          }
        : { status, respondedAt: new Date(), acceptedLines, acceptedTotal },
    )
    .where(
      providerAccepted
        ? and(
            eq(estimatesTable.id, estimate.id),
            eq(estimatesTable.deliveryState, "provider_accepted"),
            eq(estimatesTable.pendingResponseTokenHash, data.hash),
          )
        : and(
            eq(estimatesTable.id, estimate.id),
            eq(estimatesTable.status, "sent"),
            eq(estimatesTable.responseTokenHash, data.hash),
          ),
    )
    .returning();
  if (!updated) {
    const latest = await loadPublicEstimate(req.params.token);
    return res.send(
      responsePage(
        `Estimate already ${latest?.estimate.status ?? "answered"}`,
        "A response has already been recorded for this estimate.",
        latest?.estimate.status === "accepted",
      ),
    );
  }
  await logAudit({
    clientId: estimate.clientId,
    actorName: data.client.name,
    action: `estimate_${status}`,
    // Naming the declined items matters more than the accepted ones: a partial
    // acceptance is the office's cue to follow up on what was turned down.
    description:
      status === "accepted"
        ? acceptedLines === null || acceptedLines.length === selectable.length
          ? `Accepted estimate #${estimate.id} in full`
          : (() => {
              // Counted by what they could tick: a declined package is one
              // "no", not four, however many services it bundled.
              const choices = responseChoices(lines);
              const declined = choices.filter((c) => !c.indexes.every((i) => acceptedLines.includes(i)));
              return (
                `Accepted estimate #${estimate.id} in part (${choices.length - declined.length} of ${choices.length} items, ` +
                `${asMoney(acceptedTotal ?? 0)} of ${asMoney(estimate.total)}). Declined: ` +
                declined.map((c) => (c.packageKey ? `${c.label} (package)` : c.label)).join(", ")
              );
            })()
        : `Declined estimate #${estimate.id}`,
  });
  // Putting the sale on the account (assigned services + the jobs the
  // scheduling rules call for) lives behind the conditional update above: only
  // the single request that actually flipped "sent" → "accepted" gets here, so
  // a prefetched link, a double-click or a retried POST cannot do it twice.
  //
  // It must also never break the acceptance. The customer's approval is already
  // committed and the page they see is about that approval — a row or a rule
  // that fails is an office problem, so it is logged and the customer is
  // thanked either way.
  if (status === "accepted") {
    try {
      const outcome = await putAcceptedEstimateOnAccount(updated, { clientName: data.client.name });
      if (outcome.assigned.length || outcome.scheduled.length) {
        req.log.info(
          {
            estimateId: updated.id,
            clientServiceIds: outcome.assigned.map((a) => a.clientServiceId),
            jobIds: outcome.scheduled.map((s) => s.jobId),
          },
          "accepted estimate put on the account",
        );
      }
    } catch (schedulingError) {
      req.log.error(
        { err: schedulingError, estimateId: updated.id },
        "estimate accepted but putting it on the account failed; the office must assign and schedule this by hand",
      );
      try {
        await logAudit({
          clientId: estimate.clientId,
          action: "estimate_scheduling_failed",
          description:
            `Estimate #${estimate.id} was accepted, but it could not be put on the account automatically: ` +
            `${schedulingError instanceof Error ? schedulingError.message : String(schedulingError)}`.slice(0, 500),
        });
      } catch (auditError) {
        req.log.error({ err: auditError, estimateId: updated.id }, "scheduling failure audit write failed");
      }
    }
  }
  return res.send(
    responsePage(
      `Estimate ${status}`,
      status === "accepted"
        ? "Thank you — your approval has been recorded. Bison Lawn Care will follow up with next steps."
        : "Your response has been recorded. Bison Lawn Care will follow up if needed.",
      status === "accepted",
    ),
  );
});

router.use(["/estimate-fields", "/charge-presets", "/estimates"], requireAuth, requireAdmin);

/**
 * The label/price rules a one-off charge must satisfy. Applied to hand-typed
 * custom estimate lines and, identically, to the saved presets that get copied
 * into them — a preset must never be able to carry a value onto an estimate
 * that the estimate itself would reject.
 */
function validateChargeLabel(rawLabel: string): string {
  const label = rawLabel.trim();
  if (!label) {
    throw Object.assign(new Error("A custom line needs a label"), { status: 400 });
  }
  return label;
}

function validateChargePrice(label: string, price: number | null | undefined): number {
  if (price == null || !Number.isFinite(price)) {
    throw Object.assign(new Error(`"${label}" needs a numeric price`), { status: 400 });
  }
  return Math.round(price * 100) / 100;
}

// ---- estimate fields ----

router.get("/estimate-fields", async (_req, res) => {
  return res.json(await db.select().from(estimateFieldsTable).orderBy(estimateFieldsTable.sortOrder, estimateFieldsTable.id));
});

router.post("/estimate-fields", async (req, res) => {
  const body = CreateEstimateFieldBody.parse(req.body);
  const [field] = await db.insert(estimateFieldsTable).values(body).returning();
  return res.status(201).json(field);
});

router.patch("/estimate-fields/:id", async (req, res) => {
  const body = UpdateEstimateFieldBody.parse(req.body);
  const [field] = await db
    .update(estimateFieldsTable)
    .set(body)
    .where(eq(estimateFieldsTable.id, Number(req.params.id)))
    .returning();
  if (!field) return res.status(404).json({ error: "Field not found" });
  return res.json(field);
});

router.delete("/estimate-fields/:id", async (req, res) => {
  await db.delete(estimateFieldsTable).where(eq(estimateFieldsTable.id, Number(req.params.id)));
  return res.status(204).end();
});

// ---- charge presets ----
// Templates for the custom (one-off) charge lines on an estimate. Shared by the
// whole office. Inserting a preset copies its label and price onto the estimate,
// so renaming or deleting one here leaves existing estimates exactly as saved.

/** Reject a preset the same way the estimate would reject the line it becomes. */
function parseChargePreset(raw: { label?: string; defaultPrice?: number }) {
  const label = validateChargeLabel(raw.label ?? "");
  return { label, defaultPrice: validateChargePrice(label, raw.defaultPrice) };
}

router.get("/charge-presets", async (_req, res) => {
  // Only estimate charges: the parts and fees list (kind 'product', served by
  // /product-presets) shares the table but a bag fee has no place on a quote.
  return res.json(
    await db
      .select()
      .from(chargePresetsTable)
      .where(eq(chargePresetsTable.kind, "charge"))
      .orderBy(chargePresetsTable.label, chargePresetsTable.id),
  );
});

router.post("/charge-presets", async (req, res) => {
  let values: { label: string; defaultPrice: number };
  try {
    values = parseChargePreset(CreateChargePresetBody.parse(req.body));
  } catch (error) {
    const message = chargePresetBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  const [preset] = await db.insert(chargePresetsTable).values(values).returning();
  return res.status(201).json(preset);
});

router.patch("/charge-presets/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(chargePresetsTable).where(eq(chargePresetsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Charge preset not found" });
  let values: { label: string; defaultPrice: number };
  try {
    const body = UpdateChargePresetBody.parse(req.body);
    values = parseChargePreset({
      label: body.label ?? existing.label,
      defaultPrice: body.defaultPrice ?? existing.defaultPrice,
    });
  } catch (error) {
    const message = chargePresetBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  const [preset] = await db
    .update(chargePresetsTable)
    .set(values)
    .where(eq(chargePresetsTable.id, id))
    .returning();
  if (!preset) return res.status(404).json({ error: "Charge preset not found" });
  return res.json(preset);
});

router.delete("/charge-presets/:id", async (req, res) => {
  // Presets are templates, never references: estimates hold their own copy of
  // the label and price, so deleting one changes nothing that was already built.
  await db.delete(chargePresetsTable).where(eq(chargePresetsTable.id, Number(req.params.id)));
  return res.status(204).end();
});

/** Our own 400s carry a message; a schema failure would otherwise be an opaque 500. */
function chargePresetBadRequestMessage(error: unknown): string | null {
  if (error instanceof Error && (error as { status?: number }).status === 400) return error.message;
  if (error instanceof Error && error.name === "ZodError") {
    return "This preset could not be saved. Give it a label and a numeric price.";
  }
  return null;
}

// ---- estimates ----

async function withClientName(est: typeof estimatesTable.$inferSelect) {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, est.clientId));
  const [cover] = est.coverTemplateId
    ? await db
        .select({ name: documentTemplatesTable.name })
        .from(documentTemplatesTable)
        .where(eq(documentTemplatesTable.id, est.coverTemplateId))
    : [];
  return { ...est, clientName: client?.name ?? null, coverTemplateName: cover?.name ?? null };
}

/**
 * The cover document must exist when it is chosen; a typo'd id would silently
 * send the plain greeting. Undefined means "not mentioned" (leave alone on an
 * edit), null means "clear it".
 */
async function resolveCoverTemplateId(raw: number | null | undefined): Promise<number | null | undefined> {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const [template] = await db
    .select({ id: documentTemplatesTable.id })
    .from(documentTemplatesTable)
    .where(eq(documentTemplatesTable.id, raw));
  if (!template) {
    throw Object.assign(new Error("The cover document you chose no longer exists. Pick another one."), { status: 400 });
  }
  return template.id;
}

router.get("/estimates", async (req, res) => {
  const clientId = req.query.clientId ? Number(req.query.clientId) : undefined;
  const rows = await db
    .select()
    .from(estimatesTable)
    .where(clientId ? eq(estimatesTable.clientId, clientId) : undefined)
    .orderBy(desc(estimatesTable.createdAt));
  return res.json(await Promise.all(rows.map(withClientName)));
});

/**
 * A count typed on a service line (quantity or visits): absent means "use the
 * service's default", anything present must be a real non-negative number.
 * Zero is allowed on purpose — "0 visits" is how he prices a line at nothing
 * while keeping it on the quote as a talking point.
 */
function lineCount(label: string, field: "quantity" | "visits", raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`"${label}" needs a numeric ${field} of zero or more`), { status: 400 });
  }
  return field === "visits" ? Math.round(n) : n;
}

/**
 * Package fields are only meaningful together: a key without a package id (or
 * the other way round) is a client bug, and half a package on the response
 * page would let a customer un-bundle it. Field and custom lines never carry
 * them.
 */
function packageFields(line: EstimateLine) {
  const packageId = line.packageId ?? null;
  const packageKey = line.packageKey ?? null;
  if (packageId == null && packageKey == null) return { packageId: null, packageKey: null, packageName: null };
  if (packageId == null || !Number.isInteger(packageId) || !packageKey || typeof packageKey !== "string") {
    throw Object.assign(new Error(`"${line.label}" has an incomplete package reference`), { status: 400 });
  }
  return { packageId, packageKey: packageKey.slice(0, 80), packageName: (line.packageName ?? "").trim().slice(0, 120) || null };
}

/**
 * Recompute each line's price from the authoritative field/service definitions
 * so a client cannot submit arbitrary prices for configured items.
 * - Calculable fields: value / unitSize * pricePerUnit
 * - Services: the band rate for the property's value (turf sqft, or whichever
 *   field the service prices from), or the flat rate when there is no matrix,
 *   times quantity times visits — his "rate x qty x visits". The band rate is
 *   returned as unitPrice so the customer can see the per-visit figure.
 * - Other field types are informational (no price)
 * - Custom lines (no fieldId/serviceId): the submitted price is kept, but the
 *   label and the price are validated because nothing else vouches for them
 */
async function priceEstimateLines(
  lines: EstimateLine[],
  clientId: number,
  /**
   * Every line on the estimate, when only some of them are being repriced.
   * The sqft typed on a field line prices the service line next to it, and an
   * edit that only touches the service line must still see it.
   */
  context: EstimateLine[] = lines,
): Promise<EstimateLine[]> {
  const serviceIds = [...new Set(lines.map((l) => l.serviceId).filter((id): id is number => id != null))];
  const services = serviceIds.length
    ? await db.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds))
    : [];
  // Every field definition, not only the ones on the lines: a service whose
  // pricingFieldId is null prices off turf square footage, and the turf field
  // has to be found by its label before the account can be asked for it.
  const fields = await db.select().from(estimateFieldsTable);
  const [client] = await db
    .select({ propertyData: clientsTable.propertyData })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId));
  const propertyData = (client?.propertyData ?? {}) as Record<string, unknown>;
  const round = (n: number) => Math.round(n * 100) / 100;

  /**
   * The measurement a service line is priced from, in the order the office
   * expects it: what was typed on the line, then what was measured on this
   * estimate's own property fields, then what the customer's account says.
   *
   * The last step is the one "the numbers don't match the matrix based on
   * clients account" was about. The builder used to be the only thing that
   * read the account, so a line that reached the server with an empty box —
   * a package dropped in before the sqft loaded, a line carried over from an
   * older quote — was quietly priced at the flat rate while the Services page
   * tester and the assigned service both showed the band price for the very
   * same lawn.
   */
  const measurementFor = (svc: { pricingFieldId: number | null }, raw: string): number | null => {
    const typed = numericFieldValue(raw);
    if (typed != null) return typed;
    const field = pricingFieldOf(svc, fields);
    if (!field) return null;
    const onThisEstimate = context.find((l) => l.fieldId === field.id);
    const measured = onThisEstimate ? numericFieldValue(onThisEstimate.value) : null;
    if (measured != null) return measured;
    return numericFieldValue(propertyData[field.label]);
  };

  return lines.map((line) => {
    if (line.serviceId != null) {
      const svc = services.find((s) => s.id === line.serviceId);
      if (!svc) throw Object.assign(new Error(`Service ${line.serviceId} not found`), { status: 400 });
      const label = (line.label ?? "").trim() || svc.name;
      const pricingField = pricingFieldOf(svc, fields);
      const measurement = svc.pricingEquations.length > 0 ? measurementFor(svc, line.value) : null;
      // A clean-up he bills by the hour is quoted at the hours it is budgeted
      // for, times the hourly rate. Quoting the bare $65/hr as the price of the
      // visit under-quotes a three-hour job by two thirds, and the invoice the
      // clock produces would come out at three times what the customer said yes
      // to. The hours ride along on the line so the quote can show the math.
      const hours = svc.billingMode === "time" ? (svc.billableHours ?? 1) : null;
      const unitPrice =
        hours != null
          ? round(svc.rate * hours)
          : measurement != null
            ? priceService(svc, pricingField, measurement).price
            : round(svc.rate);
      const quantity = lineCount(label, "quantity", line.quantity) ?? svc.quantity ?? 1;
      const visits = lineCount(label, "visits", line.visits) ?? svc.visitsPerSeason ?? 1;
      return {
        ...line,
        ...packageFields(line),
        label,
        // The measurement it was actually priced from, written back plainly, so
        // the quote the customer reads says which number produced the rate —
        // and so a comma off the old import does not come back next edit.
        value: measurement != null ? String(measurement) : line.value,
        unitPrice,
        quantity,
        visits,
        hours,
        calculatedPrice: roundMoney(unitPrice * quantity * visits),
      };
    }
    if (line.fieldId != null) {
      const field = fields.find((f) => f.id === line.fieldId);
      if (!field) throw Object.assign(new Error(`Estimate field ${line.fieldId} not found`), { status: 400 });
      if (field.fieldType === "calculable") {
        // "14,500" is a number to the office and to the import that wrote it,
        // so it has to be one here too — and it is stored back without the
        // comma, because this is the value the account keeps afterwards.
        const numeric = numericFieldValue(line.value);
        if (numeric == null) {
          throw Object.assign(new Error(`"${field.label}" needs a numeric value`), { status: 400 });
        }
        const unitSize = field.unitSize && field.unitSize > 0 ? field.unitSize : 1;
        return {
          ...line,
          label: field.label,
          value: String(numeric),
          calculatedPrice: round((numeric / unitSize) * (field.pricePerUnit ?? 0)),
        };
      }
      return { ...line, label: field.label, calculatedPrice: null };
    }
    // Custom line (one-off charge such as a haul-away fee or a discount): there
    // is no definition to price it from, so the submitted amount is kept. Since
    // that amount is trusted, it must at least be a real label and a real number.
    const label = validateChargeLabel(line.label);
    return { ...line, label, calculatedPrice: validateChargePrice(label, line.calculatedPrice) };
  });
}

/**
 * A saved line whose field or service has since been deleted can no longer be
 * repriced. Such lines are historical: an edit carries them through byte-for-byte
 * instead of failing, but only lines that exactly match what is already stored
 * qualify — otherwise a dangling reference would be a way to submit any price.
 */
const historicalLineKey = (line: EstimateLine) =>
  JSON.stringify([line.fieldId ?? null, line.serviceId ?? null, line.label, line.value, line.calculatedPrice ?? null]);

async function danglingLineCounts(lines: EstimateLine[]): Promise<Map<string, number>> {
  const fieldIds = [...new Set(lines.map((l) => l.fieldId).filter((id): id is number => id != null))];
  const serviceIds = [...new Set(lines.map((l) => l.serviceId).filter((id): id is number => id != null))];
  const fields = fieldIds.length
    ? await db.select({ id: estimateFieldsTable.id }).from(estimateFieldsTable).where(inArray(estimateFieldsTable.id, fieldIds))
    : [];
  const services = serviceIds.length
    ? await db.select({ id: servicesTable.id }).from(servicesTable).where(inArray(servicesTable.id, serviceIds))
    : [];
  const counts = new Map<string, number>();
  for (const line of lines) {
    const missing =
      (line.fieldId != null && !fields.some((f) => f.id === line.fieldId)) ||
      (line.serviceId != null && !services.some((s) => s.id === line.serviceId));
    if (!missing) continue;
    const key = historicalLineKey(line);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Price submitted lines, passing through the estimate's own historical lines
 * (deleted field/service references) untouched and in their submitted order.
 */
async function priceEstimateLinesPreservingHistory(
  submitted: EstimateLine[],
  savedLines: EstimateLine[],
  clientId: number,
): Promise<EstimateLine[]> {
  const remaining = await danglingLineCounts(savedLines);
  const slots: (EstimateLine | null)[] = [];
  const repriceable: EstimateLine[] = [];
  for (const line of submitted) {
    const key = historicalLineKey(line);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      slots.push({ ...line, calculatedPrice: line.calculatedPrice ?? null });
    } else {
      slots.push(null);
      repriceable.push(line);
    }
  }
  const priced = await priceEstimateLines(repriceable, clientId, submitted);
  let next = 0;
  return slots.map((preserved) => preserved ?? priced[next++]);
}

/**
 * Sum the priced lines to the estimate's grand total, rejecting a total below
 * zero. Individual negative lines are legitimate (that is how a discount is
 * entered), but a negative *total* says the business owes the customer money —
 * in practice a mistyped discount such as -750 for -75, which the PDF and the
 * customer email would otherwise show verbatim.
 */
function estimateTotalOrThrow(lines: EstimateLine[]): number {
  const total = Math.round(lines.reduce((s, l) => s + (l.calculatedPrice ?? 0), 0) * 100) / 100;
  if (total < 0) {
    throw Object.assign(
      new Error(
        `This estimate totals $${total.toFixed(2)}, which would owe the customer money. ` +
          "Check the discount amount — the total must be zero or more.",
      ),
      { status: 400 },
    );
  }
  return total;
}

/**
 * Turn a rejected estimate body into a message for the caller: our own pricing
 * errors carry status 400, and a schema failure (for example a custom line whose
 * price is not a number) would otherwise surface as an opaque 500.
 */
function estimateBadRequestMessage(error: unknown): string | null {
  if (error instanceof Error && (error as { status?: number }).status === 400) return error.message;
  if (error instanceof Error && error.name === "ZodError") {
    return "This estimate could not be saved. Check that every line has a label and that custom lines have a numeric price.";
  }
  return null;
}

/**
 * Merge the estimate's field values back into the client's saved property
 * details. Matching is by field label — the same key the estimate builder uses
 * when it prefills values — so a corrected Turf Sqft or Gate Code carries over
 * to the next estimate. Only field lines participate: service and one-off
 * charge lines describe work, not the property. Blank values are ignored so an
 * empty box never wipes a saved value, and existing keys not on this estimate
 * are left untouched.
 *
 * Runs inside the estimate-creation transaction on a client row already locked
 * with SELECT ... FOR UPDATE, so two admins saving estimates for the same
 * client cannot both read the old document and have the later write drop the
 * earlier one's values. If the write-back fails the whole save fails, so the
 * admin is never told property details were updated when they were not.
 */
async function mergePropertyDataFromLines(
  tx: Pick<typeof db, "update">,
  client: { id: number; propertyData: Record<string, string> | null },
  lines: EstimateLine[],
) {
  const entries = lines
    .filter((l) => l.fieldId != null && l.label.trim() !== "" && l.value.trim() !== "")
    .map((l) => [l.label, l.value] as const);
  if (!entries.length) return [];

  const current = client.propertyData ?? {};
  const merged = { ...current };
  const changedLabels: string[] = [];
  for (const [label, value] of entries) {
    if (current[label] === value) continue;
    merged[label] = value;
    changedLabels.push(label);
  }
  if (!changedLabels.length) return [];

  await tx.update(clientsTable).set({ propertyData: merged }).where(eq(clientsTable.id, client.id));
  return changedLabels;
}

router.post("/estimates", async (req, res) => {
  let body: ReturnType<typeof CreateEstimateBody.parse>;
  let lines: EstimateLine[];
  let total: number;
  let coverTemplateId: number | null;
  try {
    body = CreateEstimateBody.parse(req.body);
    lines = await priceEstimateLines(body.lines, body.clientId);
    total = estimateTotalOrThrow(lines);
    coverTemplateId = (await resolveCoverTemplateId(body.coverTemplateId)) ?? null;
  } catch (error) {
    const message = estimateBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  // One transaction so the estimate and the client's refreshed property details
  // either both land or neither does. The client row is locked first: property
  // details are one JSON document, so concurrent saves must take turns reading
  // and rewriting it or the later one silently drops the earlier one's values.
  const saved = await db.transaction(async (tx) => {
    const [client] = await tx
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, body.clientId))
      .for("update");
    if (!client) return null;
    const [created] = await tx
      .insert(estimatesTable)
      .values({
        clientId: body.clientId,
        notes: body.notes ?? null,
        coverNote: body.coverNote ?? null,
        includeServiceDescriptions: body.includeServiceDescriptions ?? false,
        coverTemplateId,
        lines,
        total,
      })
      .returning();
    const changed = body.savePropertyData
      ? await mergePropertyDataFromLines(tx, client, lines)
      : [];
    return { est: created, changedLabels: changed };
  });
  if (!saved) return res.status(404).json({ error: "Client not found" });
  const { est, changedLabels } = saved;
  await logAudit({
    clientId: body.clientId,
    actorName: req.appUser?.name,
    action: "estimate_created",
    description: `Created estimate #${est.id} for $${est.total}`,
  });
  if (changedLabels.length) {
    await logAudit({
      clientId: body.clientId,
      actorName: req.appUser?.name,
      action: "property_data_updated",
      description: `Updated property details from estimate #${est.id}: ${changedLabels.join(", ")}`,
    });
  }
  // Report exactly which details were written so the UI never claims an update
  // that did not happen (nothing selected, blanks only, or values unchanged).
  return res.status(201).json({ ...(await withClientName(est)), propertyDataUpdated: changedLabels });
});

router.get("/estimates/:id", async (req, res) => {
  const [est] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, Number(req.params.id)));
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  return res.json(await withClientName(est));
});

/**
 * Edit a draft estimate in place. Only drafts are editable: once an estimate is
 * sent, accepted, or declined the customer has seen (or answered) those exact
 * numbers, so revisions must go out as a new estimate. Lines are repriced
 * server-side from the current field/service definitions; lines whose field or
 * service has since been deleted are carried through exactly as stored.
 *
 * Edits are optimistically concurrent: the client sends back the `version` it
 * loaded and a stale value is rejected with 409 plus the current estimate, so
 * two admins on the same draft cannot silently overwrite each other.
 */
router.patch("/estimates/:id", async (req, res) => {
  let body: ReturnType<typeof UpdateEstimateBody.parse>;
  try {
    body = UpdateEstimateBody.parse(req.body);
  } catch (error) {
    const message = estimateBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  const id = Number(req.params.id);
  const [existing] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, id));
  if (!existing) return res.status(404).json({ error: "Estimate not found" });
  if (existing.status !== "draft") {
    return res.status(409).json({
      error: `This estimate was already ${existing.status} and can no longer be edited. Create a new estimate for revised terms.`,
    });
  }
  if (existing.deliveryState === "sending" || existing.deliveryState === "provider_accepted") {
    return res.status(409).json({
      error: "This estimate is being emailed right now. Finish or reconcile that delivery before editing.",
    });
  }
  if (body.version !== existing.version) {
    return res.status(409).json({
      error:
        "Someone else saved changes to this estimate while you were editing. Reload the current version and reapply your changes.",
      code: "estimate_version_conflict",
      current: await withClientName(existing),
    });
  }

  let lines: EstimateLine[];
  let total: number;
  let coverTemplateId: number | null | undefined;
  try {
    lines = await priceEstimateLinesPreservingHistory(body.lines, existing.lines, existing.clientId);
    total = estimateTotalOrThrow(lines);
    coverTemplateId = await resolveCoverTemplateId(body.coverTemplateId);
  } catch (error) {
    const message = estimateBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }

  // Re-check the draft state and the version inside the write so a send claimed
  // (or a competing edit committed) between the read above and here cannot have
  // its numbers changed underneath it.
  const [updated] = await db
    .update(estimatesTable)
    .set({
      notes: body.notes ?? null,
      coverNote: body.coverNote === undefined ? existing.coverNote : body.coverNote,
      includeServiceDescriptions:
        body.includeServiceDescriptions === undefined
          ? existing.includeServiceDescriptions
          : body.includeServiceDescriptions,
      coverTemplateId: coverTemplateId === undefined ? existing.coverTemplateId : coverTemplateId,
      lines,
      total,
      version: existing.version + 1,
    })
    .where(
      and(
        eq(estimatesTable.id, id),
        eq(estimatesTable.status, "draft"),
        eq(estimatesTable.deliveryState, existing.deliveryState),
        eq(estimatesTable.version, body.version),
      ),
    )
    .returning();
  if (!updated) {
    // Lost the race with a competing edit or a send claimed in between. Hand
    // back the row as it stands now so the admin can reload and reapply.
    const [latest] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, id));
    if (!latest) return res.status(404).json({ error: "Estimate not found" });
    return res.status(409).json({
      error:
        "Someone else saved changes to this estimate while you were editing. Reload the current version and reapply your changes.",
      code: "estimate_version_conflict",
      current: await withClientName(latest),
    });
  }

  await logAudit({
    clientId: updated.clientId,
    actorName: req.appUser?.name,
    action: "estimate_updated",
    description: `Edited draft estimate #${updated.id} — ${lines.length} line${lines.length === 1 ? "" : "s"}, total $${existing.total} → $${updated.total}`,
  });
  return res.json(await withClientName(updated));
});

router.get("/estimates/:id/pdf", async (req, res) => {
  const data = await loadEstimateDocument(Number(req.params.id));
  if (!data) return res.status(404).json({ error: "Estimate not found" });
  const pdf = await createEstimatePdf(data);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="bison-estimate-${data.estimate.id}.pdf"`);
  return res.send(pdf);
});

router.post("/estimates/:id/reconcile-delivery", async (req, res) => {
  const data = await loadEstimateDocument(Number(req.params.id));
  if (!data) return res.status(404).json({ error: "Estimate not found" });
  const { estimate } = data;
  if (
    !estimate.pendingResponseTokenHash ||
    (estimate.deliveryState !== "provider_accepted" && estimate.deliveryState !== "sending")
  ) {
    return res.status(409).json({ error: "This estimate has no interrupted delivery to reconcile." });
  }
  const reconciled = await reconcileEstimateDelivery(
    estimate.id,
    estimate.pendingResponseTokenHash,
    estimate.sentToEmail,
    estimate.gmailMessageId,
  );
  if (!reconciled) return res.status(409).json({ error: "Delivery state changed; refresh and try again." });
  await logAudit({
    clientId: reconciled.clientId,
    actorName: req.appUser?.name,
    action: "estimate_delivery_reconciled",
    description: `Reconciled estimate #${reconciled.id} without sending another email`,
  });
  return res.json(await withClientName(reconciled));
});

router.delete("/estimates/:id", async (req, res) => {
  await db.delete(estimatesTable).where(eq(estimatesTable.id, Number(req.params.id)));
  return res.status(204).end();
});

/**
 * The documents and photos one send should carry, beyond the estimate PDF.
 *
 * Read off the raw body rather than through SendEstimateBody, which does not
 * know these fields yet and strips whatever it does not declare. Absent means
 * the behaviour this route has always had — the estimate PDF alone — so an
 * older client keeps working unchanged. A malformed list is refused instead of
 * quietly dropped: a document the sender picked and the customer never received
 * is precisely the failure this feature exists to prevent.
 */
type AttachmentSelection = { documentTemplateIds: number[]; photoIds: number[] };

function parseIdList(raw: unknown, field: string): number[] {
  if (raw == null) return [];
  const reject = () =>
    Object.assign(new Error(`${field} must be a list of ids`), { status: 400 });
  if (!Array.isArray(raw)) throw reject();
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw reject();
  }
  return [...new Set(raw as number[])];
}

function parseAttachmentSelection(rawBody: unknown): AttachmentSelection {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  return {
    documentTemplateIds: parseIdList(body.documentTemplateIds, "documentTemplateIds"),
    photoIds: parseIdList(body.photoIds, "photoIds"),
  };
}

const slugForFile = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/**
 * A name that tells the customer which photo they are looking at. The caption is
 * preferred because it is what the crew wrote about that shot; the kind and id
 * behind it keep "Before" and "Before" from colliding in one email.
 */
function photoFileName(photo: JobPhoto): string {
  // Only the subtype is needed, and image/jpeg is the one case where the
  // subtype is not the extension anybody expects to see.
  const extension = photo.contentType === "image/jpeg" ? "jpg" : photo.contentType.split("/")[1] ?? "jpg";
  const caption = photo.caption ? slugForFile(photo.caption) : "";
  return `${caption || photo.kind || "photo"}-${photo.id}.${extension}`;
}

/**
 * Turn the sender's selection into files, or refuse the send outright.
 *
 * Everything here happens before the delivery is claimed. A photo missing from
 * disk, a deleted template or a selection too large for Gmail is the sender's to
 * fix, and failing at this point leaves the estimate exactly as it was rather
 * than burning a delivery attempt and parking it in "failed".
 *
 * It is all or nothing by design: a before-and-after pair where only the "after"
 * arrived tells the customer a story that is not true, so an unreadable
 * attachment stops the send and says which one it was.
 */
async function collectEstimateAttachments(
  data: NonNullable<Awaited<ReturnType<typeof loadEstimateDocument>>>,
  selection: AttachmentSelection,
  company: CompanyProfile,
): Promise<EmailAttachment[]> {
  const { estimate, client } = data;
  if (!selection.documentTemplateIds.length && !selection.photoIds.length) return [];

  const templates = selection.documentTemplateIds.length
    ? await db
        .select()
        .from(documentTemplatesTable)
        .where(inArray(documentTemplatesTable.id, selection.documentTemplateIds))
    : [];
  const missingTemplate = selection.documentTemplateIds.find((id) => !templates.some((t) => t.id === id));
  if (missingTemplate != null) {
    throw Object.assign(
      new Error("A document you chose has been deleted. Reload the page and choose again."),
      { status: 409 },
    );
  }

  const photos = selection.photoIds.length
    ? await db.select().from(jobPhotosTable).where(inArray(jobPhotosTable.id, selection.photoIds))
    : [];
  const missingPhoto = selection.photoIds.find((id) => !photos.some((p) => p.id === id));
  if (missingPhoto != null) {
    throw Object.assign(
      new Error("A photo you chose has been deleted. Reload the page and choose again."),
      { status: 409 },
    );
  }
  // Photos are customer property records. Sending one belonging to a different
  // customer would put somebody's house in a stranger's inbox, so the estimate's
  // own client is the only source this route will attach from.
  const foreign = photos.find((photo) => photo.clientId !== estimate.clientId);
  if (foreign) {
    throw Object.assign(
      new Error(`Photo #${foreign.id} belongs to a different customer and cannot be sent with this estimate.`),
      { status: 400 },
    );
  }

  // Rendered with the customer's real values, exactly as the Settings preview
  // renders them. A document that reaches a customer still reading
  // "[clientfname]" is worse than one that was never sent.
  const context = {
    client,
    company,
    servicesBlock: quotedServicesBlock(estimate.lines as EstimateLine[]),
    quoteTotal: estimate.total,
  };
  const documents: EmailAttachment[] = [];
  for (const id of selection.documentTemplateIds) {
    const template = templates.find((t) => t.id === id)!;
    documents.push({
      fileName: `${slugForFile(template.name) || `document-${template.id}`}.pdf`,
      contentType: "application/pdf",
      bytes: await renderDocumentPdf({
        title: template.name,
        body: renderTemplate(template.body, context),
        company,
      }),
    });
  }

  // Weighed on the recorded sizes before a single photo is read, so an oversized
  // selection costs one query rather than 25MB of disk reads and memory.
  const total =
    documents.reduce((sum, document) => sum + encodedAttachmentBytes(document.bytes.byteLength), 0) +
    photos.reduce((sum, photo) => sum + encodedAttachmentBytes(photo.byteSize), 0);
  if (total > ATTACHMENT_BUDGET_BYTES) {
    throw Object.assign(
      new Error(
        `These attachments come to ${describeBytes(total)}, and one email can carry about ` +
          `${describeBytes(ATTACHMENT_BUDGET_BYTES)} alongside the estimate. ` +
          "Send the largest photos in a follow-up email, or choose fewer.",
      ),
      { status: 413 },
    );
  }

  const attachments = [...documents];
  for (const id of selection.photoIds) {
    const photo = photos.find((p) => p.id === id)!;
    let bytes: Buffer;
    try {
      bytes = await readFile(photo.storageKey);
    } catch (error) {
      throw Object.assign(
        new Error(
          `Photo #${photo.id} could not be read from storage, so nothing was sent. ` +
            "Remove it from the selection or re-upload it, then try again.",
        ),
        { status: 502, cause: error },
      );
    }
    attachments.push({ fileName: photoFileName(photo), contentType: photo.contentType, bytes });
  }
  return attachments;
}

router.post("/estimates/:id/send", async (req, res) => {
  const body = SendEstimateBody.parse(req.body);
  let selection: AttachmentSelection;
  try {
    selection = parseAttachmentSelection(req.body);
  } catch (error) {
    const message = estimateBadRequestMessage(error);
    if (message) return res.status(400).json({ error: message });
    throw error;
  }
  const data = await loadEstimateDocument(Number(req.params.id));
  if (!data) return res.status(404).json({ error: "Estimate not found" });
  if (data.estimate.status === "accepted" || data.estimate.status === "declined") {
    return res.status(409).json({
      error: `This estimate was already ${data.estimate.status}. Create a new estimate for revised terms.`,
    });
  }
  if (data.estimate.deliveryState === "provider_accepted") {
    return res.status(409).json({
      error: "Gmail already accepted this email. Reconcile the delivery instead of sending another copy.",
    });
  }

  // Read the profile directly rather than off the document data: the branding
  // the PDF builder caches onto that object is not part of its declared type,
  // and reaching through it would couple this to that implementation detail.
  const company = await getCompanyProfile();

  // Gathered before the claim below, so a bad selection never touches delivery
  // state. See collectEstimateAttachments for why it refuses rather than trims.
  let attachments: EmailAttachment[];
  try {
    attachments = await collectEstimateAttachments(data, selection, company);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status && error instanceof Error) return res.status(status).json({ error: error.message });
    throw error;
  }

  const token = randomBytes(32).toString("base64url");
  const hash = tokenHash(token);
  // Atomically claim this estimate before contacting Gmail. This serializes
  // concurrent sends and persists the exact response capability first, so a
  // provider-success/database-failure cannot cause an automatic duplicate.
  const claimed = await claimEstimateDelivery(data.estimate.id, hash);
  if (!claimed) {
    return res.status(409).json({ error: "This estimate is already being sent or has a final response." });
  }

  let providerAccepted = false;
  try {
    // Every operation after the claim belongs in this recovery boundary. Any
    // pre-provider failure releases the claim to "failed" so an admin can retry.
    const origin = publicAppOrigin();
    const publicPath = `/api/public/estimates/${encodeURIComponent(token)}/respond`;
    const acceptUrl = `${origin}${publicPath}?action=accept`;
    const declineUrl = `${origin}${publicPath}?action=decline`;
    const pdf = await createEstimatePdf(data);
    const html = createEstimateEmailHtml(data, body.message, acceptUrl, declineUrl);
    const subject = `Estimate #${data.estimate.id} from ${company.name}`;

    const sentMessage = await sendEstimateViaGmail({
      toEmail: body.toEmail,
      subject,
      html,
      pdf,
      estimateId: data.estimate.id,
      company,
      attachments,
    });
    providerAccepted = true;
    const accepted = await recordEstimateProviderAccepted(
      data.estimate.id,
      hash,
      body.toEmail,
      sentMessage.id ?? null,
    );
    if (!accepted) {
      throw new Error(
        "Gmail accepted the email, but the provider-accepted recovery state could not be saved",
      );
    }
    const est = await finalizeEstimateDelivery(
      data.estimate.id,
      hash,
      body.toEmail,
      sentMessage.id ?? null,
    );
    if (!est) throw new Error("Email was accepted by Gmail, but delivery state could not be finalized");
    try {
      await logAudit({
        clientId: est.clientId,
        actorName: req.appUser?.name,
        action: "estimate_sent",
        // The attachment count is part of the record: "which photos did we send
        // them?" is asked months later, when the selection is long forgotten.
        description:
          `Emailed estimate #${est.id} to ${body.toEmail}` +
          (attachments.length
            ? ` with ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} ` +
              `(${attachments.map((a) => a.fileName).join(", ")})`
            : ""),
      });
    } catch (auditError) {
      req.log.error({ err: auditError, estimateId: est.id }, "email sent but estimate audit write failed");
    }
    return res.json(await withClientName(est));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown delivery error";
    if (!providerAccepted) {
      await releaseEstimateDelivery(data.estimate.id, hash, message);
    }
    try {
      await logAudit({
        clientId: data.estimate.clientId,
        actorName: req.appUser?.name,
        action: "estimate_delivery_failed",
        description: `Estimate #${data.estimate.id} delivery failed: ${message.slice(0, 180)}`,
      });
    } catch (auditError) {
      req.log.error({ err: auditError, estimateId: data.estimate.id }, "estimate delivery failure audit write failed");
    }
    return res.status(providerAccepted ? 500 : 502).json({
      error: providerAccepted
        ? "Gmail accepted the email, but confirmation could not be saved. Do not retry automatically."
        : "Estimate email could not be delivered. Please retry.",
      detail: message,
    });
  }
});

export default router;
