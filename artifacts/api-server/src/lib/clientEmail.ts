import { randomBytes } from "node:crypto";
import { defaultGmailProxy, sendRawGmailMessage, type GmailProxy } from "./gmail";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

/**
 * The typed-by-hand email as HTML, with the open pixel on it.
 *
 * Same wrapping the sender does when no html is given, except that it can carry
 * the tracking pixel — "post unopened email to account" only works if there is
 * something in the email to tell us it was opened.
 */
export function plainBodyHtml(body: string, pixelUrl?: string | null): string {
  const text = `<div>${escapeHtml(body).replace(/\r?\n/g, "<br>")}</div>`;
  const pixel = pixelUrl
    ? `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`
    : "";
  return `${text}${pixel}`;
}

/**
 * `html` is optional on purpose. When a caller has a designed version it goes in
 * the text/html part; when it does not, the plain body is wrapped as before.
 *
 * The plain-text part is always sent either way. It is what text-only clients
 * and screen readers get, it is what shows in notification previews, and an
 * HTML-only message is a well-known spam signal — so the designed version never
 * replaces the plain one, it accompanies it.
 */
export async function sendClientEmailViaGmail(
  { toEmail, subject, body, html, cc, bcc }: {
    toEmail: string;
    subject: string;
    body: string;
    html?: string;
    cc?: string[];
    bcc?: string[];
  },
  proxy: GmailProxy = defaultGmailProxy,
) {
  /**
   * A newline in an address is a header injection: everything after it becomes
   * a new MIME header, which is how a "Cc" field turns into an extra Bcc to
   * somebody else entirely. Every address is checked, not just the To — cc and
   * bcc are typed by hand in the office, which is exactly where a pasted
   * address with a stray newline comes from.
   */
  const assertClean = (address: string, field: string) => {
    if (/[\r\n]/.test(address)) throw new Error(`Invalid ${field} email address`);
    return address;
  };
  const clean = (list: string[] | undefined, field: string) =>
    (list ?? [])
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => assertClean(a, field));

  assertClean(toEmail, "client");
  const ccList = clean(cc, "Cc");
  const bccList = clean(bcc, "Bcc");

  const boundary = `bison_client_${randomBytes(12).toString("hex")}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const mime = [
    `To: ${toEmail}`,
    ...(ccList.length ? [`Cc: ${ccList.join(", ")}`] : []),
    // Bcc is a real header on the outgoing message; Gmail strips it from what
    // recipients receive, which is the whole point of it.
    ...(bccList.length ? [`Bcc: ${bccList.join(", ")}`] : []),
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body).toString("base64"),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html ?? `<div>${escapeHtml(body).replace(/\r?\n/g, "<br>")}</div>`).toString("base64"),
    `--${boundary}--`,
  ].join("\r\n");

  return sendRawGmailMessage(mime, proxy);
}