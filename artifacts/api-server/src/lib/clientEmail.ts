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
 * `html` is optional on purpose. When a caller has a designed version it goes in
 * the text/html part; when it does not, the plain body is wrapped as before.
 *
 * The plain-text part is always sent either way. It is what text-only clients
 * and screen readers get, it is what shows in notification previews, and an
 * HTML-only message is a well-known spam signal — so the designed version never
 * replaces the plain one, it accompanies it.
 */
export async function sendClientEmailViaGmail(
  { toEmail, subject, body, html }: { toEmail: string; subject: string; body: string; html?: string },
  proxy: GmailProxy = defaultGmailProxy,
) {
  if (/[\r\n]/.test(toEmail)) throw new Error("Invalid client email address");

  const boundary = `bison_client_${randomBytes(12).toString("hex")}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const mime = [
    `To: ${toEmail}`,
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