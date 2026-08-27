# QuickBooks: sandbox -> production switchover

Date: 2026-08-27
Host: https://bisonlawncare.workoptional.tech

Production Intuit keys arrived. This is the switchover, done before Adam
connects his real company file.

## What was done, in this order

Order was chosen deliberately, not incidentally.

1. **Disconnected the sandbox grant first, while the development keys were still
   on the server.** `revokeAtIntuit` signs the revoke with whatever client
   credentials the server currently holds. Swapping keys first would have meant
   revoking a sandbox token with production credentials, which Intuit rejects —
   the grant is dropped locally either way, but it would have stayed alive on
   Intuit's side with nothing left pointing at it.
   Result: Intuit returned `status:200` to the revoke, and the local table went
   to 0 rows.

2. **Installed the production keys** into `/root/bisonlawn/.env.deploy` and set
   `INTUIT_ENVIRONMENT=production`. Values were piped over ssh stdin rather than
   interpolated into a command line, so they never appeared in a shell history,
   a process list, or this session's tool output. Previous file backed up to
   `.env.deploy.bak-1787814550`.
   `INTUIT_CLIENT_ID` prefix moved `AByJXB...` -> `ABpMCC...`.

3. **Recreated the app container.** `docker compose restart` does not re-read
   `env_file`; only `up -d` recreates with new values. Used both compose files
   (`docker-compose.yml` + `docker-compose.proxy.yml`) so the proxy network
   config was not dropped. Verified inside the container:
   `INTUIT_ENVIRONMENT=production`, client id prefix `ABpMCC`.
   takeoff was not touched — `takeoff-app-1` and `takeoff-caddy-1` uptimes were
   continuous across the whole operation.

## Verified

- `/api/quickbooks/status` -> 200 in 287ms; Intuit discovery call succeeded
  against production (`"operation":"discovery","status":200,
  "environment":"production"`).
- /books renders a clean **Connect QuickBooks** card: no sandbox banner, no red
  "these are not your real books" warning, no stale company. This is exactly what
  Adam will see. (screenshot 01)
- The sandbox banner correctly disappeared. Worth stating why it is safe: the
  status endpoint reports `connection?.environment ?? intuitEnvironment()`, so
  the banner follows **the grant**, not the server config. A leftover sandbox row
  would have kept its banner even with the server set to production. Sandbox
  figures cannot render as real books.

## Blocked: redirect URI not registered on the production key set

Clicking Connect bounces to `appcenter.intuit.com/app/connect/oauth2/error`:

> The redirect_uri query parameter value is invalid. Make sure it is listed in
> the Redirect URIs section on your app's keys tab and matches it exactly.

(screenshot 02)

Cause: Intuit keeps **separate** redirect-URI lists for Development and
Production keys. The sandbox list was configured weeks ago; the production list
is empty. Nothing in this codebase can fix that — it is a change on the Intuit
developer dashboard.

Required value, exact, no trailing slash:

    https://bisonlawncare.workoptional.tech/api/quickbooks/callback

## Also found: the app is still named "Test App"

Intuit's error page reads "Sorry, but **Test App** didn't connect". That name is
what Adam will see on the consent screen when he is asked to hand over access to
his real books — "Test App wants to access your QuickBooks data". It should be
renamed on the dashboard before he is sent there. Cosmetic to us, not to the
person being asked to approve it.

## Still unverified

The full production path — authorize, token exchange, CompanyInfo, reports —
cannot be exercised until the redirect URI is registered, and then only against a
real company file. Everything verified to date was against the sandbox.
