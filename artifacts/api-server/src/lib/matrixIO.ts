import type { PricingEquation } from "@workspace/db";
import { roundMoney, isPricedBand, MAX_RULE_BANDS } from "./helpers";

/**
 * Two things he asked for on 2026-09-28 that both treat a rate matrix as a
 * thing you move around rather than only type:
 *
 *  - "In Coping of service matrix to another, be able to add additional
 *    dollars (product) based on square footage to original price (ex, Aeration
 *    + seed = AE overseed) or Top dressing (beagle to add topdressing cost,
 *    product cost/sqft + delivery + Trailer)."
 *  - "Ability to extract matrix from crm to excel", and importing one back
 *    ("Example in google drive (top dressing)").
 *
 * The maths lives here rather than in helpers.ts so the band shape itself
 * (calculatePrice, scaleEquations) stays one small, heavily-tested thing.
 */

/**
 * A product he buys by the square foot plus what it costs to get it there.
 * "Aeration + seed = AE overseed": the aeration labour is the matrix he
 * already has, the seed is bags per thousand square feet, and top dressing
 * adds a delivery and a trailer that happen once however big the lawn is.
 */
export type MatrixProductCost = {
  /** Dollars of product for every `perUnits` of the pricing unit. */
  amountPerUnit: number;
  /** How much lawn one `amountPerUnit` covers — 1,000 sqft a bag. */
  perUnits: number;
  /** Delivery, the trailer: charged once per job, not per thousand. */
  flatAmount: number;
  /** "seed", "top dressing" — so the audit line and the preview say what it is. */
  label?: string | null;
};

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

export function assertProductCost(product: MatrixProductCost) {
  if (!(product.perUnits > 0)) throw bad("Say how much lawn one lot of product covers — the per-N box cannot be zero.");
  if (product.amountPerUnit < 0 || product.flatAmount < 0) {
    throw bad("A product cost cannot be negative. To take money off, use Add $ with a minus.");
  }
  if (product.amountPerUnit === 0 && product.flatAmount === 0) {
    throw bad("That product costs nothing — fill in the per-square-foot amount, the flat amount, or both.");
  }
}

/** "$5 per 1,000 + $85 delivery and trailer" — the toast, the audit line, the preview header. */
export function productCostLabel(product: MatrixProductCost, unit = "sqft"): string {
  const parts: string[] = [];
  if (product.amountPerUnit) parts.push(`$${product.amountPerUnit} per ${product.perUnits.toLocaleString("en-US")} ${unit}`);
  if (product.flatAmount) parts.push(`$${product.flatAmount} flat`);
  const sum = parts.join(" + ");
  return product.label?.trim() ? `${product.label.trim()} (${sum})` : sum;
}

/**
 * The product money one band picks up.
 *
 * A flat band is one price for a whole range of lawn sizes — his $49 band
 * covers everything up to 3,999 sqft — so the product has to be priced off one
 * size too, and the only honest choice is the top of the band. That is already
 * how his matrix behaves: a 1,000 sqft lawn in the "up to 3,999" band pays the
 * 3,999 price. Rounded UP to whole lots, because he buys whole bags.
 *
 * The "and up" band is the exception: it has no top, so the product cannot be
 * a flat add there or a 90,000 sqft lawn would get the same seed as a 10,000
 * one. There the product joins the per-step money instead, so it keeps
 * climbing with the lawn.
 */
export function addProductCost(
  equations: PricingEquation[],
  product: MatrixProductCost,
): { equations: PricingEquation[]; added: (number | null)[] } {
  assertProductCost(product);
  const lots = (units: number) => Math.ceil(units / product.perUnits) * product.amountPerUnit;
  const added: (number | null)[] = [];

  const next = equations.map((equation) => {
    // Same rule as copying a matrix: an empty row left by an "Add tier" click
    // carries no money, and adding a product cost must not turn it into a band
    // that then prices a job.
    if (!isPricedBand(equation)) {
      added.push(null);
      return { ...equation };
    }

    const copy: PricingEquation = { ...equation };
    let bandAdded = product.flatAmount;

    if (equation.upToSqft != null) {
      bandAdded += lots(equation.upToSqft);
    } else {
      // The base part of an open-ended band covers baseSqft of lawn, so that
      // much product goes in the base.
      bandAdded += lots(equation.baseSqft);
      if (equation.incrementSqft > 0) {
        // Per step, exactly: the step is a known size, so no rounding up here
        // — rounding each of forty steps up to a whole bag would invent money.
        copy.incrementPrice = roundMoney(
          equation.incrementPrice + (equation.incrementSqft / product.perUnits) * product.amountPerUnit,
        );
      } else if (product.amountPerUnit > 0) {
        // A flat "and up" band with no step of its own: give it the product's
        // own step, so a 90,000 sqft top dressing pays for 90,000 sqft of
        // product instead of whatever the biggest band happened to say.
        copy.incrementSqft = product.perUnits;
        copy.incrementPrice = roundMoney(product.amountPerUnit);
      }
    }

    copy.basePrice = roundMoney(equation.basePrice + bandAdded);
    // The floor has to carry ALL of the band's product, not just the flat
    // part. Delivery and the trailer happen on the smallest job he takes, and
    // the floor is the number that prices those jobs — the floor goes on last,
    // over the base, so anything the floor is not carrying is money he hands
    // over and never charges for. On a band whose floor was already the
    // operative price, lifting it by the delivery alone threw the seed or the
    // top dressing away and he lost exactly what the floor was adding.
    if (equation.minPrice != null) copy.minPrice = roundMoney(equation.minPrice + bandAdded);
    // Budgeted cost is what it costs him to deliver, and the product is a real
    // cost — it is not margin, so it goes on at face value whatever the rate
    // was scaled by.
    if (equation.budgetedCost != null) copy.budgetedCost = roundMoney(equation.budgetedCost + bandAdded);
    added.push(roundMoney(bandAdded));
    return copy;
  });

  return { equations: next, added };
}

// ---------- matrix <-> spreadsheet ----------

/**
 * The columns of the exported file, in his reading order. "From" is written
 * for him to read and ignored coming back in: it is the row above's "To" plus
 * one, and two numbers that have to agree, typed twice, is a gap or an overlap
 * waiting to happen.
 */
export const MATRIX_CSV_COLUMNS = [
  "From",
  "To",
  "Rate",
  "Never less than",
  "Base covers",
  "Price per step",
  "Step size",
  "Budgeted hours",
  "Budgeted cost",
] as const;

/** Header spellings the importer accepts for each field it actually reads. */
const HEADER_ALIASES: Record<string, string[]> = {
  upToSqft: ["to", "up to", "upto", "uptosqft", "max", "maximum", "ceiling", "sqft to", "to sqft"],
  basePrice: ["rate", "price", "base", "base price", "baseprice", "amount", "rate $"],
  minPrice: ["never less than", "min", "minimum", "min price", "minprice", "minimum charge", "floor"],
  baseSqft: ["base covers", "base sqft", "basesqft", "base over", "base units", "base quantity"],
  incrementPrice: ["price per step", "per step", "increment price", "incrementprice", "step price", "+ per step"],
  incrementSqft: ["step size", "step", "increment sqft", "incrementsqft", "step sqft"],
  budgetedHours: ["budgeted hours", "b. hrs", "b hrs", "hours", "hrs", "budgetedhours"],
  budgetedCost: ["budgeted cost", "b. cost", "b cost", "cost", "budgetedcost"],
  from: ["from", "from sqft", "sqft from"],
};

/**
 * Headers match on meaning, not spelling. The unit in brackets goes first —
 * the export writes "To (Turf Sqft)" and he may well retype it as "To (sqft)"
 * or drop it, and all three are the same column.
 */
/**
 * The bracketed part of a header, taken by position: the first "(" to the LAST
 * ")". He names his own estimate fields, so a label can have brackets of its
 * own — "Turf Sqft (mow area)" writes the header "To (Turf Sqft (mow area))",
 * and matching brackets by pattern stops at the first ")" and leaves a stray
 * one behind, which is how the app came to refuse a file it had written itself.
 */
function splitBracketedUnit(text: string): { rest: string; unit: string } {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open === -1 || close <= open) return { rest: text, unit: "" };
  return { rest: `${text.slice(0, open)} ${text.slice(close + 1)}`, unit: text.slice(open + 1, close).trim() };
}

const fold = (text: string) =>
  splitBracketedUnit(text.trim())
    .rest.toLowerCase()
    .replace(/\$/g, "")
    .replace(/\s+/g, " ")
    .trim();

function fieldForHeader(header: string): string | null {
  const folded = fold(header);
  if (!folded) return null;
  for (const [field, spellings] of Object.entries(HEADER_ALIASES)) {
    if (spellings.includes(folded)) return field;
  }
  return null;
}

/**
 * One CSV row, quotes and all. Not a general CSV library: it handles quoted
 * cells, doubled quotes inside them and embedded commas, which is what Excel
 * writes, and that is the whole job.
 */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** Excel's own text-defusing (="+1 208…"), money and thousands separators, all undone. */
function cleanCell(raw: string): string {
  let text = raw.trim();
  if (/^="/.test(text) && text.endsWith('"')) text = text.slice(2, -1).replace(/""/g, '"');
  return text.trim();
}

const NO_CEILING = ["", "and up", "andup", "-", "—", "none", "no limit", "unlimited", "above", "over"];

/** A money or measurement cell. Blank is blank — it is not zero. */
function readNumber(raw: string): number | null | "bad" {
  const text = cleanCell(raw).replace(/[$,\s]/g, "");
  if (text === "" || text === "-" || text === "—") return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return "bad";
  return value;
}

export type MatrixImport = {
  bands: PricingEquation[];
  /** Which of our fields each column of his file turned into, in his order. */
  columns: { header: string; field: string | null }[];
  /**
   * What the file says its sizes are measured in — the "(Turf Sqft)" the
   * export writes into the To header. Null when he typed the file himself and
   * left it off. The caller compares it with what the service is actually
   * priced by, because a top dressing matrix in square feet dropped onto a
   * blow-out priced by zones looks like a perfectly good file and would reprice
   * every blow-out in the book.
   */
  unitInFile: string | null;
  /** Rows read, rows skipped as blank. */
  rowsRead: number;
  rowsSkipped: number;
  /** Things worth his eye that are not reasons to refuse the file. */
  warnings: string[];
  /** Reasons the file cannot be saved. Non-empty means apply is refused. */
  errors: string[];
};

/**
 * Read a matrix back out of a spreadsheet he has edited.
 *
 * Nothing here guesses. A number it cannot read is an error that names the row
 * and the column, never a quiet zero — a zero in the Rate column is how a
 * 30,000 sqft mow came to quote $0.00 once already, and an import that did
 * that silently across his whole catalogue is the worst thing this feature
 * could do. The route previews what this returns and only writes once he has
 * looked at it.
 */
export function parseMatrixCsv(text: string): MatrixImport {
  const warnings: string[] = [];
  const errors: string[] = [];
  const body = text.replace(/^﻿/, "");
  const lines = body.split(/\r\n|\n|\r/);

  const headerIndex = lines.findIndex((line) => line.trim() !== "" && splitCsvLine(line).some((c) => fieldForHeader(c)));
  if (headerIndex === -1) {
    throw bad(
      `I could not find the column names in that file. It needs a first row naming the columns — "To", "Rate", and whichever of ${MATRIX_CSV_COLUMNS.join(", ")} you are using. Export a matrix first and edit that file.`,
    );
  }

  const headerCells = splitCsvLine(lines[headerIndex]).map(cleanCell);
  const columns = headerCells.map((header) => ({ header, field: fieldForHeader(header) }));
  // The export writes the unit in brackets ("To (Turf Sqft)"); fold() throws
  // brackets away so the column still matches whatever he retypes, so the unit
  // is picked up here before it is lost.
  const unitInFile =
    columns
      .filter((c) => c.field === "upToSqft" || c.field === "baseSqft" || c.field === "incrementSqft")
      .map((c) => splitBracketedUnit(c.header.trim()).unit)
      .find((unit) => unit !== "") ?? null;
  const indexOf = (field: string) => columns.findIndex((c) => c.field === field);
  const unknown = columns.filter((c) => !c.field && c.header !== "").map((c) => c.header);
  if (unknown.length) warnings.push(`Ignored ${unknown.length === 1 ? "a column" : "columns"} I do not know: ${unknown.join(", ")}.`);
  if (indexOf("upToSqft") === -1) {
    throw bad('That file has no "To" column, so there is no way to tell one band from another.');
  }
  if (indexOf("basePrice") === -1 && indexOf("minPrice") === -1) {
    throw bad('That file has no "Rate" column and no "Never less than" column, so none of its bands carry a price.');
  }

  const bands: PricingEquation[] = [];
  let rowsSkipped = 0;
  let openEndedAt: number | null = null;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line);
    // A row where every cell we care about is empty is Excel padding, not a band.
    const meaningful = columns.some((c, index) => c.field && c.field !== "from" && cleanCell(cells[index] ?? "") !== "");
    if (!meaningful) {
      rowsSkipped++;
      continue;
    }
    // The row number he sees in Excel, so "row 12" means row 12 to both of us.
    const rowNumber = i + 1;

    const read = (field: string): number | null => {
      const index = indexOf(field);
      if (index === -1) return null;
      const value = readNumber(cells[index] ?? "");
      if (value === "bad") {
        errors.push(`Row ${rowNumber}: "${cleanCell(cells[index])}" in the ${columns[index].header} column is not a number.`);
        return null;
      }
      return value;
    };

    const toRaw = cleanCell(cells[indexOf("upToSqft")] ?? "");
    let upToSqft: number | null = null;
    // No size it stops at: empty, "and up", or a 0 typed by an unfilled "Add
    // tier" row. Whether that is the top band, a mistake or just padding
    // depends on whether the row carries money, which is only known below.
    let noCeiling = false;
    let ceilingError: string | null = null;
    if (NO_CEILING.includes(fold(toRaw))) {
      noCeiling = true;
    } else {
      const value = readNumber(toRaw);
      if (value === "bad") {
        errors.push(`Row ${rowNumber}: "${toRaw}" in the To column is not a number — leave it empty or write "and up" for the top band.`);
      } else if (value == null) {
        noCeiling = true;
      } else if (value <= 0) {
        noCeiling = true;
        ceilingError = `Row ${rowNumber}: a To of ${value} is not a band. Leave it empty for "and up".`;
      } else {
        upToSqft = value;
      }
    }

    const band: PricingEquation = {
      upToSqft,
      basePrice: read("basePrice") ?? 0,
      baseSqft: read("baseSqft") ?? 0,
      incrementPrice: read("incrementPrice") ?? 0,
      incrementSqft: read("incrementSqft") ?? 0,
      budgetedHours: read("budgetedHours"),
      budgetedCost: read("budgetedCost"),
    };
    // An empty "never less than" cell leaves the field off the band entirely,
    // the way a band that never had a floor is stored — so exporting a matrix
    // and importing it straight back gives back the same matrix, byte for
    // byte, rather than one carrying a row of nulls it did not have before.
    const floor = read("minPrice");
    if (floor != null) band.minPrice = floor;
    // A row he left unfilled — no price and no size it stops at — is the
    // "Add tier" placeholder, and an empty row carries no money. His own
    // Mowing matrix is full of them, so reading one as a second "and up" band
    // is what made exporting that matrix produce a file this importer then
    // refused to take back. Padding, same as any other blank row.
    if (noCeiling && !isPricedBand(band)) {
      rowsSkipped++;
      continue;
    }
    if (ceilingError) errors.push(ceilingError);
    for (const [label, value] of [
      ["Rate", band.basePrice],
      ["Never less than", band.minPrice],
      ["Price per step", band.incrementPrice],
      // A measurement below zero is not a band either, and it is the quiet
      // one: "Base covers -5,000" reads as a perfectly good file and then
      // charges six extra steps on every lawn in that band.
      ["Base covers", band.baseSqft],
      ["Step size", band.incrementSqft],
    ] as const) {
      if (value != null && value < 0) errors.push(`Row ${rowNumber}: ${label} cannot be negative.`);
    }
    if (upToSqft == null) {
      if (openEndedAt != null) {
        errors.push(
          `Rows ${openEndedAt} and ${rowNumber} both have an empty To. Only the last band can be "and up" — every other band needs the size it stops at.`,
        );
      }
      openEndedAt = rowNumber;
    } else if (openEndedAt != null) {
      errors.push(`Row ${openEndedAt} is the "and up" band but row ${rowNumber} comes after it. The "and up" band has to be last.`);
    }
    if (!isPricedBand(band)) warnings.push(`Row ${rowNumber} carries no price, so it will never price a job.`);
    bands.push(band);

    if (bands.length > MAX_RULE_BANDS) {
      throw bad(`That file has more than ${MAX_RULE_BANDS} bands. A matrix that long is a mistake in the file, not a price list.`);
    }
  }

  if (bands.length === 0) {
    throw bad("I read the column names but there were no bands under them.");
  }
  if (!bands.some(isPricedBand)) {
    errors.push("Not one band in that file carries a price. Saving it would price every job at nothing.");
  }
  // Out-of-order ceilings are the other way to price a lawn at the wrong
  // number: calculatePrice takes the FIRST band the size fits under, so a
  // small ceiling sitting below a big one swallows everything above it.
  const ceilings = bands.map((b) => b.upToSqft).filter((v): v is number => v != null);
  for (let i = 1; i < ceilings.length; i++) {
    if (ceilings[i] <= ceilings[i - 1]) {
      warnings.push(
        `The To column goes ${ceilings[i - 1].toLocaleString("en-US")} then ${ceilings[i].toLocaleString("en-US")} — out of order. Bands are read top to bottom, so put them smallest first.`,
      );
      break;
    }
  }

  return { bands, columns, unitInFile, rowsRead: bands.length, rowsSkipped, warnings, errors };
}

/**
 * The matrix as a file Excel opens straight. Written with the same cells the
 * importer reads back, so the round trip is the point: export, edit the
 * numbers in Excel, import, look at what it read, accept.
 */
export function matrixToCsv(
  equations: PricingEquation[],
  options: { unit?: string } = {},
): string {
  const unit = options.unit ?? "sqft";
  const cell = (value: number | null | undefined) => (value == null ? "" : String(value));
  // The unit is one of his own estimate field labels, so it can carry a comma
  // ("Zones, front") and would otherwise split the header row in two.
  const quote = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const header = MATRIX_CSV_COLUMNS.map((column) =>
    quote(
      column === "To" || column === "From" || column === "Base covers" || column === "Step size"
        ? `${column} (${unit})`
        : column,
    ),
  );
  const lines = [header.join(",")];
  let from = 0;
  for (const equation of equations) {
    lines.push(
      [
        String(from),
        equation.upToSqft == null ? "and up" : String(equation.upToSqft),
        cell(equation.basePrice),
        cell(equation.minPrice ?? null),
        cell(equation.baseSqft),
        cell(equation.incrementPrice),
        cell(equation.incrementSqft),
        cell(equation.budgetedHours ?? null),
        cell(equation.budgetedCost ?? null),
      ].join(","),
    );
    from = equation.upToSqft == null ? from : equation.upToSqft + 1;
  }
  // The byte-order mark is what makes Excel read the file as UTF-8 rather than
  // guessing, the same reason the client export carries one.
  return "﻿" + lines.join("\r\n") + "\r\n";
}
