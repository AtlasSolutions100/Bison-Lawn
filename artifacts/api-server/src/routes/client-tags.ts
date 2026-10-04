import { Router, type IRouter } from "express";
import { db, clientTagsTable, clientsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreateClientTagBody, UpdateClientTagBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { logAudit } from "../lib/helpers";

/**
 * The tag list he picks from.
 *
 * "Create a tag list for drop down selection, ability to add multiple tags."
 * Tags were free text, so every typo became a second tag that looked identical
 * in the filter — "backflow" and "backflo" sitting one above the other. Now the
 * office picks from a list, and putting a new tag ON the list is its own
 * deliberate step.
 *
 * The tag on a customer is still the plain string in `clients.tags`. Nothing
 * here points at a customer and nothing on a customer points at a row here, so
 * every tag the 709 imported customers already carry keeps working exactly as
 * it did, and those tags are what the list starts out as: they come back from
 * GET alongside the managed ones, with the number of customers carrying each.
 */
const router: IRouter = Router();

router.use("/client-tags", requireAuth, requireArea("clients"));

/** The one rule a tag has always had: lowercase, trimmed, one space between words. */
function tidy(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The same rule, inside Postgres, over one tag out of a customer's array.
 *
 * The list is tidied; a tag on a customer is whatever was typed or imported —
 * "Backflow", "above  ground backflow" — and the two have to meet somewhere. If
 * they only met in JavaScript the count said one thing and the queries said
 * another: a tag he could see a count for came back as nobody's, so the guard
 * that refuses to take an in-use tag off the list let it through and stranded
 * it on the customer. Every query that compares a customer's tag to the list
 * compares the tidied form of both.
 */
const tidiedTag = (column: string) =>
  sql.raw(`lower(btrim(regexp_replace(${column}, '\\s+', ' ', 'g')))`);

/** How many customers carry this tag, however it happens to be typed on them. */
async function carrierCount(name: string): Promise<number> {
  const [row] = (
    await db.execute(sql`
      select count(*)::int as "count" from clients
      where exists (
        select 1 from jsonb_array_elements_text(clients.tags) e(tag)
        where ${tidiedTag("e.tag")} = ${name}
      )
    `)
  ).rows as { count: number }[];
  return Number(row?.count ?? 0);
}

/**
 * Alphanumeric, so "2026 spring letter" sorts before "2027 spring letter" and
 * not by the shape of the digits.
 */
const alphanumeric = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

type TagRow = { id: number | null; name: string; count: number; onList: boolean };

/**
 * One list, out of two places: the managed rows, and whatever is already on a
 * customer. A tag that was never added to the list comes back with a null id —
 * it can be picked, but it cannot be renamed or taken off a list it was never
 * on, and the web says so.
 */
async function tagList(): Promise<TagRow[]> {
  const [managed, used] = await Promise.all([
    db.select().from(clientTagsTable),
    db.execute(sql`
      select ${tidiedTag("tag")} as "name", count(distinct clients.id)::int as "count"
      from clients, jsonb_array_elements_text(clients.tags) tag
      group by 1
    `),
  ]);
  const counts = new Map<string, number>();
  for (const row of used.rows as { name: string; count: number }[]) {
    // The count he reads is customers, not entries in an array: a customer who
    // somehow ended up carrying the same tag twice is one customer. Added up
    // rather than set, so two spellings that tidy to one name never overwrite
    // each other and show him the smaller of the two.
    counts.set(row.name, (counts.get(row.name) ?? 0) + Number(row.count));
  }
  const out = new Map<string, TagRow>();
  for (const tag of managed) {
    out.set(tag.name, { id: tag.id, name: tag.name, count: counts.get(tag.name) ?? 0, onList: true });
  }
  for (const [name, count] of counts) {
    if (!out.has(name)) out.set(name, { id: null, name, count, onList: false });
  }
  return [...out.values()].sort((a, b) => alphanumeric.compare(a.name, b.name));
}

router.get("/client-tags", async (_req, res) => {
  return res.json(await tagList());
});

router.post("/client-tags", async (req, res) => {
  const body = CreateClientTagBody.parse(req.body);
  const name = tidy(body.name);
  if (!name) return res.status(400).json({ error: "A tag needs some words in it." });
  const [existing] = await db.select().from(clientTagsTable).where(eq(clientTagsTable.name, name));
  if (existing) {
    return res.status(409).json({ error: `"${name}" is already on the list.` });
  }
  const [tag] = await db.insert(clientTagsTable).values({ name }).returning();
  // No clientId: the list belongs to the office, not to one customer.
  await logAudit({
    actorName: req.appUser?.name,
    action: "client_tag_added",
    description: `Added "${name}" to the tag list`,
  });
  const inUse = (await tagList()).find((t) => t.name === name);
  return res.status(201).json({ id: tag.id, name: tag.name, count: inUse?.count ?? 0, onList: true });
});

/**
 * Renaming fixes the spelling everywhere, which is the whole point: a typo that
 * is already out on twenty customers does not get fixed by correcting the list
 * and leaving the twenty behind. The customers' own arrays are rewritten in the
 * same transaction as the list row, so there is no moment where the tag exists
 * on accounts with nothing offering it.
 */
router.patch("/client-tags/:id", async (req, res) => {
  const body = UpdateClientTagBody.parse(req.body);
  const id = Number(req.params.id);
  const name = tidy(body.name);
  if (!name) return res.status(400).json({ error: "A tag needs some words in it." });
  const [existing] = await db.select().from(clientTagsTable).where(eq(clientTagsTable.id, id));
  if (!existing) return res.status(404).json({ error: "That tag is not on the list." });
  if (name !== existing.name) {
    const [clash] = await db.select().from(clientTagsTable).where(eq(clientTagsTable.name, name));
    if (clash) {
      return res.status(409).json({
        error: `"${name}" is already on the list. Clear "${existing.name}" off the customers with Remove tags instead.`,
      });
    }
  }

  const touched = await db.transaction(async (tx) => {
    await tx.update(clientTagsTable).set({ name }).where(eq(clientTagsTable.id, id));
    // jsonb_set would need the index; rebuilding the array swaps the one value
    // and leaves the rest of the customer's tags in the order they were in.
    //
    // `distinct on` keeps the first place a tag appeared. Fixing "backflo" to
    // "backflow" is exactly the job this does, and some customers already carry
    // the right spelling — on those the rename has to leave ONE tag, not the
    // same word twice, which showed up as a doubled chip and a count of two
    // customers for one.
    const result = await tx.execute(sql`
      update clients set tags = (
        select coalesce(jsonb_agg(d.tag order by d.ord), '[]'::jsonb)
        from (
          select distinct on (m.tag) m.tag, m.ord
          from (
            select case when ${tidiedTag("e.tag")} = ${existing.name} then ${name}::text else e.tag end as tag,
                   e.ord
            from jsonb_array_elements_text(clients.tags) with ordinality as e(tag, ord)
          ) m
          order by m.tag, m.ord
        ) d
      )
      where exists (
        select 1 from jsonb_array_elements_text(clients.tags) e(tag)
        where ${tidiedTag("e.tag")} = ${existing.name}
      )
      returning clients.id
    `);
    return result.rows.length;
  });
  // What he asked for is the tag's count, and after a rename that is everyone
  // carrying the new spelling — including the customers who already had it and
  // so were not rewritten.
  const carriers = await carrierCount(name);

  await logAudit({
    actorName: req.appUser?.name,
    action: "client_tag_renamed",
    description: `Renamed the tag "${existing.name}" to "${name}"${
      touched > 0 ? ` on ${touched} ${touched === 1 ? "customer" : "customers"}` : ""
    }`,
  });
  return res.json({ id, name, count: carriers, onList: true });
});

/**
 * Taking a tag off the list while customers still carry it would leave those
 * tags stranded — on the accounts, offered by nothing — so it is refused with
 * the count and the way out. "Remove tags" on the client list is the way out.
 */
router.delete("/client-tags/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(clientTagsTable).where(eq(clientTagsTable.id, id));
  if (!existing) return res.status(404).json({ error: "That tag is not on the list." });
  const count = await carrierCount(existing.name);
  if (count > 0) {
    return res.status(409).json({
      error: `${count} ${Number(count) === 1 ? "customer has" : "customers have"} the tag "${existing.name}". Take it off them first — select them on the client list and use Bulk edit, Remove tags.`,
    });
  }
  await db.delete(clientTagsTable).where(eq(clientTagsTable.id, id));
  await logAudit({
    actorName: req.appUser?.name,
    action: "client_tag_removed",
    description: `Took "${existing.name}" off the tag list`,
  });
  return res.status(204).end();
});

export default router;
