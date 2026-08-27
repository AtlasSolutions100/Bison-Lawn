/**
 * Intuit QuickBooks Online — OAuth grant handling and the read-only reports client.
 *
 * The owner asked to "see the data from quickbooks with out logging into quick
 * books. Mostly expenses and P&L statement". Nothing here writes to QuickBooks:
 * the only calls made against his company file are GETs (Reports, CompanyInfo).
 * His bookkeeping stays in QuickBooks where his accountant expects to find it,
 * and this app is a window onto it.
 *
 * Required env:
 *   INTUIT_CLIENT_ID / INTUIT_CLIENT_SECRET  — from the Intuit developer app
 *   APP_PUBLIC_URL                           — used to build the redirect URI
 * Optional env:
 *   INTUIT_REDIRECT_URI     — override when the registered URI is not APP_PUBLIC_URL/api/quickbooks/callback
 *   INTUIT_ENVIRONMENT      — "sandbox" (default) | "production"
 *   INTUIT_MINOR_VERSION    — pins a Reports API minor version; omitted by default
 */

import { randomBytes } from "node:crypto";
import { db, quickbooksConnectionTable, type QuickbooksConnection } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "./logger";

export type QuickbooksEnvironment = "sandbox" | "production";

// Read-only reporting needs nothing more. Asking for payments or openid would
// widen the grant beyond what the feature does.
const SCOPE = "com.intuit.quickbooks.accounting";

const API_BASE: Record<QuickbooksEnvironment, string> = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};

// Access tokens live an hour. Refresh with room to spare so a report request
// never races its own token expiring mid-flight.
const REFRESH_SKEW_MS = 5 * 60_000;

const OUTBOUND_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------- config ----

/**
 * Whether the server holds Intuit client credentials at all. This is the
 * difference between "he has not connected yet" and "nobody ever gave this
 * deployment keys" — two very different things to show him.
 */
export function isConfigured(): boolean {
  return Boolean(process.env.INTUIT_CLIENT_ID?.trim() && process.env.INTUIT_CLIENT_SECRET?.trim());
}

/** The environment a *new* connection would be made against. */
export function intuitEnvironment(): QuickbooksEnvironment {
  return process.env.INTUIT_ENVIRONMENT?.trim().toLowerCase() === "production"
    ? "production"
    : "sandbox";
}

export function normalizeEnvironment(value: string | null | undefined): QuickbooksEnvironment {
  return value === "production" ? "production" : "sandbox";
}

/**
 * The API host follows the environment stored with the grant, never a constant.
 * Development keys only reach the sandbox, production keys only reach the live
 * host, and pointing one at the other fails in a way that reads like a
 * permissions problem rather than a wrong-host problem.
 *
 * An unrecognised value falls back to sandbox deliberately: the worst outcome
 * of that is a failed call, whereas defaulting to production would be the first
 * step towards showing sandbox numbers as if they were his real books.
 */
export function apiBaseUrl(environment: string | null | undefined): string {
  return API_BASE[normalizeEnvironment(environment)];
}

/**
 * The redirect URI Intuit sends the browser back to. It must match what is
 * registered on the Intuit app exactly, so it is derived from configuration
 * only — never from the request's Host header, which the caller controls.
 */
export function resolveRedirectUri(): string | null {
  const explicit = process.env.INTUIT_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const publicUrl = process.env.APP_PUBLIC_URL?.trim();
  if (!publicUrl) return null;
  try {
    return new URL("/api/quickbooks/callback", publicUrl).toString();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- discovery ----

export type IntuitEndpoints = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  /** False when these are the built-in constants because discovery was unreachable. */
  discovered: boolean;
};

const DISCOVERY_URL: Record<QuickbooksEnvironment, string> = {
  production: "https://developer.api.intuit.com/.well-known/openid_configuration",
  sandbox: "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration",
};

/**
 * The values Intuit's discovery documents publish today, kept as a fallback.
 *
 * Discovery is the source of truth — Intuit asks integrations to read it rather
 * than hardcode — but an outage at the discovery host must not take a working
 * connection down with it, so these stand in until the next refresh succeeds.
 */
const FALLBACK_ENDPOINTS: IntuitEndpoints = {
  issuer: "https://oauth.platform.intuit.com/op/v1",
  authorizationEndpoint: "https://appcenter.intuit.com/connect/oauth2",
  tokenEndpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocationEndpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
  discovered: false,
};

// Endpoints move about once a decade; a day of caching keeps discovery off the
// hot path without pinning a stale value for the life of the process.
const DISCOVERY_TTL_MS = 24 * 60 * 60_000;

const discoveryCache = new Map<QuickbooksEnvironment, { endpoints: IntuitEndpoints; expiresAt: number }>();
const discoveryInFlight = new Map<QuickbooksEnvironment, Promise<IntuitEndpoints>>();

function endpointsFromDocument(doc: Record<string, unknown>): IntuitEndpoints | null {
  const pick = (key: string): string | null => {
    const value = doc[key];
    return typeof value === "string" && value.startsWith("https://") ? value : null;
  };
  const authorizationEndpoint = pick("authorization_endpoint");
  const tokenEndpoint = pick("token_endpoint");
  const revocationEndpoint = pick("revocation_endpoint");
  const issuer = pick("issuer");
  // A partial document is not usable: half-discovered, half-hardcoded endpoints
  // would be the hardest possible thing to debug.
  if (!authorizationEndpoint || !tokenEndpoint || !revocationEndpoint || !issuer) return null;
  return { issuer, authorizationEndpoint, tokenEndpoint, revocationEndpoint, discovered: true };
}

async function loadEndpoints(environment: QuickbooksEnvironment): Promise<IntuitEndpoints> {
  try {
    const response = await fetch(DISCOVERY_URL[environment], {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
    logIntuitResponse("discovery", response.status, tidOf(response), { environment });
    if (!response.ok) return FALLBACK_ENDPOINTS;
    const endpoints = endpointsFromDocument((await response.json()) as Record<string, unknown>);
    if (!endpoints) {
      logger.warn({ environment }, "intuit discovery document was missing endpoints; using built-in defaults");
      return FALLBACK_ENDPOINTS;
    }
    discoveryCache.set(environment, { endpoints, expiresAt: Date.now() + DISCOVERY_TTL_MS });
    return endpoints;
  } catch (err) {
    logger.warn({ err, environment }, "intuit discovery fetch failed; using built-in defaults");
    return FALLBACK_ENDPOINTS;
  }
}

/**
 * OAuth endpoints for an environment, read from Intuit's discovery document.
 *
 * Only a successful fetch is cached: a fallback result is not, so the next call
 * tries discovery again rather than pinning the defaults for a whole day after
 * one blip.
 */
export async function getEndpoints(environment: QuickbooksEnvironment): Promise<IntuitEndpoints> {
  const cached = discoveryCache.get(environment);
  if (cached && cached.expiresAt > Date.now()) return cached.endpoints;

  const existing = discoveryInFlight.get(environment);
  if (existing) return existing;

  const load = loadEndpoints(environment).finally(() => discoveryInFlight.delete(environment));
  discoveryInFlight.set(environment, load);
  return load;
}

/** Test hook: drop cached discovery so the next call refetches. */
export function resetDiscoveryCache() {
  discoveryCache.clear();
  discoveryInFlight.clear();
}

export function buildAuthorizeUrl(
  endpoints: IntuitEndpoints,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(endpoints.authorizationEndpoint);
  // The client id is public by OAuth design — it travels in the browser's
  // address bar on every authorisation. The secret never appears here.
  url.searchParams.set("client_id", process.env.INTUIT_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

// ------------------------------------------------------ intuit_tid traces ----

/**
 * Intuit stamps every response with `intuit_tid`. It is the only handle their
 * support team can trace a request by, so it is logged on success and failure
 * alike and carried into anything the owner is shown — "QuickBooks says no" is
 * only diagnosable with that id attached.
 */
export function tidOf(response: Response): string | null {
  return response.headers.get("intuit_tid");
}

function logIntuitResponse(
  operation: string,
  status: number,
  intuitTid: string | null,
  extra: Record<string, unknown> = {},
) {
  const fields = { operation, status, intuitTid, ...extra };
  if (status >= 400) logger.warn(fields, "intuit request failed");
  else logger.info(fields, "intuit request");
}

function withTid(message: string, intuitTid: string | null): string {
  return intuitTid ? `${message} (Intuit reference ${intuitTid})` : message;
}

// ------------------------------------------------------------ CSRF state ----

type PendingAuth = {
  expiresAt: number;
  /** Captured when the admin asked to connect, so the callback need not trust a name it is handed. */
  connectedByName: string | null;
  environment: QuickbooksEnvironment;
};

/**
 * Outstanding `state` values, keyed by the value itself.
 *
 * In memory rather than in a table because the schema has no place for it and a
 * pending authorisation is seconds-to-minutes old by nature. The trade-off is
 * explicit: a server restart, or a second process, between clicking Connect and
 * Intuit calling back means the callback is rejected and he clicks Connect
 * again. That is the safe direction to fail — a state we cannot vouch for is
 * exactly the one we must not honour.
 */
const pendingAuth = new Map<string, PendingAuth>();
const STATE_TTL_MS = 15 * 60_000;
const MAX_PENDING_STATES = 100;

function prunePendingAuth() {
  const now = Date.now();
  for (const [key, value] of pendingAuth) {
    if (value.expiresAt <= now) pendingAuth.delete(key);
  }
  // Map iterates in insertion order, so this drops the oldest first.
  while (pendingAuth.size >= MAX_PENDING_STATES) {
    const oldest = pendingAuth.keys().next();
    if (oldest.done) break;
    pendingAuth.delete(oldest.value);
  }
}

/**
 * Mint a single-use `state` for one authorisation attempt.
 *
 * 32 random bytes from the CSPRNG: the whole point of `state` is that an
 * attacker cannot produce one. Anything derived from a timestamp, a counter or
 * a user id would be forgeable, and a forgeable state is what lets someone hand
 * this app *their* QuickBooks company by walking the owner's browser through a
 * callback he never asked for.
 */
export function createAuthState(details: { connectedByName: string | null }): string {
  prunePendingAuth();
  const state = randomBytes(32).toString("base64url");
  pendingAuth.set(state, {
    expiresAt: Date.now() + STATE_TTL_MS,
    connectedByName: details.connectedByName,
    environment: intuitEnvironment(),
  });
  return state;
}

/**
 * Redeem a `state` handed back by Intuit. Returns null when we did not mint it,
 * already redeemed it, or it has aged out. Single use: a replayed callback finds
 * nothing.
 */
export function consumeAuthState(state: unknown): PendingAuth | null {
  if (typeof state !== "string" || state.length === 0) return null;
  const pending = pendingAuth.get(state);
  if (!pending) return null;
  pendingAuth.delete(state);
  if (pending.expiresAt <= Date.now()) return null;
  return pending;
}

/** Test hook: forget every outstanding authorisation attempt. */
export function resetAuthStates() {
  pendingAuth.clear();
}

// ----------------------------------------------------------------- token ----

export class IntuitAuthError extends Error {
  /** True when Intuit says the grant itself is gone — reconnecting is the only fix. */
  readonly revoked: boolean;

  constructor(message: string, revoked = false) {
    super(message);
    this.name = "IntuitAuthError";
    this.revoked = revoked;
  }
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
};

/**
 * Turn a failed token response into something safe to store and show.
 *
 * Only Intuit's `error` / `error_description` fields are carried through. The
 * raw body is never surfaced or logged: on the success path it contains the
 * tokens themselves, and keeping one code path that never touches the body is
 * how that stays true after the next edit.
 */
function describeTokenFailure(
  status: number,
  body: string,
  intuitTid: string | null,
): { message: string; revoked: boolean } {
  let code = "";
  let description = "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    if (typeof parsed.error === "string") code = parsed.error;
    if (typeof parsed.error_description === "string") description = parsed.error_description;
  } catch {
    // Intuit occasionally answers with HTML on infrastructure errors.
  }
  const revoked = code === "invalid_grant";
  const detail = [code, description].filter(Boolean).join(": ");
  return {
    message: withTid(
      revoked
        ? "QuickBooks no longer accepts this connection. It was disconnected in QuickBooks, or went unused for more than 100 days. Reconnect to restore it."
        : `QuickBooks rejected the token request (${status}${detail ? ` ${detail}` : ""}).`,
      intuitTid,
    ),
    revoked,
  };
}

/**
 * One token request, never retried.
 *
 * A rejected authorisation is a decision, not a hiccup: replaying an
 * authorization code that Intuit already consumed, or a refresh token it has
 * just rotated, turns one clean failure into a grant that looks broken. The
 * caller surfaces the failure instead.
 */
async function postToken(
  environment: QuickbooksEnvironment,
  grantType: string,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const clientId = process.env.INTUIT_CLIENT_ID?.trim();
  const clientSecret = process.env.INTUIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new IntuitAuthError("INTUIT_CLIENT_ID and INTUIT_CLIENT_SECRET are not set on the server.");
  }

  const endpoints = await getEndpoints(environment);
  const response = await fetch(endpoints.tokenEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });

  const intuitTid = tidOf(response);
  // grantType, status and the trace id only. Never the request body (it holds
  // the refresh token) and never the response body (it holds both tokens).
  logIntuitResponse("token", response.status, intuitTid, { grantType, environment });

  if (!response.ok) {
    const { message, revoked } = describeTokenFailure(response.status, await response.text(), intuitTid);
    throw new IntuitAuthError(message, revoked);
  }

  const data = (await response.json()) as Partial<TokenResponse>;
  if (!data.access_token || !data.refresh_token) {
    throw new IntuitAuthError(withTid("QuickBooks returned an incomplete token response.", intuitTid));
  }
  return data as TokenResponse;
}

export function exchangeAuthorizationCode(
  environment: QuickbooksEnvironment,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  return postToken(
    environment,
    "authorization_code",
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  );
}

export function refreshTokens(
  environment: QuickbooksEnvironment,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(
    environment,
    "refresh_token",
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  );
}

// ------------------------------------------------------------- the grant ----

export async function loadConnection(): Promise<QuickbooksConnection | null> {
  // Ordered because reconnecting to a different company file adds a row rather
  // than overwriting the old one; the newest grant is the one he just made.
  const [row] = await db
    .select()
    .from(quickbooksConnectionTable)
    .orderBy(desc(quickbooksConnectionTable.connectedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Whether the stored grant can still be used.
 *
 * A refresh token expiry in the past means either Intuit's 100-day idle limit
 * ran out or we marked it dead after a rejected refresh. Both mean "he must
 * reconnect", and both must read as disconnected instead of throwing on every
 * page load.
 */
export function isGrantLive(connection: QuickbooksConnection | null): boolean {
  if (!connection) return false;
  const expiry = connection.refreshTokenExpiresAt;
  return expiry == null || expiry.getTime() > Date.now();
}

function expiryFrom(seconds: number | undefined, fallbackSeconds: number): Date {
  return new Date(Date.now() + (seconds ?? fallbackSeconds) * 1000);
}

export async function saveConnection(params: {
  realmId: string;
  companyName: string | null;
  tokens: TokenResponse;
  environment: QuickbooksEnvironment;
  connectedByName: string | null;
}): Promise<QuickbooksConnection> {
  const values = {
    realmId: params.realmId,
    companyName: params.companyName,
    accessToken: params.tokens.access_token,
    refreshToken: params.tokens.refresh_token,
    accessTokenExpiresAt: expiryFrom(params.tokens.expires_in, 3600),
    // 101 days, matching Intuit's documented refresh-token lifetime, so a
    // response that omits the field still records a realistic deadline.
    refreshTokenExpiresAt: expiryFrom(params.tokens.x_refresh_token_expires_in, 8_726_400),
    environment: params.environment,
    connectedByName: params.connectedByName,
    connectedAt: new Date(),
    lastError: null,
  };
  const [row] = await db
    .insert(quickbooksConnectionTable)
    .values(values)
    .onConflictDoUpdate({ target: quickbooksConnectionTable.realmId, set: values })
    .returning();
  return row!;
}

export async function deleteConnections(): Promise<void> {
  await db.delete(quickbooksConnectionTable);
}

/**
 * Best-effort revocation at Intuit when he disconnects here.
 *
 * Failure is swallowed by the caller: he asked this app to forget the grant, and
 * it must forget it whether or not Intuit is reachable. This is the only
 * outbound call that is not a GET, and it touches the OAuth grant, never his
 * books.
 */
export async function revokeAtIntuit(
  environment: QuickbooksEnvironment,
  refreshToken: string,
): Promise<void> {
  const clientId = process.env.INTUIT_CLIENT_ID?.trim();
  const clientSecret = process.env.INTUIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return;
  const endpoints = await getEndpoints(environment);
  const response = await fetch(endpoints.revocationEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ token: refreshToken }),
    signal: AbortSignal.timeout(5_000),
  });
  logIntuitResponse("revoke", response.status, tidOf(response), { environment });
}

async function persistTokens(
  connection: QuickbooksConnection,
  tokens: TokenResponse,
): Promise<QuickbooksConnection> {
  // Both halves are written, because Intuit may hand back a new refresh token on
  // any refresh. Measured 2026-08-27 against the sandbox: two consecutive
  // refreshes returned the *same* refresh token and a rotated access token, so
  // rotation is occasional (roughly daily) rather than per-refresh. Writing only
  // the access token would therefore look correct for days and then strand a
  // dead refresh token on disk — the connection dies later for no visible
  // reason. Storing both costs nothing and removes the failure mode entirely.
  const [row] = await db
    .update(quickbooksConnectionTable)
    .set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: expiryFrom(tokens.expires_in, 3600),
      refreshTokenExpiresAt: expiryFrom(tokens.x_refresh_token_expires_in, 8_726_400),
      lastError: null,
    })
    .where(eq(quickbooksConnectionTable.id, connection.id))
    .returning();
  return row ?? connection;
}

export async function markGrantRevoked(
  connection: QuickbooksConnection,
  message: string,
): Promise<void> {
  // Expiring the refresh token is what makes `isGrantLive` report false, so the
  // next page load says "reconnect" instead of throwing the same error again.
  await db
    .update(quickbooksConnectionTable)
    .set({ lastError: message, refreshTokenExpiresAt: new Date() })
    .where(eq(quickbooksConnectionTable.id, connection.id));
}

export async function recordError(
  connection: QuickbooksConnection,
  message: string,
): Promise<void> {
  await db
    .update(quickbooksConnectionTable)
    .set({ lastError: message })
    .where(eq(quickbooksConnectionTable.id, connection.id));
}

let refreshInFlight: Promise<QuickbooksConnection> | null = null;

/**
 * The connection with an access token good for the next few minutes.
 *
 * Concurrent callers share one refresh: the two report requests the /books page
 * fires together would otherwise both rotate the refresh token, and the loser's
 * write would put a superseded token back in the database.
 */
export async function withFreshTokens(
  connection: QuickbooksConnection,
): Promise<QuickbooksConnection> {
  if (connection.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) return connection;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const tokens = await refreshTokens(normalizeEnvironment(connection.environment), connection.refreshToken);
    return persistTokens(connection, tokens);
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Test hook: drop any shared in-flight refresh. */
export function resetRefreshInFlight() {
  refreshInFlight = null;
}

// -------------------------------------------------------- Intuit requests ----

async function intuitGet(
  connection: QuickbooksConnection,
  path: string,
  params: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(`${apiBaseUrl(connection.environment)}/v3/company/${connection.realmId}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const minorVersion = process.env.INTUIT_MINOR_VERSION?.trim();
  // Left off by default: pinning a minor version means the integration breaks on
  // the day Intuit retires it, and the report shape we read is in the base API.
  if (minorVersion) url.searchParams.set("minorversion", minorVersion);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  logIntuitResponse(path.split("/")[0] ?? path, response.status, tidOf(response), {
    environment: connection.environment,
  });
  return response;
}

function describeApiFailure(status: number, body: string, intuitTid: string | null): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { Fault?: { Error?: { Message?: string; Detail?: string }[] } };
    const fault = parsed.Fault?.Error?.[0];
    detail = [fault?.Message, fault?.Detail].filter(Boolean).join(" — ").slice(0, 300);
  } catch {
    // Non-JSON body; the bare status still says something useful.
  }
  return withTid(`QuickBooks returned ${status}${detail ? `: ${detail}` : "."}`, intuitTid);
}

/**
 * A report, with one forced refresh-and-retry on 401.
 *
 * The stored expiry is our belief about the token, not Intuit's: clock skew, or
 * a token invalidated early, both show up as a 401 on a token we thought was
 * good. This one retry is a *data* retry against a fresh token — the token
 * request behind it is still made exactly once, and a rejected refresh is
 * reported rather than replayed.
 */
export async function fetchReport(
  connection: QuickbooksConnection,
  reportName: string,
  params: Record<string, string>,
): Promise<{ report: IntuitReport; connection: QuickbooksConnection }> {
  let live = await withFreshTokens(connection);
  let response = await intuitGet(live, `reports/${reportName}`, params);

  if (response.status === 401) {
    const environment = normalizeEnvironment(live.environment);
    live = await persistTokens(live, await refreshTokens(environment, live.refreshToken));
    response = await intuitGet(live, `reports/${reportName}`, params);
  }

  if (!response.ok) {
    throw new Error(describeApiFailure(response.status, await response.text(), tidOf(response)));
  }

  const report = (await response.json()) as IntuitReport;
  await db
    .update(quickbooksConnectionTable)
    .set({ lastSyncedAt: new Date(), lastError: null })
    .where(eq(quickbooksConnectionTable.id, live.id));
  return { report, connection: live };
}

/**
 * The company file's display name, fetched right after the token exchange.
 *
 * It doubles as proof that the token we were just issued really does belong to
 * the realmId the callback claimed — the only part of that query string worth
 * anything is the part Intuit will confirm.
 */
export async function fetchCompanyName(connection: QuickbooksConnection): Promise<string | null> {
  const response = await intuitGet(connection, `companyinfo/${connection.realmId}`);
  if (!response.ok) {
    throw new Error(describeApiFailure(response.status, await response.text(), tidOf(response)));
  }
  const data = (await response.json()) as { CompanyInfo?: { CompanyName?: string } };
  return data.CompanyInfo?.CompanyName?.trim() || null;
}

// --------------------------------------------------------------- reports ----

export type IntuitColData = { value?: string; id?: string };
export type IntuitRowGroup = { Row?: IntuitRow[] };
export type IntuitRow = {
  Header?: { ColData?: IntuitColData[] };
  Rows?: IntuitRowGroup;
  Summary?: { ColData?: IntuitColData[] };
  ColData?: IntuitColData[];
  type?: string;
  group?: string;
};
export type IntuitReport = {
  Header?: {
    ReportName?: string;
    StartPeriod?: string;
    EndPeriod?: string;
    Currency?: string;
    ReportBasis?: string;
  };
  Columns?: { Column?: { ColTitle?: string; ColType?: string }[] };
  Rows?: IntuitRowGroup;
};

export type FlatReportRow = {
  label: string;
  amount: number;
  isTotal: boolean;
  depth: number;
};

export type FlatReport = {
  title: string;
  from: string;
  to: string;
  currency: string | null;
  rows: FlatReportRow[];
};

/**
 * QuickBooks renders money as display text, not numbers: thousands separators,
 * a currency symbol in some responses, and parentheses for negatives. Blank is
 * a real value too — a section heading has no amount of its own.
 */
export function parseAmount(raw: string | undefined | null): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const negated = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[^0-9.\-]/g, "");
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return 0;
  return negated ? -Math.abs(value) : value;
}

function labelOf(cols: IntuitColData[] | undefined): string {
  return cols?.[0]?.value?.trim() ?? "";
}

/**
 * The money column is the last one, not column 1. A report summarised by Total
 * has two columns; one summarised by month has fourteen, and the last of those
 * is the row's total — the figure he is looking for either way.
 */
function amountOf(cols: IntuitColData[] | undefined): number {
  if (!cols || cols.length < 2) return 0;
  return parseAmount(cols[cols.length - 1]?.value);
}

// Deep enough for any chart of accounts, shallow enough that a malformed or
// self-referential payload cannot spin.
const MAX_ROW_DEPTH = 24;

/**
 * Flatten Intuit's nested report rows into the flat list the UI renders.
 *
 * One row can carry a Header (the section's own line), Rows (its children) and a
 * Summary (its total) at once, and any of the three can be missing — "Gross
 * Profit" arrives as a Summary with nothing else, and an expense section with no
 * activity in the period is a Header and Summary with no Rows at all. Nesting
 * goes as deep as his chart of accounts does, so depth is carried through the
 * recursion rather than assumed.
 */
export function flattenRows(
  group: IntuitRowGroup | undefined,
  depth = 0,
  out: FlatReportRow[] = [],
): FlatReportRow[] {
  if (!group?.Row || depth > MAX_ROW_DEPTH) return out;

  for (const row of group.Row) {
    const headerLabel = labelOf(row.Header?.ColData);
    if (headerLabel) {
      out.push({ label: headerLabel, amount: amountOf(row.Header?.ColData), isTotal: false, depth });
    }

    const dataLabel = labelOf(row.ColData);
    if (dataLabel) {
      out.push({ label: dataLabel, amount: amountOf(row.ColData), isTotal: false, depth });
    }

    // Children indent under their heading. A section with no heading of its own
    // is a wrapper, not a level, so it does not add one.
    if (row.Rows) flattenRows(row.Rows, depth + (headerLabel ? 1 : 0), out);

    const summaryLabel = labelOf(row.Summary?.ColData);
    if (summaryLabel) {
      out.push({ label: summaryLabel, amount: amountOf(row.Summary?.ColData), isTotal: true, depth });
    }
  }

  return out;
}

// The top-level P&L sections that answer "where did the money go". `group` is
// Intuit's stable machine name for the section; the printed heading is not.
const EXPENSE_GROUPS = new Set(["Expenses", "COGS", "OtherExpenses"]);

/**
 * The expense side of a Profit & Loss.
 *
 * Matched on `group` first, because that is the field Intuit means to be read.
 * The label fallback exists because a row missing the attribute would otherwise
 * vanish silently, and an expenses report that is quietly empty is worse than
 * one that is slightly over-inclusive.
 */
export function expenseSections(report: IntuitReport): IntuitRowGroup {
  const rows = (report.Rows?.Row ?? []).filter((row) => {
    if (row.group) return EXPENSE_GROUPS.has(row.group);
    const label = labelOf(row.Header?.ColData) || labelOf(row.Summary?.ColData);
    return /expense|cost of goods/i.test(label);
  });
  return { Row: rows };
}

export function buildReport(params: {
  report: IntuitReport;
  title: string;
  from: string;
  to: string;
  /** Defaults to the whole report; pass a subset to publish only part of it. */
  rows?: IntuitRowGroup;
}): FlatReport {
  const header = params.report.Header;
  return {
    title: params.title,
    // Intuit echoes the period it actually ran, which can differ from what was
    // asked for (a fiscal-year boundary, say). Its answer wins.
    from: header?.StartPeriod || params.from,
    to: header?.EndPeriod || params.to,
    currency: header?.Currency ?? null,
    rows: flattenRows(params.rows ?? params.report.Rows),
  };
}

// ------------------------------------------------------------ date range ----

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The requested range, defaulting to the current year to date — the period the
 * question "how are we doing" usually means.
 */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
): { ok: true; from: string; to: string } | { ok: false; error: string } {
  const now = today();
  const start = from?.trim() || `${now.slice(0, 4)}-01-01`;
  const end = to?.trim() || now;
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
    return { ok: false, error: "Dates must be in YYYY-MM-DD form." };
  }
  if (start > end) {
    return { ok: false, error: "The start date must not be after the end date." };
  }
  return { ok: true, from: start, to: end };
}
