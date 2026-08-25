import app from "./app";
import { logger } from "./lib/logger";
import { startAbandonedMessageClaimSweeper } from "./lib/abandonedMessageClaims";

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
});
