/**
 * Matches a pasted vendor invoice against the customers assigned to a
 * vendor-performed service.
 *
 * A wrong match bills a customer for work nobody did, which is worse than the
 * missed-customer problem this is solving. So nothing here is "matched" unless
 * the property address lines up token for token; everything softer comes back
 * as "probable" for a human to confirm, and anything the invoice charged for
 * that no account explains is handed back untouched so the office can see it.
 *
 * Addresses decide, names only corroborate: property managers bill one name
 * across many addresses, so a name alone is ambiguous exactly where a mistake
 * costs the most.
 *
 * Deliberately dependency-free and side-effect-free — the CRM page imports this
 * same file so the browser and the server run identical matching logic.
 */

export type MatchConfidence = "matched" | "probable" | "unmatched";

export interface InvoiceCandidate {
  clientId: number;
  clientName: string;
  address?: string | null;
  city?: string | null;
}

export interface InvoiceLine {
  /** 1-based position in the pasted text, so the office can find it again. */
  lineNumber: number;
  text: string;
}

export interface CustomerMatch {
  clientId: number;
  confidence: MatchConfidence;
  reason: string;
  lines: InvoiceLine[];
}

export interface MatchOptions {
  /** The spray company's own name, so its letterhead is not read as a customer. */
  vendorName?: string | null;
}

export interface InvoiceMatchResult {
  /** One entry per candidate, in the order they were given. */
  matches: CustomerMatch[];
  /** Charges on the invoice that no customer account explains. */
  unmatchedLines: InvoiceLine[];
  /** Headers, totals and other boilerplate that was skipped. */
  ignoredLines: InvoiceLine[];
}

// Everything on the left normalises to the value on the right, so "77 KAGY
// BOULEVARD" and "77 Kagy Blvd" become the same string.
const ADDRESS_WORDS: Record<string, string> = {
  street: "st",
  str: "st",
  st: "st",
  avenue: "ave",
  aven: "ave",
  ave: "ave",
  av: "ave",
  road: "rd",
  rd: "rd",
  lane: "ln",
  ln: "ln",
  drive: "dr",
  drv: "dr",
  dr: "dr",
  boulevard: "blvd",
  boulevar: "blvd",
  blvd: "blvd",
  blv: "blvd",
  court: "ct",
  ct: "ct",
  circle: "cir",
  circ: "cir",
  cir: "cir",
  place: "pl",
  pl: "pl",
  way: "way",
  wy: "way",
  terrace: "ter",
  ter: "ter",
  trail: "trl",
  trl: "trl",
  parkway: "pkwy",
  pkwy: "pkwy",
  pkway: "pkwy",
  highway: "hwy",
  hwy: "hwy",
  square: "sq",
  sq: "sq",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
};

const DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);
const SUFFIXES = new Set(["st", "ave", "rd", "ln", "dr", "blvd", "ct", "cir", "pl", "way", "ter", "trl", "pkwy", "hwy", "sq", "loop"]);

// "Apt 4" and "#4" say nothing about which property was sprayed.
const UNIT_MARKERS = new Set(["apt", "apartment", "unit", "ste", "suite", "bldg", "building", "trlr", "rm", "floor", "fl"]);

// Words shared by half the business names in town — they cannot identify anyone.
const GENERIC_NAME_WORDS = new Set([
  "the",
  "and",
  "of",
  "hoa",
  "h",
  "o",
  "a",
  "llc",
  "inc",
  "ltd",
  "co",
  "corp",
  "company",
  "group",
  "property",
  "properties",
  "management",
  "mgmt",
  "associates",
  "association",
  "homeowners",
  "owners",
  "residences",
  "estates",
]);

// Boilerplate the vendor's email carries: page furniture, column headers, totals.
const NOISE_PREFIX =
  /^(invoice|statement|page\b|date\b|due\b|terms\b|remit|bill(ed)? to|customer name|service address|property address|description|qty|quantity|rate|unit price|line total|amount due|amount\b|total|subtotal|sub-total|tax\b|balance|payment|thank you|please remit|p\.?o\.? box|phone|email|account\b|ref\b|prepared (by|for)|work performed|technician|applicator|license)/i;

const NOISE_ANYWHERE = /\b(sub\s?total|grand total|total due|amount due|balance due|page \d+ of \d+)\b/i;

function normalizeTokens(value: string): string[] {
  const cleaned = value
    .toLowerCase()
    .replace(/&/g, " and ")
    // Unit numbers written as "#4" would otherwise look like a house number.
    .replace(/#\s*[a-z0-9-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!cleaned) return [];

  const raw = cleaned.split(" ");
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i];
    if (UNIT_MARKERS.has(token)) {
      i += 1; // swallow the unit designator itself
      continue;
    }
    tokens.push(ADDRESS_WORDS[token] ?? token);
  }
  return tokens;
}

/** Exported for tests and for showing the office what was compared. */
export function normalizeAddress(value: string): string {
  return normalizeTokens(value).join(" ");
}

export function normalizeName(value: string): string {
  return normalizeTokens(value).join(" ");
}

function isHouseNumber(token: string) {
  return /^\d{1,6}[a-z]?$/.test(token);
}

function indexOfSequence(haystack: string[], needle: string[]) {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/** True when the line carries something shaped like a street address. */
function lineHasAddress(tokens: string[]) {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (isHouseNumber(tokens[i]) && /^[a-z]+$/.test(tokens[i + 1])) return true;
  }
  return false;
}

function addressScore(candidate: string[], line: string[]) {
  if (candidate.length === 0) return 0;
  if (indexOfSequence(line, candidate) >= 0) return 1;

  const number = isHouseNumber(candidate[0]) ? candidate[0] : null;
  // The house number is the whole point: 77 Kagy and 79 Kagy are two customers.
  if (!number || !line.includes(number)) return 0;

  const core = candidate.slice(1).filter((token) => !SUFFIXES.has(token) && !DIRECTIONS.has(token));
  if (core.length === 0) return 0.4;
  const hits = core.filter((token) => line.includes(token)).length;
  if (hits === core.length) return 0.8;
  if (hits / core.length >= 0.5) return 0.55;
  return 0;
}

function nameScore(candidate: string[], distinctive: string[], line: string[]) {
  if (candidate.length === 0) return 0;
  if (indexOfSequence(line, candidate) >= 0) return 1;
  if (distinctive.length === 0) return 0;

  const hits = distinctive.filter((token) => line.includes(token));
  if (hits.length === distinctive.length) return 0.8;

  // "M. Olander" / "Olander, M" — an initial plus a surname the invoice spells out.
  const initial = candidate[0]?.[0];
  if (hits.length > 0 && initial && line.includes(initial)) return 0.7;

  if (hits.length > 0) return 0.45;
  return 0;
}

interface PairScore {
  clientId: number;
  rank: number;
  high: boolean;
  reason: string;
}

function scorePair(prepared: PreparedCandidate, line: string[], hasAddress: boolean): PairScore | null {
  const addr = addressScore(prepared.addressTokens, line);
  const name = nameScore(prepared.nameTokens, prepared.distinctiveTokens, line);
  // Address is weighted so it always outranks a name agreeing on its own.
  const rank = addr * 2 + name;

  if (addr >= 0.95) {
    return { clientId: prepared.clientId, rank, high: true, reason: `Address matches ${prepared.address}` };
  }
  if (addr >= 0.75) {
    return { clientId: prepared.clientId, rank, high: true, reason: `Address matches ${prepared.address} (written differently)` };
  }
  if (addr >= 0.5) {
    return { clientId: prepared.clientId, rank, high: false, reason: `Address looks like ${prepared.address} but does not read the same` };
  }
  if (addr === 0 && name >= 0.7) {
    return {
      clientId: prepared.clientId,
      rank,
      high: false,
      reason: hasAddress
        ? "Name matches, but the address on this line is not this customer's — confirm before billing"
        : "Name matches; the invoice line carries no address to confirm it",
    };
  }
  return null;
}

interface PreparedCandidate {
  clientId: number;
  address: string;
  addressTokens: string[];
  nameTokens: string[];
  distinctiveTokens: string[];
}

/**
 * Splits pasted text into the lines worth matching, dropping page furniture and
 * totals so they never show up as "the vendor billed someone you don't have".
 */
export function parseInvoiceLines(text: string, options: MatchOptions = {}): { lines: InvoiceLine[]; ignored: InvoiceLine[] } {
  const lines: InvoiceLine[] = [];
  const ignored: InvoiceLine[] = [];
  const vendorTokens = normalizeTokens(options.vendorName ?? "").filter((token) => token.length > 2);

  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const line: InvoiceLine = { lineNumber: index + 1, text: trimmed };

    const hasLetters = /[a-z]/i.test(trimmed);
    const words = trimmed.replace(/[^a-z]+/gi, " ").trim().split(/\s+/).filter(Boolean);
    if (!hasLetters || words.length === 0) {
      ignored.push(line); // rules, dates, running totals
      return;
    }
    if (NOISE_PREFIX.test(trimmed) || NOISE_ANYWHERE.test(trimmed)) {
      ignored.push(line);
      return;
    }
    const tokens = normalizeTokens(trimmed);
    // The vendor's own letterhead carries no property, so it is furniture — but
    // only when there is no address on the line, in case a customer shares a word
    // with the spray company.
    if (vendorTokens.length > 0 && !lineHasAddress(tokens) && vendorTokens.every((token) => tokens.includes(token))) {
      ignored.push(line);
      return;
    }
    lines.push(line);
  });

  return { lines, ignored };
}

/** Adjacent lines are one record: vendors often put the name above the address. */
function chargeCount(lines: InvoiceLine[]) {
  const sorted = [...lines].sort((a, b) => a.lineNumber - b.lineNumber);
  let count = 0;
  let previous = -2;
  for (const line of sorted) {
    if (line.lineNumber - previous > 1) count += 1;
    previous = line.lineNumber;
  }
  return count;
}

export function matchInvoiceToCustomers(
  text: string,
  candidates: InvoiceCandidate[],
  options: MatchOptions = {},
): InvoiceMatchResult {
  const { lines, ignored } = parseInvoiceLines(text, options);

  const prepared: PreparedCandidate[] = candidates.map((candidate) => {
    const nameTokens = normalizeTokens(candidate.clientName ?? "");
    return {
      clientId: candidate.clientId,
      address: (candidate.address ?? "").trim(),
      addressTokens: normalizeTokens(candidate.address ?? ""),
      nameTokens,
      distinctiveTokens: nameTokens.filter((token) => token.length > 2 && !GENERIC_NAME_WORDS.has(token)),
    };
  });

  const assigned = new Map<number, { line: InvoiceLine; high: boolean; reason: string }[]>();
  const unmatchedLines: InvoiceLine[] = [];

  for (const line of lines) {
    const tokens = normalizeTokens(line.text);
    const hasAddress = lineHasAddress(tokens);
    const scores = prepared
      .map((candidate) => scorePair(candidate, tokens, hasAddress))
      .filter((score): score is PairScore => score !== null)
      .sort((a, b) => b.rank - a.rank);

    if (scores.length === 0) {
      unmatchedLines.push(line);
      continue;
    }

    // Two customers explaining one charge equally well is exactly the case that
    // produces a double bill, so neither one is allowed to be pre-ticked.
    const runnerUp = scores[1];
    const ambiguous = runnerUp != null && scores[0].rank - runnerUp.rank < 0.15;
    const winners = ambiguous ? scores.filter((score) => scores[0].rank - score.rank < 0.15) : [scores[0]];

    for (const winner of winners) {
      const list = assigned.get(winner.clientId) ?? [];
      list.push({
        line,
        high: winner.high && !ambiguous,
        reason: ambiguous ? `${winner.reason} — another customer matches this line just as well` : winner.reason,
      });
      assigned.set(winner.clientId, list);
    }
  }

  const matches: CustomerMatch[] = candidates.map((candidate) => {
    const hits = assigned.get(candidate.clientId) ?? [];
    if (hits.length === 0) {
      return { clientId: candidate.clientId, confidence: "unmatched", reason: "Not on the pasted invoice", lines: [] };
    }
    const best = hits.find((hit) => hit.high) ?? hits[0];
    const duplicate =
      chargeCount(hits.map((hit) => hit.line)) > 1 ? " — the invoice charges for this customer more than once" : "";
    return {
      clientId: candidate.clientId,
      confidence: best.high ? "matched" : "probable",
      reason: `${best.reason}${duplicate}`,
      lines: hits.map((hit) => hit.line),
    };
  });

  return { matches, unmatchedLines, ignoredLines: ignored };
}
