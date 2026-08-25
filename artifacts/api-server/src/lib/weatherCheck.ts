import {
  db,
  weatherRulesTable,
  suggestedActionsTable,
  jobsTable,
  clientsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { logAudit } from "./helpers";

type DailyForecast = {
  precipitationMm: number;
  windKph: number;
  maxTempC: number;
  minTempC: number;
};

export type WeatherCheckOutcome = {
  date: string;
  jobsChecked: number;
  suggestionsCreated: number;
  forecastSummary: string | null;
  created: (typeof suggestedActionsTable.$inferSelect)[];
};

type ForecastFetcher = (lat: number, lng: number, date: string) => Promise<DailyForecast | null>;

let forecastFetcherForTests: ForecastFetcher | null = null;
const FORECAST_TIMEOUT_MS = 20_000;

/** Test seam: stand in for the forecast provider so runs stay offline. */
export function setForecastFetcherForTests(fetcher: ForecastFetcher | null) {
  forecastFetcherForTests = fetcher;
}

/** Fetch the daily forecast for a location/date from Open-Meteo (no API key needed). */
async function fetchForecast(lat: number, lng: number, date: string): Promise<DailyForecast | null> {
  if (forecastFetcherForTests) return forecastFetcherForTests(lat, lng, date);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=precipitation_sum,wind_speed_10m_max,temperature_2m_max,temperature_2m_min` +
    `&start_date=${date}&end_date=${date}&timezone=auto`;
  // A weather-provider stall must not hold a scheduled run's lease forever.
  const resp = await fetch(url, { signal: AbortSignal.timeout(FORECAST_TIMEOUT_MS) });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    daily?: {
      precipitation_sum?: (number | null)[];
      wind_speed_10m_max?: (number | null)[];
      temperature_2m_max?: (number | null)[];
      temperature_2m_min?: (number | null)[];
    };
  };
  const d = data.daily;
  if (!d) return null;
  return {
    precipitationMm: d.precipitation_sum?.[0] ?? 0,
    windKph: d.wind_speed_10m_max?.[0] ?? 0,
    maxTempC: d.temperature_2m_max?.[0] ?? 0,
    minTempC: d.temperature_2m_min?.[0] ?? 0,
  };
}

function ruleTriggered(
  rule: typeof weatherRulesTable.$inferSelect,
  f: DailyForecast,
): { hit: boolean; observed: string } {
  switch (rule.conditionType) {
    case "rain":
      return { hit: f.precipitationMm >= rule.threshold, observed: `${f.precipitationMm} mm rain` };
    case "wind":
      return { hit: f.windKph >= rule.threshold, observed: `${f.windKph} km/h wind` };
    case "heat":
      return { hit: f.maxTempC >= rule.threshold, observed: `${f.maxTempC}°C high` };
    case "cold":
      return { hit: f.minTempC <= rule.threshold, observed: `${f.minTempC}°C low` };
    default:
      return { hit: false, observed: "" };
  }
}

export function addDaysISO(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildMessage(template: string | null, vars: Record<string, string>): string {
  const base =
    template ??
    "Hi {clientName}, due to weather conditions ({reason}) we need to {action} your service on {date}.{newDatePart} Sorry for the inconvenience — Bison Lawn Care.";
  return base
    .replace(/\{clientName\}/g, vars.clientName)
    .replace(/\{reason\}/g, vars.reason)
    .replace(/\{action\}/g, vars.action)
    .replace(/\{date\}/g, vars.date)
    .replace(/\{newDate\}/g, vars.newDate)
    .replace(/\{newDatePart\}/g, vars.newDatePart);
}

/**
 * Evaluate all enabled weather rules against jobs scheduled for a date.
 * Nothing is changed automatically — triggered rules only create pending
 * suggested actions that an admin must review and approve. Shared by the
 * admin-triggered endpoint and the daily scheduler.
 */
export async function runWeatherCheckForDate(date: string): Promise<WeatherCheckOutcome> {
  const rules = await db.select().from(weatherRulesTable).where(eq(weatherRulesTable.enabled, true));
  const jobs = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.dispatched, true), eq(jobsTable.scheduledDate, date)));
  const activeJobs = jobs.filter((j) => j.status !== "completed");

  if (rules.length === 0 || activeJobs.length === 0) {
    return { date, jobsChecked: activeJobs.length, suggestionsCreated: 0, forecastSummary: null, created: [] };
  }

  const clientIds = [...new Set(activeJobs.map((j) => j.clientId))];
  const clients = await db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds));
  const cMap = new Map(clients.map((c) => [c.id, c]));

  // Existing pending suggestions so a re-run doesn't duplicate them.
  const existing = await db
    .select()
    .from(suggestedActionsTable)
    .where(and(eq(suggestedActionsTable.source, "weather"), eq(suggestedActionsTable.status, "pending")));
  const existingKeys = new Set(existing.map((s) => `${s.jobId}:${s.ruleId}`));

  // Cache forecasts by rounded coordinates so nearby clients share a lookup.
  const forecastCache = new Map<string, DailyForecast | null>();
  async function forecastFor(lat: number, lng: number): Promise<DailyForecast | null> {
    const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
    if (!forecastCache.has(key)) {
      try {
        forecastCache.set(key, await fetchForecast(lat, lng, date));
      } catch {
        forecastCache.set(key, null);
      }
    }
    return forecastCache.get(key)!;
  }

  const created: (typeof suggestedActionsTable.$inferSelect)[] = [];
  let sampleForecast: DailyForecast | null = null;
  let forecastMissing = 0;

  for (const job of activeJobs) {
    const client = cMap.get(job.clientId);
    if (!client || client.lat == null || client.lng == null) {
      forecastMissing++;
      continue;
    }
    const forecast = await forecastFor(client.lat, client.lng);
    if (!forecast) {
      forecastMissing++;
      continue;
    }
    sampleForecast = sampleForecast ?? forecast;

    for (const rule of rules) {
      const { hit, observed } = ruleTriggered(rule, forecast);
      if (!hit) continue;
      if (existingKeys.has(`${job.id}:${rule.id}`)) continue;

      const newDate = rule.actionType === "reschedule" ? addDaysISO(date, rule.rescheduleDays) : null;
      const reason = `${rule.name}: ${observed} forecast on ${date}`;
      const customerMessage = buildMessage(rule.messageTemplate, {
        clientName: client.name,
        reason: observed,
        action: rule.actionType === "reschedule" ? "reschedule" : "skip",
        date,
        newDate: newDate ?? "",
        newDatePart: newDate ? ` We plan to come instead on ${newDate}.` : "",
      });

      const [suggestion] = await db
        .insert(suggestedActionsTable)
        .values({
          source: "weather",
          ruleId: rule.id,
          jobId: job.id,
          clientId: job.clientId,
          actionType: rule.actionType,
          reason,
          targetDate: date,
          newDate,
          customerMessage,
        })
        // The partial unique index is the authority here, not the earlier
        // read: two overlapping evaluators can both observe no suggestion.
        .onConflictDoNothing()
        .returning();
      if (!suggestion) continue;
      created.push(suggestion);
      existingKeys.add(`${job.id}:${rule.id}`);

      await logAudit({
        clientId: job.clientId,
        actorName: "Weather automation",
        action: "suggestion_created",
        description: `Suggested ${rule.actionType} for job #${job.id} (${reason}) — awaiting admin review`,
      });
    }
  }

  const forecastSummary = sampleForecast
    ? `Forecast for ${date}: ${sampleForecast.precipitationMm} mm rain, ${sampleForecast.windKph} km/h max wind, high ${sampleForecast.maxTempC}°C / low ${sampleForecast.minTempC}°C` +
      (forecastMissing ? ` (${forecastMissing} job(s) skipped — missing location or forecast)` : "")
    : forecastMissing === activeJobs.length
      ? "No forecast available — jobs are missing client map locations or the weather service was unreachable"
      : null;

  return {
    date,
    jobsChecked: activeJobs.length,
    suggestionsCreated: created.length,
    forecastSummary,
    created,
  };
}
