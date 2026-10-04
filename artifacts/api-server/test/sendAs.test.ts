import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  auditEventsTable,
  clientsTable,
  companyProfileTable,
  emailSendsTable,
  invitationsTable,
  usersTable,
  unopenedEmailAlertsTable,
} from "@workspace/db";
import { and, asc, eq, gte, inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;
// Without a public origin there is no open pixel, and the "unopened" half of
// these tests is about the pixel.
process.env.APP_PUBLIC_URL = "https://crm.example.test";

const { default: app } = await import("../src/app.ts");
const {
  companyFrom,
  companyReplyTo,
  encodeDisplayName,
  senderDisplayName,
  senderHeaders,
  senderStatus,
  resolveSenderIdentity,
  isSenderRejection,
  setSenderCompanyForTests,
  setSenderIdentityForTests,
} = await import("../src/lib/sendAs.ts");
const { withHeaders } = await import("../src/lib/gmail.ts");
const { plainBodyHtml, sendClientEmailViaGmail } = await import("../src/lib/clientEmail.ts");
const { openPixelUrl } = await import("../src/lib/documentSend.ts");
const { setInvitationGmailProxyForTests } = await import("../src/lib/invitationEmail.ts");
const {
  alertBody,
  alertSubject,
  crossingsSince,
  previewUnopenedAlert,
  runUnopenedAlert,
  updateUnopenedAlertSettings,
} = await import("../src/lib/unopenedAlerts.ts");

const COMPANY = {
  id: 1,
  name: "Bison Lawn Care, LLC",
  addressLine1: "1 Bison Way",
  addressLine2: null,
  city: "Hayden",
  state: "ID",
  postalCode: "83835",
  phone: "208-555-0100",
  email: "bisonlawncarellc@gmail.com",
  website: null,
  signatureLine: "Your Friendly Bison,",
  updatedAt: new Date(),
} as any;

/** Captures every MIME message instead of handing it to Gmail. */
function capturingProxy(behaviour?: { refuseFrom?: boolean; refusalStatus?: number; refusalDetail?: string }) {
  const seen: { raw: string }[] = [];
  let refusals = 0;
  const proxy = async (_connector: string, _path: string, init: any) => {
    const raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString();
    if (behaviour?.refuseFrom && /^From:/m.test(raw)) {
      refusals += 1;
      return new Response(
        behaviour.refusalDetail ?? "Invalid From header: user does not have permission to send as this address",
        { status: behaviour.refusalStatus ?? 400 },
      );
    }
    seen.push({ raw });
    return new Response(JSON.stringify({ id: `gmail-${seen.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, proxy: proxy as any, refusals: () => refusals };
}

let server: Server;
let baseUrl: string;
const ids = { users: [] as number[], clients: [] as number[], invitations: [] as number[] };
let admin: { id: number };
let customer: { id: number; name: string };
/** Everything this file wrote happened after this instant — see the cleanup. */
const startedAt = new Date();

/** Put the day cursor back to "never checked", the way a fresh install has it. */
async function clearAlertCursor() {
  const [row] = await db
    .select()
    .from(unopenedEmailAlertsTable)
    .orderBy(asc(unopenedEmailAlertsTable.id))
    .limit(1);
  if (row) {
    await db
      .update(unopenedEmailAlertsTable)
      .set({ lastCheckedDay: null })
      .where(eq(unopenedEmailAlertsTable.id, row.id));
  }
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

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const [a] = await db
    .insert(usersTable)
    .values({ clerkId: `sendas_admin_${stamp}`, name: "Send As Admin", role: "admin", roleSource: "owner_assigned" })
    .returning();
  admin = a;
  ids.users.push(a.id);

  // The only addresses anything in this repo may email.
  const [c] = await db
    .insert(clientsTable)
    .values({ name: "Send As Customer", status: "client", email: "koby@radiantaisoftware.com" })
    .returning();
  customer = c as any;
  ids.clients.push(c.id);

});

after(async () => {
  setSenderIdentityForTests(null);
  setSenderCompanyForTests(null);
  setInvitationGmailProxyForTests(null);
  if (ids.invitations.length) {
    await db.delete(invitationsTable).where(inArray(invitationsTable.id, ids.invitations));
  }
  if (ids.clients.length) {
    await db.delete(emailSendsTable).where(inArray(emailSendsTable.clientId, ids.clients));
    await db.delete(auditEventsTable).where(inArray(auditEventsTable.clientId, ids.clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  // Only the two actions this file can produce, and only rows written after it
  // started. Deleting by action alone took out audit rows somebody made by
  // using the feature in the browser — including the ones the dashboard's
  // activity list shows him.
  await db
    .delete(auditEventsTable)
    .where(
      and(
        inArray(auditEventsTable.action, ["unopened_email_alert_on", "unopened_email_alert_sent"]),
        gte(auditEventsTable.createdAt, startedAt),
      ),
    );
  // The alert row is the install's own single row; put it back the way a fresh
  // install has it rather than deleting it out from under the next test file.
  // Scoped to that one row's id — a settings update with no WHERE on it is one
  // typo away from rewriting a table.
  const [alertRow] = await db
    .select()
    .from(unopenedEmailAlertsTable)
    .orderBy(asc(unopenedEmailAlertsTable.id))
    .limit(1);
  if (alertRow) {
    await db
      .update(unopenedEmailAlertsTable)
      .set({
        enabled: false,
        afterDays: 3,
        scope: "invoices",
        notifyEmail: null,
        lastCheckedDay: null,
        lastSentAt: null,
        lastError: null,
      })
      .where(eq(unopenedEmailAlertsTable.id, alertRow.id));
  }
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

// -------------------------------------------------- B5: who it comes from ----

test("a company name with a comma in it is quoted, so it cannot read as a second recipient", () => {
  assert.equal(encodeDisplayName("Bison Lawn Care, LLC"), '"Bison Lawn Care, LLC"');
  assert.equal(encodeDisplayName('Bison "The Herd" Lawn'), '"Bison \\"The Herd\\" Lawn"');
  assert.match(encodeDisplayName("Bison Lawn Café"), /^=\?UTF-8\?B\?/, "non-ASCII is encoded, not sent raw");
  assert.equal(encodeDisplayName("  Bison\nLawn  "), '"Bison Lawn"', "a newline cannot inject a header");
});

test("the From line is his company and the Reply-To is his address", async () => {
  setSenderIdentityForTests({ address: "work.optional@gmail.com", source: "env" });
  setSenderCompanyForTests(COMPANY);
  assert.equal(senderDisplayName(COMPANY), "Bison Lawn Care, LLC");
  await resolveSenderIdentity();
  assert.equal(companyFrom(COMPANY), '"Bison Lawn Care, LLC" <work.optional@gmail.com>');
  assert.equal(companyReplyTo(COMPANY), "bisonlawncarellc@gmail.com");

  const headers = await senderHeaders();
  assert.deepEqual(headers, [
    'From: "Bison Lawn Care, LLC" <work.optional@gmail.com>',
    "Reply-To: bisonlawncarellc@gmail.com",
  ]);
});

test("when the mailbox IS his own address, no Reply-To is added to repeat it", async () => {
  setSenderIdentityForTests({ address: "BisonLawnCareLLC@gmail.com", source: "alias", ownDomain: true });
  setSenderCompanyForTests(COMPANY);
  const headers = await senderHeaders();
  assert.equal(headers.length, 1, "no point telling them to reply to the address it came from");
  assert.equal(headers[0], 'From: "Bison Lawn Care, LLC" <BisonLawnCareLLC@gmail.com>');
});

test("with no sending address known, no From is written and Gmail fills it in as it does today", async () => {
  setSenderIdentityForTests({ address: null, source: "unknown" });
  setSenderCompanyForTests(COMPANY);
  assert.equal(companyFrom(COMPANY), "", "an empty From means: send no From header at all");
  const headers = await senderHeaders();
  assert.deepEqual(headers, ["Reply-To: bisonlawncarellc@gmail.com"], "replies still come to him");
});

test("when Google will not say which addresses the mailbox may use, we try his own anyway", async () => {
  // The real install: Google is connected, but the app holds gmail.send only,
  // so the sendAs list comes back 403 and we learn nothing. Writing no From at
  // all is what put a stranger's name on his bills, so his own address goes on
  // and Google gets to answer.
  setSenderIdentityForTests(null);
  setSenderCompanyForTests(COMPANY);
  const identity = await resolveSenderIdentity();
  assert.equal(identity.address, "bisonlawncarellc@gmail.com");
  assert.equal(identity.source, "optimistic");
  assert.equal(identity.ownDomain, false, "unproven until Google accepts it — the card must not claim otherwise");

  const headers = await senderHeaders();
  assert.deepEqual(
    headers,
    ['From: "Bison Lawn Care, LLC" <bisonlawncarellc@gmail.com>'],
    "a From IS written, and no Reply-To repeating the same address",
  );
  const status = await senderStatus();
  assert.match(status.customersSee, /^Bison Lawn Care, LLC <bisonlawncarellc@gmail\.com>/);
  assert.match(status.note ?? "", /let Google answer/);
});

test("with no From on the message, the Settings card does not claim his company name is on it", async () => {
  setSenderIdentityForTests({ address: null, source: "unknown" });
  setSenderCompanyForTests(COMPANY);
  const status = await senderStatus();
  assert.equal(status.fromAddress, null, "nothing is written on the From line");
  assert.ok(
    !status.customersSee.startsWith("Bison Lawn Care"),
    "so the card may not print his company name as what customers see",
  );
  assert.match(status.customersSee, /not your company name yet/);
});

test("an address Gmail refused is never tried again, even when GMAIL_SEND_AS still names it", async () => {
  const configured = process.env.GMAIL_SEND_AS;
  process.env.GMAIL_SEND_AS = "not-allowed@elsewhere.test";
  try {
    setSenderIdentityForTests({ address: "not-allowed@elsewhere.test", source: "env" });
    setSenderCompanyForTests(COMPANY);
    const { seen, proxy, refusals } = capturingProxy({ refuseFrom: true });
    for (const subject of ["one", "two", "three"]) {
      await sendClientEmailViaGmail({ toEmail: "koby@radiantaisoftware.com", subject, body: "Hello" }, proxy);
    }
    assert.equal(refusals(), 1, "one refusal in total, not one for every letter after it");
    assert.equal(seen.length, 3, "and all three letters reached the customer");
    assert.equal(companyFrom(COMPANY), "", "nothing puts the refused address back on the From line");
  } finally {
    if (configured == null) delete process.env.GMAIL_SEND_AS;
    else process.env.GMAIL_SEND_AS = configured;
  }
});

test("Google answering 403 delegation denied still delivers the letter, without our From", async () => {
  setSenderIdentityForTests({ address: "not-allowed@elsewhere.test", source: "env" });
  setSenderCompanyForTests(COMPANY);
  const { seen, proxy, refusals } = capturingProxy({
    refuseFrom: true,
    refusalStatus: 403,
    refusalDetail: "Delegation denied for not-allowed@elsewhere.test",
  });
  const result = await sendClientEmailViaGmail(
    { toEmail: "koby@radiantaisoftware.com", subject: "Your lawn", body: "Hello" },
    proxy,
  );
  assert.equal(refusals(), 1);
  assert.equal(seen.length, 1, "the retry went through");
  assert.ok(!/^From:/m.test(seen[0].raw));
  assert.ok(result.id, "the customer has the letter");
});

test("an address with a newline in it is never put in a header", async () => {
  setSenderIdentityForTests({ address: "a@b.test\nBcc: sneak@evil.test", source: "env" });
  setSenderCompanyForTests(COMPANY);
  assert.equal(companyFrom(COMPANY), "");
  const headers = await senderHeaders();
  assert.ok(!headers.some((h) => h.startsWith("From:")));
});

test("headers are only added above the header block, never from the body", () => {
  const mime = ["To: a@b.test", "Subject: hi", "", "From: not a header, just text he typed"].join("\r\n");
  const out = withHeaders(mime, ["From: X <x@y.test>", "Reply-To: z@y.test"]);
  assert.ok(out.startsWith("From: X <x@y.test>\r\nReply-To: z@y.test\r\nTo: a@b.test"));

  const already = ["From: Someone <s@t.test>", "To: a@b.test", "", "body"].join("\r\n");
  assert.equal(withHeaders(already, ["From: X <x@y.test>"]), already, "a caller's own From is left alone");
  assert.equal(withHeaders(mime, []), mime);
});

test("every customer email carries the From and Reply-To, through the one place that sends", async () => {
  setSenderIdentityForTests({ address: "work.optional@gmail.com", source: "env" });
  setSenderCompanyForTests(COMPANY);
  const { seen, proxy } = capturingProxy();
  await sendClientEmailViaGmail(
    { toEmail: "koby@radiantaisoftware.com", subject: "Your lawn", body: "Hello" },
    proxy,
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0].raw, /^From: "Bison Lawn Care, LLC" <work\.optional@gmail\.com>$/m);
  assert.match(seen[0].raw, /^Reply-To: bisonlawncarellc@gmail\.com$/m);
  assert.match(seen[0].raw, /^To: koby@radiantaisoftware\.com$/m);
});

test("Gmail refusing our From still delivers the letter, without it", async () => {
  setSenderIdentityForTests({ address: "not-allowed@elsewhere.test", source: "env" });
  setSenderCompanyForTests(COMPANY);
  const { seen, proxy, refusals } = capturingProxy({ refuseFrom: true });
  const result = await sendClientEmailViaGmail(
    { toEmail: "koby@radiantaisoftware.com", subject: "Your lawn", body: "Hello" },
    proxy,
  );
  assert.equal(refusals(), 1, "the first attempt carried the From and was refused");
  assert.equal(seen.length, 1, "the retry went through");
  assert.ok(!/^From:/m.test(seen[0].raw), "and carried no From of ours");
  assert.ok(result.id, "the customer has the letter");

  // And we stop choosing that address, so the next letter does not pay for the
  // same refusal.
  const headers = await senderHeaders();
  assert.ok(!headers.some((h) => h.startsWith("From:")));
  const status = await senderStatus();
  assert.match(status.note ?? "", /refused/i);
});

test("a 400 that has nothing to do with the sender is not retried away", async () => {
  setSenderIdentityForTests({ address: "work.optional@gmail.com", source: "env" });
  setSenderCompanyForTests(COMPANY);
  let calls = 0;
  const proxy = (async () => {
    calls += 1;
    return new Response("Recipient address required", { status: 400 });
  }) as any;
  await assert.rejects(
    () => sendClientEmailViaGmail({ toEmail: "koby@radiantaisoftware.com", subject: "s", body: "b" }, proxy),
    /Gmail delivery failed \(400\)/,
  );
  assert.equal(calls, 1, "one attempt, one failure — no silent second send");
  assert.equal(isSenderRejection("Recipient address required"), false);
  assert.equal(isSenderRejection("Invalid From header"), true);
});

test("the Settings line says what customers see and what his own domain would need", async () => {
  setSenderIdentityForTests({ address: "work.optional@gmail.com", source: "env" });
  setSenderCompanyForTests(COMPANY);
  const status = await senderStatus();
  assert.equal(status.fromName, "Bison Lawn Care, LLC");
  assert.equal(status.customersSee, "Bison Lawn Care, LLC <work.optional@gmail.com>");
  assert.equal(status.ownDomain, false);
  assert.match(status.whatWouldBeNeeded ?? "", /Send mail as/i);

  setSenderIdentityForTests({ address: "bisonlawncarellc@gmail.com", source: "alias", ownDomain: true });
  const good = await senderStatus();
  assert.equal(good.ownDomain, true);
  assert.equal(good.whatWouldBeNeeded, null, "nothing left to ask for");
});

test("the endpoint behind the Settings card is admin-only and answers in his words", async () => {
  setSenderIdentityForTests({ address: "work.optional@gmail.com", source: "env" });
  setSenderCompanyForTests(COMPANY);
  assert.equal((await api("/email-sender", null)).status, 401);
  const res = await api("/email-sender", admin.id);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.customersSee, "string");
  assert.equal(res.body.fromAddress, "work.optional@gmail.com");
});

// ------------------------------------------- B4: the invitation send path ----

test("inviting somebody actually sends, records that it went, and comes from his company", async () => {
  setSenderIdentityForTests({ address: "work.optional@gmail.com", source: "env" });
  setSenderCompanyForTests(COMPANY);
  const { seen, proxy } = capturingProxy();
  setInvitationGmailProxyForTests(proxy);

  const email = `koby+eich${Date.now()}@radiantaisoftware.com`;
  const created = await api("/invitations", admin.id, {
    method: "POST",
    body: JSON.stringify({ email, accessLevel: "mobile", note: "Mow route 3" }),
  });
  assert.equal(created.status, 201);
  ids.invitations.push(created.body.id);
  assert.ok(created.body.emailedAt, "the office is told the invite went only when it went");
  assert.equal(created.body.emailError, null);

  assert.equal(seen.length, 1, "one invitation, one email");
  assert.match(seen[0].raw, /^From: "Bison Lawn Care, LLC" <work\.optional@gmail\.com>$/m);
  assert.match(seen[0].raw, /^Reply-To: bisonlawncarellc@gmail\.com$/m);
  assert.match(seen[0].raw, new RegExp(`^To: ${email.replace(/[+.]/g, "\\$&")}$`, "m"));
  const html = Buffer.from(seen[0].raw.split("\r\n\r\n")[1] ?? "", "base64").toString();
  assert.match(html, /Please sign up using/, "and tells them which address to use");

  // Resend works on an invitation nobody has accepted — the answer to "Eich
  // did not receive email" when the first one went astray.
  const resent = await api(`/invitations/${created.body.id}/resend`, admin.id, { method: "POST" });
  assert.equal(resent.status, 200);
  assert.ok(resent.body.emailedAt);
  assert.equal(seen.length, 2);
});

test("a send that fails is recorded as failed, not reported as sent", async () => {
  setInvitationGmailProxyForTests((async () => new Response("quota", { status: 429 })) as any);
  const email = `koby+failed${Date.now()}@radiantaisoftware.com`;
  const created = await api("/invitations", admin.id, {
    method: "POST",
    body: JSON.stringify({ email, accessLevel: "mobile" }),
  });
  assert.equal(created.status, 201, "the row is still worth keeping — the role applies when they sign in");
  ids.invitations.push(created.body.id);
  assert.equal(created.body.emailedAt, null);
  assert.match(created.body.emailError ?? "", /429/);
  setInvitationGmailProxyForTests(null);
});

// --------------------------------- E2: an unopened email on his account ----

test("an email typed on the client page lands on the customer's timeline as not opened", async () => {
  setSenderIdentityForTests({ address: "work.optional@gmail.com", source: "env" });
  setSenderCompanyForTests(COMPANY);
  const sent = await api(`/clients/${customer.id}/email`, admin.id, {
    method: "POST",
    body: JSON.stringify({ subject: "About your sprinklers", body: "Hi there" }),
  });
  assert.equal(sent.status, 200, sent.body?.error ?? "");

  const [row] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.clientId, customer.id));
  assert.ok(row, "the email he typed is in the log, not only in the audit trail");
  assert.equal(row.status, "sent");
  assert.equal(row.source, "client_page");
  assert.ok(row.openToken, "with a pixel, so 'not opened' can mean something");
  assert.equal(row.openedAt, null);

  const activity = await api(`/client-activity?clientId=${customer.id}&kinds=email`, admin.id);
  assert.equal(activity.status, 200);
  const emailItem = activity.body.find((i: any) => i.refId === row.id);
  assert.ok(emailItem, "and it shows on the customer's account");
  assert.equal(emailItem.status, "unopened", "which is the whole point of the request");

  // Loading the pixel is what flips it, and it needs no session.
  const pixel = await fetch(`${baseUrl}/api/public/email-open/${row.openToken}.gif`);
  assert.equal(pixel.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  const [opened] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.id, row.id));
  assert.ok(opened.openedAt, "opened now");
  const after = await api(`/client-activity?clientId=${customer.id}&kinds=email`, admin.id);
  assert.equal(after.body.find((i: any) => i.refId === row.id).status, "opened");
});

// -------------------------- E3: tell HIM about unopened invoices / emails ----

test("only the emails that cross the line since the last check are reported, once each", () => {
  const row = (id: number, sentDay: string) => ({
    emailSendId: id,
    clientId: 1,
    clientName: "C",
    subject: "s",
    toEmail: "a@b.test",
    source: "invoice",
    // Midday, so the office-timezone day is the day we meant whatever the
    // server's own clock is doing.
    sentAt: `${sentDay}T19:00:00.000Z`,
    daysUnopened: 9,
  });
  const rows = [row(1, "2026-10-01"), row(2, "2026-09-28"), row(3, "2026-09-20")];
  // afterDays 3: #1 crosses on the 4th, #2 on the 1st, #3 on the 23rd. The
  // clock is passed in too, because three days has to have really gone by —
  // #1 was sent midday on the 1st, so it is three days old midday on the 4th.
  const today = "2026-10-04";
  const now = new Date("2026-10-04T19:30:00.000Z");
  const reported = crossingsSince(rows, 3, "2026-10-03", today, now).due.map((r) => r.emailSendId);
  assert.deepEqual(reported, [1], "only the one that crossed today");

  const caughtUp = crossingsSince(rows, 3, "2026-09-30", today, now).due.map((r) => r.emailSendId);
  assert.deepEqual(caughtUp, [1, 2], "a server that was off for days still catches up");
  assert.deepEqual(crossingsSince(rows, 3, today, today, now).due, [], "and never reports the same one twice");
});

test("three days means three days, not two and a bit — and nothing is skipped waiting for it", () => {
  // A bill emailed at ten to midnight Pacific on the 1st. Its third CALENDAR
  // day starts five past midnight on the 4th, which is 48 hours later: he
  // asked to hear about a bill that has sat three days and was told after two,
  // with a line saying three.
  const bill = {
    emailSendId: 1,
    clientId: 1,
    clientName: "Sarah Thompson",
    subject: "Invoice #4901",
    toEmail: "koby@radiantaisoftware.com",
    source: "client_page",
    sentAt: "2026-10-02T06:50:00.000Z",
    daysUnopened: 3,
  };

  const justAfterMidnight = crossingsSince([bill] as any, 3, "2026-10-03", "2026-10-04", new Date("2026-10-04T07:05:00.000Z"));
  assert.deepEqual(justAfterMidnight.due, [], "48 hours is not three days");
  assert.equal(justAfterMidnight.cursorDay, "2026-10-03", "and the day stays open so the bill is not skipped");

  const reallyThreeDays = crossingsSince([bill] as any, 3, "2026-10-03", "2026-10-05", new Date("2026-10-05T07:05:00.000Z"));
  assert.deepEqual(reallyThreeDays.due.map((r) => r.emailSendId), [1], "reported once it really has been three days");
  assert.equal(reallyThreeDays.cursorDay, "2026-10-05", "nothing left open, so the cursor moves on");
});

test("the wording says not opened yet, never that the customer ignored him", () => {
  const rows = [
    {
      emailSendId: 1,
      clientId: 1,
      clientName: "Sarah Thompson",
      subject: "Invoice #4901",
      toEmail: "koby@radiantaisoftware.com",
      source: "invoice",
      sentAt: "2026-09-30T19:00:00.000Z",
      daysUnopened: 4,
    },
  ];
  const subject = alertSubject(rows as any, "Bison Lawn Care, LLC", true);
  assert.match(subject, /not opened yet/);
  const body = alertBody(rows as any, 3, true);
  assert.match(body, /Sarah Thompson/);
  assert.match(body, /not opened yet/);
  assert.match(body, /worth a phone call/, "it tells him what the figure is and is not");
  // The only mention of ignoring is the sentence denying it. Nothing in here
  // may state as a fact what the customer did.
  assert.match(body, /not proof the customer ignored you/);
  assert.ok(!/(has|have|is|are) ignor/i.test(body), "never asserts what the customer did");
});

test("a batch too big for one email still reports how many there really are", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    emailSendId: i + 1,
    clientId: 1,
    clientName: `Customer ${i + 1}`,
    subject: "Invoice",
    toEmail: "koby@radiantaisoftware.com",
    source: "client_page",
    sentAt: "2026-09-30T19:00:00.000Z",
    daysUnopened: 4,
  }));
  // He emails 709 bills in one sitting, so 312 of them can cross the line on
  // the same day. Telling him "100" and never mentioning the other 212 is a
  // wrong number, not a short list.
  assert.match(alertSubject(rows as any, "Bison Lawn Care, LLC", true, 312), /^312 invoice emails not opened yet/);
  const body = alertBody(rows as any, 3, true, 312);
  assert.match(body, /^312 invoice emails have been out for 3 days/);
  assert.match(body, /Only the first 100 are listed here\. There are 312 in all\./);

  // And nothing is dressed up when the whole list fits.
  const small = alertBody(rows.slice(0, 2) as any, 3, true);
  assert.match(small, /^2 invoice emails have been out/);
  assert.ok(!/Only the first/.test(small));
});

test("the rule ships switched off, previews who it would tell, and only emails him when he turns it on", async () => {
  const off = await api("/unopened-alerts", admin.id);
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false, "off like every other rule");
  assert.match(off.body.problem ?? "", /switched off|Nowhere to send/);

  // Two emails sent to this customer six days ago that nobody has opened: a
  // bill, and a letter typed on his page. The bill's row carries an open token
  // but the bill email carries no picture, so nobody can say whether it was
  // opened; the letter carries both.
  const sentAt = new Date(Date.now() - 6 * 86_400_000);
  const [bill] = await db
    .insert(emailSendsTable)
    .values({
      clientId: customer.id,
      source: "invoice",
      toEmail: "koby@radiantaisoftware.com",
      subject: "Invoice #9001 | Bison Lawn Care",
      status: "sent",
      openToken: `unopened_test_${Date.now()}`,
      sentAt,
    })
    .returning();
  const [letter] = await db
    .insert(emailSendsTable)
    .values({
      clientId: customer.id,
      source: "client_page",
      toEmail: "koby@radiantaisoftware.com",
      subject: "About your sprinklers",
      status: "sent",
      openToken: `unopened_letter_${Date.now()}`,
      sentAt,
    })
    .returning();

  // Bills only — which is how it ships — reports nothing at all, and says why
  // in words rather than handing him 100 customers who read and paid.
  const bills = await api("/unopened-alerts", admin.id, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, afterDays: 3, scope: "invoices", notifyEmail: "koby@radiantaisoftware.com" }),
  });
  assert.equal(bills.status, 200);
  assert.ok(
    !bills.body.stillUnopened.some((r: any) => r.emailSendId === bill.id),
    "a bill whose open could never be recorded is never called unopened",
  );
  assert.match(bills.body.problem ?? "", /Bills are left out for now/);

  const saved = await api("/unopened-alerts", admin.id, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, afterDays: 3, scope: "all", notifyEmail: "koby@radiantaisoftware.com" }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, true);
  assert.equal(saved.body.notifyEmail, "koby@radiantaisoftware.com");
  assert.ok(
    saved.body.stillUnopened.some((r: any) => r.emailSendId === letter.id),
    "the preview shows the letter nobody has opened",
  );
  assert.ok(!saved.body.stillUnopened.some((r: any) => r.emailSendId === bill.id), "and still not the bill");
  assert.equal(saved.body.problem, null);

  // Nothing opened: the pixel never fired, which is exactly the case he wants
  // to hear about.
  const { seen, proxy } = capturingProxy();
  setSenderIdentityForTests({ address: "work.optional@gmail.com", source: "env" });
  setSenderCompanyForTests(COMPANY);
  const run = await runUnopenedAlert({ force: true }, proxy);
  assert.equal(run.error, null);
  assert.equal(run.to, "koby@radiantaisoftware.com");
  assert.ok(run.reported >= 1, "he is told about it");
  assert.equal(seen.length, 1, "one email to him, not one per customer");
  assert.match(seen[0].raw, /^To: koby@radiantaisoftware\.com$/m, "to HIM, never to the customer");

  // Second run the same day does nothing: he is not told twice.
  const again = await runUnopenedAlert({}, proxy);
  assert.equal(again.skipped, "already_today");
  assert.equal(seen.length, 1);

  // And an opened email drops off the list.
  await db.update(emailSendsTable).set({ openedAt: new Date() }).where(eq(emailSendsTable.id, letter.id));
  const after = await api("/unopened-alerts", admin.id);
  assert.ok(!after.body.stillUnopened.some((r: any) => r.emailSendId === letter.id));

  // Switched off, nothing runs at all, however overdue anything is.
  await updateUnopenedAlertSettings({ enabled: false });
  const quiet = await runUnopenedAlert({}, proxy);
  assert.equal(quiet.skipped, "disabled");
  assert.equal(seen.length, 1);
});

test("off the live install, nothing is emailed to an address we are not allowed to write to", async () => {
  // The default recipient is his own company email, and this machine holds the
  // same Google token as his install — so one press of "Send it to me now"
  // from a desk here would land real mail in Adam's inbox.
  await updateUnopenedAlertSettings({ enabled: true, notifyEmail: "bisonlawncarellc@gmail.com" });
  const { seen, proxy } = capturingProxy();
  const run = await runUnopenedAlert({ force: true }, proxy);
  assert.equal(run.skipped, "no_recipient");
  assert.equal(seen.length, 0, "nothing was sent");
  assert.match(run.error ?? "", /not the live install/);
  assert.match(run.error ?? "", /bisonlawncarellc@gmail\.com/, "and it names the address it refused to email");

  const view = await api("/unopened-alerts", admin.id);
  assert.match(view.body.problem ?? "", /not the live install/, "the page says so before he presses anything");

  // An address we are allowed to email is not in the way.
  await updateUnopenedAlertSettings({ notifyEmail: "koby@radiantaisoftware.com" });
  const allowed = await runUnopenedAlert({ force: true }, proxy);
  assert.notEqual(allowed.skipped, "no_recipient");
  await updateUnopenedAlertSettings({ enabled: false, notifyEmail: null });
});

test("an email that could carry no picture stores no open token, so it is never called unopened", async () => {
  const configured = process.env.APP_PUBLIC_URL;
  try {
    // No public address for the app means the picture has nowhere to point.
    delete process.env.APP_PUBLIC_URL;
    assert.equal(openPixelUrl("abc123"), null, "no picture can be built");
    assert.ok(!plainBodyHtml("Hi there", openPixelUrl("abc123")).includes("<img"), "so none goes in the email");
    // And a scheme-less value is not a usable address either: new URL() takes
    // it, but its origin is the word "null".
    process.env.APP_PUBLIC_URL = "localhost:5173";
    assert.equal(openPixelUrl("abc123"), null, "a broken picture is not tracking");
  } finally {
    if (configured == null) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = configured;
  }

  // That is why the row stores no token in that case: a token with no picture
  // reads as "we asked and heard nothing", and the alert would report an email
  // the customer read as never opened, for ever.
  const sentAt = new Date(Date.now() - 4 * 86_400_000);
  const [noPixel] = await db
    .insert(emailSendsTable)
    .values({
      clientId: customer.id,
      source: "client_page",
      toEmail: "koby@radiantaisoftware.com",
      subject: "Typed with no picture on it",
      status: "sent",
      openToken: null,
      sentAt,
    })
    .returning();
  await updateUnopenedAlertSettings({ scope: "all", afterDays: 3 });
  const preview = await previewUnopenedAlert();
  assert.ok(
    !preview.stillUnopened.some((r) => r.emailSendId === noPixel.id),
    "an email that carried nothing to tell us is never reported as not opened",
  );
  await updateUnopenedAlertSettings({ scope: "invoices" });
});

test("with nowhere to send it, the rule says so instead of failing quietly", async () => {
  await updateUnopenedAlertSettings({ enabled: true, notifyEmail: null });
  const realOwner = process.env.APP_OWNER_EMAIL;
  const [profile] = await db.select().from(companyProfileTable).limit(1);
  const realProfileEmail = profile?.email ?? null;
  try {
    delete process.env.APP_OWNER_EMAIL;
    if (profile) await db.update(companyProfileTable).set({ email: null }).where(eq(companyProfileTable.id, profile.id));
    const { seen, proxy } = capturingProxy();
    const run = await runUnopenedAlert({ force: true }, proxy);
    assert.equal(run.skipped, "no_recipient");
    assert.equal(seen.length, 0);
    const view = await api("/unopened-alerts", admin.id);
    assert.match(view.body.problem ?? "", /Nowhere to send it/);
  } finally {
    if (realOwner != null) process.env.APP_OWNER_EMAIL = realOwner;
    if (profile) {
      await db.update(companyProfileTable).set({ email: realProfileEmail }).where(eq(companyProfileTable.id, profile.id));
    }
    await updateUnopenedAlertSettings({ enabled: false });
  }
});

test("a list too long to show says how many there really are, instead of quietly cutting it", async () => {
  // Month-end: he emails the whole book in one sitting, so more cross the line
  // on one day than one email can carry. Being told "100" with no hint that
  // 101 are sitting there is the wrong number.
  const sentAt = new Date(Date.now() - 5 * 86_400_000);
  const stamp = Date.now();
  await db.insert(emailSendsTable).values(
    Array.from({ length: 101 }, (_, i) => ({
      clientId: customer.id,
      source: "client_page",
      toEmail: "koby@radiantaisoftware.com",
      subject: `Letter ${i + 1}`,
      status: "sent" as const,
      openToken: `unopened_many_${stamp}_${i}`,
      sentAt,
    })),
  );
  await updateUnopenedAlertSettings({ enabled: true, afterDays: 3, scope: "all", notifyEmail: "koby@radiantaisoftware.com" });
  await clearAlertCursor();
  try {
    const preview = await previewUnopenedAlert();
    assert.equal(preview.stillUnopened.length, 100, "the page still only draws a hundred lines");
    assert.match(preview.problem ?? "", /emails are sitting unopened past the cut-off — only the first 100 are listed/);

    const { seen, proxy } = capturingProxy();
    setSenderIdentityForTests({ address: "work.optional@gmail.com", source: "env" });
    setSenderCompanyForTests(COMPANY);
    const run = await runUnopenedAlert({ force: true }, proxy);
    assert.equal(seen.length, 1);
    assert.ok(run.reported > 100, `the true number is reported, not the hundred that fitted (${run.reported})`);
    const subject = Buffer.from(/=\?UTF-8\?B\?(.+)\?=/.exec(seen[0].raw)![1]!, "base64").toString();
    assert.match(subject, new RegExp(`^${run.reported} emails not opened yet`), "and the subject carries it");
    // The plain-text half of the message, decoded: it has to say the figure
    // and admit the list below it was cut.
    const plain = Buffer.from(seen[0].raw.split(/\r\n\r\n/)[2]!.split(/\r\n/)[0]!, "base64").toString();
    assert.match(plain, new RegExp(`^${run.reported} emails have been out for 3 days`));
    assert.match(plain, /Only the first 100 are listed here\. There are \d+ in all\./);
  } finally {
    await updateUnopenedAlertSettings({ enabled: false, scope: "invoices", notifyEmail: null });
  }
});
