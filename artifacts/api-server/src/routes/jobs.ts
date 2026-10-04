import { Router, type IRouter } from "express";
import {
  db,
  jobsTable,
  jobProductsTable,
  clientsTable,
  servicesTable,
  usersTable,
  invoicesTable,
  paymentsTable,
  clientServicesTable,
  jobTimeEntriesTable,
  chargePresetsTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { contractorNoteFor, discountAmountFor } from "../lib/jobGeneration";
import {
  CreateJobBody,
  UpdateJobBody,
  DispatchJobsBody,
  AddJobProductBody,
  AddExtraWorkBody,
  RecordOnSitePaymentBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { balanceOf } from "../lib/invoiceDocument";
import {
  logAudit,
  recalcClientBalance,
  recalcInvoice,
  optimizeRoute,
  haversineKm,
  getBillingSettings,
} from "../lib/helpers";
import { assessSkip } from "../lib/skipPolicy";
import { crewByJob, crewJobIdsFor, isOnJobCrew } from "../lib/jobCrew";
import { todayISO } from "../lib/invoiceNumbers";
import { createInvoiceForJob } from "../lib/invoiceFromJob";

const router: IRouter = Router();

router.use(requireAuth);

type JobRow = typeof jobsTable.$inferSelect;

// Exported for routes/client-activity.ts, which lists a customer's jobs
// (dispatched or not) in the same shape the board reads.
export async function hydrateJobs(rows: JobRow[]) {
  if (rows.length === 0) return [];
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const serviceIds = [...new Set(rows.map((r) => r.serviceId).filter((x): x is number => x != null))];
  const userIds = [...new Set(rows.map((r) => r.assignedToId).filter((x): x is number => x != null))];
  const jobIds = rows.map((r) => r.id);
  const csIds = [...new Set(rows.map((r) => r.clientServiceId).filter((x): x is number => x != null))];

  const [clients, services, users, products, latestInvoices, clientServices, clocked, crew] = await Promise.all([
    db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds)),
    serviceIds.length ? db.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds)) : Promise.resolve([]),
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : Promise.resolve([]),
    db.select().from(jobProductsTable).where(inArray(jobProductsTable.jobId, jobIds)),
    // The most recent bill per customer, for the dispatch board: "seeing prices
    // of job, and outstanding balance and last invoice balance". Account balance
    // answers "do they owe us anything"; the last invoice answers "what did we
    // last bill them", which is the one the crew get asked at the door. Void
    // invoices are excluded — they were cancelled, so they are not what was
    // last billed.
    clientIds.length
      ? db
          .selectDistinctOn([invoicesTable.clientId], {
            clientId: invoicesTable.clientId,
            number: invoicesTable.number,
            id: invoicesTable.id,
            total: invoicesTable.total,
            amountPaid: invoicesTable.amountPaid,
            invoiceDate: invoicesTable.invoiceDate,
            // Without the status, balanceOf cannot tell that a written-off
            // bill owes nothing, and the board told the crew at the door to
            // ask for money he had already decided to stop chasing.
            status: invoicesTable.status,
          })
          .from(invoicesTable)
          .where(and(inArray(invoicesTable.clientId, clientIds), ne(invoicesTable.status, "void")))
          .orderBy(invoicesTable.clientId, desc(invoicesTable.id))
      : Promise.resolve([]),
    // The must-read crew note lives on the assigned service with its date
    // range, and is looked up here rather than copied onto each visit so an
    // edit reaches every future visit at once.
    csIds.length
      ? db.select().from(clientServicesTable).where(inArray(clientServicesTable.id, csIds))
      : Promise.resolve([]),
    // Minutes clocked so far, for the board ("clocked 2.4 h") and for the
    // history on the account. Open entries are not counted until closed.
    db
      .select({
        jobId: jobTimeEntriesTable.jobId,
        minutes: sql<number>`coalesce(sum(extract(epoch from (${jobTimeEntriesTable.clockOutAt} - ${jobTimeEntriesTable.clockInAt})) / 60), 0)`,
        open: sql<number>`count(*) filter (where ${jobTimeEntriesTable.clockOutAt} is null)`,
      })
      .from(jobTimeEntriesTable)
      .where(inArray(jobTimeEntriesTable.jobId, jobIds))
      .groupBy(jobTimeEntriesTable.jobId),
    // The extra people on the stop. "Document crew member on clean ups" — the
    // board, the job card and the invoice question "who did this one" all need
    // more than the one name on assignedToId.
    crewByJob(jobIds),
  ]);

  const cMap = new Map(clients.map((c) => [c.id, c]));
  const invMap = new Map(latestInvoices.map((i) => [i.clientId, i]));
  const sMap = new Map(services.map((s) => [s.id, s]));
  const uMap = new Map(users.map((u) => [u.id, u]));
  const csMap = new Map(clientServices.map((cs) => [cs.id, cs]));
  const clockMap = new Map(clocked.map((c) => [c.jobId, c]));

  return rows.map((r) => {
    const c = cMap.get(r.clientId);
    const lastInvoice = invMap.get(r.clientId);
    return {
      ...r,
      clientName: c?.name ?? null,
      clientAddress: c?.serviceAddress ?? null,
      clientBalance: c?.accountBalance ?? null,
      lastInvoiceNumber: lastInvoice ? (lastInvoice.number ?? lastInvoice.id) : null,
      lastInvoiceBalance: lastInvoice ? balanceOf(lastInvoice) : null,
      lastInvoiceDate: lastInvoice?.invoiceDate ?? null,
      clientLat: c?.lat ?? null,
      clientLng: c?.lng ?? null,
      city: c?.city ?? null,
      lastServiceDate: c?.lastServiceDate ?? null,
      mapNote: r.mapNote ?? c?.mapNote ?? null,
      // Saved property details, keyed by field label — "Gate Code",
      // "Sprinkler Zones", "Turf Sqft". Reported by a sub: the gate code was on
      // the client page but not on his job card, so he had to ring the office
      // from the driveway. These are facts about the property the person
      // standing at it needs, and there is nothing financial in here, so the
      // whole map goes rather than a hand-picked list of labels — a new detail
      // Adam adds tomorrow should reach the crew without a code change.
      clientPropertyData: (c?.propertyData ?? {}) as Record<string, string>,
      // What the board and waiting list filter and email by. The email is here
      // so a row can say "no email" before a bulk send, not after it.
      clientEmail: c?.email ?? null,
      clientPhone: c?.phone ?? null,
      clientDoNotEmail: c?.doNotEmail ?? false,
      clientMapCode: c?.mapCode ?? null,
      clientState: c?.state ?? null,
      clientTags: (c?.tags ?? []) as string[],
      serviceName: r.serviceId ? (sMap.get(r.serviceId)?.name ?? null) : null,
      serviceCode: r.serviceId
        ? (sMap.get(r.serviceId)?.code ?? sMap.get(r.serviceId)?.externalId ?? null)
        : null,
      // The short name he set on the person, never the account name — which
      // for a contractor who signed up by email is the email address.
      assignedToName: r.assignedToId ? contractorLabel(uMap.get(r.assignedToId)) : null,
      // Everyone else on the job, the lead excluded. A clean-up with Disa
      // leading and Gabe and Spencer along reads "Disa +2" on the board, and
      // the stop is on all three of their phones.
      crew: crew.get(r.id) ?? [],
      products: products.filter((p) => p.jobId === r.id),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      skippedAt: r.skippedAt ? r.skippedAt.toISOString() : null,
      cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
      // The crew note in force on this visit's day, if any. Start is locked on
      // the job card until it has been opened (noteAcknowledgedAt).
      contractorNote: contractorNoteFor(r.clientServiceId ? csMap.get(r.clientServiceId) : null, r.scheduledDate),
      noteAcknowledgedAt: r.noteAcknowledgedAt ? r.noteAcknowledgedAt.toISOString() : null,
      clockedMinutes: Math.round(Number(clockMap.get(r.id)?.minutes ?? 0) * 10) / 10,
      clockOpen: Number(clockMap.get(r.id)?.open ?? 0) > 0,
      discountAmount: discountAmountFor(r.amount, r.discountType, r.discountValue),
    };
  });
}

function contractorLabel(u: { name: string; displayName?: string | null } | undefined) {
  if (!u) return null;
  return u.displayName?.trim() || u.name;
}

/**
 * The client-side filters the board and the waiting list share: branch (his
 * word for the client's state), map code, a tag, and a name-or-address search.
 * Done as a subquery on clients so a board of four hundred jobs is filtered in
 * Postgres rather than hydrated and thrown away.
 */
function clientFilterConds(q: Record<string, string | undefined>): SQL[] {
  const conds: SQL[] = [];
  if (q.mapCode?.trim()) conds.push(ilike(clientsTable.mapCode, q.mapCode.trim()));
  if (q.branch?.trim()) conds.push(ilike(clientsTable.state, q.branch.trim()));
  if (q.city?.trim()) conds.push(ilike(clientsTable.city, q.city.trim()));
  if (q.tag?.trim()) {
    // Tags are stored lowercase (see clients.tags), so the query is too.
    const tag = q.tag.trim().toLowerCase();
    conds.push(sql`exists (select 1 from jsonb_array_elements_text(${clientsTable.tags}) t where t = ${tag})`);
  }
  if (q.search?.trim()) {
    const like = `%${q.search.trim()}%`;
    conds.push(or(ilike(clientsTable.name, like), ilike(clientsTable.serviceAddress, like))!);
  }
  /**
   * "Dispatch board — columns search using custom fields."
   *
   * The custom fields are the ones he keeps in Settings (Turf Sqft, Gate Code,
   * Sprinkler Zones) and they live on the customer as one JSON document keyed
   * by the field's label. `fieldLabel` alone means "only customers who have
   * this filled in", which is the question behind half of them: who have I not
   * measured yet.
   *
   * The label is matched without case because the label he types in Settings
   * and the key saved on a customer years ago are not always capitalised the
   * same, and a filter that silently matches nothing looks like missing data.
   *
   * fieldMin/fieldMax strip everything but digits off the value first: a sqft
   * typed as "6,200" or "6200 sq ft" is a number he means to compare, and
   * refusing to compare it would make the filter useless on real data.
   *
   * What is left has to still look like one number before it is compared. Some
   * of the 709 came over from Service Autopilot with a range in the box —
   * "5000-6000", "4,500 - 5,000", a lone dash where somebody meant n/a — and
   * handing that to Postgres as a number used to kill the whole query, so the
   * board came back empty instead of showing the lawns that DO have a number.
   * A value that is not one number counts as nothing usable here and drops out
   * of the comparison, the same answer numericFieldValue gives in the pricing
   * code — one stored value must not mean two different things.
   */
  if (q.fieldLabel?.trim()) {
    const label = q.fieldLabel.trim();
    const value = q.fieldValue?.trim();
    const min = q.fieldMin?.trim() ? Number(q.fieldMin) : null;
    const max = q.fieldMax?.trim() ? Number(q.fieldMax) : null;
    const cleaned = sql`regexp_replace(pd.value, '[^0-9.-]', '', 'g')`;
    const num = sql`case when ${cleaned} ~ '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
            then ${cleaned}::double precision end`;
    const extra: SQL[] = [];
    if (value) extra.push(sql`pd.value ilike ${`%${value}%`}`);
    if (min != null && Number.isFinite(min)) extra.push(sql`${num} >= ${min}`);
    if (max != null && Number.isFinite(max)) extra.push(sql`${num} <= ${max}`);
    conds.push(
      sql`exists (select 1 from jsonb_each_text(${clientsTable.propertyData}) pd
            where lower(pd.key) = lower(${label}) and btrim(pd.value) <> ''
            ${extra.length ? sql.join([sql`and`, sql.join(extra, sql` and `)], sql` `) : sql``})`,
    );
  }
  if (conds.length === 0) return [];
  return [inArray(jobsTable.clientId, db.select({ id: clientsTable.id }).from(clientsTable).where(and(...conds)))];
}

const hasNotesCond = () => and(sql`${jobsTable.notes} is not null`, ne(jobsTable.notes, ""))!;

/**
 * "My" jobs: the ones I lead, plus the ones I was added to as crew.
 *
 * One condition rather than two queries stitched together, so route order,
 * paging and the date filters all keep working on the one statement.
 */
const mineOrCrew = (userId: number): SQL =>
  or(eq(jobsTable.assignedToId, userId), inArray(jobsTable.id, crewJobIdsFor(userId)))!;

router.get("/waiting-list", requireAdmin, async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const { date, from, to } = q;
  const conds: SQL[] = [eq(jobsTable.dispatched, false)];
  // A waiting-list job is only "waiting" while the date being looked at sits
  // inside its window. `window=past` is the other list he asked for: windows
  // that closed without the job going out, so the batch can be cancelled.
  if (q.window === "past") {
    // Our day, not the server's. On UTC the clock rolls over at five in the
    // afternoon here, and an evening tidy-up would list — and Cancel would
    // cancel — every job whose window is still open today.
    const today = todayISO();
    conds.push(sql`${jobsTable.windowEnd} is not null`, sql`${jobsTable.windowEnd} < ${today}`);
  } else if (date) {
    conds.push(lte(jobsTable.windowStart, date), gte(jobsTable.windowEnd, date));
  }
  if (from) conds.push(gte(jobsTable.windowEnd, from));
  if (to) conds.push(lte(jobsTable.windowStart, to));
  if (q.status) conds.push(eq(jobsTable.status, q.status));
  // Cancelled and completed jobs are not waiting for anything.
  else conds.push(sql`${jobsTable.status} not in ('cancelled', 'completed')`);
  if (q.serviceId) conds.push(eq(jobsTable.serviceId, Number(q.serviceId)));
  if (q.assignedTo) conds.push(eq(jobsTable.assignedToId, Number(q.assignedTo)));
  if (q.hasNotes === "true") conds.push(hasNotesCond());
  conds.push(...clientFilterConds(q));
  const rows = await db
    .select()
    .from(jobsTable)
    .where(and(...conds))
    .orderBy(asc(jobsTable.windowStart), asc(jobsTable.id));
  return res.json(await hydrateJobs(rows));
});

router.get("/jobs", requireAdmin, async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const conds = [eq(jobsTable.dispatched, true)];
  if (q.date) conds.push(eq(jobsTable.scheduledDate, q.date));
  if (q.from) conds.push(gte(jobsTable.scheduledDate, q.from));
  if (q.to) conds.push(lte(jobsTable.scheduledDate, q.to));
  if (q.assignedTo) conds.push(eq(jobsTable.assignedToId, Number(q.assignedTo)));
  if (q.status) conds.push(eq(jobsTable.status, q.status));
  if (q.serviceId) conds.push(eq(jobsTable.serviceId, Number(q.serviceId)));
  if (q.clientId) conds.push(eq(jobsTable.clientId, Number(q.clientId)));
  if (q.hasNotes === "true") conds.push(hasNotesCond());
  conds.push(...clientFilterConds(q));
  // Day first, then route order: the board takes a date range now (the 15th
  // to the 17th), and a range sorted by route order alone interleaves the days.
  const rows = await db
    .select()
    .from(jobsTable)
    .where(and(...conds))
    .orderBy(asc(jobsTable.scheduledDate), asc(jobsTable.routeOrder), asc(jobsTable.id));
  return res.json(await hydrateJobs(rows));
});

router.post("/jobs", requireAdmin, async (req, res) => {
  const body = CreateJobBody.parse(req.body);
  const dispatched = !!body.scheduledDate;
  // A one-off job on a time-billed service (a clean-up added straight to the
  // board) is priced from the clock like any other visit of that service.
  let billing: { billingMode: string; hourlyRate: number | null } = { billingMode: "fixed", hourlyRate: null };
  if (body.serviceId != null) {
    const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, body.serviceId));
    if (svc?.billingMode === "time") billing = { billingMode: "time", hourlyRate: svc.rate };
  }
  const [job] = await db
    .insert(jobsTable)
    .values({ ...body, ...billing, dispatched, notesImportant: body.notesImportant ?? false })
    .returning();
  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "job_created",
    description: `Created job #${job.id}${job.scheduledDate ? ` for ${job.scheduledDate}` : ""}`,
  });
  return res.status(201).json((await hydrateJobs([job]))[0]);
});

router.post("/jobs/dispatch", requireAdmin, async (req, res) => {
  const body = DispatchJobsBody.parse(req.body);
  if (body.jobIds.length === 0) return res.json([]);
  const set: Record<string, unknown> = { dispatched: true, scheduledDate: body.date };
  if (body.assignedToId != null) set.assignedToId = body.assignedToId;
  const rows = await db.update(jobsTable).set(set).where(inArray(jobsTable.id, body.jobIds)).returning();
  for (const j of rows) {
    await logAudit({
      clientId: j.clientId,
      actorName: req.appUser?.name,
      action: "job_dispatched",
      description: `Dispatched job #${j.id} to ${body.date}`,
    });
  }
  return res.json(await hydrateJobs(rows));
});

// contractor endpoints
router.get("/my/jobs", async (req, res) => {
  const { date, from, to } = req.query as Record<string, string | undefined>;
  const conds = [
    // Mine if I am the lead, or if I was put on the crew. "Add crew members to
    // day" is only half done if the second man on the clean-up still has an
    // empty list on his phone and has to ring the office to find out where to
    // turn up.
    mineOrCrew(req.appUser!.id),
    eq(jobsTable.dispatched, true),
    eq(jobsTable.visibleToContractor, true),
    // Called off by the office: not a stop on anybody's route.
    ne(jobsTable.status, "cancelled"),
  ];
  if (date) conds.push(eq(jobsTable.scheduledDate, date));
  if (from) conds.push(gte(jobsTable.scheduledDate, from));
  if (to) conds.push(lte(jobsTable.scheduledDate, to));
  // Day, then whose run it is, then the stop number. A stop number only means
  // anything inside one lead's one day, so on a day where Gabe leads two of his
  // own stops and rides along on two of Disa's, sorting on the number alone
  // shuffles her stops in among his — two 1s and two 2s that mean nothing
  // together. His own run stays in one piece and hers stays in one piece.
  const rows = await db
    .select()
    .from(jobsTable)
    .where(and(...conds))
    .orderBy(
      asc(jobsTable.scheduledDate),
      asc(jobsTable.assignedToId),
      asc(jobsTable.routeOrder),
      asc(jobsTable.id),
    );
  return res.json(await hydrateJobs(rows));
});

router.get("/my/route", async (req, res) => {
  const date = String(req.query.date ?? "");
  if (!date) return res.status(400).json({ error: "date is required" });
  const user = req.appUser!;
  const rows = await db
    .select()
    .from(jobsTable)
    .where(
      and(
        // Same rule as /my/jobs: a crew member drives the same route as the
        // lead, so he gets the same list of stops.
        mineOrCrew(user.id),
        eq(jobsTable.dispatched, true),
        eq(jobsTable.scheduledDate, date),
        eq(jobsTable.visibleToContractor, true),
      ),
    )
    .orderBy(asc(jobsTable.assignedToId), asc(jobsTable.routeOrder), asc(jobsTable.id));
  const jobs = await hydrateJobs(rows);

  const withCoords = jobs.filter((j) => j.clientLat != null && j.clientLng != null);
  const withoutCoords = jobs.filter((j) => j.clientLat == null || j.clientLng == null);

  const hasBase = user.baseLat != null && user.baseLng != null;
  const optimized = hasBase && withCoords.length > 0;

  let ordered = jobs;
  let totalDistanceKm = 0;
  // distance (km) from each ordered job with coordinates to the next stop; null when unknown
  const legKm = new Map<number, number>();
  if (optimized) {
    const base = { lat: user.baseLat!, lng: user.baseLng! };
    const pts = withCoords.map((j) => ({ lat: j.clientLat!, lng: j.clientLng! }));
    const order = optimizeRoute(base, pts);
    const orderedCoords = order.map((i) => withCoords[i]);
    ordered = [...orderedCoords, ...withoutCoords];
    let cur = base;
    let prevId: number | null = null; // base handled separately below
    for (const j of orderedCoords) {
      const d = haversineKm(cur.lat, cur.lng, j.clientLat!, j.clientLng!);
      totalDistanceKm += d;
      if (prevId === null) {
        legKm.set(-1, d); // leg from base to first job
      } else {
        legKm.set(prevId, d);
      }
      prevId = j.id;
      cur = { lat: j.clientLat!, lng: j.clientLng! };
    }
  } else {
    // deterministic dispatch order: whose run it is, then routeOrder (nulls
    // last), then id. Grouping by the lead first for the same reason /my/jobs
    // does: stop 1 of Disa's day and stop 1 of his own are not the same stop 1,
    // so a man who leads some stops and rides along on others gets his own run
    // in one piece instead of the two interleaved.
    ordered = [...jobs].sort(
      (a, b) =>
        (a.assignedToId ?? Number.MAX_SAFE_INTEGER) - (b.assignedToId ?? Number.MAX_SAFE_INTEGER) ||
        (a.routeOrder ?? Number.MAX_SAFE_INTEGER) - (b.routeOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.id - b.id,
    );
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const jobStops = ordered.map((j, i) => ({
    order: optimized ? i + 2 : i + 1,
    type: "job" as const,
    jobId: j.id,
    name: j.clientName ?? j.serviceName ?? `Job #${j.id}`,
    clientName: j.clientName ?? null,
    address: j.clientAddress ?? null,
    lat: j.clientLat ?? null,
    lng: j.clientLng ?? null,
    hasCoordinates: j.clientLat != null && j.clientLng != null,
    distanceToNextKm: legKm.has(j.id) ? round1(legKm.get(j.id)!) : null,
  }));

  const stops = optimized
    ? [
        {
          order: 1,
          type: "base" as const,
          jobId: null,
          name: "Home Base",
          clientName: null,
          address: user.baseAddress ?? null,
          lat: user.baseLat ?? null,
          lng: user.baseLng ?? null,
          hasCoordinates: true,
          distanceToNextKm: legKm.has(-1) ? round1(legKm.get(-1)!) : null,
        },
        ...jobStops,
      ]
    : jobStops;

  return res.json({
    baseAddress: user.baseAddress ?? null,
    totalDistanceKm: round1(totalDistanceKm),
    optimized,
    stops,
  });
});

/**
 * Central contractor access predicate: contractors may only touch jobs that
 * are assigned to them, dispatched, and visible to contractors. Admins are
 * unrestricted.
 *
 * A crew member counts as assigned. Put a second man on a clean-up and he can
 * read the card, open the must-read note and add his extra work, the same as
 * the lead — otherwise "add crew members to day" hands him a stop he is
 * locked out of. The crew lookup is a round trip, so it is only taken when the
 * cheap checks have already said no.
 */
async function canAccessJob(
  req: { appUser?: { id: number; role: string } },
  job: JobRow,
): Promise<boolean> {
  if (req.appUser?.role === "admin") return true;
  if (!req.appUser || job.dispatched !== true || job.visibleToContractor !== true) return false;
  if (job.assignedToId === req.appUser.id) return true;
  return isOnJobCrew(req.appUser.id, job.id);
}

router.get("/my/offerable-services", async (_req, res) => {
  const rows = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.contractorOfferable, true))
    .orderBy(asc(servicesTable.name));
  return res.json(
    rows.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      price: s.contractorPrice ?? s.rate,
    })),
  );
});

router.post("/my/jobs/:id/extra-work", async (req, res) => {
  const body = AddExtraWorkBody.parse(req.body);
  const jobId = Number(req.params.id);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!(await canAccessJob(req, job))) return res.status(403).json({ error: "Forbidden" });

  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, body.serviceId));
  // Contractors may only add services the office has approved for field offers
  if (!svc || !svc.contractorOfferable) {
    return res.status(400).json({ error: "This service is not available to offer on site" });
  }
  const quantity = body.quantity ?? 1;
  const price = svc.contractorPrice ?? svc.rate;

  // Lock the job so a concurrent completion can't invoice while we add work
  const product = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!locked || locked.status === "completed") return null;
    const [p] = await tx
      .insert(jobProductsTable)
      .values({ jobId, serviceId: svc.id, name: svc.name, price, quantity })
      .returning();
    return p;
  });
  if (!product) {
    return res.status(400).json({ error: "Job is completed and invoiced; work can no longer be added" });
  }
  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "extra_work_added",
    description: `Added on-site extra work "${svc.name}" (${quantity} × $${price}) to job #${jobId}`,
  });
  return res.status(201).json(product);
});

router.post("/my/jobs/:id/payments", async (req, res) => {
  const body = RecordOnSitePaymentBody.parse(req.body);
  const jobId = Number(req.params.id);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) return res.status(404).json({ error: "Job not found" });
  // Contractors can only take payment for jobs assigned to them
  if (!(await canAccessJob(req, job))) return res.status(403).json({ error: "Forbidden" });

  const settings = await getBillingSettings();
  const applyFee = body.method === "credit_card" && settings.cardFeeEnabled && settings.cardFeePercent > 0;
  const baseAmount = Math.round(body.amount * 100) / 100;
  const cardFee = applyFee ? Math.round(baseAmount * settings.cardFeePercent) / 100 : 0;
  const total = Math.round((baseAmount + cardFee) * 100) / 100;

  const feeNote = applyFee
    ? `Includes $${cardFee.toFixed(2)} card processing fee (${settings.cardFeePercent}%).`
    : null;
  const notes = [body.notes, feeNote].filter(Boolean).join(" ") || null;

  // Lock the job row so payment recording serializes with completion: we either
  // see the completion invoice (and attach to it) or insert before completion
  // commits, in which case completion's own pass attaches this payment.
  const payment = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!locked) return null;
    // Attach to the job's invoice when it exists, belongs to the client, and isn't void
    let invoice: typeof invoicesTable.$inferSelect | null = null;
    if (locked.invoiceId != null) {
      // Locked, not just read: we are about to change its total and its paid
      // figure, and an office payment on the same invoice must not interleave.
      const [inv] = await tx
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, locked.invoiceId))
        .for("update");
      if (inv && inv.clientId === locked.clientId && inv.status !== "void") invoice = inv;
    }
    // The card surcharge is a real charge: add it to the invoice total so
    // amountPaid and the customer balance reconcile to the disclosed amount.
    if (invoice && cardFee > 0) {
      await tx
        .update(invoicesTable)
        .set({ total: Math.round((invoice.total + cardFee) * 100) / 100 })
        .where(eq(invoicesTable.id, invoice.id));
    }
    const [p] = await tx
      .insert(paymentsTable)
      .values({
        clientId: locked.clientId,
        invoiceId: invoice?.id ?? null,
        jobId,
        amount: total,
        cardFee,
        method: body.method,
        reference: body.reference ?? null,
        notes,
      })
      .returning();
    // Same transaction as the insert: the payment and every figure derived from
    // it must commit together, or a crash in between leaves the invoice and the
    // client balance permanently understating what the contractor collected.
    if (p.invoiceId) await recalcInvoice(p.invoiceId, tx);
    await recalcClientBalance(p.clientId, tx);
    return p;
  });
  if (!payment) return res.status(404).json({ error: "Job not found" });
  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "payment_recorded",
    description: `On-site payment of $${total} via ${body.method} for job #${jobId}${feeNote ? ` — ${feeNote}` : ""}`,
  });
  return res.status(201).json({
    ...payment,
    createdAt: payment.createdAt.toISOString(),
    baseAmount,
    cardFee,
    cardFeePercent: applyFee ? settings.cardFeePercent : null,
  });
});

router.get("/jobs/:id", async (req, res) => {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, Number(req.params.id)));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!(await canAccessJob(req, job))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return res.json((await hydrateJobs([job]))[0]);
});

router.patch("/jobs/:id", async (req, res) => {
  const body = UpdateJobBody.parse(req.body);
  if (body.status === "completed") {
    // Completion must go through POST /jobs/:id/complete so invoicing stays atomic
    return res.status(400).json({ error: "Use the complete endpoint to finish a job" });
  }
  // A date box hands over a value for every keystroke, and a half-typed year
  // ("0002-09-16") reads as a perfectly good date. Saved, the job sits in year
  // 2 where no board and no list will ever show it again.
  if (
    body.scheduledDate != null &&
    !(/^\d{4}-\d{2}-\d{2}$/.test(body.scheduledDate) && body.scheduledDate >= "2000-01-01" && body.scheduledDate <= "2100-12-31")
  ) {
    return res.status(400).json({ error: "That date does not look right. Use yyyy-mm-dd, year 2000 or later." });
  }
  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, Number(req.params.id)));
  if (!existing) return res.status(404).json({ error: "Job not found" });

  const isAdmin = req.appUser!.role === "admin";
  if (!isAdmin) {
    // contractors may only update the status of their own visible, dispatched jobs
    if (!(await canAccessJob(req, existing))) return res.status(403).json({ error: "Forbidden" });
    const keys = Object.keys(body);
    // skipReason travels with status: skipped since the contractor on site is the
    // one who knows why — but it must never become a general-purpose notes field.
    if (keys.some((k) => k !== "status" && k !== "skipReason")) {
      return res.status(403).json({ error: "Contractors can only update job status" });
    }
    // Calling a visit off is the office's decision. A crew that cannot do the
    // work skips it, with a reason, and the office decides what happens next.
    if (body.status === "cancelled") {
      return res.status(403).json({ error: "Only the office can cancel a job" });
    }
    // The must-read note: nobody starts the job until they have opened it.
    // "Bring the sprinkler key" is no use read after the drive home.
    if (body.status === "in_progress" && !existing.noteAcknowledgedAt && existing.clientServiceId) {
      const [cs] = await db.select().from(clientServicesTable).where(eq(clientServicesTable.id, existing.clientServiceId));
      if (contractorNoteFor(cs, existing.scheduledDate)) {
        return res.status(400).json({ error: "Open the note on this job before starting it" });
      }
    }
  }

  const update: typeof body & {
    skippedAt?: Date | null;
    skipBillable?: boolean | null;
    cancelledAt?: Date | null;
    amountOverridden?: boolean;
  } = { ...body };
  // The office typing a price on a time-billed job is the "adjusted
  // afterwards" step: from here the clock no longer sets the amount.
  if (body.amount !== undefined && body.amount !== existing.amount && existing.billingMode === "time") {
    update.amountOverridden = true;
  }
  let skipAssessment: Awaited<ReturnType<typeof assessSkip>> | null = null;
  if (body.status === "skipped") {
    const skippedAt = new Date();
    update.skippedAt = skippedAt;
    // Assessed once, at the moment of the skip, and stored. See skipPolicy.ts
    // for why this is not recomputed on read.
    skipAssessment = await assessSkip(existing.clientId, existing.id, skippedAt);
    update.skipBillable = skipAssessment.billable;
  } else if (body.status && existing.status === "skipped") {
    // Moving off skipped (e.g. rescheduled) retires the old reason so it doesn't
    // linger and get mistaken for the reason behind whatever happens next.
    update.skipReason = null;
    update.skippedAt = null;
    update.skipBillable = null;
  }
  if (body.status === "cancelled") {
    update.cancelledAt = new Date();
  } else if (body.status && existing.status === "cancelled") {
    // Same as coming off skipped: a job put back on the board starts clean.
    update.cancelReason = null;
    update.cancelledAt = null;
  }

  const [job] = await db
    .update(jobsTable)
    .set(update)
    .where(eq(jobsTable.id, Number(req.params.id)))
    .returning();
  if (body.status && body.status !== existing.status) {
    await logAudit({
      clientId: job.clientId,
      actorName: req.appUser?.name,
      action: "job_status",
      description:
        body.status === "skipped"
          ? `Job #${job.id} status changed to skipped${body.skipReason ? ` — ${body.skipReason}` : ""}` +
            (skipAssessment ? ` (${skipAssessment.billable ? "chargeable" : "free"} skip)` : "")
          : body.status === "cancelled"
            ? `Cancelled job #${job.id}${body.cancelReason ? ` — ${body.cancelReason}` : ""}`
            : `Job #${job.id} status changed to ${body.status.replace(/_/g, " ")}`,
    });
  }
  const hydrated = (await hydrateJobs([job]))[0];
  // The skip verdict rides back on the response so the person who just clicked
  // Skip is told, on the spot, whether it costs the customer anything. Finding
  // out at invoicing time is how a disputed charge starts.
  return res.json(skipAssessment ? { ...hydrated, skipNotice: skipAssessment.message } : hydrated);
});

router.delete("/jobs/:id", requireAdmin, async (req, res) => {
  await db.delete(jobsTable).where(eq(jobsTable.id, Number(req.params.id)));
  return res.status(204).end();
});

router.post("/jobs/:id/complete", async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Job not found" });
  if (!(await canAccessJob(req, existing))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (existing.status === "completed") {
    return res.json((await hydrateJobs([existing]))[0]);
  }
  // A skipped visit did no work — invoicing it would bill for a no-show. The
  // office must explicitly move it off "skipped" (e.g. reschedule) before it
  // can ever be completed.
  if (existing.status === "skipped") {
    return res.status(400).json({ error: "This job was skipped and cannot be completed. Reschedule it first." });
  }
  // Same for a cancelled one: the office called it off, nobody did the work.
  if (existing.status === "cancelled") {
    return res.status(400).json({ error: "This job was cancelled and cannot be completed. Put it back on the board first." });
  }

  // Atomic completion: lock the job row, re-check status, and create the
  // invoice inside one transaction so concurrent requests can't double-invoice.
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, id))
      .for("update");
    if (!locked) return null;
    if (locked.status === "completed") return { job: locked, invoice: null };
    if (locked.status === "skipped" || locked.status === "cancelled") {
      return { job: locked, invoice: null, skipped: true as const };
    }

    const products = await tx.select().from(jobProductsTable).where(eq(jobProductsTable.jobId, id));
    const productTotal = products.reduce((s, p) => s + p.price * p.quantity, 0);
    // fold card surcharges from payments collected before completion into the invoice total
    const pendingPayments = await tx
      .select()
      .from(paymentsTable)
      .where(and(eq(paymentsTable.jobId, id), isNull(paymentsTable.invoiceId)));
    const pendingFees = pendingPayments.reduce((s, p) => s + p.cardFee, 0);

    // A time-billed job is priced from the clock: every closed entry on the
    // job, all crew, added up. The office can still set the number by hand
    // (amountOverridden) — that is his "price adjusted afterwards". Nothing
    // clocked at all bills the budgeted estimate rather than $0, and says so
    // on the invoice.
    let serviceAmount = locked.amount;
    let billedHours: number | null = null;
    let noTimeNote: string | null = null;
    if (locked.billingMode === "time" && locked.hourlyRate != null) {
      const entries = await tx.select().from(jobTimeEntriesTable).where(eq(jobTimeEntriesTable.jobId, id));
      if (entries.some((e) => e.clockOutAt == null)) {
        return { job: locked, invoice: null, stillClocked: true as const };
      }
      const minutes = entries.reduce((s, e) => s + (e.clockOutAt!.getTime() - e.clockInAt.getTime()) / 60000, 0);
      if (!locked.amountOverridden) {
        if (minutes > 0) {
          billedHours = Math.round((minutes / 60) * 100) / 100;
          serviceAmount = Math.round(billedHours * locked.hourlyRate * 100) / 100;
        } else {
          noTimeNote = "No time was clocked on this job; billed at the budgeted hours. Adjust before sending.";
        }
      }
    }
    // The discount is the one on the assigned service, so it comes off the
    // service and not off the parts and fees: 10% off a $50 mow is $5,
    // whatever bags went with it. That is the figure the board and the
    // account page have been showing all along.
    const discount = discountAmountFor(serviceAmount, locked.discountType, locked.discountValue);
    const total = Math.round((serviceAmount + productTotal + pendingFees - discount) * 100) / 100;

    let serviceName: string | null = null;
    let invoiceDescription: string | null = null;
    if (locked.serviceId) {
      const [svc] = await tx.select().from(servicesTable).where(eq(servicesTable.id, locked.serviceId));
      serviceName = svc?.name ?? null;
      invoiceDescription = svc?.invoiceDescription?.trim() || null;
    }

    const invoice = await createInvoiceForJob(tx, {
      clientId: locked.clientId,
      jobId: id,
      serviceAmount,
      serviceName,
      invoiceDescription,
      serviceDate: locked.scheduledDate,
      products: products.map((p) => ({ name: p.name, price: p.price, quantity: p.quantity })),
      pendingFees,
      timeBilled: billedHours != null && locked.hourlyRate != null ? { hours: billedHours, hourlyRate: locked.hourlyRate } : null,
      discount: discount > 0 ? { label: locked.discountLabel?.trim() || "Discount", amount: discount } : null,
      note: noTimeNote,
    });

    // Attach any on-site payments collected before completion to the new invoice
    await tx
      .update(paymentsTable)
      .set({ invoiceId: invoice.id })
      .where(and(eq(paymentsTable.jobId, id), isNull(paymentsTable.invoiceId)));

    const today = new Date().toISOString().slice(0, 10);
    const [job] = await tx
      .update(jobsTable)
      .set({ status: "completed", completedAt: new Date(), invoiceId: invoice.id, amount: serviceAmount })
      .where(eq(jobsTable.id, id))
      .returning();

    await tx.update(clientsTable).set({ lastServiceDate: today }).where(eq(clientsTable.id, locked.clientId));
    // Reflect the pre-completion payments just attached above, before this
    // commits. Done outside the transaction, a failure here would leave the job
    // invoiced but the invoice and balance showing nothing paid.
    await recalcInvoice(invoice.id, tx);
    await recalcClientBalance(locked.clientId, tx);
    return { job, invoice };
  });

  if (!result) return res.status(404).json({ error: "Job not found" });
  if ("skipped" in result && result.skipped) {
    // Lost the race: a concurrent request skipped this job after our pre-lock
    // check but before we took the row lock. Same rule applies — no invoice.
    return res.status(400).json({ error: "This job was skipped and cannot be completed. Reschedule it first." });
  }
  if ("stillClocked" in result && result.stillClocked) {
    // Time is money on this one, literally: closing the job with the clock
    // running would bill the hours so far and lose the rest.
    return res.status(400).json({ error: "Someone is still clocked in on this job. Clock out first so the hours are billed." });
  }
  if (result.invoice) {
    await logAudit({
      clientId: result.job.clientId,
      actorName: req.appUser?.name,
      action: "job_completed",
      description:
        `Completed job #${id}; invoice #${result.invoice.id} for $${result.invoice.total}` +
        (result.job.billingMode === "time" && !result.job.amountOverridden
          ? ` (billed from the clock at $${result.job.hourlyRate}/hr)`
          : "") +
        (result.job.discountValue ? `, less ${result.job.discountLabel ?? "discount"}` : ""),
    });
  }
  return res.json((await hydrateJobs([result.job]))[0]);
});

router.post("/jobs/:id/products", async (req, res) => {
  const body = AddJobProductBody.parse(req.body);
  const jobId = Number(req.params.id);
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!(await canAccessJob(req, job))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (job.status === "completed") {
    return res.status(400).json({ error: "Job is completed and invoiced; products can no longer be changed" });
  }
  // Lock the job row and recheck status in the same transaction so a
  // concurrent completion can't invoice while we add a product.
  // A preset picked from the parts list supplies the name and price; free
  // text stays open to the office for the one-off part nobody listed.
  let name = body.name?.trim() ?? "";
  let price = body.price ?? 0;
  let chargePresetId: number | null = null;
  if (body.presetId != null) {
    const [preset] = await db
      .select()
      .from(chargePresetsTable)
      .where(and(eq(chargePresetsTable.id, body.presetId), eq(chargePresetsTable.kind, "product")));
    if (!preset) return res.status(400).json({ error: "That part is no longer on the list" });
    // The crew reaches this route from their own job too, so the office-only
    // rule has to hold here as well — otherwise a $120 valve lands on the
    // customer's invoice from a phone.
    if (req.appUser?.role !== "admin" && !preset.contractorCanAdd) {
      return res.status(400).json({ error: "That part is not on the list you can add on site" });
    }
    name = preset.label;
    price = preset.defaultPrice;
    chargePresetId = preset.id;
  } else if (!name || body.price == null) {
    return res.status(400).json({ error: "Pick a part from the list, or type a name and a price" });
  }
  if (!((body.quantity ?? 1) > 0)) return res.status(400).json({ error: "Quantity must be more than zero" });
  const product = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId)).for("update");
    if (!locked || locked.status === "completed") return null;
    const [p] = await tx
      .insert(jobProductsTable)
      .values({ jobId, name, price, quantity: body.quantity ?? 1, chargePresetId })
      .returning();
    return p;
  });
  if (!product) {
    return res.status(400).json({ error: "Job is completed and invoiced; products can no longer be changed" });
  }
  return res.status(201).json(product);
});

router.delete("/job-products/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [product] = await db.select().from(jobProductsTable).where(eq(jobProductsTable.id, id));
  if (!product) return res.status(204).end();
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, product.jobId));
  if (!job) return res.status(204).end();
  if (!(await canAccessJob(req, job))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (job.status === "completed") {
    return res.status(400).json({ error: "Job is completed and invoiced; products can no longer be changed" });
  }
  const deleted = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobsTable).where(eq(jobsTable.id, product.jobId)).for("update");
    if (!locked || locked.status === "completed") return false;
    await tx.delete(jobProductsTable).where(eq(jobProductsTable.id, id));
    return true;
  });
  if (!deleted) {
    return res.status(400).json({ error: "Job is completed and invoiced; products can no longer be changed" });
  }
  return res.status(204).end();
});

export default router;
