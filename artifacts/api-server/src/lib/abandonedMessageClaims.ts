import { db, suggestedActionsTable } from "@workspace/db";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { logAudit } from "./helpers";
import { logger } from "./logger";

type SuggestionRow = typeof suggestedActionsTable.$inferSelect;

/**
 * How long a delivery claim may stay in "sending" before the office should stop
 * seeing it as in-flight. A Gmail send takes seconds; anything older than this
 * means the request or the server died between the claim and the outcome write.
 */
export const ABANDONED_CLAIM_AGE_MS = 2 * 60 * 1000;

/** How often the background sweep looks for claims that never reported back. */
export const ABANDONED_CLAIM_SWEEP_INTERVAL_MS = 60 * 1000;

const ABANDONED_CLAIM_MESSAGE =
  "Delivery was interrupted before it completed — the server never recorded whether this email was sent. Assume the customer was not notified.";

/**
 * Age out delivery claims that never reported an outcome. Rows claimed before
 * the cutoff (or with no claim timestamp at all, from before claims were
 * stamped) become "abandoned" so the office sees unfinished work instead of a
 * permanent "sending" badge. A send that is somehow still running can still
 * overwrite this with its real outcome.
 *
 * Idempotent: the update only matches rows still in "sending", so a row that is
 * already "abandoned" is neither re-written nor re-audited, no matter how often
 * the sweep runs.
 */
export async function expireAbandonedMessageClaims(): Promise<SuggestionRow[]> {
  const cutoff = new Date(Date.now() - ABANDONED_CLAIM_AGE_MS);
  const abandoned = await db
    .update(suggestedActionsTable)
    .set({ messageDeliveryState: "abandoned", messageDeliveryError: ABANDONED_CLAIM_MESSAGE })
    .where(
      and(
        eq(suggestedActionsTable.messageDeliveryState, "sending"),
        or(
          isNull(suggestedActionsTable.messageDeliveryClaimedAt),
          lt(suggestedActionsTable.messageDeliveryClaimedAt, cutoff),
        ),
      ),
    )
    .returning();

  for (const row of abandoned) {
    await logAudit({
      clientId: row.clientId,
      actorName: "System",
      action: "suggestion_message_abandoned",
      description: `The approved ${row.actionType} message for suggestion #${row.id} never finished sending; delivery was interrupted and no outcome was recorded`,
    });
  }

  return abandoned;
}

/**
 * Run the sweep on a timer so an interrupted message is flagged even when
 * nobody opens the review queue. Without this, a claim stuck in "sending" only
 * ages out on a queue read, so a customer could go a week uncontacted.
 * Returns a stop function for orderly shutdown.
 */
export function startAbandonedMessageClaimSweeper(
  intervalMs = ABANDONED_CLAIM_SWEEP_INTERVAL_MS,
): () => void {
  const sweep = async () => {
    try {
      const abandoned = await expireAbandonedMessageClaims();
      if (abandoned.length) {
        logger.warn(
          { count: abandoned.length, suggestionIds: abandoned.map((r) => r.id) },
          "Flagged customer messages whose delivery never completed",
        );
      }
    } catch (err) {
      logger.error({ err }, "Abandoned delivery claim sweep failed");
    }
  };

  // Catch anything left stranded by the previous process before waiting a tick.
  void sweep();

  const timer = setInterval(() => void sweep(), intervalMs);
  // Never hold the process open just for the sweep.
  timer.unref();
  return () => clearInterval(timer);
}
