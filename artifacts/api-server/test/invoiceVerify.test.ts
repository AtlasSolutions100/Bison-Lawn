import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  jobsTable,
  invoicesTable,
  invoiceLineItemsTable,
  paymentsTable,
  servicesTable,
  auditEventsTable,
  emailSendsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { emailInvoice, emailInvoices, loadInvoiceForDocument } = await import("../src/lib/invoiceDelivery.ts");
const { dueDateFrom, todayISO } = await import("../src/lib/invoiceNumbers.ts");
const { backfillLegacyVerifiedAt } = await import("../src/routes/billing.ts");

/**
 * The verify-before-send flow from the 2026-09-15 walkthrough: a completed
 * job's invoice is pending until the office checks it; then it waits in the
 * email or print queue; from there it is open with days past due. Plus the
 * undo, the missed-job attach, the delete, the batch email and print, the
 * payments search, and the invoice's own history.
 */

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[], services: [] as number[] };

let admin: { id: number };
let printClient: { id: number }; // delivery: print, has an email
let noMailClient: { id: number }; // delivery: email, but marked do-not-email
let noAddressClient: { id: number }; // nothing chosen, no email at all
let emailClient: { id: number }; // delivery: email
let service: { id: number };

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers; raw: Buffer }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-user-id": String(admin.id),
      "x-test-auth-token": TEST_AUTH_TOKEN,
      ...(init.headers ?? {}),
    },
  });
  const raw = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  const body = type.includes("json") && raw.length ? JSON.parse(raw.toString()) : null;
  return { status: res.status, body, headers: res.headers, raw };
}

const post = (path: string, body?: unknown) => api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (path: string, body: unknown) => api(path, { method: "PATCH", body: JSON.stringify(body) });
const del = (path: string, body?: unknown) => api(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) });

async function newJob(clientId: number, amount: number, scheduledDate: string) {
  const [job] = await db
    .insert(jobsTable)
    .values({ clientId, serviceId: service.id, status: "scheduled", dispatched: true, scheduledDate, amount })
    .returning();
  return job;
}

async function completeJob(jobId: number) {
  const res = await post(`/jobs/${jobId}/complete`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  assert.ok(job.invoiceId, "completion makes an invoice");
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, job.invoiceId!));
  return invoice;
}

async function queueIds(queue: string, extra = "") {
  const res = await api(`/invoices?queue=${queue}${extra}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as { id: number }[]).map((i) => i.id);
}

async function auditFor(invoiceId: number) {
  const res = await api(`/invoices/${invoiceId}/audit`);
  assert.equal(res.status, 200);
  return res.body as { action: string; description: string; entityType: string | null }[];
}

/** Captures what would have gone to Gmail, one message per call. */
function capturingProxy() {
  const seen: string[] = [];
  const proxy = async (_connector: string, _path: string, init: { body: string }) => {
    seen.push(Buffer.from(JSON.parse(init.body).raw, "base64url").toString());
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

  const stamp = Date.now();
  const [a] = await db
    .insert(usersTable)
    .values({ clerkId: `iv_admin_${stamp}`, name: "Verify Admin", role: "admin", roleSource: "owner_assigned" })
    .returning();
  admin = a;
  ids.users.push(a.id);

  const clients = await db
    .insert(clientsTable)
    .values([
      { name: `Print Customer ${stamp}`, status: "client", email: "koby@radiantaisoftware.com", invoiceDelivery: "print", billingTerms: "Net 15" },
      { name: `No Mail Customer ${stamp}`, status: "client", email: "kobystull123@gmail.com", invoiceDelivery: "email", doNotEmail: true },
      { name: `No Address Customer ${stamp}`, status: "client" },
      { name: `Email Customer ${stamp}`, status: "client", billingEmail: "koby@radiantaisoftware.com", invoiceDelivery: "email" },
    ])
    .returning();
  [printClient, noMailClient, noAddressClient, emailClient] = clients;
  ids.clients.push(...clients.map((c) => c.id));

  const [s] = await db
    .insert(servicesTable)
    .values({ name: `Mowing ${stamp}`, rate: 45, invoiceDescription: "Weekly mowing and trim" })
    .returning();
  service = s;
  ids.services.push(s.id);
});

after(async () => {
  if (ids.clients.length) {
    await db.delete(emailSendsTable).where(inArray(emailSendsTable.clientId, ids.clients));
    await db.delete(paymentsTable).where(inArray(paymentsTable.clientId, ids.clients));
    await db.delete(invoicesTable).where(inArray(invoicesTable.clientId, ids.clients));
    await db.delete(jobsTable).where(inArray(jobsTable.clientId, ids.clients));
    await db.delete(auditEventsTable).where(inArray(auditEventsTable.clientId, ids.clients));
    await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  }
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

// ---- the verify queue --------------------------------------------------------

let job1: { id: number };
let inv1: { id: number; number: number | null };

test("completing a job makes a pending invoice that shows only in the verification queue", async () => {
  job1 = await newJob(printClient.id, 45, "2026-09-10");
  inv1 = await completeJob(job1.id);
  assert.equal((inv1 as any).status, "pending");
  assert.equal((inv1 as any).verifiedAt, null);

  assert.ok((await queueIds("pending")).includes(inv1.id), "in Needs verification");
  assert.ok(!(await queueIds("open")).includes(inv1.id), "not in Open");
  assert.ok(!(await queueIds("to_email")).includes(inv1.id), "not in To email");
  assert.ok(!(await queueIds("to_print")).includes(inv1.id), "not in To print");

  const res = await api(`/invoices/${inv1.id}`);
  assert.equal(res.body.lines[0].description, "Weekly mowing and trim", "the service's invoice description prints");
  assert.equal(res.body.lines[0].serviceDate, "2026-09-10");
  assert.equal(
    res.body.accountBalance,
    0,
    "an unchecked bill is not on the balance the customer gets quoted",
  );
  // Was passing only because the seeded due date had not arrived yet; once it
  // had, an unchecked bill started reporting days late. A customer cannot be
  // late paying a bill that was never sent to them.
  assert.equal(res.body.daysPastDue, 0, "a pending bill is never past due");
  assert.ok(!(await queueIds("past_due")).includes(inv1.id), "and it is not in the Past due queue");
  assert.equal(res.body.clientEmail, "koby@radiantaisoftware.com");
});

test("a pending invoice is never emailed and cannot be set open by hand", async () => {
  const send = await post(`/invoices/${inv1.id}/send`, {});
  assert.equal(send.status, 400);
  assert.match(send.body.error, /not been verified/i);

  const batch = await post(`/invoices/email`, { ids: [inv1.id] });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  assert.equal(batch.body.sent, 0);
  assert.equal(batch.body.skipped[0].reason, "not_verified");

  const open = await patch(`/invoices/${inv1.id}`, { status: "open" });
  assert.equal(open.status, 400);
  assert.match(open.body.error, /verify/i);

  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv1.id));
  assert.equal(row.sentAt, null);
  assert.equal(row.status, "pending");
});

test("editing the lines while pending recomputes the total, keeps it pending and is logged", async () => {
  const res = await patch(`/invoices/${inv1.id}`, {
    lines: [
      { description: "Mowing 9/10", serviceDate: "2026-09-10", quantity: 2, unitPrice: 25 },
      { description: "Bag fee", quantity: 1, unitPrice: 5 },
    ],
    notes: "Thanks for the gate code",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.total, 55);
  assert.equal(res.body.status, "pending");
  assert.equal(res.body.notes, "Thanks for the gate code");
  assert.equal(res.body.lines.length, 2);

  const events = await auditFor(inv1.id);
  const edit = events.find((e) => e.action === "invoice_updated");
  assert.ok(edit, "the edit is in the invoice's history");
  assert.equal(edit!.entityType, "invoice");
  assert.match(edit!.description, /was \$45\.00, now \$55\.00/);
  assert.match(edit!.description, /note to the customer/);
});

// ---- delete, attach a missed job, undo --------------------------------------

let job2: { id: number };

test("deleting an unsent invoice puts its job back to completed-but-not-invoiced", async () => {
  job2 = await newJob(printClient.id, 30, "2026-09-12");
  const inv2 = await completeJob(job2.id);
  const before = await api(`/clients/${printClient.id}`);
  assert.equal(before.body.accountBalance, 85);

  const res = await del(`/invoices/${inv2.id}`);
  assert.equal(res.status, 204);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, job2.id));
  assert.equal(job.status, "completed");
  assert.equal(job.invoiceId, null, "the job is unbilled again, not lost");
  const after = await api(`/clients/${printClient.id}`);
  assert.equal(after.body.accountBalance, 55, "the deleted bill leaves the balance");

  const [event] = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.action, "invoice_deleted"), eq(auditEventsTable.entityId, inv2.id)));
  assert.ok(event, "the delete is audited");
  assert.match(event.description, /back to not invoiced/);
});

test("a missed job can be added to an invoice and its lines carry the job id", async () => {
  const res = await post(`/invoices/${inv1.id}/attach-job`, { jobId: job2.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.total, 85, "55 + the $30 job");
  const added = res.body.lines.filter((l: any) => l.jobId === job2.id);
  assert.equal(added.length, 1);
  assert.equal(added[0].description, "Weekly mowing and trim");
  assert.equal(added[0].serviceDate, "2026-09-12");
  assert.equal(added[0].unitPrice, 30);

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, job2.id));
  assert.equal(job.invoiceId, inv1.id, "the job now points at the invoice");

  const again = await post(`/invoices/${inv1.id}/attach-job`, { jobId: job2.id });
  assert.equal(again.status, 400, "cannot be billed twice");

  const notDone = await newJob(printClient.id, 10, "2026-09-20");
  const scheduled = await post(`/invoices/${inv1.id}/attach-job`, { jobId: notDone.id });
  assert.equal(scheduled.status, 400, "only completed work can be billed");
});

test("undoing the completion of an attached job takes its lines off and sends it to the waiting list", async () => {
  const res = await post(`/jobs/${job2.id}/uncomplete`, { sendTo: "waiting_list" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.invoiceVoided, false);
  assert.equal(res.body.invoiceId, inv1.id);

  const inv = await api(`/invoices/${inv1.id}`);
  assert.equal(inv.body.total, 55, "back to its own lines");
  assert.ok(inv.body.lines.every((l: any) => l.jobId == null));
  assert.equal(inv.body.status, "pending");

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, job2.id));
  assert.equal(job.status, "scheduled");
  assert.equal(job.completedAt, null);
  assert.equal(job.invoiceId, null);
  assert.equal(job.dispatched, false, "waiting list means no day");
  assert.equal(job.scheduledDate, null);
});

test("undoing the completion of the invoice's own job voids the empty invoice and keeps its day", async () => {
  const job3 = await newJob(printClient.id, 60, "2026-09-14");
  const inv3 = await completeJob(job3.id);
  const res = await post(`/jobs/${job3.id}/uncomplete`, { sendTo: "board" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.invoiceVoided, true);
  assert.equal(res.body.invoiceNumber, inv3.number);

  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv3.id));
  assert.equal(row.status, "void");
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, job3.id));
  assert.equal(job.status, "scheduled");
  assert.equal(job.dispatched, true);
  assert.equal(job.scheduledDate, "2026-09-14");
  assert.equal(job.invoiceId, null);

  const balance = await api(`/clients/${printClient.id}`);
  assert.equal(balance.body.accountBalance, 55, "the voided bill is not owed");
  const notCompleted = await post(`/jobs/${job3.id}/uncomplete`, {});
  assert.equal(notCompleted.status, 400);
});

// ---- payment at the door, then verify -------------------------------------

let payment1: { id: number };

test("a payment in full on a pending invoice pays it but keeps it in the check queue; verify then picks the print queue", async () => {
  const pay = await post(`/payments`, { clientId: printClient.id, invoiceId: inv1.id, amount: 55, method: "check", reference: "CHK 1042" });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  payment1 = pay.body;
  assert.equal(pay.body.invoiceNumber, inv1.number);
  let inv = await api(`/invoices/${inv1.id}`);
  // Money in hand wins: the bill is paid. Checking is a separate fact, so it
  // still waits in Needs verification and cannot be printed or emailed yet.
  assert.equal(inv.body.status, "paid", "paid in full at the door");
  assert.equal(inv.body.needsVerification, true, "still needs checking");
  assert.equal(inv.body.verifiedAt, null);
  assert.equal(inv.body.amountPaid, 55);
  assert.equal(inv.body.balance, 0);
  assert.equal(inv.body.lastPaymentMethod, "check", "how they pay");
  assert.ok((await queueIds("pending")).includes(inv1.id), "a door payment does not skip the check");
  assert.ok(!(await queueIds("to_print")).includes(inv1.id), "not printable before the check");
  const byHand = await patch(`/invoices/${inv1.id}`, { status: "open" });
  assert.equal(byHand.status, 400, "still cannot be moved on by hand");

  const verify = await post(`/invoices/${inv1.id}/verify`);
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.equal(verify.body.status, "paid", "verify never un-pays a paid bill");
  assert.equal(verify.body.needsVerification, false);
  assert.ok(verify.body.verifiedAt);
  assert.equal(verify.body.verifiedById, admin.id);
  assert.equal(verify.body.deliveryMethod, "print", "snapshotted from the customer");

  assert.ok((await queueIds("to_print")).includes(inv1.id), "waits to be printed");
  assert.ok(!(await queueIds("to_email")).includes(inv1.id));
  assert.ok(!(await queueIds("pending")).includes(inv1.id));

  const again = await post(`/invoices/${inv1.id}/verify`);
  assert.equal(again.status, 400);

  const events = await auditFor(inv1.id);
  assert.ok(events.some((e) => e.action === "invoice_verified" && /goes out by print/.test(e.description)));
  assert.ok(events.some((e) => e.action === "payment_recorded" && /CHK 1042/.test(e.description)), "payments show in the invoice history");
  inv = await api(`/invoices/${inv1.id}`);
  assert.equal(inv.body.unappliedCredit, 0);
});

test("print all returns one PDF, stamps each verified invoice printed and leaves pending ones alone", async () => {
  const pendingJob = await newJob(printClient.id, 20, "2026-09-15");
  const pending = await completeJob(pendingJob.id);
  const res = await api(`/invoices/print.pdf?ids=${inv1.id},${pending.id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/pdf/);
  assert.equal(res.raw.subarray(0, 4).toString(), "%PDF");

  const [printed] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv1.id));
  assert.ok(printed.printedAt, "printedAt stamped");
  const [still] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, pending.id));
  assert.equal(still.printedAt, null, "a pending bill is not printed");
  assert.ok(!(await queueIds("to_print")).includes(inv1.id), "leaves the print queue");
  const events = await auditFor(inv1.id);
  assert.ok(events.some((e) => e.action === "invoice_printed"));

  const nothing = await api(`/invoices/print.pdf?ids=${pending.id}`);
  assert.equal(nothing.status, 400);
  await post(`/jobs/${pendingJob.id}/uncomplete`, {});
});

test("deleting a payment re-opens the invoice and is logged on it", async () => {
  const res = await del(`/payments/${payment1.id}`);
  assert.equal(res.status, 204);
  const inv = await api(`/invoices/${inv1.id}`);
  assert.equal(inv.body.status, "open");
  assert.equal(inv.body.balance, 55);
  const events = await auditFor(inv1.id);
  const gone = events.find((e) => e.action === "payment_deleted");
  assert.ok(gone);
  assert.equal(gone!.entityType, "invoice");
  assert.match(gone!.description, /owed again/);
});

// ---- email all --------------------------------------------------------------

let invEmail: { id: number; number: number | null };
let jobEmail: { id: number };

test("email all sends the Bison bill to verified customers, bills do-not-email ones too, and skips the no-address one", async () => {
  jobEmail = await newJob(emailClient.id, 75, "2026-09-11");
  invEmail = await completeJob(jobEmail.id);
  const jobNoMail = await newJob(noMailClient.id, 40, "2026-09-11");
  const invNoMail = await completeJob(jobNoMail.id);
  const jobNoAddr = await newJob(noAddressClient.id, 35, "2026-09-11");
  const invNoAddr = await completeJob(jobNoAddr.id);
  for (const inv of [invEmail, invNoMail, invNoAddr]) {
    const v = await post(`/invoices/${inv.id}/verify`);
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  const noAddr = await api(`/invoices/${invNoAddr.id}`);
  assert.equal(noAddr.body.deliveryMethod, "print", "no email on file means paper");
  assert.ok((await queueIds("to_email")).includes(invEmail.id));
  assert.ok((await queueIds("to_email")).includes(invNoMail.id), "a do-not-email customer still gets their bill");

  const { seen, proxy } = capturingProxy();
  const result = await emailInvoices(
    { invoiceIds: [invEmail.id, invNoMail.id, invNoAddr.id, inv1.id], actorName: "Verify Admin", actorId: admin.id },
    proxy,
  );
  // The do-not-email box stops bulk notices, not a bill: his customer page
  // promises "invoices still go out", and skipping them left the bill stuck in
  // To email for ever — it never reached To print either.
  assert.equal(result.sent, 3, "the email customer, the do-not-email one, and the print customer with an address");
  assert.deepEqual(
    result.skipped.map((s) => [s.invoiceId, s.reason]),
    [[invNoAddr.id, "no_email"]],
  );
  assert.equal(result.failed.length, 0);
  assert.equal(seen.length, 3, "one Gmail call per sent invoice, none for the skip");
  const mime = seen.find((m) => m.includes(`Invoice #${invEmail.number ?? invEmail.id}`));
  assert.ok(mime, "subject carries the invoice number");
  assert.ok(mime!.includes("To: koby@radiantaisoftware.com"), "billing email first");
  assert.match(mime!, /Content-Type: application\/pdf/, "the PDF is attached");
  // The letter travels base64-encoded; read it back the way a mail client would.
  const htmlPart = /Content-Type: text\/html[^]*?\r\n\r\n([^]*?)\r\n--bison_invoice/.exec(mime!);
  assert.ok(htmlPart, "the email has an HTML body");
  const html = Buffer.from(htmlPart![1].replace(/\r?\n/g, ""), "base64").toString("utf8");
  assert.match(html, /late fee/i, "the payment disclosure from the Bison bill template is in the letter");
  assert.ok(html.includes(`Invoice #${invEmail.number ?? invEmail.id}`));
  assert.ok(html.includes("Weekly mowing and trim"), "the lines are in the email");

  const [sent] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invEmail.id));
  assert.ok(sent.sentAt, "sentAt stamped after Gmail accepted it");
  const [noMail] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invNoMail.id));
  assert.ok(noMail.sentAt, "the do-not-email customer's bill went out");
  assert.ok(!(await queueIds("to_email")).includes(invEmail.id), "leaves the email queue");
  assert.ok(!(await queueIds("to_email")).includes(invNoMail.id), "and does not sit in To email for ever");

  const sends = await db.select().from(emailSendsTable).where(eq(emailSendsTable.batchId, result.batchId));
  assert.equal(sends.length, 4, "one email_sends row per invoice in the batch");
  assert.deepEqual(sends.map((s) => s.status).sort(), ["sent", "sent", "sent", "skipped"]);
  assert.ok(sends.every((s) => s.source === "invoice"));
  const events = await auditFor(invEmail.id);
  assert.ok(events.some((e) => e.action === "invoice_sent" && e.entityType === "invoice"));

  const twice = await emailInvoices({ invoiceIds: [invEmail.id], actorName: "Verify Admin" }, proxy);
  assert.equal(twice.sent, 0);
  assert.equal(twice.skipped[0].reason, "already_sent", "email all never resends");
});

test("undoing a completion is refused once the bill went out", async () => {
  const res = await post(`/jobs/${jobEmail.id}/uncomplete`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already went out/);
});

// ---- manual invoices, past due, delete refusals -----------------------------

test("a typed invoice is already verified, and delete refuses a paid one unless forced", async () => {
  const created = await post(`/invoices`, {
    clientId: printClient.id,
    lines: [{ description: "Sprinkler part", quantity: 2, unitPrice: 20 }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "open");
  assert.ok(created.body.verifiedAt, "the office typed it, that is the check");
  assert.equal(created.body.deliveryMethod, "print");
  assert.equal(created.body.terms, "Net 15", "terms from the account");
  assert.ok((await queueIds("to_print")).includes(created.body.id));

  const pay = await post(`/payments`, { clientId: printClient.id, invoiceId: created.body.id, amount: 40, method: "venmo" });
  assert.equal(pay.status, 201);
  const refused = await del(`/invoices/${created.body.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /payment on it/);

  const forced = await del(`/invoices/${created.body.id}`, { force: true });
  assert.equal(forced.status, 204);
  const credit = await api(`/payments?clientId=${printClient.id}&unapplied=true`);
  assert.ok(credit.body.some((p: any) => p.id === pay.body.id && p.invoiceId == null), "the money stays as credit");
});

test("open invoices show days past due, and the past-due queue uses the invoice date for due-on-receipt terms", async () => {
  const old = await post(`/invoices`, {
    clientId: emailClient.id,
    invoiceDate: "2026-08-01",
    terms: "Due on receipt",
    lines: [{ description: "Aeration", quantity: 1, unitPrice: 120 }],
  });
  assert.equal(old.status, 201, JSON.stringify(old.body));
  assert.equal(old.body.dueDate, "2026-08-01", "due on receipt is due the day it is issued");

  // Nothing is late until the customer has it, so the bill has to have gone
  // out before the days start counting. Without this the figure stayed 0 —
  // which is the point of the rule, not a problem with the test.
  assert.equal(old.body.daysPastDue, 0, "a bill still sitting here is not the customer's delay");
  assert.ok(!(await queueIds("past_due")).includes(old.body.id), "and it is not in Past due yet");
  await db.update(invoicesTable).set({ sentAt: new Date() }).where(eq(invoicesTable.id, old.body.id));

  const sent = await api(`/invoices/${old.body.id}`);
  assert.ok(sent.body.daysPastDue >= 40, `days past due should count from Aug 1, got ${sent.body.daysPastDue}`);
  assert.ok((await queueIds("past_due")).includes(old.body.id));
  assert.ok((await queueIds("open")).includes(old.body.id));
  assert.ok(!(await queueIds("past_due")).includes(invEmail.id), "a fresh Net 15 bill is not past due yet");

  const retermed = await patch(`/invoices/${old.body.id}`, { terms: "Net 30" });
  assert.equal(retermed.body.dueDate, "2026-08-31", "the due date follows the terms");

  const byNumber = await api(`/invoices?search=${old.body.number}`);
  assert.deepEqual(byNumber.body.map((i: any) => i.id), [old.body.id], "search by invoice number");
  const byName = await api(`/invoices?search=Email%20Customer`);
  assert.ok(byName.body.some((i: any) => i.id === old.body.id), "search by customer name");
  const byClient = await api(`/invoices?clientId=${emailClient.id}&queue=open`);
  assert.ok(byClient.body.every((i: any) => i.clientId === emailClient.id));
});

test("payments are searchable by reference, invoice number, method and date", async () => {
  const ref = await post(`/payments`, { clientId: emailClient.id, invoiceId: invEmail.id, amount: 25, method: "zelle", reference: "ZL-7788" });
  assert.equal(ref.status, 201, JSON.stringify(ref.body));

  const byRef = await api(`/payments?search=ZL-7788`);
  assert.deepEqual(byRef.body.map((p: any) => p.id), [ref.body.id]);
  assert.equal(byRef.body[0].invoiceNumber, invEmail.number, "the invoice number rides along");
  assert.equal(byRef.body[0].clientName.startsWith("Email Customer"), true);

  const byNumber = await api(`/payments?search=%23${invEmail.number}`);
  assert.ok(byNumber.body.some((p: any) => p.id === ref.body.id), "search by #invoice number");

  const byMethod = await api(`/payments?method=zelle&clientId=${emailClient.id}`);
  assert.ok(byMethod.body.every((p: any) => p.method === "zelle"));
  assert.ok(byMethod.body.some((p: any) => p.id === ref.body.id));

  // His day, not the server's: a payment keyed in the evening is still today's.
  const today = todayISO();
  const inRange = await api(`/payments?from=${today}&to=${today}&clientId=${emailClient.id}`);
  assert.ok(inRange.body.some((p: any) => p.id === ref.body.id));
  const outOfRange = await api(`/payments?from=2020-01-01&to=2020-01-31&clientId=${emailClient.id}`);
  assert.equal(outOfRange.body.length, 0);
  const badDate = await api(`/payments?from=yesterday`);
  assert.equal(badDate.status, 400);

  const inv = await api(`/invoices/${invEmail.id}`);
  assert.equal(inv.body.status, "partial");
  assert.equal(inv.body.balance, 50);
  assert.equal(inv.body.lastPaymentMethod, "zelle");
});

test("the invoice history holds everything that happened to it, oldest events included", async () => {
  const events = await auditFor(inv1.id);
  const actions = new Set(events.map((e) => e.action));
  for (const expected of ["job_completed", "invoice_updated", "invoice_job_added", "job_uncompleted", "payment_recorded", "invoice_verified", "invoice_printed", "payment_deleted"]) {
    assert.ok(actions.has(expected), `${expected} should be in the history: ${[...actions].join(", ")}`);
  }
  const legacy = events.find((e) => e.action === "job_completed");
  assert.equal(legacy!.entityType, null, "found by the #number in the sentence, not a stamp");
  const other = await auditFor(invEmail.id);
  assert.ok(!other.some((e) => e.action === "payment_deleted"), "another invoice's events stay out");
});

// ---- the defects the meeting found -----------------------------------------

test("a re-billed job keeps the discount it was promised", async () => {
  // A 10% loyalty discount on a $100 mow, completed, then the bill deleted —
  // which puts the job back on the "completed, not invoiced" list — then billed
  // again as a missed job on another invoice. The discount used to vanish and
  // the customer was charged the full $100.
  const [discounted] = await db
    .insert(jobsTable)
    .values({
      clientId: printClient.id,
      serviceId: service.id,
      status: "scheduled",
      dispatched: true,
      scheduledDate: "2026-09-08",
      amount: 100,
      discountType: "percent",
      discountValue: 10,
      discountLabel: "Loyalty discount",
    })
    .returning();
  const own = await completeJob(discounted.id);
  assert.equal(own.total, 90, "completion bills $100 less the 10%");

  const gone = await del(`/invoices/${own.id}`);
  assert.equal(gone.status, 204);
  const [released] = await db.select().from(jobsTable).where(eq(jobsTable.id, discounted.id));
  assert.equal(released.invoiceId, null);
  assert.equal(released.discountValue, 10, "the discount stays on the job");

  const host = await newJob(printClient.id, 40, "2026-09-09");
  const hostInv = await completeJob(host.id);
  const attach = await post(`/invoices/${hostInv.id}/attach-job`, { jobId: discounted.id });
  assert.equal(attach.status, 200, JSON.stringify(attach.body));
  assert.equal(attach.body.total, 130, "40 + 100 - the 10% off the mow");
  const off = attach.body.lines.find((l: any) => l.description === "Loyalty discount");
  assert.ok(off, `the discount prints as its own line: ${JSON.stringify(attach.body.lines)}`);
  assert.equal(off.total, -10);
  assert.equal(off.jobId, discounted.id, "so it comes off again with the job");

  const events = await auditFor(hostInv.id);
  assert.ok(
    events.some((e) => e.action === "invoice_job_added" && /\$90\.00/.test(e.description)),
    "the audit line says what the job really added",
  );
  await post(`/jobs/${discounted.id}/uncomplete`, {});
  await post(`/jobs/${host.id}/uncomplete`, {});
});

test("a card fee paid at the door stays on the bill when the lines are added up again", async () => {
  const settings = await api(`/billing-settings`);
  const restore = { cardFeeEnabled: settings.body.cardFeeEnabled, cardFeePercent: settings.body.cardFeePercent };
  const on = await patch(`/billing-settings`, { cardFeeEnabled: true, cardFeePercent: 3 });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  try {
    const job = await newJob(printClient.id, 50, "2026-09-13");
    const inv = await completeJob(job.id);
    assert.equal(inv.total, 50);

    // The contractor takes a card on site after closing the job: $50 plus the
    // 3% fee he discloses.
    const paid = await post(`/my/jobs/${job.id}/payments`, { amount: 50, method: "credit_card" });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.equal(paid.body.cardFee, 1.5);
    const fresh = await api(`/invoices/${inv.id}`);
    assert.equal(fresh.body.total, 51.5, "the fee is charged");
    assert.equal(fresh.body.amountPaid, 51.5);

    // The office fixes the wording. The fee had no line of its own, so adding
    // the lines up used to drop it and hand the customer $1.50 of credit.
    const edited = await patch(`/invoices/${inv.id}`, {
      lines: [{ description: "Mowing 9/13", serviceDate: "2026-09-13", quantity: 1, unitPrice: 50, jobId: job.id }],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.total, 51.5, "the fee survives the edit");
    const fee = edited.body.lines.find((l: any) => l.description === "Card processing fee");
    assert.ok(fee, `the fee is now a line the customer can see: ${JSON.stringify(edited.body.lines)}`);
    assert.equal(fee.total, 1.5);
    assert.equal(edited.body.balance, 0, "paid in full, with no invented credit");

    // Adding a missed job does not drop it either.
    const missed = await newJob(printClient.id, 20, "2026-09-14");
    const missedInv = await completeJob(missed.id);
    await del(`/invoices/${missedInv.id}`);
    const attach = await post(`/invoices/${inv.id}/attach-job`, { jobId: missed.id });
    assert.equal(attach.status, 200, JSON.stringify(attach.body));
    assert.equal(attach.body.total, 71.5, "50 + the 1.50 fee + the 20 job");
    assert.equal(
      attach.body.lines.filter((l: any) => l.description === "Card processing fee").length,
      1,
      "one fee line, not one per edit",
    );
  } finally {
    await patch(`/billing-settings`, restore);
  }
});

test("bills from before there was a Verify button count as already checked", async () => {
  // Every invoice the business raised before this build has no verifiedAt, so
  // they all piled into Needs verification — the emailed ones included.
  const [emailed] = await db
    .insert(invoicesTable)
    .values({
      clientId: printClient.id,
      status: "open",
      total: 60,
      invoiceDate: "2020-05-01",
      dueDate: "2020-05-16",
      sentAt: new Date("2020-05-01T17:00:00Z"),
      createdAt: sql`timestamp '2020-05-01 17:00:00'`,
    })
    .returning();

  const row = await api(`/invoices/${emailed.id}`);
  assert.equal(row.body.needsVerification, false, "a bill the customer already holds is not waiting on him");
  assert.ok(!(await queueIds("pending")).includes(emailed.id));

  // And it can be sent again, which used to come back "has not been verified".
  const { seen, proxy } = capturingProxy();
  const resend = await emailInvoice({ invoiceId: emailed.id, actorId: admin.id, bulk: false }, proxy);
  assert.equal(resend.status, "sent", JSON.stringify(resend));
  assert.equal(seen.length, 1);

  // The one-time backfill stamps the old rows, so nothing downstream — the
  // status recalculation included — treats them as unchecked again.
  const [oldPaid] = await db
    .insert(invoicesTable)
    .values({
      clientId: printClient.id,
      status: "paid",
      total: 25,
      amountPaid: 25,
      invoiceDate: "2020-04-01",
      createdAt: sql`timestamp '2020-04-01 12:00:00'`,
    })
    .returning();
  const stamped = await backfillLegacyVerifiedAt();
  assert.ok(stamped >= 2, `the old bills are stamped, got ${stamped}`);
  const [paidAfter] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, oldPaid.id));
  assert.ok(paidAfter.verifiedAt, "an old paid bill counts as checked");
  const [emailedAfter] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, emailed.id));
  assert.equal(
    emailedAfter.verifiedAt?.toISOString(),
    emailedAfter.sentAt?.toISOString(),
    "checked as of the day it went out",
  );

  // Editing one no longer drags it back to Needs verification.
  const noted = await patch(`/invoices/${emailed.id}`, { notes: "Paid by cheque, mailed" });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  assert.equal(noted.body.status, "open", "not pushed back to pending");

  // Today's work is untouched: a bill nobody has looked at still waits, and so
  // does one paid at the door this morning.
  const todayJob = await newJob(printClient.id, 35, todayISO());
  const todayInv = await completeJob(todayJob.id);
  const [doorPaid] = await db
    .insert(invoicesTable)
    .values({ clientId: printClient.id, status: "paid", total: 15, amountPaid: 15, invoiceDate: todayISO() })
    .returning();
  await backfillLegacyVerifiedAt();
  const [stillPending] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, todayInv.id));
  assert.equal(stillPending.verifiedAt, null, "an unchecked completion is never backfilled");
  const [stillWaiting] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, doorPaid.id));
  assert.equal(stillWaiting.verifiedAt, null, "nor is a bill paid at the door today");
  await post(`/jobs/${todayJob.id}/uncomplete`, {});
});

test("verifying an old job's bill dates it due from the day it goes out", async () => {
  // His bills go out after the last job of the month, and the due date was
  // counted from the mow — so the bill arrived already two weeks late.
  const job = await newJob(printClient.id, 65, "2026-08-20");
  const inv = await completeJob(job.id);
  assert.equal(inv.invoiceDate, "2026-08-20");
  assert.equal(inv.dueDate, "2026-09-04", "Net 15 from the visit while it sits unchecked");

  const v = await post(`/invoices/${inv.id}/verify`);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.invoiceDate, "2026-08-20", "still billed for the day of the work");
  assert.equal(v.body.dueDate, dueDateFrom(todayISO(), "Net 15"), "but due 15 days after it goes out");
  assert.equal(v.body.daysPastDue, 0, "not past due the moment it is sent");
  assert.ok(!(await queueIds("past_due")).includes(inv.id));
  const events = await auditFor(inv.id);
  assert.ok(
    events.some((e) => e.action === "invoice_verified" && e.description.includes(`due ${v.body.dueDate}`)),
    "the history says when it is due",
  );
});

test("an unchecked bill stays off the balance the customer is quoted", async () => {
  const raw = await api(`/clients/${emailClient.id}`);
  const office = raw.body.accountBalance as number;
  const job = await newJob(emailClient.id, 45, "2026-09-15");
  const pending = await completeJob(job.id);

  const row = await api(`/invoices/${pending.id}`);
  assert.equal(row.body.accountBalance, office, "the new unchecked bill is not on the customer's balance");
  const sent = await api(`/invoices/${invEmail.id}`);
  assert.equal(sent.body.accountBalance, office, "nor on a verified bill's");

  // The same figure the coupon prints and the letter quotes as [accountbalance].
  const doc = await loadInvoiceForDocument(invEmail.id);
  assert.ok(doc);
  assert.equal(doc!.client.accountBalance, office, "the emailed bill quotes what they have been billed");

  const afterRaw = await api(`/clients/${emailClient.id}`);
  assert.equal(
    afterRaw.body.accountBalance,
    Math.round((office + 45) * 100) / 100,
    "the office's own balance still counts the work",
  );

  // Money taken at the door for an unchecked bill is set aside with it, rather
  // than reading as credit the customer could ask back.
  const pay = await post(`/payments`, { clientId: emailClient.id, invoiceId: pending.id, amount: 45, method: "cash" });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const paidRow = await api(`/invoices/${pending.id}`);
  assert.equal(paidRow.body.accountBalance, office, "still just what has been billed");
});

test("a payment keyed in the evening belongs to his day, not the next one in UTC", async () => {
  // 2026-09-16 01:00 UTC is 6 pm on the 15th in Post Falls.
  const [evening] = await db
    .insert(paymentsTable)
    .values({
      clientId: printClient.id,
      amount: 12.34,
      method: "cash",
      reference: "EVE-9001",
      createdAt: sql`timestamp '2026-09-16 01:00:00'`,
    })
    .returning();
  assert.ok(evening.createdAt.toISOString().startsWith("2026-09-16"), "stored as UTC wall clock");

  const hisDay = await api(`/payments?from=2026-09-15&to=2026-09-15&clientId=${printClient.id}`);
  assert.ok(hisDay.body.some((p: any) => p.id === evening.id), "found by the day he took it");
  const utcDay = await api(`/payments?from=2026-09-16&to=2026-09-16&clientId=${printClient.id}`);
  assert.ok(!utcDay.body.some((p: any) => p.id === evening.id), "and not by the next day");
});
