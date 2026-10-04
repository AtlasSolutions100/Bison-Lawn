import { db, jobCrewTable, jobsTable, usersTable } from "@workspace/db";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { shownName } from "./userAccounts";
import type { Executor } from "./helpers";

/**
 * Who else was on the job.
 *
 * "Document crew member on clean ups, add crew members to day." A clean-up is
 * two or three men in one truck, so the one name on `assignedToId` was never
 * the whole answer. The lead stays on the job itself — everything that bills,
 * routes and totals a sub's day still reads it — and these are the extra people.
 *
 * Kept in its own module because three screens ask the same two questions of
 * it: "who is on this stop" (the board, the job card) and "which stops am I
 * on" (a sub's own day, his clock-in), and the second one has to reach
 * `/my/jobs`, `/my/route` and the clock without each writing the subquery again.
 */

export type CrewMember = { id: number; name: string };

/**
 * The crew on each of these jobs, keyed by job id.
 *
 * Whoever is leading the job is never in this list, even if there is a row here
 * saying so. He puts Gabe on a clean-up as the second man and then hands him
 * the whole job — four screens can reassign a stop, and the board reading
 * "Disa, + Gabe" with Gabe as the lead is the kind of thing he would have to
 * ring up about. Settled on the way out instead of in each of those four
 * places, so it is right whichever one he used.
 */
export async function crewByJob(jobIds: number[], exec: Executor = db): Promise<Map<number, CrewMember[]>> {
  const out = new Map<number, CrewMember[]>();
  if (jobIds.length === 0) return out;
  const rows = await exec
    .select({
      jobId: jobCrewTable.jobId,
      userId: jobCrewTable.userId,
      name: usersTable.name,
      displayName: usersTable.displayName,
    })
    .from(jobCrewTable)
    .innerJoin(usersTable, eq(usersTable.id, jobCrewTable.userId))
    .innerJoin(jobsTable, eq(jobsTable.id, jobCrewTable.jobId))
    .where(
      and(
        inArray(jobCrewTable.jobId, jobIds),
        or(sql`${jobsTable.assignedToId} is null`, ne(jobsTable.assignedToId, jobCrewTable.userId)),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.jobId) ?? [];
    // The short name he set on the person, never the account name — a sub who
    // signed up by email has their email address as the account name, and
    // "the dispatch board shows an email, not a name" is on his checklist.
    list.push({ id: r.userId, name: shownName({ name: r.name, displayName: r.displayName }) });
    out.set(r.jobId, list);
  }
  // Alphabetical so a crew of three reads the same way every time the board
  // redraws. The lead is shown on its own, so there is no running order here
  // worth keeping.
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Is this person on the crew of this job? Says nothing about the lead. */
export async function isOnJobCrew(userId: number, jobId: number, exec: Executor = db): Promise<boolean> {
  const [row] = await exec
    .select({ id: jobCrewTable.id })
    .from(jobCrewTable)
    .where(and(eq(jobCrewTable.jobId, jobId), eq(jobCrewTable.userId, userId)))
    .limit(1);
  return row != null;
}

/**
 * The jobs this person is crew on, as a subquery rather than a list of ids.
 *
 * A sub's own day is `assigned to me OR crew on it`, and in blow-out season he
 * is on a few hundred rows; handing Postgres the subquery keeps that one
 * statement instead of a round trip for the ids and an `in (...)` the length of
 * a paragraph.
 */
export function crewJobIdsFor(userId: number) {
  return db.select({ jobId: jobCrewTable.jobId }).from(jobCrewTable).where(eq(jobCrewTable.userId, userId));
}
