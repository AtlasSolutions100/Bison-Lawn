import type { Feedback } from "@workspace/db";
import { sendCustomerMessageViaGmail } from "./customerMessageDelivery";
import { defaultGmailProxy, type GmailProxy } from "./gmail";
import { logger } from "./logger";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CATEGORY_LABEL: Record<string, string> = {
  idea: "Idea",
  problem: "Problem",
  other: "Feedback",
};

/**
 * Who gets told when someone submits feedback.
 *
 * A dedicated variable rather than reusing APP_OWNER_EMAIL: the owner emails
 * identify who may administer the app, and quietly overloading them to also mean
 * "route notifications here" makes changing one silently change the other.
 * Unset means notifications are off and the /feedback page is the only channel.
 */
function notifyAddress(): string | null {
  const value = process.env.FEEDBACK_NOTIFY_EMAIL?.trim();
  return value ? value : null;
}

export function feedbackSubject(feedback: Feedback) {
  const label = CATEGORY_LABEL[feedback.category] ?? "Feedback";
  const who = feedback.userName ?? "Someone";
  return `${label} from ${who}${feedback.page ? ` on ${feedback.page}` : ""} | Bison Lawn Care CRM`;
}

export function feedbackEmailHtml(feedback: Feedback, appUrl: string | null) {
  const rows: [string, string | null][] = [
    ["From", feedback.userName],
    ["Email", feedback.userEmail],
    ["Role", feedback.userRole],
    ["Screen", feedback.page],
    ["Type", CATEGORY_LABEL[feedback.category] ?? feedback.category],
  ];
  const meta = rows
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#6f675f;white-space:nowrap">${k}</td>` +
        `<td style="padding:2px 0">${escapeHtml(String(v))}</td></tr>`,
    )
    .join("");

  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:620px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
      <div style="background:#176b45;color:#fff;padding:24px 32px">
        <h1 style="margin:0;font-size:20px">New feedback</h1>
      </div>
      <div style="padding:28px 32px">
        <p style="white-space:pre-wrap;line-height:1.6;margin:0 0 24px">${escapeHtml(feedback.message)}</p>
        <table style="font-size:13px;border-collapse:collapse">${meta}</table>
        ${
          appUrl
            ? `<p style="margin-top:28px"><a href="${appUrl}/feedback" style="background:#176b45;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">Open the feedback board</a></p>`
            : ""
        }
      </div>
    </div>
  </body></html>`;
}

/**
 * Email a new piece of feedback to the office.
 *
 * Never throws. Submitting feedback must succeed even when mail does not — the
 * person who typed it has already been told it was received, and the row is
 * safely in the database and visible on /feedback either way. A failure here is
 * a missed notification, not lost feedback.
 */
export async function notifyFeedback(
  feedback: Feedback,
  proxy: GmailProxy = defaultGmailProxy,
): Promise<void> {
  const toEmail = notifyAddress();
  if (!toEmail) return;

  try {
    await sendCustomerMessageViaGmail(
      {
        toEmail,
        subject: feedbackSubject(feedback),
        html: feedbackEmailHtml(feedback, process.env.APP_PUBLIC_URL?.replace(/\/$/, "") ?? null),
      },
      proxy,
    );
  } catch (err) {
    logger.error({ err, feedbackId: feedback.id }, "failed to email feedback notification");
  }
}
