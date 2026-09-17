import { Router, type IRouter } from "express";
import { db, jobsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { BulkJobActionBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { logAudit } from "../lib/helpers";
import { assessSkip } from "../lib/skipPolicy";

const router: IRouter = Router();

// Tick rows, pick an action, done. Moving, cancelling and deleting other
// people's work is an office job.
router.use(["/jobs/bulk-action"], requireAuth, requireArea("dispatch"));

// A half-typed year in a date box reads as a real date ("0002-09-16"), and a
// job parked in year 2 is off every board and every list for good. Nothing we
// schedule is before 2000 or after 2100, so anything outside that is a slip.
const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= "2000-01-01" && v <= "2100-12-31";

type JobRow = typeof jobsTable.$inferSelect;

/**
 * Which jobs an action may touch.
 *
 * A completed job has an invoice behind it, so it is never cancelled, deleted,
 * moved or sent back to the waiting list from here: the money side would go
 * out of step with the board. A note can always be added. Skipping something
 * already skipped or cancelled is left alone too, or the free-skip count would
 * be spent twice on one visit.
 *
 * A skip is a board action. Nobody drove to a waiting-list job — it has no day
 * yet — so skipping one would spend the customer's free skip of the year on a
 * visit that was never attempted.
 */
function eligible(action: string, job: JobRow): boolean {
  if (action === "add_note") return true;
  if (job.status === "completed") return false;
  if (action === "skip") return job.dispatched && job.status !== "skipped" && job.status !== "cancelled";
  if (action === "cancel") return job.status !== "cancelled";
  return true;
}

/**
 * "select all, or select some" — one action for the whole selection.
 *
 * The bar on the dispatch board and the waiting list both post here. Every
 * job in the batch is locked and changed in one transaction, so a selection
 * of forty either all moves or none of it does; the ones the action does not
 * apply to are reported back by id rather than failing the batch, because on
 * a real day the selection nearly always has one completed job in it.
 */
router.post("/jobs/bulk-action", async (req, res) => {
  const body = BulkJobActionBody.parse(req.body);
  const jobIds = [...new Set(body.jobIds)].filter((id) => Number.isInteger(id));
  if (jobIds.length === 0) return res.status(400).json({ error: "Select at least one job" });

  const raw = (req.body ?? {}) as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);
  const reason = body.reason?.trim() || null;
  const note = body.note?.trim() || "";

  if ((body.action === "move" || body.action === "dispatch") && !isDate(body.scheduledDate)) {
    return res.status(400).json({ error: "Pick a date (yyyy-mm-dd)" });
  }
  if (body.action === "assign" && !has("assignedToId")) {
    return res.status(400).json({ error: "Pick a contractor, or Unassigned" });
  }
  if (body.action === "add_note" && !note) {
    return res.status(400).json({ error: "Type the note to add" });
  }

  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    const rows = await tx.select().from(jobsTable).where(inArray(jobsTable.id, jobIds)).for("update");
    const targets = rows.filter((r) => eligible(body.action, r));
    const skippedIds = rows.filter((r) => !eligible(body.action, r)).map((r) => r.id);
    const ids = targets.map((r) => r.id);
    const skipNotices: string[] = [];
    if (ids.length === 0) return { targets, ids, skippedIds, skipNotices };

    /**
     * Giving a job a new day means the visit is owed again.
     *
     * A skip or a cancel belongs to the day it happened on, so it is retired
     * with the move. Left on, the crew turns up on Thursday to a row that says
     * SKIPPED, Complete refuses it ("reschedule it first" — he just did), and
     * Monday's skip keeps eating the customer's one free skip of the year.
     */
    const reopenMoved = async () => {
      const stale = targets.filter((r) => r.status === "skipped" || r.status === "cancelled").map((r) => r.id);
      if (stale.length === 0) return;
      await tx
        .update(jobsTable)
        .set({
          status: "scheduled",
          skipReason: null,
          skippedAt: null,
          skipBillable: null,
          cancelReason: null,
          cancelledAt: null,
        })
        .where(inArray(jobsTable.id, stale));
    };

    switch (body.action) {
      case "move":
        // A waiting-list job given a date is on the board from then on; leaving
        // dispatched false would give it a date nobody can see.
        await tx
          .update(jobsTable)
          .set({ scheduledDate: body.scheduledDate!, dispatched: true })
          .where(inArray(jobsTable.id, ids));
        await reopenMoved();
        break;
      case "assign":
        await tx
          .update(jobsTable)
          .set({ assignedToId: body.assignedToId ?? null })
          .where(inArray(jobsTable.id, ids));
        break;
      case "dispatch":
        await tx
          .update(jobsTable)
          .set({
            dispatched: true,
            scheduledDate: body.scheduledDate!,
            // Only overwrite the crew when one was named, same rule as the
            // route builder: dispatching unassigned must not wipe a name
            // somebody already put on the job.
            ...(body.assignedToId != null ? { assignedToId: body.assignedToId } : {}),
          })
          .where(inArray(jobsTable.id, ids));
        await reopenMoved();
        break;
      case "waiting_list":
        // Back to waiting means back to square one: no date, no route number,
        // and a skip or cancel from its time on the board is retired with it.
        await tx
          .update(jobsTable)
          .set({
            dispatched: false,
            scheduledDate: null,
            routeOrder: null,
            status: "scheduled",
            skipReason: null,
            skippedAt: null,
            skipBillable: null,
            cancelReason: null,
            cancelledAt: null,
          })
          .where(inArray(jobsTable.id, ids));
        break;
      case "cancel":
        await tx
          .update(jobsTable)
          .set({
            status: "cancelled",
            cancelledAt: now,
            cancelReason: reason,
            skipReason: null,
            skippedAt: null,
            skipBillable: null,
          })
          .where(inArray(jobsTable.id, ids));
        break;
      case "skip":
        // One at a time on purpose: the free-or-chargeable verdict depends on
        // how many skips that customer already has this year, and two jobs for
        // the same customer in one batch must see each other.
        for (const job of targets) {
          const verdict = await assessSkip(job.clientId, job.id, now, tx);
          await tx
            .update(jobsTable)
            .set({ status: "skipped", skippedAt: now, skipReason: reason, skipBillable: verdict.billable })
            .where(eq(jobsTable.id, job.id));
          skipNotices.push(verdict.message);
        }
        break;
      case "delete":
        await tx.delete(jobsTable).where(inArray(jobsTable.id, ids));
        break;
      case "add_note":
        for (const job of targets) {
          const existing = job.notes?.trim();
          await tx
            .update(jobsTable)
            .set({
              notes: existing ? `${existing}\n${note}` : note,
              notesImportant: job.notesImportant || body.notesImportant === true,
            })
            .where(eq(jobsTable.id, job.id));
        }
        break;
    }
    return { targets, ids, skippedIds, skipNotices };
  });

  const { targets, ids, skippedIds, skipNotices } = outcome;
  const count = `${ids.length} job${ids.length === 1 ? "" : "s"}`;
  const said = {
    move: `Moved ${count} to ${body.scheduledDate}`,
    assign: body.assignedToId == null ? `Unassigned ${count}` : `Assigned ${count} to user #${body.assignedToId}`,
    dispatch: `Dispatched ${count} from the waiting list to ${body.scheduledDate}`,
    waiting_list: `Sent ${count} back to the waiting list`,
    cancel: `Cancelled ${count}${reason ? ` — ${reason}` : ""}`,
    skip: `Skipped ${count}${reason ? ` — ${reason}` : ""}`,
    delete: `Deleted ${count}`,
    add_note: `Added a note to ${count}: "${note}"`,
  }[body.action];

  if (ids.length > 0) {
    // One line for the batch so the event that matters — a group was acted on —
    // is findable, plus one on each customer's own history for the actions
    // that change what they get or owe. A cancelled or skipped visit is
    // exactly the thing the office looks up when the customer rings.
    await logAudit({
      actorName: req.appUser?.name ?? null,
      action: `jobs_bulk_${body.action}`,
      description: `${said}${skippedIds.length ? ` (${skippedIds.length} left alone)` : ""}`,
    });
    if (["cancel", "skip", "delete", "waiting_list"].includes(body.action)) {
      for (const job of targets) {
        const what = {
          cancel: `Cancelled job #${job.id}${reason ? ` — ${reason}` : ""}`,
          skip: `Skipped job #${job.id}${reason ? ` — ${reason}` : ""}`,
          delete: `Deleted job #${job.id}${job.scheduledDate ? ` (was ${job.scheduledDate})` : ""}`,
          waiting_list: `Job #${job.id} sent back to the waiting list${job.scheduledDate ? ` from ${job.scheduledDate}` : ""}`,
        }[body.action as "cancel" | "skip" | "delete" | "waiting_list"];
        await logAudit({
          clientId: job.clientId,
          actorName: req.appUser?.name ?? null,
          action: `job_${body.action === "waiting_list" ? "returned_to_waiting" : body.action === "delete" ? "deleted" : body.action === "cancel" ? "cancelled" : "skipped"}`,
          description: what,
        });
      }
    }
  }

  return res.json({
    action: body.action,
    updated: ids.length,
    jobIds: ids,
    skippedIds,
    skipNotices,
  });
});

export default router;
