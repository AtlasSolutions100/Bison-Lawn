# Verification — production deploy to srv1928610

Date: 2026-08-27, ~03:45–03:55 UTC
Target: `https://bisonlawncare.workoptional.tech` on a host already serving
`https://workoptional.studio` (takeoff) to ~20 clients.

## Result

Live. Let's Encrypt certificate `CN=bisonlawncare.workoptional.tech`, valid
Aug 27 → Nov 25 2026. Screenshot: `01-live-https-landing.annotated.jpg`.

## takeoff: unaffected — measured, not asserted

| Evidence | Value |
|---|---|
| `takeoff-app-1` started | `2026-08-26T00:32:10Z`, `restarts=0` — 27h before this deploy, never restarted |
| `takeoff-caddy-1` started | `2026-08-27T03:21:57Z`, `restarts=0` — the takeoff owner's own recreate, 20 min before I connected. Not restarted by me; `reload` only. |
| `/home/deploy/takeoff/Caddyfile` mtime | `03:21:06Z` — written by them, **never modified by this deploy** |
| `workoptional.studio` | 200 at every checkpoint, including 3 consecutive checks in the seconds after the Caddy reload (0.111s / 0.114s / 0.112s) |
| Compose project labels | takeoff containers = `takeoff`; new containers = `bisonlawn`. Separate project, network, and volume. |

Everything created lives in `/root/bisonlawn` plus one file in
`/home/deploy/takeoff/caddy-sites/` — the directory the takeoff side provided
for exactly this and excludes from its deploy.

## Sequence, with the gate that mattered

1. Read-only survey; `workoptional.studio` 200.
2. Clone via a repo-scoped **read-only** GitHub deploy key (`gh` key id 161442430).
3. `.env.deploy` transferred by `scp` — not a heredoc — so no shell could mangle
   the refresh token. Verified intact on arrival (103 chars).
4. `docker compose up -d --build`. takeoff checked mid-build: 200 in 0.136s,
   load 0.31 → 2.02 → back to 0.24.
5. Schema push. **24 tables**, matching the 24 declared in
   `lib/db/src/schema/crm.ts` and the 24 created locally.
6. **The gate:** `docker exec takeoff-caddy-1 wget -qO- http://bisonlawn-app:8080/api/healthz`
   returned `{"status":"ok"}` *before* any config was written. Had this failed,
   the runbook stops here rather than adding a vhost pointing at nothing.
7. Vhost written by `scp`, `chown deploy:deploy`, then `caddy validate` → Valid.
8. `caddy reload` → exit 0. takeoff 200×3 immediately after; Caddy still
   `Up 30 minutes`, i.e. reloaded, never restarted.
9. Certificate issued within ~3s.

## Endpoints, measured

| Request | Expected | Actual |
|---|---|---|
| `/api/healthz` | `{"status":"ok"}` | `{"status":"ok"}` |
| `/` | 200 HTML | 200 |
| `/dispatch` (hard load of a client-side route) | 200, not 404 | 200 |
| `/api/clients` signed out | 401 from the DB-backed auth path | 401 |

## Two real bugs found and fixed during the deploy

1. **URL-unsafe Postgres password.** I generated it with `openssl rand -base64`,
   which emits `/` and `+`. The `/` broke `DATABASE_URL` parsing:
   `postgres://bison:/h5eMX...@db:5432/...` parsed the host as `bison`, and every
   query failed with `getaddrinfo EAI_AGAIN bison`. **The container reported
   `healthy` throughout** — `/api/healthz` does not touch the database, so the
   healthcheck could not see it. Fixed with `openssl rand -hex 32`; the volume
   was destroyed and recreated (it held nothing).
2. **`scripts/google-oauth-setup.mjs` opened a truncated URL on Windows.**
   `cmd /c start` splits on `&`, so the browser got only the first parameter and
   Google reported "Required parameter is missing: response_type". Now uses
   `rundll32 url.dll,FileProtocolHandler`.

## Live email, proven

Sent through the app's real path (`lib/clientEmail` → `lib/gmail` →
`lib/googleOAuth` → Gmail REST API). Gmail message id `1a04153e858bbc71`.
Delivered headers confirmed by the recipient:

```
from:      Koby Stull <koby@radiantaisoftware.com>
mailed-by: radiantaisoftware.com
```

This confirms the predicted behaviour: no `From:` header is set anywhere, so
Gmail stamps the consenting account. Whoever runs the OAuth setup becomes the
address customers see.

## Startup errors: explained, not ignored

Three `level:50` errors appear in the app log, all within 105 ms at
`03:50:51` — the boot that happened *before* the schema push, when the startup
sweeps queried tables that did not exist yet. A deliberate restart after the
push produced **0 errors**. Not an ongoing fault, and not hidden.

## Not verified

- **Nothing behind sign-in on the live domain.** The Clerk session used earlier
  was on `localhost`; this is a different origin and needs a fresh sign-in, which
  requires a human. Admin access via `APP_SECONDARY_OWNER_EMAIL` was proven in
  the container locally (`../2026-08-26/container-admin-crawl/`) with the exact
  env now deployed, but it has not been re-confirmed on this hostname.
- The estimate → email → accept/decline round trip against the live public URL.
- Contractor/mobile views.
