/**
 * "Where is my guy?" A contractor's phone reports where it is while Bison
 * Field is open and they have a job going; the dispatch map draws them and
 * the office answers the customer without ringing someone who is driving.
 *
 * Honest limits, so nobody is promised more than a web app can do: the phone
 * only reports while the app is open in the foreground (a locked screen or a
 * backgrounded Safari stops it), so the office sees "last seen N min ago"
 * rather than a live dot the moment the phone goes in a pocket. Positions are
 * only reported during a job the person is assigned to, only the office can
 * read them, and a week of history is all that is kept.
 */
import { Router, type IRouter } from "express";
import { db, userLocationsTable, jobsTable, clientsTable, usersTable, jobTimeEntriesTable } from "@workspace/db";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { ReportMyLocationBody, ListTeamLocationsQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { haversineKm } from "../lib/helpers";
import { todayLocal } from "../lib/jobGeneration";

const router: IRouter = Router();

/** Within this of a job's pin counts as "at the house" — a driveway, not a street. */
const AT_JOB_KM = 0.15;
/** Older than this and the office is told the position is stale, not current. */
const STALE_AFTER_SECONDS = 10 * 60;
const KEEP_DAYS = 7;

const ACTIVE_STATUSES = ["on_the_way", "in_progress"] as const;

router.post("/my/location", requireAuth, async (req, res) => {
  const body = ReportMyLocationBody.parse(req.body);
  const me = req.appUser!;

  // The phone says which job it thinks it is on; believed only if that job is
  // actually this person's. Anything else is dropped rather than rejected —
  // the fix itself is still worth keeping.
  let jobId: number | null = null;
  if (body.jobId != null) {
    const [job] = await db
      .select({ id: jobsTable.id, assignedToId: jobsTable.assignedToId })
      .from(jobsTable)
      .where(eq(jobsTable.id, body.jobId));
    if (job && job.assignedToId === me.id) jobId = job.id;
  }

  const recordedAt = body.recordedAt ? new Date(body.recordedAt) : new Date();
  const now = Date.now();
  // A phone clock that is wrong, or a fix replayed from a queue, must not put
  // someone "at a job" in the future or an hour ago; clamp to the last hour.
  const safeRecordedAt =
    Number.isNaN(recordedAt.getTime()) || recordedAt.getTime() > now || now - recordedAt.getTime() > 3_600_000
      ? new Date(now)
      : recordedAt;

  await db.insert(userLocationsTable).values({
    userId: me.id,
    lat: body.lat,
    lng: body.lng,
    accuracyM: body.accuracyM ?? null,
    heading: body.heading ?? null,
    speedMps: body.speedMps ?? null,
    jobId,
    recordedAt: safeRecordedAt,
  });

  // Not a tracking archive: a week is enough to answer "where was he Tuesday".
  await db
    .delete(userLocationsTable)
    .where(
      and(
        eq(userLocationsTable.userId, me.id),
        lt(userLocationsTable.recordedAt, new Date(now - KEEP_DAYS * 86_400_000)),
      ),
    );

  return res.status(204).end();
});

type Status = "at_job" | "en_route" | "idle" | "stale" | "unknown";

router.get("/team/locations", requireAuth, requireArea("dispatch"), async (req, res) => {
  const { date } = ListTeamLocationsQueryParams.parse(req.query);
  // Our own day, not Greenwich's: after about 5 pm here a UTC date is already
  // tomorrow, and the map would say "no job going" for everyone still working.
  const day = date || todayLocal();
  const now = Date.now();

  const [latest, people] = await Promise.all([
    db
      .selectDistinctOn([userLocationsTable.userId])
      .from(userLocationsTable)
      .orderBy(userLocationsTable.userId, desc(userLocationsTable.recordedAt)),
    // Everyone who works jobs, plus anyone else who has reported in the last
    // day (Adam himself on a route, say) — the strip must not hide a person
    // just because their role is not "contractor".
    db.select().from(usersTable).where(eq(usersTable.active, true)),
  ]);
  const latestByUser = new Map(latest.map((l) => [l.userId, l]));
  const recentReporters = new Set(
    latest.filter((l) => now - l.recordedAt.getTime() < 86_400_000).map((l) => l.userId),
  );
  const crew = people.filter((u) => u.role === "contractor" || recentReporters.has(u.id));
  const crewIds = crew.map((u) => u.id);
  if (crewIds.length === 0) return res.json([]);

  const [activeJobs, clockFixes] = await Promise.all([
    db
      .select({
        id: jobsTable.id,
        assignedToId: jobsTable.assignedToId,
        status: jobsTable.status,
        clientName: clientsTable.name,
        clientAddress: clientsTable.serviceAddress,
        lat: clientsTable.lat,
        lng: clientsTable.lng,
      })
      .from(jobsTable)
      .innerJoin(clientsTable, eq(clientsTable.id, jobsTable.clientId))
      .where(
        and(
          inArray(jobsTable.assignedToId, crewIds),
          eq(jobsTable.scheduledDate, day),
          inArray(jobsTable.status, [...ACTIVE_STATUSES]),
        ),
      ),
    // When the phone has never reported, the last clock-in or clock-out fix is
    // the next best answer — it at least says which house they were at.
    db
      .selectDistinctOn([jobTimeEntriesTable.userId])
      .from(jobTimeEntriesTable)
      .where(
        and(
          inArray(jobTimeEntriesTable.userId, crewIds),
          gte(jobTimeEntriesTable.clockInAt, new Date(now - KEEP_DAYS * 86_400_000)),
        ),
      )
      .orderBy(jobTimeEntriesTable.userId, desc(jobTimeEntriesTable.clockInAt)),
  ]);
  const clockByUser = new Map(clockFixes.map((e) => [e.userId, e]));

  const rows = crew
    .map((u) => {
      const live = latestByUser.get(u.id);
      const clock = clockByUser.get(u.id);
      let lat: number | null = null;
      let lng: number | null = null;
      let accuracyM: number | null = null;
      let recordedAt: Date | null = null;
      let source: "live" | "clock" | "none" = "none";
      if (live) {
        ({ lat, lng, accuracyM } = live);
        recordedAt = live.recordedAt;
        source = "live";
      } else if (clock) {
        const out = clock.clockOutAt && clock.clockOutLat != null && clock.clockOutLng != null;
        if (out) {
          lat = clock.clockOutLat;
          lng = clock.clockOutLng;
          recordedAt = clock.clockOutAt;
          source = "clock";
        } else if (clock.clockInLat != null && clock.clockInLng != null) {
          lat = clock.clockInLat;
          lng = clock.clockInLng;
          recordedAt = clock.clockInAt;
          source = "clock";
        }
      }
      const ageSeconds = recordedAt ? Math.max(0, Math.round((now - recordedAt.getTime()) / 1000)) : null;

      const mine = activeJobs.filter((j) => j.assignedToId === u.id);
      // Nearest job first, so "at" names the house they are actually parked at
      // when two of the day's stops are on the same street.
      const near =
        lat != null && lng != null
          ? mine
              .filter((j) => j.lat != null && j.lng != null)
              .map((j) => ({ job: j, km: haversineKm(lat!, lng!, j.lat!, j.lng!) }))
              .sort((a, b) => a.km - b.km)[0]
          : undefined;
      const going = mine.find((j) => j.status === "in_progress") ?? mine.find((j) => j.status === "on_the_way");

      let status: Status;
      let job = going ?? null;
      if (lat == null || lng == null) status = "unknown";
      else if (ageSeconds != null && ageSeconds > STALE_AFTER_SECONDS) status = "stale";
      else if (near && near.km <= AT_JOB_KM) {
        status = "at_job";
        job = near.job;
      } else if (going) status = "en_route";
      else status = "idle";

      return {
        userId: u.id,
        userName: u.displayName?.trim() || u.name,
        lat,
        lng,
        accuracyM,
        recordedAt: recordedAt ? recordedAt.toISOString() : null,
        ageSeconds,
        source,
        status,
        jobId: job?.id ?? null,
        jobStatus: job?.status ?? null,
        jobClientName: job?.clientName ?? null,
        jobAddress: job?.clientAddress ?? null,
      };
    })
    // People with a position first, freshest first; the never-reported at the bottom.
    .sort((a, b) => (a.ageSeconds ?? Infinity) - (b.ageSeconds ?? Infinity) || a.userName.localeCompare(b.userName));

  return res.json(rows);
});

export default router;
