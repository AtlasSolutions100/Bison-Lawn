/**
 * What an invoice's status means for the money, in one place.
 *
 * Its own file so the money helpers and the PDF renderer can both ask without
 * one of them having to import the other: balanceOf lives next to the bill
 * drawing, recalcClientBalance lives next to the audit log, and the one
 * question "does this bill still owe anything" has to be answered the same way
 * in both or the account balance disagrees with the bill the customer holds.
 */

/**
 * The statuses that owe nothing.
 *
 * Void is cancelled: the bill should never have existed, and its payments are
 * detached to credit when it is voided. Written off is the Jackie Wagner case —
 * the work was done and he is never going to see the money, so it comes off
 * what she owes without the invoice or its history disappearing. Collections is
 * the same arithmetic for a different reason: someone else is chasing the debt
 * now, so it must not sit in his own past-due list making him ring her again.
 *
 * Unlike void, a written-off or collections bill keeps whatever was already
 * paid against it. Writing off $200 of a $300 bill that has $100 on it has to
 * take $200 off the account, not $300 — see recalcClientBalance.
 */
export const NOT_OWED_STATUSES = ["void", "written_off", "collections"] as const;

/** The two ways out of a balance he will never collect. */
export const WRITE_OFF_STATUSES = ["written_off", "collections"] as const;
export type WriteOffStatus = (typeof WRITE_OFF_STATUSES)[number];

export const owesNothing = (status: string | null | undefined) =>
  status != null && (NOT_OWED_STATUSES as readonly string[]).includes(status);

export const isWriteOff = (status: string | null | undefined) =>
  status != null && (WRITE_OFF_STATUSES as readonly string[]).includes(status);

/** How a written-off or collections bill reads on the account, in his words. */
export const WRITE_OFF_LABEL: Record<string, string> = {
  written_off: "Written off",
  collections: "Sent to collections",
};
