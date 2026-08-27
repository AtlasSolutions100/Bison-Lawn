import { Router, type IRouter } from "express";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { REPORTS, costingSummary, isReportKey } from "../lib/analytics";
import { answerQuestion, assistantConfigured } from "../lib/aiAssistant";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Money, crew performance and customer profitability. Office only.
router.use(["/reports"], requireAuth, requireAdmin);

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

router.get("/reports/costing", async (req, res) => {
  const range = resolveRange(req);
  if (!range) {
    return res.status(400).json({ error: "from and to must be yyyy-mm-dd, and from cannot be after to" });
  }
  const [summary, bySub, byService, byClient] = await Promise.all([
    costingSummary(range.from, range.to),
    REPORTS.costing_by_sub.run(range.from, range.to),
    REPORTS.costing_by_service.run(range.from, range.to),
    REPORTS.costing_by_client.run(range.from, range.to),
  ]);
  return res.json({ summary, bySub, byService, byClient, assistantAvailable: assistantConfigured() });
});

router.get("/reports/:key", async (req, res) => {
  const key = String(req.params.key);
  if (!isReportKey(key)) return res.status(404).json({ error: "No such report" });
  const range = resolveRange(req);
  if (!range) {
    return res.status(400).json({ error: "from and to must be yyyy-mm-dd, and from cannot be after to" });
  }
  const rows = await REPORTS[key].run(range.from, range.to);
  return res.json({ key, title: REPORTS[key].title, rows });
});

/**
 * The question box. 503 rather than a generic failure when no key is set, so the
 * cause is obvious: this is configuration, not a bug.
 */
router.post("/reports/ask", async (req, res) => {
  if (!assistantConfigured()) {
    return res.status(503).json({
      error: "The assistant is not configured. Set XAI_API_KEY on the server to enable it.",
    });
  }
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) return res.status(400).json({ error: "Ask a question first" });
  if (question.length > 500) return res.status(400).json({ error: "That question is too long" });

  const range = resolveRange({ query: req.body ?? {} });
  if (!range) {
    return res.status(400).json({ error: "from and to must be yyyy-mm-dd, and from cannot be after to" });
  }

  try {
    return res.json(await answerQuestion(question, range.from, range.to));
  } catch (err) {
    req.log.error({ err }, "assistant question failed");
    const message = err instanceof Error ? err.message : "The assistant could not answer that.";
    return res.status(502).json({ error: message });
  }
});

export default router;
