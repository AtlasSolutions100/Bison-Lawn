import { Router, type IRouter, type Request } from "express";
import {
  db,
  automationRunsTable,
  weatherRulesTable,
  schedulingRulesTable,
  suggestedActionsTable,
  jobsTable,
  clientsTable,
  servicesTable,
  usersTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  CreateWeatherRuleBody,
  UpdateWeatherRuleBody,
  CreateSchedulingRuleBody,
  UpdateSchedulingRuleBody,
  RunWeatherCheckBody,
  UpdateSuggestedActionBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit } from "../lib/helpers";
import { runWeatherCheckForDate } from "../lib/weatherCheck";
import { ensureDefaultSchedulingRules } from "../lib/schedulingRules";
import { ensureDailyWeatherCheck, getWeatherCheckStatus } from "../lib/weatherScheduler";
import {
  createCustomerMessageEmailHtml,
  customerMessageSubject,
  sendCustomerMessageViaGmail,
} from "../lib/customerMessageDelivery";
import { defaultGmailProxy, type GmailProxy } from "../lib/gmail";
import { expireAbandonedMessageClaims } from "../lib/abandonedMessageClaims";
import { getCompanyProfile } from "../lib/companyProfile";

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

// ---------- scheduling rules ----------

type SchedulingRuleRow = typeof schedulingRulesTable.$inferSelect;

/**
 * Resolve the service and assignee names the rule points at, so the editor can
 * render a rule without joining anything client-side.
 */
async function hydrateSchedulingRules(rows: SchedulingRuleRow[]) {
  if (rows.length === 0) return [];
  const serviceIds = [...new Set(rows.map((r) => r.serviceId).filter((x): x is number => x != null))];
  const userIds = [...new Set(rows.map((r) => r.assignedToId).filter((x): x is number => x != null))];
  const [services, users] = await Promise.all([
    serviceIds.length ? db.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds)) : Promise.resolve([]),
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : Promise.resolve([]),
  ]);
  const sMap = new Map(services.map((s) => [s.id, s.name]));
  const uMap = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    ...r,
    serviceName: r.serviceId ? (sMap.get(r.serviceId) ?? null) : null,
    assignedToName: r.assignedToId ? (uMap.get(r.assignedToId) ?? null) : null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Human-readable summary of what a rule does, for the audit trail. */
function describeSchedulingRule(rule: SchedulingRuleRow, serviceName: string | null) {
  const target = serviceName ? `"${serviceName}"` : "any other service";
  const outcome =
    rule.action === "waiting_list"
      ? `waiting list ${rule.windowStartMonthDay ?? "any"} → ${rule.windowEndMonthDay ?? "any"}`
      : rule.action === "none"
        ? "no job"
        : `${rule.action} +${rule.offsetDays} day(s)`;
  return `${target} → ${outcome}`;
}

router.get("/scheduling-rules", async (_req, res) => {
  // First read puts the starting policy in place (once — see the seed marker),
  // so the office has something to change instead of an empty page.
  await ensureDefaultSchedulingRules();
  const rows = await db
    .select()
    .from(schedulingRulesTable)
    .orderBy(asc(schedulingRulesTable.sortOrder), asc(schedulingRulesTable.id));
  return res.json(await hydrateSchedulingRules(rows));
});

router.post("/scheduling-rules", async (req, res) => {
  const body = CreateSchedulingRuleBody.parse(req.body);
  const [rule] = await db.insert(schedulingRulesTable).values(body).returning();
  const [hydrated] = await hydrateSchedulingRules([rule]);
  await logAudit({
    actorName: req.appUser?.name,
    action: "scheduling_rule_created",
    description: `Created scheduling rule #${rule.id}: ${describeSchedulingRule(rule, hydrated.serviceName)}`,
  });
  return res.status(201).json(hydrated);
});

router.patch("/scheduling-rules/:id", async (req, res) => {
  const body = UpdateSchedulingRuleBody.parse(req.body);
  const [existing] = await db
    .select()
    .from(schedulingRulesTable)
    .where(eq(schedulingRulesTable.id, Number(req.params.id)));
  if (!existing) return res.status(404).json({ error: "Rule not found" });
  const [rule] = await db
    .update(schedulingRulesTable)
    // The office edits these live; stamping the change is what tells them which
    // rule was touched last when a job lands somewhere unexpected.
    .set({ ...body, updatedAt: new Date() })
    .where(eq(schedulingRulesTable.id, existing.id))
    .returning();
  const [hydrated] = await hydrateSchedulingRules([rule]);
  const changes = (Object.keys(body) as (keyof typeof body)[])
    .filter((k) => body[k] !== undefined && (existing as any)[k] !== body[k])
    .map((k) => `${k}: ${JSON.stringify((existing as any)[k])} → ${JSON.stringify(body[k])}`);
  await logAudit({
    actorName: req.appUser?.name,
    action: "scheduling_rule_updated",
    description:
      `Updated scheduling rule #${existing.id} (${describeSchedulingRule(rule, hydrated.serviceName)})` +
      `${changes.length ? `: ${changes.join(", ")}` : ""}`,
  });
  return res.json(hydrated);
});

router.delete("/scheduling-rules/:id", async (req, res) => {
  const [existing] = await db
    .select()
    .from(schedulingRulesTable)
    .where(eq(schedulingRulesTable.id, Number(req.params.id)));
  if (existing) {
    const [hydrated] = await hydrateSchedulingRules([existing]);
    await db.delete(schedulingRulesTable).where(eq(schedulingRulesTable.id, existing.id));
    await logAudit({
      actorName: req.appUser?.name,
      action: "scheduling_rule_deleted",
      description: `Deleted scheduling rule #${existing.id}: ${describeSchedulingRule(existing, hydrated.serviceName)}`,
    });
  }
  return res.status(204).end();
});

// ---------- weather check ----------

/**
 * Admin-triggered weather check. The rule evaluation itself lives in
 * lib/weatherCheck so the daily scheduler runs exactly the same logic.
 * Nothing is changed automatically — triggered rules only create pending
 * suggested actions that an admin must review and approve.
 */
router.post("/weather-check", async (req, res) => {
  const body = RunWeatherCheckBody.parse(req.body);
  const date = body.date;

  const [run] = await db
    .insert(automationRunsTable)
    .values({
      kind: "weather",
      trigger: "manual",
      datesChecked: [date],
      status: "running",
      triggeredBy: req.appUser?.name ?? null,
    })
    .returning();

  try {
    const outcome = await runWeatherCheckForDate(date);
    await db
      .update(automationRunsTable)
      .set({
        status: "succeeded",
        jobsChecked: outcome.jobsChecked,
        suggestionsCreated: outcome.suggestionsCreated,
        summary: outcome.forecastSummary,
        finishedAt: new Date(),
      })
      .where(eq(automationRunsTable.id, run.id));

    return res.json({
      date: outcome.date,
      jobsChecked: outcome.jobsChecked,
      suggestionsCreated: outcome.suggestionsCreated,
      forecastSummary: outcome.forecastSummary,
      suggestions: await hydrateSuggestions(outcome.created),
    });
  } catch (err) {
    await db
      .update(automationRunsTable)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      })
      .where(eq(automationRunsTable.id, run.id));
    throw err;
  }
});

/** Schedule settings plus the last automatic/manual run, for the admin panel. */
router.get("/weather-check/status", async (_req, res) => {
  return res.json(await getWeatherCheckStatus());
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

router.get("/suggested-actions", async (req, res) => {
  // Opening the queue is the last line of defence for the daily weather check:
  // if the deployment slept through the scheduled hour, the due run happens
  // (once, via the database day-claim) before the queue is returned, so the
  // office never reviews a stale list.
  await ensureDailyWeatherCheck();

  // The background sweeper (see lib/abandonedMessageClaims) is what guarantees
  // interrupted deliveries get flagged; sweeping here too keeps the queue
  // accurate the instant it is opened. The sweep is idempotent, so the overlap
  // costs nothing.
  await expireAbandonedMessageClaims();

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
    // Skip/reschedule notices are as much a letter from the business as an
    // estimate is, so they carry the same identity rather than a hardcoded name.
    const company = await getCompanyProfile();
    const sent = await sendCustomerMessageViaGmail(
      {
        toEmail,
        subject: customerMessageSubject(suggestion.actionType, suggestion.targetDate, company),
        html: createCustomerMessageEmailHtml(suggestion.customerMessage!, clientName, company),
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

/**
 * Retry emailing an approved customer message that never reached the customer.
 *
 * Only a delivery that ended in "failed" (or "no_email", once an address has
 * been added to the client) can be retried: a message that already reached the
 * customer must never be sent twice. The transaction re-claims delivery by
 * moving that terminal state back to "sending" with a fresh claim stamp, so two
 * concurrent resend clicks cannot both hand the same message to Gmail and an
 * interrupted retry ages out like any other claim. Every attempt is audited,
 * and a retry that fails again is recorded rather than thrown.
 *
 * An "abandoned" delivery is deliberately not retryable here: nobody knows
 * whether that send reached the customer, and its original attempt may still
 * be in flight and entitled to write its own outcome.
 */
router.post("/suggested-actions/:id/resend-message", async (req, res) => {
  const id = Number(req.params.id);

  const claimed = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(suggestedActionsTable)
      .where(eq(suggestedActionsTable.id, id))
      .for("update");
    if (!locked) return { failure: { status: 404, message: "Suggestion not found" } };
    if (locked.status !== "approved") {
      return { failure: { status: 400, message: "Only an approved suggestion can have its message resent" } };
    }
    if (!locked.customerMessage?.trim()) {
      return { failure: { status: 422, message: "This suggestion has no customer message to send" } };
    }
    if (locked.messageDeliveryState === "sent") {
      return { failure: { status: 409, message: "This message already reached the customer; it cannot be resent" } };
    }
    if (locked.messageDeliveryState === "sending") {
      return {
        failure: { status: 409, message: "This message is already being sent; wait for that attempt to finish" },
      };
    }
    if (locked.messageDeliveryState === "abandoned") {
      return {
        failure: {
          status: 409,
          message:
            "Delivery was interrupted and it is unknown whether this email went out; contact the customer directly rather than risking a duplicate",
        },
      };
    }
    if (locked.messageDeliveryState !== "failed" && locked.messageDeliveryState !== "no_email") {
      return { failure: { status: 400, message: "There is no failed delivery to retry for this suggestion" } };
    }

    const [client] = await tx.select().from(clientsTable).where(eq(clientsTable.id, locked.clientId));
    const toEmail = client?.email?.trim() || null;
    if (!toEmail) {
      return {
        failure: {
          status: 422,
          message: "This client still has no email address on file — add one to the client record first",
        },
      };
    }

    const [suggestion] = await tx
      .update(suggestedActionsTable)
      .set({
        messageDeliveryState: "sending",
        messageDeliveryClaimedAt: new Date(),
        messageDeliveryError: null,
      })
      .where(eq(suggestedActionsTable.id, id))
      .returning();
    return { suggestion, toEmail, clientName: client?.name ?? null, previousState: locked.messageDeliveryState };
  });

  if ("failure" in claimed && claimed.failure) {
    const { status, message } = claimed.failure;
    return res.status(status).json({ error: message });
  }

  const suggestion = claimed.suggestion!;
  await logAudit({
    clientId: suggestion.clientId,
    actorName: req.appUser?.name,
    action: "suggestion_message_resend_attempted",
    description:
      `Retrying the approved ${suggestion.actionType} message for suggestion #${suggestion.id}` +
      ` to ${claimed.toEmail} (previous delivery: ${claimed.previousState})`,
  });

  const delivered = await deliverCustomerMessage(suggestion, claimed.toEmail, claimed.clientName, req);
  return res.json((await hydrateSuggestions([delivered]))[0]);
});

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
