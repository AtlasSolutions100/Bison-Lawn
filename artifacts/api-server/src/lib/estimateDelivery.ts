import { randomBytes } from "node:crypto";
import { defaultGmailProxy, sendRawGmailMessage, toBase64Url, type GmailProxy } from "./gmail";

export { toBase64Url, type GmailProxy };

export async function sendEstimateViaGmail(
  {
    toEmail,
    subject,
    html,
    pdf,
    estimateId,
  }: { toEmail: string; subject: string; html: string; pdf: Buffer; estimateId: number },
  proxy: GmailProxy = defaultGmailProxy,
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

  return sendRawGmailMessage(mime, proxy);
}
