import assert from "node:assert/strict";
import test from "node:test";
import type { Client, CompanyProfile, Invoice, InvoiceLineItem } from "@workspace/db";
import {
  balanceOf,
  billToLines,
  createInvoiceEmailHtml,
  createInvoicePdf,
  invoiceEmailSubject,
  invoiceNumberOf,
  propertyLines,
} from "../src/lib/invoiceDocument.ts";
import { dueDateFrom } from "../src/lib/invoiceNumbers.ts";
import { sendInvoiceViaGmail } from "../src/lib/invoiceDelivery.ts";

const company = {
  name: "Bison Lawn Care LLC",
  addressLine1: "Po Box 117",
  addressLine2: null,
  city: "Post Falls",
  state: "ID",
  postalCode: "83877",
  phone: "208-981-0176",
  email: "Bisonlawncarellc@gmail.com",
  website: "Bisonlawncare.net",
  signatureLine: "Your Friendly Bison,",
} as unknown as CompanyProfile;

const baseClient = {
  id: 1,
  name: "Koby Stull",
  serviceAddress: "111 Test Dr",
  addressLine2: null,
  city: "Post Falls",
  state: "ID",
  postalCode: "83854",
  email: "koby@example.com",
  accountBalance: 0,
  nameOnInvoice: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingEmail: null,
  accountNumber: "KOST1001",
} as unknown as Client;

const baseInvoice = {
  id: 12,
  clientId: 1,
  jobId: null,
  status: "open",
  total: 340,
  amountPaid: 0,
  notes: null,
  number: 4901,
  invoiceDate: "2026-09-02",
  dueDate: "2026-09-17",
  terms: "Net 15",
  poNumber: "PO-8842",
  sentAt: null,
  createdAt: new Date("2026-09-02T12:00:00Z"),
} as unknown as Invoice;

const lines = [
  {
    id: 1,
    invoiceId: 12,
    description: "Mowing",
    serviceDate: "2026-08-12",
    quantity: 4,
    unitPrice: 49,
    total: 196,
    sortOrder: 0,
  },
  {
    id: 2,
    invoiceId: 12,
    description: "Sprinkler Blowout",
    serviceDate: null,
    quantity: 1,
    unitPrice: 144,
    total: 144,
    sortOrder: 1,
  },
] as unknown as InvoiceLineItem[];

test("invoice number falls back to the row id on legacy rows", () => {
  assert.equal(invoiceNumberOf(baseInvoice), 4901);
  assert.equal(invoiceNumberOf({ id: 77, number: null } as Invoice), 77);
});

test("balance never goes negative when a customer overpays", () => {
  assert.equal(balanceOf({ total: 340, amountPaid: 100 } as Invoice), 240);
  assert.equal(balanceOf({ total: 340, amountPaid: 500 } as Invoice), 0);
  // Floating point: 0.1 + 0.2 arithmetic must not leak into a printed balance.
  assert.equal(balanceOf({ total: 0.3, amountPaid: 0.1 } as Invoice), 0.2);
});

// recalcClientBalance already excludes void invoices from what the customer
// owes, so a void invoice showing its old total under "Balance Due" — in red,
// on the list and on the printed invoice — contradicted the account balance it
// fed. Voiding cancels the debt; money already received stays as credit.
test("a void invoice owes nothing", () => {
  assert.equal(balanceOf({ total: 200, amountPaid: 0, status: "void" } as Invoice), 0);
  assert.equal(balanceOf({ total: 200, amountPaid: 50, status: "void" } as Invoice), 0);
  // Every other status is unaffected.
  assert.equal(balanceOf({ total: 200, amountPaid: 50, status: "open" } as Invoice), 150);
  assert.equal(balanceOf({ total: 200, amountPaid: 200, status: "paid" } as Invoice), 0);
});

test("bill-to uses the billing address when one is recorded", () => {
  const managed = {
    ...baseClient,
    nameOnInvoice: "Blue Sage Property Management",
    billingAddressLine1: "1712 W Durham Dr",
    billingCity: "Hayden",
    billingState: "ID",
    billingPostalCode: "83835",
  } as Client;
  assert.deepEqual(billToLines(managed), [
    "Blue Sage Property Management",
    "1712 W Durham Dr",
    "Hayden, ID 83835",
  ]);
  // The property block always stays the address the work happens at — that is
  // the whole point of separating them.
  assert.deepEqual(propertyLines(managed), ["Koby Stull", "111 Test Dr", "Post Falls, ID 83854"]);
});

test("bill-to falls back to the service address for an ordinary residential customer", () => {
  assert.deepEqual(billToLines(baseClient), ["Koby Stull", "111 Test Dr", "Post Falls, ID 83854"]);
});

test("every invoice gets a due date: Net terms, due on receipt, or his standard Net 15", () => {
  assert.equal(dueDateFrom("2026-09-02", "Net 15"), "2026-09-17");
  assert.equal(dueDateFrom("2026-09-02", "net30"), "2026-10-02");
  // Crossing a month boundary and a leap day must not drift.
  assert.equal(dueDateFrom("2026-02-20", "Net 15"), "2026-03-07");
  // The past-due automation counts from the due date, so "Due on receipt"
  // is due the day it is issued and blank terms fall back to Net 15.
  assert.equal(dueDateFrom("2026-09-02", "Due on receipt"), "2026-09-02");
  assert.equal(dueDateFrom("2026-09-02", "due upon receipt"), "2026-09-02");
  assert.equal(dueDateFrom("2026-09-02", null), "2026-09-17");
  assert.equal(dueDateFrom("2026-09-02", ""), "2026-09-17");
  // Terms the parser does not understand still leave it unset rather than guess.
  assert.equal(dueDateFrom("2026-09-02", "on the 1st"), null);
});

test("email states the balance, the terms and every line", () => {
  const html = createInvoiceEmailHtml({ invoice: baseInvoice, client: baseClient, lines, company });
  assert.match(html, /Invoice #4901/);
  assert.match(html, /Balance due \$340\.00/);
  assert.match(html, /Net 15/);
  assert.match(html, /PO-8842/);
  assert.match(html, /KOST1001/);
  assert.match(html, /Mowing/);
  assert.match(html, /Sprinkler Blowout/);
  assert.match(html, /Dear Koby,/);
  // Date-only values must render as the day the office typed, not a day earlier.
  assert.match(html, /8\/12\/2026/);
});

test("email escapes customer-supplied text", () => {
  const html = createInvoiceEmailHtml({
    invoice: baseInvoice,
    client: baseClient,
    lines: [{ ...lines[0]!, description: 'Mow <script>alert("x")</script> & edge' }],
    company,
  });
  assert.match(html, /Mow &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("subject carries the invoice number and the company name", () => {
  assert.equal(invoiceEmailSubject(baseInvoice, company), "Invoice #4901 | Bison Lawn Care LLC");
});

test("the PDF renders without touching the database when a profile is supplied", async () => {
  const pdf = await createInvoicePdf({ invoice: baseInvoice, client: baseClient, lines, company });
  assert.ok(pdf.byteLength > 1000, "expected a non-trivial PDF");
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
});

test("an invoice with no lines still renders rather than throwing", async () => {
  const pdf = await createInvoicePdf({ invoice: baseInvoice, client: baseClient, lines: [], company });
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
});

const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

const manyLines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    invoiceId: 12,
    description: `Service line ${i + 1}`,
    serviceDate: "2026-08-12",
    quantity: 1,
    unitPrice: 49,
    total: 49,
    sortOrder: i,
  })) as unknown as InvoiceLineItem[];

// The page break used to be measured against a hardcoded 700 rather than the
// page's real content bottom of 738. That wasted 38pt of every sheet, which was
// enough to push the payment coupon alone onto a second page on an invoice with
// three lines and a note — doubling the paper and postage on a mailed invoice.
test("an ordinary invoice keeps its payment coupon on one page", async () => {
  const withNote = { ...baseInvoice, notes: "Thanks — please return the stub with your cheque." } as Invoice;

  for (const [count, invoice] of [
    [3, withNote],
    [5, baseInvoice],
  ] as const) {
    const pdf = await createInvoicePdf({
      invoice,
      client: baseClient,
      lines: manyLines(count),
      company,
    });
    assert.equal(
      pageCount(pdf),
      1,
      `${count} lines${invoice.notes ? " with a note" : ""} should fit on a single page`,
    );
  }
});

// The other half of the same guard, in the other direction: `needed` must stay
// an upper bound on what the coupon actually draws, or it starts too near the
// bottom and tears across the break — a dashed rule on one sheet and the remit
// details on the next, which is worse than a clean second page. These counts
// were measured against the rendered output; a change either way means the
// break moved and wants looking at.
test("invoices spill to a second page only when they genuinely need one", async () => {
  const expected: [lines: number, pages: number][] = [
    [1, 1],
    [5, 1],
    [8, 2],
    [24, 2],
    [30, 3],
  ];

  for (const [count, pages] of expected) {
    const pdf = await createInvoicePdf({
      invoice: baseInvoice,
      client: baseClient,
      lines: manyLines(count),
      company,
    });
    assert.equal(pageCount(pdf), pages, `${count} lines should render as ${pages} page(s)`);
  }
});

test("Gmail delivery attaches the PDF and names it for the customer's filing", async () => {
  let captured: any;
  const fakeProxy = async (_connector: string, path: string, init: any) => {
    captured = { path, init };
    return new Response(JSON.stringify({ id: "gmail-inv-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await sendInvoiceViaGmail(
    {
      toEmail: "customer@example.com",
      subject: "Invoice #4901 | Bison Lawn Care LLC",
      html: "<p>Invoice</p>",
      pdf: Buffer.from("%PDF-1.4 fake"),
      invoiceNumber: 4901,
      company,
    },
    fakeProxy,
  );

  assert.equal((result as { id: string }).id, "gmail-inv-1");
  const raw = JSON.parse(captured.init.body).raw as string;
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(mime, /To: customer@example\.com/);
  assert.match(mime, /Content-Type: multipart\/mixed/);
  assert.match(mime, /filename="Bison-Lawn-Care-LLC-Invoice-4901\.pdf"/);
});
