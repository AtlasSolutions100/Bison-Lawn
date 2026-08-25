import assert from "node:assert/strict";
import test from "node:test";
import { createEstimatePdf, createEstimateEmailHtml } from "../src/lib/estimateDocument.ts";
import { sendEstimateViaGmail, toBase64Url } from "../src/lib/estimateDelivery.ts";
import { publicAppOrigin } from "../src/routes/estimates.ts";

const data = {
  estimate: {
    id: 42,
    clientId: 1,
    status: "draft",
    total: 125,
    notes: "Includes spring cleanup.",
    lines: [{ fieldId: 1, label: "Weekly mowing", value: "Season", calculatedPrice: 125 }],
    sentAt: null,
    sentToEmail: null,
    responseTokenHash: null,
    respondedAt: null,
    deliveryAttempts: 0,
    deliveryState: "idle",
    lastDeliveryError: null,
    gmailMessageId: null,
    createdAt: new Date("2026-08-24T12:00:00Z"),
  },
  client: {
    id: 1,
    name: "Test Customer",
    status: "client",
    serviceAddress: "123 Main St",
    city: "Denver",
    lat: null,
    lng: null,
    accountBalance: 0,
    email: "customer@example.com",
    phone: null,
    additionalContact: null,
    mapNote: null,
    propertyData: {},
    lastServiceDate: null,
    createdAt: new Date("2026-08-24T12:00:00Z"),
  },
};

test("estimate PDF is a real PDF containing customer-ready data", async () => {
  const pdf = await createEstimatePdf(data);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.ok(pdf.length > 1_000);
});

test("estimate email includes line items and secure response links", () => {
  const html = createEstimateEmailHtml(
    data,
    "Please review.",
    "https://example.com/accept?token=abc",
    "https://example.com/decline?token=abc",
  );
  assert.match(html, /Weekly mowing/);
  assert.match(html, /\$125\.00/);
  assert.match(html, /Accept Estimate/);
  assert.match(html, /https:\/\/example\.com\/decline/);
});

test("Gmail delivery sends an RFC 2822 message with HTML and PDF attachment", async () => {
  let captured: any;
  const fakeProxy = async (_connector: string, path: string, init: any) => {
    captured = { path, init };
    return new Response(JSON.stringify({ id: "gmail-123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await sendEstimateViaGmail(
    {
      toEmail: "customer@example.com",
      subject: "Estimate #42",
      html: "<p>Hello</p>",
      pdf: Buffer.from("%PDF-test"),
      estimateId: 42,
    },
    fakeProxy,
  );
  assert.equal(result.id, "gmail-123");
  assert.equal(captured.path, "/gmail/v1/users/me/messages/send");
  const body = JSON.parse(captured.init.body);
  const mime = Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  assert.match(mime, /To: customer@example\.com/);
  assert.match(mime, /Content-Type: text\/html/);
  assert.match(mime, /Content-Type: application\/pdf/);
  assert.equal(toBase64Url("hello"), "aGVsbG8");
});

test("Gmail provider errors surface without pretending delivery succeeded", async () => {
  const fakeProxy = async () => new Response("provider unavailable", { status: 503 });
  await assert.rejects(
    () =>
      sendEstimateViaGmail(
        {
          toEmail: "customer@example.com",
          subject: "Estimate #42",
          html: "<p>Hello</p>",
          pdf: Buffer.from("%PDF-test"),
          estimateId: 42,
        },
        fakeProxy,
      ),
    /Gmail delivery failed \(503\)/,
  );
});

test("production response links require a canonical HTTPS app origin", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOrigin = process.env.APP_PUBLIC_URL;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.APP_PUBLIC_URL;
    assert.throws(() => publicAppOrigin(), /APP_PUBLIC_URL is required/);
    process.env.APP_PUBLIC_URL = "http://unsafe.example.com";
    assert.throws(() => publicAppOrigin(), /must use HTTPS/);
    process.env.APP_PUBLIC_URL = "https://bison.example.com/path/";
    assert.equal(publicAppOrigin(), "https://bison.example.com");
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousOrigin == null) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = previousOrigin;
  }
});