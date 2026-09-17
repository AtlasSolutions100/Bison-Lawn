import {
  db,
  auditEventsTable,
  automationRulesTable,
  automationRunsTable,
  automationSendsTable,
  clientsTable,
  documentTemplatesTable,
  emailSendsTable,
  estimatesTable,
  invoicesTable,
  jobsTable,
  servicesTable,
  type AutomationRule,
  type Client,
  type DocumentTemplate,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { ensureDocumentTemplatesOnce } from "./documentTemplateSeeds";
import { deliverDocument, newBatchId, recipientEmail, type DocumentRecipient } from "./documentSend";
import { logAudit } from "./helpers";
import { dueDateFrom, todayISO } from "./invoiceNumbers";
import { logger } from "./logger";
import { letterDate, renderTemplate, type MergeContext } from "./mergeTokens";
import { getCompanyProfile } from "./companyProfile";

/**
 * His automations, the way he described them: "N days after X, send Y,
 * unless Z". Every rule is that one sentence, and this file is the thing
 * that reads the sentence once a day and acts on it.
 */
export const RULE_TRIGGERS = [
  "invoice_past_due",
  "invoice_sent",
  "estimate_sent",
  "job_completed",
  "client_added",
  "fixed_date",
  "after_rule",
] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

export type RuleConditions = {
  /** Only while the invoice is still open or partly paid. */
  stillUnpaid?: boolean;
  /** Only while the estimate has not been accepted or declined. */
  noResponse?: boolean;
  /** job_completed only: just jobs for this service. */
  serviceId?: number | null;
  /** after_rule only: the earlier notice this one follows. */
  afterRuleId?: number | null;
  /**
   * How far back a trigger may sit and still fire. Turning a rule on must
   * not blast a notice at every invoice from three years ago, so anything
   * whose send day fell more than this many days ago is left alone.
   */
  lookbackDays?: number;
};

const DEFAULT_LOOKBACK_DAYS = 30;

export const EMAIL_AUTOMATION_SCHEDULE = {
  /** Local wall-clock time the daily run fires; after the morning's payments have been keyed in. */
  runAtLocalTime: "09:00",
  get timeZone() {
    return process.env.APP_TIME_ZONE || "America/Los_Angeles";
  },
} as const;

const RUN_KIND = "emails";
const TICK_MS = 5 * 60 * 1000;
const CLAIM_LEASE_MS = 20 * 60 * 1000;
const MAX_FAILED_ATTEMPTS_PER_DAY = 3;

// ---------------------------------------------------------------- dates ----

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar day (YYYY-MM-DD) an instant falls on in the office's timezone. */
export function localDay(date: Date, timeZone = EMAIL_AUTOMATION_SCHEDULE.timeZone): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function localMinutes(date: Date, timeZone = EMAIL_AUTOMATION_SCHEDULE.timeZone): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/** Add days to a YYYY-MM-DD string with no timezone involved. */
export function addDays(day: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  const p = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  return Math.round((p(to) - p(from)) / 86_400_000);
}

/**
 * When a notice about `baseDay` is due, and whether today is inside the
 * window where it should still go out.
 */
function isDue(baseDay: string | null, offsetDays: number, today: string, lookbackDays: number): boolean {
  if (!baseDay) return false;
  const fireDay = addDays(baseDay, offsetDays);
  const age = daysBetween(fireDay, today);
  return age >= 0 && age <= lookbackDays;
}

export function conditionsOf(rule: Pick<AutomationRule, "conditions">): RuleConditions {
  const c = (rule.conditions ?? {}) as RuleConditions;
  return {
    stillUnpaid: Boolean(c.stillUnpaid),
    noResponse: Boolean(c.noResponse),
    serviceId: typeof c.serviceId === "number" ? c.serviceId : null,
    afterRuleId: typeof c.afterRuleId === "number" ? c.afterRuleId : null,
    lookbackDays:
      typeof c.lookbackDays === "number" && c.lookbackDays >= 0 ? Math.floor(c.lookbackDays) : DEFAULT_LOOKBACK_DAYS,
  };
}

// ----------------------------------------------------------- candidates ----

export type Candidate = {
  client: Client;
  /** What the rule fired on, so the same notice can never go twice. */
  subjectKey: string;
  /** Plain words for the preview: "Invoice #4901 — $120.00 due Sep 1". */
  subjectLabel: string;
  context: Omit<MergeContext, "client" | "company">;
};

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const UNPAID = ["open", "partial"] as const;

/** The day an invoice is due, filling in the blank the old terms parser left. */
export function effectiveDueDate(invoice: {
  dueDate: string | null;
  invoiceDate: string | null;
  terms: string | null;
  createdAt: Date;
}): string | null {
  if (invoice.dueDate) return invoice.dueDate;
  const issued = invoice.invoiceDate ?? localDay(invoice.createdAt);
  return dueDateFrom(issued, invoice.terms);
}

async function invoiceCandidate(
  invoice: typeof invoicesTable.$inferSelect,
  client: Client,
  today: string,
): Promise<Candidate> {
  const dueDate = effectiveDueDate(invoice);
  const daysOverdue = dueDate ? Math.max(0, daysBetween(dueDate, today)) : null;
  const balance = Math.max(0, Math.round((invoice.total - invoice.amountPaid) * 100) / 100);
  return {
    client,
    subjectKey: `invoice:${invoice.id}`,
    subjectLabel: `Invoice #${invoice.number ?? invoice.id} — ${money(balance)} owed${dueDate ? `, due ${letterDate(dueDate)}` : ""}`,
    context: { invoice: { ...invoice, dueDate, daysOverdue } },
  };
}

function estimateCandidate(estimate: typeof estimatesTable.$inferSelect, client: Client): Candidate {
  return {
    client,
    subjectKey: `estimate:${estimate.id}`,
    subjectLabel: `Estimate #${estimate.id} — ${money(estimate.total)}${estimate.sentAt ? `, sent ${letterDate(estimate.sentAt)}` : ""}`,
    context: { estimate },
  };
}

async function clientsById(ids: number[]): Promise<Map<number, Client>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.select().from(clientsTable).where(inArray(clientsTable.id, unique));
  return new Map(rows.map((c) => [c.id, c]));
}

/**
 * How far a run is allowed to reach. Nothing in the app narrows it — a rule is
 * meant to sweep every customer — but a test must never be able to email, or
 * leave a notice on the record of, somebody it did not create itself.
 */
export type RuleScope = { clientIds?: number[] | null };

/**
 * Everyone a rule would email today, before checking what it already sent.
 *
 * Conditions are re-checked at the moment of the run, not the moment the
 * trigger happened: a past-due notice for an invoice paid this morning must
 * not go out this afternoon.
 */
export async function findCandidates(rule: AutomationRule, today: string, scope?: RuleScope): Promise<Candidate[]> {
  const cond = conditionsOf(rule);
  const lookback = cond.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const out: Candidate[] = [];

  switch (rule.trigger as RuleTrigger) {
    case "invoice_past_due": {
      const invoices = await db.select().from(invoicesTable).where(inArray(invoicesTable.status, [...UNPAID]));
      const clients = await clientsById(invoices.map((i) => i.clientId));
      for (const invoice of invoices) {
        const client = clients.get(invoice.clientId);
        if (!client) continue;
        if (!isDue(effectiveDueDate(invoice), rule.offsetDays, today, lookback)) continue;
        out.push(await invoiceCandidate(invoice, client, today));
      }
      break;
    }
    case "invoice_sent": {
      const invoices = await db
        .select()
        .from(invoicesTable)
        .where(cond.stillUnpaid ? and(isNotNull(invoicesTable.sentAt), inArray(invoicesTable.status, [...UNPAID])) : isNotNull(invoicesTable.sentAt));
      const clients = await clientsById(invoices.map((i) => i.clientId));
      for (const invoice of invoices) {
        const client = clients.get(invoice.clientId);
        if (!client || invoice.status === "void") continue;
        if (!isDue(invoice.sentAt ? localDay(invoice.sentAt) : null, rule.offsetDays, today, lookback)) continue;
        out.push(await invoiceCandidate(invoice, client, today));
      }
      break;
    }
    case "estimate_sent": {
      const estimates = await db
        .select()
        .from(estimatesTable)
        .where(and(isNotNull(estimatesTable.sentAt), eq(estimatesTable.status, "sent")));
      const clients = await clientsById(estimates.map((e) => e.clientId));
      for (const estimate of estimates) {
        const client = clients.get(estimate.clientId);
        if (!client) continue;
        if (cond.noResponse && estimate.respondedAt) continue;
        if (!isDue(estimate.sentAt ? localDay(estimate.sentAt) : null, rule.offsetDays, today, lookback)) continue;
        out.push(estimateCandidate(estimate, client));
      }
      break;
    }
    case "job_completed": {
      const jobs = await db
        .select({ job: jobsTable, serviceName: servicesTable.name })
        .from(jobsTable)
        .leftJoin(servicesTable, eq(servicesTable.id, jobsTable.serviceId))
        .where(
          cond.serviceId != null
            ? and(eq(jobsTable.status, "completed"), isNotNull(jobsTable.completedAt), eq(jobsTable.serviceId, cond.serviceId))
            : and(eq(jobsTable.status, "completed"), isNotNull(jobsTable.completedAt)),
        );
      const clients = await clientsById(jobs.map((j) => j.job.clientId));
      for (const { job, serviceName } of jobs) {
        const client = clients.get(job.clientId);
        if (!client) continue;
        if (!isDue(job.completedAt ? localDay(job.completedAt) : null, rule.offsetDays, today, lookback)) continue;
        out.push({
          client,
          subjectKey: `job:${job.id}`,
          subjectLabel: `${serviceName ?? "Job"} done ${job.completedAt ? letterDate(job.completedAt) : ""}`.trim(),
          context: { job: { scheduledDate: job.scheduledDate, serviceName } },
        });
      }
      break;
    }
    case "client_added": {
      const clients = await db.select().from(clientsTable).where(eq(clientsTable.status, "client"));
      for (const client of clients) {
        if (!isDue(localDay(client.createdAt), rule.offsetDays, today, lookback)) continue;
        out.push({ client, subjectKey: `client:${client.id}`, subjectLabel: `New customer ${letterDate(localDay(client.createdAt))}`, context: {} });
      }
      break;
    }
    case "fixed_date": {
      const monthDay = (rule.monthDay ?? "").trim();
      if (!/^\d{2}-\d{2}$/.test(monthDay)) break;
      // This year's date, or last year's if we are early January and the
      // lookback still reaches it.
      const year = Number(today.slice(0, 4));
      const baseDays = [`${year}-${monthDay}`, `${year - 1}-${monthDay}`];
      const baseDay = baseDays.find((d) => isDue(d, rule.offsetDays, today, lookback));
      if (!baseDay) break;
      const clients = await db.select().from(clientsTable).where(eq(clientsTable.status, "client")).orderBy(asc(clientsTable.name));
      for (const client of clients) {
        out.push({
          client,
          subjectKey: `client:${client.id}:${baseDay.slice(0, 4)}`,
          subjectLabel: `Every year on ${letterDate(baseDay)}`,
          context: {},
        });
      }
      break;
    }
    case "after_rule": {
      if (cond.afterRuleId == null) break;
      const earlier = await db
        .select({ send: automationSendsTable, status: emailSendsTable.status })
        .from(automationSendsTable)
        .leftJoin(emailSendsTable, eq(emailSendsTable.id, automationSendsTable.emailSendId))
        .where(eq(automationSendsTable.ruleId, cond.afterRuleId));
      for (const { send, status } of earlier) {
        // A notice that never actually went out (no email, failed) is not a
        // notice the customer ignored; the follow-up waits for a real one.
        if (status !== "sent") continue;
        if (!isDue(localDay(send.createdAt), rule.offsetDays, today, lookback)) continue;
        const candidate = await candidateFromSubject(send.subjectKey, cond, today);
        if (candidate) out.push(candidate);
      }
      break;
    }
  }
  if (scope?.clientIds) {
    const allowed = new Set(scope.clientIds);
    return out.filter((c) => allowed.has(c.client.id));
  }
  return out;
}

/** Rebuild the candidate an earlier rule fired on, re-checking the conditions now. */
async function candidateFromSubject(subjectKey: string, cond: RuleConditions, today: string): Promise<Candidate | null> {
  const [kind, rawId, extra] = subjectKey.split(":");
  const id = Number(rawId);
  if (!Number.isInteger(id)) return null;

  if (kind === "invoice") {
    const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
    if (!invoice) return null;
    if (cond.stillUnpaid && !UNPAID.includes(invoice.status as (typeof UNPAID)[number])) return null;
    if (invoice.status === "void") return null;
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, invoice.clientId));
    return client ? invoiceCandidate(invoice, client, today) : null;
  }
  if (kind === "estimate") {
    const [estimate] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, id));
    if (!estimate) return null;
    if (cond.noResponse && (estimate.respondedAt || estimate.status !== "sent")) return null;
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, estimate.clientId));
    return client ? estimateCandidate(estimate, client) : null;
  }
  if (kind === "job") {
    const [row] = await db
      .select({ job: jobsTable, serviceName: servicesTable.name })
      .from(jobsTable)
      .leftJoin(servicesTable, eq(servicesTable.id, jobsTable.serviceId))
      .where(eq(jobsTable.id, id));
    if (!row) return null;
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, row.job.clientId));
    if (!client) return null;
    return {
      client,
      subjectKey,
      subjectLabel: `${row.serviceName ?? "Job"} #${row.job.id}`,
      context: { job: { scheduledDate: row.job.scheduledDate, serviceName: row.serviceName } },
    };
  }
  if (kind === "client") {
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, id));
    if (!client) return null;
    return { client, subjectKey, subjectLabel: extra ? `Every year (${extra})` : "New customer", context: {} };
  }
  return null;
}

/** Drop anyone this rule has already handled. */
async function withoutAlreadySent(rule: AutomationRule, candidates: Candidate[]): Promise<Candidate[]> {
  if (!candidates.length) return [];
  const done = await db
    .select({ subjectKey: automationSendsTable.subjectKey })
    .from(automationSendsTable)
    .where(and(eq(automationSendsTable.ruleId, rule.id), inArray(automationSendsTable.subjectKey, candidates.map((c) => c.subjectKey))));
  const seen = new Set(done.map((d) => d.subjectKey));
  return candidates.filter((c) => !seen.has(c.subjectKey));
}

// -------------------------------------------------------------- preview ----

export type PreviewRecipient = {
  clientId: number;
  clientName: string;
  email: string | null;
  subjectLabel: string;
  wouldSkip: "no_email" | "do_not_email" | null;
};

/**
 * "Would send to 14 customers: …" — what the rule would do if it ran right
 * now, without sending anything. This is the screen he checks before turning
 * a rule on, and the reason the seeded rules ship switched off.
 */
export async function previewRule(rule: AutomationRule, today = todayISO()) {
  const template = await templateFor(rule);
  const candidates = await withoutAlreadySent(rule, await findCandidates(rule, today));
  const recipients: PreviewRecipient[] = candidates.map((c) => {
    const email = recipientEmail(c.client, Boolean(c.context.invoice));
    return {
      clientId: c.client.id,
      clientName: c.client.name,
      email,
      subjectLabel: c.subjectLabel,
      wouldSkip: c.client.doNotEmail ? "do_not_email" : !email ? "no_email" : null,
    };
  });

  let sample: { clientName: string; subject: string | null; body: string } | null = null;
  const first = candidates.find((c) => !c.client.doNotEmail && recipientEmail(c.client, Boolean(c.context.invoice)));
  if (template && first) {
    const company = await getCompanyProfile();
    const context: MergeContext = { ...first.context, client: first.client, company };
    sample = {
      clientName: first.client.name,
      subject: template.subject ? renderTemplate(template.subject, context) : null,
      body: renderTemplate(template.body, context),
    };
  }

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    templateName: template?.name ?? null,
    today,
    count: recipients.filter((r) => !r.wouldSkip).length,
    recipients,
    sample,
    problem: !template ? "This rule has no document to send. Pick one." : !rule.enabled ? "This rule is switched off; nothing goes out until you turn it on." : null,
  };
}

async function templateFor(rule: AutomationRule): Promise<DocumentTemplate | null> {
  if (rule.templateId == null) return null;
  const [template] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, rule.templateId));
  return template ?? null;
}

// ---------------------------------------------------------------- runs ----

export type RuleRunOutcome = {
  ruleId: number;
  ruleName: string;
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  batchId: string | null;
  problem: string | null;
};

/**
 * Send one rule's notices for today.
 *
 * The claim on automation_sends goes in BEFORE the email, on the unique
 * (rule, subject) index. Two servers running the same day, or a manual run
 * on top of the scheduled one, both hit that index and only one of them
 * sends. A send that fails outright gives its claim back so tomorrow can
 * try again; a skip (no email, do-not-email) keeps it, because retrying
 * the same skip every morning tells him nothing new. A letter Gmail already
 * accepted keeps its claim as well, even when we could not write down that
 * it went — the customer has it, and a second copy is worse than a gap in
 * our log.
 */
export async function runRule(rule: AutomationRule, today: string, actorName: string, scope?: RuleScope): Promise<RuleRunOutcome> {
  const outcome: RuleRunOutcome = {
    ruleId: rule.id,
    ruleName: rule.name,
    considered: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    batchId: null,
    problem: null,
  };
  const template = await templateFor(rule);
  if (!template) {
    outcome.problem = "no document picked";
    return outcome;
  }

  const candidates = await withoutAlreadySent(rule, await findCandidates(rule, today, scope));
  outcome.considered = candidates.length;
  if (!candidates.length) return outcome;

  const batchId = newBatchId();
  outcome.batchId = batchId;

  for (const candidate of candidates) {
    const [claim] = await db
      .insert(automationSendsTable)
      .values({ ruleId: rule.id, subjectKey: candidate.subjectKey })
      .onConflictDoNothing()
      .returning({ id: automationSendsTable.id });
    if (!claim) continue; // someone else sent it between the list and now

    const recipient: DocumentRecipient = { client: candidate.client, context: candidate.context };
    let outcomes;
    try {
      ({ outcomes } = await deliverDocument({
        template,
        recipients: [recipient],
        source: "automation",
        batchId,
        actorName,
      }));
    } catch (err) {
      // Nothing was sent and nothing was written down, so the claim is a lie:
      // hand it back before giving up on the rule for today. Left in place it
      // would silence this customer's notice for good — tomorrow's run would
      // see the claim, decide the letter already went out, and move on.
      await db.delete(automationSendsTable).where(eq(automationSendsTable.id, claim.id));
      throw err;
    }
    const result = outcomes[0]!;
    if (result.status === "sent") outcome.sent += 1;
    else if (result.status === "failed") outcome.failed += 1;
    else outcome.skipped += 1;

    if (result.status === "failed" && !result.delivered) {
      await db.delete(automationSendsTable).where(eq(automationSendsTable.id, claim.id));
    } else {
      // Keeping the claim covers the awkward middle case too: Gmail took the
      // letter but we could not record it. The customer HAS the notice, so
      // tomorrow must not send it again; it is still counted as failed so the
      // run log tells him to go look.
      await db.update(automationSendsTable).set({ emailSendId: result.emailSendId }).where(eq(automationSendsTable.id, claim.id));
    }
  }

  await db.update(automationRulesTable).set({ lastRunAt: new Date() }).where(eq(automationRulesTable.id, rule.id));
  return outcome;
}

function describeRun(outcomes: RuleRunOutcome[]): string {
  if (!outcomes.length) return "No rules are switched on.";
  return outcomes
    .map((o) => {
      if (o.problem) return `${o.ruleName}: ${o.problem}`;
      if (!o.considered) return `${o.ruleName}: nothing due`;
      const parts = [`${o.sent} sent`];
      if (o.skipped) parts.push(`${o.skipped} skipped`);
      if (o.failed) parts.push(`${o.failed} failed`);
      return `${o.ruleName}: ${parts.join(", ")}`;
    })
    .join(" · ");
}

const failedAttempts = new Map<string, number>();

/**
 * Run every enabled rule once. A scheduled run claims the day on
 * automation_runs (kind "emails") so it cannot happen twice; a manual run
 * from the button records its own row and relies on the per-notice claim
 * in runRule to stay safe next to it.
 */
export async function runEmailAutomations(opts: {
  trigger: "scheduled" | "manual";
  triggeredBy?: string | null;
  force?: boolean;
  today?: string;
}): Promise<{ runId: number; outcomes: RuleRunOutcome[]; summary: string } | null> {
  const now = new Date();
  const today = opts.today ?? todayISO();
  const actorName = opts.trigger === "manual" ? (opts.triggeredBy ?? "Email automation") : "Email automation";

  if (opts.trigger === "scheduled") {
    const [h, m] = EMAIL_AUTOMATION_SCHEDULE.runAtLocalTime.split(":").map(Number);
    if (!opts.force && localMinutes(now) < h * 60 + m) return null;
    await releaseExpiredClaims();
    if ((failedAttempts.get(today) ?? 0) >= MAX_FAILED_ATTEMPTS_PER_DAY) return null;
  }

  const [run] = await db
    .insert(automationRunsTable)
    .values({
      kind: RUN_KIND,
      trigger: opts.trigger,
      runDate: opts.trigger === "scheduled" ? today : null,
      datesChecked: [today],
      status: "running",
      triggeredBy: actorName,
      leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
    })
    .onConflictDoNothing()
    .returning();
  if (!run) return null; // today's scheduled run already happened (or is happening)

  const heartbeat = setInterval(() => {
    db
      .update(automationRunsTable)
      .set({ leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS) })
      .where(and(eq(automationRunsTable.id, run.id), eq(automationRunsTable.status, "running")))
      .catch((err) => logger.warn({ err, runId: run.id }, "Could not renew email automation lease"));
  }, Math.floor(CLAIM_LEASE_MS / 3));
  heartbeat.unref();

  try {
    await ensureDefaultAutomationRules();
    const rules = await db
      .select()
      .from(automationRulesTable)
      .where(eq(automationRulesTable.enabled, true))
      .orderBy(asc(automationRulesTable.id));

    const outcomes: RuleRunOutcome[] = [];
    for (const rule of rules) {
      try {
        outcomes.push(await runRule(rule, today, actorName));
      } catch (err) {
        // One broken rule must not stop the others; it is reported in the log line.
        logger.error({ err, ruleId: rule.id }, "Email automation rule failed");
        outcomes.push({
          ruleId: rule.id,
          ruleName: rule.name,
          considered: 0,
          sent: 0,
          skipped: 0,
          failed: 0,
          batchId: null,
          problem: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = describeRun(outcomes);
    const considered = outcomes.reduce((n, o) => n + o.considered, 0);
    const sent = outcomes.reduce((n, o) => n + o.sent, 0);
    await db
      .update(automationRunsTable)
      .set({ status: "succeeded", jobsChecked: considered, suggestionsCreated: sent, summary, leaseExpiresAt: null, finishedAt: new Date() })
      .where(eq(automationRunsTable.id, run.id));
    await logAudit({
      actorName,
      action: "email_automations_run",
      description: `${opts.trigger === "manual" ? "Ran the email automations by hand" : "Daily email automations ran"} for ${today}: ${summary}`,
    });
    failedAttempts.delete(today);
    return { runId: run.id, outcomes, summary };
  } catch (err) {
    await db
      .update(automationRunsTable)
      .set({
        status: "failed",
        runDate: null,
        error: err instanceof Error ? err.message : String(err),
        leaseExpiresAt: null,
        finishedAt: new Date(),
      })
      .where(eq(automationRunsTable.id, run.id));
    if (opts.trigger === "scheduled") failedAttempts.set(today, (failedAttempts.get(today) ?? 0) + 1);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

/** Free a day claimed by a run that died mid-way, so the next tick can retry. */
export async function releaseExpiredClaims(): Promise<void> {
  await db
    .update(automationRunsTable)
    .set({
      status: "failed",
      runDate: null,
      error: "Interrupted — the run did not finish (the server restarted or timed out)",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(automationRunsTable.kind, RUN_KIND),
        eq(automationRunsTable.status, "running"),
        or(sql`${automationRunsTable.leaseExpiresAt} is null`, sql`${automationRunsTable.leaseExpiresAt} < now()`),
      ),
    );
}

export function serializeEmailRun(run: typeof automationRunsTable.$inferSelect) {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    day: run.datesChecked[0] ?? run.runDate ?? null,
    considered: run.jobsChecked,
    sent: run.suggestionsCreated,
    summary: run.summary,
    error: run.error,
    triggeredBy: run.triggeredBy,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

/** Schedule settings plus the recent runs, for the automation page. */
export async function getEmailAutomationStatus() {
  const runs = await db
    .select()
    .from(automationRunsTable)
    .where(eq(automationRunsTable.kind, RUN_KIND))
    .orderBy(desc(automationRunsTable.startedAt))
    .limit(20);
  return {
    enabled: schedulerStarted,
    runAtLocalTime: EMAIL_AUTOMATION_SCHEDULE.runAtLocalTime,
    timeZone: EMAIL_AUTOMATION_SCHEDULE.timeZone,
    today: todayISO(),
    runs: runs.map(serializeEmailRun),
  };
}

// ----------------------------------------------------------- scheduler ----

let schedulerStarted = false;
let inFlight: Promise<void> | null = null;

function tick(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runEmailAutomations({ trigger: "scheduled" })
    .then(() => undefined)
    .catch((err) => logger.error({ err }, "Email automation tick failed"))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Same shape as the weather scheduler: tick every few minutes, let the
 * database day-claim decide whether today's run has happened. Ticking rather
 * than sleeping until 9:00 means a server that was down at 9:00 catches up
 * the moment it is back.
 */
export function startEmailAutomationScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  logger.info({ runAtLocalTime: EMAIL_AUTOMATION_SCHEDULE.runAtLocalTime, timeZone: EMAIL_AUTOMATION_SCHEDULE.timeZone }, "Email automation scheduler started");
  tick();
}

// ---------------------------------------------------------------- seeds ----

const SEED_MARKER_ACTION = "automation_rules_seeded";

/**
 * His three automations from the walkthrough (plus the seasonal ones he
 * described), created switched OFF. They exist so he can open the page,
 * read each one as a sentence, press Preview and see exactly who it would
 * email — then turn it on himself. Nothing here sends until he does.
 *
 * Marked in the audit trail like the scheduling rules, so a rule he deletes
 * on purpose does not come back on the next restart.
 */
export async function ensureDefaultAutomationRules(): Promise<void> {
  const [seeded] = await db
    .select({ id: auditEventsTable.id })
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, SEED_MARKER_ACTION))
    .limit(1);
  if (seeded) return;

  const [existing] = await db.select({ id: automationRulesTable.id }).from(automationRulesTable).limit(1);
  if (existing) {
    await logAudit({ action: SEED_MARKER_ACTION, description: "Email automations already existed; the starting set was not added" });
    return;
  }

  await ensureDocumentTemplatesOnce();
  const templates = await db.select({ id: documentTemplatesTable.id, key: documentTemplatesTable.key }).from(documentTemplatesTable);
  const idFor = (key: string) => templates.find((t) => t.key === key)?.id ?? null;

  const [pastDue] = await db
    .insert(automationRulesTable)
    .values({
      name: "Past due notice",
      enabled: false,
      trigger: "invoice_past_due",
      offsetDays: 2,
      templateId: idFor("past-due"),
      conditions: { stillUnpaid: true, lookbackDays: DEFAULT_LOOKBACK_DAYS },
    })
    .returning();
  await db.insert(automationRulesTable).values({
    name: "Final notice",
    enabled: false,
    trigger: "after_rule",
    offsetDays: 15,
    templateId: idFor("final-notice"),
    conditions: { stillUnpaid: true, afterRuleId: pastDue.id, lookbackDays: DEFAULT_LOOKBACK_DAYS },
  });
  const [followUp] = await db
    .insert(automationRulesTable)
    .values({
      name: "Estimate follow-up",
      enabled: false,
      trigger: "estimate_sent",
      offsetDays: 2,
      templateId: idFor("estimate-follow-up"),
      conditions: { noResponse: true, lookbackDays: DEFAULT_LOOKBACK_DAYS },
    })
    .returning();
  await db.insert(automationRulesTable).values([
    {
      name: "Don't forget us",
      enabled: false,
      trigger: "after_rule",
      offsetDays: 7,
      templateId: idFor("dont-forget-us"),
      conditions: { noResponse: true, afterRuleId: followUp.id, lookbackDays: DEFAULT_LOOKBACK_DAYS },
    },
    {
      name: "Turn up your sprinklers",
      enabled: false,
      trigger: "fixed_date",
      offsetDays: 0,
      monthDay: "06-15",
      templateId: idFor("turn-up-your-sprinklers"),
      conditions: { lookbackDays: 7 },
    },
    {
      name: "Fall notice",
      enabled: false,
      trigger: "fixed_date",
      offsetDays: 0,
      monthDay: "09-01",
      templateId: idFor("fall-notice"),
      conditions: { lookbackDays: 7 },
    },
    {
      name: "Welcome to the herd",
      enabled: false,
      trigger: "client_added",
      offsetDays: 0,
      templateId: idFor("welcome-to-the-herd"),
      conditions: { lookbackDays: 7 },
    },
  ]);

  await logAudit({
    action: SEED_MARKER_ACTION,
    description: "Added the starting email automations (past due, final notice, estimate follow-ups, seasonal notices, welcome) — all switched off",
  });
}
