import assert from "node:assert/strict";
import test from "node:test";
import {
  createCustomerMessageEmailHtml,
  customerMessageSubject,
  sendCustomerMessageViaGmail,
} from "../src/lib/customerMessageDelivery.ts";

test("approved message is wrapped in the Bison email shell with escaped content", () => {
  const html = createCustomerMessageEmailHtml(
    'Rain <10 mm> & wind\nWe will come Friday instead.',
    "Test Customer",
  );
  assert.match(html, /Bison Lawn Care LLC/);
  assert.match(html, /Hi Test Customer,/);
  assert.match(html, /Rain &lt;10 mm&gt; &amp; wind/);
  assert.match(html, /<br \/>We will come Friday instead\./);
  assert.doesNotMatch(html, /<10 mm>/);
});

test("subject names the action and the affected date", () => {
  assert.equal(
    customerMessageSubject("reschedule", "2026-08-26"),
    "Service rescheduled — 2026-08-26 | Bison Lawn Care LLC",
  );
  assert.equal(customerMessageSubject("skip", null), "Service skipped | Bison Lawn Care LLC");
});

test("Gmail delivery sends an RFC 2822 HTML message", async () => {
  let captured: any;
  const fakeProxy = async (_connector: string, path: string, init: any) => {
    captured = { path, init };
    return new Response(JSON.stringify({ id: "gmail-msg-7" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await sendCustomerMessageViaGmail(
    { toEmail: "customer@example.com", subject: "Service skipped", html: "<p>Hello</p>" },
    fakeProxy,
  );
  assert.equal(result.id, "gmail-msg-7");
  assert.equal(captured.path, "/gmail/v1/users/me/messages/send");
  const body = JSON.parse(captured.init.body);
  const mime = Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  assert.match(mime, /To: customer@example\.com/);
  assert.match(mime, /Subject: Service skipped/);
  assert.match(mime, /Content-Type: text\/html/);
  assert.equal(Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString(), "<p>Hello</p>");
});

test("provider errors reject instead of reporting a silent success", async () => {
  const fakeProxy = async () => new Response("mailbox unavailable", { status: 550 });
  await assert.rejects(
    () =>
      sendCustomerMessageViaGmail(
        { toEmail: "customer@example.com", subject: "Service skipped", html: "<p>Hello</p>" },
        fakeProxy,
      ),
    /Gmail delivery failed \(550\)/,
  );
});
