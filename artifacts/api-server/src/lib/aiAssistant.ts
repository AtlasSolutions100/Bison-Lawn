/**
 * The question box on the Reports page.
 *
 * The model does exactly two things: it picks which of the curated reports
 * answers the question, and it writes the sentences around the result. It never
 * writes SQL and never produces a figure. Every number in the answer came out of
 * a query in analytics.ts, and the raw table is always rendered beneath the
 * prose so a bad summary can be checked against the data rather than trusted.
 *
 * That constraint is the whole design. Adam prices work and keeps or drops
 * customers off these numbers; a model that invents a plausible one is worse
 * than no feature at all.
 *
 * Without an XAI_API_KEY the box still works: the question is matched on its
 * words against each report's example sentences and keywords, the report runs,
 * and the answer is a plain one-line "here is the table" with no prose. The
 * picker on the page offers the same sentences, so nothing here is guesswork.
 *
 * xAI's API is OpenAI-compatible, so this is a plain fetch — no SDK for one
 * endpoint used twice.
 */
import {
  REPORTS,
  isReportKey,
  totalsOf,
  type ReportKey,
  type ReportColumn,
  type ReportRow,
} from "./analytics";
import { logger } from "./logger";

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_MODEL = "grok-3";
const TIMEOUT_MS = 30_000;

export function assistantConfigured(): boolean {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function chat(messages: ChatMessage[], maxTokens: number): Promise<string> {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) throw new Error("No XAI_API_KEY is configured on this server");

  const response = await fetch(XAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.XAI_MODEL?.trim() || DEFAULT_MODEL,
      messages,
      max_tokens: maxTokens,
      // Low but not zero: this is summarising figures, not brainstorming.
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // The body can carry the key back in an error echo, so only the status is
    // logged and only a generic message reaches the browser.
    logger.error({ status: response.status }, "xai request failed");
    throw new Error(`The assistant is unavailable right now (upstream returned ${response.status}).`);
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The assistant returned an empty answer.");
  return text;
}

const CATALOGUE = Object.entries(REPORTS)
  .map(([key, r]) => `- ${key}: ${r.describes} (e.g. "${r.asks[0]}")`)
  .join("\n");

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * How many reports claim each keyword. "revenue" and "contractor" are in
 * several lists and say little about which report is wanted; "skipped" or
 * "unapplied" name one report outright. A shared word is worth less, in
 * proportion, so the distinctive word decides.
 */
const KEYWORD_USES: Map<string, number> = (() => {
  const uses = new Map<string, number>();
  for (const r of Object.values(REPORTS)) {
    for (const kw of new Set(r.keywords.map(normalise))) {
      if (kw) uses.set(kw, (uses.get(kw) ?? 0) + 1);
    }
  }
  return uses;
})();

/**
 * Route by words, no model involved.
 *
 * A sentence lifted straight from the picker wins outright, so the same
 * sentence always opens the same report. Otherwise each report scores per
 * keyword found in the question: longer keywords count a little more so
 * "revenue lost" beats a lone "revenue", and a keyword shared between reports
 * counts less than one only this report uses. Ties go to the report listed
 * first, which is why the catalogue is ordered from specific to general.
 */
export function chooseReportByWords(question: string): ReportKey | null {
  const q = normalise(question);
  if (!q) return null;
  for (const [key, r] of Object.entries(REPORTS)) {
    if (r.asks.some((ask) => normalise(ask) === q)) return key;
  }
  let best: { key: ReportKey; score: number } | null = null;
  for (const [key, r] of Object.entries(REPORTS)) {
    let score = 0;
    for (const kw of new Set(r.keywords.map(normalise))) {
      if (kw && ` ${q} `.includes(` ${kw} `)) {
        score += (1 + kw.split(" ").length * 0.25) / (KEYWORD_USES.get(kw) ?? 1);
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { key, score };
  }
  return best?.key ?? null;
}

/**
 * Step one: which report answers this?
 *
 * Constrained to the catalogue and required to answer with a bare key, so an
 * unanswerable question comes back as "none" rather than as the model's best
 * guess at a report that does not address what was asked.
 */
async function chooseReport(question: string): Promise<ReportKey | null> {
  const answer = await chat(
    [
      {
        role: "system",
        content:
          "You route a question from a lawn care business owner to one report. Reply with the report key alone, nothing else. " +
          "If no report genuinely answers the question, reply exactly: none\n\n" +
          `Reports:\n${CATALOGUE}`,
      },
      { role: "user", content: question },
    ],
    16,
  );
  const key = answer.trim().toLowerCase().replace(/[^a-z_]/g, "");
  return isReportKey(key) ? key : null;
}

/**
 * Step two: describe what the query returned.
 *
 * The rows go in as JSON and the model is told, plainly, not to compute anything
 * — the arithmetic is already done. "Say so" on missing data matters: a report
 * covering four measured jobs out of ninety is nearly meaningless, and the
 * summary has to admit that rather than generalise from it.
 */
async function summarise(
  question: string,
  title: string,
  columns: ReportColumn[],
  rows: ReportRow[],
  totals: Record<string, number> | null,
): Promise<string> {
  if (rows.length === 0) {
    return "There is no data for that period yet, so there is nothing to report.";
  }
  const legend = columns.map((c) => `${c.key} = ${c.label} (${c.kind})`).join("; ");
  return chat(
    [
      {
        role: "system",
        content:
          "You summarise a lawn care business report for the owner. Rules:\n" +
          "- Use only the numbers given. Never calculate, estimate or infer a figure.\n" +
          "- A null actualHours means the work was never clocked, not that it took no time. A null budget means no budget was set. Say when data is missing.\n" +
          "- Lead with the single most useful finding. Three sentences at most.\n" +
          "- Plain English, no markdown, no bullet points, no preamble.",
      },
      {
        role: "user",
        content:
          `Question: ${question}\n\nReport: ${title}\nColumns: ${legend}\n` +
          (totals ? `Totals: ${JSON.stringify(totals)}\n` : "") +
          `\nRows (first 60):\n${JSON.stringify(rows.slice(0, 60), null, 1)}`,
      },
    ],
    300,
  );
}

export type AssistantAnswer = {
  question: string;
  reportKey: ReportKey | null;
  reportTitle: string | null;
  answer: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, number> | null;
  /** False when the answer was routed by words alone, so the page can say so. */
  assistantUsed: boolean;
};

function noReportAnswer(question: string): AssistantAnswer {
  return {
    question,
    reportKey: null,
    reportTitle: null,
    answer:
      "I do not have a report that answers that. Pick one of the questions below, or ask about " +
      "skipped jobs, revenue per week, square footage, unapplied payments, failed emails or job cost.",
    columns: [],
    rows: [],
    totals: null,
    assistantUsed: false,
  };
}

export async function answerQuestion(
  question: string,
  from: string,
  to: string,
): Promise<AssistantAnswer> {
  const useModel = assistantConfigured();
  // The picker's own sentences route by words even with a key set, so a
  // click never depends on a model call it did not need.
  let reportKey = chooseReportByWords(question);
  const exact = reportKey != null && REPORTS[reportKey].asks.some((a) => normalise(a) === normalise(question));
  if (useModel && !exact) {
    reportKey = (await chooseReport(question)) ?? reportKey;
  }
  if (!reportKey) return noReportAnswer(question);

  const report = REPORTS[reportKey];
  const rows = await report.run(from, to);
  const totals = totalsOf(report, rows);
  const answer = useModel
    ? await summarise(question, report.title, report.columns, rows, totals)
    : rows.length === 0
      ? `Nothing to show for "${report.title}" between ${from} and ${to}.`
      : `Here is "${report.title}" for ${from} to ${to}: ${rows.length} ${rows.length === 1 ? "row" : "rows"}.`;
  return {
    question,
    reportKey,
    reportTitle: report.title,
    answer,
    columns: report.columns,
    rows,
    totals,
    assistantUsed: useModel,
  };
}
