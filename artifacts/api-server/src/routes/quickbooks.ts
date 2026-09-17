import { Router, type IRouter, type Request, type Response } from "express";
import type { QuickbooksConnection } from "@workspace/db";
import {
  GetQuickbooksExpensesQueryParams,
  GetQuickbooksProfitAndLossQueryParams,
} from "@workspace/api-zod";
import { requireAuth, requireArea } from "../middlewares/requireAuth";
import {
  IntuitAuthError,
  buildAuthorizeUrl,
  buildReport,
  consumeAuthState,
  createAuthState,
  deleteConnections,
  exchangeAuthorizationCode,
  expenseSections,
  fetchCompanyName,
  fetchReport,
  getEndpoints,
  intuitEnvironment,
  isConfigured,
  isGrantLive,
  loadConnection,
  markGrantRevoked,
  normalizeEnvironment,
  recordError,
  resolveRange,
  resolveRedirectUri,
  revokeAtIntuit,
  saveConnection,
} from "../lib/quickbooks";

const router: IRouter = Router();

/**
 * Everything except the callback is his own admin console.
 *
 * The callback is deliberately outside this: Intuit hands the browser back to it
 * with no session of ours attached, so it cannot be behind auth and must verify
 * the request on its own — see below.
 */
router.use(
  [
    "/quickbooks/status",
    "/quickbooks/connect",
    "/quickbooks/disconnect",
    "/quickbooks/profit-and-loss",
    "/quickbooks/expenses",
  ],
  requireAuth,
  // The books are the one area Adam named for a second full user who must
  // never see them, so this is a per-area check rather than "any admin".
  requireArea("quickbooks"),
);

/**
 * Where the browser is sent after the callback finishes.
 *
 * Always a same-origin relative path, built from configuration. Nothing from the
 * callback's query string reaches it — a redirect target taken from an
 * unauthenticated request is an open redirect waiting to happen.
 */
function booksPageUrl(outcome: string): string {
  const raw = (process.env.BASE_PATH ?? "").trim();
  // Only a rooted, single-slash path is honoured. An absolute URL, a
  // protocol-relative "//host", or a value some shell rewrote into a Windows
  // path on the way into the environment all fall back to the app root rather
  // than becoming a redirect off this origin.
  const base = /^\/[^/]/.test(raw) ? raw.replace(/\/+$/, "") : "";
  return `${base}/books?quickbooks=${outcome}`;
}

// ------------------------------------------------------------------ status --

router.get("/quickbooks/status", async (req, res) => {
  const configured = isConfigured();
  const connection = await loadConnection();
  const redirectUri = resolveRedirectUri();

  let connectUrl: string | null = null;
  if (configured && redirectUri) {
    const endpoints = await getEndpoints(intuitEnvironment());
    connectUrl = buildAuthorizeUrl(
      endpoints,
      redirectUri,
      // The state is minted here, for this page load, so the link he clicks
      // carries one we can vouch for. It is cheap and single-use; an unclicked
      // one simply ages out.
      createAuthState({ connectedByName: req.appUser?.name ?? null }),
    );
  }

  // Deliberately not spread from the row: the access and refresh tokens live on
  // that record and this response goes to a browser.
  return res.json({
    connected: isGrantLive(connection),
    configured,
    companyName: connection?.companyName ?? null,
    realmId: connection?.realmId ?? null,
    environment: connection?.environment ?? (configured ? intuitEnvironment() : null),
    connectedAt: connection?.connectedAt?.toISOString() ?? null,
    connectedByName: connection?.connectedByName ?? null,
    lastSyncedAt: connection?.lastSyncedAt?.toISOString() ?? null,
    lastError: connection?.lastError ?? null,
    connectUrl,
  });
});

// ----------------------------------------------------------------- connect --

router.get("/quickbooks/connect", async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({
      error: "This server has no Intuit credentials, so it cannot connect to QuickBooks.",
    });
  }
  const redirectUri = resolveRedirectUri();
  if (!redirectUri) {
    return res.status(503).json({
      error: "Set APP_PUBLIC_URL (or INTUIT_REDIRECT_URI) so QuickBooks knows where to send the browser back.",
    });
  }
  const environment = intuitEnvironment();
  const endpoints = await getEndpoints(environment);
  const state = createAuthState({ connectedByName: req.appUser?.name ?? null });
  return res.redirect(buildAuthorizeUrl(endpoints, redirectUri, state));
});

// ---------------------------------------------------------------- callback --

/**
 * Intuit's redirect back after he approves (or declines) the connection.
 *
 * Unauthenticated by necessity, so nothing in the query string is believed on
 * its own:
 *  - `state` must be one we minted and have not already redeemed. A mismatch is
 *    rejected outright — that is the whole defence against someone walking his
 *    browser into binding this app to *their* QuickBooks company.
 *  - `realmId` is checked for shape, then proved by asking Intuit for that
 *    company's name with the token we were just issued. A token that is not
 *    valid for the claimed realm fails there.
 *  - `error` is never echoed back into the redirect; only fixed outcome codes
 *    are.
 */
router.get("/quickbooks/callback", async (req, res) => {
  const query = req.query as Record<string, unknown>;

  const pending = consumeAuthState(query.state);
  if (!pending) {
    req.log.warn("quickbooks callback rejected: unknown, expired or already-used state");
    return res.redirect(booksPageUrl("state-mismatch"));
  }

  if (typeof query.error === "string" && query.error) {
    // He clicked Deny, or Intuit refused. Nothing to exchange.
    req.log.info("quickbooks authorisation was not granted");
    return res.redirect(booksPageUrl("declined"));
  }

  const code = typeof query.code === "string" ? query.code : "";
  const realmId = typeof query.realmId === "string" ? query.realmId : "";
  if (!code || !/^\d{1,32}$/.test(realmId)) {
    req.log.warn("quickbooks callback rejected: missing code or malformed realmId");
    return res.redirect(booksPageUrl("invalid-callback"));
  }

  const redirectUri = resolveRedirectUri();
  if (!redirectUri) return res.redirect(booksPageUrl("not-configured"));

  try {
    const tokens = await exchangeAuthorizationCode(pending.environment, code, redirectUri);

    // Saved first so the company-name lookup has a real connection to borrow the
    // token and environment from. `connectedByName` comes from the state we
    // minted when he clicked Connect, not from anything Intuit handed back.
    let connection = await saveConnection({
      realmId,
      companyName: null,
      tokens,
      environment: pending.environment,
      connectedByName: pending.connectedByName,
    });

    try {
      const companyName = await fetchCompanyName(connection);
      connection = await saveConnection({
        realmId,
        companyName,
        tokens,
        environment: pending.environment,
        connectedByName: pending.connectedByName,
      });
    } catch (err) {
      // The grant is good even if this lookup is not; the page falls back to
      // showing the realm id. Worth recording so it is visible rather than odd.
      await recordError(connection, err instanceof Error ? err.message : "Could not read the company name.");
      req.log.warn({ err }, "quickbooks connected but company name lookup failed");
    }

    return res.redirect(booksPageUrl("connected"));
  } catch (err) {
    req.log.error({ err }, "quickbooks token exchange failed");
    return res.redirect(booksPageUrl("exchange-failed"));
  }
});

// -------------------------------------------------------------- disconnect --

router.post("/quickbooks/disconnect", async (req, res) => {
  const connection = await loadConnection();
  if (connection) {
    try {
      // Courtesy, not correctness: the grant is dropped here regardless.
      await revokeAtIntuit(normalizeEnvironment(connection.environment), connection.refreshToken);
    } catch (err) {
      req.log.warn({ err }, "quickbooks revoke failed; forgetting the grant locally anyway");
    }
  }
  await deleteConnections();
  return res.status(204).end();
});

// ----------------------------------------------------------------- reports --

type RangeOrResponse = { from: string; to: string } | null;

function resolveRequestedRange(
  req: Request,
  res: Response,
  params: { from?: string; to?: string },
): RangeOrResponse {
  const range = resolveRange(params.from, params.to);
  if (!range.ok) {
    res.status(400).json({ error: range.error });
    return null;
  }
  return { from: range.from, to: range.to };
}

async function requireLiveConnection(res: Response): Promise<QuickbooksConnection | null> {
  const connection = await loadConnection();
  if (!isGrantLive(connection)) {
    res.status(409).json({
      error: connection?.lastError ?? "QuickBooks is not connected. Connect it from the Books page.",
    });
    return null;
  }
  return connection;
}

/**
 * Runs a report and turns the two failure modes into different answers.
 *
 * A revoked grant is recorded and reported as "reconnect", not thrown on every
 * subsequent page load; anything else is an upstream problem, kept in
 * `lastError` with Intuit's trace id so the next person to look has something
 * to give their support team.
 */
async function respondWithReport(
  req: Request,
  res: Response,
  connection: QuickbooksConnection,
  options: { reportName: string; title: string; from: string; to: string; expensesOnly: boolean },
) {
  try {
    const { report } = await fetchReport(connection, options.reportName, {
      start_date: options.from,
      end_date: options.to,
    });
    return res.json(
      buildReport({
        report,
        title: options.title,
        from: options.from,
        to: options.to,
        rows: options.expensesOnly ? expenseSections(report) : undefined,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "QuickBooks could not be reached.";
    if (err instanceof IntuitAuthError && err.revoked) {
      await markGrantRevoked(connection, message);
      req.log.warn({ err }, "quickbooks grant is no longer valid");
      return res.status(409).json({ error: message });
    }
    await recordError(connection, message);
    req.log.error({ err }, "quickbooks report request failed");
    return res.status(502).json({ error: message });
  }
}

router.get("/quickbooks/profit-and-loss", async (req, res) => {
  const params = GetQuickbooksProfitAndLossQueryParams.parse(req.query);
  const range = resolveRequestedRange(req, res, params);
  if (!range) return;
  const connection = await requireLiveConnection(res);
  if (!connection) return;

  return respondWithReport(req, res, connection, {
    reportName: "ProfitAndLoss",
    title: "Profit & Loss",
    from: range.from,
    to: range.to,
    expensesOnly: false,
  });
});

/**
 * "Where did the money go", by category.
 *
 * This is the expense side of the Profit & Loss — the Expenses, Cost of Goods
 * Sold and Other Expenses sections — rather than `ProfitAndLossDetail` or an
 * expenses-by-vendor report. Three reasons:
 *
 *  - He asked by *category*. `VendorExpenses` answers "who did I pay", which is
 *    a different question, and `ProfitAndLossDetail` answers with one row per
 *    transaction: in this report's flat {label, amount} shape those labels come
 *    out as dates and cheque numbers, not categories.
 *  - The numbers tie exactly to the P&L shown above it on the same page. Two
 *    expense figures on one screen that do not agree is a support call, and
 *    "why doesn't this match my P&L" is not a question worth manufacturing.
 *  - It is a summary report. Intuit warns that the detail reports time out on
 *    wide requests, and a year of a busy company's transactions is exactly that.
 */
router.get("/quickbooks/expenses", async (req, res) => {
  const params = GetQuickbooksExpensesQueryParams.parse(req.query);
  const range = resolveRequestedRange(req, res, params);
  if (!range) return;
  const connection = await requireLiveConnection(res);
  if (!connection) return;

  return respondWithReport(req, res, connection, {
    reportName: "ProfitAndLoss",
    title: "Expenses by category",
    from: range.from,
    to: range.to,
    expensesOnly: true,
  });
});

export default router;
