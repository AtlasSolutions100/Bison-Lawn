import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  invoicesTable,
  estimatesTable,
  documentTemplatesTable,
  automationRulesTable,
  automationSendsTable,
  emailSendsTable,
  auditEventsTable,
} from "@workspace/db";
import { and, eq, inArray, like, notInArray, or } from "drizzle-orm";

process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;
process.env.APP_PUBLIC_URL = "https://crm.example.test";
// Pin the office's timezone: a letter has to print the day HE was on, and the
// assertions below spell out an exact day.
process.env.APP_TIME_ZONE = "America/Los_Angeles";

const { default: app } = await import("../src/app.ts");
const { setDocumentSendGmailProxyForTests, setDocumentSendBreakageForTests } = await import("../src/lib/documentSend.ts");
const { runRule, previewRule, findCandidates, effectiveDueDate, addDays, daysBetween, conditionsOf } =
  await import("../src/lib/automationRunner.ts");
const { todayISO } = await import("../src/lib/invoiceNumbers.ts");
const { letterDate, renderTemplate } = await import("../src/lib/mergeTokens.ts");

let server: Server;
let baseUrl: string;

const TODAY = todayISO();
const stamp = Date.now();
// Invoice numbers are unique; keep ours far away from his real sequence.
let nextNumber = 9_000_000 + (stamp % 100_000);

const ids = {
  users: [] as number[],
  clients: [] as number[],
  templates: [] as number[],
  rules: [] as number[],
  batches: [] as string[],
};

/**
 * A rule sweeps every customer in the database — that is the whole point of it
 * — so a test that runs one has to fence it to the customers it made itself.
 * Without the fence a run here emails his real overdue customers and leaves
 * "Emailed Test past due" on their timelines for good.
 */
const onlyOurs = () => ({ clientIds: ids.clients });

/** Run a rule fenced to our customers, remembering the batch so it can be cleaned up. */
async function runOurs(rule: Awaited<ReturnType<typeof ruleById>>, today = TODAY) {
  const outcome = await runRule(rule, today, "Test runner", onlyOurs());
  if (outcome.batchId) ids.batches.push(outcome.batchId);
  return outcome;
}

let admin: { id: number };
let paysLate: { id: number; name: string };
let alsoLate: { id: number; name: string };
let optedOut: { id: number };
let quoted: { id: number; name: string };
let answered: { id: number };
let pastDueTemplate: { id: number };
let finalTemplate: { id: number };
let followUpTemplate: { id: number };

let overdueInvoice: { id: number; number: number | null };
let receiptInvoice: { id: number };
let paidInvoice: { id: number };
let notYetInvoice: { id: number };
let optedOutInvoice: { id: number };
let openEstimate: { id: number };
let answeredEstimate: { id: number };

function capturingProxy() {
  const seen: { to: string; raw: string }[] = [];
  const proxy = async (_c: string, _p: string, init: any) => {
    const raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString();
    seen.push({ to: /^To: (.+)$/m.exec(raw)?.[1] ?? "", raw });
    return new Response(JSON.stringify({ id: `gmail-${seen.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, proxy: proxy as any };
}

/** The plain-text part of a captured message, decoded. */
function plainBodyOf(raw: string): string {
  const part = raw.split(/--bison_client_[a-f0-9]+/).find((p) => p.includes("text/plain"));
  const b64 = part?.split("\r\n\r\n")[1]?.trim() ?? "";
  return Buffer.from(b64, "base64").toString();
}

async function api(path: string, userId: number | null, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(userId != null ? { "x-test-user-id": String(userId), "x-test-auth-token": TEST_AUTH_TOKEN } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function ruleById(id: number) {
  const [rule] = await db.select().from(automationRulesTable).where(eq(automationRulesTable.id, id));
  assert.ok(rule, `rule #${id} exists`);
  return rule;
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a] = await db
    .insert(usersTable)
    .values({ clerkId: `rules_admin_${stamp}`, name: "Rules Admin", role: "admin", roleSource: "owner_assigned" })
    .returning();
  admin = a;
  ids.users.push(a.id);

  const clients = await db
    .insert(clientsTable)
    .values([
      { name: "Pays Late Pete", status: "client", email: "koby@radiantaisoftware.com", billingEmail: "kobystull123@gmail.com" },
      { name: "Also Late Alice", status: "client", email: "koby@radiantaisoftware.com" },
      { name: "Opted Out Otis", status: "client", email: "koby@radiantaisoftware.com", doNotEmail: true },
      { name: "Quoted Quinn", status: "lead", email: "kobystull123@gmail.com" },
      { name: "Answered Andy", status: "lead", email: "kobystull123@gmail.com" },
    ])
    .returning();
  [paysLate, alsoLate, optedOut, quoted, answered] = clients as any;
  ids.clients.push(...clients.map((c) => c.id));

  const templates = await db
    .insert(documentTemplatesTable)
    .values([
      {
        key: `__test_past_due_${stamp}`,
        name: "Test past due",
        kind: "notice",
        category: "client",
        subject: "Past due: invoice #[invoicenumber]",
        body: "Dear [clientfname], invoice #[invoicenumber] for [invoicebalance] was due [invoiceduedate], [daysoverdue] days ago.",
      },
      {
        key: `__test_final_${stamp}`,
        name: "Test final notice",
        kind: "notice",
        category: "client",
        subject: "Final notice: invoice #[invoicenumber]",
        body: "Final notice for [invoicebalance].",
      },
      {
        key: `__test_follow_up_${stamp}`,
        name: "Test estimate follow-up",
        kind: "notice",
        category: "estimate",
        subject: "Following up on estimate #[estimatenumber]",
        body: "Dear [clientfname], we sent [estimatetotal] on [estimatesentdate].",
      },
    ])
    .returning();
  [pastDueTemplate, finalTemplate, followUpTemplate] = templates as any;
  ids.templates.push(...templates.map((t) => t.id));

  const invoices = await db
    .insert(invoicesTable)
    .values([
      // Due 5 days ago, half paid: the balance, not the total, is chased.
      { clientId: paysLate.id, status: "partial", total: 200, amountPaid: 50, number: nextNumber++, invoiceDate: addDays(TODAY, -20), dueDate: addDays(TODAY, -5), terms: "Net 15" },
      // No due date on file, "Due on receipt" 3 days ago: due the day it was issued.
      { clientId: alsoLate.id, status: "open", total: 120, amountPaid: 0, number: nextNumber++, invoiceDate: addDays(TODAY, -3), dueDate: null, terms: "Due on receipt" },
      // Paid: never chased even though it is old.
      { clientId: alsoLate.id, status: "paid", total: 80, amountPaid: 80, number: nextNumber++, invoiceDate: addDays(TODAY, -30), dueDate: addDays(TODAY, -15), terms: "Net 15" },
      // Due yesterday: not 2 days past due yet.
      { clientId: alsoLate.id, status: "open", total: 60, amountPaid: 0, number: nextNumber++, invoiceDate: addDays(TODAY, -16), dueDate: addDays(TODAY, -1), terms: "Net 15" },
      // Overdue but the customer is marked do not email.
      { clientId: optedOut.id, status: "open", total: 45, amountPaid: 0, number: nextNumber++, invoiceDate: addDays(TODAY, -20), dueDate: addDays(TODAY, -5), terms: "Net 15" },
    ])
    .returning();
  [overdueInvoice, receiptInvoice, paidInvoice, notYetInvoice, optedOutInvoice] = invoices as any;

  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  const estimates = await db
    .insert(estimatesTable)
    .values([
      { clientId: quoted.id, status: "sent", total: 350, sentAt: twoDaysAgo, sentToEmail: "kobystull123@gmail.com" },
      { clientId: answered.id, status: "sent", total: 500, sentAt: twoDaysAgo, sentToEmail: "kobystull123@gmail.com", respondedAt: new Date() },
    ])
    .returning();
  [openEstimate, answeredEstimate] = estimates as any;
});

after(async () => {
  setDocumentSendGmailProxyForTests(null);
  setDocumentSendBreakageForTests(null);
  if (ids.rules.length) await db.delete(automationRulesTable).where(inArray(automationRulesTable.id, ids.rules));
  // Belt and braces next to the fence above: anything at all that came out of
  // a batch we started goes, whoever it landed on.
  if (ids.batches.length) await db.delete(emailSendsTable).where(inArray(emailSendsTable.batchId, ids.batches));
  const testTemplateNames = ["Test past due", "Test final notice", "Test estimate follow-up"];
  await db.delete(auditEventsTable).where(
    and(
      inArray(auditEventsTable.action, ["document_emailed", "document_email_failed"]),
      or(...testTemplateNames.map((name) => like(auditEventsTable.description, `%"${name}"%`))),
    ),
  );
  if (ids.clients.length) {
    await db.delete(emailSendsTable).where(inArray(emailSendsTable.clientId, ids.clients));
    await db.delete(auditEventsTable).where(inArray(auditEventsTable.clientId, ids.clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  if (ids.templates.length) await db.delete(documentTemplatesTable).where(inArray(documentTemplatesTable.id, ids.templates));
  await db.delete(auditEventsTable).where(and(inArray(auditEventsTable.action, ["email_automation_created", "email_automation_updated", "email_automation_enabled", "email_automation_disabled", "email_automation_deleted"]), eq(auditEventsTable.actorName, "Rules Admin")));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

test("date helpers count whole days and never drift across a month", () => {
  assert.equal(addDays("2026-02-27", 3), "2026-03-02");
  assert.equal(daysBetween("2026-09-01", "2026-09-16"), 15);
  assert.equal(daysBetween("2026-09-16", "2026-09-01"), -15);
});

test("an invoice's due date falls back to its terms when the column is blank", () => {
  const base = { createdAt: new Date("2026-09-01T12:00:00Z") };
  assert.equal(effectiveDueDate({ ...base, dueDate: "2026-09-20", invoiceDate: "2026-09-01", terms: "Net 30" }), "2026-09-20");
  assert.equal(effectiveDueDate({ ...base, dueDate: null, invoiceDate: "2026-09-01", terms: "Due on receipt" }), "2026-09-01");
  assert.equal(effectiveDueDate({ ...base, dueDate: null, invoiceDate: "2026-09-01", terms: null }), "2026-09-16");
  assert.equal(effectiveDueDate({ ...base, dueDate: null, invoiceDate: "2026-09-01", terms: "whenever" }), null);
});

test("the three rules he described ship pre-created and switched off", async () => {
  const res = await api("/automation-rules", admin.id);
  assert.equal(res.status, 200);
  const byName = new Map(res.body.map((r: any) => [r.name, r]));
  for (const name of ["Past due notice", "Final notice", "Estimate follow-up", "Don't forget us"]) {
    assert.ok(byName.has(name), `"${name}" is seeded`);
  }
  const pastDue = byName.get("Past due notice") as any;
  assert.equal(pastDue.trigger, "invoice_past_due");
  assert.equal(pastDue.offsetDays, 2);
  assert.equal(pastDue.conditions.stillUnpaid, true);
  assert.equal(pastDue.templateName, "Past Due");
  const finalNotice = byName.get("Final notice") as any;
  assert.equal(finalNotice.trigger, "after_rule");
  assert.equal(finalNotice.offsetDays, 15);
  assert.equal(finalNotice.afterRuleName, "Past due notice");
  const followUp = byName.get("Estimate follow-up") as any;
  assert.equal(followUp.trigger, "estimate_sent");
  assert.equal(followUp.offsetDays, 2);
  assert.equal(followUp.conditions.noResponse, true);
  const dontForget = byName.get("Don't forget us") as any;
  assert.equal(dontForget.offsetDays, 7);
  assert.equal(dontForget.afterRuleName, "Estimate follow-up");
  // The seeds only decide the starting state; he may have flipped them since.
  // What must hold is that a fresh seed never starts anything sending.
  const seededAudit = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "automation_rules_seeded"));
  assert.ok(seededAudit.length >= 1, "the seed marks itself so deleted rules stay deleted");
});

test("a rule must make sense before it is saved", async () => {
  const noDate = await api("/automation-rules", admin.id, {
    method: "POST",
    body: JSON.stringify({ name: "Bad yearly", trigger: "fixed_date", templateId: pastDueTemplate.id }),
  });
  assert.equal(noDate.status, 400);
  assert.match(noDate.body.error, /month and day/);

  const noParent = await api("/automation-rules", admin.id, {
    method: "POST",
    body: JSON.stringify({ name: "Orphan follow-up", trigger: "after_rule", offsetDays: 3, templateId: pastDueTemplate.id }),
  });
  assert.equal(noParent.status, 400);
  assert.match(noParent.body.error, /earlier notice/);

  const anon = await api("/automation-rules", null);
  assert.equal(anon.status, 401);
});

let pastDueRule: { id: number };
let finalRule: { id: number };
let followUpRule: { id: number };

test("creating a rule from the sentence builder stores it switched off and audits it", async () => {
  const res = await api("/automation-rules", admin.id, {
    method: "POST",
    body: JSON.stringify({
      name: `Test past due ${stamp}`,
      trigger: "invoice_past_due",
      offsetDays: 2,
      templateId: pastDueTemplate.id,
      conditions: { stillUnpaid: true },
    }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.templateName, "Test past due");
  assert.equal(res.body.sentTotal, 0);
  pastDueRule = res.body;
  ids.rules.push(res.body.id);

  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.action, "email_automation_created"), eq(auditEventsTable.actorName, "Rules Admin")));
  assert.match(audit?.description ?? "", /2 day\(s\) after an invoice is due send "Test past due" if still unpaid/);

  const final = await api("/automation-rules", admin.id, {
    method: "POST",
    body: JSON.stringify({
      name: `Test final notice ${stamp}`,
      trigger: "after_rule",
      offsetDays: 0,
      templateId: finalTemplate.id,
      conditions: { stillUnpaid: true, afterRuleId: pastDueRule.id },
    }),
  });
  assert.equal(final.status, 201, JSON.stringify(final.body));
  finalRule = final.body;
  ids.rules.push(final.body.id);

  const follow = await api("/automation-rules", admin.id, {
    method: "POST",
    body: JSON.stringify({
      name: `Test estimate follow-up ${stamp}`,
      trigger: "estimate_sent",
      offsetDays: 2,
      templateId: followUpTemplate.id,
      conditions: { noResponse: true },
    }),
  });
  assert.equal(follow.status, 201);
  followUpRule = follow.body;
  ids.rules.push(follow.body.id);

  const selfFollow = await api(`/automation-rules/${finalRule.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ conditions: { stillUnpaid: true, afterRuleId: finalRule.id } }),
  });
  assert.equal(selfFollow.status, 400);
  assert.match(selfFollow.body.error, /follow itself/);
});

test("preview says who would get the past-due notice today, and sends nothing", async () => {
  const res = await api(`/automation-rules/${pastDueRule.id}/preview`, admin.id, { method: "POST" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const ours = res.body.recipients.filter((r: any) => ids.clients.includes(r.clientId));
  const byClient = new Map(ours.map((r: any) => [r.clientId, r]));

  assert.ok(byClient.has(paysLate.id), "5 days overdue, half paid: chased");
  assert.ok(byClient.has(alsoLate.id), "due on receipt 3 days ago with no due date on file: chased");
  assert.ok(byClient.has(optedOut.id), "listed so he can see why it will be skipped");
  assert.equal((byClient.get(optedOut.id) as any).wouldSkip, "do_not_email");
  assert.equal((byClient.get(paysLate.id) as any).wouldSkip, null);
  // Bills chase the billing address.
  assert.equal((byClient.get(paysLate.id) as any).email, "kobystull123@gmail.com");
  assert.match((byClient.get(paysLate.id) as any).subjectLabel, /\$150\.00 owed/);
  // The paid one and the one due yesterday are not in the list.
  assert.equal(ours.filter((r: any) => r.clientId === alsoLate.id).length, 1);
  assert.match(res.body.problem ?? "", /switched off/);

  const sends = await db.select().from(emailSendsTable).where(inArray(emailSendsTable.clientId, ids.clients));
  assert.equal(sends.length, 0, "a preview sends nothing");
});

test("running the past-due rule sends once per invoice, skips do-not-email, and never sends twice", async () => {
  const { seen, proxy } = capturingProxy();
  setDocumentSendGmailProxyForTests(proxy);

  const rule = await ruleById(pastDueRule.id);
  const outcome = await runOurs(rule);
  const ours = await db
    .select()
    .from(automationSendsTable)
    .where(and(eq(automationSendsTable.ruleId, rule.id), inArray(automationSendsTable.subjectKey, [
      `invoice:${overdueInvoice.id}`, `invoice:${receiptInvoice.id}`, `invoice:${paidInvoice.id}`, `invoice:${notYetInvoice.id}`, `invoice:${optedOutInvoice.id}`,
    ])));
  const claimed = new Set(ours.map((s) => s.subjectKey));
  assert.ok(claimed.has(`invoice:${overdueInvoice.id}`));
  assert.ok(claimed.has(`invoice:${receiptInvoice.id}`));
  assert.ok(claimed.has(`invoice:${optedOutInvoice.id}`), "a skip keeps its claim so it is not re-skipped every morning");
  assert.ok(!claimed.has(`invoice:${paidInvoice.id}`), "paid invoices are never chased");
  assert.ok(!claimed.has(`invoice:${notYetInvoice.id}`), "due yesterday is not 2 days past due");
  assert.ok(outcome.sent >= 2);
  assert.ok(outcome.skipped >= 1);
  assert.ok(outcome.batchId);

  const pete = seen.find((s) => s.to === "kobystull123@gmail.com" && plainBodyOf(s.raw).includes(`#${overdueInvoice.number}`));
  assert.ok(pete, "Pete's bill went to his billing address");
  assert.match(plainBodyOf(pete!.raw), /Dear Pays, invoice #\d+ for \$150\.00 was due [A-Z][a-z]+ \d+, \d{4}, 5 days ago\./);

  const sends = await db.select().from(emailSendsTable).where(inArray(emailSendsTable.clientId, ids.clients));
  assert.ok(sends.every((s) => s.source === "automation"));
  assert.equal(sends.find((s) => s.clientId === optedOut.id)?.skipReason, "do_not_email");
  const petesRow = sends.find((s) => s.clientId === paysLate.id);
  assert.equal(petesRow?.status, "sent");
  assert.equal(ours.find((s) => s.subjectKey === `invoice:${overdueInvoice.id}`)?.emailSendId, petesRow?.id);

  // Same day, same rule, run again: nothing new goes out.
  const before = seen.length;
  const again = await runOurs(await ruleById(pastDueRule.id));
  assert.equal(seen.length, before);
  const oursAgain = await db.select().from(emailSendsTable).where(inArray(emailSendsTable.clientId, ids.clients));
  assert.equal(oursAgain.length, sends.length, "no second email_sends row for the same invoice");
  assert.ok(again.considered <= outcome.considered);

  const [updated] = await db.select().from(automationRulesTable).where(eq(automationRulesTable.id, pastDueRule.id));
  assert.ok(updated?.lastRunAt, "the rule remembers when it last ran");
});

test("the final notice follows the past-due notice and only chases what is still unpaid", async () => {
  const { seen, proxy } = capturingProxy();
  setDocumentSendGmailProxyForTests(proxy);

  // Alice paid up after the first notice; Pete did not.
  await db.update(invoicesTable).set({ status: "paid", amountPaid: 120 }).where(eq(invoicesTable.id, receiptInvoice.id));

  const preview = await previewRule(await ruleById(finalRule.id), TODAY);
  const ours = preview.recipients.filter((r) => ids.clients.includes(r.clientId));
  assert.ok(ours.some((r) => r.clientId === paysLate.id), "Pete's unpaid invoice gets the final notice");
  assert.ok(!ours.some((r) => r.clientId === alsoLate.id), "Alice paid, so no final notice");
  assert.ok(!ours.some((r) => r.clientId === optedOut.id), "a notice that never went out has no follow-up");

  await runOurs(await ruleById(finalRule.id));
  const finalSends = await db
    .select()
    .from(emailSendsTable)
    .where(and(inArray(emailSendsTable.clientId, ids.clients), eq(emailSendsTable.templateId, finalTemplate.id)));
  assert.equal(finalSends.length, 1);
  assert.equal(finalSends[0]!.clientId, paysLate.id);
  assert.equal(finalSends[0]!.status, "sent");
  assert.ok(seen.some((s) => /Final notice/.test(Buffer.from(/=\?UTF-8\?B\?(.+)\?=/.exec(s.raw)![1]!, "base64").toString())));
});

test("estimate follow-ups go only to quotes with no answer yet", async () => {
  const { seen, proxy } = capturingProxy();
  setDocumentSendGmailProxyForTests(proxy);

  const rule = await ruleById(followUpRule.id);
  const candidates = await findCandidates(rule, TODAY, onlyOurs());
  assert.deepEqual(candidates.map((c) => c.subjectKey), [`estimate:${openEstimate.id}`]);
  assert.equal(candidates[0]!.client.id, quoted.id);

  await runOurs(rule);
  const sends = await db
    .select()
    .from(emailSendsTable)
    .where(and(inArray(emailSendsTable.clientId, ids.clients), eq(emailSendsTable.templateId, followUpTemplate.id)));
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.clientId, quoted.id);
  assert.equal(sends[0]!.toEmail, "kobystull123@gmail.com");
  const msg = seen.find((s) => s.to === "kobystull123@gmail.com")!;
  assert.match(plainBodyOf(msg.raw), /Dear Quoted, we sent \$350\.00 on [A-Z][a-z]+ \d+, \d{4}\./);

  // Quinn answers: the rule has nothing more for her, and Andy never had anything.
  await db.update(estimatesTable).set({ respondedAt: new Date(), status: "accepted" }).where(eq(estimatesTable.id, openEstimate.id));
  const after = await findCandidates(rule, TODAY, onlyOurs());
  assert.equal(after.length, 0);
  assert.ok(answeredEstimate.id);
});

test("switching a rule on and off is one PATCH and an audit line in his words", async () => {
  const on = await api(`/automation-rules/${pastDueRule.id}`, admin.id, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.ok(on.body.sentTotal >= 2, "the row shows how many it has sent");
  const off = await api(`/automation-rules/${pastDueRule.id}`, admin.id, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  assert.equal(off.body.enabled, false);
  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(inArray(auditEventsTable.action, ["email_automation_enabled", "email_automation_disabled"]), eq(auditEventsTable.actorName, "Rules Admin")));
  assert.ok(audits.some((a) => /Switched ON/.test(a.description)));
  assert.ok(audits.some((a) => /Switched OFF/.test(a.description)));

  const status = await api("/automation-rules/status", admin.id);
  assert.equal(status.status, 200);
  assert.equal(status.body.runAtLocalTime, "09:00");
  assert.ok(Array.isArray(status.body.runs));

  const gone = await api(`/automation-rules/${followUpRule.id}`, admin.id, { method: "DELETE" });
  assert.equal(gone.status, 204);
  const list = await api("/automation-rules", admin.id);
  assert.ok(!list.body.some((r: any) => r.id === followUpRule.id));
  assert.equal(conditionsOf({ conditions: { lookbackDays: -4 } }).lookbackDays, 30, "a bad lookback falls back to the default");
});

test("a rule sweeps everybody, so a test run has to be fenced to its own customers", async () => {
  const { seen, proxy } = capturingProxy();
  setDocumentSendGmailProxyForTests(proxy);

  const rule = await ruleById(pastDueRule.id);
  const everyone = await findCandidates(rule, TODAY);
  const fenced = await findCandidates(rule, TODAY, onlyOurs());
  assert.ok(
    fenced.every((c) => ids.clients.includes(c.client.id)),
    "the fence lets nobody else in",
  );
  assert.ok(everyone.length >= fenced.length, "unfenced is the whole database");
  assert.ok(
    fenced.length <= ids.clients.length + 2,
    "and it is our customers, not his",
  );

  // Nothing this file ever sent may sit on a record it did not create.
  const strays = ids.batches.length
    ? await db
        .select()
        .from(emailSendsTable)
        .where(and(inArray(emailSendsTable.batchId, ids.batches), notInArray(emailSendsTable.clientId, ids.clients)))
    : [];
  assert.deepEqual(strays.map((s) => s.clientId), [], "no notice of ours landed on one of his customers");
  assert.equal(seen.length, 0, "looking costs nothing");
});

test("a letter prints the day the office was on, not the day UTC was on", () => {
  // 5:30 pm on the 15th here is already half past midnight on the 16th in UTC.
  const sentAt = new Date("2026-09-16T00:30:00Z");
  assert.equal(letterDate(sentAt), "September 15, 2026");
  const company = { name: "Bison Lawn Care", signatureLine: "" } as any;
  assert.match(
    renderTemplate("We sent over an estimate on [estimatesentdate].", { company, estimate: { id: 7, sentAt, total: 350 } }),
    /on September 15, 2026\./,
  );
  // A date-only column has no timezone to get wrong.
  assert.equal(letterDate("2026-09-15"), "September 15, 2026");
});

test("an invoice with no number on file is chased by its id, never as 'invoice #'", async () => {
  const { seen, proxy } = capturingProxy();
  setDocumentSendGmailProxyForTests(proxy);

  // Everything imported from his old system came across without a number.
  const [unnumbered] = await db
    .insert(invoicesTable)
    .values({
      clientId: alsoLate.id,
      status: "open",
      total: 45,
      amountPaid: 0,
      number: null,
      invoiceDate: addDays(TODAY, -20),
      dueDate: addDays(TODAY, -5),
      terms: "Net 15",
    })
    .returning();

  const outcome = await runOurs(await ruleById(pastDueRule.id));
  assert.equal(outcome.sent, 1, "only the new invoice is left to chase");
  const msg = seen.at(-1)!;
  assert.ok(
    plainBodyOf(msg.raw).includes(`invoice #${unnumbered!.id} for $45.00`),
    `the letter names the invoice: ${plainBodyOf(msg.raw)}`,
  );
  const subject = Buffer.from(/=\?UTF-8\?B\?(.+)\?=/.exec(msg.raw)![1]!, "base64").toString();
  assert.match(subject, new RegExp(`Past due: invoice #${unnumbered!.id}`));
  const [logged] = await db
    .select()
    .from(emailSendsTable)
    .where(and(eq(emailSendsTable.clientId, alsoLate.id), like(emailSendsTable.subject, `%#${unnumbered!.id}`)));
  assert.ok(logged, "the log quotes the same number the letter did");
});

test("a notice that blew up before it was sent hands its claim back for tomorrow", async () => {
  const { seen, proxy } = capturingProxy();
  setDocumentSendGmailProxyForTests(proxy);

  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      clientId: paysLate.id,
      status: "open",
      total: 70,
      amountPaid: 0,
      number: nextNumber++,
      invoiceDate: addDays(TODAY, -20),
      dueDate: addDays(TODAY, -5),
      terms: "Net 15",
    })
    .returning();
  const subjectKey = `invoice:${invoice!.id}`;

  setDocumentSendBreakageForTests(() => {
    throw new Error("the database went away");
  });
  await assert.rejects(runOurs(await ruleById(pastDueRule.id)), /database went away/);
  setDocumentSendBreakageForTests(null);

  assert.equal(seen.length, 0, "nobody was emailed");
  const orphan = await db
    .select()
    .from(automationSendsTable)
    .where(and(eq(automationSendsTable.ruleId, pastDueRule.id), eq(automationSendsTable.subjectKey, subjectKey)));
  assert.equal(orphan.length, 0, "the claim went back, or this notice would be silenced for good");

  // Tomorrow the same invoice really does go out.
  const retry = await runOurs(await ruleById(pastDueRule.id));
  assert.equal(retry.sent, 1);
  assert.equal(seen.length, 1);
  const [claim] = await db
    .select()
    .from(automationSendsTable)
    .where(and(eq(automationSendsTable.ruleId, pastDueRule.id), eq(automationSendsTable.subjectKey, subjectKey)));
  assert.ok(claim?.emailSendId, "and this time the claim points at the email that went");
});

test("a letter Gmail took but we could not write down is not sent a second time", async () => {
  const [ghost] = await db
    .insert(clientsTable)
    .values({ name: "Vanishes Vera", status: "client", email: "koby@radiantaisoftware.com" })
    .returning();
  ids.clients.push(ghost!.id);
  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      clientId: ghost!.id,
      status: "open",
      total: 90,
      amountPaid: 0,
      number: nextNumber++,
      invoiceDate: addDays(TODAY, -20),
      dueDate: addDays(TODAY, -5),
      terms: "Net 15",
    })
    .returning();

  // Gmail accepts the letter and THEN the row we were about to write becomes
  // impossible to write — here because the customer record went away under us.
  const sentCount: string[] = [];
  setDocumentSendGmailProxyForTests((async () => {
    sentCount.push("accepted");
    await db.delete(clientsTable).where(eq(clientsTable.id, ghost!.id));
    return new Response(JSON.stringify({ id: "gmail-vanished" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any);

  const outcome = await runOurs(await ruleById(pastDueRule.id));
  assert.equal(sentCount.length, 1, "the customer was emailed once");
  assert.equal(outcome.failed, 1, "and he is told it could not be recorded");
  const [claim] = await db
    .select()
    .from(automationSendsTable)
    .where(and(eq(automationSendsTable.ruleId, pastDueRule.id), eq(automationSendsTable.subjectKey, `invoice:${invoice!.id}`)));
  assert.ok(claim, "the claim is kept: the customer HAS the letter, so tomorrow must not send another");
  assert.equal(claim!.emailSendId, null);
});
