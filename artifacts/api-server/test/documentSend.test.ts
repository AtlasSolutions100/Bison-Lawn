import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  servicesTable,
  jobsTable,
  documentTemplatesTable,
  emailSendsTable,
  auditEventsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;
// The open pixel needs a public origin; without one no pixel is written.
process.env.APP_PUBLIC_URL = "https://crm.example.test";

const { default: app } = await import("../src/app.ts");
const { setDocumentSendGmailProxyForTests, documentEmailHtml, recipientEmail } = await import("../src/lib/documentSend.ts");

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[], templates: [] as number[], services: [] as number[] };
let admin: { id: number };
let withEmail: { id: number; name: string };
let billingOnly: { id: number };
let noEmail: { id: number; name: string };
let optedOut: { id: number; name: string };
let template: { id: number };
let job: { id: number };

/**
 * Captures every MIME message instead of handing it to Gmail. Set `failFor`
 * to make the send to one address blow up the way a Gmail 4xx would.
 */
function capturingProxy() {
  const seen: { to: string; raw: string }[] = [];
  const state = { failFor: null as string | null };
  const proxy = async (_connector: string, _path: string, init: any) => {
    const raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString();
    const to = /^To: (.+)$/m.exec(raw)?.[1] ?? "";
    if (state.failFor && to === state.failFor) {
      return new Response("mailbox full", { status: 429 });
    }
    seen.push({ to, raw });
    return new Response(JSON.stringify({ id: `gmail-${seen.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, state, proxy: proxy as any };
}

/** The html part, decoded, so the pixel and the merged body can be asserted on. */
function htmlPartOf(raw: string): string {
  const parts = raw.split(/--bison_client_[a-f0-9]+/);
  const htmlPart = parts.find((p) => p.includes("text/html"));
  assert.ok(htmlPart, "message has an html part");
  const b64 = htmlPart.split("\r\n\r\n")[1]?.trim() ?? "";
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
  return { status: res.status, body, headers: res.headers };
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const stamp = Date.now();
  const [a] = await db
    .insert(usersTable)
    .values({ clerkId: `docsend_admin_${stamp}`, name: "Doc Send Admin", role: "admin", roleSource: "owner_assigned" })
    .returning();
  admin = a;
  ids.users.push(a.id);

  const clients = await db
    .insert(clientsTable)
    .values([
      { name: "Sarah Thompson", status: "client", email: "koby@radiantaisoftware.com", serviceAddress: "12 Elm St", city: "Post Falls", state: "ID", postalCode: "83854" },
      { name: "Ridgeline Property Group", status: "client", email: null, billingEmail: "kobystull123@gmail.com" },
      { name: "No Email Nancy", status: "client", email: null },
      { name: "Opted Out Otis", status: "client", email: "koby@radiantaisoftware.com", doNotEmail: true },
    ])
    .returning();
  [withEmail, billingOnly, noEmail, optedOut] = clients as any;
  ids.clients.push(...clients.map((c) => c.id));

  const [svc] = await db.insert(servicesTable).values({ name: `Blow Out Test ${stamp}`, rate: 90 } as any).returning();
  ids.services.push(svc.id);
  const [j] = await db
    .insert(jobsTable)
    .values({ clientId: withEmail.id, serviceId: svc.id, status: "scheduled", scheduledDate: "2026-10-03" } as any)
    .returning();
  job = j;

  const [t] = await db
    .insert(documentTemplatesTable)
    .values({
      key: `__test_doc_send_${stamp}`,
      name: "Test blow out day",
      kind: "notice",
      category: "client",
      subject: "Blow out for [clientfname] on [servicedate]",
      body: "Dear [clientfname],\n\nYour [servicename] is on [servicedate].\n\n[companyname]",
      isSeeded: false,
    })
    .returning();
  template = t;
  ids.templates.push(t.id);
});

after(async () => {
  setDocumentSendGmailProxyForTests(null);
  if (ids.clients.length) {
    await db.delete(emailSendsTable).where(inArray(emailSendsTable.clientId, ids.clients));
    await db.delete(auditEventsTable).where(inArray(auditEventsTable.clientId, ids.clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  if (ids.templates.length) await db.delete(documentTemplatesTable).where(inArray(documentTemplatesTable.id, ids.templates));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

test("recipient address: bills chase the billing email, everything else the customer's own, each falling back to the other", () => {
  const both = { email: "own@x.test", billingEmail: "bill@x.test" } as any;
  assert.equal(recipientEmail(both, false), "own@x.test");
  assert.equal(recipientEmail(both, true), "bill@x.test");
  assert.equal(recipientEmail({ email: null, billingEmail: "bill@x.test" } as any, false), "bill@x.test");
  assert.equal(recipientEmail({ email: " ", billingEmail: null } as any, true), null);
});

test("the email shell carries the company block and the pixel, and escapes the body", () => {
  const html = documentEmailHtml({
    bodyText: "Dear <Sarah>,\n\nLine two\nLine three",
    company: { name: "Bison Lawn Care", addressLine1: "1 Bison Way", city: "Hayden", state: "ID", postalCode: "83835", phone: "208-555-0100", email: "office@bison.test", signatureLine: "Your Friendly Bison" } as any,
    pixelUrl: "https://crm.example.test/api/public/email-open/abc.gif",
  });
  assert.match(html, /Bison Lawn Care/);
  assert.match(html, /1 Bison Way/);
  assert.match(html, /&lt;Sarah&gt;/, "angle brackets in the body are escaped, not rendered");
  assert.match(html, /Line two<br \/>Line three/, "single newlines become line breaks");
  assert.match(html, /<img src="https:\/\/crm\.example\.test\/api\/public\/email-open\/abc\.gif" width="1" height="1"/);
});

test("sending needs an admin session", async () => {
  const anon = await api(`/document-templates/${template.id}/send`, null, {
    method: "POST",
    body: JSON.stringify({ clientIds: [withEmail.id], source: "client_page" }),
  });
  assert.equal(anon.status, 401);
});

test("a bad body is a 400, not a half-sent batch", async () => {
  const res = await api(`/document-templates/${template.id}/send`, admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [], source: "client_page" }),
  });
  assert.equal(res.status, 400);
  const missing = await api(`/document-templates/999999999/send`, admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [withEmail.id], source: "client_page" }),
  });
  assert.equal(missing.status, 404);
});

let batchId: string;
let openToken: string;

test("sends to everyone it can, skips do-not-email and no-email by name, merges tokens and records every row", async () => {
  const { seen, proxy } = capturingProxy();
  setDocumentSendGmailProxyForTests(proxy);

  const res = await api(`/document-templates/${template.id}/send`, admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientIds: [withEmail.id, billingOnly.id, noEmail.id, optedOut.id],
      jobIds: [job.id],
      tokens: { servicedate: "October 3, 2026" },
      source: "dispatch",
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.sent, 2);
  assert.deepEqual(
    res.body.skipped.map((s: any) => [s.clientName, s.reason]).sort(),
    [
      ["No Email Nancy", "no_email"],
      ["Opted Out Otis", "do_not_email"],
    ],
  );
  assert.match(res.body.batchId, /^b_/);
  batchId = res.body.batchId;

  // Two Gmail calls, none for the skipped two.
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((s) => s.to).sort(), ["koby@radiantaisoftware.com", "kobystull123@gmail.com"]);

  // Sarah's email: first name, the job's service, the hand-typed date (which
  // beats the job's date — both say October 3 here, so check the subject).
  const sarah = seen.find((s) => s.to === "koby@radiantaisoftware.com")!;
  const subject = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(sarah.raw)?.[1] ?? "";
  assert.equal(Buffer.from(subject, "base64").toString(), "Blow out for Sarah on October 3, 2026");
  const html = htmlPartOf(sarah.raw);
  assert.match(html, /Dear Sarah,/);
  assert.match(html, new RegExp(`Your Blow Out Test \\d+ is on October 3, 2026`));
  const pixel = /https:\/\/crm\.example\.test\/api\/public\/email-open\/([A-Za-z0-9_-]+)\.gif/.exec(html);
  assert.ok(pixel, "the html carries the open pixel");
  openToken = pixel![1]!;

  // One email_sends row per recipient, all in the same batch.
  const rows = await db.select().from(emailSendsTable).where(eq(emailSendsTable.batchId, batchId));
  assert.equal(rows.length, 4);
  const byClient = new Map(rows.map((r) => [r.clientId, r]));
  assert.equal(byClient.get(withEmail.id)?.status, "sent");
  assert.equal(byClient.get(withEmail.id)?.openToken, openToken);
  assert.equal(byClient.get(withEmail.id)?.source, "dispatch");
  assert.equal(byClient.get(withEmail.id)?.templateId, template.id);
  assert.equal(byClient.get(withEmail.id)?.sentById, admin.id);
  assert.ok(byClient.get(withEmail.id)?.gmailMessageId);
  assert.equal(byClient.get(billingOnly.id)?.status, "sent");
  assert.equal(byClient.get(billingOnly.id)?.toEmail, "kobystull123@gmail.com");
  assert.equal(byClient.get(noEmail.id)?.status, "skipped");
  assert.equal(byClient.get(noEmail.id)?.skipReason, "no_email");
  assert.equal(byClient.get(noEmail.id)?.openToken, null);
  assert.equal(byClient.get(optedOut.id)?.status, "skipped");
  assert.equal(byClient.get(optedOut.id)?.skipReason, "do_not_email");

  // The audit trail names the document and the address, in his words.
  const audits = await db.select().from(auditEventsTable).where(eq(auditEventsTable.clientId, withEmail.id));
  assert.ok(audits.some((a) => a.action === "document_emailed" && /Test blow out day/.test(a.description)));
});

test("a Gmail failure for one customer is recorded and does not stop the rest", async () => {
  const { seen, state, proxy } = capturingProxy();
  state.failFor = "koby@radiantaisoftware.com";
  setDocumentSendGmailProxyForTests(proxy);

  const res = await api(`/document-templates/${template.id}/send`, admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [withEmail.id, billingOnly.id], source: "client_page" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, 1);
  assert.deepEqual(res.body.skipped, [{ clientId: withEmail.id, clientName: "Sarah Thompson", reason: "failed" }]);
  assert.equal(seen.length, 1);

  const [failed] = await db
    .select()
    .from(emailSendsTable)
    .where(eq(emailSendsTable.batchId, res.body.batchId))
    .then((rows) => rows.filter((r) => r.clientId === withEmail.id));
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /429/);
  assert.equal(failed?.openToken, null, "a failed email must not be trackable as opened");
});

test("the open pixel is public, always a GIF, and marks the row opened once", async () => {
  const hit = await fetch(`${baseUrl}/api/public/email-open/${openToken}.gif`);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("content-type"), "image/gif");
  assert.match(hit.headers.get("cache-control") ?? "", /no-store/);
  const bytes = Buffer.from(await hit.arrayBuffer());
  assert.equal(bytes.subarray(0, 6).toString(), "GIF89a");

  // A second open counts up but keeps the first time.
  await fetch(`${baseUrl}/api/public/email-open/${openToken}.gif`);
  // The update runs after the response is sent; give it a beat.
  await new Promise((r) => setTimeout(r, 200));
  const [row] = await db.select().from(emailSendsTable).where(eq(emailSendsTable.openToken, openToken));
  assert.ok(row?.openedAt, "openedAt is stamped");
  assert.equal(row?.openCount, 2);

  // An unknown token is still a GIF, never a broken image in someone's inbox.
  const unknown = await fetch(`${baseUrl}/api/public/email-open/not-a-real-token.gif`);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.headers.get("content-type"), "image/gif");
});

test("the activity screen lists the batch with its counts and who opened it", async () => {
  const anon = await api("/email-activity/batches", null);
  assert.equal(anon.status, 401);

  const list = await api("/email-activity/batches?limit=50", admin.id);
  assert.equal(list.status, 200);
  const batch = list.body.find((b: any) => b.batchId === batchId);
  assert.ok(batch, "our batch is in the list");
  assert.equal(batch.total, 4);
  assert.equal(batch.sent, 2);
  assert.equal(batch.skipped, 2);
  assert.equal(batch.failed, 0);
  assert.equal(batch.opened, 1);
  assert.equal(batch.source, "dispatch");
  assert.equal(batch.sourceLabel, "Dispatch board");
  assert.equal(batch.templateName, "Test blow out day");
  assert.equal(batch.sentByName, "Doc Send Admin");

  const detail = await api(`/email-activity/batches/${batchId}`, admin.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.length, 4);
  const sarah = detail.body.find((r: any) => r.clientId === withEmail.id);
  assert.equal(sarah.status, "sent");
  assert.ok(sarah.openedAt);
  assert.equal(sarah.openCount, 2);
  const nancy = detail.body.find((r: any) => r.clientId === noEmail.id);
  assert.equal(nancy.status, "skipped");
  assert.equal(nancy.skipReason, "no_email");

  const missing = await api("/email-activity/batches/b_nope", admin.id);
  assert.equal(missing.status, 404);
});

test("the batch list and the batch itself agree on when it went out, whatever the server's clock is set to", async () => {
  const rows = await db.select().from(emailSendsTable).where(eq(emailSendsTable.batchId, batchId));
  const earliest = rows.map((r) => r.createdAt.getTime()).sort((a, b) => a - b)[0]!;

  // The times come off a timestamp column with no zone on it, so a server
  // running on anything but UTC used to read them hours out. Pretend to be
  // one of those servers while the list is built.
  const realTz = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    const list = await api("/email-activity/batches?limit=50", admin.id);
    const batch = list.body.find((b: any) => b.batchId === batchId);
    assert.ok(batch);
    assert.equal(batch.createdAt, new Date(earliest).toISOString(), "the list shows the real time it went out");

    const detail = await api(`/email-activity/batches/${batchId}`, admin.id);
    const firstOut = detail.body.map((r: any) => r.createdAt).sort()[0];
    assert.equal(batch.createdAt, firstOut, "and the same time the batch's own screen shows");
  } finally {
    if (realTz == null) delete process.env.TZ;
    else process.env.TZ = realTz;
  }
});

test("templates list filters by folder and every seeded document is there", async () => {
  const all = await api("/document-templates", admin.id);
  assert.equal(all.status, 200);
  const keys = new Set(all.body.map((t: any) => t.key));
  for (const key of ["bison-bill", "past-due", "final-notice", "sprinkler-blowout-day", "estimate-follow-up", "dont-forget-us", "welcome-to-the-herd", "spring-letter", "turn-up-your-sprinklers", "fall-notice"]) {
    assert.ok(keys.has(key), `seed "${key}" is present on a normal start`);
  }
  const marketing = await api("/document-templates?category=marketing", admin.id);
  assert.ok(marketing.body.length >= 3);
  assert.ok(marketing.body.every((t: any) => t.category === "marketing"));
  assert.ok(!marketing.body.some((t: any) => t.id === template.id));
});
