import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import {
  db,
  pool,
  auditEventsTable,
  clientsTable,
  clientServicesTable,
  documentTemplatesTable,
  estimateFieldsTable,
  estimatesTable,
  jobsTable,
  packagesTable,
  schedulingRulesTable,
  servicesTable,
  usersTable,
} from "@workspace/db";
import type { EstimateLine } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { createEstimatePdf, createEstimateEmailHtml, lineMathLabel, quotedServicesBlock } = await import(
  "../src/lib/estimateDocument.ts"
);
const { todayLocal, rollDateOneYear } = await import("../src/lib/jobGeneration.ts");
const { addDaysISO } = await import("../src/lib/weatherCheck.ts");

/**
 * 2026-09-15 walkthrough, estimates: price = band rate x quantity x visits
 * (B2), services and whole packages on one estimate (48), a cover document
 * leading the quote (47 / P6), the customer ticking packages as one line, and
 * an accepted estimate landing on the account as assigned services.
 */

let server: Server;
let baseUrl: string;

const stamp = Date.now();
const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
  packages: [] as number[],
  fields: [] as number[],
  templates: [] as number[],
};

let admin: { id: number };
let client: { id: number; name: string };
let zonesField: { id: number; label: string };
let mowing: { id: number; name: string };
let timer: { id: number; name: string };
let blowOut: { id: number; name: string };
let sprinklerPackage: { id: number; name: string };
let coverTemplate: { id: number; name: string };
// Fixtures for the schedule the acceptance writes: a service with its own
// season, one nothing schedules, work billed by the hour, an outside
// company's work, and a recurring package whose season already closed.
let seasonMowing: { id: number; name: string };
let quietService: { id: number; name: string };
let hourlyService: { id: number; name: string };
let vendorService: { id: number; name: string };
let seasonPackage: { id: number; name: string };

async function api(path: string, userId: number | null, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(userId != null ? { "x-test-user-id": String(userId), "x-test-auth-token": TEST_AUTH_TOKEN } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Mark an estimate as sent with a known response token, the way a real send would. */
async function markSent(estimateId: number) {
  const token = `estimate-test-${estimateId}-${Math.random().toString(36).slice(2)}`;
  await db
    .update(estimatesTable)
    .set({
      status: "sent",
      sentAt: new Date(),
      sentToEmail: "koby@radiantaisoftware.com",
      deliveryState: "sent",
      responseTokenHash: createHash("sha256").update(token).digest("hex"),
    })
    .where(eq(estimatesTable.id, estimateId));
  return token;
}

async function respond(token: string, form: string) {
  const res = await fetch(`${baseUrl}/api/public/estimates/${encodeURIComponent(token)}/respond`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  return { status: res.status, text: await res.text() };
}

const packageLines = (packageKey: string): EstimateLine[] => [
  { serviceId: timer.id, label: "Timer — spring", value: "", packageId: sprinklerPackage.id, packageKey, packageName: sprinklerPackage.name },
  { serviceId: timer.id, label: "Timer — summer", value: "", packageId: sprinklerPackage.id, packageKey, packageName: sprinklerPackage.name },
  { serviceId: blowOut.id, label: "", value: "", packageId: sprinklerPackage.id, packageKey, packageName: sprinklerPackage.name },
];

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a] = await db
    .insert(usersTable)
    .values([{ clerkId: `test_est_admin_${stamp}`, name: "Estimate Admin", role: "admin", roleSource: "owner_assigned" }])
    .returning();
  admin = a;
  ids.users.push(a.id);

  const [field] = await db
    .insert(estimateFieldsTable)
    .values({ label: `Test Zones ${stamp}`, fieldType: "calculable", pricePerUnit: 12, unitSize: 1, sortOrder: 99 })
    .returning();
  zonesField = field;
  ids.fields.push(field.id);

  const [c] = await db
    .insert(clientsTable)
    .values({
      name: `Estimate Test Client ${stamp}`,
      status: "client",
      serviceAddress: "12 Quote Lane",
      city: "Post Falls",
      email: "koby@radiantaisoftware.com",
      propertyData: { [field.label]: "6200" },
    })
    .returning();
  client = c;
  ids.clients.push(c.id);

  const [mow, tmr, blow] = await db
    .insert(servicesTable)
    .values([
      {
        name: `Test Season Mowing ${stamp}`,
        rate: 45,
        visitsPerSeason: 28,
        pricingFieldId: field.id,
        // 70 covers the first 10,000 units, then 6 per 1,000 beyond that.
        pricingEquations: [
          { upToSqft: 5000, basePrice: 40, baseSqft: 5000, incrementPrice: 5, incrementSqft: 1000 },
          { upToSqft: null, basePrice: 70, baseSqft: 10000, incrementPrice: 6, incrementSqft: 1000 },
        ],
      },
      { name: `Test Timer Adjust ${stamp}`, rate: 30 },
      { name: `Test Blow-Out ${stamp}`, rate: 95 },
    ])
    .returning();
  mowing = mow;
  timer = tmr;
  blowOut = blow;
  ids.services.push(mow.id, tmr.id, blow.id);

  const today = todayLocal();
  const [pkg] = await db
    .insert(packagesTable)
    .values({
      name: `Test Sprinkler Package ${stamp}`,
      serviceIds: [tmr.id, tmr.id, blow.id],
      items: [
        { serviceId: tmr.id, label: "Timer — spring" },
        { serviceId: tmr.id, label: "Timer — summer" },
        { serviceId: blow.id },
      ],
      scheduleType: "window",
      startDate: addDaysISO(today, -30),
      endDate: addDaysISO(today, 60),
    })
    .returning();
  sprinklerPackage = pkg;
  ids.packages.push(pkg.id);

  const [season, quiet, hourly, vendor] = await db
    .insert(servicesTable)
    .values([
      {
        name: `Test In-Season Mowing ${stamp}`,
        rate: 50,
        visitsPerSeason: 28,
        // Mid-season today: opened a month ago, closes in twenty days.
        defaultStartDate: addDaysISO(today, -30),
        defaultEndDate: addDaysISO(today, 20),
      },
      {
        // Last season's dates, and nothing schedules it, so the row the
        // acceptance writes is the only thing under test.
        name: `Test Closed Season Service ${stamp}`,
        rate: 20,
        defaultStartDate: addDaysISO(today, -150),
        defaultEndDate: addDaysISO(today, -30),
      },
      { name: `Test Clean-up ${stamp}`, rate: 65, billingMode: "time", billableHours: 3 },
      { name: `Test Vendor Spray ${stamp}`, rate: 75, vendorName: "Acme Spray" },
    ])
    .returning();
  seasonMowing = season;
  quietService = quiet;
  hourlyService = hourly;
  vendorService = vendor;
  ids.services.push(season.id, quiet.id, hourly.id, vendor.id);

  const [seasonPkg] = await db
    .insert(packagesTable)
    .values({
      name: `Test Full Season Care ${stamp}`,
      serviceIds: [mow.id, quiet.id],
      items: [{ serviceId: mow.id }, { serviceId: quiet.id }],
      scheduleType: "recurring",
      frequencyWeeks: 1,
      // A whole season in the past: the package is not edited every spring.
      startDate: addDaysISO(today, -150),
      seasonEndDate: addDaysISO(today, -30),
    })
    .returning();
  seasonPackage = seasonPkg;
  ids.packages.push(seasonPkg.id);

  const [tpl] = await db
    .insert(documentTemplatesTable)
    .values({
      key: `test-estimate-cover-${stamp}`,
      name: `Test Proposal Letter ${stamp}`,
      kind: "estimate_cover",
      category: "estimate",
      body: "Dear [clientfname],\n\nHere is the quote you asked for. Everything is listed below.\n\n[bison_full_service]",
    })
    .returning();
  coverTemplate = tpl;
  ids.templates.push(tpl.id);

  // Service-specific rules beat whatever catch-all this database carries, so
  // the acceptance path is deterministic.
  await db.insert(schedulingRulesTable).values([
    { serviceId: mow.id, enabled: true, action: "dispatch", offsetDays: 1, jobNote: "test mow rule", sortOrder: 1 },
    {
      serviceId: tmr.id,
      enabled: true,
      action: "waiting_list",
      offsetDays: 1,
      windowStartMonthDay: "03-01",
      windowEndMonthDay: "11-30",
      jobNote: "test timer rule",
      sortOrder: 1,
    },
    { serviceId: blow.id, enabled: true, action: "dispatch", offsetDays: 2, jobNote: "test blow-out rule", sortOrder: 1 },
    { serviceId: season.id, enabled: true, action: "dispatch", offsetDays: 1, jobNote: "test season rule", sortOrder: 1 },
    // Nothing goes on the board for this one: the row the acceptance planned
    // is what the test reads.
    { serviceId: quiet.id, enabled: true, action: "none", offsetDays: 1, sortOrder: 1 },
    { serviceId: hourly.id, enabled: true, action: "dispatch", offsetDays: 1, jobNote: "test clean-up rule", sortOrder: 1 },
    { serviceId: vendor.id, enabled: true, action: "dispatch", offsetDays: 1, jobNote: "test vendor rule", sortOrder: 1 },
  ]);
});

after(async () => {
  // clients cascade estimates, client_services, jobs and audit events;
  // services cascade their scheduling rules.
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.packages.length) await db.delete(packagesTable).where(inArray(packagesTable.id, ids.packages));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.fields.length) await db.delete(estimateFieldsTable).where(inArray(estimateFieldsTable.id, ids.fields));
  if (ids.templates.length) await db.delete(documentTemplatesTable).where(inArray(documentTemplatesTable.id, ids.templates));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

test("a service line is priced from the matrix band times quantity times visits", async () => {
  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [{ serviceId: mowing.id, label: "", value: "6200" }],
    }),
  });
  assert.equal(created.status, 201);
  const [line] = created.body.lines;
  assert.equal(line.label, mowing.name);
  assert.equal(line.unitPrice, 70); // the 10,000-unit band covers 6,200
  assert.equal(line.quantity, 1);
  assert.equal(line.visits, 28); // the service's visits per season
  assert.equal(line.calculatedPrice, 1960);
  assert.equal(created.body.total, 1960);
  assert.equal(lineMathLabel(line), "28 visits x $70.00");

  // Beyond the band's base the increments count: 12,500 -> 70 + 3 x 6.
  const bigger = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [{ serviceId: mowing.id, label: "", value: "12500" }] }),
  });
  assert.equal(bigger.status, 201);
  assert.equal(bigger.body.lines[0].unitPrice, 88);
  assert.equal(bigger.body.lines[0].calculatedPrice, 2464);
});

test("typed quantity and visits override the service defaults, zero is allowed, negatives are not", async () => {
  const typed = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [
        { serviceId: mowing.id, label: "", value: "6200", quantity: 2, visits: 10 },
        { serviceId: mowing.id, label: "Talking point only", value: "6200", visits: 0 },
      ],
    }),
  });
  assert.equal(typed.status, 201);
  assert.equal(typed.body.lines[0].calculatedPrice, 1400);
  assert.equal(typed.body.lines[1].visits, 0);
  assert.equal(typed.body.lines[1].calculatedPrice, 0);
  assert.equal(typed.body.total, 1400);

  const negative = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [{ serviceId: mowing.id, label: "", value: "6200", visits: -3 }] }),
  });
  assert.equal(negative.status, 400);
  assert.match(negative.body.error, /visits of zero or more/);

  // No measurement typed on the line: the customer's own property detail
  // prices it, which is Adam's B1 ("the numbers don't match the matrix based
  // on clients account"). This used to quote the flat rate while the Services
  // page tester and the assigned service both showed the band price.
  const fromAccount = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [{ serviceId: mowing.id, label: "", value: "" }] }),
  });
  assert.equal(fromAccount.status, 201);
  assert.equal(fromAccount.body.lines[0].unitPrice, 70, "the band for the 6,200 on file");
  assert.equal(fromAccount.body.lines[0].value, "6200", "and the quote says which number priced it");
  assert.equal(fromAccount.body.lines[0].calculatedPrice, 1960);

  // Nobody knows the measurement: the flat rate stands in, still times the visits.
  const [bare] = await db
    .insert(clientsTable)
    .values({ name: `Estimate No Measurements ${stamp}`, status: "lead", serviceAddress: "1 Unknown Way" })
    .returning();
  ids.clients.push(bare.id);
  const flat = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: bare.id, lines: [{ serviceId: mowing.id, label: "", value: "" }] }),
  });
  assert.equal(flat.status, 201);
  assert.equal(flat.body.lines[0].unitPrice, 45);
  assert.equal(flat.body.lines[0].calculatedPrice, 1260);
});

test("a package's lines stay together, repeats and all, with the package name as sent", async () => {
  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [
        { serviceId: mowing.id, label: "", value: "6200" },
        ...packageLines("pk-test-1"),
        { label: "Haul-away", value: "", calculatedPrice: 25 },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const lines: EstimateLine[] = created.body.lines;
  assert.deepEqual(
    lines.map((l) => [l.label, l.packageKey ?? null, l.calculatedPrice]),
    [
      [mowing.name, null, 1960],
      ["Timer — spring", "pk-test-1", 30],
      ["Timer — summer", "pk-test-1", 30],
      [blowOut.name, "pk-test-1", 95],
      ["Haul-away", null, 25],
    ],
  );
  assert.ok(lines.slice(1, 4).every((l) => l.packageId === sprinklerPackage.id && l.packageName === sprinklerPackage.name));
  assert.equal(created.body.total, 2140);

  const block = quotedServicesBlock(lines);
  assert.match(block, new RegExp(`${sprinklerPackage.name} — \\$155\\.00`));
  assert.match(block, /  - Timer — spring — \$30\.00/);
  assert.match(block, /28 visits x \$70\.00/);

  // Half a package reference is a client bug, not a line to save.
  const halfPackage = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [{ serviceId: timer.id, label: "", value: "", packageKey: "orphan" }],
    }),
  });
  assert.equal(halfPackage.status, 400);
  assert.match(halfPackage.body.error, /incomplete package reference/);
});

test("the cover document must exist, and leads the PDF and the email with the customer's details merged in", async () => {
  const bogus = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, coverTemplateId: 999999999, lines: [{ serviceId: mowing.id, label: "", value: "6200" }] }),
  });
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /no longer exists/);

  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      coverTemplateId: coverTemplate.id,
      coverNote: "Great meeting you on Tuesday.",
      lines: [{ serviceId: mowing.id, label: "", value: "6200" }],
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.coverTemplateId, coverTemplate.id);
  assert.equal(created.body.coverTemplateName, coverTemplate.name);

  const fetched = await api(`/estimates/${created.body.id}`, admin.id);
  assert.equal(fetched.body.coverTemplateName, coverTemplate.name);

  // An edit can clear it; leaving it out leaves it alone.
  const untouched = await api(`/estimates/${created.body.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ version: created.body.version, lines: created.body.lines }),
  });
  assert.equal(untouched.status, 200);
  assert.equal(untouched.body.coverTemplateId, coverTemplate.id);
  const cleared = await api(`/estimates/${created.body.id}`, admin.id, {
    method: "PATCH",
    body: JSON.stringify({ version: untouched.body.version, coverTemplateId: null, lines: created.body.lines }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.coverTemplateId, null);

  const [estimate] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, created.body.id));
  const [clientRow] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
  const data = { estimate: { ...estimate, coverTemplateId: coverTemplate.id }, client: clientRow, quotedServices: [] };
  const pdf = await createEstimatePdf(data);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  const html = createEstimateEmailHtml(data, "Great meeting you on Tuesday.", "https://example.com/a", "https://example.com/d");
  assert.match(html, /Dear Estimate,/); // [clientfname] merged
  assert.match(html, /Here is the quote you asked for/);
  assert.match(html, /28 visits x \$70\.00/); // [bison_full_service] and the table both carry the math
  assert.match(html, /Great meeting you on Tuesday\./);
  assert.doesNotMatch(html, /\[clientfname\]/);
});

test("the customer ticks a package as one line, and accepting puts the services on the account with the visits on the board", async () => {
  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [
        { serviceId: mowing.id, label: "", value: "6200" },
        ...packageLines("pk-accept"),
        { label: "Haul-away", value: "", calculatedPrice: 25 },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const estimateId: number = created.body.id;
  const token = await markSent(estimateId);

  const page = await fetch(`${baseUrl}/api/public/estimates/${encodeURIComponent(token)}/respond?action=accept`);
  assert.equal(page.status, 200);
  const html = await page.text();
  const boxes = [...html.matchAll(/<input type="checkbox" name="line" value="([^"]+)" checked>/g)].map((m) => m[1]);
  // One box for the mow, ONE for the whole package, one for the haul-away.
  assert.deepEqual(boxes, ["0", "1,2,3", "4"]);
  assert.match(html, new RegExp(`${sprinklerPackage.name} <em>\\(package\\)</em>`));
  assert.match(html, /28 visits x \$70\.00/);

  const before = await db.select().from(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  assert.equal(before.length, 0);

  const accepted = await respond(token, "action=accept&hadlines=1&line=0&line=1%2C2%2C3&line=4");
  assert.equal(accepted.status, 200);
  assert.match(accepted.text, /Estimate accepted/);

  const [stored] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, estimateId));
  assert.equal(stored.status, "accepted");
  assert.deepEqual(stored.acceptedLines, [0, 1, 2, 3, 4]);
  assert.equal(stored.acceptedTotal, 2140);

  const rows = await db
    .select()
    .from(clientServicesTable)
    .where(eq(clientServicesTable.clientId, client.id))
    .orderBy(clientServicesTable.id);
  assert.equal(rows.length, 4, "one assigned service per accepted service line; the haul-away is not a service");

  const today = todayLocal();
  const tomorrow = addDaysISO(today, 1);
  const [mowRow, springRow, summerRow, blowRow] = rows;
  assert.equal(mowRow.serviceId, mowing.id);
  assert.equal(mowRow.amount, 70); // per visit, not the season total
  assert.equal(mowRow.quantity, 1);
  assert.equal(mowRow.scheduleType, "recurring");
  assert.equal(mowRow.frequency, "weekly");
  assert.equal(mowRow.firstServiceDate, tomorrow); // the dispatch rule's day
  assert.equal(mowRow.seasonEndDate, addDaysISO(tomorrow, 27 * 7));
  assert.equal(mowRow.pricedFromLabel, zonesField.label);
  assert.equal(mowRow.pricedFromValue, 6200);
  assert.equal(mowRow.packageId, null);

  for (const row of [springRow, summerRow, blowRow]) {
    assert.equal(row.packageId, sprinklerPackage.id);
    assert.equal(row.scheduleType, "window"); // from the package
    assert.equal(row.startDate, addDaysISO(today, -30));
    assert.equal(row.endDate, addDaysISO(today, 60));
  }
  assert.equal(springRow.label, "Timer — spring");
  assert.equal(summerRow.label, "Timer — summer");
  assert.equal(blowRow.label, null); // same name as the service, nothing to add
  assert.equal(blowRow.amount, 95);

  // 28 mows on the board under the assigned service: the rule's first visit
  // plus 27 more weekly on the same weekday, each at the per-visit price.
  const mowJobs = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.clientServiceId, mowRow.id))
    .orderBy(jobsTable.scheduledDate);
  assert.equal(mowJobs.length, 28);
  assert.equal(mowJobs[0].scheduledDate, tomorrow);
  assert.equal(mowJobs[0].dispatched, true);
  assert.equal(mowJobs[27].scheduledDate, addDaysISO(tomorrow, 27 * 7));
  assert.ok(mowJobs.every((j) => j.amount === 70));

  // The timer rule holds its visits on the waiting list; the blow-out rule
  // dispatches two days out. Each lands under its own row.
  const springJobs = await db.select().from(jobsTable).where(eq(jobsTable.clientServiceId, springRow.id));
  assert.equal(springJobs.length, 1);
  assert.equal(springJobs[0].dispatched, false);
  assert.ok(springJobs[0].windowStart);
  const blowJobs = await db.select().from(jobsTable).where(eq(jobsTable.clientServiceId, blowRow.id));
  assert.equal(blowJobs.length, 1);
  assert.equal(blowJobs[0].scheduledDate, addDaysISO(today, 2));

  // Nothing floats loose: every job this acceptance created is filed under a row.
  const loose = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(eq(jobsTable.clientId, client.id), inArray(jobsTable.serviceId, [mowing.id, timer.id, blowOut.id])));
  assert.equal(loose.length, 28 + 3);

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, client.id), eq(auditEventsTable.action, "service_assigned")));
  assert.equal(audits.length, 4);
  assert.ok(audits.some((a) => /\$70 a visit x 28 visits/.test(a.description) && /28 visits on the board/.test(a.description)));
  assert.ok(audits.some((a) => /part of a package/.test(a.description) && /on the waiting list/.test(a.description)));

  // Housekeeping for the next tests: the rows above belong to this acceptance.
  await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  await db.delete(jobsTable).where(eq(jobsTable.clientId, client.id));
});

test("a package ticked in part is accepted whole, and an unticked package stays off the account", async () => {
  const whole = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [{ serviceId: mowing.id, label: "", value: "6200" }, ...packageLines("pk-part")] }),
  });
  assert.equal(whole.status, 201);
  const token = await markSent(whole.body.id);
  // A hand-edited form naming one member of the package: the package is
  // accepted whole, the mow is declined.
  const res = await respond(token, "action=accept&hadlines=1&line=2");
  assert.equal(res.status, 200);
  const [stored] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, whole.body.id));
  assert.equal(stored.status, "accepted");
  assert.deepEqual(stored.acceptedLines, [1, 2, 3]);
  assert.equal(stored.acceptedTotal, 155);
  const rows = await db.select().from(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.packageId === sprinklerPackage.id));
  const declined = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, client.id), eq(auditEventsTable.action, "estimate_accepted")));
  assert.ok(declined.some((a) => /Declined: .*Mowing/.test(a.description)));
  await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  await db.delete(jobsTable).where(eq(jobsTable.clientId, client.id));

  const mowOnly = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [{ serviceId: mowing.id, label: "", value: "6200" }, ...packageLines("pk-none")] }),
  });
  const token2 = await markSent(mowOnly.body.id);
  const res2 = await respond(token2, "action=accept&hadlines=1&line=0");
  assert.equal(res2.status, 200);
  const rows2 = await db.select().from(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].serviceId, mowing.id);
  await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  await db.delete(jobsTable).where(eq(jobsTable.clientId, client.id));

  // Unticking everything is not an acceptance; the customer is sent back.
  const nothing = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [{ serviceId: mowing.id, label: "", value: "6200" }] }),
  });
  const token3 = await markSent(nothing.body.id);
  const res3 = await respond(token3, "action=accept&hadlines=1");
  assert.match(res3.text, /keep at least one item ticked/);
  const [stillSent] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, nothing.body.id));
  assert.equal(stillSent.status, "sent");
});

/**
 * What the acceptance writes has to be the season the customer actually
 * bought: last year's package dates, a winter of mowing on a service that
 * closes in October, visits that exist only in the audit line, a talking-point
 * line at no charge, hourly work quoted at one hour's rate and a sub's work
 * turned into a crew assignment were all ways the board came out wrong.
 */

test("a package whose season already closed is sold for the next one, for the visits bought", async () => {
  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [
        {
          serviceId: mowing.id,
          label: "",
          value: "6200",
          visits: 5,
          packageId: seasonPackage.id,
          packageKey: "pk-season",
          packageName: seasonPackage.name,
        },
        {
          serviceId: quietService.id,
          label: "",
          value: "",
          visits: 5,
          packageId: seasonPackage.id,
          packageKey: "pk-season",
          packageName: seasonPackage.name,
        },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const token = await markSent(created.body.id);
  assert.equal((await respond(token, "action=accept&hadlines=1&line=0%2C1")).status, 200);

  const today = todayLocal();
  const tomorrow = addDaysISO(today, 1);
  const rows = await db
    .select()
    .from(clientServicesTable)
    .where(eq(clientServicesTable.clientId, client.id))
    .orderBy(clientServicesTable.id);
  assert.equal(rows.length, 2);
  const [mowRow, quietRow] = rows;

  // The rule put the first mow on the board tomorrow and the four other visits
  // sold follow weekly. Before this, the row kept last season's end date and
  // the whole season the customer paid for generated nothing.
  assert.equal(mowRow.scheduleType, "recurring");
  assert.equal(mowRow.firstServiceDate, tomorrow);
  assert.equal(mowRow.seasonEndDate, addDaysISO(tomorrow, 4 * 7));
  const mowJobs = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.clientServiceId, mowRow.id))
    .orderBy(jobsTable.scheduledDate);
  assert.equal(mowJobs.length, 5, "five visits sold, five visits on the board");
  assert.ok(mowJobs.every((j) => (j.scheduledDate ?? "") >= tomorrow));

  // Nothing scheduled the other line, so its planned dates show the roll on
  // its own: the package window a year on, capped at the five visits bought.
  const rolledStart = rollDateOneYear(addDaysISO(today, -150))!;
  assert.equal(quietRow.firstServiceDate, rolledStart);
  assert.equal(quietRow.seasonEndDate, addDaysISO(rolledStart, 4 * 7));
  assert.ok((quietRow.seasonEndDate ?? "") > today, "a season already closed puts nothing on the board");

  await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  await db.delete(jobsTable).where(eq(jobsTable.clientId, client.id));
});

test("visits sold stay inside the service's own season, so nothing is mowed in December", async () => {
  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [
        { serviceId: seasonMowing.id, label: "", value: "" },
        { serviceId: quietService.id, label: "", value: "", visits: 5 },
      ],
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.lines[0].visits, 28); // the service's visits per season
  const token = await markSent(created.body.id);
  assert.equal((await respond(token, "action=accept&hadlines=1&line=0&line=1")).status, 200);

  const today = todayLocal();
  const tomorrow = addDaysISO(today, 1);
  const seasonEnd = addDaysISO(today, 20);
  const rows = await db
    .select()
    .from(clientServicesTable)
    .where(eq(clientServicesTable.clientId, client.id))
    .orderBy(clientServicesTable.id);
  assert.equal(rows.length, 2);
  const [mowRow, quietRow] = rows;

  assert.equal(mowRow.scheduleType, "recurring");
  assert.equal(mowRow.frequency, "weekly");
  assert.equal(mowRow.firstServiceDate, tomorrow);
  assert.equal(mowRow.seasonEndDate, seasonEnd, "28 weeks from tomorrow runs months past the service's season");
  const mowJobs = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.clientServiceId, mowRow.id))
    .orderBy(jobsTable.scheduledDate);
  assert.equal(mowJobs.length, 3, "only the visits that fit before the season closes");
  assert.ok(mowJobs.every((j) => (j.scheduledDate ?? "") <= seasonEnd));

  // A service whose season already closed is sold for the next one.
  const rolledStart = rollDateOneYear(addDaysISO(today, -150))!;
  assert.equal(quietRow.firstServiceDate, rolledStart);
  assert.equal(quietRow.seasonEndDate, addDaysISO(rolledStart, 4 * 7));

  await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  await db.delete(jobsTable).where(eq(jobsTable.clientId, client.id));
});

test("several visits sold in one window are several entries on the waiting list", async () => {
  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [
        {
          serviceId: timer.id,
          label: "",
          value: "",
          visits: 3,
          packageId: sprinklerPackage.id,
          packageKey: "pk-window",
          packageName: sprinklerPackage.name,
        },
      ],
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.total, 90); // $30 a visit x 3
  const token = await markSent(created.body.id);
  assert.equal((await respond(token, "action=accept&hadlines=1&line=0")).status, 200);

  const [row] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  assert.equal(row.scheduleType, "window");
  assert.equal(row.amount, 30);
  const jobs = await db.select().from(jobsTable).where(eq(jobsTable.clientServiceId, row.id));
  assert.equal(jobs.length, 3, "three visits bought, three on the list — one would invoice $30 of the $90");
  assert.ok(jobs.every((j) => j.dispatched === false && j.amount === 30));

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, client.id), eq(auditEventsTable.action, "service_assigned")));
  assert.ok(audits.some((a) => /3 visits on the waiting list/.test(a.description)));

  await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  await db.delete(jobsTable).where(eq(jobsTable.clientId, client.id));
});

test("a 0-visit talking point is not put on the account or the board when the estimate is accepted", async () => {
  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [{ serviceId: mowing.id, label: "For reference only", value: "6200", visits: 0 }],
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.lines[0].calculatedPrice, 0);
  assert.equal(created.body.total, 0);
  const token = await markSent(created.body.id);

  // Nothing on a $0 quote is selectable, so the form carries no checkboxes and
  // the acceptance means "all of it" — which used to include this line.
  const page = await fetch(`${baseUrl}/api/public/estimates/${encodeURIComponent(token)}/respond?action=accept`);
  const html = await page.text();
  assert.doesNotMatch(html, /name="line"/);
  assert.equal((await respond(token, "action=accept")).status, 200);

  const [stored] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, created.body.id));
  assert.equal(stored.status, "accepted");
  assert.equal(stored.acceptedLines, null);
  assert.equal(stored.acceptedTotal, 0);
  const rows = await db.select().from(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  assert.equal(rows.length, 0, "nothing was bought, so nothing goes on the account at $70 a visit");
  const jobs = await db.select().from(jobsTable).where(eq(jobsTable.clientId, client.id));
  assert.equal(jobs.length, 0);
});

test("work billed by the hour is quoted at its budgeted hours, and its first visit is priced like the rest", async () => {
  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({ clientId: client.id, lines: [{ serviceId: hourlyService.id, label: "", value: "" }] }),
  });
  assert.equal(created.status, 201);
  const [line] = created.body.lines;
  assert.equal(line.hours, 3);
  assert.equal(line.unitPrice, 195, "three budgeted hours at $65, not the bare hourly rate");
  assert.equal(line.visits, 1);
  assert.equal(line.calculatedPrice, 195);
  assert.equal(created.body.total, 195);
  assert.equal(lineMathLabel(line), "$195.00 (3 hr @ $65.00/hr)");
  assert.match(quotedServicesBlock(created.body.lines), /3 hr @ \$65\.00\/hr/);

  const token = await markSent(created.body.id);
  assert.equal((await respond(token, "action=accept&hadlines=1&line=0")).status, 200);

  const [row] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  assert.equal(row.amount, 65); // the hourly rate; the clock sets the rest
  assert.equal(row.budgetedHours, 3);
  const jobs = await db.select().from(jobsTable).where(eq(jobsTable.clientServiceId, row.id));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].amount, 195, "the figure the customer accepted, and what every other visit is worth");
  assert.equal(jobs[0].hourlyRate, 65);
  assert.equal(jobs[0].billingMode, "time");

  await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  await db.delete(jobsTable).where(eq(jobsTable.clientId, client.id));
});

test("an outside company's work never becomes a weekly crew assignment", async () => {
  const created = await api("/estimates", admin.id, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      lines: [{ serviceId: vendorService.id, label: "", value: "", visits: 5 }],
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.total, 375);
  const token = await markSent(created.body.id);
  assert.equal((await respond(token, "action=accept&hadlines=1&line=0")).status, 200);

  const [row] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  assert.equal(row.scheduleType, "one_time");
  assert.equal(row.frequency, null);
  assert.equal(row.firstServiceDate, null, "a weekly row here would put phantom stops on the board");
  const jobs = await db.select().from(jobsTable).where(eq(jobsTable.clientId, client.id));
  assert.equal(jobs.length, 0, "the sub's visits are completed from their own invoice");

  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.clientId, client.id), eq(auditEventsTable.action, "service_assigned")));
  assert.ok(audits.some((a) => /Acme Spray does this work/.test(a.description)));

  await db.delete(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  await db.delete(jobsTable).where(eq(jobsTable.clientId, client.id));
});
