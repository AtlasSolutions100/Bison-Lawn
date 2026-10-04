/**
 * The Polish button.
 *
 * "When sending emails — having an option to use AI for clarity and
 * professionalism, currently use chatgpt. Like in GMail." Today he copies his
 * half-written email into ChatGPT, reads what comes back, and pastes it in. One
 * endpoint, one job: hand back a tidier version of the words he sent so the page
 * can show him both and let him choose.
 *
 * What is deliberately NOT here: any mention of the customer. The body is the
 * text and a tone, nothing else — no client id, no invoice, no history. That is
 * a rule, not an oversight; see lib/aiAssistant.ts.
 *
 * No logAudit. This moves no money, no schedule and no access — it rewrites
 * words in a box he has not sent yet. The send itself is already audited where
 * it happens.
 */
import { Router, type IRouter } from "express";
import { PolishTextBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { polishText, type PolishTone } from "../lib/aiAssistant";

const router: IRouter = Router();

// Anyone signed in who can type an email can tidy it up. Deliberately not
// gated on an area: the contractor "crew is on the way" note goes through the
// phone app, and locking this to the office would make the button vanish for
// exactly the person least likely to enjoy writing it.
router.use(["/ai"], requireAuth);

router.post("/ai/polish", async (req, res) => {
  const body = PolishTextBody.parse(req.body);
  if (!body.text.trim()) {
    return res.status(400).json({ error: "There is nothing written yet to tidy up." });
  }
  // The generated zod enum has already refused anything but the three tones,
  // so this only fills in the default for a body that left it out.
  const tone: PolishTone = body.tone ?? "clear";

  try {
    return res.json(await polishText(body.text, tone));
  } catch (err) {
    // A reachability failure, not something he can fix in the box. The page
    // keeps his words and says to try again rather than clearing anything.
    req.log.error({ err }, "ai polish failed");
    return res.status(502).json({
      error: "The AI rewrite could not be reached just now. Your words are untouched — try again in a minute.",
    });
  }
});

export default router;
