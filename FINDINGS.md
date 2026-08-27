# Findings log

Append one line per behaviour-changing turn. Assume the next session has no context.

## 2026-08-26 — de-Replit: repo now boots on a plain machine

**Changed**
- `pnpm-workspace.yaml`: removed Replit's `overrides:` block (~75 entries pinning every
  native binary to linux-x64 by setting the others to `'-'`); set `allowBuilds` for
  `esbuild` and `@clerk/shared` to `true`.
- `pnpm-lock.yaml`: regenerated. The old one recorded `esbuild → @esbuild/linux-x64` only.
- `lib/db/drizzle.config.ts`: schema path now normalised to forward slashes.
- `artifacts/api-server/package.json`: dropped POSIX-only `export NODE_ENV=…` /
  `NODE_ENV=test …` prefixes from `dev` and the eight `test:*` scripts. Every test file
  already sets `process.env.NODE_ENV` itself, and `dev.mjs` sets it for the server.
- Added `dev.mjs`, `.env.example`; `.env` added to `.gitignore`.

**Fixed**
- `pnpm install` failed on Windows/macOS with "The package @esbuild/win32-x64 could not be found".
- `drizzle-kit push` failed with "No schema files found" (glob can't read backslashes).
- `pnpm run dev` / `pnpm test` failed with "'export' is not recognized" outside a POSIX shell.
- No same-origin `/api` route off Replit — `dev.mjs` sets `E2E_API_URL`, which is the only
  condition under which `vite.config.ts` mounts its `/api` proxy.

**Still open**
- Gmail sending goes through `@replit/connectors-sdk` (`artifacts/api-server/src/lib/gmail.ts`).
  Estimates, spring letters and weather messages cannot be delivered off Replit. No replacement yet.
- Public estimate links and CORS still key off `REPLIT_DEV_DOMAIN` / `REPLIT_DOMAINS`
  (`routes/estimates.ts:95`, `app.ts:49-53`). `APP_PUBLIC_URL` exists but is not the fallback everywhere.
- Nothing behind Clerk sign-in has been opened in a browser locally.
- 22 `subrepl-*` git remotes and branches plus a `gitsafe-backup` remote are still in the repo.

## 2026-08-26 — Phase 1: off-platform, end to end

**Changed**
- `lib/gmail.ts` now calls the Gmail REST API directly with a token from
  `lib/googleOAuth.ts` (our own `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`).
  `@replit/connectors-sdk` dropped from both package.jsons. The `GmailProxy`
  seam is unchanged, so all delivery tests still pass untouched.
- `scripts/google-oauth-setup.mjs`: one-time loopback OAuth flow that prints a
  refresh token. Scope is `gmail.send` only.
- `app.ts`: CORS allowlist is `APP_PUBLIC_URL` + optional `APP_EXTRA_ORIGINS`
  instead of `REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN`. In production the process
  now also serves `artifacts/bison-crm/dist/public` with an index.html fallback
  for any non-`/api` GET.
- `routes/estimates.ts`: dev fallback origin no longer reads `REPLIT_DEV_DOMAIN`.
- `vite.config.ts`: Replit plugins removed; the `/api` proxy now keys off
  `API_URL` (set by `dev.mjs`) as well as `E2E_API_URL` (set by the e2e harness).
- `build.mjs` added. Deleted `.replit`, `.replitignore`, `.agents/`, `.config/`.
  `replit.md` → `ARCHITECTURE.md`, de-Replit'd. 22 dead git remotes removed.
- `lib/e2e/src/harness.ts`: browser resolves via `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
  or Playwright's own install, not the Replit-only variable.

**Fixed**
- Nothing could send email off Replit.
- Production had no single-origin serving, which Clerk's cookie session requires.
- Windows builds baked a mangled `BASE_PATH` (`/Program Files/Git/`) into every
  asset URL, producing a blank page. `build.mjs` keeps `BASE_PATH` out of shells.

**Still open**
- **The Gmail path has never run against live Google.** No OAuth client exists
  yet. Covered only by tests that inject their own proxy.
- **Proposal: redirect signed-out deep links to sign-in.** `/dispatch` and every
  protected route render an empty page when signed out (`App.tsx` wraps them in
  `<Show when="signed-in">`, which renders null). This is existing intended
  behaviour — see `.agents/memory/blank-page-diagnosis.md` — not a regression. It
  is worth revisiting on a custom domain, where people bookmark deep pages and a
  blank page reads as an outage.
- Nothing behind Clerk sign-in has been opened in a browser.
- 23 `subrepl-*` branches carry commits not in `main`; kept, not deleted.
- `artifacts/mockup-sandbox` is a Replit-agent shadcn playground nothing imports.
  Proposed for deletion, not deleted.
- Nothing pushed to `origin` yet.

## 2026-08-26 — deployable: Docker stack + admin-access config

**Changed**
- `Dockerfile` (multi-stage, node:24-slim), `.dockerignore`, `docker-compose.yml`
  (app + postgres, app bound to 127.0.0.1), `.env.deploy.example`,
  `deploy/Caddyfile.example`, `DEPLOY.md`.
- `VITE_CLERK_PUBLISHABLE_KEY` / `VITE_CLERK_PROXY_URL` are Docker **build args**,
  not runtime env: Vite inlines `import.meta.env.VITE_*` into the bundle. The
  build fails fast if the publishable key is missing. Compose must therefore be
  run as `docker compose --env-file .env.deploy up -d --build`.

**Verified**
- Image builds and runs; container reports healthy; `/`, `/dispatch`,
  `/api/healthz` all correct from inside the container.
- Admin access proven: `koby@radiantaisoftware.com` in `APP_SECONDARY_OWNER_EMAIL`
  resolves to `role=admin, role_source=owner` in the DB and shows ADMIN in the
  Team UI. See `verify/2026-08-26/container-admin-crawl/`.
- Read-only crawl of dashboard, clients, estimates, builder, team.

**Still open**
- **Sender identity.** No `From:` header is set anywhere; Gmail stamps the
  authenticated account. Whoever runs `scripts/google-oauth-setup.mjs` becomes the
  visible sender on every customer email. Adam must consent from the Bison
  account before this is customer-ready.
- **Live Gmail send still untested.**
- Image is ~1.6 GB (whole installed tree ships; pdfkit is externalised from the
  bundle and drizzle-kit is needed for schema pushes). Slimmable.
- `drizzle-kit push` is the only schema mechanism; there are no migration files.
  DEPLOY.md deliberately keeps it a manual step.

## 2026-08-26 — target environment identified

Deploy target is a VPS already running `takeoff-caddy-1` (caddy:2-alpine, owns
80/443) in front of `takeoff-app-1` (8100/tcp, unpublished). Caddy is
containerised, so this stack uses `docker-compose.proxy.yml`: no host port, join
Caddy's network, and Caddy reaches it as `bisonlawn-app:8080`. The existing site
is not touched.

Domain is `bisonlawncare.workoptional.tech` (was written as `bison.` — corrected).
Container name standardised to `bisonlawn-app`.

Clerk stays on the existing development keys for now — they work on a custom
domain, with Clerk's dev banner and usage limits. No key rotation needed.

## 2026-08-26 — deploy alongside a live production stack

The target host also runs `takeoff` (caddy:2-alpine on 80/443 + an app on 8100),
serving `workoptional.studio` to ~20 clients. That constrains the deploy.

**Changed**
- `docker-compose.proxy.yml` now expects a **dedicated** shared network
  (`web-proxy`), not the proxy's own project network. Attaching this stack to
  `takeoff_default` would have made `docker compose down` in the takeoff project
  fail with "network in use" — coupling an unrelated live stack to ours.
- `deploy/RUNBOOK-srv1928610.md`: host-specific procedure with backup,
  validate-before-reload, per-step checks of the live site, and a full undo.

**Verified**
- Both compose configurations resolve: overlay yields `bisonlawn-app` on
  `default` + external `web-proxy`, zero published ports; base file alone keeps
  the `127.0.0.1` binding.

**Notes for whoever runs it**
- The takeoff Caddyfile is a host bind mount (`/home/deploy/takeoff/Caddyfile`,
  read-only into the container), so it can be backed up and restored on the host.
- `caddy reload` is atomic: an invalid config fails to load and the previous one
  keeps serving. Never `restart`.
- `docker network connect` attaches a running container with no restart.
- Remaining fragility: recreating the takeoff stack can drop the manually added
  network from its Caddy container. That 502s bisonlawn, never takeoff.

## 2026-08-26 — takeoff Caddyfile inspected; vhost tailored

The live Caddyfile at `/home/deploy/takeoff/Caddyfile` has one site block
addressed by the env placeholder `{$SITE_HOST}`, no global options block, and
proxies to the compose alias `app:8100`.

Consequences folded into the runbook:
- A trailing site block is the correct place to append; there is no global block
  to sit above.
- `{$SITE_HOST}` must resolve inside `docker exec` for `caddy validate` to pass.
  It should (exec inherits container env) but the runbook verifies it, because a
  failure there produces an error pointing at *their* block, not ours.
- Our block matches their `encode zstd gzip` order and uses `format console`,
  not json: both write to the same `docker logs takeoff-caddy-1` stream.
- No transport timeouts copied over — theirs exist for a measured 30m report
  render. Nothing here is slow.
- 25MB body cap, not their 512MB: no large-upload route exists in this app.

**Unresolved fragility:** the edit is an uncommitted local change inside
takeoff's git working tree. A `git pull`/`checkout` there reverts it, and
bisonlawn breaks on the next Caddy reload. takeoff is unaffected. Avoiding this
would need the Caddy container recreated to mount an importable `conf.d`, which
is not acceptable while it serves 20 clients.

## 2026-08-26 — takeoff side wired; two corrections taken

The takeoff owner corrected two assumptions in the earlier runbook, both right:

1. `~/takeoff` is **not** a git repo — the `git status Caddyfile` check would have
   returned a false all-clear.
2. Every takeoff deploy `scp`s `Caddyfile` from its own repo, so an appended
   vhost was **guaranteed** to be overwritten, not merely at risk. The earlier
   conclusion that "editing the file is the lower-risk option" was wrong.

Their fix, now live on the box: `web-proxy` declared as an external network on
the Caddy service in takeoff's compose, and `import /etc/caddy/conf.d/*.caddy`
backed by `~/takeoff/caddy-sites` (mounted read-only into the container,
excluded from the deploy). Both fragilities are gone — nothing survives only as
an untracked manual change.

Runbook rewritten to the drop-in model. No longer touches their Caddyfile.

**Contributed back:** `deploy/CADDY-IMPORT-FINDINGS.md`. Both sides measured that
an empty/absent `conf.d` is valid. Two cases only measured here:
- an invalid file makes `caddy reload` fail atomically (old config keeps
  serving — safe), but
- it makes `caddy run` **refuse to start**, so a bad file left in place takes
  takeoff down at the next unrelated restart, with no visible link to the change.

Hence the mandatory `|| rm` after validate, and the suggestion that the takeoff
deploy gate restarts on `caddy validate`.

**Settled:** hostname is `bisonlawncare.workoptional.tech`; DNS is live and
resolves to 31.220.50.13 (verified from this machine).

**Process note:** heredocs in this session were silently collapsing backslashes,
which put a literal two-character `backslash-n` into a runbook command instead
of a line continuation. Bash would have passed `n` as an argument to
`caddy validate`, failing it, which would then have fired the `|| rm` and
deleted the vhost file. Every fenced bash block in the deploy docs is now
syntax-checked with `bash -n`: 12 blocks in the runbook, 12 in DEPLOY.md, 0
errors. Worth re-running that check after any edit to those files.

## 2026-08-26 — SESSION_SECRET is dead config

`SESSION_SECRET` is set in the Replit environment and appears in the handover
notes, but **nothing in this codebase reads it** (grep across artifacts, lib,
scripts: zero hits). Auth is entirely Clerk, which manages its own sessions via
cookies; there is no local session store. Removed from `.env.example` and
`.env.deploy.example`, where it had been carried over unexamined.

Consequence: the value in the handover notes does not need to be transferred,
protected, or rotated for this app.

## 2026-08-27 — live Gmail send proven; two bugs fixed

**Live Gmail delivery works.** Sent through the app's real path
(`lib/clientEmail` -> `lib/gmail` -> `lib/googleOAuth` -> Gmail REST API), not a
hand-rolled request. Gmail message id `1a04153e858bbc71`. This closes the
largest untested surface of the Replit migration.

Getting there surfaced two real bugs:

1. **`scripts/google-oauth-setup.mjs` opened a broken URL on Windows.** It used
   `cmd /c start`, and cmd.exe treats `&` as a command separator — so the browser
   received only the URL up to the first `&`. That includes `client_id` but drops
   `response_type`, and Google answers "Required parameter is missing:
   response_type", which reads like a malformed request rather than a truncated
   URL. Now uses `rundll32 url.dll,FileProtocolHandler`, which takes the URL as
   one unparsed argument.

2. **The Gmail API was not enabled on the Google Cloud project.** The OAuth
   exchange succeeded and the failure only appeared at the API call, as a 403
   naming the project. Worth knowing that a valid token proves nothing about
   whether the API is on.

**Also corrected:** the runbook assumed the `import` line was at the tail of the
takeoff Caddyfile. It is at **line 11, top level, above the site block** — which
is correct placement, but `tail -3` would not have shown it and the check would
have looked like a failure. Now `grep -n import`.

**Paths:** the SSH key authorises `root`, not `deploy`, so `~` is `/root` while
takeoff lives at `/home/deploy/takeoff`. All runbook paths made absolute.

## 2026-08-27 — LIVE at https://bisonlawncare.workoptional.tech

Deployed to srv1928610 alongside the takeoff stack. Full record in
`verify/2026-08-27/production-deploy/`.

takeoff measured unaffected at every step: `takeoff-app-1` untouched for 27h
with `restarts=0`, its Caddyfile mtime unchanged from when the takeoff side
wrote it, and `workoptional.studio` returning 200 at every checkpoint including
three consecutive checks in the seconds after the Caddy reload. Caddy was
reloaded, never restarted.

**Bug found and fixed: URL-unsafe Postgres password.** Generated with
`openssl rand -base64`, which emits `/`. That broke `DATABASE_URL` parsing —
`postgres://bison:/h5e...@db:5432/x` resolves the host as `bison` — and every
query failed with `getaddrinfo EAI_AGAIN bison`. **The container reported
`healthy` the whole time**, because `/api/healthz` does not touch the database.
A green healthcheck on this app does not mean the database is reachable. Fixed
with `openssl rand -hex 32`; DEPLOY.md and `.env.deploy.example` now say why.

**Live email confirmed by delivered headers:** `From: Koby Stull
<koby@radiantaisoftware.com>`, `mailed-by: radiantaisoftware.com`. Confirms that
the consenting account becomes the visible sender, since no `From:` header is
set anywhere in the code.

**Open / next**
- Nothing behind sign-in verified on the live hostname (needs a human sign-in).
- OAuth consent screen is still in "Testing": refresh tokens expire after 7 days.
  Publish it or email dies silently around 2026-09-03.
- Sender is currently Koby, not the Bison account. Re-run the setup script signed
  in as Bison when ready for real customers.
- GitHub deploy key id 161442430 added to the repo (read-only, this host).
