import type { CompanyProfile } from "@workspace/db";
import { defaultGmailProxy, sendRawGmailMessage, type GmailProxy } from "./gmail";
import {
  FALLBACK_COMPANY_PROFILE,
  brandAssetUrl,
  companyAddressLines,
  companyContactLine,
} from "./estimateDocument";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Both builders are synchronous because their caller — the automation approval
 * route — composes the subject and body inline as arguments. The profile is
 * therefore passed in rather than fetched here; omitting it falls back to the
 * column defaults so an un-migrated call still names the company correctly.
 */
export function customerMessageSubject(
  actionType: string,
  targetDate: string | null,
  company: CompanyProfile = FALLBACK_COMPANY_PROFILE,
) {
  const what = actionType === "reschedule" ? "Service rescheduled" : "Service skipped";
  return `${what}${targetDate ? ` — ${targetDate}` : ""} | ${company.name}`;
}

/** Wrap the admin-approved plain-text message in the Bison email shell. */
export function createCustomerMessageEmailHtml(
  message: string,
  clientName: string | null,
  company: CompanyProfile = FALLBACK_COMPANY_PROFILE,
) {
  const body = escapeHtml(message).replace(/\n/g, "<br />");
  // The wordmark is decoration only: mail clients block remote images by
  // default, and every detail it carries is also set as text below it.
  const wordmark = brandAssetUrl("logo-wordmark.png");
  const emblem = brandAssetUrl("logo-emblem.png");
  const addressLines = companyAddressLines(company);
  const contactLine = companyContactLine(company);

  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:620px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
      <div style="padding:26px 32px 18px;text-align:center">
        ${
          wordmark
            ? `<img src="${escapeHtml(wordmark)}" alt="${escapeHtml(company.name)}" width="240" style="display:inline-block;width:240px;max-width:100%;height:auto;border:0" />`
            : ""
        }
      </div>
      <div style="background:#215343;color:#fff;padding:20px 32px">
        <h1 style="margin:0;font-size:22px">${escapeHtml(company.name)}</h1>
        <p style="margin:8px 0 0">Update to your upcoming service</p>
      </div>
      <div style="padding:32px">
        ${clientName ? `<p>Hi ${escapeHtml(clientName)},</p>` : ""}
        <p style="line-height:1.6">${body}</p>
        <p style="font-size:12px;color:#6f675f;margin-top:28px">
          Questions? Just reply to this email and the office will get back to you.
        </p>
        <p style="margin:24px 0 0;line-height:1.6">${escapeHtml(company.signatureLine)}<br /><br /><strong>${escapeHtml(company.name)}</strong>${
          contactLine ? `<br />${escapeHtml(contactLine)}` : ""
        }</p>
      </div>
      <div style="background:#f7f5f1;padding:24px 32px;text-align:center;border-top:1px solid #e7e2dc">
        ${
          emblem
            ? `<img src="${escapeHtml(emblem)}" alt="" width="56" style="display:inline-block;width:56px;height:auto;border:0" />`
            : ""
        }
        <p style="margin:8px 0 0;font-weight:bold;color:#215343">Thank you for your business!</p>
        ${addressLines.length ? `<p style="margin:8px 0 0;font-size:12px;color:#6f675f">${addressLines.map(escapeHtml).join("<br />")}</p>` : ""}
        ${contactLine ? `<p style="margin:6px 0 0;font-size:12px;color:#6f675f">${escapeHtml(contactLine)}</p>` : ""}
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
