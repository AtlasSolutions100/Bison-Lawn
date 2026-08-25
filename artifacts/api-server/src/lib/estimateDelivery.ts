import { randomBytes } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();

export const toBase64Url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type GmailProxy = (
  connector: string,
  path: string,
  init: { method: string; body: string; headers: Record<string, string> },
) => Promise<Response>;

export async function sendEstimateViaGmail(
  {
    toEmail,
    subject,
    html,
    pdf,
    estimateId,
  }: { toEmail: string; subject: string; html: string; pdf: Buffer; estimateId: number },
  proxy: GmailProxy = connectors.proxy.bind(connectors) as GmailProxy,
) {
  const boundary = `bison_estimate_${randomBytes(12).toString("hex")}`;
  const mime = [
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html).toString("base64"),
    `--${boundary}`,
    'Content-Type: application/pdf; name="estimate.pdf"',
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="bison-estimate-${estimateId}.pdf"`,
    "",
    pdf.toString("base64"),
    `--${boundary}--`,
  ].join("\r\n");

  const response = await proxy("google-mail", "/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: toBase64Url(mime) }),
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gmail delivery failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as { id?: string };
}