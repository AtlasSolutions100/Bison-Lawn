import { defaultGmailProxy, sendRawGmailMessage, type GmailProxy } from "./gmail";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Subject line for an approved skip/reschedule notice. */
export function customerMessageSubject(actionType: string, targetDate: string | null) {
  const what = actionType === "reschedule" ? "Service rescheduled" : "Service skipped";
  return `${what}${targetDate ? ` — ${targetDate}` : ""} | Bison Lawn Care LLC`;
}

/** Wrap the admin-approved plain-text message in the Bison email shell. */
export function createCustomerMessageEmailHtml(message: string, clientName: string | null) {
  const body = escapeHtml(message).replace(/\n/g, "<br />");
  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:620px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
      <div style="background:#176b45;color:#fff;padding:28px 32px">
        <h1 style="margin:0;font-size:24px">Bison Lawn Care LLC</h1>
        <p style="margin:8px 0 0">Update to your upcoming service</p>
      </div>
      <div style="padding:32px">
        ${clientName ? `<p>Hi ${escapeHtml(clientName)},</p>` : ""}
        <p style="line-height:1.6">${body}</p>
        <p style="font-size:12px;color:#6f675f;margin-top:28px">
          Questions? Just reply to this email and the office will get back to you.
        </p>
      </div>
    </div>
  </body></html>`;
}

/** Email an approved customer message. Throws when Gmail does not accept it. */
export async function sendCustomerMessageViaGmail(
  { toEmail, subject, html }: { toEmail: string; subject: string; html: string },
  proxy: GmailProxy = defaultGmailProxy,
) {
  const mime = [
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html).toString("base64"),
  ].join("\r\n");
  return sendRawGmailMessage(mime, proxy);
}
