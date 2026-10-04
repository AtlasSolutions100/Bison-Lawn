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

/* ------------------------------------------------------------------ *
 * "When sending emails — having an option to use AI for clarity and
 * professionalism, currently use chatgpt. Like in GMail."
 *
 * He writes the email, then pastes it into ChatGPT, then pastes it back. This
 * is that round trip without leaving the app. It is a rewrite of HIS words and
 * nothing else: no customer row, no invoice, no history is sent — only the text
 * in the box he is typing in. The office emails customers about money and about
 * when somebody is turning up at their house, and none of that belongs in a
 * third party's logs to make a sentence read better.
 *
 * Two rules the rewrite has to obey or it is worse than useless:
 *  - His merge tokens survive. `[clientname]` in a document is not a word, it
 *    is the customer's name at send time. A model that "improves" it to
 *    "[client name]" ships a letter that reads "Dear [client name]," to 709
 *    people. So the tokens are counted going in and counted coming back, and a
 *    rewrite that lost or renamed one is thrown away rather than offered.
 *  - He sees it before it replaces anything. The endpoint returns the rewrite,
 *    the page shows both, and he presses Use this or Keep mine. Nothing here
 *    writes to a draft on its own.
 * ------------------------------------------------------------------ */

export const POLISH_TONES = ["clear", "professional", "friendly"] as const;
export type PolishTone = (typeof POLISH_TONES)[number];

/** Longer than any email he types; a guard against pasting a whole mailbox in. */
export const POLISH_MAX_CHARS = 10_000;

/**
 * How much room the answer gets, worked out from what he sent.
 *
 * A flat 1,200 was the bug: a six-thousand-character letter is about fifteen
 * hundred tokens, so the rewrite came back stopping mid-sentence and was
 * offered to him as the finished letter. Half a token per character is roughly
 * double the room the text itself needs, which leaves slack for a rewrite that
 * runs a little long, and the ceiling still stops a 10,000-character paste from
 * asking for an unbounded answer.
 */
const POLISH_TOKEN_CEILING = 4_000;
export function polishMaxTokens(text: string): number {
  return Math.min(POLISH_TOKEN_CEILING, Math.ceil(text.length / 2) + 200);
}

/**
 * Below this he can read the whole rewrite at a glance, and "much shorter" is
 * usually the clear tone doing its job. Above it a letter that comes back half
 * the length has lost paragraphs he would have to notice for himself.
 */
const POLISH_SHORTNESS_CHECKED_FROM = 1_000;
/** Less of his letter than this came back means it was cut off, not tidied. */
const POLISH_SHORTEST_KEPT = 0.6;

/**
 * The provider seam. Production passes nothing and gets xAI; the test passes a
 * fake, which is the only way to prove the token rule without a live key.
 */
export type PolishProvider = (messages: ChatMessage[], maxTokens: number) => Promise<string>;

export type PolishResult = {
  /** What to offer him. Equal to the text he sent when nothing was changed. */
  text: string;
  /** False when no XAI_API_KEY is set, so the button can explain itself. */
  available: boolean;
  /** True when `text` is a rewrite he has not seen yet. */
  changed: boolean;
  /** Plain-words reason the rewrite was not used, for the page to show. */
  note: string | null;
  tone: PolishTone;
};

/**
 * Both syntaxes, because both are live: his own pasted documents use
 * `[clientname]` and the spring letter uses `{{first_name}}`. See
 * mergeTokens.ts for why the app did not standardise him onto one.
 */
const MERGE_TOKEN_PATTERN = /\[[A-Za-z0-9_:]+\]|\{\{[^}\n]+\}\}/g;

/**
 * Every token, sorted, with duplicates kept — a letter that says
 * `[clientname]` twice must come back saying it twice, or a greeting or a
 * signature quietly lost its name.
 *
 * The two syntaxes do not get the same rule, because the two renderers do not.
 * mergeTokens.ts lower-cases a `[...]` token before it looks the value up, so
 * `[ClientName]` and `[clientname]` both fill in the name and a rewrite that
 * only changed the capitals broke nothing. The spring letter's `{{...}}` tokens
 * are swapped by an exact text match on `{{clientFirstName}}`, so
 * `{{clientfirstname}}` fills in nothing and prints the braces to the customer.
 * Those are compared exactly as they came back.
 */
export function mergeTokensIn(text: string): string[] {
  return [...text.matchAll(MERGE_TOKEN_PATTERN)]
    .map((m) => (m[0].startsWith("[") ? m[0].toLowerCase() : m[0]))
    .sort();
}

function sameTokens(before: string[], after: string[]): boolean {
  return before.length === after.length && before.every((t, i) => t === after[i]);
}

const TONE_RULES: Record<PolishTone, string> = {
  clear:
    "Make it clearer and shorter. Plain words, short sentences. Say the same thing with less of it.",
  professional:
    "Make it read as a professional note from a small business to its customer. Polite, direct, no stiffness and no corporate filler.",
  friendly:
    "Make it warm and neighbourly, the way a local owner writes to a regular. Still brief and still clear.",
};

/**
 * Models like to answer a request. This is not a request, it is a rewrite, so
 * the instructions are mostly a list of what not to do — the usual failures are
 * adding a greeting he did not write, inventing a price or a date, and wrapping
 * the whole thing in a code fence.
 */
function polishMessages(text: string, tone: PolishTone): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You rewrite one message for the owner of a small lawn care company before he sends it to a customer. " +
        `${TONE_RULES[tone]}\n\nRules:\n` +
        "- Return ONLY the rewritten message. No preamble, no explanation, no quote marks around it, no code fences.\n" +
        "- Never add a fact. No prices, dates, times, names, services or promises that are not already in the text.\n" +
        "- Never remove a fact. Every price, date, address and number in the text must still be there.\n" +
        "- Text in square brackets like [clientname], [companyname] or [servicedate], and text in double braces " +
        "like {{first_name}}, are merge fields that get filled in with the real customer's details when the message " +
        "is sent. Copy each one through EXACTLY, character for character, the same number of times. Do not translate " +
        "them, space them out, correct their spelling, capitalise them or explain them. They are not words.\n" +
        // richText.ts reads two underscores as underline, and the Letter box
        // tells him so, so the rewrite has to be told the same thing. A model
        // left to guess turns __like this__ into **like this**, which in this
        // app is bold, and the underline he asked for is gone.
        "- Keep his formatting exactly: **bold**, __underline__, *italic* and lines starting with - stay as they are.\n" +
        "- Keep it roughly the same length or shorter. Do not pad it out.\n" +
        "- If the text is already fine, return it unchanged.",
    },
    { role: "user", content: text },
  ];
}

/**
 * Models wrap prose in fences and quotes even when told twice not to. Stripping
 * that here is cheaper than a second round trip, and it only ever removes a
 * wrapper around the WHOLE answer, never anything inside it.
 */
function unwrap(answer: string): string {
  let out = answer.trim();
  const fenced = out.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fenced) out = fenced[1]!.trim();
  if (out.length > 1 && /^["“][\s\S]*["”]$/.test(out) && !out.slice(1, -1).includes('"')) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * Rewrite his text, or say why it was not rewritten.
 *
 * Never throws for a reason he can do something about — a missing key, a model
 * that mangled a token, an empty answer — because the button sits next to a
 * half-written email and an error dialog there loses his place. Those come back
 * as the original text plus a note. A genuine upstream failure does throw, so
 * the route can answer 502 and the page can say "try again in a minute".
 */
export async function polishText(
  rawText: string,
  tone: PolishTone = "clear",
  provider?: PolishProvider,
): Promise<PolishResult> {
  const text = rawText.replace(/\r\n/g, "\n");
  const base = { text, available: assistantConfigured(), changed: false, tone };

  if (!base.available) {
    return {
      ...base,
      note:
        "The AI rewrite is not switched on for this app yet, so your words are unchanged. " +
        "It needs an AI key added on the server — ask Koby to turn it on.",
    };
  }
  if (!text.trim()) {
    return { ...base, note: "There is nothing written yet to tidy up." };
  }
  if (text.length > POLISH_MAX_CHARS) {
    return {
      ...base,
      note: `That is longer than ${POLISH_MAX_CHARS.toLocaleString()} characters, which is more than this can rewrite in one go.`,
    };
  }

  const maxTokens = polishMaxTokens(text);
  const answer = unwrap(await (provider ?? chat)(polishMessages(text, tone), maxTokens));
  if (!answer) {
    return { ...base, note: "The rewrite came back empty, so your words are unchanged. Try again." };
  }

  // A long letter that comes back half its length did not get tidier, it got
  // cut off — the model ran out of room part way through writing it. Offering
  // that hides a missing ending under the words "The AI version", and Use this
  // would delete the rest of his letter. Checked before the merge fields, so a
  // cut-off letter says it was cut off rather than blaming his brackets.
  if (text.length >= POLISH_SHORTNESS_CHECKED_FROM && answer.length < text.length * POLISH_SHORTEST_KEPT) {
    logger.warn({ sent: text.length, back: answer.length, maxTokens }, "polish came back short");
    return {
      ...base,
      note:
        "The rewrite came back much shorter than what you wrote, so it looks like it stopped part way through " +
        "instead of finishing your letter. Your words are unchanged. Try it again, or split a very long letter in two.",
    };
  }

  const before = mergeTokensIn(text);
  const after = mergeTokensIn(answer);
  if (!sameTokens(before, after)) {
    // Thrown away on purpose. A letter whose [clientname] came back as
    // "[client name]" prints the brackets to the customer, and he would have
    // no way of knowing until somebody rang him about it.
    logger.warn({ before: before.length, after: after.length }, "polish dropped merge tokens");
    return {
      ...base,
      note:
        "The rewrite changed your merge fields (the bits in brackets like [clientname]), which would have printed " +
        "the brackets to the customer, so it was thrown away and your words are unchanged. Try it again.",
    };
  }

  if (answer === text) {
    return { ...base, note: "It read fine already — nothing was changed." };
  }
  return { text: answer, available: true, changed: true, note: null, tone };
}
