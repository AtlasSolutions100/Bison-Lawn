import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  servicesTable,
  packagesTable,
  clientServicesTable,
  jobsTable,
  auditEventsTable,
  type PricingEquation,
} from "@workspace/db";
import { eq, inArray, like } from "drizzle-orm";
import { calculatePrice } from "../src/lib/helpers.ts";

// 2026-09-15 walkthrough, services and packages: the service form's new
// fields, copying a matrix onto sister services, building bands from a rule,
// and a package that lists the same service more than once.

process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;
const stamp = Date.now();

const ids = {
  users: [] as number[],
  clients: [] as number[],
  services: [] as number[],
  packages: [] as number[],
};

let admin: { id: number };

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-user-id": String(admin.id),
      "x-test-auth-token": TEST_AUTH_TOKEN,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const band = (upToSqft: number | null, basePrice: number, extra: Partial<PricingEquation> = {}): PricingEquation => ({
  upToSqft,
  basePrice,
  baseSqft: 0,
  incrementPrice: 0,
  incrementSqft: 0,
  budgetedHours: null,
  budgetedCost: null,
  ...extra,
});

async function makeService(values: Partial<typeof servicesTable.$inferInsert> & { name: string }) {
  const [svc] = await db.insert(servicesTable).values(values).returning();
  ids.services.push(svc.id);
  return svc;
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a] = await db
    .insert(usersTable)
    .values({ clerkId: `test_services_admin_${stamp}`, name: "Test Admin", role: "admin", roleSource: "owner_assigned" })
    .returning();
  admin = a;
  ids.users.push(a.id);
});

after(async () => {
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  if (ids.packages.length) await db.delete(packagesTable).where(inArray(packagesTable.id, ids.packages));
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  await db.delete(auditEventsTable).where(like(auditEventsTable.description, `%${stamp}%`));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

// ---- the service form: code, invoice description, billing mode, visits ----

test("a service carries a code, an invoice description, a billing mode and visits per season", async () => {
  const created = await api("/services", {
    method: "POST",
    body: JSON.stringify({
      name: `Mowing ${stamp}`,
      code: "  MOWIN ",
      invoiceDescription: " Weekly mowing, trimming and blowing ",
      billingMode: "fixed",
      visitsPerSeason: 28,
      rate: 49,
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ids.services.push(created.body.id);
  assert.equal(created.body.code, "MOWIN", "a stray space must not become a different code");
  assert.equal(created.body.invoiceDescription, "Weekly mowing, trimming and blowing");
  assert.equal(created.body.billingMode, "fixed");
  assert.equal(created.body.visitsPerSeason, 28);

  // Emptying a box means "none", and a clean-up switches to billing on time.
  const patched = await api(`/services/${created.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ code: "", invoiceDescription: "   ", billingMode: "time", visitsPerSeason: null }),
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.code, null);
  assert.equal(patched.body.invoiceDescription, null);
  assert.equal(patched.body.billingMode, "time");
  assert.equal(patched.body.visitsPerSeason, null);

  const zeroVisits = await api(`/services/${created.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ visitsPerSeason: 0 }),
  });
  assert.equal(zeroVisits.status, 400, "zero visits a season is not a season");
});

// ---- fill bands by rule ----

test("a rule becomes bands without saving anything", async () => {
  const res = await api("/services/matrix-from-rule", {
    method: "POST",
    body: JSON.stringify({
      startPrice: 40,
      firstTier: { pricePerStep: 2, stepSize: 500, upTo: 2000 },
      secondTier: { pricePerStep: 4.5, stepSize: 2000, upTo: null },
      costPercent: 75,
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.equations.map((e: PricingEquation) => [e.upToSqft, e.basePrice]),
    [[500, 40], [1000, 42], [1500, 44], [2000, 46], [null, 46]],
  );
  assert.equal(res.body.equations[0].budgetedCost, 30);
  const last = res.body.equations[4];
  assert.equal(last.baseSqft, 2000);
  assert.equal(last.incrementSqft, 2000);
  assert.equal(last.incrementPrice, 4.5);

  const bad = await api("/services/matrix-from-rule", {
    method: "POST",
    body: JSON.stringify({ startPrice: 40, firstTier: { pricePerStep: 2, stepSize: 0, upTo: 2000 } }),
  });
  assert.equal(bad.status, 400);
});

// ---- the season repricer ----

test("the season repricer raises the priced bands and leaves an empty row empty", async () => {
  // Mowing's real shape: two priced bands and the leftover row from an "Add
  // tier" click. +$5 used to turn that leftover into an open-ended $5 band,
  // and a 30,000 sqft property then quoted $5 instead of the top band.
  const svc = await makeService({
    name: `Repriced mowing ${stamp}`,
    rate: 49,
    pricingEquations: [band(3999, 49), band(9999, 75), band(null, 0)],
  });

  const res = await api("/services/bulk-price-adjust", {
    method: "POST",
    body: JSON.stringify({ serviceIds: [svc.id], mode: "fixed", amount: 5, apply: true }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.applied, true);
  assert.deepEqual(res.body.changes.map((c: { from: number; to: number }) => [c.from, c.to]), [[49, 54]]);

  const [row] = await db.select().from(servicesTable).where(eq(servicesTable.id, svc.id));
  assert.deepEqual(
    row.pricingEquations.map((e) => [e.upToSqft, e.basePrice]),
    [[3999, 54], [9999, 80], [null, 0]],
    "the empty row must not become a $5 band",
  );
  assert.equal(row.rate, 54, "the flat rate moves too");
  assert.equal(calculatePrice(row.pricingEquations, 30000).price, 80, "a big property still prices at the top band");

  // A percent season raise still carries the per-step increment with it.
  const stepped = await makeService({
    name: `Repriced stepped ${stamp}`,
    rate: 0,
    pricingEquations: [band(null, 100, { baseSqft: 5000, incrementSqft: 1000, incrementPrice: 10 })],
  });
  const percent = await api("/services/bulk-price-adjust", {
    method: "POST",
    body: JSON.stringify({ serviceIds: [stepped.id], mode: "percent", amount: 10, apply: true }),
  });
  assert.equal(percent.status, 200, JSON.stringify(percent.body));
  const [steppedRow] = await db.select().from(servicesTable).where(eq(servicesTable.id, stepped.id));
  assert.equal(steppedRow.pricingEquations[0].basePrice, 110);
  assert.equal(steppedRow.pricingEquations[0].incrementPrice, 11);
});

// ---- copy a matrix to other services ----

test("copying Bison App 1 to the sister apps: preview writes nothing, apply writes every target", async () => {
  const mowing = [band(3999, 49, { budgetedCost: 36.75, budgetedHours: 0.5 }), band(9999, 75), band(null, 203.75)];
  const source = await makeService({ name: `Bison App 1 ${stamp}`, pricingEquations: mowing });
  const targets = await Promise.all(
    [2, 3, 4].map((n) => makeService({ name: `Bison App ${n} ${stamp}`, pricingEquations: [band(0, 0)] })),
  );
  const targetIds = targets.map((t) => t.id);

  const preview = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({ targetServiceIds: [...targetIds, source.id], mode: "multiply", value: 1.5, roundTo: 0.5 }),
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.applied, false);
  assert.equal(preview.body.targets.length, 3, "the source itself is dropped from the targets");
  assert.deepEqual(
    preview.body.targets[0].equations.map((e: PricingEquation) => e.basePrice),
    [73.5, 112.5, 305.5],
  );
  assert.equal(preview.body.targets[0].existingBands, 0, "an empty placeholder row is not a matrix");
  for (const t of targets) {
    const [row] = await db.select().from(servicesTable).where(eq(servicesTable.id, t.id));
    assert.equal(row.pricingEquations[0].basePrice, 0, "preview must not write");
  }

  const applied = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({ targetServiceIds: targetIds, mode: "multiply", value: 1.5, roundTo: 0.5, apply: true }),
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.applied, true);
  for (const t of targets) {
    const [row] = await db.select().from(servicesTable).where(eq(servicesTable.id, t.id));
    assert.deepEqual(row.pricingEquations.map((e) => e.basePrice), [73.5, 112.5, 305.5]);
    assert.deepEqual(row.pricingEquations.map((e) => e.upToSqft), [3999, 9999, null], "the measurements travel untouched");
    assert.equal(row.pricingEquations[0].budgetedHours, 0.5);
    assert.equal(row.pricingEquations[0].budgetedCost, 55.13, "cost follows the rate");
  }
  const [unchanged] = await db.select().from(servicesTable).where(eq(servicesTable.id, source.id));
  assert.equal(unchanged.pricingEquations[0].basePrice, 49, "the source is never touched");

  const audit = await db
    .select()
    .from(auditEventsTable)
    .where(like(auditEventsTable.description, `%Bison App 1 ${stamp}%`));
  assert.ok(audit.some((e) => e.action === "service_matrix_copied"), "the copy is audited");
});

test("a target that already has a matrix is only replaced when asked", async () => {
  const source = await makeService({ name: `Mowing src ${stamp}`, pricingEquations: [band(3999, 49)] });
  const handTyped = await makeService({ name: `One-time mow ${stamp}`, pricingEquations: [band(5000, 80)] });

  const refused = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({ targetServiceIds: [handTyped.id], apply: true }),
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /already has a matrix/);
  const [still] = await db.select().from(servicesTable).where(eq(servicesTable.id, handTyped.id));
  assert.equal(still.pricingEquations[0].basePrice, 80, "a hand-typed matrix is not lost to one click");

  const replaced = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({ targetServiceIds: [handTyped.id], mode: "add", value: 5, apply: true, overwrite: true }),
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const [now] = await db.select().from(servicesTable).where(eq(servicesTable.id, handTyped.id));
  assert.deepEqual(now.pricingEquations.map((e) => [e.upToSqft, e.basePrice]), [[3999, 54]]);
});

test("the pricing field travels with the bands, and a source with nothing to copy is refused", async () => {
  const source = await makeService({ name: `Blowout ${stamp}`, pricingEquations: [band(4, 60)] });
  const target = await makeService({ name: `Blowout late ${stamp}` });

  const kept = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({ targetServiceIds: [target.id], apply: true, copyPricingField: false }),
  });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.targets[0].pricingFieldChanged, false);

  const empty = await makeService({ name: `Empty ${stamp}`, pricingEquations: [band(0, 0)] });
  const nothing = await api(`/services/${empty.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({ targetServiceIds: [target.id], apply: true }),
  });
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error, /no priced bands/);

  const selfOnly = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({ targetServiceIds: [source.id] }),
  });
  assert.equal(selfOnly.status, 400, "copying onto itself alone is not a copy");

  const zeroTimes = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({ targetServiceIds: [target.id], mode: "multiply", value: 0 }),
  });
  assert.equal(zeroTimes.status, 400, "x0 would wipe every price");
});

// ---- packages that list the same service more than once ----

test("a package can hold the same service several times, each entry with its own label and window", async () => {
  const timer = await makeService({ name: `Timer adjustment ${stamp}`, rate: 45 });
  const aeration = await makeService({ name: `Aeration ${stamp}`, rate: 120 });

  const created = await api("/packages", {
    method: "POST",
    body: JSON.stringify({
      name: `Sprinkler ${stamp}`,
      scheduleType: "window",
      startDate: "2026-04-01",
      endDate: "2026-10-31",
      items: [
        { serviceId: timer.id, label: " June ", windowStart: "2026-06-01", windowEnd: "2026-06-30" },
        { serviceId: timer.id, label: "July", windowStart: "2026-07-01", windowEnd: "2026-07-31" },
        { serviceId: aeration.id },
        { serviceId: aeration.id, label: "Fall" },
      ],
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ids.packages.push(created.body.id);
  assert.deepEqual(created.body.serviceIds, [timer.id, timer.id, aeration.id, aeration.id], "the id list stays in step, repeats kept");
  assert.equal(created.body.services.length, 4, "one service per entry, so a repeat shows as many times as it is listed");
  assert.deepEqual(
    created.body.items.map((i: { label: string | null }) => i.label),
    ["June", "July", null, "Fall"],
  );
  assert.equal(created.body.items[0].windowStart, "2026-06-01");

  const listed = await api("/packages");
  const found = listed.body.find((p: { id: number }) => p.id === created.body.id);
  assert.equal(found.items.length, 4);

  // Older callers that only send ids still get plain entries.
  const idsOnly = await api(`/packages/${created.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ serviceIds: [aeration.id, aeration.id] }),
  });
  assert.equal(idsOnly.status, 200, JSON.stringify(idsOnly.body));
  assert.deepEqual(idsOnly.body.items, [
    { serviceId: aeration.id, label: null, windowStart: null, windowEnd: null },
    { serviceId: aeration.id, label: null, windowStart: null, windowEnd: null },
  ]);

  const badWindow = await api(`/packages/${created.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ items: [{ serviceId: timer.id, windowStart: "2026-07-01", windowEnd: "2026-06-01" }] }),
  });
  assert.equal(badWindow.status, 400);
  assert.match(badWindow.body.error, /cannot end before it starts/);

  // Deleting a service takes every entry for it out of the package.
  const restored = await api(`/packages/${created.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ items: [{ serviceId: timer.id, label: "June" }, { serviceId: aeration.id }, { serviceId: timer.id, label: "July" }] }),
  });
  assert.equal(restored.status, 200);
  const gone = await api(`/services/${timer.id}`, { method: "DELETE" });
  assert.equal(gone.status, 204);
  ids.services.splice(ids.services.indexOf(timer.id), 1);
  const [row] = await db.select().from(packagesTable).where(eq(packagesTable.id, created.body.id));
  assert.deepEqual(row.serviceIds, [aeration.id]);
  assert.deepEqual(row.items.map((i) => i.serviceId), [aeration.id]);
});

test("an entry window the package could never honour is refused while he is still on the package, by name", async () => {
  const timer = await makeService({ name: `Timer window ${stamp}`, rate: 45 });
  const [client] = await db
    .insert(clientsTable)
    .values({ name: `Window Client ${stamp}`, status: "client", serviceAddress: "2 Elm St" })
    .returning();
  ids.clients.push(client.id);

  const post = (items: unknown[]) =>
    api("/packages", {
      method: "POST",
      body: JSON.stringify({
        name: `Spring windows ${stamp}`,
        scheduleType: "window",
        startDate: "2026-04-01",
        endDate: "2026-10-31",
        items,
      }),
    });

  // Only an end date, before the package starts: assigning used to fail for
  // the whole package with nothing to say which entry did it.
  const endsFirst = await post([
    { serviceId: timer.id, label: "June", windowStart: "2026-06-01", windowEnd: "2026-06-30" },
    { serviceId: timer.id, label: "Early spring", windowEnd: "2026-03-31" },
  ]);
  assert.equal(endsFirst.status, 400, JSON.stringify(endsFirst.body));
  assert.match(endsFirst.body.error, /Early spring/, "the message names the entry at fault");

  // Only a start date, after the package ends.
  const startsLast = await post([{ serviceId: timer.id, label: "Late fall", windowStart: "2026-11-15" }]);
  assert.equal(startsLast.status, 400, JSON.stringify(startsLast.body));
  assert.match(startsLast.body.error, /Late fall/);

  // A day that does not exist on a calendar.
  const notADay = await post([{ serviceId: timer.id, label: "Leap", windowStart: "2026-02-31" }]);
  assert.equal(notADay.status, 400, JSON.stringify(notADay.body));
  assert.match(notADay.body.error, /"Leap": Window start is not a real calendar date/);

  const refusedRows = await db.select().from(packagesTable).where(like(packagesTable.name, `Spring windows ${stamp}`));
  assert.equal(refusedRows.length, 0, "nothing is saved when an entry is refused");

  // Both dates of its own, outside the package window, is fine: an entry's
  // own window wins, so that is a window the assignment can honour.
  const ok = await post([
    { serviceId: timer.id, label: "Early spring", windowStart: "2026-03-01", windowEnd: "2026-03-31" },
    { serviceId: timer.id, label: "June" },
  ]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  ids.packages.push(ok.body.id);

  const assigned = await api(`/clients/${client.id}/client-services`, {
    method: "POST",
    body: JSON.stringify({ packageId: ok.body.id }),
  });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  assert.equal(assigned.body.length, 2, "both entries land on the account");

  // Editing a saved package is judged against the window it will end up with.
  const edited = await api(`/packages/${ok.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ items: [{ serviceId: timer.id, label: "Early spring", windowEnd: "2026-03-31" }] }),
  });
  assert.equal(edited.status, 400, JSON.stringify(edited.body));
  assert.match(edited.body.error, /Early spring/);
  const widened = await api(`/packages/${ok.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      startDate: "2026-03-01",
      items: [{ serviceId: timer.id, label: "Early spring", windowEnd: "2026-03-31" }],
    }),
  });
  assert.equal(widened.status, 200, JSON.stringify(widened.body));
  assert.equal(widened.body.items[0].windowEnd, "2026-03-31");
});

test("assigning a package with repeated entries puts every entry on the account, labelled and in its own window", async () => {
  const timer = await makeService({ name: `Timer adj ${stamp}`, rate: 45 });
  const blowout = await makeService({ name: `Blow-out ${stamp}`, rate: 90 });
  const [client] = await db
    .insert(clientsTable)
    .values({ name: `Package Client ${stamp}`, status: "client", serviceAddress: "1 Elm St" })
    .returning();
  ids.clients.push(client.id);

  const pkg = await api("/packages", {
    method: "POST",
    body: JSON.stringify({
      name: `Timer x2 ${stamp}`,
      scheduleType: "window",
      startDate: "2026-04-01",
      endDate: "2026-10-31",
      items: [
        { serviceId: timer.id, label: "June", windowStart: "2026-06-01", windowEnd: "2026-06-30" },
        { serviceId: timer.id, label: "August", windowStart: "2026-08-01", windowEnd: "2026-08-31" },
        { serviceId: blowout.id },
      ],
    }),
  });
  assert.equal(pkg.status, 201, JSON.stringify(pkg.body));
  ids.packages.push(pkg.body.id);

  const assigned = await api(`/clients/${client.id}/client-services`, {
    method: "POST",
    body: JSON.stringify({ packageId: pkg.body.id }),
  });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  assert.equal(assigned.body.length, 3, "three entries, three rows — the repeat is not collapsed");

  const timers = assigned.body.filter((cs: { serviceId: number }) => cs.serviceId === timer.id);
  assert.equal(timers.length, 2);
  assert.deepEqual(timers.map((cs: { label: string | null }) => cs.label).sort(), ["August", "June"]);
  const june = timers.find((cs: { label: string | null }) => cs.label === "June");
  assert.equal(june.startDate, "2026-06-01", "the entry's window beats the package window");
  assert.equal(june.endDate, "2026-06-30");
  const bo = assigned.body.find((cs: { serviceId: number }) => cs.serviceId === blowout.id);
  assert.equal(bo.label, null);
  assert.equal(bo.startDate, "2026-04-01", "an entry with no window of its own uses the package's");
  assert.equal(bo.endDate, "2026-10-31");

  const rows = await db.select().from(clientServicesTable).where(eq(clientServicesTable.clientId, client.id));
  assert.equal(rows.length, 3);
  const jobs = await db.select().from(jobsTable).where(eq(jobsTable.clientId, client.id));
  assert.equal(jobs.filter((j) => j.serviceId === timer.id).length, 2, "one visit per timer entry on the waiting list");
});
