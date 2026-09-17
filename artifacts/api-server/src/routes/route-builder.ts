import { Router, type IRouter } from "express";
import { db, jobsTable, clientsTable, servicesTable, usersTable } from "@workspace/db";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { BuildRouteFromWaitingListBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { logAudit, roundMoney, type Executor } from "../lib/helpers";

const router: IRouter = Router();

router.use(requireAuth);

type Candidate = {
  jobId: number;
  clientId: number;
  clientName: string;
  address: string | null;
  mapCode: string | null;
  serviceName: string | null;
  amount: number;
  budgetedHours: number | null;
  lat: number | null;
  lng: number | null;
};

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Nearest-neighbour walk from an anchor. Deliberately no 2-opt pass: the shared
 * optimiser in lib/helpers re-measures the whole tour for every candidate swap,
 * which is fine for one crew's dozen stops but does not finish on the four
 * hundred blow-outs that land here in a single autumn.
 *
 * Ties break on the earlier index so the same waiting list always produces the
 * same route — the office previews, thinks, and previews again, and a route that
 * reshuffled between identical previews would look broken.
 */
function nearestNeighbourOrder(anchor: { lat: number; lng: number }, points: Candidate[]): number[] {
  const visited = new Array(points.length).fill(false);
  const order: number[] = [];
  let cur = anchor;
  for (let step = 0; step < points.length; step++) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (visited[i]) continue;
      const d = haversineKm(cur.lat, cur.lng, points[i].lat!, points[i].lng!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    visited[best] = true;
    order.push(best);
    cur = { lat: points[best].lat!, lng: points[best].lng! };
  }
  return order;
}

/**
 * Every waiting-list job that matches the filters, in a stable order.
 *
 * Reads the waiting list the same way GET /waiting-list does — jobs with
 * dispatched = false — and hydrates clients and services with the separate
 * keyed lookups that route uses, rather than a join, so map code and city can
 * be matched case-insensitively the way the dispatch board already filters city.
 *
 * `lock` takes FOR UPDATE on the candidate rows. Selection and the write have to
 * see the same set: without the lock a job dispatched from the board between the
 * two would either be scheduled twice or silently drop out of a route the office
 * had already approved.
 */
async function loadCandidates(
  exec: Executor,
  filters: { serviceId?: number | null; mapCode?: string | null; city?: string | null },
  lock: boolean,
): Promise<Candidate[]> {
  const conds = [
    eq(jobsTable.dispatched, false),
    // A cancelled waiting-list job (a window that passed and was cleared in
    // bulk) is not a stop for anyone; nor is one already done.
    sql`${jobsTable.status} not in ('cancelled', 'completed')`,
  ];
  if (filters.serviceId != null) conds.push(eq(jobsTable.serviceId, filters.serviceId));

  const query = exec
    .select()
    .from(jobsTable)
    .where(and(...conds))
    // Nulls sort last in Postgres, which is what we want: a job with no window
    // is the least urgent tie-break, not the first stop of the day.
    .orderBy(asc(jobsTable.windowStart), asc(jobsTable.id));
  const rows = await (lock ? query.for("update") : query);
  if (rows.length === 0) return [];

  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const serviceIds = [...new Set(rows.map((r) => r.serviceId).filter((x): x is number => x != null))];
  const [clients, services] = await Promise.all([
    exec.select().from(clientsTable).where(inArray(clientsTable.id, clientIds)),
    serviceIds.length
      ? exec.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds))
      : Promise.resolve([]),
  ]);
  const cMap = new Map(clients.map((c) => [c.id, c]));
  const sMap = new Map(services.map((s) => [s.id, s]));

  const wantMapCode = filters.mapCode?.trim().toLowerCase() || null;
  const wantCity = filters.city?.trim().toLowerCase() || null;

  const out: Candidate[] = [];
  for (const r of rows) {
    const c = cMap.get(r.clientId);
    if (wantMapCode && (c?.mapCode ?? "").trim().toLowerCase() !== wantMapCode) continue;
    if (wantCity && (c?.city ?? "").trim().toLowerCase() !== wantCity) continue;
    out.push({
      jobId: r.id,
      clientId: r.clientId,
      clientName: c?.name ?? `Client #${r.clientId}`,
      address: c?.serviceAddress ?? null,
      mapCode: c?.mapCode ?? null,
      serviceName: r.serviceId ? (sMap.get(r.serviceId)?.name ?? null) : null,
      amount: r.amount,
      budgetedHours: r.budgetedHours,
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
    });
  }
  return out;
}

/**
 * Put the matching jobs in the order a truck would drive them, then let the caps
 * cut the day off the front.
 *
 * Ordering happens before the caps, not after: cutting first and sorting the
 * survivors would hand back a day's work scattered across the whole zone. Walking
 * the geography first and stopping when the day is full keeps what is taken
 * contiguous, which is the whole point of carving a route out of a four-hundred
 * job pile.
 *
 * Jobs with no coordinates go on the tail rather than being dropped. Plenty of
 * clients were typed in without a geocode and they still need blowing out; a
 * missing lat/lng is a data gap, not a reason to leave someone off the schedule.
 */
function orderGeographically(candidates: Candidate[], anchor: { lat: number; lng: number } | null) {
  const located = candidates.filter((c) => c.lat != null && c.lng != null);
  const unlocated = candidates.filter((c) => c.lat == null || c.lng == null);
  if (located.length === 0) return candidates;

  // With no crew base to start from, the centroid is the anchor: the walk then
  // begins in the middle of the cluster and spirals out, so the stops taken
  // before a cap bites stay near each other.
  const start = anchor ?? {
    lat: located.reduce((s, c) => s + c.lat!, 0) / located.length,
    lng: located.reduce((s, c) => s + c.lng!, 0) / located.length,
  };
  const order = nearestNeighbourOrder(start, located);
  return [...order.map((i) => located[i]), ...unlocated];
}

/**
 * Cut the route at the first cap that the next stop would break, and say which
 * one it was.
 *
 * It stops rather than skipping past the offending job and carrying on. Skipping
 * would squeeze in a cheap stop from the far end of the zone to use up the last
 * of the budget, which is a longer drive for less money and impossible to explain
 * to the person reading the preview.
 */
function fillToCaps(
  ordered: Candidate[],
  caps: { maxStops?: number | null; maxDollars?: number | null; maxHours?: number | null },
) {
  // Floating point slack. budgetedHours and amount are doubles, so a route of
  // eight 0.75 hour stops sums to just over 6 and would refuse a 6 hour cap
  // without this.
  const EPS = 1e-9;
  const selected: Candidate[] = [];
  let totalAmount = 0;
  let totalHours = 0;
  let limitedBy: string | null = null;

  for (const c of ordered) {
    if (caps.maxStops != null && selected.length >= caps.maxStops) {
      limitedBy = "stops";
      break;
    }
    const nextAmount = totalAmount + c.amount;
    if (caps.maxDollars != null && nextAmount > caps.maxDollars + EPS) {
      limitedBy = "dollars";
      break;
    }
    const nextHours = totalHours + (c.budgetedHours ?? 0);
    if (caps.maxHours != null && nextHours > caps.maxHours + EPS) {
      limitedBy = "hours";
      break;
    }
    selected.push(c);
    totalAmount = nextAmount;
    totalHours = nextHours;
  }

  return { selected, limitedBy, totalAmount, totalHours, skipped: ordered.length - selected.length };
}

/**
 * Cut a day-sized route out of the waiting list.
 *
 * Previews unless apply is true. Committing several hundred jobs to a date is not
 * something anyone unpicks by hand, so the default has to be the harmless one:
 * with apply false this endpoint opens no transaction and writes nothing.
 */
router.post("/waiting-list/build-route", requireArea("dispatch"), async (req, res) => {
  const body = BuildRouteFromWaitingListBody.parse(req.body);

  // A half-typed year ("0002-09-16") is a well-formed date, and a route built
  // onto a day in year 2 is a route nobody can ever find again.
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(body.scheduledDate) ||
    body.scheduledDate < "2000-01-01" ||
    body.scheduledDate > "2100-12-31"
  ) {
    return res.status(400).json({ error: "scheduledDate must be yyyy-mm-dd, year 2000 or later" });
  }
  // A zero or negative cap is almost always a half-typed number rather than a
  // request for an empty route, and silently returning nothing looks like the
  // filters matched nothing.
  for (const [name, value] of [
    ["maxStops", body.maxStops],
    ["maxDollars", body.maxDollars],
    ["maxHours", body.maxHours],
  ] as const) {
    if (value != null && !(value > 0)) {
      return res.status(400).json({ error: `${name} must be greater than zero` });
    }
  }

  const filters = { serviceId: body.serviceId, mapCode: body.mapCode, city: body.city };
  const caps = { maxStops: body.maxStops, maxDollars: body.maxDollars, maxHours: body.maxHours };

  // The route starts wherever the assigned crew starts, when we know that. It is
  // the difference between a sensible first stop and one picked from the middle
  // of the map.
  let anchor: { lat: number; lng: number } | null = null;
  if (body.assignedToId != null) {
    const [assignee] = await db.select().from(usersTable).where(eq(usersTable.id, body.assignedToId));
    if (assignee?.baseLat != null && assignee.baseLng != null) {
      anchor = { lat: assignee.baseLat, lng: assignee.baseLng };
    }
  }

  const buildFrom = (candidates: Candidate[]) => {
    const ordered = orderGeographically(candidates, anchor);
    const filled = fillToCaps(ordered, caps);
    return {
      ...filled,
      stops: filled.selected.map((c, i) => ({
        jobId: c.jobId,
        clientId: c.clientId,
        clientName: c.clientName,
        address: c.address,
        mapCode: c.mapCode,
        serviceName: c.serviceName,
        amount: c.amount,
        budgetedHours: c.budgetedHours,
        routeOrder: i + 1,
      })),
    };
  };

  if (!body.apply) {
    const built = buildFrom(await loadCandidates(db, filters, false));
    return res.json({
      applied: false,
      selected: built.stops,
      skipped: built.skipped,
      totalAmount: roundMoney(built.totalAmount),
      totalHours: Math.round(built.totalHours * 100) / 100,
      limitedBy: built.limitedBy,
    });
  }

  // Selection and write share one transaction so the route lands whole or not at
  // all. Half of two hundred blow-outs scheduled and half still waiting is a
  // state no one can sort out by looking at the board.
  const built = await db.transaction(async (tx) => {
    const result = buildFrom(await loadCandidates(tx, filters, true));
    if (result.stops.length === 0) return result;

    // One statement rather than a write per stop: each job needs its own
    // routeOrder, and two hundred round trips would hold the row locks open for
    // the whole time the office sits waiting on the response.
    // The ::int on each branch is load bearing: without it every branch is an
    // untyped parameter and Postgres has to guess the CASE result type.
    const chunks: SQL[] = [sql`(case`];
    for (const s of result.stops) {
      chunks.push(sql`when ${jobsTable.id} = ${s.jobId} then ${s.routeOrder}::int`);
    }
    chunks.push(sql`end)`);

    await tx
      .update(jobsTable)
      .set({
        dispatched: true,
        scheduledDate: body.scheduledDate,
        routeOrder: sql.join(chunks, sql` `),
        // Only overwrite the crew when one was named. An unassigned route build
        // must not wipe an assignment somebody already made on the job.
        ...(body.assignedToId != null ? { assignedToId: body.assignedToId } : {}),
      })
      .where(
        inArray(
          jobsTable.id,
          result.stops.map((s) => s.jobId),
        ),
      );
    return result;
  });

  // Logged after the commit and as one line, not one per job: the event the
  // office needs to find later is "a route was built", and four hundred
  // near-identical rows would bury it. Outside the transaction because logAudit
  // writes on the pooled connection, so a slow audit insert would otherwise
  // stretch the lock window.
  if (built.stops.length > 0) {
    const zone = [body.mapCode, body.city].filter(Boolean).join(" / ") || "all areas";
    await logAudit({
      actorName: req.appUser?.name,
      action: "route_built",
      description:
        `Built a ${built.stops.length} stop route for ${body.scheduledDate} from the waiting list ` +
        `(${zone}), ${roundMoney(built.totalAmount)} total, ${built.skipped} left waiting`,
    });
  }

  return res.json({
    applied: true,
    selected: built.stops,
    skipped: built.skipped,
    totalAmount: roundMoney(built.totalAmount),
    totalHours: Math.round(built.totalHours * 100) / 100,
    limitedBy: built.limitedBy,
  });
});

export default router;
