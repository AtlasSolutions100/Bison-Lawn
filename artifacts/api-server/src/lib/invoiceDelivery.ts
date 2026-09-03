import { randomBytes } from "node:crypto";
import type { CompanyProfile } from "@workspace/db";
import { defaultGmailProxy, sendRawGmailMessage, type GmailProxy } from "./gmail";
import {
  GMAIL_MAX_MESSAGE_BYTES,
  describeBytes,
  encodeBase64Lines,
  safeFileName,
} from "./estimateDelivery";

/**
 * File name the customer sees on the attachment.
 *
 * Company name first because the invoice lands in a folder alongside every
 * other trade's paperwork, and "Invoice 4848.pdf" on its own is unfindable six
 * months later when they are looking for who mowed the lawn.
 */
function attachmentFileName(invoiceNumber: number, company: CompanyProfile | undefined) {
  const prefix = (company?.name ?? "").trim().replace(/\s+/g, "-");
  return safeFileName(`${prefix ? `${prefix}-` : ""}Invoice-${invoiceNumber}.pdf`, "invoice.pdf");
}

export async function sendInvoiceViaGmail(
  {
    toEmail,
    subject,
    html,
    pdf,
    invoiceNumber,
    company,
  }: {
    toEmail: string;
    subject: string;
    html: string;
    pdf: Buffer;
    invoiceNumber: number;
    company?: CompanyProfile;
  },
  proxy: GmailProxy = defaultGmailProxy,
) {
  const boundary = `bison_invoice_${randomBytes(12).toString("hex")}`;
  const fileName = attachmentFileName(invoiceNumber, company);
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
    encodeBase64Lines(html),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${fileName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${fileName}"`,
    "",
    encodeBase64Lines(pdf),
    `--${boundary}--`,
  ].join("\r\n");

  const messageBytes = Buffer.byteLength(mime);
  if (messageBytes > GMAIL_MAX_MESSAGE_BYTES) {
    throw new Error(
      `This invoice email is ${describeBytes(messageBytes)}, over the ` +
        `${describeBytes(GMAIL_MAX_MESSAGE_BYTES)} Gmail accepts.`,
    );
  }

  return sendRawGmailMessage(mime, proxy);
}
