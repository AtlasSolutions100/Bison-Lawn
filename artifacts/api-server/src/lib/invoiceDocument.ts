import PDFDocument from "pdfkit";
import type { Client, CompanyProfile, Invoice, InvoiceLineItem } from "@workspace/db";
import { getCompanyProfile } from "./companyProfile";
import {
  FALLBACK_COMPANY_PROFILE,
  brandAssetUrl,
  companyAddressLines,
  companyContactLine,
  drawBrandImage,
} from "./estimateDocument";
import { firstNameOf } from "./mergeTokens";

export type InvoiceDocumentData = {
  invoice: Invoice;
  client: Client;
  lines: InvoiceLineItem[];
  company?: CompanyProfile;
};

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

const qty = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

const GREEN = "#215343";
const DARK = "#2B2118";
const MUTED = "#6F675F";
const RULE = "#E7E2DC";
const TINT = "#EBF1EE";
const DUE = "#B4451F";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The number a customer quotes on the phone, falling back to the row id. */
export const invoiceNumberOf = (invoice: Pick<Invoice, "id" | "number">) => invoice.number ?? invoice.id;

/**
 * What is still owed on this invoice.
 *
 * Never negative — overpayment is credit, not a negative bill — and always zero
 * on a void invoice. Voiding cancels the debt: `recalcClientBalance` already
 * excludes void invoices from the account balance, so an invoice stamped VOID
 * that still showed its old total under "Balance Due" contradicted the very
 * account balance it fed, in red, on both the list and the printed invoice.
 * Any money actually received against it stays on the account as credit.
 */
export const balanceOf = (invoice: Pick<Invoice, "total" | "amountPaid"> & { status?: string | null }) =>
  invoice.status === "void" ? 0 : Math.max(0, Math.round((invoice.total - invoice.amountPaid) * 100) / 100);

const dateLabel = (value: string | null | undefined) => {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  // Date-only strings are parsed as UTC midnight, which in a negative-offset
  // timezone renders as the previous day. Split the parts instead of trusting
  // Date to guess — an invoice dated a day early is a support call.
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (parts) return `${Number(parts[2])}/${Number(parts[3])}/${parts[1]}`;
  return raw;
};

/**
 * The Bill To block, which is not the same thing as the property address.
 *
 * Falls back to the service address only when no billing address is recorded —
 * that is right for the ordinary residential customer whose bill goes to the
 * house being mowed, and wrong to assume for anyone else, which is why the
 * fields exist separately.
 */
export function billToLines(client: Client) {
  const hasBilling = Boolean(
    client.billingAddressLine1 || client.billingCity || client.billingPostalCode,
  );
  const name = (client.nameOnInvoice ?? "").trim() || client.name;
  const [line1, line2, city, state, postal] = hasBilling
    ? [
        client.billingAddressLine1,
        client.billingAddressLine2,
        client.billingCity,
        client.billingState,
        client.billingPostalCode,
      ]
    : [client.serviceAddress, client.addressLine2, client.city, client.state, client.postalCode];

  const cityLine = [[city, state].filter(Boolean).join(", "), postal].filter(Boolean).join(" ").trim();
  return [name, line1, line2, cityLine].map((v) => (v ?? "").trim()).filter(Boolean);
}

/** The property block — always the address the work happens at. */
export function propertyLines(client: Client) {
  const cityLine = [[client.city, client.state].filter(Boolean).join(", "), client.postalCode]
    .filter(Boolean)
    .join(" ")
    .trim();
  return [client.name, client.serviceAddress, client.addressLine2, cityLine]
    .map((v) => (v ?? "").trim())
    .filter(Boolean);
}

export async function createInvoicePdf(data: InvoiceDocumentData): Promise<Buffer> {
  const company = data.company ?? (await getCompanyProfile());
  const { invoice, client, lines } = data;
  const number = invoiceNumberOf(invoice);
  const balance = balanceOf(invoice);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54, info: { Title: `Invoice ${number}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let y = 0;
    // The last y a block may still start at. Taken from the page rather than
    // hardcoded: a literal 700 left 38pt of every Letter page unused, which was
    // enough to push the payment coupon onto a sheet of its own on an invoice
    // with as few as three lines.
    const contentBottom = () => doc.page.height - doc.page.margins.bottom;
    const needSpace = (needed: number) => {
      if (y + needed > contentBottom()) {
        doc.addPage();
        y = 54;
      }
    };

    // --- letterhead -------------------------------------------------------
    if (!drawBrandImage(doc, "logo-wordmark.png", 54, 46, 168)) {
      doc.fillColor(GREEN).font("Helvetica-Bold").fontSize(22).text(company.name, 54, 58, { width: 260 });
    }

    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text(company.name, 330, 48, {
      width: 228,
      align: "right",
    });
    const contactBlock = [...companyAddressLines(company), company.phone, company.email, company.website]
      .map((line) => (line ?? "").trim())
      .filter(Boolean);
    if (contactBlock.length) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(contactBlock.join("\n"), 330, doc.y + 2, {
        width: 228,
        align: "right",
        lineGap: 1,
      });
    }

    y = Math.max(doc.y, 118) + 10;
    doc.moveTo(54, y).lineTo(558, y).lineWidth(2).strokeColor(GREEN).stroke();
    y += 18;

    // --- title and the meta grid -----------------------------------------
    doc.fillColor(GREEN).font("Helvetica-Bold").fontSize(19).text(`INVOICE #${number}`, 54, y, { width: 260 });
    if (invoice.status === "paid") {
      doc.fillColor(GREEN).font("Helvetica-Bold").fontSize(13).text("PAID", 54, doc.y + 4, { width: 260 });
    } else if (invoice.status === "void") {
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(13).text("VOID", 54, doc.y + 4, { width: 260 });
    }
    const titleBottom = doc.y;

    // Right-hand meta grid: label column then value column, so the labels line
    // up regardless of how many rows are populated.
    const meta: [string, string][] = [
      ["Invoice Date", dateLabel(invoice.invoiceDate) || dateLabel(invoice.createdAt.toISOString())],
      ["Terms", (invoice.terms ?? "").trim()],
      ["Due Date", dateLabel(invoice.dueDate)],
      ["PO Number", (invoice.poNumber ?? "").trim()],
      ["Account #", (client.accountNumber ?? "").trim()],
    ].filter((row): row is [string, string] => Boolean(row[1]));

    let metaY = y + 4;
    for (const [label, value] of meta) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(label, 330, metaY, { width: 104 });
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(9.5).text(value, 440, metaY, {
        width: 118,
        align: "right",
      });
      metaY += 15;
    }

    y = Math.max(titleBottom, metaY) + 20;

    // --- bill to / property ----------------------------------------------
    const billTo = billToLines(client);
    const property = propertyLines(client);
    const blockTop = y;
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8.5).text("BILL TO", 54, y, { characterSpacing: 1 });
    doc.fillColor(DARK).font("Helvetica").fontSize(10).text(billTo.join("\n"), 54, doc.y + 5, {
      width: 230,
      lineGap: 1.5,
    });
    const billBottom = doc.y;

    doc
      .fillColor(MUTED)
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .text("PROPERTY ADDRESS", 320, blockTop, { characterSpacing: 1 });
    doc.fillColor(DARK).font("Helvetica").fontSize(10).text(property.join("\n"), 320, doc.y + 5, {
      width: 238,
      lineGap: 1.5,
    });

    y = Math.max(billBottom, doc.y) + 24;

    // --- line items -------------------------------------------------------
    // Column x-positions, matching the Description | Date | Qty | Price | Total
    // order of the invoices he sends today.
    const COL = { desc: 66, date: 300, qty: 384, price: 428, total: 492 };
    const drawHeader = () => {
      doc.rect(54, y, 504, 26).fill(TINT);
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(9);
      doc.text("DESCRIPTION", COL.desc, y + 9, { width: 226 });
      doc.text("DATE", COL.date, y + 9, { width: 76 });
      doc.text("QTY", COL.qty, y + 9, { width: 36, align: "right" });
      doc.text("PRICE", COL.price, y + 9, { width: 56, align: "right" });
      doc.text("TOTAL", COL.total, y + 9, { width: 54, align: "right" });
      y += 34;
    };
    drawHeader();

    if (lines.length === 0) {
      doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(10).text("No itemised lines.", COL.desc, y, {
        width: 400,
      });
      y = doc.y + 12;
    }

    for (const line of lines) {
      doc.font("Helvetica").fontSize(10);
      const descHeight = doc.heightOfString(line.description, { width: 226, lineGap: 1 });
      needSpace(descHeight + 22);
      if (y === 54) drawHeader();

      const rowTop = y;
      doc.fillColor(DARK).font("Helvetica").fontSize(10).text(line.description, COL.desc, rowTop, {
        width: 226,
        lineGap: 1,
      });
      doc.fillColor(MUTED).fontSize(9.5).text(dateLabel(line.serviceDate) || "—", COL.date, rowTop, {
        width: 76,
      });
      doc.fillColor(DARK).fontSize(9.5).text(qty(line.quantity), COL.qty, rowTop, { width: 36, align: "right" });
      doc.text(money(line.unitPrice), COL.price, rowTop, { width: 56, align: "right" });
      doc.font("Helvetica-Bold").text(money(line.total), COL.total, rowTop, { width: 54, align: "right" });

      y = Math.max(doc.y, rowTop + descHeight) + 8;
      doc.moveTo(54, y).lineTo(558, y).lineWidth(0.75).strokeColor(RULE).stroke();
      y += 10;
    }

    // --- totals -----------------------------------------------------------
    needSpace(96);
    y += 6;
    const totalRow = (label: string, value: string, opts?: { bold?: boolean; color?: string }) => {
      doc
        .fillColor(opts?.bold ? DARK : MUTED)
        .font(opts?.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(opts?.bold ? 11 : 10)
        .text(label, 340, y, { width: 130, align: "right" });
      doc
        .fillColor(opts?.color ?? DARK)
        .font(opts?.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(opts?.bold ? 12 : 10)
        .text(value, 478, y, { width: 80, align: "right" });
      y += opts?.bold ? 20 : 16;
    };

    totalRow("Subtotal", money(invoice.total));
    totalRow("Invoice Total", money(invoice.total), { bold: true });
    if (invoice.amountPaid > 0) totalRow("Paid", `-${money(invoice.amountPaid)}`);
    totalRow("Balance Due", money(balance), { bold: true, color: balance > 0 ? DUE : GREEN });

    if (invoice.notes?.trim()) {
      needSpace(60);
      y += 10;
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text("NOTES", 54, y);
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(invoice.notes.trim(), 54, doc.y + 5, {
        width: 504,
        lineGap: 2,
      });
      y = doc.y + 14;
    }

    // --- payment coupon ---------------------------------------------------
    // A detachable stub, as on his own invoices: the customer tears it off and
    // returns it with a cheque, which is how a real share of his book pays.
    // What the block below actually occupies: the gap and rule (32), the
    // heading and its gap (20), the taller of the address and the three meta
    // rows, the gap above the remit line (12), and the remit and contact lines
    // with room for the remit to wrap (48). Measured at 133.9pt for a
    // three-line address, so this stays an upper bound — it has to be, or the
    // coupon tears across the page break, which is worse than a second sheet.
    needSpace(32 + 20 + Math.max(billTo.length * 13.5, 45) + 12 + 48);
    y += 16;
    doc.save().dash(3, { space: 3 }).moveTo(54, y).lineTo(558, y).lineWidth(1).strokeColor(MUTED).stroke().restore();
    y += 16;

    doc
      .fillColor(MUTED)
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .text("PAYMENT COUPON", 54, y, { characterSpacing: 1 });
    y = doc.y + 8;

    const couponTop = y;
    doc.fillColor(DARK).font("Helvetica").fontSize(10).text(billTo.join("\n"), 54, couponTop, {
      width: 230,
      lineGap: 1.5,
    });
    const couponLeftBottom = doc.y;

    const couponMeta: [string, string][] = [
      ["Invoice #", String(number)],
      ["Invoice Balance", money(balance)],
      ["Account Balance", money(client.accountBalance)],
    ];
    let couponY = couponTop;
    for (const [label, value] of couponMeta) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(label, 320, couponY, { width: 130 });
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(9.5).text(value, 456, couponY, {
        width: 102,
        align: "right",
      });
      couponY += 15;
    }

    y = Math.max(couponLeftBottom, couponY) + 12;
    const remitTo = [company.name, ...companyAddressLines(company)].filter(Boolean);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`Remit to: ${remitTo.join(", ")}`, 54, y, {
      width: 504,
    });
    y = doc.y + 6;
    const contact = companyContactLine(company);
    if (contact) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(contact, 54, y, { width: 504 });
    }

    doc.end();
  });
}

/** Subject line for the invoice email. */
export function invoiceEmailSubject(
  invoice: Pick<Invoice, "id" | "number">,
  company: CompanyProfile = FALLBACK_COMPANY_PROFILE,
) {
  return `Invoice #${invoiceNumberOf(invoice)} | ${company.name}`;
}

export function createInvoiceEmailHtml(data: {
  invoice: Invoice;
  client: Client;
  lines: InvoiceLineItem[];
  company?: CompanyProfile;
}) {
  const company = data.company ?? FALLBACK_COMPANY_PROFILE;
  const { invoice, client, lines } = data;
  const number = invoiceNumberOf(invoice);
  const balance = balanceOf(invoice);
  const greeting = firstNameOf(client.name);
  const wordmark = brandAssetUrl("logo-wordmark.png");
  const emblem = brandAssetUrl("logo-emblem.png");

  const rows =
    lines
      .map(
        (line) =>
          `<tr>
            <td style="padding:8px 0;border-bottom:1px solid #e7e2dc">${escapeHtml(line.description)}${
              line.serviceDate
                ? `<div style="color:#6f675f;font-size:12px">${escapeHtml(dateLabel(line.serviceDate))}</div>`
                : ""
            }</td>
            <td style="padding:8px 0;border-bottom:1px solid #e7e2dc;text-align:right;white-space:nowrap">${escapeHtml(qty(line.quantity))}</td>
            <td style="padding:8px 0 8px 12px;border-bottom:1px solid #e7e2dc;text-align:right;white-space:nowrap">${escapeHtml(money(line.total))}</td>
          </tr>`,
      )
      .join("") ||
    `<tr><td colspan="3" style="padding:8px 0;color:#6f675f">See attached invoice for detail.</td></tr>`;

  const meta = ([
    ["Invoice Date", dateLabel(invoice.invoiceDate) || dateLabel(invoice.createdAt.toISOString())],
    ["Terms", (invoice.terms ?? "").trim()],
    ["Due Date", dateLabel(invoice.dueDate)],
    ["PO Number", (invoice.poNumber ?? "").trim()],
    ["Account #", (client.accountNumber ?? "").trim()],
  ] as [string, string][])
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 14px 2px 0;color:#6f675f;white-space:nowrap">${k}</td><td style="padding:2px 0"><strong>${escapeHtml(v)}</strong></td></tr>`,
    )
    .join("");

  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:640px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
      <div style="padding:26px 32px 18px;text-align:center">
        ${
          wordmark
            ? `<img src="${escapeHtml(wordmark)}" alt="${escapeHtml(company.name)}" width="240" style="display:inline-block;width:240px;max-width:100%;height:auto;border:0" />`
            : `<h1 style="margin:0;color:#215343;font-size:22px">${escapeHtml(company.name)}</h1>`
        }
      </div>
      <div style="background:#215343;color:#fff;padding:18px 32px">
        <h1 style="margin:0;font-size:20px">Invoice #${escapeHtml(String(number))}</h1>
        <p style="margin:6px 0 0;font-size:15px">Balance due ${escapeHtml(money(balance))}</p>
      </div>
      <div style="padding:28px 32px">
        ${greeting ? `<p style="margin:0 0 16px">Dear ${escapeHtml(greeting)},</p>` : ""}
        <p style="margin:0 0 20px;line-height:1.6">
          Thank you for your business. Your invoice is below and attached as a PDF.
        </p>
        ${meta ? `<table style="font-size:13px;border-collapse:collapse;margin-bottom:22px">${meta}</table>` : ""}
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr>
              <th align="left" style="padding:0 0 8px;border-bottom:2px solid #215343;color:#6f675f;font-size:12px;letter-spacing:1px">DESCRIPTION</th>
              <th align="right" style="padding:0 0 8px;border-bottom:2px solid #215343;color:#6f675f;font-size:12px;letter-spacing:1px">QTY</th>
              <th align="right" style="padding:0 0 8px 12px;border-bottom:2px solid #215343;color:#6f675f;font-size:12px;letter-spacing:1px">TOTAL</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="2" align="right" style="padding:14px 0 0;font-weight:bold">Invoice Total</td>
              <td align="right" style="padding:14px 0 0 12px;font-weight:bold">${escapeHtml(money(invoice.total))}</td>
            </tr>
            ${
              invoice.amountPaid > 0
                ? `<tr><td colspan="2" align="right" style="padding:4px 0 0;color:#6f675f">Paid</td>
                   <td align="right" style="padding:4px 0 0 12px;color:#6f675f">-${escapeHtml(money(invoice.amountPaid))}</td></tr>`
                : ""
            }
            <tr>
              <td colspan="2" align="right" style="padding:8px 0 0;font-weight:bold;font-size:16px">Balance Due</td>
              <td align="right" style="padding:8px 0 0 12px;font-weight:bold;font-size:16px;color:${balance > 0 ? DUE : GREEN}">${escapeHtml(money(balance))}</td>
            </tr>
          </tfoot>
        </table>
        <p style="margin:26px 0 0;font-size:12px;color:#6f675f;line-height:1.6">
          Questions about this invoice? Just reply to this email and the office will get back to you.
        </p>
      </div>
      <div style="border-top:1px solid #e7e2dc;padding:22px 32px;text-align:center;color:#6f675f;font-size:12px">
        ${
          emblem
            ? `<img src="${escapeHtml(emblem)}" alt="" width="72" style="display:inline-block;width:72px;height:auto;border:0;margin-bottom:10px" />`
            : ""
        }
        <div><strong style="color:#2b2118">${escapeHtml(company.name)}</strong></div>
        ${companyAddressLines(company)
          .map((line) => `<div>${escapeHtml(line)}</div>`)
          .join("")}
        ${companyContactLine(company) ? `<div style="margin-top:6px">${escapeHtml(companyContactLine(company))}</div>` : ""}
      </div>
    </div>
  </body></html>`;
}
