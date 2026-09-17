/**
 * One-shot daily email automation run, for cron or a manual ops run:
 *
 *   pnpm --filter @workspace/api-server run email-automations
 *
 * The in-process scheduler covers the app while it is serving; this entry
 * point guarantees the run even if no instance is awake at the scheduled
 * hour. Both share the same database day-claim (automation_runs, kind
 * "emails"), so whichever gets there first wins and no rule runs twice for
 * one day — and every notice is claimed one at a time on top of that.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { runEmailAutomations } from "../lib/automationRunner";

try {
  const result = await runEmailAutomations({ trigger: "scheduled", force: true });
  logger.info({ summary: result?.summary ?? "already ran today" }, "Daily email automations finished");
} catch (err) {
  logger.error({ err }, "Daily email automations failed");
  await pool.end();
  process.exit(1);
}
await pool.end();
