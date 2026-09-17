import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  jobsTable,
  servicesTable,
  smsMessagesTable,
  ticketsTable,
  auditEventsTable,
  emailSendsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";

// Texting: the seam, the log, the routing of a customer's reply, and the
// "crew is on their way" email. Same harness as integration.test.ts.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;
// Texting is OFF as far as the env is concerned; the tests swap in a capturing
// provider where they need one. The auth token signs the inbound webhook.
delete process.env.SMS_PROVIDER;
delete process.env.TWILIO_ACCOUNT_SID;
process.env.TWILIO_AUTH_TOKEN = "test_twilio_token_9f3a";
process.env.SMS_OFFICE_NUMBER = "(208) 555-0100";
process.env.APP_PUBLIC_URL = "https://crm.example.test";

const { default: app } = await import("../src/app.ts");
const {
  normalizePhone,
  phoneKey,
  formatPhone,
  segmentsOf,
  parseReplyRef,
  routeInboundSms,
  twilioSignature,
  setSmsProviderForTests,
  smsSendable,
} = await import("../src/lib/sms.ts");
const { setCrewNoticeGmailProxyForTests } = await import("../src/routes/sms.ts");

const OFFICE = "+12085550100";
const DALE_PHONE = "+12085550111";
const DALE_PROXY = "+12085550222";
const SARAH_PHONE = "+12085550333";
const TEST_NUMBERS = [OFFICE, DALE_PHONE, DALE_PROXY, SARAH_PHONE, "+12085550444", "+12085550555", "+12085550999"];

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[], services: [] as number[] };
let stamp = 0;

let admin: { id: number };
let dale: { id: number };
let bob: { id: number };
let sarah: { id: number };
let noPhone: { id: number };
let noEmail: { id: number };
let noMail: { id: number };
let service: { id: number };
let daleJob: { id: number };
let bobJob: { id: number };

const TODAY = new Date().toISOString().slice(0, 10);

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
const post = (path: string, userId: number | null, data: unknown) =>
  api(path, userId, { method: "POST", body: JSON.stringify(data) });
const put = (path: string, userId: number | null, data: unknown) =>
  api(path, userId, { method: "PUT", body: JSON.stringify(data) });

/** Records every text the app hands to the provider instead of sending it. */
function capturingProvider() {
  const sent: { to: string; from: string; body: string }[] = [];
  let n = 0;
  const provider = async (msg: { to: string; from: string; body: string }) => {
    sent.push(msg);
    return { providerId: `SM_test_${++n}` };
  };
  return { sent, provider };
}

/** Twilio's webhook, faked: form-encoded body plus the signature Twilio would compute. */
async function inbound(params: Record<string, string>, opts: { badSignature?: boolean } = {}) {
  const url = `${process.env.APP_PUBLIC_URL}/api/public/sms/inbound`;
  const signature = opts.badSignature ? "nope" : twilioSignature(url, params, process.env.TWILIO_AUTH_TOKEN!);
  const res = await fetch(`${baseUrl}/api/public/sms/inbound`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, text: await res.text() };
}

/** The words of a captured email: the text/plain part is base64 inside the MIME envelope. */
function plainTextOf(raw: string): string {
  const m = /Content-Type: text\/plain[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(raw);
  return m ? Buffer.from(m[1].replace(/\r?\n/g, ""), "base64").toString("utf8") : "";
}

/** The other half of the envelope — the part a mail client actually shows. */
function htmlOf(raw: string): string {
  const m = /Content-Type: text\/html[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(raw);
  return m ? Buffer.from(m[1].replace(/\r?\n/g, ""), "base64").toString("utf8") : "";
}

const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * The on-the-way email rows THIS test made, and nobody else's. Scoped to our
 * own customers on purpose: a real send from the crew's phone lives in the
 * same table, and wiping it would make the "we're on our way" button come
 * back on that job and email the customer a second time.
 */
const ownEmailSends = () => inArray(emailSendsTable.clientId, ids.clients);

/** Captures the on-the-way email instead of handing it to Gmail. */
function capturingGmail() {
  const seen: { raw: string }[] = [];
  const proxy = async (_connector: string, _path: string, init: any) => {
    seen.push({ raw: Buffer.from(JSON.parse(init.body).raw, "base64url").toString() });
    return new Response(JSON.stringify({ id: `gmail-${seen.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, proxy: proxy as any };
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  stamp = Date.now();
  const [a, d, b] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_sms_admin_${stamp}`, name: `Sms Admin ${stamp}`, role: "admin", roleSource: "owner_assigned" },
      {
        clerkId: `test_sms_dale_${stamp}`,
        name: `dale_${stamp}@example.com`,
        displayName: `Dale ${stamp}`,
        role: "contractor",
        phone: "208-555-0111",
        smsProxyNumber: DALE_PROXY,
      },
      { clerkId: `test_sms_bob_${stamp}`, name: `Bob ${stamp}`, role: "contractor" },
    ])
    .returning();
  admin = a;
  dale = d;
  bob = b;
  ids.users.push(a.id, d.id, b.id);

  const [s, np, ne, nm] = await db
    .insert(clientsTable)
    .values([
      {
        name: `Sarah Thompson ${stamp}`,
        status: "client",
        serviceAddress: "615 E 18th Ave",
        phone: "(208) 555-0333",
        email: "koby@radiantaisoftware.com",
      },
      { name: `No Phone ${stamp}`, status: "client", serviceAddress: "1 Elm St", email: "koby@radiantaisoftware.com" },
      { name: `No Email ${stamp}`, status: "client", serviceAddress: "2 Oak St", phone: "208-555-0555" },
      {
        name: `No Mail Please ${stamp}`,
        status: "client",
        serviceAddress: "3 Ash St",
        email: "kobystull123@gmail.com",
        doNotEmail: true,
      },
    ])
    .returning();
  sarah = s;
  noPhone = np;
  noEmail = ne;
  noMail = nm;
  ids.clients.push(s.id, np.id, ne.id, nm.id);

  const [svc] = await db.insert(servicesTable).values({ name: `Sms Mow ${stamp}` }).returning();
  service = svc;
  ids.services.push(svc.id);

  const base = { serviceId: service.id, amount: 50, scheduledDate: TODAY, dispatched: true, visibleToContractor: true };
  const [j1, j2] = await db
    .insert(jobsTable)
    .values([
      { ...base, clientId: sarah.id, status: "scheduled", assignedToId: dale.id },
      { ...base, clientId: noEmail.id, status: "scheduled", assignedToId: bob.id },
    ])
    .returning();
  daleJob = j1;
  bobJob = j2;
});

after(async () => {
  setSmsProviderForTests(null);
  setCrewNoticeGmailProxyForTests(null);
  // sms rows point at clients/users with SET NULL, so they are removed by number
  await db
    .delete(smsMessagesTable)
    .where(or(inArray(smsMessagesTable.fromNumber, TEST_NUMBERS), inArray(smsMessagesTable.toNumber, TEST_NUMBERS)));
  if (ids.clients.length) await db.delete(emailSendsTable).where(ownEmailSends());
  await db.delete(auditEventsTable).where(like(auditEventsTable.description, `%${stamp}%`));
  // tickets, jobs and client audit rows cascade from clients
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

// ------------------------------------------------------------- pure bits --

test("phone numbers typed every which way come out as one shape", () => {
  assert.equal(normalizePhone("(208) 555-0142"), "+12085550142");
  assert.equal(normalizePhone("208.555.0142"), "+12085550142");
  assert.equal(normalizePhone("+1 208 555 0142"), "+12085550142");
  assert.equal(normalizePhone("1-208-555-0142"), "+12085550142");
  assert.equal(normalizePhone("555-0142"), null, "too short to text");
  assert.equal(normalizePhone("+44 20 7946 0958"), null, "not US");
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(phoneKey("(208) 555-0142"), "2085550142");
  assert.equal(phoneKey("+12085550142"), phoneKey("208-555-0142"));
  assert.equal(formatPhone("+12085550142"), "(208) 555-0142");
  assert.equal(formatPhone("garbage"), "garbage");
});

test("segments: plain text fits 160, an emoji drops it to 70, and long texts split", () => {
  assert.equal(segmentsOf(""), 0);
  assert.equal(segmentsOf("Running late"), 1);
  assert.equal(segmentsOf("a".repeat(160)), 1);
  assert.equal(segmentsOf("a".repeat(161)), 2);
  assert.equal(segmentsOf("a".repeat(306)), 2);
  assert.equal(segmentsOf("a".repeat(307)), 3);
  assert.equal(segmentsOf("On my way 🚚"), 1);
  assert.equal(segmentsOf("🚚".repeat(40)), 2);
});

test("a contractor's reply can pick the customer with #id, or not", () => {
  assert.deepEqual(parseReplyRef("#42 Be there in 10"), { messageId: 42, text: "Be there in 10" });
  assert.deepEqual(parseReplyRef("#42: Be there in 10"), { messageId: 42, text: "Be there in 10" });
  assert.deepEqual(parseReplyRef("  #7 - ok"), { messageId: 7, text: "ok" });
  assert.deepEqual(parseReplyRef("Be there in 10"), { messageId: null, text: "Be there in 10" });
  assert.deepEqual(parseReplyRef("#42"), { messageId: 42, text: "" });
});

test("routing: the whole decision table, with no phone or database", () => {
  const line = { userId: 1, userName: "Dale", userPhone: DALE_PHONE, proxyNumber: DALE_PROXY };
  const base = { inboundId: 9, to: DALE_PROXY, isOfficeLine: false, referenced: null, lastCustomer: null };
  const client = { id: 5, name: "Sarah" };

  // customer → contractor's line → forwarded to his phone, labelled
  assert.deepEqual(routeInboundSms({ ...base, from: SARAH_PHONE, body: "Running late?", line, client }), {
    kind: "forward_to_contractor",
    to: DALE_PHONE,
    from: DALE_PROXY,
    text: "[#9 Sarah] Running late?",
    clientId: 5,
  });
  // unknown customer: labelled by number
  const unknown = routeInboundSms({ ...base, from: "+12085550999", body: "hi", line, client: null });
  assert.equal(unknown.kind, "forward_to_contractor");
  assert.ok((unknown as any).text.startsWith("[#9 (208) 555-0999]"));
  // contractor with no phone on file: the office gets a ticket instead
  const noPhoneLine = { ...line, userPhone: null };
  const t = routeInboundSms({ ...base, from: SARAH_PHONE, body: "hi", line: noPhoneLine, client });
  assert.equal(t.kind, "office_ticket");
  assert.equal((t as any).title, "Text from Sarah for Dale");
  // contractor replies with #id → to that customer, prefix stripped
  const ref = { clientId: 5, clientName: "Sarah", customerNumber: SARAH_PHONE };
  assert.deepEqual(routeInboundSms({ ...base, from: DALE_PHONE, body: "#9 Be there in 10", line, client: null, referenced: ref }), {
    kind: "reply_to_customer",
    to: SARAH_PHONE,
    from: DALE_PROXY,
    text: "Be there in 10",
    clientId: 5,
  });
  // contractor replies without #id → most recent customer on the line
  const last = routeInboundSms({ ...base, from: DALE_PHONE, body: "On my way", line, client: null, lastCustomer: ref });
  assert.equal(last.kind, "reply_to_customer");
  assert.equal((last as any).to, SARAH_PHONE);
  // he typed the wrong #number → told so, NOT sent to whoever texted last
  const typo = routeInboundSms({ ...base, from: DALE_PHONE, body: "#14 yes, 3 works", line, client: null, lastCustomer: ref });
  assert.equal(typo.kind, "no_thread");
  assert.equal((typo as any).to, DALE_PHONE, "the bounce goes back to him");
  assert.match((typo as any).text, /No text #14 on your line/);
  // contractor replies, nobody to reply to → told so
  const none = routeInboundSms({ ...base, from: DALE_PHONE, body: "On my way", line, client: null });
  assert.equal(none.kind, "no_thread");
  assert.equal((none as any).to, DALE_PHONE);
  // contractor sends "#9" and nothing else → told to put a message after it
  const empty = routeInboundSms({ ...base, from: DALE_PHONE, body: "#9", line, client: null, referenced: ref });
  assert.equal(empty.kind, "no_thread");
  assert.match((empty as any).text, /after the #number/);
  // STOP from anyone → logged and left alone
  assert.deepEqual(routeInboundSms({ ...base, from: SARAH_PHONE, body: " stop ", line, client }), { kind: "opt_out", clientId: 5 });
  // office line → ticket
  const office = routeInboundSms({ ...base, to: OFFICE, from: SARAH_PHONE, body: "Can you come Tuesday?", line: null, isOfficeLine: true, client });
  assert.equal(office.kind, "office_ticket");
  assert.equal((office as any).title, "Text from Sarah");
  // a number nobody owns
  assert.equal(routeInboundSms({ ...base, to: "+12085550999", from: SARAH_PHONE, body: "hi", line: null, client }).kind, "unroutable");
});

test("the webhook signature is Twilio's: url + sorted params, HMAC-SHA1, base64", () => {
  // Worked example from Twilio's own docs
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  assert.equal(twilioSignature(url, params, "12345"), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
});

// ------------------------------------------------------------ switched off --

test("with no provider: status says off and names the keys, sends answer 503 with the reason", async () => {
  setSmsProviderForTests(null);
  assert.equal(smsSendable(), false);

  const status = await api("/sms/status", admin.id);
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, false);
  assert.equal(status.body.provider, "none");
  assert.equal(status.body.officeNumber, OFFICE, "normalised from the env");
  assert.equal(status.body.webhookUrl, "https://crm.example.test/api/public/sms/inbound");
  const keys = status.body.envKeys.map((k: any) => k.key);
  assert.deepEqual(keys, ["SMS_PROVIDER", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "SMS_OFFICE_NUMBER"]);
  assert.equal(status.body.envKeys.find((k: any) => k.key === "SMS_PROVIDER").set, false);
  assert.equal(status.body.envKeys.find((k: any) => k.key === "TWILIO_AUTH_TOKEN").set, true);

  const r = await post(`/clients/${sarah.id}/sms`, admin.id, { body: "Hi Sarah" });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not switched on/);
  const j = await post(`/jobs/${daleJob.id}/sms`, dale.id, { body: "Hi" });
  assert.equal(j.status, 503);

  // a contractor's own status shows their own number, so their screen can say where texts come from
  const mine = await api("/sms/status", dale.id);
  assert.equal(mine.body.myNumber, DALE_PROXY);
});

// ------------------------------------------------------------ office sends --

test("office texts a customer from the office number, and it is logged on the customer", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);

  const r = await post(`/clients/${sarah.id}/sms`, admin.id, { body: "Hi Sarah, we'll be by around 2." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, true);
  assert.equal(r.body.to, SARAH_PHONE);
  assert.equal(r.body.from, OFFICE);
  assert.deepEqual(sent, [{ to: SARAH_PHONE, from: OFFICE, body: "Hi Sarah, we'll be by around 2." }]);

  const thread = await api(`/clients/${sarah.id}/sms`, admin.id);
  assert.equal(thread.status, 200);
  assert.equal(thread.body.length, 1);
  assert.equal(thread.body[0].direction, "outbound");
  assert.equal(thread.body[0].status, "sent");
  assert.equal(thread.body[0].userName, null, "office line, nobody's masked number");

  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, sarah.id), eq(auditEventsTable.action, "client_sms_sent")))
    .orderBy(desc(auditEventsTable.id));
  assert.ok(audit);
  assert.match(audit.description, /Texted \(208\) 555-0333 from the office number/);
});

test("office texts on a contractor's behalf from that person's masked number, so the reply reaches them", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);

  const r = await post(`/clients/${sarah.id}/sms`, admin.id, { body: "Dale here, 10 min out.", fromUserId: dale.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.from, DALE_PROXY);
  assert.equal(sent[0].from, DALE_PROXY);
  const thread = await api(`/clients/${sarah.id}/sms`, admin.id);
  assert.equal(thread.body.at(-1).userId, dale.id);
  assert.equal(thread.body.at(-1).userName, `Dale ${stamp}`);

  const noNumber = await post(`/clients/${sarah.id}/sms`, admin.id, { body: "hi", fromUserId: bob.id });
  assert.equal(noNumber.status, 400);
  assert.match(noNumber.body.error, /no texting number yet/);
});

test("no mobile number → 400 with the fix; a typed-in number overrides the customer's", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);

  const none = await post(`/clients/${noPhone.id}/sms`, admin.id, { body: "hi" });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /No mobile number/);

  const typed = await post(`/clients/${noPhone.id}/sms`, admin.id, { body: "hi", toPhone: "208 555 0444" });
  assert.equal(typed.status, 200);
  assert.equal(typed.body.to, "+12085550444");
  assert.equal(sent[0].to, "+12085550444");

  const bad = await post(`/clients/${noPhone.id}/sms`, admin.id, { body: "hi", toPhone: "12345" });
  assert.equal(bad.status, 400);
  const empty = await post(`/clients/${sarah.id}/sms`, admin.id, { body: "" });
  assert.equal(empty.status, 400, "zod: body needs at least one character");
});

test("a provider failure is kept as a failed row with the reason, never a lost text", async () => {
  setSmsProviderForTests(async () => {
    throw new Error("SMS delivery failed (400): unverified number");
  });
  const r = await post(`/clients/${sarah.id}/sms`, admin.id, { body: "hello?" });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, false);
  assert.match(r.body.error, /unverified number/);
  const [row] = await db.select().from(smsMessagesTable).where(eq(smsMessagesTable.id, r.body.messageId));
  assert.equal(row.status, "failed");
  assert.match(row.error!, /unverified/);
});

test("contractors cannot use the office endpoints", async () => {
  const r = await post(`/clients/${sarah.id}/sms`, dale.id, { body: "hi" });
  assert.equal(r.status, 403);
  const t = await api(`/clients/${sarah.id}/sms`, dale.id);
  assert.equal(t.status, 403);
});

// -------------------------------------------------------- contractor sends --

test("a contractor texts the customer of their own job from their masked number", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);

  const r = await post(`/jobs/${daleJob.id}/sms`, dale.id, { body: "Running 20 late." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.from, DALE_PROXY);
  assert.equal(r.body.to, SARAH_PHONE);
  assert.equal(sent.length, 1);
  const [row] = await db.select().from(smsMessagesTable).where(eq(smsMessagesTable.id, r.body.messageId));
  assert.equal(row.jobId, daleJob.id);
  assert.equal(row.clientId, sarah.id);
  assert.equal(row.userId, dale.id);

  // Bob is not on Dale's job
  const other = await post(`/jobs/${daleJob.id}/sms`, bob.id, { body: "hi" });
  assert.equal(other.status, 403);
  // Bob has no masked number: the office number carries it, so the reply lands with the office
  const bobs = await post(`/jobs/${bobJob.id}/sms`, bob.id, { body: "hi" });
  assert.equal(bobs.status, 200);
  assert.equal(bobs.body.from, OFFICE);
  assert.equal(bobs.body.to, "+12085550555");
});

// ----------------------------------------------------------- team numbers --

test("the office gives a person a masked number; one number, one person", async () => {
  const ok = await put(`/users/${bob.id}/sms-number`, admin.id, { smsProxyNumber: "208 555 0444" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.smsProxyNumber, "+12085550444");

  const taken = await put(`/users/${bob.id}/sms-number`, admin.id, { smsProxyNumber: DALE_PROXY });
  assert.equal(taken.status, 400);
  assert.match(taken.body.error, /already has that number/);

  const office = await put(`/users/${bob.id}/sms-number`, admin.id, { smsProxyNumber: OFFICE });
  assert.equal(office.status, 400);
  assert.match(office.body.error, /office number/);

  const garbage = await put(`/users/${bob.id}/sms-number`, admin.id, { smsProxyNumber: "call me" });
  assert.equal(garbage.status, 400);

  const notAllowed = await put(`/users/${bob.id}/sms-number`, dale.id, { smsProxyNumber: "208 555 0999" });
  assert.equal(notAllowed.status, 403);

  const cleared = await put(`/users/${bob.id}/sms-number`, admin.id, { smsProxyNumber: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.smsProxyNumber, null);

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.action, "sms_number_set"), like(auditEventsTable.description, `%Bob ${stamp}%`)));
  assert.equal(audits.length, 2, "gave, then took away");
});

// ----------------------------------------------------------------- inbound --

test("the webhook refuses anything Twilio did not sign", async () => {
  const r = await inbound({ From: SARAH_PHONE, To: DALE_PROXY, Body: "hi", MessageSid: `SMbad${stamp}` }, { badSignature: true });
  assert.equal(r.status, 403);
  const rows = await db.select().from(smsMessagesTable).where(eq(smsMessagesTable.providerMessageId, `SMbad${stamp}`));
  assert.equal(rows.length, 0);
});

test("a customer's reply to Dale's number is forwarded to Dale's own phone, labelled, and logged on the customer", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);

  const sid = `SMin1_${stamp}`;
  const r = await inbound({ From: "+12085550333", To: DALE_PROXY, Body: "Running late?", MessageSid: sid });
  assert.equal(r.status, 200);
  assert.equal(r.text, "<Response/>");

  const [row] = await db.select().from(smsMessagesTable).where(eq(smsMessagesTable.providerMessageId, sid));
  assert.ok(row, "the inbound row");
  assert.equal(row.direction, "inbound");
  assert.equal(row.clientId, sarah.id, "matched Sarah by her number");
  assert.equal(row.userId, dale.id);
  assert.equal(row.status, "forwarded");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, DALE_PHONE, "Dale's real phone");
  assert.equal(sent[0].from, DALE_PROXY, "from the masked number, so replying works");
  assert.equal(sent[0].body, `[#${row.id} Sarah Thompson ${stamp}] Running late?`);

  // Twilio retries; the same SID must not forward twice
  const again = await inbound({ From: "+12085550333", To: DALE_PROXY, Body: "Running late?", MessageSid: sid });
  assert.equal(again.status, 200);
  assert.equal(sent.length, 1);

  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, sarah.id), eq(auditEventsTable.action, "client_sms_received")))
    .orderBy(desc(auditEventsTable.id));
  assert.match(audit.description, /forwarded to their phone/);
});

test("Dale answers from his own phone: #id picks the customer, the customer sees only the masked number", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);
  const [last] = await db
    .select()
    .from(smsMessagesTable)
    .where(and(eq(smsMessagesTable.direction, "inbound"), eq(smsMessagesTable.clientId, sarah.id)))
    .orderBy(desc(smsMessagesTable.id))
    .limit(1);

  const r = await inbound({ From: DALE_PHONE, To: DALE_PROXY, Body: `#${last.id} Be there in 10`, MessageSid: `SMreply1_${stamp}` });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { to: SARAH_PHONE, from: DALE_PROXY, body: "Be there in 10" });

  const [out] = await db
    .select()
    .from(smsMessagesTable)
    .where(and(eq(smsMessagesTable.direction, "outbound"), eq(smsMessagesTable.providerMessageId, "SM_test_1")))
    .orderBy(desc(smsMessagesTable.id))
    .limit(1);
  assert.equal(out.clientId, sarah.id, "on Sarah's page");
  assert.equal(out.userId, dale.id);

  // without #id → whoever texted this line most recently, still Sarah
  const plain = await inbound({ From: DALE_PHONE, To: DALE_PROXY, Body: "Parking now", MessageSid: `SMreply2_${stamp}` });
  assert.equal(plain.status, 200);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].to, SARAH_PHONE);
  assert.equal(sent[1].body, "Parking now");

  // a #id that is not on Dale's line: he is told the number is wrong. It must
  // NOT fall back to the last thread — he named a customer, and "hello" going
  // to somebody else is a text to the wrong customer.
  const wrong = await inbound({ From: DALE_PHONE, To: DALE_PROXY, Body: "#999999999 hello", MessageSid: `SMreply3_${stamp}` });
  assert.equal(wrong.status, 200);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].to, DALE_PHONE, "the bounce comes back to Dale, not to a customer");
  assert.match(sent[2].body, /No text #999999999 on your line/);
  assert.equal(
    sent.filter((m) => m.to === SARAH_PHONE).length,
    2,
    "Sarah got the two real answers and nothing from the mistyped number",
  );
});

test("a #id pointing at the forward itself does not text Dale his own words back", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);

  // Sarah texts Dale's number; the forward we send Dale is its own row, and
  // its id sits right next to the customer's. Off by one and the old code
  // answered Dale's own phone.
  const r = await inbound({ From: SARAH_PHONE, To: DALE_PROXY, Body: "Gate code?", MessageSid: `SMself1_${stamp}` });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1, "forwarded to Dale");
  const [relay] = await db
    .select()
    .from(smsMessagesTable)
    .where(and(eq(smsMessagesTable.direction, "outbound"), eq(smsMessagesTable.toNumber, DALE_PHONE)))
    .orderBy(desc(smsMessagesTable.id))
    .limit(1);
  assert.ok(relay, "the relay row we sent Dale");

  const reply = await inbound({ From: DALE_PHONE, To: DALE_PROXY, Body: `#${relay.id} it's 1234`, MessageSid: `SMself2_${stamp}` });
  assert.equal(reply.status, 200);
  assert.equal(sent.length, 2);
  assert.match(sent[1].body, new RegExp(`No text #${relay.id} on your line`), "told the number is wrong");
  assert.equal(
    sent.filter((m) => m.body === "it's 1234").length,
    0,
    "his words went to nobody — not to the customer under a wrong id, not to himself",
  );
});

test("a text to the office number opens a ticket for the office", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);
  const r = await inbound({ From: "+12085550333", To: OFFICE, Body: "Can you come Tuesday instead?", MessageSid: `SMoffice_${stamp}` });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 0, "nothing to forward; the office reads tickets");
  const [ticket] = await db.select().from(ticketsTable).where(eq(ticketsTable.clientId, sarah.id)).orderBy(desc(ticketsTable.id)).limit(1);
  assert.ok(ticket);
  assert.equal(ticket.title, `Text from Sarah Thompson ${stamp}`);
  assert.match(ticket.description!, /Can you come Tuesday instead\?/);
});

test("a text to a contractor with no phone on file becomes a ticket, not a lost message", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);
  await put(`/users/${bob.id}/sms-number`, admin.id, { smsProxyNumber: "+12085550444" });
  const r = await inbound({ From: "+12085550333", To: "+12085550444", Body: "Gate is open", MessageSid: `SMbob_${stamp}` });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 0);
  const [ticket] = await db.select().from(ticketsTable).where(eq(ticketsTable.clientId, sarah.id)).orderBy(desc(ticketsTable.id)).limit(1);
  assert.equal(ticket.title, `Text from Sarah Thompson ${stamp} for Bob ${stamp}`);
  await put(`/users/${bob.id}/sms-number`, admin.id, { smsProxyNumber: null });
});

test("STOP is logged and nothing is sent; a picture with no words is noted, not dropped", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);
  const r = await inbound({ From: "+12085550333", To: DALE_PROXY, Body: "STOP", MessageSid: `SMstop_${stamp}` });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 0);
  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, sarah.id), eq(auditEventsTable.action, "client_sms_opt_out")));
  assert.ok(audit);

  const pic = await inbound({ From: "+12085550333", To: DALE_PROXY, Body: "", NumMedia: "1", MessageSid: `SMpic_${stamp}` });
  assert.equal(pic.status, 200);
  const [row] = await db.select().from(smsMessagesTable).where(eq(smsMessagesTable.providerMessageId, `SMpic_${stamp}`));
  assert.match(row.body, /picture message/);
  assert.equal(sent.length, 1, "the note about the picture is forwarded to Dale");
  assert.match(sent[0].body, /picture message/);
});

test("a number nobody owns is acknowledged (so Twilio stops retrying) and goes nowhere", async () => {
  const { sent, provider } = capturingProvider();
  setSmsProviderForTests(provider);
  const r = await inbound({ From: "+12085550333", To: "+12085550999", Body: "hello?", MessageSid: `SMnobody_${stamp}` });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 0);
});

// -------------------------------------------- "crew is on their way" (49) --

test("on-the-way notice: not offered until the job is On The Way, then one tap emails the customer, once", async () => {
  const gmail = capturingGmail();
  setCrewNoticeGmailProxyForTests(gmail.proxy);

  const early = await api(`/my/jobs/${daleJob.id}/on-the-way-notice`, dale.id);
  assert.equal(early.status, 200);
  assert.equal(early.body.canSend, false);
  assert.equal(early.body.reason, "not_on_the_way");
  const tooEarly = await post(`/my/jobs/${daleJob.id}/on-the-way-notice`, dale.id, {});
  assert.equal(tooEarly.body.sent, false);
  assert.equal(gmail.seen.length, 0, "nothing goes out before the tap");

  await db.update(jobsTable).set({ status: "on_the_way" }).where(eq(jobsTable.id, daleJob.id));
  const ready = await api(`/my/jobs/${daleJob.id}/on-the-way-notice`, dale.id);
  assert.equal(ready.body.canSend, true);
  assert.equal(ready.body.reason, null);
  assert.equal(ready.body.templateName, "On the way");

  const sent = await post(`/my/jobs/${daleJob.id}/on-the-way-notice`, dale.id, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.sent, true);
  assert.equal(gmail.seen.length, 1);
  const raw = gmail.seen[0].raw;
  assert.match(raw, /To: koby@radiantaisoftware\.com/);
  const words = plainTextOf(raw);
  assert.match(words, new RegExp(`Dale ${stamp}`), "names the person who tapped");
  assert.match(words, /615 E 18th Ave/, "and the house");
  assert.match(words, /is on the way to/);
  assert.match(words, /Hi Sarah,/, "first name only, the way he talks to customers");

  const after1 = await api(`/my/jobs/${daleJob.id}/on-the-way-notice`, dale.id);
  assert.equal(after1.body.canSend, false);
  assert.equal(after1.body.reason, "already_sent");
  assert.ok(after1.body.sentAt);
  const twice = await post(`/my/jobs/${daleJob.id}/on-the-way-notice`, dale.id, {});
  assert.equal(twice.body.sent, false);
  assert.equal(twice.body.reason, "already_sent");
  assert.equal(gmail.seen.length, 1, "a second tap does not email again");

  const [send] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.batchId, `on-the-way:${daleJob.id}`));
  assert.equal(send.status, "sent");
  assert.equal(send.source, "crew");
  assert.equal(send.sentById, dale.id);
  assert.ok(send.sentAt, "stamped when it went out, like every other sent email");

  // and the office's email list can name it instead of showing a raw word
  const batches = await api("/email-activity/batches", admin.id);
  assert.equal(batches.status, 200);
  const batch = batches.body.find((b: any) => b.batchId === `on-the-way:${daleJob.id}`);
  assert.ok(batch, "the send shows up in the email log");
  assert.equal(batch.sourceLabel, "Crew on the way");
  const detail = await api(`/email-activity/batches/on-the-way:${daleJob.id}`, admin.id);
  assert.equal(detail.status, 200);
  assert.ok(detail.body[0].sentAt, "and the log shows when it went out");

  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, sarah.id), eq(auditEventsTable.action, "on_the_way_notice")));
  assert.match(audit.description, /is on the way/);
});

test("on-the-way notice: no email, do-not-email, and someone else's job", async () => {
  const gmail = capturingGmail();
  setCrewNoticeGmailProxyForTests(gmail.proxy);

  await db.update(jobsTable).set({ status: "on_the_way" }).where(eq(jobsTable.id, bobJob.id));
  const none = await api(`/my/jobs/${bobJob.id}/on-the-way-notice`, bob.id);
  assert.equal(none.body.canSend, false);
  assert.equal(none.body.reason, "no_email");
  const tried = await post(`/my/jobs/${bobJob.id}/on-the-way-notice`, bob.id, {});
  assert.equal(tried.body.sent, false);
  assert.equal(tried.body.reason, "no_email");

  const [quiet] = await db
    .insert(jobsTable)
    .values({
      clientId: noMail.id,
      serviceId: service.id,
      amount: 50,
      scheduledDate: TODAY,
      status: "on_the_way",
      assignedToId: bob.id,
      dispatched: true,
      visibleToContractor: true,
    })
    .returning();
  const dne = await api(`/my/jobs/${quiet.id}/on-the-way-notice`, bob.id);
  assert.equal(dne.body.reason, "do_not_email");
  const dneSend = await post(`/my/jobs/${quiet.id}/on-the-way-notice`, bob.id, {});
  assert.equal(dneSend.body.sent, false);

  const other = await api(`/my/jobs/${daleJob.id}/on-the-way-notice`, bob.id);
  assert.equal(other.status, 403);
  const otherSend = await post(`/my/jobs/${daleJob.id}/on-the-way-notice`, bob.id, {});
  assert.equal(otherSend.status, 403);

  assert.equal(gmail.seen.length, 0, "no email left the building");
});

test("on-the-way notice: a Gmail failure is recorded and reported, not swallowed", async () => {
  setCrewNoticeGmailProxyForTests(async () => new Response("quota", { status: 429 }));
  const [job] = await db
    .insert(jobsTable)
    .values({
      clientId: sarah.id,
      serviceId: service.id,
      amount: 50,
      scheduledDate: TODAY,
      status: "on_the_way",
      assignedToId: dale.id,
      dispatched: true,
      visibleToContractor: true,
    })
    .returning();
  const r = await post(`/my/jobs/${job.id}/on-the-way-notice`, dale.id, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, false);
  assert.equal(r.body.reason, "failed");
  const [send] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.batchId, `on-the-way:${job.id}`));
  assert.equal(send.status, "failed");
  assert.ok(send.error);
  assert.equal(send.sentAt, null, "nothing went out, so nothing is stamped as sent");
  // a failed try does not count as sent: the button is still offered
  const again = await api(`/my/jobs/${job.id}/on-the-way-notice`, dale.id);
  assert.equal(again.body.canSend, true);
});

test("on-the-way email says hello once and signs off once — the letter already does both", async () => {
  const gmail = capturingGmail();
  setCrewNoticeGmailProxyForTests(gmail.proxy);
  const [job] = await db
    .insert(jobsTable)
    .values({
      clientId: sarah.id,
      serviceId: service.id,
      amount: 50,
      scheduledDate: TODAY,
      status: "on_the_way",
      assignedToId: dale.id,
      dispatched: true,
      visibleToContractor: true,
    })
    .returning();

  const r = await post(`/my/jobs/${job.id}/on-the-way-notice`, dale.id, {});
  assert.equal(r.body.sent, true, JSON.stringify(r.body));
  const raw = gmail.seen[0].raw;
  const html = htmlOf(raw);
  assert.ok(html, "the email has an html part, and that is what a phone shows");
  assert.equal(countOf(html, "Hi Sarah,"), 1, "one hello");
  assert.equal(countOf(html, "Hi Sarah Thompson"), 0, "not a second hello with her full name");
  assert.equal(countOf(html, "Questions? Just reply"), 0, "no second sign-off bolted on after ours");
  assert.match(html, /is on the way to/, "the letter he wrote is still all there");
  assert.equal(countOf(plainTextOf(raw), "Hi Sarah,"), 1, "and the plain part reads the same");
});

test("cleaning up after these tests leaves a real on-the-way email alone", async () => {
  const [mine] = await db
    .select()
    .from(emailSendsTable)
    .where(eq(emailSendsTable.batchId, `on-the-way:${daleJob.id}`));
  assert.ok(mine, "our own row is here to be cleaned up");

  // Stands in for a send the crew really made from a phone: same table, same
  // batch shape, a job that is none of our business.
  const [real] = await db
    .insert(emailSendsTable)
    .values({
      source: "crew",
      status: "sent",
      batchId: `on-the-way:999999999`,
      toEmail: "koby@radiantaisoftware.com",
      subject: `Real crew send ${stamp}`,
      sentAt: new Date(),
    })
    .returning();
  try {
    // Exactly what after() runs.
    await db.delete(emailSendsTable).where(ownEmailSends());
    const [survived] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.id, real.id));
    assert.ok(survived, "a real send must still be in the log, or that customer gets emailed twice");
    const [gone] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.id, mine.id));
    assert.equal(gone, undefined, "and our own rows are gone");
  } finally {
    await db.delete(emailSendsTable).where(eq(emailSendsTable.id, real.id));
  }
});
