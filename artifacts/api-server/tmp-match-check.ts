import { matchInvoiceToCustomers } from "./src/lib/vendorInvoiceParse";

const candidates = [
  { clientId: 1, clientName: "Marcy Olander", address: "77 Kagy Blvd", city: "Bozeman" },
  { clientId: 2, clientName: "Cedar Hollow HOA", address: "202 Cedar Hollow Way", city: "Bozeman" },
];

const invoice = `ACME SPRAY SERVICE
Invoice #40122      Page 1 of 1
Date: 08/12/2026

Description                Property                              Amount
Fertilizer + broadleaf     77 KAGY BOULEVARD, BOZEMAN MT         $75.00
Round 3 fert   Cedar Hollow H.O.A.   202 Cedar Hollow Wy.        75.00
Turf app       Bob Sandoval          1450 Durston Rd             75.00
Spot spray     M. Olander                                        35.00
Weed control   Ridgeline Property Group   1200 Baxter Lane       75.00
Subtotal                                                        335.00
Total Due                                                       335.00
Thank you for your business!`;

const result = matchInvoiceToCustomers(invoice, candidates);
for (const match of result.matches) {
  const name = candidates.find((c) => c.clientId === match.clientId)!.clientName;
  console.log(`${name}: ${match.confidence.toUpperCase()} — ${match.reason}`);
  for (const line of match.lines) console.log(`    L${line.lineNumber}: ${line.text}`);
}
console.log("\nUNMATCHED LINES:");
for (const line of result.unmatchedLines) console.log(`    L${line.lineNumber}: ${line.text}`);
console.log("\nIGNORED LINES:");
for (const line of result.ignoredLines) console.log(`    L${line.lineNumber}: ${line.text}`);

// Second pass: only-names invoice, plus a near-miss house number.
const invoice2 = `Olander, Marcy
CEDAR HOLLOW HOA
79 Kagy Blvd
202 cedar hollow way apt 2`;
const r2 = matchInvoiceToCustomers(invoice2, candidates);
console.log("\n--- names-only / near-miss ---");
for (const match of r2.matches) {
  const name = candidates.find((c) => c.clientId === match.clientId)!.clientName;
  console.log(`${name}: ${match.confidence.toUpperCase()} — ${match.reason} [${match.lines.map((l) => l.text).join(" | ")}]`);
}
console.log("unmatched:", r2.unmatchedLines.map((l) => l.text));
console.log("ignored:", r2.ignoredLines.map((l) => l.text));
