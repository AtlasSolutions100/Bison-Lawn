import { randomBytes } from "node:crypto";
import PDFDocument from "pdfkit";
import type { CompanyProfile } from "@workspace/db";
import { companyAddressLines, companyContactLine } from "./estimateDocument";
import { defaultGmailProxy, sendRawGmailMessage, toBase64Url, type GmailProxy } from "./gmail";

export { toBase64Url, type GmailProxy };

/** One file riding along with the estimate email. */
export type EmailAttachment = {
  fileName: string;
  contentType: string;
  bytes: Buffer;
};

/**
 * Gmail refuses a message whose encoded size passes about 25MB, and the refusal
 * arrives as a generic API error long after the admin pressed Send. The limit is
 * enforced here so it is our message that explains it, not Gmail's.
 */
export const GMAIL_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * What the chosen documents and photos may add up to.
 *
 * The estimate PDF and the HTML body ride on every send, so they are reserved
 * out of the limit rather than counted against a running total the sender is
 * watching: the sender is choosing photos, and the number shown beside them has
 * to be one they can act on. 2MB is many times what a quote carrying two small
 * logos has ever weighed.
 */
export const ATTACHMENT_BUDGET_BYTES = GMAIL_MAX_MESSAGE_BYTES - 2 * 1024 * 1024;

const BASE64_LINE_LENGTH = 76;

/**
 * Encode with the line breaks RFC 2045 asks for.
 *
 * The single-line encoding this used to emit survived because an estimate PDF is
 * small. A 15MB photo is one twenty-million-character line, which is far past
 * SMTP's 998-octet line limit; relays are then free to fold it wherever they
 * like, and a photo that arrives corrupted looks like our bug, not the relay's.
 */
export function encodeBase64Lines(bytes: Buffer | string): string {
  const encoded = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += BASE64_LINE_LENGTH) {
    lines.push(encoded.slice(at, at + BASE64_LINE_LENGTH));
  }
  return lines.join("\r\n");
}

/**
 * What `byteLength` raw bytes cost inside the message, so a selection can be
 * weighed before anything is read off disk or sent. Base64 is four characters
 * per three bytes, plus a CRLF per line, plus a small allowance for the part's
 * own headers.
 */
export function encodedAttachmentBytes(byteLength: number): number {
  const encoded = Math.ceil(byteLength / 3) * 4;
  return encoded + Math.ceil(encoded / BASE64_LINE_LENGTH) * 2 + 200;
}

/** Sizes the way the office talks about them, for messages they have to act on. */
export function describeBytes(byteLength: number): string {
  const mb = byteLength / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)}MB` : `${mb.toFixed(1)}MB`;
}

/**
 * A file name a mail client will accept in a quoted header: no quotes, no line
 * breaks, nothing outside ASCII. A name that carried a CRLF would let a caption
 * inject its own MIME headers, and captions are typed by hand.
 */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\/:*?<>|]/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

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

/**
 * Set one of the owner's stored documents as a PDF.
 *
 * A PDF rather than the plain text it is stored as: these go to homeowners
 * alongside a quote, and "meet-and-greet.txt" reads as something that fell out
 * of the machine. Deliberately plain — no artwork, no columns — because the
 * document is his words and every one of them has already been merged in by the
 * caller; this only has to present them without losing the paragraph breaks.
 */
export function renderDocumentPdf({
  title,
  body,
  company,
}: {
  title: string;
  body: string;
  company: CompanyProfile;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54, info: { Title: title } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fillColor("#215343").font("Helvetica-Bold").fontSize(18).text(company.name, { width: 504 });
    doc.fillColor("#2B2118").font("Helvetica-Bold").fontSize(14).text(title, { width: 504 });
    doc.moveDown(0.8);

    for (const block of body.split(/\n{2,}/)) {
      const paragraph = block.trim();
      if (!paragraph) continue;
      doc
        .fillColor("#2B2118")
        .font("Helvetica")
        .fontSize(10.5)
        .text(paragraph, { width: 504, lineGap: 2 });
      doc.moveDown(0.6);
    }

    const footer = [...companyAddressLines(company), companyContactLine(company)].filter(Boolean);
    if (footer.length) {
      doc.moveDown(1);
      doc.fillColor("#6F675F").font("Helvetica").fontSize(9).text(footer.join("\n"), {
        width: 504,
        lineGap: 1,
      });
    }

    doc.end();
  });
}

export async function sendEstimateViaGmail(
  {
    toEmail,
    subject,
    html,
    pdf,
    estimateId,
    company,
    attachments = [],
  }: {
    toEmail: string;
    subject: string;
    html: string;
    pdf: Buffer;
    estimateId: number;
    company?: CompanyProfile;
    /** Documents and photos the sender chose, in the order they will appear. */
    attachments?: EmailAttachment[];
  },
  proxy: GmailProxy = defaultGmailProxy,
) {
  const boundary = `bison_estimate_${randomBytes(12).toString("hex")}`;
  const parts: EmailAttachment[] = [
    { fileName: attachmentFileName(estimateId, company), contentType: "application/pdf", bytes: pdf },
    ...attachments,
  ];
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
    ...parts.flatMap((part) => {
      const fileName = safeFileName(part.fileName, "attachment");
      return [
        `--${boundary}`,
        `Content-Type: ${part.contentType}; name="${fileName}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${fileName}"`,
        "",
        encodeBase64Lines(part.bytes),
      ];
    }),
    `--${boundary}--`,
  ].join("\r\n");

  // Last line of defence. The route weighs the selection before it claims the
  // delivery, so reaching this means the estimate PDF itself was unexpectedly
  // large — still better refused here, with a reason, than handed to Gmail to
  // fail on with an error nobody in the office can read.
  const messageBytes = Buffer.byteLength(mime);
  if (messageBytes > GMAIL_MAX_MESSAGE_BYTES) {
    throw new Error(
      `This email is ${describeBytes(messageBytes)}, over the ` +
        `${describeBytes(GMAIL_MAX_MESSAGE_BYTES)} Gmail accepts. Send fewer attachments.`,
    );
  }

  return sendRawGmailMessage(mime, proxy);
}
