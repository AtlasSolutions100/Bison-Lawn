import { db, clientServicesTable, estimateFieldsTable, jobsTable, packagesTable, servicesTable } from "@workspace/db";
import type { ClientService, Estimate, EstimateLine, PackageItem, Service, ServicePackage } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { logAudit, roundMoney } from "./helpers";
import { cadenceLabel, generateJobs, MAX_GENERATED_JOBS, rollDateOneYear, todayLocal, weekdayOf } from "./jobGeneration";
import { addDaysISO } from "./weatherCheck";
import { estimateLineVisitAmount, scheduleAcceptedEstimate, type ScheduledFromEstimate } from "./schedulingRules";

/**
 * What happens on the account when a customer says yes.
 *
 * 2026-09-15 walkthrough: in his old CRM an accepted estimate put the quoted
 * services on the customer's account as assigned services, and the office
 * scheduled from there. Here every accepted service line becomes one
 * client_services row — the same row the account page's Assigned Services
 * panel edits — carrying the package it came from, the per-visit price the
 * matrix gave, and how many visits were sold. The scheduling rules (what
 * happens automatically when an estimate is accepted) still decide whether a
 * first visit goes straight on the board, and that job is filed under the new
 * row so the account shows it. A season of mowing then gets the rest of its
 * visits, weekly from the day the rule chose, so the board reads the way the
 * customer bought it.
 *
 * What was sold is the fence in both directions: as many visits as were paid
 * for, and never past the season the service or the package runs in — no mows
 * in December, and no season that closed last October. Work an outside company
 * performs stays off the board entirely.
 *
 * Nothing here may break the acceptance: the caller has already recorded the
 * customer's yes, and a row that could not be created is the office's problem,
 * logged for them to see.
 */

export type AssignedFromEstimate = {
  clientServiceId: number;
  lineIndex: number;
  serviceName: string;
  visits: number;
  /** Visits put on the board beyond the one the scheduling rule made. */
  extraVisits: number;
};

export type AcceptedEstimateOutcome = {
  assigned: AssignedFromEstimate[];
  scheduled: ScheduledFromEstimate[];
};

type AcceptedServiceLine = { line: EstimateLine & { serviceId: number }; index: number };

/** The accepted lines that name a service, with their index into `lines`. */
export function acceptedServiceLines(estimate: Pick<Estimate, "lines" | "acceptedLines">): AcceptedServiceLine[] {
  const accepted = estimate.acceptedLines as number[] | null;
  return (estimate.lines as EstimateLine[])
    .map((line, index) => ({ line, index }))
    .filter(({ index }) => accepted === null || accepted.includes(index))
    .filter((entry): entry is AcceptedServiceLine => entry.line.serviceId != null)
    // "0 visits" is how he keeps a service on the quote as a talking point at
    // no charge. Nobody bought it, so it must not land on the account priced
    // at a visit the customer never saw a figure for.
    .filter(({ line }) => (line.visits ?? 1) !== 0);
}

/**
 * Which property detail a matrix-priced line was priced from, in the words the
 * account page shows ("Turf Sqft 6200"). Mirrors how resolveServicePrice names
 * the field: the service's own pricing field, else the turf square footage
 * field every matrix meant before that column existed.
 */
function pricedFrom(
  svc: Service,
  line: EstimateLine,
  fields: { id: number; label: string; fieldType: string }[],
): { label: string | null; value: number | null } {
  if (svc.pricingEquations.length === 0 || line.unitPrice == null) return { label: null, value: null };
  const numeric = Number(String(line.value).replace(/,/g, ""));
  if (line.value.trim() === "" || !Number.isFinite(numeric)) return { label: null, value: null };
  const field =
    svc.pricingFieldId != null
      ? fields.find((f) => f.id === svc.pricingFieldId) ?? null
      : fields.find((f) => /turf/i.test(f.label) && /sq/i.test(f.label)) ??
        fields.find((f) => /sq\s?ft|sqft|square/i.test(f.label) && f.fieldType === "calculable") ??
        null;
  return { label: field?.label ?? "Turf Sqft", value: numeric };
}

/** The package entry a line was added from, so its own window wins. */
function packageEntryFor(pkg: ServicePackage | null, line: EstimateLine): PackageItem | null {
  if (!pkg) return null;
  const items = pkg.items ?? [];
  return (
    items.find((item) => item.serviceId === line.serviceId && (item.label ?? "").trim() === line.label.trim()) ??
    items.find((item) => item.serviceId === line.serviceId) ??
    null
  );
}

/**
 * Roll a season forward until it has not already closed. Last season's dates —
 * on a service or on a package — would otherwise sell a whole season of visits
 * that all sit in the past, and nothing would reach the board.
 */
function currentSeason(
  start: string | null,
  end: string | null,
  today: string,
): { start: string | null; end: string | null } {
  let season = { start, end };
  for (let i = 0; i < 3 && season.end != null && season.end < today; i++) {
    season = { start: rollDateOneYear(season.start), end: rollDateOneYear(season.end) };
  }
  return season;
}

/** Whichever day comes first, when either of them may be missing. */
function earliestDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * The row one accepted line becomes. The schedule comes from the package it
 * was sold in, else the service's own season window, else the visit count:
 * 28 visits is a weekly service, one visit is a one-time job.
 */
function planClientService(
  estimate: Estimate,
  { line }: AcceptedServiceLine,
  svc: Service,
  pkg: ServicePackage | null,
  fields: { id: number; label: string; fieldType: string }[],
  today: string,
): {
  values: typeof clientServicesTable.$inferInsert;
  visits: number;
  seasonFromVisits: boolean;
  /** The last day the work was sold for; the scheduling rule cannot push the season past it. */
  seasonCap: string | null;
} {
  const quantity = line.quantity ?? svc.quantity ?? 1;
  const visits = Math.max(1, Math.round(line.visits ?? 1));
  const from = pricedFrom(svc, line, fields);
  const base: typeof clientServicesTable.$inferInsert = {
    clientId: estimate.clientId,
    serviceId: svc.id,
    packageId: line.packageId ?? null,
    label: line.label.trim() && line.label.trim() !== svc.name ? line.label.trim() : null,
    quantity,
    // Per visit, the way every assigned service is priced. A time-billed
    // service's amount is its hourly rate; the clock sets the rest.
    amount: svc.billingMode === "time" ? roundMoney(svc.rate) : estimateLineVisitAmount(line),
    scheduleType: "one_time",
    budgetedHours: svc.billableHours ?? null,
    pricedFromLabel: from.label,
    pricedFromValue: from.value,
    renewDate: pkg?.renewDate ?? svc.renewDate ?? null,
  };

  const tomorrow = addDaysISO(today, 1);
  const entry = packageEntryFor(pkg, line);
  const windowStart = entry?.windowStart ?? pkg?.startDate ?? null;
  const windowEnd = entry?.windowEnd ?? pkg?.endDate ?? null;
  if (svc.vendorName != null) {
    // Work an outside company performs never becomes a weekly crew assignment.
    // Nothing we generate from it is a stop a sub can do — those visits are
    // completed in bulk from the vendor's own invoice (Spray Runs) — and a
    // recurring row would put phantom stops on the board the first time
    // anything regenerated it. The count sold is in the audit line.
    const season = currentSeason(windowStart ?? svc.defaultStartDate, windowEnd ?? svc.defaultEndDate, today);
    if (season.start && season.end) {
      return {
        values: { ...base, scheduleType: "window", startDate: season.start, endDate: season.end },
        visits,
        seasonFromVisits: false,
        seasonCap: season.end,
      };
    }
    return { values: base, visits, seasonFromVisits: false, seasonCap: null };
  }
  if (pkg?.scheduleType === "window" && windowStart && windowEnd) {
    const season = currentSeason(windowStart, windowEnd, today);
    return {
      values: { ...base, scheduleType: "window", startDate: season.start, endDate: season.end },
      visits,
      seasonFromVisits: false,
      seasonCap: season.end,
    };
  }
  if (pkg?.scheduleType === "recurring") {
    const weeks = pkg.frequencyWeeks ?? 1;
    // The package carries last season's dates until the office edits it, so
    // roll them forward the way a window package's are: a season bought in
    // March 2027 is the 2027 season, not the one that closed in October.
    const season = currentSeason(pkg.startDate, pkg.seasonEndDate, tomorrow);
    const first = season.start && season.start > tomorrow ? season.start : tomorrow;
    return {
      values: {
        ...base,
        scheduleType: "recurring",
        firstServiceDate: first,
        frequency: weeks === 1 ? "weekly" : weeks === 2 ? "biweekly" : null,
        frequencyWeeks: weeks,
        weekday: weekdayOf(first),
        // What was sold is a number of visits inside the package's season, so
        // the season ends at whichever comes first — his last day or the last
        // visit the customer paid for.
        seasonEndDate: earliestDate(season.end, addDaysISO(first, (visits - 1) * weeks * 7)),
      },
      visits,
      seasonFromVisits: true,
      seasonCap: season.end,
    };
  }
  if (svc.defaultStartDate && svc.defaultEndDate) {
    if (visits === 1) {
      const season = currentSeason(svc.defaultStartDate, svc.defaultEndDate, today);
      return {
        values: { ...base, scheduleType: "window", startDate: season.start, endDate: season.end },
        visits,
        seasonFromVisits: false,
        seasonCap: season.end,
      };
    }
    // "28 mows" on a service that runs April to October: weekly, but the
    // season is the fence. Counting 28 weeks from tomorrow would put mows on
    // the board in December, January and February for the office to delete.
    const season = currentSeason(svc.defaultStartDate, svc.defaultEndDate, tomorrow);
    const first = season.start && season.start > tomorrow ? season.start : tomorrow;
    return {
      values: {
        ...base,
        scheduleType: "recurring",
        firstServiceDate: first,
        frequency: "weekly",
        frequencyWeeks: 1,
        weekday: weekdayOf(first),
        seasonEndDate: earliestDate(season.end, addDaysISO(first, (visits - 1) * 7)),
      },
      visits,
      seasonFromVisits: true,
      seasonCap: season.end,
    };
  }
  if (visits > 1) {
    // No season on the service: "28 mows" is weekly from tomorrow, for as many
    // weeks as were sold. The scheduling rule may move the first visit; the
    // season moves with it.
    const first = tomorrow;
    return {
      values: {
        ...base,
        scheduleType: "recurring",
        firstServiceDate: first,
        frequency: "weekly",
        frequencyWeeks: 1,
        weekday: weekdayOf(first),
        seasonEndDate: addDaysISO(first, (visits - 1) * 7),
      },
      visits,
      seasonFromVisits: true,
      seasonCap: null,
    };
  }
  return { values: base, visits, seasonFromVisits: false, seasonCap: null };
}

/**
 * Put an accepted estimate on the customer's account and on the board.
 *
 * Callers reach this exactly once per acceptance — the conditional status
 * update in the public respond handler is what makes that true. Errors are
 * thrown for the caller to log; the acceptance itself is already committed.
 */
export async function putAcceptedEstimateOnAccount(
  estimate: Estimate,
  options: { clientName?: string | null; acceptedOn?: string } = {},
): Promise<AcceptedEstimateOutcome> {
  const entries = acceptedServiceLines(estimate);
  if (entries.length === 0) return { assigned: [], scheduled: [] };
  const today = options.acceptedOn ?? todayLocal();

  const serviceIds = [...new Set(entries.map(({ line }) => line.serviceId))];
  const packageIds = [
    ...new Set(entries.map(({ line }) => line.packageId).filter((id): id is number => id != null)),
  ];
  const [services, packages, fields] = await Promise.all([
    db.select().from(servicesTable).where(inArray(servicesTable.id, serviceIds)),
    packageIds.length
      ? db.select().from(packagesTable).where(inArray(packagesTable.id, packageIds))
      : Promise.resolve([] as ServicePackage[]),
    db
      .select({ id: estimateFieldsTable.id, label: estimateFieldsTable.label, fieldType: estimateFieldsTable.fieldType })
      .from(estimateFieldsTable),
  ]);

  const planned = entries.flatMap((entry) => {
    const svc = services.find((s) => s.id === entry.line.serviceId);
    if (!svc) return [];
    const pkg = entry.line.packageId != null ? packages.find((p) => p.id === entry.line.packageId) ?? null : null;
    return [{ entry, svc, plan: planClientService(estimate, entry, svc, pkg, fields, today) }];
  });
  // A service deleted between sending and accepting cannot go on the account;
  // the office needs to know the customer bought it all the same.
  for (const { line } of entries.filter(({ line }) => !services.some((s) => s.id === line.serviceId))) {
    await logAudit({
      clientId: estimate.clientId,
      actorName: options.clientName ?? null,
      action: "estimate_service_missing",
      description: `Accepted estimate #${estimate.id} included "${line.label}", but that service no longer exists, so it was not put on the account.`,
    });
  }

  // Every row in one transaction: half a package on the account is worse than
  // none, because the office would not know which half.
  const rows = await db.transaction(async (tx) => {
    const created: {
      cs: ClientService;
      svc: Service;
      lineIndex: number;
      visits: number;
      seasonFromVisits: boolean;
      seasonCap: string | null;
    }[] = [];
    for (const { entry, svc, plan } of planned) {
      const [cs] = await tx.insert(clientServicesTable).values(plan.values).returning();
      created.push({
        cs,
        svc,
        lineIndex: entry.index,
        visits: plan.visits,
        seasonFromVisits: plan.seasonFromVisits,
        seasonCap: plan.seasonCap,
      });
    }
    return created;
  });

  const clientServiceIdByLine = new Map(rows.map((r) => [r.lineIndex, r.cs.id]));
  const scheduled = await scheduleAcceptedEstimate(estimate, {
    clientName: options.clientName,
    acceptedOn: today,
    clientServiceIdByLine,
  });

  const assigned: AssignedFromEstimate[] = [];
  for (const row of rows) {
    let cs = row.cs;
    let extraVisits = 0;
    const first = scheduled.find((s) => s.lineIndex === row.lineIndex);
    if (cs.scheduleType === "recurring" && first?.scheduledDate) {
      // The rule chose the day and, for route_fit, whose route it joins; the
      // rest of the season follows on that weekday with that contractor.
      const seasonEndDate = row.seasonFromVisits
        ? earliestDate(
            row.seasonCap,
            addDaysISO(first.scheduledDate, (row.visits - 1) * 7 * (cs.frequencyWeeks ?? 1)),
          )
        : cs.seasonEndDate;
      const [job] = await db
        .select({ assignedToId: jobsTable.assignedToId })
        .from(jobsTable)
        .where(eq(jobsTable.id, first.jobId));
      [cs] = await db
        .update(clientServicesTable)
        .set({
          firstServiceDate: first.scheduledDate,
          weekday: weekdayOf(first.scheduledDate),
          seasonEndDate,
          assignedToId: job?.assignedToId ?? cs.assignedToId,
        })
        .where(eq(clientServicesTable.id, cs.id))
        .returning();
      if (row.visits > 1) {
        extraVisits = (await generateJobs(cs, row.svc, db, { from: addDaysISO(first.scheduledDate, 1) })).length;
      }
    } else if (cs.scheduleType === "window" && first && row.visits > 1) {
      // Several visits inside one window (five fertilizer rounds between April
      // and October) are five entries on the waiting list, not one. One entry
      // would invoice one round and the other four would only exist in the
      // audit line — the office dates them from the list as they go.
      const wanted = Math.min(row.visits, MAX_GENERATED_JOBS) - 1;
      for (let i = 0; i < wanted; i++) {
        extraVisits += (await generateJobs(cs, row.svc, db)).length;
      }
    }
    assigned.push({
      clientServiceId: cs.id,
      lineIndex: row.lineIndex,
      serviceName: row.svc.name,
      visits: row.visits,
      extraVisits,
    });

    const priced = cs.pricedFromLabel ? `, priced from ${cs.pricedFromLabel} ${cs.pricedFromValue}` : "";
    const waitingExtras = cs.scheduleType === "window" ? extraVisits : 0;
    const onBoard = row.svc.vendorName
      ? `nothing on our board — ${row.svc.vendorName} does this work and it is completed from their invoice`
      : !first
      ? "nothing on the board yet — schedule it from the account"
      : waitingExtras
        ? first.scheduledDate
          ? `first visit on the board for ${first.scheduledDate}, ${waitingExtras} more on the waiting list`
          : `${1 + waitingExtras} visits on the waiting list ${first.windowStart} → ${first.windowEnd}`
        : extraVisits
          ? `${1 + extraVisits} visits on the board from ${first.scheduledDate}`
          : first.scheduledDate
            ? `first visit on the board for ${first.scheduledDate}`
            : `on the waiting list ${first.windowStart} → ${first.windowEnd}`;
    await logAudit({
      clientId: estimate.clientId,
      actorName: options.clientName ?? null,
      action: "service_assigned",
      entityType: "client_service",
      entityId: cs.id,
      description:
        `Accepted estimate #${estimate.id} put "${cs.label ?? row.svc.name}" on the account` +
        `${cs.packageId ? ` (${row.svc.name}, part of a package)` : ""} — $${cs.amount}` +
        `${row.svc.billingMode === "time" ? "/hr" : " a visit"}` +
        `${row.visits > 1 ? ` x ${row.visits} visits` : ""}${priced}; ${cadenceLabel(cs)}; ${onBoard}`,
    });
  }

  return { assigned, scheduled };
}
