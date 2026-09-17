import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  jobsTable,
  invoicesTable,
  paymentsTable,
  auditEventsTable,
  servicesTable,
} from "@workspace/db";
import { eq, inArray, desc } from "drizzle-orm";
import { csvCell } from "../src/routes/clients-bulk.ts";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
};

let admin: { id: number };
let contractor: { id: number };
let service: { id: number };
// A unique tag so the "distinct" checks below never collide with real data.
const STAMP = Date.now();
const MARK = `bulktest${STAMP}`;

async function api(
  path: string,
  userId: number | null,
  init: RequestInit = {},
): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(userId != null
        ? { "x-test-user-id": String(userId), "x-test-auth-token": TEST_AUTH_TOKEN }
        : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, body: isJson && text ? JSON.parse(text) : null, text, headers: res.headers };
}

async function seedClient(values: Partial<typeof clientsTable.$inferInsert> & { name: string }) {
  const [row] = await db
    .insert(clientsTable)
    .values({ status: "client", tags: [MARK], ...values })
    .returning();
  ids.clients.push(row.id);
  return row;
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a, c] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_bulk_admin_${STAMP}`, name: "Bulk Admin", role: "admin", roleSource: "owner_assigned" },
      { clerkId: `test_bulk_contractor_${STAMP}`, name: "Bulk Contractor", role: "contractor" },
    ])
    .returning();
  admin = a;
  contractor = c;
  ids.users.push(a.id, c.id);

  const [svc] = await db.insert(servicesTable).values({ name: `Bulk Mow ${STAMP}` }).returning();
  service = svc;
  ids.services.push(svc.id);
});

after(async () => {
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

test("csvCell quotes commas and quotes, and defuses formula cells", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell("Smith, Jane"), '"Smith, Jane"');
  assert.equal(csvCell('The "Barn"'), '"The ""Barn"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  // Defused as text with ="...", which is the form Excel does not show; the old
  // leading apostrophe was visible in the cell.
  assert.equal(csvCell("=HYPERLINK(1)"), '"=""=HYPERLINK(1)"""');
  assert.equal(csvCell("@sum(A1)"), '"=""@sum(A1)"""');
  assert.equal(csvCell('=A1&"x"'), '"=""=A1&""""x"""""""');
  assert.equal(csvCell("+1 208 555 0100"), '"=""+1 208 555 0100"""');
  assert.ok(!csvCell("+1 208 555 0100").includes("'"), "no stray apostrophe on a phone number");
  // A number is a number. A credit balance he cannot sum in Excel is the whole
  // reason the Balance column exists.
  assert.equal(csvCell("-5"), "-5");
  assert.equal(csvCell("-25.00"), "-25.00");
  assert.equal(csvCell("+7"), "+7");
  assert.equal(csvCell("-1,250.75"), '"-1,250.75"');
  assert.equal(csvCell(12.5), "12.5");
  assert.equal(csvCell(-40), "-40");
});

test("the client list does not read an untouched dropdown as blank", async () => {
  // The bulk edit dialog is React and there is no browser runner here, so the
  // one thing that can go wrong silently is pinned against the page source:
  // ticking "Do not email" and leaving the select on the "On" it is showing
  // used to send doNotEmail: false and clear the protection on every customer
  // selected.
  const page = await readFile(
    new URL("../../bison-crm/src/pages/clients.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/\(values\[key\] \?\? ''\)\.trim\(\)/.test(page),
    "submit must not read an untouched dropdown as an empty string",
  );
  assert.match(
    page,
    /choices\?\.\[0\]\?\.value/,
    "submit must fall back to the choice the select is displaying",
  );
  assert.match(
    page,
    /\{ value: 'true', label: 'On — skip them in bulk emails' \}/,
    "the first do-not-email choice is the one that turns it on",
  );
});

test("a custom field nobody filled in is not read as zero", async () => {
  const page = await readFile(
    new URL("../../bison-crm/src/pages/clients.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/Number\(raw \?\? 0\)/.test(page),
    "'Turf sqft less than 5000' must not match every customer he has never measured",
  );
  assert.match(
    page,
    /const have = empty \? NaN : Number\(raw\);/,
    "no value stays no value in the number filter",
  );
  assert.match(
    page,
    /if \(Number\.isNaN\(have\)\) return filter\.op === 'not_equals';/,
    "no value matches nothing except 'does not equal'",
  );
  assert.match(
    page,
    /return digits \? Number\(digits\) : null;/,
    "a blank custom field reads as no measurement, not 0",
  );
  assert.ok(
    page.includes("{ value: 'is_empty', label: 'is blank' }"),
    "a number field can be asked who is still blank",
  );
});

test("bulk-update honours do-not-email both ways and leaves it alone when unsent", async () => {
  const protectedClient = await seedClient({ name: `Bulk DNE On ${STAMP}`, doNotEmail: true });
  const plain = await seedClient({ name: `Bulk DNE Off ${STAMP}` });

  // What the dialog sends when he ticks the row and leaves the select showing
  // "On": every selected customer must end up protected.
  const on = await api("/clients/bulk-update", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [protectedClient.id, plain.id], doNotEmail: true }),
  });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.updated, 2);
  let rows = await db
    .select({ id: clientsTable.id, doNotEmail: clientsTable.doNotEmail })
    .from(clientsTable)
    .where(inArray(clientsTable.id, [protectedClient.id, plain.id]));
  assert.deepEqual(rows.map((r) => r.doNotEmail).sort(), [true, true]);
  const [onLine] = await db
    .select({ description: auditEventsTable.description })
    .from(auditEventsTable)
    .where(eq(auditEventsTable.clientId, plain.id))
    .orderBy(desc(auditEventsTable.id))
    .limit(1);
  assert.match(onLine.description ?? "", /Turned on do-not-email/);

  // A bulk edit about something else must not touch it.
  const other = await api("/clients/bulk-update", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [protectedClient.id], mapCode: "pf" }),
  });
  assert.equal(other.status, 200);
  rows = await db
    .select({ id: clientsTable.id, doNotEmail: clientsTable.doNotEmail })
    .from(clientsTable)
    .where(eq(clientsTable.id, protectedClient.id));
  assert.equal(rows[0].doNotEmail, true, "an edit that never mentioned it leaves it on");

  // And "Off" chosen on purpose still turns it off.
  const off = await api("/clients/bulk-update", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [protectedClient.id], doNotEmail: false }),
  });
  assert.equal(off.status, 200);
  rows = await db
    .select({ id: clientsTable.id, doNotEmail: clientsTable.doNotEmail })
    .from(clientsTable)
    .where(eq(clientsTable.id, protectedClient.id));
  assert.equal(rows[0].doNotEmail, false);
  const [offLine] = await db
    .select({ description: auditEventsTable.description })
    .from(auditEventsTable)
    .where(eq(auditEventsTable.clientId, protectedClient.id))
    .orderBy(desc(auditEventsTable.id))
    .limit(1);
  assert.match(offLine.description ?? "", /Turned off do-not-email/);
});

test("contractors cannot use any bulk route", async () => {
  const update = await api("/clients/bulk-update", contractor.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [1], status: "former_client" }),
  });
  assert.equal(update.status, 403);
  const del = await api("/clients/bulk-delete", contractor.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [1] }),
  });
  assert.equal(del.status, 403);
  const exp = await api("/clients/export", contractor.id);
  assert.equal(exp.status, 403);
  const anon = await api("/clients/export", null);
  assert.equal(anon.status, 401);
});

test("bulk-update sets status, leaves untouched fields alone, and writes one audit line per client", async () => {
  const one = await seedClient({ name: `Bulk One ${STAMP}`, mapCode: "PF", billingTerms: "Net 15" });
  const two = await seedClient({ name: `Bulk Two ${STAMP}`, mapCode: "CDA", billingTerms: "Net 30" });

  const res = await api("/clients/bulk-update", admin.id, {
    method: "POST",
    // Ids repeated on purpose: the count must reflect clients, not clicks.
    body: JSON.stringify({ clientIds: [one.id, two.id, one.id], status: "former_client" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 2);
  assert.deepEqual([...res.body.clientIds].sort(), [one.id, two.id].sort());

  const rows = await db.select().from(clientsTable).where(inArray(clientsTable.id, [one.id, two.id]));
  for (const row of rows) {
    assert.equal(row.status, "former_client");
  }
  // Map code and terms were not in the body, so they must survive.
  assert.equal(rows.find((r) => r.id === one.id)?.mapCode, "PF");
  assert.equal(rows.find((r) => r.id === two.id)?.billingTerms, "Net 30");

  const audit = await api(`/clients/${one.id}/audit`, admin.id);
  assert.equal(audit.status, 200);
  const line = audit.body.find((e: any) => e.action === "client_updated");
  assert.ok(line, "expected a client_updated audit line on the client");
  assert.match(line.description, /Set status to former client/);
  assert.match(line.description, /bulk edit of 2 clients/);
  assert.equal(line.actorName, "Bulk Admin");
});

test("bulk-update clears with null, uppercases map codes, and adds/removes tags without touching the rest", async () => {
  const c = await seedClient({
    name: `Bulk Tags ${STAMP}`,
    mapCode: "PF",
    waterDistrict: "Whitworth",
    tags: [MARK, "backflow", "gate code"],
  });

  const res = await api("/clients/bulk-update", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientIds: [c.id],
      mapCode: "rth",
      waterDistrict: null,
      addTags: ["  Inside Turn-On ", "BACKFLOW"],
      removeTags: ["Gate Code"],
      accountType: "commercial",
      invoiceDelivery: "print",
      billingTerms: "Net 15",
      state: "WA",
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const [row] = await db.select().from(clientsTable).where(eq(clientsTable.id, c.id));
  assert.equal(row.mapCode, "RTH");
  assert.equal(row.waterDistrict, null);
  assert.equal(row.accountType, "commercial");
  assert.equal(row.invoiceDelivery, "print");
  assert.equal(row.billingTerms, "Net 15");
  assert.equal(row.state, "WA");
  // "backflow" already there: not duplicated. "gate code" removed. New one lowercased.
  assert.deepEqual([...row.tags].sort(), [MARK, "backflow", "inside turn-on"].sort());
  assert.equal(row.status, "client");

  const [line] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.clientId, c.id))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(1);
  assert.match(line.description, /Set map code to RTH/);
  assert.match(line.description, /Cleared water district/);
  assert.match(line.description, /Added tags (backflow, inside turn-on|inside turn-on, backflow)/);
  assert.match(line.description, /Removed tag gate code/);
});

test("bulk-update rejects an empty change and unknown ids quietly count zero", async () => {
  const c = await seedClient({ name: `Bulk Empty ${STAMP}` });
  const nothing = await api("/clients/bulk-update", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [c.id] }),
  });
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error, /Nothing to change/);

  const bad = await api("/clients/bulk-update", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [], status: "client" }),
  });
  assert.equal(bad.status, 400);

  const ghost = await api("/clients/bulk-update", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [999999999], status: "client" }),
  });
  assert.equal(ghost.status, 200);
  assert.equal(ghost.body.updated, 0);
});

test("bulk-delete previews the counts, then deletes clients with their invoices, payments and jobs", async () => {
  const keep = await seedClient({ name: `Bulk Keep ${STAMP}` });
  const gone1 = await seedClient({ name: `Bulk Gone One ${STAMP}` });
  const gone2 = await seedClient({ name: `Bulk Gone Two ${STAMP}` });

  await db.insert(invoicesTable).values([
    { clientId: gone1.id, total: 50 },
    { clientId: gone1.id, total: 25 },
    { clientId: keep.id, total: 10 },
  ]);
  await db.insert(paymentsTable).values([{ clientId: gone2.id, amount: 20, method: "check" }]);
  await db.insert(jobsTable).values([
    { clientId: gone1.id, serviceId: service.id, amount: 50 },
    { clientId: gone2.id, serviceId: service.id, amount: 50 },
    { clientId: gone2.id, serviceId: service.id, amount: 50 },
  ]);

  const preview = await api("/clients/bulk-delete", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [gone1.id, gone2.id], preview: true }),
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body, { preview: true, clients: 2, invoices: 2, payments: 1, jobs: 3 });

  // Preview must not have deleted anything.
  const still = await db.select({ id: clientsTable.id }).from(clientsTable).where(inArray(clientsTable.id, [gone1.id, gone2.id]));
  assert.equal(still.length, 2);

  const del = await api("/clients/bulk-delete", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [gone1.id, gone2.id] }),
  });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { preview: false, clients: 2, invoices: 2, payments: 1, jobs: 3 });

  const after = await db.select({ id: clientsTable.id }).from(clientsTable).where(inArray(clientsTable.id, [gone1.id, gone2.id, keep.id]));
  assert.deepEqual(after.map((r) => r.id), [keep.id]);
  const keepInvoices = await db.select().from(invoicesTable).where(eq(invoicesTable.clientId, keep.id));
  assert.equal(keepInvoices.length, 1);
  const orphanJobs = await db.select().from(jobsTable).where(inArray(jobsTable.clientId, [gone1.id, gone2.id]));
  assert.equal(orphanJobs.length, 0);

  const [line] = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "clients_bulk_deleted"))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(1);
  assert.match(line.description, /Deleted 2 clients/);
  assert.match(line.description, new RegExp(`Bulk Gone One ${STAMP}`));
  assert.match(line.description, /2 invoices, 1 payment, 3 jobs/);
  assert.equal(line.actorName, "Bulk Admin");

  const bad = await api("/clients/bulk-delete", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientIds: [] }),
  });
  assert.equal(bad.status, 400);
});

test("export is a CSV with a header row, the chosen ids only, custom-field columns and escaped cells", async () => {
  const a = await seedClient({
    name: `Export, "Quoted" ${STAMP}`,
    email: "a@example.test",
    city: "Post Falls",
    propertyData: { "Turf sqft": "4200", "Gate code": "=1234" },
    accountBalance: 12.5,
  });
  const b = await seedClient({
    name: `Export Plain ${STAMP}`,
    status: "former_client",
    propertyData: { "turf sqft": "9000" },
  });
  const notMine = await seedClient({ name: `Export Other ${STAMP}` });

  const res = await api(`/clients/export?ids=${a.id},${b.id}`, admin.id);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="clients-\d{4}-\d{2}-\d{2}\.csv"/);
  // fetch's text() strips the byte-order mark, so look at the raw bytes.
  const raw = new Uint8Array(
    await (
      await fetch(`${baseUrl}/api/clients/export?ids=${a.id}`, {
        headers: { "x-test-user-id": String(admin.id), "x-test-auth-token": TEST_AUTH_TOKEN },
      })
    ).arrayBuffer(),
  );
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], "Excel needs the UTF-8 BOM");

  const lines = res.text.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  assert.equal(lines.length, 3, res.text);
  const header = lines[0].split(",");
  assert.equal(header[0], "Id");
  assert.equal(header[1], "Name");
  assert.ok(header.includes("Map Code"));
  assert.ok(header.includes("Tags"));
  // Custom fields become columns, folded case-insensitively into one.
  assert.equal(header.filter((h) => h.toLowerCase() === "turf sqft").length, 1);
  assert.ok(header.includes("Gate code"));

  const rowA = lines.find((l) => l.startsWith(`${a.id},`))!;
  assert.ok(rowA, "row for client a");
  assert.ok(rowA.includes(`"Export, ""Quoted"" ${STAMP}"`), rowA);
  assert.ok(rowA.includes('"=""=1234"""'), "formula-looking custom field is defused as text");
  assert.ok(rowA.includes("12.50"));
  const rowB = lines.find((l) => l.startsWith(`${b.id},`))!;
  assert.ok(rowB.includes(",former,"));
  assert.ok(rowB.includes("9000"));
  assert.ok(!res.text.includes(`Export Other ${STAMP}`), "ids not asked for must not leak in");

  // Without ids the status + search filters apply, same as the list.
  const filtered = await api(`/clients/export?status=former_client&search=${encodeURIComponent(`Export`)}`, admin.id);
  assert.equal(filtered.status, 200);
  assert.ok(filtered.text.includes(`Export Plain ${STAMP}`));
  assert.ok(!filtered.text.includes(`Export Other ${STAMP}`));
  assert.ok(!filtered.text.includes(String(notMine.id) + ","));
});

test("export gives a credit balance he can add up and his own added-on day", async () => {
  // 6:30 in the evening on the 15th, Idaho time. The list says the 15th, so the
  // CSV has to say the 15th too — it used to say the 16th.
  const evening = await seedClient({
    name: `Export Evening ${STAMP}`,
    accountBalance: -25,
    phone: "+1 208 555 0100",
    createdAt: new Date("2026-09-16T00:30:00.000Z"),
  });

  const res = await api(`/clients/export?ids=${evening.id}`, admin.id);
  assert.equal(res.status, 200);
  const lines = res.text.replace(/^﻿/, "").trimEnd().split("\r\n");
  const header = lines[0].split(",");
  const cells = lines[1].split(",");
  assert.equal(cells[header.indexOf("Balance")], "-25.00", "a credit balance stays a number");
  assert.equal(cells[header.indexOf("Added")], "2026-09-15", lines[1]);
  assert.ok(!res.text.includes("'-25.00"), "no apostrophe in front of a credit balance");
  assert.ok(res.text.includes('"=""+1 208 555 0100"""'), "the phone is defused without a visible mark");

  // The file he downloads is named for his day as well.
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Boise",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  assert.equal(
    res.headers.get("content-disposition"),
    `attachment; filename="clients-${stamp}.csv"`,
  );
});

test("export is not swallowed by /clients/:id", async () => {
  const res = await api("/clients/export?ids=0", admin.id);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
});
