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
 * xAI's API is OpenAI-compatible, so this is a plain fetch — no SDK for one
 * endpoint used twice.
 */
import { REPORTS, isReportKey, type ReportKey } from "./analytics";
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
  .map(([key, r]) => `- ${key}: ${r.describes}`)
  .join("\n");

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
          "You route a question to one report. Reply with the report key alone, nothing else. " +
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
async function summarise(question: string, title: string, rows: unknown[]): Promise<string> {
  if (rows.length === 0) {
    return "There is no data for that period yet, so there is nothing to report.";
  }
  return chat(
    [
      {
        role: "system",
        content:
          "You summarise a lawn care business report for the owner. Rules:\n" +
          "- Use only the numbers given. Never calculate, estimate or infer a figure.\n" +
          "- A null actualHours means the work was never clocked, not that it took no time. Say when data is missing.\n" +
          "- Lead with the single most useful finding. Three sentences at most.\n" +
          "- Plain English, no markdown, no bullet points, no preamble.",
      },
      {
        role: "user",
        content: `Question: ${question}\n\nReport: ${title}\n\nRows:\n${JSON.stringify(rows, null, 1)}`,
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
  rows: unknown[];
};

export async function answerQuestion(
  question: string,
  from: string,
  to: string,
): Promise<AssistantAnswer> {
  const reportKey = await chooseReport(question);
  if (!reportKey) {
    return {
      question,
      reportKey: null,
      reportTitle: null,
      answer:
        "I do not have a report that answers that. I can cover crew hours against budget, " +
        "service profitability, customers whose work runs over, and completed work that has " +
        "not been invoiced.",
      rows: [],
    };
  }

  const report = REPORTS[reportKey];
  const rows = await report.run(from, to);
  const answer = await summarise(question, report.title, rows);
  return { question, reportKey, reportTitle: report.title, answer, rows };
}
