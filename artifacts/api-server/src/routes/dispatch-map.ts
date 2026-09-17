import { Router, type IRouter } from "express";
import { db, jobsTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { BulkAssignJobsBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { logAudit } from "../lib/helpers";

const router: IRouter = Router();

// Moving other people's work around the board is an office job.
router.use(["/jobs/bulk-assign"], requireAuth, requireArea("dispatch"));

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * What the map's group selection commits.
 *
 * The interesting part is what it does *not* do: a field absent from the body is
 * left alone. Assigning a crew to forty stops must not blank the dates somebody
 * set this morning, and the difference between "not mentioned" and "set to null"
 * is the whole reason this reads the raw body rather than a parsed object with
 * defaults filled in.
 */
router.post("/jobs/bulk-assign", async (req, res) => {
  const body = BulkAssignJobsBody.parse(req.body);
  const jobIds = [...new Set(body.jobIds)].filter((id) => Number.isInteger(id));
  if (jobIds.length === 0) return res.status(400).json({ error: "Select at least one job" });

  const raw = (req.body ?? {}) as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);

  if (has("scheduledDate") && raw.scheduledDate != null && !isDate(raw.scheduledDate)) {
    return res.status(400).json({ error: "scheduledDate must be yyyy-mm-dd" });
  }

  const patch: Record<string, unknown> = {};
  if (has("assignedToId")) patch.assignedToId = body.assignedToId ?? null;
  if (has("scheduledDate")) patch.scheduledDate = body.scheduledDate ?? null;
  if (has("dispatched") && body.dispatched != null) patch.dispatched = body.dispatched;
  // "Set route order" starts by wiping the numbers so he can click the stops in
  // the order they should be driven. Clearing and numbering in one call would
  // be contradictory, so the clear wins and the numbering is refused.
  if (body.clearRouteOrder === true) {
    if (body.routeOrderFrom != null) {
      return res.status(400).json({ error: "Clear the route order or number it, not both at once" });
    }
    patch.routeOrder = null;
  }

  if (Object.keys(patch).length === 0 && body.routeOrderFrom == null) {
    return res.status(400).json({ error: "Nothing to change" });
  }

  await db.transaction(async (tx) => {
    if (Object.keys(patch).length > 0) {
      await tx.update(jobsTable).set(patch).where(inArray(jobsTable.id, jobIds));
    }

    if (body.routeOrderFrom != null) {
      // Numbered in the order the ids arrived, which is the order the dispatcher
      // sees on screen — not the order the database happens to return them.
      // One statement so the row locks are not held across forty round trips.
      const start = body.routeOrderFrom;
      const cases = jobIds.map(
        (id, i) => sql`when ${jobsTable.id} = ${id} then ${start + i}::int`,
      );
      await tx
        .update(jobsTable)
        .set({ routeOrder: sql.join([sql`(case`, ...cases, sql`end)`], sql` `) })
        .where(inArray(jobsTable.id, jobIds));
    }
  });

  // One line for the batch. Forty near-identical audit rows bury the event that
  // actually matters, which is that a group was moved at all.
  const changed = [
    has("assignedToId") ? (body.assignedToId == null ? "unassigned" : `assigned to #${body.assignedToId}`) : null,
    has("scheduledDate") ? (body.scheduledDate == null ? "date cleared" : `moved to ${body.scheduledDate}`) : null,
    has("dispatched") && body.dispatched != null ? (body.dispatched ? "dispatched" : "returned to the waiting list") : null,
    body.routeOrderFrom != null ? `route order set from ${body.routeOrderFrom}` : null,
    body.clearRouteOrder === true ? "route order cleared" : null,
  ].filter(Boolean);

  await logAudit({
    actorName: req.appUser?.name ?? null,
    action: "jobs_bulk_assigned",
    description: `${jobIds.length} job${jobIds.length === 1 ? "" : "s"} updated from the dispatch map (${changed.join(", ")})`,
  });

  return res.json({ updated: jobIds.length, jobIds });
});

export default router;
