import { randomBytes } from "node:crypto";
import { defaultGmailProxy, sendRawGmailMessage, type GmailProxy } from "./gmail";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

export async function sendClientEmailViaGmail(
  { toEmail, subject, body }: { toEmail: string; subject: string; body: string },
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
    Buffer.from(`<div>${escapeHtml(body).replace(/\r?\n/g, "<br>")}</div>`).toString("base64"),
    `--${boundary}--`,
  ].join("\r\n");

  return sendRawGmailMessage(mime, proxy);
}