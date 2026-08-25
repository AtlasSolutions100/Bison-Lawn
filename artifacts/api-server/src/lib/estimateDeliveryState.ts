import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, estimatesTable } from "@workspace/db";

export async function claimEstimateDelivery(estimateId: number, pendingTokenHash: string) {
  const [claimed] = await db
    .update(estimatesTable)
    .set({
      deliveryState: "sending",
      pendingResponseTokenHash: pendingTokenHash,
      lastDeliveryError: null,
      deliveryAttempts: sql`${estimatesTable.deliveryAttempts} + 1`,
    })
    .where(
      and(
        eq(estimatesTable.id, estimateId),
        notInArray(estimatesTable.deliveryState, ["sending", "provider_accepted"]),
        notInArray(estimatesTable.status, ["accepted", "declined"]),
      ),
    )
    .returning();
  return claimed ?? null;
}

export async function releaseEstimateDelivery(
  estimateId: number,
  pendingTokenHash: string,
  errorMessage: string,
) {
  const [released] = await db
    .update(estimatesTable)
    .set({
      deliveryState: "failed",
      pendingResponseTokenHash: null,
      lastDeliveryError: errorMessage,
    })
    .where(
      and(
        eq(estimatesTable.id, estimateId),
        eq(estimatesTable.deliveryState, "sending"),
        eq(estimatesTable.pendingResponseTokenHash, pendingTokenHash),
      ),
    )
    .returning();
  return released ?? null;
}

export async function recordEstimateProviderAccepted(
  estimateId: number,
  pendingTokenHash: string,
  toEmail: string,
  gmailMessageId: string | null,
) {
  const [accepted] = await db
    .update(estimatesTable)
    .set({
      deliveryState: "provider_accepted",
      providerAcceptedAt: new Date(),
      sentToEmail: toEmail,
      gmailMessageId,
      lastDeliveryError: null,
    })
    .where(
      and(
        eq(estimatesTable.id, estimateId),
        eq(estimatesTable.deliveryState, "sending"),
        eq(estimatesTable.pendingResponseTokenHash, pendingTokenHash),
      ),
    )
    .returning();
  return accepted ?? null;
}

export async function finalizeEstimateDelivery(
  estimateId: number,
  pendingTokenHash: string,
  toEmail: string,
  gmailMessageId: string | null,
) {
  const [sent] = await db
    .update(estimatesTable)
    .set({
      status: "sent",
      sentAt: new Date(),
      sentToEmail: toEmail,
      responseTokenHash: pendingTokenHash,
      pendingResponseTokenHash: null,
      respondedAt: null,
      deliveryState: "sent",
      lastDeliveryError: null,
      gmailMessageId,
    })
    .where(
      and(
        eq(estimatesTable.id, estimateId),
        eq(estimatesTable.deliveryState, "provider_accepted"),
        eq(estimatesTable.pendingResponseTokenHash, pendingTokenHash),
        notInArray(estimatesTable.status, ["accepted", "declined"]),
      ),
    )
    .returning();
  if (sent) return sent;

  // A customer may submit the still-valid previous link while a resend is in
  // flight. Preserve that terminal decision, but activate the newly emailed
  // token so its link resolves to "already accepted/declined".
  const [terminal] = await db
    .update(estimatesTable)
    .set({
      sentAt: new Date(),
      sentToEmail: toEmail,
      responseTokenHash: pendingTokenHash,
      pendingResponseTokenHash: null,
      deliveryState: "sent",
      lastDeliveryError: null,
      gmailMessageId,
    })
    .where(
      and(
        eq(estimatesTable.id, estimateId),
        eq(estimatesTable.deliveryState, "provider_accepted"),
        eq(estimatesTable.pendingResponseTokenHash, pendingTokenHash),
        inArray(estimatesTable.status, ["accepted", "declined"]),
      ),
    )
    .returning();
  if (terminal) return terminal;

  // The customer response endpoint may have promoted the provider-accepted
  // pending token and finalized the row before this request resumes.
  const [alreadyFinalized] = await db
    .select()
    .from(estimatesTable)
    .where(
      and(
        eq(estimatesTable.id, estimateId),
        eq(estimatesTable.deliveryState, "sent"),
        eq(estimatesTable.responseTokenHash, pendingTokenHash),
      ),
    );
  return alreadyFinalized ?? null;
}

export async function reconcileEstimateDelivery(
  estimateId: number,
  pendingTokenHash: string,
  toEmail: string | null,
  gmailMessageId: string | null,
) {
  const [reconciled] = await db
    .update(estimatesTable)
    .set({
      status: sql`case when ${estimatesTable.status} in ('accepted', 'declined') then ${estimatesTable.status} else 'sent' end`,
      sentAt: sql`coalesce(${estimatesTable.sentAt}, now())`,
      sentToEmail: toEmail,
      responseTokenHash: pendingTokenHash,
      pendingResponseTokenHash: null,
      deliveryState: "sent",
      lastDeliveryError: null,
      gmailMessageId,
    })
    .where(
      and(
        eq(estimatesTable.id, estimateId),
        inArray(estimatesTable.deliveryState, ["sending", "provider_accepted"]),
        eq(estimatesTable.pendingResponseTokenHash, pendingTokenHash),
      ),
    )
    .returning();
  return reconciled ?? null;
}