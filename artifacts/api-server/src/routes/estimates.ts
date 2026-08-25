import { Router, type IRouter } from "express";
import { db, estimateFieldsTable, estimatesTable, clientsTable } from "@workspace/db";
import { and, desc, eq, or } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import {
  CreateEstimateFieldBody,
  UpdateEstimateFieldBody,
  CreateEstimateBody,
  SendEstimateBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit } from "../lib/helpers";
import { createEstimateEmailHtml, createEstimatePdf } from "../lib/estimateDocument";
import { sendEstimateViaGmail } from "../lib/estimateDelivery";
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
  return client ? { estimate, client } : null;
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
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return "http://localhost:8080";
}

function responsePage(title: string, message: string, success: boolean) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{margin:0;background:#f7f5f1;color:#2b2118;font-family:Arial,sans-serif;display:grid;min-height:100vh;place-items:center}.card{background:#fff;border:1px solid #e7e2dc;border-radius:16px;padding:42px;max-width:520px;text-align:center;box-shadow:0 12px 40px #2b211814}.mark{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;margin:0 auto 20px;background:${success ? "#eaf3ee" : "#f3ece8"};color:${success ? "#176b45" : "#864f36"};font-size:30px}h1{margin:0 0 12px}p{color:#6f675f;line-height:1.6}</style></head>
  <body><main class="card"><div class="mark">${success ? "✓" : "×"}</div><h1>${title}</h1><p>${message}</p><p>Bison Lawn Care LLC</p></main></body></html>`;
}

function responseConfirmationPage(token: string, action: "accept" | "decline", estimateId: number) {
  const accepting = action === "accept";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Respond to estimate</title>
  <style>body{margin:0;background:#f7f5f1;color:#2b2118;font-family:Arial,sans-serif;display:grid;min-height:100vh;place-items:center}.card{background:#fff;border:1px solid #e7e2dc;border-radius:16px;padding:42px;max-width:520px;text-align:center;box-shadow:0 12px 40px #2b211814}h1{margin:0 0 12px}p{color:#6f675f;line-height:1.6}.button{border:0;border-radius:7px;padding:14px 26px;font-size:16px;font-weight:bold;cursor:pointer;background:${accepting ? "#176b45" : "#864f36"};color:#fff}</style></head>
  <body><main class="card"><h1>${accepting ? "Accept" : "Decline"} estimate #${estimateId}?</h1><p>Please confirm your response below. Your choice cannot be changed through this link after it is submitted.</p>
  <form method="post" action="/api/public/estimates/${encodeURIComponent(token)}/respond"><input type="hidden" name="action" value="${action}"><button class="button" type="submit">Confirm ${accepting ? "Acceptance" : "Decline"}</button></form>
  <p>Bison Lawn Care LLC</p></main></body></html>`;
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
  return res.send(responseConfirmationPage(req.params.token, action, estimate.id));
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
          }
        : { status, respondedAt: new Date() },
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
    description: `${status === "accepted" ? "Accepted" : "Declined"} estimate #${estimate.id}`,
  });
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

router.use(["/estimate-fields", "/estimates"], requireAuth, requireAdmin);

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

// ---- estimates ----

async function withClientName(est: typeof estimatesTable.$inferSelect) {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, est.clientId));
  return { ...est, clientName: client?.name ?? null };
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

router.post("/estimates", async (req, res) => {
  const body = CreateEstimateBody.parse(req.body);
  const total = body.lines.reduce((s, l) => s + (l.calculatedPrice ?? 0), 0);
  const [est] = await db
    .insert(estimatesTable)
    .values({
      clientId: body.clientId,
      notes: body.notes ?? null,
      lines: body.lines,
      total: Math.round(total * 100) / 100,
    })
    .returning();
  await logAudit({
    clientId: body.clientId,
    actorName: req.appUser?.name,
    action: "estimate_created",
    description: `Created estimate #${est.id} for $${est.total}`,
  });
  return res.status(201).json(await withClientName(est));
});

router.get("/estimates/:id", async (req, res) => {
  const [est] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, Number(req.params.id)));
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  return res.json(await withClientName(est));
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

router.post("/estimates/:id/send", async (req, res) => {
  const body = SendEstimateBody.parse(req.body);
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
    const subject = `Estimate #${data.estimate.id} from Bison Lawn Care LLC`;

    const sentMessage = await sendEstimateViaGmail({
      toEmail: body.toEmail,
      subject,
      html,
      pdf,
      estimateId: data.estimate.id,
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
        description: `Emailed estimate #${est.id} to ${body.toEmail}`,
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
