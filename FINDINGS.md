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

Domain is `bisonlawn.workoptional.tech` (was written as `bison.` — corrected).
Container name standardised to `bisonlawn-app`.

Clerk stays on the existing development keys for now — they work on a custom
domain, with Clerk's dev banner and usage limits. No key rotation needed.
