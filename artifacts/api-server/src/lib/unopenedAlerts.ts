import {
  db,
  clientsTable,
  emailSendsTable,
  unopenedEmailAlertsTable,
  type UnopenedEmailAlert,
} from "@workspace/db";
import { and, asc, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { sendClientEmailViaGmail } from "./clientEmail";
import { getCompanyProfile } from "./companyProfile";
import { addDays, localDay } from "./automationRunner";
import { defaultGmailProxy, type GmailProxy } from "./gmail";
import { logAudit } from "./helpers";
import { logger } from "./logger";
import { todayISO } from "./invoiceNumbers";

/**
 * "Automation sent to admin for unopened invoices/emails."
 *
 * The one automation that emails HIM. Every other rule in the app writes to a
 * customer; this one tells him a bill he emailed has been sitting there for
 * days with nobody opening it, so he can pick up the phone.
 *
 * Opens are a guess and the wording has to admit it. The open pixel fires when
 * a mail client loads pictures: Gmail loads them through its own proxy, Apple
 * Mail fetches them before anyone has read anything, and a text-only client
 * never loads them at all. So "not opened yet" is the strongest thing this is
 * allowed to say — never "they ignored you", which would have him ringing a
 * customer who read the bill on their phone a week ago.
 */

/** How far back the very first run reaches, so switching it on is not a flood. */
const CATCH_UP_DAYS = 7;
const TICK_MS = 15 * 60 * 1000;
/** No more rows than he would read in one sitting. */
const MAX_ROWS = 100;
const DAY_MS = 86_400_000;

/**
 * Emails nobody can honestly call unopened.
 *
 * "Not opened" only means something when the email carried the little picture
 * that tells us it was loaded. The bill mailer (lib/invoiceDelivery.ts) stamps
 * an open token on its row but puts no picture in the message, so a bill can
 * never come back as opened however many times the customer reads it. Counting
 * those would hand him a list of 100 customers who read and paid their bill,
 * which is the exact phone call this rule exists to avoid. They stay out until
 * the bill email carries the picture, and the Automation page says why.
 */
const SOURCES_WITHOUT_A_PIXEL = ["invoice"];

const BILLS_NOT_TRACKED_YET =
  "Bills are left out for now: the bill email does not carry the little picture that tells us an email was " +
  "opened, so nobody can say whether a customer opened one. Switch this to any email and it reports the " +
  "letters and emails that do carry it.";

/**
 * Addresses this app may email while it is not the live install.
 *
 * The alert's default recipient is his company email, and a laptop running this
 * code holds the same Google token and the same company profile as the real
 * install — so "Send it to me now" from a desk here would put real mail in
 * Adam's inbox. On the live install NODE_ENV is production (set in the
 * Dockerfile) and nothing is in the way.
 */
const OFF_PRODUCTION_RECIPIENTS = (
  process.env.DEV_EMAIL_ALLOWLIST ?? "koby@radiantaisoftware.com,kobystull123@gmail.com"
)
  .split(",")
  .map((address) => address.trim().toLowerCase())
  .filter(Boolean);

function recipientAllowedHere(to: string): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return OFF_PRODUCTION_RECIPIENTS.includes(to.trim().toLowerCase());
}

/** Plain words for why this machine will not email that address. */
function notTheLiveInstall(to: string): string {
  return (
    `This is not the live install, so nothing was emailed to ${to}. Type one of our own addresses in the box to ` +
    `try the alert from here.`
  );
}

export type UnopenedScope = "invoices" | "all";

export type UnopenedRow = {
  emailSendId: number;
  clientId: number | null;
  clientName: string;
  subject: string | null;
  toEmail: string | null;
  source: string;
  sentAt: string;
  daysUnopened: number;
};

/** The single settings row, created on first read like the company profile. */
export async function getUnopenedAlertSettings(): Promise<UnopenedEmailAlert> {
  const [existing] = await db
    .select()
    .from(unopenedEmailAlertsTable)
    .orderBy(asc(unopenedEmailAlertsTable.id))
    .limit(1);
  if (existing) return existing;
  const [created] = await db.insert(unopenedEmailAlertsTable).values({}).returning();
  return created!;
}

export async function updateUnopenedAlertSettings(patch: {
  enabled?: boolean;
  afterDays?: number;
  scope?: UnopenedScope;
  notifyEmail?: string | null;
}): Promise<UnopenedEmailAlert> {
  const current = await getUnopenedAlertSettings();
  const [row] = await db
    .update(unopenedEmailAlertsTable)
    .set({
      enabled: patch.enabled ?? current.enabled,
      // One day is the floor: an email sent this morning has not had a chance.
      afterDays: patch.afterDays != null ? Math.min(60, Math.max(1, Math.round(patch.afterDays))) : current.afterDays,
      scope: patch.scope ?? current.scope,
      notifyEmail: patch.notifyEmail !== undefined ? (patch.notifyEmail?.trim() || null) : current.notifyEmail,
      updatedAt: new Date(),
    })
    .where(eq(unopenedEmailAlertsTable.id, current.id))
    .returning();
  return row!;
}

/** Where the alert goes: what he typed, else the company email on Settings. */
export async function alertRecipient(settings: UnopenedEmailAlert): Promise<string | null> {
  const typed = settings.notifyEmail?.trim();
  if (typed) return typed;
  const company = await getCompanyProfile().catch(() => undefined);
  const profileEmail = company?.email?.trim();
  if (profileEmail) return profileEmail;
  return process.env.APP_OWNER_EMAIL?.trim() || null;
}

/**
 * Emails that went out, were never opened, and are old enough to worry about.
 *
 * Only `status = 'sent'` rows with an open token count: a row with no token
 * carries no pixel, so "not opened" would mean "we never asked" — reporting
 * those would have him chasing customers over our own missing tracking.
 */
async function unopenedSends(scope: string, now: Date): Promise<UnopenedRow[]> {
  const rows = await db
    .select({ send: emailSendsTable, clientName: clientsTable.name })
    .from(emailSendsTable)
    .leftJoin(clientsTable, eq(clientsTable.id, emailSendsTable.clientId))
    .where(
      and(
        eq(emailSendsTable.status, "sent"),
        isNull(emailSendsTable.openedAt),
        isNotNull(emailSendsTable.sentAt),
        isNotNull(emailSendsTable.openToken),
        // A token on its own is not proof a picture went out — see
        // SOURCES_WITHOUT_A_PIXEL.
        notInArray(emailSendsTable.source, SOURCES_WITHOUT_A_PIXEL),
        ...(scope === "invoices" ? [eq(emailSendsTable.source, "invoice")] : []),
      ),
    )
    .orderBy(asc(emailSendsTable.sentAt));

  return rows.map(({ send, clientName }) => ({
    emailSendId: send.id,
    clientId: send.clientId,
    clientName: clientName ?? "(deleted customer)",
    subject: send.subject,
    toEmail: send.toEmail,
    source: send.source,
    sentAt: send.sentAt!.toISOString(),
    // Whole days off the clock, not squares off a calendar. Counting calendar
    // days called an email sent at ten to midnight "3 days old" barely two days
    // later, and then printed that figure to him as a fact.
    daysUnopened: daysOut(send.sentAt!, now),
  }));
}

/** How long this email has really been sitting there, in whole days. */
function daysOut(sentAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - sentAt.getTime()) / DAY_MS));
}

/** The day this email's Nth day falls on — which run is the one to report it. */
function crossingDay(row: UnopenedRow, afterDays: number): string {
  return addDays(localDay(new Date(row.sentAt)), afterDays);
}

/** True once it has been out the full number of days, to the hour. */
function outFullDays(row: UnopenedRow, afterDays: number, now: Date): boolean {
  return new Date(row.sentAt).getTime() + afterDays * DAY_MS <= now.getTime();
}

export type CrossingWindow = {
  /** The emails this run should report, oldest first. */
  due: UnopenedRow[];
  /**
   * How far the day cursor may move. It stops one day short of a day that is
   * not finished yet — see below — so nothing is skipped by the cursor passing
   * over it.
   */
  cursorDay: string;
};

/**
 * The emails whose Nth day falls in the window we have not reported yet.
 *
 * A cursor rather than "anything older than N days" so one email is reported
 * once. He asked to be told when a bill goes unopened, not to be told again
 * every morning about the same bill — and a server that was off for two days
 * still catches the ones that crossed the line while it was down.
 */
export function crossingsSince(
  rows: UnopenedRow[],
  afterDays: number,
  from: string,
  today: string,
  now: Date = new Date(),
): CrossingWindow {
  const inWindow = rows.filter((row) => {
    const crossing = crossingDay(row, afterDays);
    return crossing > from && crossing <= today;
  });

  // "Three days" has to mean three days. The crossing day only says which run
  // owns an email; the clock says whether it has really been out that long, and
  // an email sent at 11:50pm crosses its third calendar day at five past
  // midnight — 48 hours later. Those wait.
  //
  // The cursor moves a whole day at a time, so the day holding one of those is
  // left open: everything crossing on it is reported together on the next tick
  // after the youngest has really been out the full number of days, and
  // everything from the days before it goes now.
  const notYet = inWindow.filter((row) => !outFullDays(row, afterDays, now)).map((row) => crossingDay(row, afterDays));
  const openDay = notYet.length ? notYet.sort()[0]! : null;
  return {
    due: openDay ? inWindow.filter((row) => crossingDay(row, afterDays) < openDay) : inWindow,
    cursorDay: openDay ? addDays(openDay, -1) : today,
  };
}

export type UnopenedAlertPreview = {
  enabled: boolean;
  afterDays: number;
  scope: string;
  notifyEmail: string | null;
  lastCheckedDay: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  today: string;
  /** What the next run would put in his inbox. */
  wouldReport: UnopenedRow[];
  /** Everything still unopened past the cut-off, whether already reported or not. */
  stillUnopened: UnopenedRow[];
  problem: string | null;
};

export async function previewUnopenedAlert(today = todayISO(), now = new Date()): Promise<UnopenedAlertPreview> {
  const settings = await getUnopenedAlertSettings();
  const to = await alertRecipient(settings);
  const all = await unopenedSends(settings.scope, now);
  const from = settings.lastCheckedDay ?? addDays(today, -CATCH_UP_DAYS);
  const standing = all.filter((row) => row.daysUnopened >= settings.afterDays);
  const stillUnopened = standing.slice(0, MAX_ROWS);
  const next = crossingsSince(all, settings.afterDays, from, today, now).due;

  // Everything that is in the way, in the order it matters, as one plain line.
  // A figure he cannot see the rest of is worse than no figure: when the list
  // is cut the page has to say how many there really are.
  const problems = [
    !to ? "Nowhere to send it — fill in your company email on the Settings page, or type an address above." : null,
    to && !recipientAllowedHere(to) ? notTheLiveInstall(to) : null,
    settings.scope === "invoices" ? BILLS_NOT_TRACKED_YET : null,
    !settings.enabled ? "This is switched off; nothing reaches your inbox until you turn it on." : null,
    standing.length > stillUnopened.length
      ? `${standing.length} emails are sitting unopened past the cut-off — only the first ${MAX_ROWS} are listed.`
      : null,
    next.length > MAX_ROWS
      ? `${next.length} of them would go in the next email, which lists the first ${MAX_ROWS} of those.`
      : null,
  ].filter((line): line is string => !!line);

  return {
    enabled: settings.enabled,
    afterDays: settings.afterDays,
    scope: settings.scope,
    notifyEmail: to,
    lastCheckedDay: settings.lastCheckedDay,
    lastSentAt: settings.lastSentAt ? settings.lastSentAt.toISOString() : null,
    lastError: settings.lastError,
    today,
    wouldReport: next.slice(0, MAX_ROWS),
    stillUnopened,
    problem: problems.length ? problems.join(" ") : null,
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]!);

/**
 * Plain-words subject. Deliberately never says the customer ignored him.
 *
 * `total` is how many there really are; `rows` is only as much of the list as
 * one email can carry. Telling him "100" when 312 bills are sitting there, and
 * never mentioning the other 212, is a wrong number, not a short list.
 */
export function alertSubject(
  rows: UnopenedRow[],
  companyName: string,
  invoicesOnly: boolean,
  total = rows.length,
): string {
  const what = invoicesOnly ? "invoice email" : "email";
  return `${total} ${what}${total === 1 ? "" : "s"} not opened yet | ${companyName}`;
}

export function alertBody(
  rows: UnopenedRow[],
  afterDays: number,
  invoicesOnly: boolean,
  total = rows.length,
): string {
  const lines = rows.map(
    (row) =>
      `- ${row.clientName} — ${row.subject ?? "(no subject)"} — sent ${row.sentAt.slice(0, 10)}, ${row.daysUnopened} day${row.daysUnopened === 1 ? "" : "s"} ago${row.toEmail ? ` to ${row.toEmail}` : ""}`,
  );
  return [
    `${total} ${invoicesOnly ? "invoice email" : "email"}${total === 1 ? " has" : "s have"} been out for ${afterDays} day${afterDays === 1 ? "" : "s"} without being opened:`,
    "",
    ...lines,
    ...(total > rows.length
      ? ["", `Only the first ${rows.length} are listed here. There are ${total} in all.`]
      : []),
    "",
    "A note on what this means: we know an email was opened when the pictures in it get loaded. Some mail",
    "programs never load pictures, and some load them before anyone reads anything. So this list is",
    '"not opened yet" — it is worth a phone call, not proof the customer ignored you.',
    "",
    "You can turn this off, or change the number of days, on the Automation page.",
  ].join("\n");
}

function alertHtml(rows: UnopenedRow[], afterDays: number, invoicesOnly: boolean, total = rows.length): string {
  const body = rows
    .map(
      (row) =>
        `<tr>` +
        `<td style="padding:8px 10px;border-bottom:1px solid #e7e2dc">${escapeHtml(row.clientName)}</td>` +
        `<td style="padding:8px 10px;border-bottom:1px solid #e7e2dc">${escapeHtml(row.subject ?? "(no subject)")}</td>` +
        `<td style="padding:8px 10px;border-bottom:1px solid #e7e2dc;white-space:nowrap">${escapeHtml(row.sentAt.slice(0, 10))}</td>` +
        `<td style="padding:8px 10px;border-bottom:1px solid #e7e2dc;text-align:right;white-space:nowrap">${row.daysUnopened}</td>` +
        `</tr>`,
    )
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:640px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 6px;font-size:20px;color:#215343">Not opened yet</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6">
        ${total} ${invoicesOnly ? "invoice email" : "email"}${total === 1 ? " has" : "s have"} been out for
        ${afterDays} day${afterDays === 1 ? "" : "s"} without being opened.
        ${total > rows.length ? `Only the first ${rows.length} are listed below; there are ${total} in all.` : ""}
      </p>
      <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">
        <thead><tr style="text-align:left;color:#6f675f;font-size:12px;text-transform:uppercase">
          <th style="padding:0 10px 6px">Customer</th><th style="padding:0 10px 6px">Email</th>
          <th style="padding:0 10px 6px">Sent</th><th style="padding:0 10px 6px;text-align:right">Days</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
      <p style="margin:20px 0 0;font-size:12px;color:#6f675f;line-height:1.6">
        We know an email was opened when the pictures in it get loaded. Some mail programs never load pictures, and
        some load them before anyone reads anything &mdash; so this is &ldquo;not opened yet&rdquo;, worth a phone
        call rather than proof the customer ignored you. Turn this off, or change the number of days, on the
        Automation page.
      </p>
    </div>
  </body></html>`;
}

export type UnopenedAlertRun = {
  ran: boolean;
  reported: number;
  to: string | null;
  skipped: "disabled" | "no_recipient" | "already_today" | "nothing_due" | null;
  error: string | null;
};

/**
 * Check once and, if anything crossed the line, put one email in his inbox.
 *
 * The cursor moves even when there is nothing to report, so yesterday's quiet
 * day cannot come back tomorrow. It does NOT move when the send failed — he
 * would never hear about those bills at all — and it stops short of a day
 * whose emails have not actually been out the full number of days yet, so
 * passing over midnight cannot skip them.
 */
export async function runUnopenedAlert(
  opts: { today?: string; now?: Date; force?: boolean } = {},
  proxy: GmailProxy = defaultGmailProxy,
): Promise<UnopenedAlertRun> {
  const now = opts.now ?? new Date();
  const today = opts.today ?? todayISO();
  const settings = await getUnopenedAlertSettings();
  if (!settings.enabled && !opts.force) {
    return { ran: false, reported: 0, to: null, skipped: "disabled", error: null };
  }
  const to = await alertRecipient(settings);
  if (!to) return { ran: false, reported: 0, to: null, skipped: "no_recipient", error: null };
  // His own address is the default recipient, so off the live install this is
  // the difference between a dry run and real mail landing in Adam's inbox from
  // somebody's laptop. Nothing is sent, and the answer names the address so
  // whoever pressed the button knows where it was headed.
  if (!recipientAllowedHere(to)) {
    return { ran: false, reported: 0, to, skipped: "no_recipient", error: notTheLiveInstall(to) };
  }
  if (!opts.force && settings.lastCheckedDay === today) {
    return { ran: false, reported: 0, to, skipped: "already_today", error: null };
  }

  const from = settings.lastCheckedDay ?? addDays(today, -CATCH_UP_DAYS);
  const crossings = crossingsSince(await unopenedSends(settings.scope, now), settings.afterDays, from, today, now);
  // Everything that crossed is counted; only as much of it as one email can
  // carry is listed. A month-end batch can put 312 bills over the line on one
  // day, and "100" with no mention of the other 212 is a wrong number, not a
  // short list.
  const total = crossings.due.length;
  const rows = crossings.due.slice(0, MAX_ROWS);

  if (!rows.length) {
    await db
      .update(unopenedEmailAlertsTable)
      .set({ lastCheckedDay: crossings.cursorDay, lastError: null })
      .where(eq(unopenedEmailAlertsTable.id, settings.id));
    return { ran: true, reported: 0, to, skipped: "nothing_due", error: null };
  }

  const company = await getCompanyProfile().catch(() => undefined);
  const invoicesOnly = settings.scope === "invoices";
  const subject = alertSubject(rows, company?.name ?? "Bison Lawn Care LLC", invoicesOnly, total);
  try {
    await sendClientEmailViaGmail(
      {
        toEmail: to,
        subject,
        body: alertBody(rows, settings.afterDays, invoicesOnly, total),
        html: alertHtml(rows, settings.afterDays, invoicesOnly, total),
      },
      proxy,
    );
  } catch (cause) {
    const error = (cause instanceof Error ? cause.message : "Could not send the alert").slice(0, 500);
    await db
      .update(unopenedEmailAlertsTable)
      .set({ lastError: error })
      .where(eq(unopenedEmailAlertsTable.id, settings.id));
    return { ran: true, reported: 0, to, skipped: null, error };
  }

  await db
    .update(unopenedEmailAlertsTable)
    .set({ lastCheckedDay: crossings.cursorDay, lastSentAt: new Date(), lastError: null })
    .where(eq(unopenedEmailAlertsTable.id, settings.id));
  await logAudit({
    actorName: "Unopened email alert",
    action: "unopened_email_alert_sent",
    description:
      `Told ${to} that ${total} ${invoicesOnly ? "invoice email" : "email"}${total === 1 ? "" : "s"} have gone ` +
      `${settings.afterDays} days without being opened` +
      (total > rows.length ? `, with the first ${rows.length} of them listed in the email` : ""),
  });
  return { ran: true, reported: total, to, skipped: null, error: null };
}

// ----------------------------------------------------------- scheduler ----

let started = false;
let inFlight: Promise<void> | null = null;

function tick(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runUnopenedAlert()
    .then(() => undefined)
    .catch((err) => logger.error({ err }, "unopened email alert failed"))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Ticks rather than sleeping until a set hour, the same shape as the email
 * automations: the once-a-day guard is the `lastCheckedDay` column, so a server
 * that was down all morning still reports when it comes back.
 */
export function startUnopenedAlertScheduler(): void {
  if (started) return;
  started = true;
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  tick();
}
