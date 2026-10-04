import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  servicesTable,
  clientServicesTable,
  estimatesTable,
  ticketsTable,
  ticketCategoriesTable,
  estimateFieldsTable,
  auditEventsTable,
  jobsTable,
} from "@workspace/db";
import { eq, inArray, like } from "drizzle-orm";

/**
 * The Settings half of his 2026-09-28 notes, end to end through the HTTP
 * routes the way integration.test.ts does it:
 *
 *   G1  his ticket category list, a category on a ticket, filterable, editable
 *   G2  "Add Customer Field Effects all Clients"
 *   G3  his parts list, seeded with his own examples, reachable on the phone
 *   G4  "Signed estimates to send to management companies"
 *   G5  spring letters: one customer's own price, and a percent raise on the
 *       customers he ticked
 *   E5  underline in typed text
 *
 * Nothing here touches a real customer: every row it reads is one it made, and
 * the two seeded lists are only ever read, never emptied.
 */
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");
const { TICKET_CATEGORY_SEEDS, PRODUCT_PRESET_SEEDS } = await import("../src/lib/settingsSeeds.ts");
const { acceptanceRecord } = await import("../src/lib/estimateAcceptanceRecord.ts");
const { textRuns, inlineHtml, stripMarkers, hasFormatting } = await import("../src/lib/richText.ts");

let server: Server;
let baseUrl: string;

const stamp = Date.now();
const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
  tickets: [] as number[],
  categories: [] as number[],
  fields: [] as number[],
  jobs: [] as number[],
};

let admin: { id: number; name: string };
let crew: { id: number };
let client: { id: number; name: string };
let service: { id: number; name: string };
let clientServiceId: number;
let estimateId: number;

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

const get = (path: string) => api(path, admin.id);
const post = (path: string, data: unknown) => api(path, admin.id, { method: "POST", body: JSON.stringify(data) });
const patch = (path: string, data: unknown) => api(path, admin.id, { method: "PATCH", body: JSON.stringify(data) });
const del = (path: string) => api(path, admin.id, { method: "DELETE" });

/** Remember a category this test made so `after` takes it away again. */
async function addCategory(name: string) {
  const created = await post("/ticket-categories", { name });
  if (created.status === 201) ids.categories.push(created.body.id);
  return created;
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a, c] = await db
    .insert(usersTable)
    .values([
      { clerkId: `test_set_admin_${stamp}`, name: "Settings Admin", role: "admin", roleSource: "owner_assigned", accessLevel: "full" },
      { clerkId: `test_set_crew_${stamp}`, name: "Settings Crew", role: "contractor", roleSource: "provisioned", accessLevel: "mobile" },
    ])
    .returning();
  admin = a;
  crew = c;
  ids.users.push(a.id, c.id);

  const [cl] = await db
    .insert(clientsTable)
    .values({
      name: `ZZ Settings Test ${stamp}`,
      status: "client",
      serviceAddress: "1 Settings Way",
      email: "koby@radiantaisoftware.com",
      propertyData: { [`Gate code ${stamp}`]: "4321" },
    })
    .returning();
  client = cl;
  ids.clients.push(cl.id);

  const [svc] = await db
    .insert(servicesTable)
    .values({ name: `ZZ Settings Mowing ${stamp}`, rate: 50, quantity: 1 })
    .returning();
  service = svc;
  ids.services.push(svc.id);

  const [cs] = await db
    .insert(clientServicesTable)
    .values({ clientId: cl.id, serviceId: svc.id, quantity: 1, amount: 50, scheduleType: "recurring" })
    .returning();
  clientServiceId = cs.id;

  const [est] = await db
    .insert(estimatesTable)
    .values({
      clientId: cl.id,
      status: "draft",
      total: 300,
      lines: [
        { serviceId: svc.id, label: "Spring clean up", value: "", unitPrice: 200, calculatedPrice: 200 },
        { serviceId: svc.id, label: "Bark install", value: "", unitPrice: 100, calculatedPrice: 100 },
      ] as any,
    })
    .returning();
  estimateId = est.id;
});

after(async () => {
  if (ids.jobs.length) await db.delete(jobsTable).where(inArray(jobsTable.id, ids.jobs));
  if (ids.tickets.length) await db.delete(ticketsTable).where(inArray(ticketsTable.id, ids.tickets));
  if (ids.categories.length) await db.delete(ticketCategoriesTable).where(inArray(ticketCategoriesTable.id, ids.categories));
  if (ids.fields.length) await db.delete(estimateFieldsTable).where(inArray(estimateFieldsTable.id, ids.fields));
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  // The audit lines this test wrote, so his real trail is not left with test
  // rows in it.
  await db.delete(auditEventsTable).where(like(auditEventsTable.description, `%${stamp}%`));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---- G1: his ticket categories ----

test("his own list is there the first time the screen is opened, in his order", async () => {
  const list = await get("/ticket-categories");
  assert.equal(list.status, 200);
  const names: string[] = list.body.map((row: any) => row.name);
  for (const seed of TICKET_CATEGORY_SEEDS) {
    assert.ok(names.includes(seed), `"${seed}" is missing from his list`);
  }
  // Not alphabetised: he typed them in the order he thinks about them, and the
  // screen has to keep that order.
  const positions = TICKET_CATEGORY_SEEDS.map((seed) => names.indexOf(seed));
  assert.deepEqual(positions, [...positions].sort((x, y) => x - y), "his order was not kept");

  // Seeding is once ever, not "whenever the table looks empty": a second read
  // must not put anything back.
  const again = await get("/ticket-categories");
  assert.equal(again.body.length, list.body.length);
});

test("a category can be added, and the same name twice is refused", async () => {
  const created = await addCategory(`Backflow test ${stamp}`);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.ticketCount, 0);
  assert.equal(created.body.active, true);

  const dupe = await post("/ticket-categories", { name: `  backflow test ${stamp}  ` });
  assert.equal(dupe.status, 409, "a category he already has must not be added twice under a different case");
  assert.match(dupe.body.error, /already on the list/i);

  const blank = await post("/ticket-categories", { name: "   " });
  assert.equal(blank.status, 400);
});

test("a ticket carries a category, and the board can pull up just that category", async () => {
  const filed = await post("/tickets", { title: `ZZ Billing question ${stamp}`, category: "Billing" });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  ids.tickets.push(filed.body.id);
  assert.equal(filed.body.category, "Billing");

  // The empty string is what the picker posts when nothing is chosen. Stored
  // as the empty string it would show up under neither filter.
  const unfiled = await post("/tickets", { title: `ZZ Unfiled ${stamp}`, category: "" });
  assert.equal(unfiled.status, 201);
  ids.tickets.push(unfiled.body.id);
  assert.equal(unfiled.body.category, null, "no category has to be one value, not two");

  const billing = await get("/tickets?category=Billing");
  assert.equal(billing.status, 200);
  const billingIds = billing.body.map((t: any) => t.id);
  assert.ok(billingIds.includes(filed.body.id));
  assert.ok(!billingIds.includes(unfiled.body.id));

  const none = await get("/tickets?category=none");
  const noneIds = none.body.map((t: any) => t.id);
  assert.ok(noneIds.includes(unfiled.body.id), "the ones nobody has filed yet have to be findable");
  assert.ok(!noneIds.includes(filed.body.id));

  // And the count beside the category on the Settings screen is counted from
  // the tickets, so it cannot go stale.
  const list = await get("/ticket-categories");
  const billingRow = list.body.find((row: any) => row.name === "Billing");
  assert.ok(billingRow.ticketCount >= 1, "the Settings list has to say how many tickets are filed under it");
});

test("renaming a category takes its tickets with it; deleting one leaves them alone", async () => {
  const name = `Winter work ${stamp}`;
  const created = await addCategory(name);
  const ticket = await post("/tickets", { title: `ZZ Winter ${stamp}`, category: name });
  ids.tickets.push(ticket.body.id);

  const renamed = `Snow work ${stamp}`;
  const saved = await patch(`/ticket-categories/${created.body.id}`, { name: renamed });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.name, renamed);
  assert.equal(saved.body.ticketCount, 1, "the ticket has to have come across onto the new name");

  const underOld = await get(`/tickets?category=${encodeURIComponent(name)}`);
  assert.equal(underOld.body.length, 0, "nothing may be left behind under the old spelling");
  const underNew = await get(`/tickets?category=${encodeURIComponent(renamed)}`);
  assert.deepEqual(underNew.body.map((t: any) => t.id), [ticket.body.id]);

  // Off, not gone: the picker stops offering it, the Settings screen still
  // shows it so he can turn it back on, and the ticket keeps its name.
  const off = await patch(`/ticket-categories/${created.body.id}`, { active: false });
  assert.equal(off.status, 200);
  const offered = await get("/ticket-categories");
  assert.ok(!offered.body.some((row: any) => row.id === created.body.id), "a category he turned off must not be offered");
  const settings = await get("/ticket-categories?includeInactive=true");
  assert.ok(settings.body.some((row: any) => row.id === created.body.id), "but Settings has to still show it");

  const gone = await del(`/ticket-categories/${created.body.id}`);
  assert.equal(gone.status, 204);
  ids.categories = ids.categories.filter((id) => id !== created.body.id);
  const [stillFiled] = await db.select().from(ticketsTable).where(eq(ticketsTable.id, ticket.body.id));
  assert.equal(stillFiled.category, renamed, "a deleted category must not blank what the ticket was about");
  const stillFindable = await get(`/tickets?category=${encodeURIComponent(renamed)}`);
  assert.deepEqual(stillFindable.body.map((t: any) => t.id), [ticket.body.id]);
});

test("the crew can read the category list but cannot change it", async () => {
  const read = await api("/ticket-categories", crew.id);
  assert.equal(read.status, 200, "the picker on a ticket needs the list, whoever is looking at it");

  const write = await api("/ticket-categories", crew.id, {
    method: "POST",
    body: JSON.stringify({ name: `Crew made this ${stamp}` }),
  });
  assert.equal(write.status, 403, "changing his list is his");
});

// ---- G2: a customer field that reaches every customer ----

test("a field added in Settings shows on every customer, and the one-off labels are named", async () => {
  const label = `Dog name ${stamp}`;
  const created = await post("/customer-fields", { label, fieldType: "text" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  ids.fields.push(created.body.id);

  // Every customer: these are the rows the account page, the estimate builder
  // and the matrix all render, so being on this list IS showing on all 709.
  const onEveryCustomer = await get("/estimate-fields");
  assert.ok(
    onEveryCustomer.body.some((field: any) => field.label === label),
    "the field has to be on the list every customer renders",
  );

  const list = await get("/customer-fields");
  assert.equal(list.status, 200);
  assert.ok(list.body.clientCount > 0);
  assert.ok(list.body.managed.some((field: any) => field.label === label));
  // The gate code typed on one customer's card is the thing he hit: it exists,
  // but only there. The screen has to say so rather than pretend it is global.
  const oneOff = list.body.unmanaged.find((entry: any) => entry.label === `Gate code ${stamp}`);
  assert.ok(oneOff, "a label living on one customer only has to be shown as such");
  assert.equal(oneOff.filled, 1);

  const dupe = await post("/customer-fields", { label: label.toUpperCase() });
  assert.equal(dupe.status, 409);
});

test("adopting a one-off label keeps what is already saved against it", async () => {
  const label = `Gate code ${stamp}`;
  const adopted = await post("/customer-fields", { label });
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  ids.fields.push(adopted.body.id);
  assert.equal(adopted.body.filledCount, 1, "the customer who already had a gate code must not be stranded");

  const [row] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
  assert.equal((row.propertyData as Record<string, string>)[label], "4321");

  const list = await get("/customer-fields");
  assert.ok(!list.body.unmanaged.some((entry: any) => entry.label === label), "it is on the list now");
});

test("renaming a field carries every customer's saved value across, and deleting it keeps them", async () => {
  const label = `Dog name ${stamp}`;
  const field = (await get("/customer-fields")).body.managed.find((f: any) => f.label === label);
  assert.ok(field, "the field from the earlier test");

  await db
    .update(clientsTable)
    .set({ propertyData: { [`Gate code ${stamp}`]: "4321", [label]: "Beagle" } })
    .where(eq(clientsTable.id, client.id));

  const renamed = `Dog ${stamp}`;
  const saved = await patch(`/customer-fields/${field.id}`, { label: renamed });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.movedValues, 1);

  // The label IS the key in property_data: without the carry across, a rename
  // would blank the value on every customer who had one.
  const [row] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
  const data = row.propertyData as Record<string, string>;
  assert.equal(data[renamed], "Beagle");
  assert.ok(!(label in data), "the old key has to be gone, not duplicated");

  const gone = await del(`/customer-fields/${field.id}`);
  assert.equal(gone.status, 204);
  ids.fields = ids.fields.filter((id) => id !== field.id);
  const [after] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
  assert.equal(
    (after.propertyData as Record<string, string>)[renamed],
    "Beagle",
    "taking a field off the list is 'stop asking everybody', not 'throw away what we know'",
  );
  // And it goes back to being shown as a one-off label, which is the truth.
  const list = await get("/customer-fields");
  assert.ok(list.body.unmanaged.some((entry: any) => entry.label === renamed));
});

// ---- G3: his parts list ----

test("his own examples are on the parts list, and on the list the crew can add from", async () => {
  const office = await get("/product-presets");
  assert.equal(office.status, 200);
  const labels: string[] = office.body.map((row: any) => row.label);
  for (const seed of PRODUCT_PRESET_SEEDS) {
    assert.ok(labels.includes(seed.label), `"${seed.label}" is missing from his parts list`);
  }
  // At $0 on purpose: a guessed price rides onto a customer's invoice, a zero
  // is obvious on the screen.
  const bags = office.body.find((row: any) => row.label === "Small bags");
  assert.equal(bags.defaultPrice, 0);
  assert.equal(bags.unit, "bag");
  assert.equal(bags.contractorCanAdd, true, "the crew is who adds these on site");

  // The whole point is the crew adding one on site, so it has to be on the
  // phone's list too, not only the office screen.
  const onSite = await api("/my/products", crew.id);
  assert.equal(onSite.status, 200);
  const crewLabels: string[] = onSite.body.map((row: any) => row.label);
  for (const seed of PRODUCT_PRESET_SEEDS) {
    assert.ok(crewLabels.includes(seed.label), `the crew cannot add "${seed.label}" on site`);
  }
});

// ---- G4: a signed estimate for a management company ----

test("an accepted estimate carries who accepted it and when, and the PDF still renders", async () => {
  const token = `settings-test-${estimateId}-${Math.random().toString(36).slice(2)}`;
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

  // Only the first line ticked, from the customer's own emailed link.
  const responded = await fetch(`${baseUrl}/api/public/estimates/${encodeURIComponent(token)}/respond`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "action=accept&hadlines=1&line=0",
  });
  assert.equal(responded.status, 200);

  const [accepted] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, estimateId));
  assert.equal(accepted.status, "accepted");

  const record = acceptanceRecord(accepted, client);
  assert.ok(record, "an accepted estimate has to produce something to forward");
  const labelled = Object.fromEntries(record.rows.map((row) => [row.label, row.value]));
  assert.equal(labelled["Accepted by"], client.name);
  assert.equal(labelled["From the link emailed to"], "koby@radiantaisoftware.com");
  assert.match(labelled["Accepted on"], /\d{4} at /, "the management company is reading this for the date");
  // Only $200 of the $300 was ticked, and the document must not read as if the
  // whole quote was bought.
  assert.match(labelled["Amount approved"], /\$200\.00 of \$300\.00/);
  assert.deepEqual(record.declined, ["Bark install"]);
  assert.match(record.attestation, /approved online from the private link/i);
  // It is not a wet signature and may never say it is.
  assert.ok(!/signature|signed by/i.test(record.attestation), "it must not claim a signature it does not have");

  const pdf = await fetch(`${baseUrl}/api/estimates/${estimateId}/pdf`, {
    headers: { "x-test-user-id": String(admin.id), "x-test-auth-token": TEST_AUTH_TOKEN },
  });
  assert.equal(pdf.status, 200);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF", "the acceptance block must not break the document");
  assert.ok(bytes.length > 1000);
});

test("nothing is attested for a quote that has not been accepted", async () => {
  const [draft] = await db
    .insert(estimatesTable)
    .values({ clientId: client.id, status: "draft", total: 100, lines: [] as any })
    .returning();
  assert.equal(acceptanceRecord(draft, client), null);
  assert.equal(acceptanceRecord({ ...draft, status: "declined", respondedAt: new Date() }, client), null,
    "a decline is not an approval, so there is nothing to put on a document");
  await db.delete(estimatesTable).where(eq(estimatesTable.id, draft.id));
});

// ---- G5: spring letter prices ----

test("one customer's own price can be typed, and dropped back to the standard rate", async () => {
  const set = await post("/spring-letters/prices", { prices: [{ clientServiceId, amount: 72.5 }] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.saved, 1);
  assert.deepEqual(set.body.changes.map((c: any) => [c.from, c.to]), [[50, 72.5]]);

  const rows = await get("/spring-letters/clients");
  const mine = rows.body.find((row: any) => row.clientId === client.id);
  assert.ok(mine, "the customer has to be on the spring letter screen");
  const line = mine.services.find((s: any) => s.clientServiceId === clientServiceId);
  assert.equal(line.customAmount, 72.5, "the screen has to show it is his own price");
  assert.equal(line.catalogAmount, 50, "and what it would be on the standard rate");
  assert.equal(line.newAmount, 72.5, "the letter quotes his figure");

  // The standard rate was not touched, which is the whole difference between
  // this and the bar above it.
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, service.id));
  assert.equal(svc.rate, 50, "typing one customer's price must not move everybody");

  const cleared = await post("/spring-letters/prices", { prices: [{ clientServiceId, amount: null }] });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, 1);
  const back = await get("/spring-letters/clients");
  const afterLine = back.body
    .find((row: any) => row.clientId === client.id)
    .services.find((s: any) => s.clientServiceId === clientServiceId);
  assert.equal(afterLine.customAmount, null);
  assert.equal(afterLine.newAmount, 50);

  const negative = await post("/spring-letters/prices", { prices: [{ clientServiceId, amount: -5 }] });
  assert.equal(negative.status, 400);
  const missing = await post("/spring-letters/prices", { prices: [{ clientServiceId: 0, amount: 10 }] });
  assert.equal(missing.status, 404);
});

test("a percent raise previews before it saves, and only reaches the customers he ticked", async () => {
  const body = { clientIds: [client.id], mode: "percent", amount: 10, roundTo: null, apply: false };
  // A raise aimed at a customer means every service on that customer — that is
  // what "select all" buys him. Accepting the estimate above put a second
  // service on this account, so the row under test is picked out by id.
  const mine = (result: any) => result.body.changes.filter((c: any) => c.clientServiceId === clientServiceId);

  const preview = await post("/spring-letters/price-plan", body);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.applied, false);
  assert.ok(preview.body.changes.length > 1, "every service on the ticked customer is in the plan");
  assert.deepEqual(mine(preview).map((c: any) => [c.from, c.to]), [[50, 55]]);

  // Preview only: nothing may have been written yet.
  const [untouched] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, clientServiceId));
  assert.equal(untouched.customAmount, null, "a preview that saves is a preview he cannot trust");

  const applied = await post("/spring-letters/price-plan", { ...body, apply: true });
  assert.equal(applied.body.applied, true);
  const [saved] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, clientServiceId));
  assert.equal(saved.customAmount, 55);

  // Rounding to the nearest $5, which is how he actually prices: 55 + 6% is
  // 58.30, and he wants to send 60.
  const rounded = await post("/spring-letters/price-plan", { ...body, amount: 6, roundTo: 5, apply: false });
  assert.deepEqual(mine(rounded).map((c: any) => c.to), [60]);

  // A typo that would print a credit note is clamped, not sent.
  const silly = await post("/spring-letters/price-plan", { ...body, mode: "percent", amount: -500, apply: false });
  assert.deepEqual(mine(silly).map((c: any) => c.to), [0]);
  const negativeSet = await post("/spring-letters/price-plan", { ...body, mode: "set", amount: -10, apply: false });
  assert.equal(negativeSet.status, 400);
  const nobody = await post("/spring-letters/price-plan", { ...body, clientIds: [] });
  assert.equal(nobody.status, 400, "a raise aimed at nobody is a mis-click, not an instruction");
  const badRounding = await post("/spring-letters/price-plan", { ...body, roundTo: -5 });
  assert.equal(badRounding.status, 400);

  // Set, so the whole selection goes out at one price.
  const flat = await post("/spring-letters/price-plan", { ...body, mode: "set", amount: 65, apply: true });
  assert.equal(flat.body.applied, true);
  const [flatRow] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, clientServiceId));
  assert.equal(flatRow.customAmount, 65);

  // Audited by name, because it is money he has to be able to explain in six
  // months without remembering.
  const trail = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, "spring_letter_price_set"));
  assert.ok(
    trail.some((row) => row.entityId === clientServiceId),
    "a price change has to land in the audit trail",
  );
});

// ---- E5: underline ----

test("underline is __two underscores__, and it does not eat his merge tokens", () => {
  assert.deepEqual(textRuns("please read __this part__ twice"), [
    { text: "please read ", bold: false, italic: false, underline: false },
    { text: "this part", bold: false, italic: false, underline: true },
    { text: " twice", bold: false, italic: false, underline: false },
  ]);
  assert.equal(inlineHtml("__Important__"), "<u>Important</u>");
  assert.equal(
    inlineHtml("**Bold**, __underlined__ and *slanted*"),
    "<strong>Bold</strong>, <u>underlined</u> and <em>slanted</em>",
  );

  // Two underscores, not one, precisely so a token keeps its underscores.
  assert.equal(inlineHtml("[bison_full_service] renews"), "[bison_full_service] renews");
  assert.deepEqual(textRuns("[bison_full_service]"), [
    { text: "[bison_full_service]", bold: false, italic: false, underline: false },
  ]);

  // A reader on the plain-text half of the email sees words, not markers.
  assert.equal(stripMarkers("__Read this__ and **this**"), "Read this and this");
  assert.equal(hasFormatting("plain words"), false);
  assert.equal(hasFormatting("an __underlined__ line"), true);
});

// ---- the acceptance block has to say what the customer actually ticked ----

/** An accepted estimate, shaped the way the public response route leaves one. */
const acceptedEstimate = (over: Record<string, unknown>) =>
  ({
    id: 9001,
    status: "accepted",
    respondedAt: new Date("2026-04-20T01:30:00Z"),
    sentToEmail: "koby@radiantaisoftware.com",
    sentAt: new Date("2026-04-18T17:00:00Z"),
    total: 300,
    acceptedTotal: 300,
    acceptedLines: [0, 1],
    lines: [],
    ...over,
  }) as any;

const rowsOf = (record: { rows: { label: string; value: string }[] }) =>
  Object.fromEntries(record.rows.map((row) => [row.label, row.value]));

test("a quote accepted in full says so, whatever property details are on it", () => {
  // What his estimate builder really produces: two priced lines plus the
  // property details, which carry no price (Gate Code is a text field, so its
  // line price is null) and never got a checkbox on the response page. Counting
  // those as declined printed "Not accepted: Turf Sqft, Gate Code" and "2 of 4
  // items" on a quote the customer bought whole.
  const lines = [
    { label: "Spring clean up", value: "", unitPrice: 200, calculatedPrice: 200 },
    { label: "Bark install", value: "", unitPrice: 100, calculatedPrice: 100 },
    { label: "Turf Sqft", value: "6200", calculatedPrice: 0 },
    { label: "Gate Code", value: "4321", calculatedPrice: null },
  ];
  const whole = acceptanceRecord(acceptedEstimate({ lines }), client);
  assert.ok(whole);
  assert.deepEqual(whole.declined, [], "nothing was declined, so nothing may be named as declined");
  assert.equal(rowsOf(whole)["Amount approved"], "$300.00", "a full acceptance must not read as part of itself");

  // And a real partial acceptance still reads as one, counted over the lines
  // the customer was actually offered.
  const part = acceptanceRecord(acceptedEstimate({ lines, acceptedLines: [0], acceptedTotal: 200 }), client);
  assert.ok(part);
  assert.deepEqual(part.declined, ["Bark install"]);
  assert.equal(rowsOf(part)["Amount approved"], "$200.00 of $300.00 quoted (1 of 2 items)");
});

test("the same package added twice is two choices, counted one by one", () => {
  const lines = [
    { label: "Turn-on", value: "", calculatedPrice: 160, packageKey: "pk-1", packageName: "Sprinkler Package" },
    { label: "Blow-out", value: "", calculatedPrice: 160, packageKey: "pk-2", packageName: "Sprinkler Package" },
  ];
  const one = acceptanceRecord(acceptedEstimate({ total: 320, acceptedTotal: 160, acceptedLines: [0], lines }), client);
  assert.ok(one);
  // Grouped by the package's own key, not its name: merged by name this read
  // "0 of 1 items" on an estimate where he sold one of the two.
  assert.deepEqual(one.declined, ["Sprinkler Package"]);
  assert.equal(rowsOf(one)["Amount approved"], "$160.00 of $320.00 quoted (1 of 2 items)");

  const both = acceptanceRecord(
    acceptedEstimate({ total: 320, acceptedTotal: 320, acceptedLines: [0, 1], lines }),
    client,
  );
  assert.ok(both);
  assert.deepEqual(both.declined, []);
  assert.equal(rowsOf(both)["Amount approved"], "$320.00");
});

test("the acceptance is dated on his day, not the server's clock", () => {
  const was = process.env.APP_TIME_ZONE;
  const lines = [{ label: "Spring clean up", value: "", calculatedPrice: 300 }];
  try {
    // 6:30 PM on the Sunday in Post Falls. The deployed container runs on UTC,
    // where the same instant is 1:30 AM on the Monday — the wrong day and the
    // wrong weekday on the one document whose job is proving when they agreed.
    process.env.APP_TIME_ZONE = "America/Los_Angeles";
    const pacific = acceptanceRecord(acceptedEstimate({ lines, acceptedLines: [0] }), client);
    assert.ok(pacific);
    assert.equal(pacific.stamp, "ACCEPTED 4/19/2026");
    assert.equal(rowsOf(pacific)["Accepted on"], "Sunday, April 19, 2026 at 6:30 PM");
    assert.match(pacific.attestation, /sent 4\/18\/2026/);

    // Proof it is the office's zone doing the work and not the machine this
    // happens to run on: name a different zone and the date moves with it.
    process.env.APP_TIME_ZONE = "UTC";
    const utc = acceptanceRecord(acceptedEstimate({ lines, acceptedLines: [0] }), client);
    assert.ok(utc);
    assert.equal(utc.stamp, "ACCEPTED 4/20/2026");
    assert.equal(rowsOf(utc)["Accepted on"], "Monday, April 20, 2026 at 1:30 AM");
  } finally {
    if (was === undefined) delete process.env.APP_TIME_ZONE;
    else process.env.APP_TIME_ZONE = was;
  }
});

// ---- the typed price has to be the price that gets billed ----

test("a price he types on the spring letter reaches the jobs and the bills", async () => {
  await db
    .update(clientServicesTable)
    .set({ amount: 50, customAmount: null, pricedFromLabel: "Turf Sqft", pricedFromValue: 6200 })
    .where(eq(clientServicesTable.id, clientServiceId));
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [visit] = await db
    .insert(jobsTable)
    .values({ clientId: client.id, serviceId: service.id, clientServiceId, amount: 50, scheduledDate: soon })
    .returning();
  const [byHand] = await db
    .insert(jobsTable)
    .values({
      clientId: client.id,
      serviceId: service.id,
      clientServiceId,
      amount: 99,
      amountOverridden: true,
      scheduledDate: soon,
    })
    .returning();
  ids.jobs.push(visit.id, byHand.id);

  const typed = await post("/spring-letters/prices", { prices: [{ clientServiceId, amount: 72.5 }] });
  assert.equal(typed.status, 200, JSON.stringify(typed.body));

  const [row] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, clientServiceId));
  assert.equal(row.customAmount, 72.5);
  // The letter reads customAmount; every job and invoice reads amount. Writing
  // only the first meant the letter quoted $72.50 and the bill said $50.
  assert.equal(row.amount, 72.5, "the figure the jobs and the invoices copy has to be the figure he quoted");
  assert.equal(row.pricedFromLabel, null, "a price agreed with one customer is not read off the matrix any more");

  const [repriced] = await db.select().from(jobsTable).where(eq(jobsTable.id, visit.id));
  assert.equal(repriced.amount, 72.5, "a visit already on the board would otherwise bill the old price");
  const [untouched] = await db.select().from(jobsTable).where(eq(jobsTable.id, byHand.id));
  assert.equal(untouched.amount, 99, "a price typed on the visit itself was deliberate and stays");

  const cleared = await post("/spring-letters/prices", { prices: [{ clientServiceId, amount: null }] });
  assert.equal(cleared.status, 200);
  const [back] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, clientServiceId));
  assert.equal(back.customAmount, null);
  assert.equal(back.amount, 50, "dropping it back to the standard rate has to move the money back too");
  const [backOnBoard] = await db.select().from(jobsTable).where(eq(jobsTable.id, visit.id));
  assert.equal(backOnBoard.amount, 50);

  // The bar aimed at the customers he ticked does the same.
  const plan = await post("/spring-letters/price-plan", {
    clientIds: [client.id],
    mode: "set",
    amount: 80,
    roundTo: null,
    apply: true,
  });
  assert.equal(plan.body.applied, true, JSON.stringify(plan.body));
  const [planned] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, clientServiceId));
  assert.equal(planned.customAmount, 80);
  assert.equal(planned.amount, 80);
  const [plannedVisit] = await db.select().from(jobsTable).where(eq(jobsTable.id, visit.id));
  assert.equal(plannedVisit.amount, 80);
});

// ---- a field a service prices from is not his to break by accident ----

test("a field a service prices from cannot be deleted or retyped out from under it", async () => {
  const label = `ZZ Sprinkler zones ${stamp}`;
  const created = await post("/customer-fields", { label, fieldType: "calculable" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  ids.fields.push(created.body.id);
  await db.update(servicesTable).set({ pricingFieldId: created.body.id }).where(eq(servicesTable.id, service.id));

  // Deleting it sets the service's pricing field to null, and null does not
  // mean "unknown" — it means turf square footage, so a blow-out priced per
  // zone would quietly price per square foot on every job and invoice after.
  const refusedDelete = await del(`/customer-fields/${created.body.id}`);
  assert.equal(refusedDelete.status, 409, JSON.stringify(refusedDelete.body));
  assert.ok(
    refusedDelete.body.error.includes(service.name),
    "the refusal has to name the service he would be repricing",
  );
  const [stillOnTheList] = await db
    .select()
    .from(estimateFieldsTable)
    .where(eq(estimateFieldsTable.id, created.body.id));
  assert.ok(stillOnTheList, "nothing may come off the list while a service prices from it");
  const [stillPointed] = await db.select().from(servicesTable).where(eq(servicesTable.id, service.id));
  assert.equal(stillPointed.pricingFieldId, created.body.id);

  // The same field the other way in: Text and Yes / no leave nothing to price
  // against, so the price starts failing everywhere until somebody flips it back.
  for (const fieldType of ["text", "boolean"]) {
    const refused = await patch(`/customer-fields/${created.body.id}`, { fieldType });
    assert.equal(refused.status, 409, `${fieldType} had to be refused: ${JSON.stringify(refused.body)}`);
    assert.ok(refused.body.error.includes(service.name));
  }
  const [kind] = await db.select().from(estimateFieldsTable).where(eq(estimateFieldsTable.id, created.body.id));
  assert.equal(kind.fieldType, "calculable", "the kind of answer must not have moved");

  // A plain number still carries a number, so that one is allowed, and the name
  // is never the problem — the service points at the row, not at the label.
  const toNumber = await patch(`/customer-fields/${created.body.id}`, { fieldType: "number" });
  assert.equal(toNumber.status, 200, JSON.stringify(toNumber.body));
  const stillRenameable = await patch(`/customer-fields/${created.body.id}`, { label: `${label} b` });
  assert.equal(stillRenameable.status, 200);

  // And once nothing prices from it, it comes off the list as before.
  await db.update(servicesTable).set({ pricingFieldId: null }).where(eq(servicesTable.id, service.id));
  const gone = await del(`/customer-fields/${created.body.id}`);
  assert.equal(gone.status, 204);
  ids.fields = ids.fields.filter((id) => id !== created.body.id);
});

test("a rename carries the values his import left under a different capitalisation", async () => {
  const label = `ZZ Turf Area ${stamp}`;
  const variant = label.toLowerCase();
  const gate = `ZZ Gate ${stamp}`;
  const [imported] = await db
    .insert(clientsTable)
    .values({
      name: `ZZ Import Skew A ${stamp}`,
      status: "client",
      propertyData: { [variant]: "6200", [gate]: "4321" },
    })
    .returning();
  const [bothWays] = await db
    .insert(clientsTable)
    .values({
      name: `ZZ Import Skew B ${stamp}`,
      status: "client",
      propertyData: { [variant]: "1", [label]: "8000" },
    })
    .returning();
  ids.clients.push(imported.id, bothWays.id);

  const created = await post("/customer-fields", { label, fieldType: "calculable" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  ids.fields.push(created.body.id);

  const renamed = `ZZ Lawn Area ${stamp}`;
  const saved = await patch(`/customer-fields/${created.body.id}`, { label: renamed });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(
    saved.body.movedValues,
    2,
    "the count he is told has to include the customers whose key the import spelled differently",
  );

  const [a] = await db.select().from(clientsTable).where(eq(clientsTable.id, imported.id));
  const aData = a.propertyData as Record<string, string>;
  assert.equal(aData[renamed], "6200", "a number saved under the old capitalisation must not be stranded");
  assert.ok(!(variant in aData), "and the old key has to be gone, not left behind as a one-off label");
  assert.equal(aData[gate], "4321", "every other field on that customer stays exactly as it was");

  const [b] = await db.select().from(clientsTable).where(eq(clientsTable.id, bothWays.id));
  const bData = b.propertyData as Record<string, string>;
  assert.equal(bData[renamed], "8000", "where both spellings exist, the one that matched the field wins");
  assert.ok(!(variant in bData) && !(label in bData));

  const list = await get("/customer-fields");
  assert.ok(
    !list.body.unmanaged.some((entry: any) => entry.label.toLowerCase() === variant),
    "nothing may be left behind looking like a field on one customer only",
  );

  await del(`/customer-fields/${created.body.id}`);
  ids.fields = ids.fields.filter((id) => id !== created.body.id);
});
