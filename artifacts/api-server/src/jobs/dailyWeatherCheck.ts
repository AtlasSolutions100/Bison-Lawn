/**
 * One-shot daily weather check, for running the automation from outside the
 * HTTP process (a cron entry or a manual ops run):
 *
 *   pnpm --filter @workspace/api-server run weather-check
 *
 * The in-process scheduler covers the app while it is serving; this entry
 * point guarantees the run even if no instance happens to be awake at the
 * scheduled hour. Both share the same database day-claim, so whichever gets
 * there first wins and the check never runs twice for one day.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { getWeatherCheckStatus, runDailyWeatherCheck } from "../lib/weatherScheduler";

try {
  await runDailyWeatherCheck({ force: true });
  const status = await getWeatherCheckStatus();
  logger.info({ lastAutomaticRun: status.lastAutomaticRun }, "Daily weather check job finished");
} catch (err) {
  logger.error({ err }, "Daily weather check job failed");
  await pool.end();
  process.exit(1);
}
await pool.end();
