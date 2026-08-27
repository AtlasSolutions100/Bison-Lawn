# QuickBooks auth-error handling — Intuit questionnaire Auth Q6 (a–d)

Date: 2026-08-27
Host: https://bisonlawncare.workoptional.tech (production deploy, sandbox Intuit environment)
Company: Sandbox Company US 1257, realm 9341457800325469

Answering Intuit's "Can your app handle the following scenarios" for expired access
tokens, expired refresh tokens, invalid grant, and CSRF. Three of the four are
verified by reading the code path; (a) was verified live against Intuit.

## (a) Expired access token — VERIFIED LIVE, twice

Method: force the stored expiry into the past in the production database, load
/books in a browser, then compare the stored token before and after. An access
token cannot be expired at Intuit on demand, so expiring *our belief* about it is
the closest honest test — it exercises the same `withFreshTokens` branch.

Run 1
- forced `access_token_expires_at` to `2026-08-27 05:00:41` (2h in the past)
- loaded /books: page rendered real sandbox figures, "Last read 2:00:49 AM"
- `access_token_expires_at` after: `2026-08-27 08:00:48` — a fresh hour
- `last_error`: (none)

Run 2 (hash comparison, to prove the token string itself changed rather than
just the expiry column)
- md5(access_token) before: `491f62cb33eed1d701161184abe81a61`
- md5(access_token) after:  `a9b6558db10434e47d24043c26806c1f`  -> ROTATED
- md5(refresh_token) before and after: `5a859d31f6d42004d6d01c8cd8dd3120` -> unchanged

Finding worth recording: Intuit returned the *same* refresh token on both
refreshes. The code comment in quickbooks.ts says Intuit "rotates the refresh
token on every refresh"; observed behaviour is that it does not — it reissues the
same one until roughly the 24-hour mark. Writing both halves is still correct
(when it does rotate, storing only the access token would strand a dead refresh
token), but the stated reason is more absolute than the observed behaviour.

Two independent mechanisms cover this scenario:
- proactive: `withFreshTokens` refreshes when the token is inside a 5-minute skew
- reactive: `fetchReport` retries exactly once on a 401 with a forced refresh,
  because the stored expiry is our belief and not Intuit's

## (b) Expired refresh token — code-verified

`isGrantLive` treats a past `refresh_token_expires_at` as disconnected, so the
app reports "not connected" and asks for a reconnect instead of throwing on every
page load. Expiry is stored at 101 days to match Intuit's documented lifetime;
observed value on this grant is 2026-12-06, about 101 days out.

Not live-tested: doing so requires waiting out the real 100-day idle window, or
destroying the grant.

## (c) Invalid grant — code-verified

`describeTokenFailure` parses the OAuth error body and treats `invalid_grant`
specially: `IntuitAuthError.revoked = true`, the route calls `markGrantRevoked`,
which sets `refresh_token_expires_at = now()` so `isGrantLive` reports false, and
returns HTTP 409 with:

  "QuickBooks no longer accepts this connection. It was disconnected in
   QuickBooks, or went unused for more than 100 days. Reconnect to restore it."

Token requests are never retried — a rejected authorisation is a decision, not a
hiccup, and replaying a consumed authorization code is itself an invalid_grant.

Not live-tested deliberately: the only way to trigger it is to invalidate the
real refresh token, which destroys the working sandbox grant and requires a fresh
OAuth authorisation to restore.

## (d) CSRF — code-verified, and the strongest of the four

- `state` is 32 CSPRNG bytes (`randomBytes(32).toString("base64url")`), not
  derived from anything guessable. A forgeable state is exactly what lets an
  attacker walk the owner's browser through a callback he never asked for and
  attach *their* QuickBooks company to his app.
- Single use: `consumeAuthState` deletes on read, so a replayed callback finds
  nothing.
- 15-minute TTL, checked after deletion.
- Unknown, expired or already-used state -> logged at warn, redirected to
  /books?quickbooks=state-mismatch, which renders "That sign-in could not be
  verified ... so it was ignored. Start again from Connect."
- Fails closed: a state we cannot vouch for is precisely the one not to honour.
- The callback never echoes Intuit's query string into the redirect — only fixed
  outcome codes — so the error path is not itself an open redirect or an
  XSS sink.
- `connectedByName` is captured when Connect is clicked and carried in the
  pending-state record, so the callback never trusts a name it is handed.

## Every callback failure has a user-facing message

CALLBACK_OUTCOMES in books.tsx covers: connected, declined, state-mismatch,
invalid-callback, not-configured, exchange-failed. No silent failure.

## Caveats

- There are no automated tests for the QuickBooks module. These answers rest on
  the code and, for (a), on live behaviour — not on a suite.
- Everything here was exercised against Intuit's *sandbox*. The production
  environment is untested until production keys are issued.
- (b) and (c) are code-verified only, for the reasons given above.
