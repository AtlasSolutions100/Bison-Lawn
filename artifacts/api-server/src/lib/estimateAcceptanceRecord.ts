import type { Client, Estimate, EstimateLine } from "@workspace/db";
import { officeTimeZone } from "./invoiceNumbers";

/**
 * 2026-09-28 notes (G4). "Signed estimates to send to management companies."
 *
 * A management company will not take his word that the homeowner said yes —
 * they want a piece of paper naming who approved what, for how much, and
 * when. Nothing new is captured here: the public accept page already records
 * all of it (the customer's own emailed link, the moment they clicked, which
 * lines they left ticked and the total of those). This turns that record into
 * the paragraph that goes on the estimate PDF.
 *
 * It is not a wet signature and must never claim to be one. The wording says
 * exactly what happened — approved online from a private link sent to a named
 * address — because overstating it on a document he forwards to a third party
 * is the one thing that could come back on him.
 */

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

export type AcceptanceRecord = {
  /** Right-aligned stamp for the top of the page. */
  stamp: string;
  heading: string;
  /** Label / value pairs, in reading order. */
  rows: { label: string; value: string }[];
  /** The sentence that makes the page usable as evidence. */
  attestation: string;
  /** Items the customer unticked, named so the reader is not misled. */
  declined: string[];
};

/**
 * One customer-facing choice: a package is ONE yes or no however many services
 * it bundles, which is how the response page presented it to them.
 *
 * Only priced lines count, and packages are grouped by packageKey — both
 * because that is exactly what the customer was shown. The response page
 * (routes/estimates.ts) puts a checkbox beside a line only when it carries a
 * price, so the $0 lines an estimate records about the property (Turf Sqft,
 * Gate Code, "Dog: yes") were never offered and can never come back ticked.
 * Counting them here printed "Not accepted: Turf Sqft, Gate Code" and "2 of 4
 * items" on a quote the customer accepted in full — the opposite of what this
 * block exists to attest, on the document he forwards to a management company.
 * And the same package added twice is two choices on that page, so grouping by
 * name instead of key reported a package he sold as declined.
 */
function responseChoices(lines: EstimateLine[]): { label: string; indexes: number[] }[] {
  const choices: { label: string; indexes: number[] }[] = [];
  const byPackage = new Map<string, { label: string; indexes: number[] }>();
  lines.forEach((line, index) => {
    if ((line.calculatedPrice ?? 0) === 0) return;
    const key = line.packageKey ?? null;
    if (key) {
      const open = byPackage.get(key);
      if (open) {
        open.indexes.push(index);
        return;
      }
      const choice = { label: line.packageName ?? "Package", indexes: [index] };
      byPackage.set(key, choice);
      choices.push(choice);
      return;
    }
    choices.push({ label: line.label, indexes: [index] });
  });
  return choices;
}

/**
 * The long form of the moment they clicked, read in the office's own clock.
 *
 * The deployed container has no TZ set, so it runs on UTC: without naming the
 * zone, a Sunday evening approval at 6:30 PM comes out as "Monday ... 1:30 AM"
 * — the wrong day, and the wrong weekday, on the one document whose whole job
 * is proving when the customer agreed.
 */
function whenAccepted(at: Date): string {
  const timeZone = officeTimeZone();
  return `${at.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone,
  })} at ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })}`;
}

/** A date on his calendar, not the server's. */
const officeDate = (at: Date) => at.toLocaleDateString("en-US", { timeZone: officeTimeZone() });

/**
 * The acceptance block for an estimate, or null when there is nothing to
 * attest — a draft, a sent-but-unanswered quote, or a decline. A declined
 * estimate deliberately gets no block: there is no approval to show.
 */
export function acceptanceRecord(
  estimate: Pick<
    Estimate,
    "id" | "status" | "respondedAt" | "sentToEmail" | "sentAt" | "total" | "acceptedLines" | "acceptedTotal" | "lines"
  >,
  client: Pick<Client, "name">,
): AcceptanceRecord | null {
  if (estimate.status !== "accepted") return null;

  const lines = estimate.lines as EstimateLine[];
  const accepted = estimate.acceptedLines as number[] | null;
  const choices = responseChoices(lines);
  // Null means "all of it" — that is what an estimate accepted before the
  // per-line checkboxes existed means, and reading it as "none" would print a
  // document claiming the customer bought nothing.
  const declined =
    accepted === null ? [] : choices.filter((choice) => !choice.indexes.every((i) => accepted.includes(i)));
  const total = estimate.acceptedTotal ?? estimate.total;

  const rows: { label: string; value: string }[] = [
    { label: "Accepted by", value: client.name },
  ];
  if (estimate.sentToEmail) {
    rows.push({ label: "From the link emailed to", value: estimate.sentToEmail });
  }
  rows.push({
    label: "Accepted on",
    value: estimate.respondedAt ? whenAccepted(estimate.respondedAt) : "date not recorded",
  });
  rows.push({
    label: "Amount approved",
    value:
      declined.length > 0
        ? `${money(total)} of ${money(estimate.total)} quoted (${choices.length - declined.length} of ${choices.length} items)`
        : money(total),
  });

  const attestation =
    `This is Bison Lawn Care's record of the customer's approval of estimate #${estimate.id}. ` +
    `It was approved online from the private link in the email above` +
    `${estimate.sentAt ? `, sent ${officeDate(estimate.sentAt)}` : ""}` +
    `${estimate.respondedAt ? `, and the approval was recorded the moment it was given` : ""}. ` +
    `No change has been made to the priced work on this page since.`;

  return {
    stamp: estimate.respondedAt ? `ACCEPTED ${officeDate(estimate.respondedAt)}` : "ACCEPTED",
    heading: "CUSTOMER ACCEPTANCE",
    rows,
    attestation,
    declined: declined.map((choice) => choice.label),
  };
}
