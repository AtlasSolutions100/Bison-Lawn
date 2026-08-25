import PDFDocument from "pdfkit";
import type { Estimate, EstimateLine, Client } from "@workspace/db";

export type EstimateDocumentData = {
  estimate: Estimate;
  client: Client;
  quotedServices: { id: number; name: string; description: string | null }[];
};

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

export async function createEstimatePdf({ estimate, client, quotedServices }: EstimateDocumentData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54, info: { Title: `Estimate ${estimate.id}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const green = "#176B45";
    const dark = "#2B2118";
    const muted = "#6F675F";
    doc.rect(0, 0, 612, 110).fill(green);
    doc.fillColor("#FFFFFF").fontSize(24).font("Helvetica-Bold").text("Bison Lawn Care LLC", 54, 38);
    doc.fontSize(11).font("Helvetica").text("Professional lawn care & landscaping", 54, 72);
    doc.fontSize(20).font("Helvetica-Bold").text("ESTIMATE", 430, 40, { width: 128, align: "right" });
    doc.fontSize(10).font("Helvetica").text(`#${estimate.id}`, 430, 70, { width: 128, align: "right" });

    doc.fillColor(dark).font("Helvetica-Bold").fontSize(12).text("PREPARED FOR", 54, 142);
    doc.font("Helvetica").fontSize(11).text(client.name, 54, 163);
    if (client.serviceAddress) doc.text(client.serviceAddress);
    if (client.city) doc.text(client.city);
    if (client.email) doc.text(client.email);

    doc.font("Helvetica-Bold").text("ESTIMATE DETAILS", 360, 142, { width: 198 });
    doc.font("Helvetica").text(`Created: ${estimate.createdAt.toLocaleDateString("en-US")}`, 360, 163, {
      width: 198,
    });
    doc.text(`Status: ${estimate.status.toUpperCase()}`, { width: 198 });

    let y = 235;
    if (estimate.coverNote?.trim()) {
      doc.fillColor(dark).font("Helvetica-Bold").fontSize(11).text("A NOTE FROM BISON LAWN CARE", 54, y);
      doc
        .fillColor(muted)
        .font("Helvetica")
        .fontSize(10)
        .text(estimate.coverNote.trim(), 54, y + 18, { width: 504, lineGap: 3 });
      y = doc.y + 24;
      if (y > 650) {
        doc.addPage();
        y = 54;
      }
    }
    doc.rect(54, y, 504, 30).fill("#EAF3EE");
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(10);
    doc.text("DESCRIPTION", 66, y + 10, { width: 270 });
    doc.text("DETAIL", 340, y + 10, { width: 105 });
    doc.text("AMOUNT", 450, y + 10, { width: 96, align: "right" });
    y += 40;

    for (const line of estimate.lines as EstimateLine[]) {
      if (y > 680) {
        doc.addPage();
        y = 54;
      }
      doc.fillColor(dark).font("Helvetica-Bold").fontSize(10).text(line.label, 66, y, { width: 260 });
      doc.fillColor(muted).font("Helvetica").text(line.value || "—", 340, y, { width: 105 });
      doc
        .fillColor(dark)
        .text(line.calculatedPrice == null ? "—" : money(line.calculatedPrice), 450, y, {
          width: 96,
          align: "right",
        });
      y = Math.max(doc.y, y + 18) + 10;
      doc.moveTo(54, y).lineTo(558, y).strokeColor("#E7E2DC").stroke();
      y += 12;
    }

    y += 8;
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(14).text("TOTAL", 350, y, { width: 95 });
    doc.fillColor(green).fontSize(16).text(money(estimate.total), 450, y - 2, {
      width: 96,
      align: "right",
    });

    if (estimate.notes) {
      y += 55;
      if (y > 680) {
        doc.addPage();
        y = 54;
      }
      doc.fillColor(dark).font("Helvetica-Bold").fontSize(11).text("NOTES", 54, y);
      doc.fillColor(muted).font("Helvetica").fontSize(10).text(estimate.notes, 54, y + 18, { width: 504 });
      y = doc.y + 24;
    } else {
      y += 55;
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
        if (y > 640) {
          doc.addPage();
          y = 54;
        }
        doc.fillColor(dark).font("Helvetica-Bold").fontSize(12).text("SERVICE DESCRIPTIONS", 54, y);
        y = doc.y + 12;
        for (const service of descriptions) {
          const needed = doc.heightOfString(service.description, { width: 504, lineGap: 2 }) + 38;
          if (y + needed > 700) {
            doc.addPage();
            y = 54;
          }
          doc.fillColor(dark).font("Helvetica-Bold").fontSize(10).text(service.name, 54, y, { width: 504 });
          doc
            .fillColor(muted)
            .font("Helvetica")
            .fontSize(10)
            .text(service.description, 54, doc.y + 4, { width: 504, lineGap: 2 });
          y = doc.y + 14;
        }
      }
    }

    doc
      .fillColor(muted)
      .fontSize(9)
      .text("Thank you for considering Bison Lawn Care LLC.", 54, 735, { width: 504, align: "center" });
    doc.end();
  });
}

export function createEstimateEmailHtml(
  data: EstimateDocumentData,
  message: string | undefined,
  acceptUrl: string,
  declineUrl: string,
) {
  const { estimate, client } = data;
  const escape = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:620px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
      <div style="background:#176b45;color:#fff;padding:28px 32px">
        <h1 style="margin:0;font-size:24px">Bison Lawn Care LLC</h1>
        <p style="margin:8px 0 0">Estimate #${estimate.id}</p>
      </div>
      <div style="padding:32px">
        <p>Hi ${escape(client.name)},</p>
        <p>${escape(message || "Thank you for the opportunity to care for your property. Please review your estimate below.")}</p>
        <table style="width:100%;border-collapse:collapse;margin:24px 0">
          <thead><tr style="background:#eaf3ee"><th style="padding:10px;text-align:left">Description</th><th style="padding:10px;text-align:left">Detail</th><th style="padding:10px;text-align:right">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-size:20px;font-weight:bold;text-align:right">Total: <span style="color:#176b45">${money(estimate.total)}</span></p>
        ${estimate.notes ? `<p style="color:#6f675f"><strong>Notes:</strong> ${escape(estimate.notes)}</p>` : ""}
        <div style="margin:30px 0;text-align:center">
          <a href="${escape(acceptUrl)}" style="display:inline-block;background:#176b45;color:#fff;padding:13px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin:4px">Accept Estimate</a>
          <a href="${escape(declineUrl)}" style="display:inline-block;border:1px solid #8c837a;color:#4d453e;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin:4px">Decline</a>
        </div>
        <p style="font-size:12px;color:#6f675f;text-align:center">A PDF copy is attached for your records.</p>
      </div>
    </div>
  </body></html>`;
}