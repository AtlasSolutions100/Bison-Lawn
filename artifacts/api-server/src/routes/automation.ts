import { Router, type IRouter, type Request } from "express";
import {
  db,
  weatherRulesTable,
  suggestedActionsTable,
  jobsTable,
  clientsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import {
  CreateWeatherRuleBody,
  UpdateWeatherRuleBody,
  RunWeatherCheckBody,
  UpdateSuggestedActionBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit } from "../lib/helpers";
import {
  createCustomerMessageEmailHtml,
  customerMessageSubject,
  sendCustomerMessageViaGmail,
} from "../lib/customerMessageDelivery";
import { defaultGmailProxy, type GmailProxy } from "../lib/gmail";

const router: IRouter = Router();

// The mail provider used for approved customer messages. Tests replace it with
// a stub so the sent/failed outcomes can be exercised without touching Gmail.
let customerMessageGmailProxy: GmailProxy = defaultGmailProxy;

/** Swap the Gmail proxy used for approved customer messages (tests only). */
export function setCustomerMessageGmailProxyForTests(proxy: GmailProxy | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The customer message Gmail proxy can only be replaced in tests");
  }
  customerMessageGmailProxy = proxy ?? defaultGmailProxy;
}

// Every automation endpoint is admin-only: rules, checks, and the review queue.
router.use(requireAuth, requireAdmin);

// ---------- weather rules ----------

router.get("/weather-rules", async (_req, res) => {
  const rows = await db.select().from(weatherRulesTable).orderBy(desc(weatherRulesTable.createdAt));
  return res.json(rows);
});

router.post("/weather-rules", async (req, res) => {
  const body = CreateWeatherRuleBody.parse(req.body);
  const [rule] = await db.insert(weatherRulesTable).values(body).returning();
  await logAudit({
    actorName: req.appUser?.name,
    action: "weather_rule_created",
    description: `Created weather rule "${rule.name}" (${rule.conditionType} ≥ ${rule.threshold}, action: ${rule.actionType})`,
  });
  return res.status(201).json(rule);
});

router.patch("/weather-rules/:id", async (req, res) => {
  const body = UpdateWeatherRuleBody.parse(req.body);
  const [existing] = await db
    .select()
    .from(weatherRulesTable)
    .where(eq(weatherRulesTable.id, Number(req.params.id)));
  if (!existing) return res.status(404).json({ error: "Rule not found" });
  const [rule] = await db
    .update(weatherRulesTable)
    .set(body)
    .where(eq(weatherRulesTable.id, existing.id))
    .returning();
  const changes = (Object.keys(body) as (keyof typeof body)[])
    .filter((k) => body[k] !== undefined && (existing as any)[k] !== body[k])
    .map((k) => `${k}: ${JSON.stringify((existing as any)[k])} → ${JSON.stringify(body[k])}`);
  await logAudit({
    actorName: req.appUser?.name,
    action: "weather_rule_updated",
    description: `Updated weather rule "${existing.name}" (#${existing.id})${changes.length ? `: ${changes.join(", ")}` : ""}`,
  });
  return res.json(rule);
});

router.delete("/weather-rules/:id", async (req, res) => {
  const [existing] = await db
    .select()
    .from(weatherRulesTable)
    .where(eq(weatherRulesTable.id, Number(req.params.id)));
  if (existing) {
    await db.delete(weatherRulesTable).where(eq(weatherRulesTable.id, existing.id));
    await logAudit({
      actorName: req.appUser?.name,
      action: "weather_rule_deleted",
      description: `Deleted weather rule "${existing.name}" (#${existing.id}, ${existing.conditionType} threshold ${existing.threshold}, action: ${existing.actionType})`,
    });
  }
  return res.status(204).end();
});

// ---------- weather check ----------

type DailyForecast = {
  precipitationMm: number;
  windKph: number;
  maxTempC: number;
  minTempC: number;
};

/** Fetch the daily forecast for a location/date from Open-Meteo (no API key needed). */
async function fetchForecast(lat: number, lng: number, date: string): Promise<DailyForecast | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=precipitation_sum,wind_speed_10m_max,temperature_2m_max,temperature_2m_min` +
    `&start_date=${date}&end_date=${date}&timezone=auto`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    daily?: {
      precipitation_sum?: (number | null)[];
      wind_speed_10m_max?: (number | null)[];
      temperature_2m_max?: (number | null)[];
      temperature_2m_min?: (number | null)[];
    };
  };
  const d = data.daily;
  if (!d) return null;
  return {
    precipitationMm: d.precipitation_sum?.[0] ?? 0,
    windKph: d.wind_speed_10m_max?.[0] ?? 0,
    maxTempC: d.temperature_2m_max?.[0] ?? 0,
    minTempC: d.temperature_2m_min?.[0] ?? 0,
  };
}

function ruleTriggered(rule: typeof weatherRulesTable.$inferSelect, f: DailyForecast): { hit: boolean; observed: string } {
  switch (rule.conditionType) {
    case "rain":
      return { hit: f.precipitationMm >= rule.threshold, observed: `${f.precipitationMm} mm rain` };
    case "wind":
      return { hit: f.windKph >= rule.threshold, observed: `${f.windKph} km/h wind` };
    case "heat":
      return { hit: f.maxTempC >= rule.threshold, observed: `${f.maxTempC}°C high` };
    case "cold":
      return { hit: f.minTempC <= rule.threshold, observed: `${f.minTempC}°C low` };
    default:
      return { hit: false, observed: "" };
  }
}

function addDaysISO(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildMessage(template: string | null, vars: Record<string, string>): string {
  const base =
    template ??
    "Hi {clientName}, due to weather conditions ({reason}) we need to {action} your service on {date}.{newDatePart} Sorry for the inconvenience — Bison Lawn Care.";
  return base
    .replace(/\{clientName\}/g, vars.clientName)
    .replace(/\{reason\}/g, vars.reason)
    .replace(/\{action\}/g, vars.action)
    .replace(/\{date\}/g, vars.date)
    .replace(/\{newDate\}/g, vars.newDate)
    .replace(/\{newDatePart\}/g, vars.newDatePart);
}

/**
 * Evaluate all enabled weather rules against jobs scheduled for a date.
 * Nothing is changed automatically — triggered rules only create pending
 * suggested actions that an admin must review and approve.
 */
router.post("/weather-check", async (req, res) => {
  const body = RunWeatherCheckBody.parse(req.body);
  const date = body.date;

  const rules = await db.select().from(weatherRulesTable).where(eq(weatherRulesTable.enabled, true));
  const jobs = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.dispatched, true), eq(jobsTable.scheduledDate, date)));
  const activeJobs = jobs.filter((j) => j.status !== "completed");

  if (rules.length === 0 || activeJobs.length === 0) {
    return res.json({ date, jobsChecked: activeJobs.length, suggestionsCreated: 0, forecastSummary: null, suggestions: [] });
  }

  const clientIds = [...new Set(activeJobs.map((j) => j.clientId))];
  const clients = await db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds));
  const cMap = new Map(clients.map((c) => [c.id, c]));

  // Existing pending suggestions so a re-run doesn't duplicate them.
  const existing = await db
    .select()
    .from(suggestedActionsTable)
    .where(and(eq(suggestedActionsTable.source, "weather"), eq(suggestedActionsTable.status, "pending")));
  const existingKeys = new Set(existing.map((s) => `${s.jobId}:${s.ruleId}`));

  // Cache forecasts by rounded coordinates so nearby clients share a lookup.
  const forecastCache = new Map<string, DailyForecast | null>();
  async function forecastFor(lat: number, lng: number): Promise<DailyForecast | null> {
    const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
    if (!forecastCache.has(key)) {
      try {
        forecastCache.set(key, await fetchForecast(lat, lng, date));
      } catch {
        forecastCache.set(key, null);
      }
    }
    return forecastCache.get(key)!;
  }

  const created: (typeof suggestedActionsTable.$inferSelect)[] = [];
  let sampleForecast: DailyForecast | null = null;
  let forecastMissing = 0;

  for (const job of activeJobs) {
    const client = cMap.get(job.clientId);
    if (!client || client.lat == null || client.lng == null) {
      forecastMissing++;
      continue;
    }
    const forecast = await forecastFor(client.lat, client.lng);
    if (!forecast) {
      forecastMissing++;
      continue;
    }
    sampleForecast = sampleForecast ?? forecast;

    for (const rule of rules) {
      const { hit, observed } = ruleTriggered(rule, forecast);
      if (!hit) continue;
      if (existingKeys.has(`${job.id}:${rule.id}`)) continue;

      const newDate = rule.actionType === "reschedule" ? addDaysISO(date, rule.rescheduleDays) : null;
      const reason = `${rule.name}: ${observed} forecast on ${date}`;
      const customerMessage = buildMessage(rule.messageTemplate, {
        clientName: client.name,
        reason: observed,
        action: rule.actionType === "reschedule" ? "reschedule" : "skip",
        date,
        newDate: newDate ?? "",
        newDatePart: newDate ? ` We plan to come instead on ${newDate}.` : "",
      });

      const [suggestion] = await db
        .insert(suggestedActionsTable)
        .values({
          source: "weather",
          ruleId: rule.id,
          jobId: job.id,
          clientId: job.clientId,
          actionType: rule.actionType,
          reason,
          targetDate: date,
          newDate,
          customerMessage,
        })
        .returning();
      created.push(suggestion);
      existingKeys.add(`${job.id}:${rule.id}`);

      await logAudit({
        clientId: job.clientId,
        actorName: "Weather automation",
        action: "suggestion_created",
        description: `Suggested ${rule.actionType} for job #${job.id} (${reason}) — awaiting admin review`,
      });
    }
  }

  const forecastSummary = sampleForecast
    ? `Forecast for ${date}: ${sampleForecast.precipitationMm} mm rain, ${sampleForecast.windKph} km/h max wind, high ${sampleForecast.maxTempC}°C / low ${sampleForecast.minTempC}°C` +
      (forecastMissing ? ` (${forecastMissing} job(s) skipped — missing location or forecast)` : "")
    : forecastMissing === activeJobs.length
      ? "No forecast available — jobs are missing client map locations or the weather service was unreachable"
      : null;

  return res.json({
    date,
    jobsChecked: activeJobs.length,
    suggestionsCreated: created.length,
    forecastSummary,
    suggestions: await hydrateSuggestions(created),
  });
});

// ---------- suggested actions (review queue) ----------

type SuggestionRow = typeof suggestedActionsTable.$inferSelect;

async function hydrateSuggestions(rows: SuggestionRow[]) {
  if (rows.length === 0) return [];
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const ruleIds = [...new Set(rows.map((r) => r.ruleId).filter((x): x is number => x != null))];
  const userIds = [...new Set(rows.map((r) => r.reviewedById).filter((x): x is number => x != null))];
  const [clients, rules, users] = await Promise.all([
    db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds)),
    ruleIds.length ? db.select().from(weatherRulesTable).where(inArray(weatherRulesTable.id, ruleIds)) : Promise.resolve([]),
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : Promise.resolve([]),
  ]);
  const cMap = new Map(clients.map((c) => [c.id, c]));
  const rMap = new Map(rules.map((r) => [r.id, r.name]));
  const uMap = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    ...r,
    clientName: cMap.get(r.clientId)?.name ?? null,
    clientEmail: cMap.get(r.clientId)?.email ?? null,
    ruleName: r.ruleId ? (rMap.get(r.ruleId) ?? null) : null,
    reviewedByName: r.reviewedById ? (uMap.get(r.reviewedById) ?? null) : null,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    messageSentAt: r.messageSentAt ? r.messageSentAt.toISOString() : null,
    messageDeliveryClaimedAt: r.messageDeliveryClaimedAt ? r.messageDeliveryClaimedAt.toISOString() : null,
  }));
}

/**
 * How long a delivery claim may stay in "sending" before the office should stop
 * seeing it as in-flight. A Gmail send takes seconds; anything older than this
 * means the request or the server died between the claim and the outcome write.
 */
export const ABANDONED_CLAIM_AGE_MS = 2 * 60 * 1000;

const ABANDONED_CLAIM_MESSAGE =
  "Delivery was interrupted before it completed — the server never recorded whether this email was sent. Assume the customer was not notified.";

/**
 * Age out delivery claims that never reported an outcome. Rows claimed before
 * the cutoff (or with no claim timestamp at all, from before claims were
 * stamped) become "abandoned" so the office sees unfinished work instead of a
 * permanent "sending" badge. A send that is somehow still running can still
 * overwrite this with its real outcome.
 */
async function expireAbandonedMessageClaims(): Promise<SuggestionRow[]> {
  const cutoff = new Date(Date.now() - ABANDONED_CLAIM_AGE_MS);
  return db
    .update(suggestedActionsTable)
    .set({ messageDeliveryState: "abandoned", messageDeliveryError: ABANDONED_CLAIM_MESSAGE })
    .where(
      and(
        eq(suggestedActionsTable.messageDeliveryState, "sending"),
        or(
          isNull(suggestedActionsTable.messageDeliveryClaimedAt),
          lt(suggestedActionsTable.messageDeliveryClaimedAt, cutoff),
        ),
      ),
    )
    .returning();
}

router.get("/suggested-actions", async (req, res) => {
  const abandoned = await expireAbandonedMessageClaims();
  for (const row of abandoned) {
    await logAudit({
      clientId: row.clientId,
      actorName: "System",
      action: "suggestion_message_abandoned",
      description: `The approved ${row.actionType} message for suggestion #${row.id} never finished sending; delivery was interrupted and no outcome was recorded`,
    });
  }

  const q = req.query as Record<string, string | undefined>;
  const conds = [];
  if (q.status) conds.push(eq(suggestedActionsTable.status, q.status));
  const rows = await db
    .select()
    .from(suggestedActionsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(suggestedActionsTable.createdAt));
  return res.json(await hydrateSuggestions(rows));
});

router.patch("/suggested-actions/:id", async (req, res) => {
  const body = UpdateSuggestedActionBody.parse(req.body);
  const [existing] = await db
    .select()
    .from(suggestedActionsTable)
    .where(eq(suggestedActionsTable.id, Number(req.params.id)));
  if (!existing) return res.status(404).json({ error: "Suggestion not found" });
  if (existing.status !== "pending") {
    return res.status(400).json({ error: "Only pending suggestions can be edited" });
  }
  const [updated] = await db
    .update(suggestedActionsTable)
    .set(body)
    .where(eq(suggestedActionsTable.id, existing.id))
    .returning();
  const changes: string[] = [];
  if (body.newDate !== undefined && body.newDate !== existing.newDate) {
    changes.push(`new date: ${JSON.stringify(existing.newDate)} → ${JSON.stringify(body.newDate)}`);
  }
  if (body.customerMessage !== undefined && body.customerMessage !== existing.customerMessage) {
    changes.push(
      `customer message: ${JSON.stringify(existing.customerMessage)} → ${JSON.stringify(body.customerMessage)}`,
    );
  }
  if (changes.length) {
    await logAudit({
      clientId: existing.clientId,
      actorName: req.appUser?.name,
      action: "suggestion_edited",
      description: `Edited pending suggestion #${existing.id}${existing.jobId ? ` (job #${existing.jobId})` : ""}: ${changes.join("; ")}`,
    });
  }
  return res.json((await hydrateSuggestions([updated]))[0]);
});

/**
 * Approving applies the schedule change atomically: reschedule moves the job
 * to the new date; skip returns it to the waiting list. The approved customer
 * message and the change are both written to the audit trail.
 *
 * When the suggestion carries a customer message and the client has an email,
 * the message is emailed after the schedule change commits. The transaction
 * claims delivery ("sending") so the pending → approved transition is the only
 * gate that can hand the message to Gmail, and a failed email never rolls back
 * an already-applied schedule change — it is recorded as "failed" instead.
 */
router.post("/suggested-actions/:id/approve", async (req, res) => {
  const id = Number(req.params.id);

  const applied = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(suggestedActionsTable)
      .where(eq(suggestedActionsTable.id, id))
      .for("update");
    if (!locked) return { error: 404 as const };
    if (locked.status !== "pending") return { error: 400 as const, suggestion: locked };

    if (locked.jobId != null) {
      const [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, locked.jobId)).for("update");
      if (!job) return { error: 410 as const };
      if (job.status === "completed") return { error: 409 as const };
      if (locked.actionType === "reschedule") {
        if (!locked.newDate) return { error: 422 as const };
        await tx
          .update(jobsTable)
          .set({ scheduledDate: locked.newDate, status: "scheduled" })
          .where(eq(jobsTable.id, job.id));
      } else {
        // skip: pull the job off the schedule and back onto the waiting list
        await tx
          .update(jobsTable)
          .set({ dispatched: false, scheduledDate: null, routeOrder: null, status: "scheduled" })
          .where(eq(jobsTable.id, job.id));
      }
    }

    // Claim delivery in the same transaction that approves, so the message can
    // only be handed to Gmail by the single request that wins the transition.
    const [client] = await tx.select().from(clientsTable).where(eq(clientsTable.id, locked.clientId));
    const toEmail = client?.email?.trim() || null;
    const deliveryState = !locked.customerMessage?.trim()
      ? "not_applicable"
      : !toEmail
        ? "no_email"
        : "sending";

    const [suggestion] = await tx
      .update(suggestedActionsTable)
      .set({
        status: "approved",
        reviewedById: req.appUser!.id,
        reviewedAt: new Date(),
        messageDeliveryState: deliveryState,
        // Stamp the claim so an interrupted send can be aged out instead of
        // sitting in "sending" forever.
        messageDeliveryClaimedAt: deliveryState === "sending" ? new Date() : null,
        messageDeliveryError: null,
      })
      .where(eq(suggestedActionsTable.id, id))
      .returning();
    return { suggestion, toEmail, clientName: client?.name ?? null };
  });

  if ("error" in applied && applied.error !== undefined) {
    const messages: Record<number, string> = {
      404: "Suggestion not found",
      400: "Suggestion has already been reviewed",
      410: "The job for this suggestion no longer exists",
      409: "The job has already been completed; nothing to change",
      422: "A reschedule suggestion needs a new date before approval",
    };
    return res.status(applied.error).json({ error: messages[applied.error] });
  }

  let s = applied.suggestion!;
  const deliveryNote =
    s.messageDeliveryState === "sending"
      ? `. Emailing the approved customer message to ${applied.toEmail}`
      : s.messageDeliveryState === "no_email"
        ? ". Customer message could not be emailed: this client has no email address on file"
        : "";
  await logAudit({
    clientId: s.clientId,
    actorName: req.appUser?.name,
    action: "suggestion_approved",
    description:
      `Approved ${s.actionType}${s.jobId ? ` of job #${s.jobId}` : ""}` +
      `${s.actionType === "reschedule" && s.newDate ? ` to ${s.newDate}` : ""} (${s.reason})` +
      `${s.customerMessage ? `. Customer message: "${s.customerMessage}"` : ""}${deliveryNote}`,
  });

  if (s.messageDeliveryState === "sending" && applied.toEmail) {
    s = await deliverCustomerMessage(s, applied.toEmail, applied.clientName ?? null, req);
  }

  return res.json((await hydrateSuggestions([s]))[0]);
});

/**
 * Only the claim that started a send may write its outcome. A claim that was
 * already aged out to "abandoned" can still be corrected by its own send
 * finishing late, but a newer claim's row is never overwritten by an older one.
 */
function ownClaim(suggestion: SuggestionRow) {
  return and(
    eq(suggestedActionsTable.id, suggestion.id),
    inArray(suggestedActionsTable.messageDeliveryState, ["sending", "abandoned"]),
    suggestion.messageDeliveryClaimedAt
      ? eq(suggestedActionsTable.messageDeliveryClaimedAt, suggestion.messageDeliveryClaimedAt)
      : isNull(suggestedActionsTable.messageDeliveryClaimedAt),
  );
}

/** Re-read a suggestion when its outcome write did not apply to this claim. */
async function currentSuggestion(suggestion: SuggestionRow): Promise<SuggestionRow> {
  const [row] = await db
    .select()
    .from(suggestedActionsTable)
    .where(eq(suggestedActionsTable.id, suggestion.id));
  return row ?? suggestion;
}

/**
 * Send the approved message and persist the outcome. The schedule change is
 * already committed, so a delivery failure is recorded and surfaced rather
 * than thrown — the office needs to see it and contact the customer.
 */
async function deliverCustomerMessage(
  suggestion: SuggestionRow,
  toEmail: string,
  clientName: string | null,
  req: Request,
): Promise<SuggestionRow> {
  try {
    const sent = await sendCustomerMessageViaGmail(
      {
        toEmail,
        subject: customerMessageSubject(suggestion.actionType, suggestion.targetDate),
        html: createCustomerMessageEmailHtml(suggestion.customerMessage!, clientName),
      },
      customerMessageGmailProxy,
    );
    const [updated] = await db
      .update(suggestedActionsTable)
      .set({
        messageDeliveryState: "sent",
        messageSentToEmail: toEmail,
        messageSentAt: new Date(),
        messageDeliveryError: null,
        messageGmailId: sent.id ?? null,
      })
      .where(ownClaim(suggestion))
      .returning();
    try {
      await logAudit({
        clientId: suggestion.clientId,
        actorName: req.appUser?.name,
        action: "suggestion_message_sent",
        description: `Emailed the approved ${suggestion.actionType} message for suggestion #${suggestion.id} to ${toEmail}`,
      });
    } catch (auditError) {
      req.log.error({ err: auditError, suggestionId: suggestion.id }, "message sent but audit write failed");
    }
    return updated ?? (await currentSuggestion(suggestion));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown delivery error";
    const [failed] = await db
      .update(suggestedActionsTable)
      .set({
        messageDeliveryState: "failed",
        messageSentToEmail: toEmail,
        messageDeliveryError: message.slice(0, 500),
      })
      .where(ownClaim(suggestion))
      .returning();
    try {
      await logAudit({
        clientId: suggestion.clientId,
        actorName: req.appUser?.name,
        action: "suggestion_message_failed",
        description: `Could not email the approved ${suggestion.actionType} message for suggestion #${suggestion.id} to ${toEmail}: ${message.slice(0, 180)}`,
      });
    } catch (auditError) {
      req.log.error({ err: auditError, suggestionId: suggestion.id }, "message delivery failure audit write failed");
    }
    return failed ?? (await currentSuggestion(suggestion));
  }
}

router.post("/suggested-actions/:id/reject", async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(suggestedActionsTable).where(eq(suggestedActionsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Suggestion not found" });
  if (existing.status !== "pending") {
    return res.status(400).json({ error: "Suggestion has already been reviewed" });
  }
  const [suggestion] = await db
    .update(suggestedActionsTable)
    .set({
      status: "rejected",
      reviewedById: req.appUser!.id,
      reviewedAt: new Date(),
      messageDeliveryState: "not_applicable",
    })
    .where(eq(suggestedActionsTable.id, id))
    .returning();
  await logAudit({
    clientId: suggestion.clientId,
    actorName: req.appUser?.name,
    action: "suggestion_rejected",
    description: `Rejected suggested ${suggestion.actionType}${suggestion.jobId ? ` of job #${suggestion.jobId}` : ""} (${suggestion.reason})`,
  });
  return res.json((await hydrateSuggestions([suggestion]))[0]);
});

export default router;
