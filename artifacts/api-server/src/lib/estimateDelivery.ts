import { randomBytes } from "node:crypto";
import type { CompanyProfile } from "@workspace/db";
import { defaultGmailProxy, sendRawGmailMessage, toBase64Url, type GmailProxy } from "./gmail";

export { toBase64Url, type GmailProxy };

/**
 * The name the customer's saved copy ends up with on their desktop, taken from
 * the company profile so it stays right if the owner ever trades as something
 * else. Falls back to the old fixed slug when no profile is supplied.
 */
function attachmentFileName(estimateId: number, company: CompanyProfile | undefined) {
  const slug = (company?.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "bison"}-estimate-${estimateId}.pdf`;
}

export async function sendEstimateViaGmail(
  {
    toEmail,
    subject,
    html,
    pdf,
    estimateId,
    company,
  }: {
    toEmail: string;
    subject: string;
    html: string;
    pdf: Buffer;
    estimateId: number;
    company?: CompanyProfile;
  },
  proxy: GmailProxy = defaultGmailProxy,
) {
  const boundary = `bison_estimate_${randomBytes(12).toString("hex")}`;
  const fileName = attachmentFileName(estimateId, company);
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
    `Content-Type: application/pdf; name="${fileName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${fileName}"`,
    "",
    pdf.toString("base64"),
    `--${boundary}--`,
  ].join("\r\n");

  return sendRawGmailMessage(mime, proxy);
}
