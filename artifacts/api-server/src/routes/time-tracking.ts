import { Router, type IRouter, type Request, type Response } from "express";
import { db, jobTimeEntriesTable, jobsTable, usersTable } from "@workspace/db";
import type { JobTimeEntry } from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ClockInToJobBody, ClockOutOfJobBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { logAudit } from "../lib/helpers";
import { shownName } from "../lib/userAccounts";
import { isOnJobCrew } from "../lib/jobCrew";

const router: IRouter = Router();

router.use(requireAuth);

type JobRow = typeof jobsTable.$inferSelect;

/**
 * Same rule jobs.ts applies to every other contractor action on a job. Kept as
 * a copy rather than an import because that module owns its own predicate;
 * if the rule changes there it has to change here too, and a clock-in that
 * outlives the dispatch it belongs to is the failure this prevents.
 */
async function canAccessJob(req: Request, job: JobRow): Promise<boolean> {
  if (req.appUser?.role === "admin") return true;
  if (!req.appUser || job.dispatched !== true || job.visibleToContractor !== true) return false;
  if (job.assignedToId === req.appUser.id) return true;
  // The second and third man on a clean-up clock their own hours. That is the
  // whole point of "document crew member on clean ups": without it the job's
  // time is one man's, and the hours he reports back are a guess.
  return isOnJobCrew(req.appUser.id, job.id);
}

async function loadAccessibleJob(req: Request, res: Response): Promise<JobRow | null> {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, Number(req.params.id)));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return null;
  }
  if (!(await canAccessJob(req, job))) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return job;
}

/**
 * Elapsed time to a tenth of a minute rather than whole minutes: these get
 * added up across a route, and rounding every stop to the nearest minute walks
 * the day's total away from what actually happened.
 */
function elapsedMinutes(entry: JobTimeEntry): number | null {
  if (!entry.clockOutAt) return null;
  const ms = entry.clockOutAt.getTime() - entry.clockInAt.getTime();
  return Math.round(ms / 6000) / 10;
}

async function hydrate(rows: JobTimeEntry[]) {
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const users = await db.select().from(usersTable).where(inArray(usersTable.id, userIds));
  const uMap = new Map(users.map((u) => [u.id, shownName(u)]));
  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    userId: r.userId,
    userName: uMap.get(r.userId) ?? null,
    clockInAt: r.clockInAt.toISOString(),
    clockOutAt: r.clockOutAt ? r.clockOutAt.toISOString() : null,
    clockInLat: r.clockInLat,
    clockInLng: r.clockInLng,
    clockOutLat: r.clockOutLat,
    clockOutLng: r.clockOutLng,
    minutes: elapsedMinutes(r),
    note: r.note,
  }));
}

router.post("/jobs/:id/clock-in", async (req, res) => {
  const body = ClockInToJobBody.parse(req.body ?? {});
  const job = await loadAccessibleJob(req, res);
  if (!job) return;
  const userId = req.appUser!.id;

  // Locked and re-checked inside the transaction: a phone on a bad signal gets
  // double-tapped, and two requests that both read "no open entry" would open
  // two entries, which then both close and bill the visit twice.
  const entry = await db.transaction(async (tx) => {
    await tx.select().from(jobsTable).where(eq(jobsTable.id, job.id)).for("update");
    const [open] = await tx
      .select()
      .from(jobTimeEntriesTable)
      .where(
        and(
          eq(jobTimeEntriesTable.jobId, job.id),
          eq(jobTimeEntriesTable.userId, userId),
          isNull(jobTimeEntriesTable.clockOutAt),
        ),
      );
    if (open) return null;
    const [inserted] = await tx
      .insert(jobTimeEntriesTable)
      .values({
        jobId: job.id,
        userId,
        // Stamped here rather than left to the column default: clock-out is a
        // JS Date, and these columns carry no timezone, so a database session
        // on a different zone to this process would make every elapsed time
        // wrong by that offset.
        clockInAt: new Date(),
        clockInLat: body.lat ?? null,
        clockInLng: body.lng ?? null,
        note: body.note ?? null,
      })
      .returning();
    return inserted;
  });

  if (!entry) {
    return res.status(409).json({ error: "Already clocked in to this job" });
  }

  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "job_clock_in",
    description:
      `${req.appUser?.name ?? "Someone"} clocked in to job #${job.id}` +
      (entry.clockInLat != null && entry.clockInLng != null
        ? ` at ${entry.clockInLat.toFixed(5)}, ${entry.clockInLng.toFixed(5)}`
        : " (no location available)"),
  });

  return res.status(201).json((await hydrate([entry]))[0]);
});

router.post("/jobs/:id/clock-out", async (req, res) => {
  const body = ClockOutOfJobBody.parse(req.body ?? {});
  const job = await loadAccessibleJob(req, res);
  if (!job) return;
  const userId = req.appUser!.id;

  const entry = await db.transaction(async (tx) => {
    await tx.select().from(jobsTable).where(eq(jobsTable.id, job.id)).for("update");
    const [open] = await tx
      .select()
      .from(jobTimeEntriesTable)
      .where(
        and(
          eq(jobTimeEntriesTable.jobId, job.id),
          eq(jobTimeEntriesTable.userId, userId),
          isNull(jobTimeEntriesTable.clockOutAt),
        ),
      )
      .orderBy(desc(jobTimeEntriesTable.clockInAt))
      .for("update");
    if (!open) return null;
    const [closed] = await tx
      .update(jobTimeEntriesTable)
      .set({
        clockOutAt: new Date(),
        clockOutLat: body.lat ?? null,
        clockOutLng: body.lng ?? null,
        // One note column for the pair, so a clock-out note is appended rather
        // than silently overwriting whatever was said on the way in.
        note: body.note ? [open.note, body.note].filter(Boolean).join("\n") : open.note,
      })
      .where(eq(jobTimeEntriesTable.id, open.id))
      .returning();
    return closed;
  });

  if (!entry) {
    return res.status(409).json({ error: "Not clocked in to this job" });
  }

  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "job_clock_out",
    description: `${req.appUser?.name ?? "Someone"} clocked out of job #${job.id} after ${elapsedMinutes(entry) ?? 0} minutes on site`,
  });

  return res.json((await hydrate([entry]))[0]);
});

router.get("/jobs/:id/time-entries", async (req, res) => {
  const job = await loadAccessibleJob(req, res);
  if (!job) return;
  const rows = await db
    .select()
    .from(jobTimeEntriesTable)
    .where(eq(jobTimeEntriesTable.jobId, job.id))
    .orderBy(desc(jobTimeEntriesTable.clockInAt));
  return res.json(await hydrate(rows));
});

export default router;
