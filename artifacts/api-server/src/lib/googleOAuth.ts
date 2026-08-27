/**
 * Google OAuth access tokens for the app's own Google Cloud project.
 *
 * This replaces Replit's Connectors service, which brokered Google credentials
 * for us on-platform and does not exist anywhere else. We now hold a long-lived
 * refresh token for the Bison Lawn Care Gmail account and exchange it for short
 * access tokens ourselves.
 *
 * Required env:
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  — from the Google Cloud OAuth client
 *   GOOGLE_REFRESH_TOKEN                     — minted once by scripts/google-oauth-setup.mjs
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Refresh a minute early: an access token that expires mid-flight surfaces as a
// 401 on a customer-facing send, which the delivery state machine has to treat
// as a possible partial send.
const EXPIRY_SKEW_MS = 60_000;

let cached: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Google email delivery is not configured — see README.local.md.`,
    );
  }
  return value;
}

async function fetchAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    refresh_token: requireEnv("GOOGLE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    // A revoked or expired refresh token lands here. Name it, because the fix
    // is re-running the setup script, not retrying.
    throw new Error(
      `Google token refresh failed (${response.status}): ${detail.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error("Google token refresh returned no access_token");
  }

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS,
  };
  return cached.token;
}

/**
 * A valid access token, refreshed only when the cached one is close to expiry.
 * Concurrent callers share one refresh so a burst of sends does not fire a burst
 * of token requests.
 */
export async function getGoogleAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  if (inFlight) return inFlight;

  inFlight = fetchAccessToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Test hook: drop the cached token so the next call refreshes. */
export function resetGoogleAccessTokenCache() {
  cached = null;
  inFlight = null;
}
