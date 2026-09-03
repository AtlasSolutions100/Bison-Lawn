import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { db, documentTemplatesTable } from "@workspace/db";
import type { Estimate, EstimateLine, Client, CompanyProfile } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCompanyProfile } from "./companyProfile";
import { firstNameOf, renderTemplate } from "./mergeTokens";

/** The company details and contract text one estimate document renders with. */
export type EstimateBranding = {
  company: CompanyProfile;
  /** His terms with merge tokens already resolved, or null when unavailable. */
  contract: string | null;
};

export type EstimateDocumentData = {
  estimate: Estimate;
  client: Client;
  quotedServices: { id: number; name: string; description: string | null }[];
  branding?: EstimateBranding;
};

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

const GREEN = "#215343";
const DARK = "#2B2118";
const MUTED = "#6F675F";
const RULE = "#E7E2DC";
const TINT = "#EBF1EE";

const CONTRACT_TEMPLATE_KEY = "service-contract";

/**
 * Stand-in for a profile that was never loaded, mirroring the column defaults.
 *
 * Only ever reached by a document built without the async step that resolves
 * the real profile, and it exists so such a document still names the company
 * instead of rendering "undefined" at a customer.
 */
export const FALLBACK_COMPANY_PROFILE = {
  name: "Bison Lawn Care LLC",
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  phone: null,
  email: null,
  website: null,
  signatureLine: "Your Friendly Bison,",
} as unknown as CompanyProfile;

/**
 * Company profile plus his contract, resolved once and kept on the document.
 *
 * Cached onto `data` rather than fetched twice because the PDF and the email
 * body are built from the same object within one request, and the email
 * builder is synchronous — its caller has no await to hand it. Resolving here
 * guarantees both halves of one estimate quote the same company details.
 */
export async function resolveEstimateBranding(data: EstimateDocumentData): Promise<EstimateBranding> {
  if (data.branding) return data.branding;

  const company = await getCompanyProfile();
  let contract: string | null = null;
  try {
    const [row] = await db
      .select({ body: documentTemplatesTable.body })
      .from(documentTemplatesTable)
      .where(eq(documentTemplatesTable.key, CONTRACT_TEMPLATE_KEY))
      .limit(1);
    if (row?.body.trim()) {
      contract = renderTemplate(row.body, {
        client: data.client,
        company,
        quoteTotal: data.estimate.total,
      }).trim();
    }
  } catch {
    // The office can delete or rename his contract template, and a deployment
    // can be mid-migration. Neither is a reason to withhold a quote the
    // customer is waiting on, so the terms are simply left off.
    contract = null;
  }

  data.branding = { company, contract };
  return data.branding;
}

const BRAND_ASSET_DIR = join("artifacts", "bison-crm", "public");
const brandAssetPaths = new Map<string, string | null>();

/**
 * Absolute path to a piece of brand artwork, or null when it cannot be found.
 *
 * The same file has to be located from two different layouts: in dev this
 * module runs from `artifacts/api-server/src/lib`, and in the Docker image it
 * is bundled into `artifacts/api-server/dist/index.mjs`. Both sit inside the
 * same repository copy, so walking up to the first ancestor that still
 * contains the web app's public folder resolves it either way without
 * hardcoding a depth that is only correct for one of them.
 *
 * Returning null instead of a guess matters: a header without a logo is a
 * cosmetic loss, while a path that throws inside pdfkit costs the customer
 * their quote.
 */
function brandAssetPath(fileName: string): string | null {
  const cached = brandAssetPaths.get(fileName);
  if (cached !== undefined) return cached;

  let dir = dirname(fileURLToPath(import.meta.url));
  let found: string | null = null;
  for (;;) {
    const candidate = join(dir, BRAND_ASSET_DIR, fileName);
    if (existsSync(candidate)) {
      found = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  brandAssetPaths.set(fileName, found);
  return found;
}

/** Draw brand artwork, reporting whether it landed so callers can fall back. */
export function drawBrandImage(
  doc: PDFKit.PDFDocument,
  fileName: string,
  x: number,
  y: number,
  width: number,
) {
  const path = brandAssetPath(fileName);
  if (!path) return false;
  try {
    doc.image(path, x, y, { width });
    return true;
  } catch {
    // Unreadable or unsupported artwork must not take the document with it.
    return false;
  }
}

/** Absolute URL for artwork in an email, or null when no public origin is set. */
export function brandAssetUrl(fileName: string): string | null {
  const origin = process.env.APP_PUBLIC_URL?.trim();
  if (!origin) return null;
  try {
    return new URL(`/${fileName}`, origin).toString();
  } catch {
    return null;
  }
}

const cityStateZip = (company: CompanyProfile) =>
  [[company.city, company.state].filter(Boolean).join(", "), company.postalCode].filter(Boolean).join(" ").trim();

/** The company's postal address, one line per element, blanks dropped. */
export function companyAddressLines(company: CompanyProfile) {
  return [company.addressLine1, company.addressLine2, cityStateZip(company)]
    .map((line) => (line ?? "").trim())
    .filter(Boolean);
}

/** Phone | email | website, as the footer of his own letters reads. */
export const companyContactLine = (company: CompanyProfile) =>
  [company.phone, company.email, company.website].map((v) => (v ?? "").trim()).filter(Boolean).join("  |  ");

/** The customer's address block, as it appears at the head of one of his letters. */
function clientAddressLines(client: Client) {
  const cityLine = [[client.city, client.state].filter(Boolean).join(", "), client.postalCode]
    .filter(Boolean)
    .join(" ")
    .trim();
  return [client.serviceAddress, client.addressLine2, cityLine, client.email]
    .map((line) => (line ?? "").trim())
    .filter(Boolean);
}

/**
 * A standalone heading in his contract — "Payment Disclosure:" and friends.
 * Multi-line paragraphs such as "Client Responsibilities: The Client shall:"
 * are body copy that happens to end in a colon, so length and line count both
 * have to agree before a paragraph is set in bold.
 */
const isContractHeading = (paragraph: string) =>
  !paragraph.includes("\n") && paragraph.endsWith(":") && paragraph.length < 40;

export async function createEstimatePdf(data: EstimateDocumentData): Promise<Buffer> {
  // Resolved before the stream opens so a failed lookup cannot abandon a
  // half-written document.
  const { company, contract } = await resolveEstimateBranding(data);
  const { estimate, client, quotedServices } = data;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54, info: { Title: `Estimate ${estimate.id}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let y = 0;
    /** Start a new page when `needed` points below the bottom margin. */
    const needSpace = (needed: number) => {
      if (y + needed > 726) {
        doc.addPage();
        y = 54;
      }
    };

    // --- letterhead -------------------------------------------------------
    // His artwork is dark green on transparent, so it sits on the page itself
    // rather than in the coloured bar this header used to be.
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

    doc.fillColor(GREEN).font("Helvetica-Bold").fontSize(17).text(`ESTIMATE #${estimate.id}`, 54, y, { width: 300 });
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(
      `Created: ${estimate.createdAt.toLocaleDateString("en-US")}\nStatus: ${estimate.status.toUpperCase()}`,
      330,
      y + 2,
      { width: 228, align: "right", lineGap: 1 },
    );
    y = doc.y + 22;

    // --- address block ----------------------------------------------------
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8.5).text("PREPARED FOR", 54, y, { characterSpacing: 1 });
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(11).text(client.name, 54, doc.y + 5, { width: 300 });
    const clientLines = clientAddressLines(client);
    if (clientLines.length) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(clientLines.join("\n"), 54, doc.y + 1, {
        width: 300,
        lineGap: 1,
      });
    }
    y = doc.y + 20;

    const greetingName = firstNameOf(client.name);
    if (greetingName) {
      doc.fillColor(DARK).font("Helvetica").fontSize(11).text(`Dear ${greetingName},`, 54, y, { width: 504 });
      y = doc.y + 12;
    }

    if (estimate.coverNote?.trim()) {
      doc
        .fillColor(DARK)
        .font("Helvetica")
        .fontSize(10.5)
        .text(estimate.coverNote.trim(), 54, y, { width: 504, lineGap: 3 });
      y = doc.y + 20;
      needSpace(120);
    }

    // --- quoted services --------------------------------------------------
    doc.rect(54, y, 504, 30).fill(TINT);
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10);
    doc.text("DESCRIPTION", 66, y + 10, { width: 270 });
    doc.text("DETAIL", 340, y + 10, { width: 105 });
    doc.text("AMOUNT", 450, y + 10, { width: 96, align: "right" });
    y += 40;

    for (const line of estimate.lines as EstimateLine[]) {
      needSpace(46);
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text(line.label, 66, y, { width: 260 });
      doc.fillColor(MUTED).font("Helvetica").text(line.value || "—", 340, y, { width: 105 });
      doc
        .fillColor(DARK)
        .text(line.calculatedPrice == null ? "—" : money(line.calculatedPrice), 450, y, {
          width: 96,
          align: "right",
        });
      y = Math.max(doc.y, y + 18) + 10;
      doc.moveTo(54, y).lineTo(558, y).lineWidth(1).strokeColor(RULE).stroke();
      y += 12;
    }

    needSpace(50);
    y += 8;
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(14).text("TOTAL", 350, y, { width: 95 });
    doc.fillColor(GREEN).fontSize(16).text(money(estimate.total), 450, y - 2, {
      width: 96,
      align: "right",
    });
    y += 46;

    if (estimate.notes) {
      needSpace(70);
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(11).text("NOTES", 54, y);
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(estimate.notes, 54, doc.y + 6, { width: 504 });
      y = doc.y + 22;
    }

    if (estimate.includeServiceDescriptions) {
      const descriptions = (estimate.lines as EstimateLine[])
        .map((line) => {
          if (line.serviceId == null) return null;
          const service = quotedServices.find((candidate) => candidate.id === line.serviceId);
          if (!service?.description?.trim()) return null;
          return { name: line.label || service.name, description: service.description.trim() };
        })
        .filter((entry): entry is { name: string; description: string } => entry != null);
      if (descriptions.length) {
        needSpace(80);
        doc.fillColor(DARK).font("Helvetica-Bold").fontSize(12).text("SERVICE DESCRIPTIONS", 54, y);
        y = doc.y + 12;
        for (const service of descriptions) {
          doc.font("Helvetica").fontSize(10);
          needSpace(doc.heightOfString(service.description, { width: 504, lineGap: 2 }) + 38);
          doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text(service.name, 54, y, { width: 504 });
          doc
            .fillColor(MUTED)
            .font("Helvetica")
            .fontSize(10)
            .text(service.description, 54, doc.y + 4, { width: 504, lineGap: 2 });
          y = doc.y + 14;
        }
      }
    }

    // --- sign-off and company block ---------------------------------------
    const companyBlock = [company.name, ...companyAddressLines(company), company.phone, company.email]
      .map((line) => (line ?? "").trim())
      .filter(Boolean);
    needSpace(38 + companyBlock.length * 14);
    y += 10;
    doc.fillColor(DARK).font("Helvetica").fontSize(10.5).text([company.signatureLine.trim(), "", ...companyBlock].join("\n"), 54, y, {
      width: 300,
      lineGap: 2,
    });
    y = doc.y + 26;

    // --- centred thank-you footer, as his letters close -------------------
    const emblemWidth = 54;
    needSpace(emblemWidth + 60);
    if (drawBrandImage(doc, "logo-emblem.png", (612 - emblemWidth) / 2, y, emblemWidth)) {
      y += emblemWidth + 6;
    }
    doc.fillColor(GREEN).font("Helvetica-Bold").fontSize(12).text("Thank you for your business!", 54, y, {
      width: 504,
      align: "center",
    });
    const footerLines = [...companyAddressLines(company), companyContactLine(company)].filter(Boolean);
    if (footerLines.length) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(footerLines.join("\n"), 54, doc.y + 6, {
        width: 504,
        align: "center",
        lineGap: 1,
      });
    }

    // --- terms ------------------------------------------------------------
    // Always its own page: the quote above is what the customer reads, and the
    // terms are what they keep.
    if (contract) {
      doc.addPage();
      y = 54;
      for (const paragraph of contract.split(/\n{2,}/)) {
        const text = paragraph.trim();
        if (!text) continue;
        const heading = isContractHeading(text);
        doc.font(heading ? "Helvetica-Bold" : "Helvetica").fontSize(heading ? 11 : 8.5);
        const height = doc.heightOfString(text, { width: 504, lineGap: heading ? 0 : 1.5 });
        if (y + height > 740) {
          doc.addPage();
          y = 54;
        }
        doc.fillColor(heading ? GREEN : DARK).text(text, 54, y, { width: 504, lineGap: heading ? 0 : 1.5 });
        y = doc.y + (heading ? 10 : 9);
      }
    }

    doc.end();
  });
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** His stored documents are plain text; keep the paragraph breaks in HTML. */
const paragraphs = (text: string, style: string) =>
  text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="${style}">${escape(block).replace(/\n/g, "<br />")}</p>`)
    .join("");

export function createEstimateEmailHtml(
  data: EstimateDocumentData,
  message: string | undefined,
  acceptUrl: string,
  declineUrl: string,
) {
  const { estimate, client } = data;
  // Populated by createEstimatePdf, which the send path always builds first.
  const company = data.branding?.company ?? FALLBACK_COMPANY_PROFILE;
  const contract = data.branding?.contract ?? null;

  const rows = (estimate.lines as EstimateLine[])
    .map(
      (line) => `<tr>
        <td style="padding:10px;border-bottom:1px solid #e7e2dc">${escape(line.label)}</td>
        <td style="padding:10px;border-bottom:1px solid #e7e2dc">${escape(line.value || "—")}</td>
        <td style="padding:10px;border-bottom:1px solid #e7e2dc;text-align:right">${
          line.calculatedPrice == null ? "—" : money(line.calculatedPrice)
        }</td>
      </tr>`,
    )
    .join("");

  // Most mail clients block remote images, so every logo here is decoration:
  // the company name, address and contact details are all present as text.
  const wordmark = brandAssetUrl("logo-wordmark.png");
  const emblem = brandAssetUrl("logo-emblem.png");
  const greeting = firstNameOf(client.name) || client.name;
  const clientLines = clientAddressLines(client);
  const contactLine = companyContactLine(company);
  const footerAddress = companyAddressLines(company);

  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:620px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
      <div style="padding:26px 32px 18px;text-align:center">
        ${
          wordmark
            ? `<img src="${escape(wordmark)}" alt="${escape(company.name)}" width="240" style="display:inline-block;width:240px;max-width:100%;height:auto;border:0" />`
            : `<h1 style="margin:0;font-size:24px;color:#215343">${escape(company.name)}</h1>`
        }
      </div>
      <div style="background:#215343;color:#fff;padding:16px 32px">
        <p style="margin:0;font-size:18px;font-weight:bold">Estimate #${estimate.id}</p>
        <p style="margin:6px 0 0;font-size:13px">${escape(company.name)}</p>
      </div>
      <div style="padding:32px">
        <p style="margin:0 0 20px;font-size:12px;color:#6f675f;line-height:1.5">
          <strong style="color:#2b2118">${escape(client.name)}</strong>${
            clientLines.length ? `<br />${clientLines.map(escape).join("<br />")}` : ""
          }
        </p>
        <p>Dear ${escape(greeting)},</p>
        <p>${escape(message || "Thank you for the opportunity to care for your property. Please review your estimate below.")}</p>
        <table style="width:100%;border-collapse:collapse;margin:24px 0">
          <thead><tr style="background:#ebf1ee"><th style="padding:10px;text-align:left">Description</th><th style="padding:10px;text-align:left">Detail</th><th style="padding:10px;text-align:right">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-size:20px;font-weight:bold;text-align:right">Total: <span style="color:#215343">${money(estimate.total)}</span></p>
        ${estimate.notes ? `<p style="color:#6f675f"><strong>Notes:</strong> ${escape(estimate.notes)}</p>` : ""}
        <div style="margin:30px 0;text-align:center">
          <a href="${escape(acceptUrl)}" style="display:inline-block;background:#215343;color:#fff;padding:13px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin:4px">Accept Estimate</a>
          <a href="${escape(declineUrl)}" style="display:inline-block;border:1px solid #8c837a;color:#4d453e;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin:4px">Decline</a>
        </div>
        <p style="font-size:12px;color:#6f675f;text-align:center">A PDF copy is attached for your records.</p>
        <p style="margin:28px 0 0;line-height:1.6">${escape(company.signatureLine)}<br /><br /><strong>${escape(company.name)}</strong>${
          contactLine ? `<br />${escape(contactLine)}` : ""
        }</p>
        ${
          contract
            ? `<div style="margin-top:32px;border-top:1px solid #e7e2dc;padding-top:20px">
          ${paragraphs(contract, "margin:0 0 10px;font-size:11px;line-height:1.5;color:#4d453e")}
        </div>`
            : ""
        }
      </div>
      <div style="background:#f7f5f1;padding:24px 32px;text-align:center;border-top:1px solid #e7e2dc">
        ${
          emblem
            ? `<img src="${escape(emblem)}" alt="" width="56" style="display:inline-block;width:56px;height:auto;border:0" />`
            : ""
        }
        <p style="margin:8px 0 0;font-weight:bold;color:#215343">Thank you for your business!</p>
        ${footerAddress.length ? `<p style="margin:8px 0 0;font-size:12px;color:#6f675f">${footerAddress.map(escape).join("<br />")}</p>` : ""}
        ${contactLine ? `<p style="margin:6px 0 0;font-size:12px;color:#6f675f">${escape(contactLine)}</p>` : ""}
      </div>
    </div>
  </body></html>`;
}
