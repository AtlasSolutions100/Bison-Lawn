import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { db, pool, usersTable, clientsTable, clientNotesTable, clientTagsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

/**
 * The customer's account after his 2026-09-28 notes: the tag list he picks
 * from, sub accounts (alphanumeric, no former clients, off the main list) and
 * the activity timeline's order. Everything goes through the HTTP routes with
 * the test-only auth header, the way integration.test.ts does it.
 */
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;

const ids = { users: [] as number[], clients: [] as number[] };
const tagNames: string[] = [];

let admin: { id: number };
let master: { id: number; name: string };
let bigNumber: { id: number; name: string };
let smallNumber: { id: number; name: string };
let former: { id: number; name: string };
let plain: { id: number; name: string };
let stamp: number;

async function api(
  path: string,
  userId: number | null,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A throwaway customer of my own, cleaned up with the rest in `after`. */
async function seedClient(name: string, tags: string[]) {
  const [row] = await db.insert(clientsTable).values({ name, status: "client", tags }).returning();
  ids.clients.push(row.id);
  return row;
}

const get = (path: string) => api(path, admin.id);
const post = (path: string, data: unknown) => api(path, admin.id, { method: "POST", body: JSON.stringify(data) });
const patch = (path: string, data: unknown) => api(path, admin.id, { method: "PATCH", body: JSON.stringify(data) });
const del = (path: string) => api(path, admin.id, { method: "DELETE" });

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  stamp = Date.now();
  const [a] = await db
    .insert(usersTable)
    .values([{ clerkId: `test_tags_admin_${stamp}`, name: "Tag Admin", role: "admin", roleSource: "owner_assigned" }])
    .returning();
  admin = a;
  ids.users.push(a.id);

  // The two numbered names are the point of "list sub account in alpha numeric
  // order": as plain text "10" sorts before "2", which is not the order anybody
  // reads a street in.
  const [m, big, small, f, p] = await db
    .insert(clientsTable)
    .values([
      { name: `ZZ Test Master ${stamp}`, status: "client", serviceAddress: "1 Board Rd" },
      { name: `ZZ Test ${stamp} 10 Oak St`, status: "client", serviceAddress: "10 Oak St" },
      { name: `ZZ Test ${stamp} 2 Oak St`, status: "client", serviceAddress: "2 Oak St" },
      { name: `ZZ Test Former ${stamp}`, status: "former_client", serviceAddress: "9 Gone Ln" },
      { name: `ZZ Test Plain ${stamp}`, status: "client", serviceAddress: "4 Elm St", tags: [`imported ${stamp}`] },
    ])
    .returning();
  master = m;
  bigNumber = big;
  smallNumber = small;
  former = f;
  plain = p;
  ids.clients.push(m.id, big.id, small.id, f.id, p.id);
});

after(async () => {
  if (ids.clients.length) await db.delete(clientsTable).where(inArray(clientsTable.id, ids.clients));
  for (const name of tagNames) await db.delete(clientTagsTable).where(eq(clientTagsTable.name, name));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---- C2: sub accounts ----

test("properties under a master come back in alphanumeric order, not text order", async () => {
  for (const child of [bigNumber, smallNumber]) {
    const linked = await patch(`/clients/${child.id}`, { parentClientId: master.id });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
  }
  const related = await get(`/clients/${master.id}/related`);
  assert.equal(related.status, 200);
  const names = related.body.map((c: any) => c.name);
  assert.deepEqual(names, [smallNumber.name, bigNumber.name], `2 Oak must come before 10 Oak, got ${names}`);
});

test("a former client cannot be filed under a master account", async () => {
  const refused = await patch(`/clients/${former.id}`, { parentClientId: master.id });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /former client/i);

  // And the same refusal on the way in, not only on an edit.
  const created = await post(`/clients`, {
    name: `ZZ Test New Former ${stamp}`,
    status: "former_client",
    parentClientId: master.id,
  });
  assert.equal(created.status, 400);
  assert.match(created.body.error, /former client/i);
});

test("nothing can be filed under a master that is itself a former client", async () => {
  await patch(`/clients/${master.id}`, { status: "former_client" });
  const refused = await patch(`/clients/${plain.id}`, { parentClientId: master.id });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /former client/i);
  await patch(`/clients/${master.id}`, { status: "client" });

  // Back to active, the same link is allowed — the refusal is about the status
  // and nothing else.
  const allowed = await patch(`/clients/${plain.id}`, { parentClientId: master.id });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  const off = await patch(`/clients/${plain.id}`, { parentClientId: null });
  assert.equal(off.status, 200);
});

test("the client list can leave properties under a master out, and ask for only those", async () => {
  const all = await get(`/clients?search=ZZ Test ${stamp}`);
  const allIds = all.body.map((c: any) => c.id);
  assert.ok(allIds.includes(smallNumber.id), "the default list still holds every customer");

  const hidden = await get(`/clients?search=ZZ Test ${stamp}&subAccounts=hide`);
  const hiddenIds = hidden.body.map((c: any) => c.id);
  assert.ok(!hiddenIds.includes(smallNumber.id), "a property under a master is off the list");
  assert.ok(!hiddenIds.includes(bigNumber.id));

  const only = await get(`/clients?search=ZZ Test ${stamp}&subAccounts=only`);
  const onlyIds = only.body.map((c: any) => c.id);
  assert.deepEqual([...onlyIds].sort(), [smallNumber.id, bigNumber.id].sort());
});

// ---- C3: the tag list ----

test("the tag list starts out as the tags already on customers", async () => {
  const list = await get(`/client-tags`);
  assert.equal(list.status, 200);
  const imported = list.body.find((t: any) => t.name === `imported ${stamp}`);
  assert.ok(imported, "a tag only on a customer is still offered");
  assert.equal(imported.onList, false);
  assert.equal(imported.id, null);
  assert.equal(imported.count, 1);
});

test("a tag is added to the list once, and a second try says so", async () => {
  const name = `zz test backflow ${stamp}`;
  tagNames.push(name);
  const added = await post(`/client-tags`, { name: `  ZZ Test   Backflow ${stamp} ` });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  // Tidied the way a tag on a customer is tidied: lowercase, one space.
  assert.equal(added.body.name, name);
  assert.equal(added.body.onList, true);
  assert.equal(added.body.count, 0);

  const again = await post(`/client-tags`, { name });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already on the list/);
});

test("the list comes back alphanumeric, so 2026 sorts before 2027 and before 10", async () => {
  const names = [`zz sort ${stamp} 2`, `zz sort ${stamp} 10`];
  for (const name of names) {
    tagNames.push(name);
    assert.equal((await post(`/client-tags`, { name })).status, 201);
  }
  const list = await get(`/client-tags`);
  const mine = list.body.map((t: any) => t.name).filter((n: string) => n.startsWith(`zz sort ${stamp}`));
  assert.deepEqual(mine, [`zz sort ${stamp} 2`, `zz sort ${stamp} 10`]);
});

test("renaming a tag fixes the spelling on every customer carrying it", async () => {
  const typo = `zz backflo ${stamp}`;
  const right = `zz backflow ${stamp}`;
  tagNames.push(typo, right);
  const added = await post(`/client-tags`, { name: typo });
  assert.equal(added.status, 201);
  // Two customers carry the typo, one of them alongside another tag that must
  // be left exactly as it is.
  for (const client of [plain, smallNumber]) {
    const current = (await get(`/clients/${client.id}`)).body.tags ?? [];
    const saved = await patch(`/clients/${client.id}`, { tags: [...current, typo] });
    assert.equal(saved.status, 200);
  }

  const renamed = await patch(`/client-tags/${added.body.id}`, { name: right });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.count, 2, "both customers were rewritten");

  const one = (await get(`/clients/${plain.id}`)).body;
  assert.ok(one.tags.includes(right));
  assert.ok(!one.tags.includes(typo));
  assert.ok(one.tags.includes(`imported ${stamp}`), "its other tag is untouched");
  const two = (await get(`/clients/${smallNumber.id}`)).body;
  assert.deepEqual(two.tags, [right]);

  // A customer who never had it is not given it.
  const untouched = (await get(`/clients/${bigNumber.id}`)).body;
  assert.deepEqual(untouched.tags, []);
});

test("renaming onto a tag that is already on the list is refused rather than merged", async () => {
  const name = `zz clash ${stamp}`;
  tagNames.push(name);
  const first = await post(`/client-tags`, { name });
  assert.equal(first.status, 201);
  const second = await post(`/client-tags`, { name: `${name} other` });
  tagNames.push(`${name} other`);
  assert.equal(second.status, 201);

  const refused = await patch(`/client-tags/${second.body.id}`, { name });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /already on the list/);
});

test("a tag customers still carry cannot be taken off the list; an unused one can", async () => {
  const list = await get(`/client-tags`);
  const inUse = list.body.find((t: any) => t.name === `zz backflow ${stamp}`);
  assert.ok(inUse?.id, "the renamed tag is on the list");
  const refused = await del(`/client-tags/${inUse.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /2 customers have/);

  const unused = list.body.find((t: any) => t.name === `zz sort ${stamp} 2`);
  assert.equal((await del(`/client-tags/${unused.id}`)).status, 204);
  const after = await get(`/client-tags`);
  assert.ok(!after.body.some((t: any) => t.name === `zz sort ${stamp} 2`));
});

test("renaming onto a spelling that only exists on customers leaves one tag, not two", async () => {
  // The typo-cleanup this feature exists for: "backflo" is on the list,
  // "backflow" never was but came in on the imported customers, and one
  // customer carries both. Nothing refuses the rename, so it has to merge.
  const typo = `zz backflo2 ${stamp}`;
  const right = `zz backflow2 ${stamp}`;
  tagNames.push(typo, right);
  const both = await seedClient(`ZZ Test Both ${stamp}`, [typo, right, `zz keep ${stamp}`]);
  const typoOnly = await seedClient(`ZZ Test Typo ${stamp}`, [typo]);
  const rightOnly = await seedClient(`ZZ Test Right ${stamp}`, [right]);

  const added = await post(`/client-tags`, { name: typo });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const renamed = await patch(`/client-tags/${added.body.id}`, { name: right });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  assert.deepEqual(
    (await get(`/clients/${both.id}`)).body.tags,
    [right, `zz keep ${stamp}`],
    "one tag where he had both spellings, and his other tag still in place",
  );
  assert.deepEqual((await get(`/clients/${typoOnly.id}`)).body.tags, [right]);
  assert.deepEqual((await get(`/clients/${rightOnly.id}`)).body.tags, [right], "left alone, not doubled");

  // Three customers carry it, so three is what he is told — including the one
  // who already had the right spelling and so was never rewritten.
  assert.equal(renamed.body.count, 3);
  const row = (await get(`/client-tags`)).body.find((t: any) => t.name === right);
  assert.equal(row.count, 3, "the count is customers, not entries in an array");
  assert.equal(row.onList, true);
});

test("a tag typed with a capital or a double space still belongs to its list row", async () => {
  // Nothing tidies a tag on the way onto a customer — the import and PATCH
  // /clients both write what they are given — so the list has to fold them.
  const tidyName = `zz loose tag ${stamp}`;
  const tightName = `zz tight tag ${stamp}`;
  tagNames.push(tidyName, tightName);
  const loose = await seedClient(`ZZ Test Loose ${stamp}`, [`ZZ Loose  Tag ${stamp}`]);
  const second = await seedClient(`ZZ Test Loose Two ${stamp}`, [`zz loose   tag ${stamp}`]);

  const listed = (await get(`/client-tags`)).body.find((t: any) => t.name === tidyName);
  assert.ok(listed, "the tidied spelling is the one the list offers");
  assert.equal(listed.count, 2, "both customers counted, not whichever group came back last");
  assert.equal(listed.onList, false);

  const added = await post(`/client-tags`, { name: `ZZ Loose  Tag ${stamp}` });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.name, tidyName);
  assert.equal(added.body.count, 2);

  // The guard that stops a tag being stranded on accounts has to see those two.
  const refused = await del(`/client-tags/${added.body.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /2 customers have/);

  // And the way out it points him at has to reach them: the rename rewrites the
  // loose spellings too, or the tag can never be cleaned off at all.
  const renamed = await patch(`/client-tags/${added.body.id}`, { name: tightName });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.count, 2);
  assert.deepEqual((await get(`/clients/${loose.id}`)).body.tags, [tightName]);
  assert.deepEqual((await get(`/clients/${second.id}`)).body.tags, [tightName]);

  // Cleared off the customers, it comes off the list.
  for (const c of [loose, second]) {
    assert.equal((await patch(`/clients/${c.id}`, { tags: [] })).status, 200);
  }
  assert.equal((await del(`/client-tags/${added.body.id}`)).status, 204);
});

test("a tag that is not on the list cannot be renamed or deleted", async () => {
  assert.equal((await patch(`/client-tags/99999999`, { name: "whatever" })).status, 404);
  assert.equal((await del(`/client-tags/99999999`)).status, 404);
});

// ---- C4: the activity timeline's order ----

test("the activity timeline comes back newest first", async () => {
  const today = new Date();
  const days = (n: number) => new Date(today.getTime() - n * 24 * 60 * 60 * 1000);
  await db.insert(clientNotesTable).values([
    { clientId: plain.id, body: "oldest note", createdAt: days(10) },
    { clientId: plain.id, body: "middle note", createdAt: days(5) },
    { clientId: plain.id, body: "newest note", createdAt: days(1) },
  ]);

  const timeline = await get(`/client-activity?clientId=${plain.id}`);
  assert.equal(timeline.status, 200);
  const notes = timeline.body.filter((i: any) => i.kind === "note");
  assert.deepEqual(notes.map((n: any) => n.title), ["newest note", "middle note", "oldest note"]);

  // And the whole list, not only the notes in it: every row is on or before the
  // row above it.
  const dates = timeline.body.map((i: any) => i.date);
  for (let i = 1; i < dates.length; i++) {
    assert.ok(dates[i] <= dates[i - 1], `row ${i} (${dates[i]}) is newer than the row above it (${dates[i - 1]})`);
  }
});

// ---- C5: the Edit panel, and the cards it shows twice ----
//
// These are React and there is no browser runner here, so the things that can
// go wrong silently are pinned against the page source, the way the bulk-edit
// dialog's are in clientsBulk.test.ts.

const pagePath = (file: string) => new URL(`../../bison-crm/src/pages/${file}`, import.meta.url);

/** One card's source out of the customer page. */
function cardSource(page: string, name: string): string {
  const start = page.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} is still in client-detail.tsx`);
  const next = page.indexOf("\nfunction ", start + 1);
  return page.slice(start, next === -1 ? undefined : next);
}

test("only one card saves the notification email", async () => {
  // The Edit panel has the Billing card and the Name & address card open at the
  // same moment and both used to send clients.email, so the second Save put
  // back the address the first had just corrected — and flipped an "invoice by
  // email" customer back to the old one with it.
  const page = await readFile(pagePath("client-detail.tsx"), "utf8");
  const billing = cardSource(page, "ClientBilling");
  assert.ok(
    !/email: clean\(form\.email\)/.test(billing),
    "the billing card must not send the notification email",
  );
  assert.ok(
    !/^\s+email: client\.email/m.test(billing),
    "the billing form must not snapshot the notification email either",
  );
  assert.match(billing, /value=\{notificationEmail\}\s*\n\s*readOnly/, "it shows that email, it does not edit it");
  const personal = cardSource(page, "ClientPersonalInfo");
  assert.match(personal, /email: clean\(form\.email\)/, "Name & address is the one card that saves it");
});

test("a card re-seeds its boxes when the customer changes under it", async () => {
  // Overview keeps its copy of Personal info mounted behind the Edit panel. Save
  // the phone in the panel and the copy behind it was still holding the old one,
  // with its Save button lit — one press and the edit was gone.
  const page = await readFile(pagePath("client-detail.tsx"), "utf8");
  assert.match(page, /function useClientFields</, "one hook keeps a card's boxes in step with the customer");
  // Every card the Edit panel can show over a copy of itself on a tab.
  for (const card of ["ClientPersonalInfo", "ClientBilling", "ClientRouting", "ClientMapPin"]) {
    const src = cardSource(page, card);
    assert.match(src, /useClientFields/, `${card} must take its boxes from the hook`);
    assert.ok(
      !/useState<(Form|BillingForm)>/.test(src) && !/useState\(client\./.test(src),
      `${card} must not read the customer once and keep it forever`,
    );
  }
});

test("opening the Edit panel adds a history entry, so Back closes it", async () => {
  const page = await readFile(pagePath("client-detail.tsx"), "utf8");
  const openEdit = page.slice(page.indexOf("const openEdit ="), page.indexOf("const closeEdit ="));
  assert.ok(openEdit.length > 0, "openEdit is still there");
  assert.ok(
    !/replace: true/.test(openEdit),
    "replacing the account's own entry means Back walks him out to the client list",
  );
  assert.match(openEdit, /replace: editing/, "only a jump inside the already-open panel replaces");
});

test("the hidden-properties line counts the status tab it is sitting on", async () => {
  const page = await readFile(pagePath("clients.tsx"), "utf8");
  assert.ok(
    !/useListClients\(\{ subAccounts: 'only' \}\)/.test(page),
    "counting every property regardless of status said 12 were hidden on a tab none of them are on",
  );
  const counting = page.slice(
    page.indexOf("const { data: subAccountRows }"),
    page.indexOf("const subAccountCount"),
  );
  assert.match(counting, /statusFilter !== 'all' && \{ status: statusFilter \}/);
  assert.match(counting, /subAccounts: 'only'/);

  // And the query that line now sends really does leave out a property whose
  // status is not the tab's: these two are properties with status 'client'.
  const leads = await get(`/clients?status=lead&subAccounts=only`);
  assert.equal(leads.status, 200);
  const leadIds = leads.body.map((c: any) => c.id);
  assert.ok(!leadIds.includes(smallNumber.id), "a serviced property is not counted as a hidden lead");
  assert.ok(!leadIds.includes(bigNumber.id));
});
