import app from "./app";
import { logger } from "./lib/logger";
import { startAbandonedMessageClaimSweeper } from "./lib/abandonedMessageClaims";
import { reconcileUserAccounts } from "./lib/userAccounts";
import { startWeatherScheduler } from "./lib/weatherScheduler";
import { startClientServiceTicker } from "./lib/clientServiceTick";
import { startEmailAutomationScheduler } from "./lib/automationRunner";
import { ensureDocumentTemplatesOnce } from "./lib/documentTemplateSeeds";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Interrupted customer messages are flagged on a timer (and once at start,
  // catching anything the previous process left stranded) so the office does
  // not have to open the review queue for them to surface.
  startAbandonedMessageClaimSweeper();

  // Daily weather check: prepares suggestions for review without anyone
  // having to click "Check Weather".
  startWeatherScheduler();

  // Paused services come back on their date or when the account is paid;
  // active services roll into the new season. Nobody has to click anything.
  startClientServiceTicker();

  // His letters have to be on the Settings page of a fresh install, not only
  // after the demo seed. Keyed on each template's slug, so a restart is a no-op.
  ensureDocumentTemplatesOnce()
    .then((inserted) => {
      if (inserted > 0) logger.info({ inserted }, "seeded document templates");
    })
    .catch((err) => logger.error({ err }, "failed to seed document templates"));

  // Daily email automations: past-due notices, estimate follow-ups, seasonal
  // letters — each rule sends only what he has switched on.
  startEmailAutomationScheduler();

  // Registers sign-in identities for existing accounts and merges any
  // duplicate accounts (same person, two Clerk identities) already stored.
  // Never fatal: the app stays up if the cleanup cannot run.
  reconcileUserAccounts()
    .then((result) => {
      if (result.identitiesBackfilled > 0 || result.accountsMerged > 0) {
        logger.info(result, "reconciled duplicate user accounts");
      }
    })
    .catch((err) => {
      logger.error({ err }, "failed to reconcile user accounts");
    });
});
