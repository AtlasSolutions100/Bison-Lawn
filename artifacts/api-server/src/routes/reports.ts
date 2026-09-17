import { Router, type IRouter } from "express";
import { AskReportQuestionBody } from "@workspace/api-zod";
import { requireAuth, requireArea } from "../middlewares/requireAuth";
import { REPORTS, costingSummary, isReportKey, reportCatalogue, toCsv, totalsOf } from "../lib/analytics";
import { answerQuestion, assistantConfigured } from "../lib/aiAssistant";

const router: IRouter = Router();

// Money, crew performance and customer profitability. Owner's side of the
// desk: an office user only gets in when Adam grants Reports.
router.use(["/reports"], requireAuth, requireArea("reports"));

/** yyyy-mm-dd, checked rather than trusted — these go straight into a query. */
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function resolveRange(req: { query: Record<string, unknown> }) {
  const { from, to } = req.query;
  if (!validDate(from) || !validDate(to)) return null;
  if (from > to) return null;
  return { from, to };
}

const RANGE_ERROR = "from and to must be yyyy-mm-dd, and from cannot be after to";

router.get("/reports/costing", async (req, res) => {
  const range = resolveRange(req);
  if (!range) return res.status(400).json({ error: RANGE_ERROR });
  const [summary, bySub, byService, byClient] = await Promise.all([
    costingSummary(range.from, range.to),
    REPORTS.costing_by_sub.run(range.from, range.to),
    REPORTS.costing_by_service.run(range.from, range.to),
    REPORTS.costing_by_client.run(range.from, range.to),
  ]);
  return res.json({ summary, bySub, byService, byClient, assistantAvailable: assistantConfigured() });
});

/**
 * Every report the page can open, with the sentences the picker shows. Read
 * from the same catalogue the AI router uses, so the two can never disagree
 * about what exists.
 */
router.get("/reports/catalogue", (_req, res) => {
  return res.json({ assistantAvailable: assistantConfigured(), reports: reportCatalogue() });
});

/**
 * One report over a date range. `format=csv` returns the same rows as a file
 * the browser saves — his "Export to Excel" button — and the cookie session
 * carries the request, so a plain link works with no download code in the page.
 */
router.get("/reports/run", async (req, res) => {
  const key = String(req.query.key ?? "");
  if (!isReportKey(key)) return res.status(404).json({ error: "No such report" });
  const range = resolveRange(req);
  if (!range) return res.status(400).json({ error: RANGE_ERROR });
  const report = REPORTS[key];
  const rows = await report.run(range.from, range.to);
  if (req.query.format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${key}-${range.from}-to-${range.to}.csv"`);
    return res.send(toCsv(report, rows));
  }
  return res.json({
    key,
    title: report.title,
    from: range.from,
    to: range.to,
    columns: report.columns,
    rows,
    totals: totalsOf(report, rows),
  });
});

/**
 * The question box. With no XAI_API_KEY the question is routed on its words
 * and answered with the table alone, so the box is never a dead control; the
 * page says which of the two happened.
 */
router.post("/reports/ask", async (req, res) => {
  const body = AskReportQuestionBody.parse(req.body);
  const question = body.question.trim();
  if (!question) return res.status(400).json({ error: "Ask a question first" });

  const range = resolveRange({ query: body });
  if (!range) return res.status(400).json({ error: RANGE_ERROR });

  try {
    return res.json(await answerQuestion(question, range.from, range.to));
  } catch (err) {
    req.log.error({ err }, "assistant question failed");
    const message = err instanceof Error ? err.message : "The assistant could not answer that.";
    return res.status(502).json({ error: message });
  }
});

export default router;
