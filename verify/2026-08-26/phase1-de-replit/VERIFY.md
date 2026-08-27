# Verification — Phase 1: cut the Replit umbilical

Date: 2026-08-26

## What was tested

The four platform dependencies that would have stopped this app running on our
own VPS: outbound email, the public origin, single-origin serving, and the
Replit-only build/config files.

## Results

| Change | How it was verified | Result |
|---|---|---|
| Gmail via our own Google OAuth client, replacing `@replit/connectors-sdk` | Full API suite; the delivery suites inject their own `GmailProxy` and exercise the RFC 2822 build, PDF attachment, and provider-error paths | PASS — 94/94, 0 fail. **Not** verified against live Gmail: no OAuth client exists yet (see Open). |
| `APP_PUBLIC_URL` replaces `REPLIT_DEV_DOMAIN` for estimate response links | `estimateDelivery.test.ts` — "production response links require a canonical HTTPS app origin" | PASS |
| `APP_PUBLIC_URL` / `APP_EXTRA_ORIGINS` replace `REPLIT_DOMAINS` for CORS | Typecheck + boot; unparseable entries warn instead of widening CORS or crashing | PASS on boot; a cross-origin browser request was not exercised |
| API serves the built SPA in production | `node build.mjs`, then the production bundle on :8080, driven in Chrome | PASS — see below |
| Replit vite plugins, `.replit`, `.replitignore`, `.agents/`, `.config/`, connectors SDK, catalog entries removed | `pnpm install` (−5 packages), `pnpm run typecheck` | PASS — 4 packages, 0 errors |
| e2e harness no longer requires `REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Code reads `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, else Playwright's own install | Compiles; **the browser e2e suite was not run** — no Chromium installed for Playwright here |
| 22 dead `subrepl-*` remotes + `gitsafe-backup` removed | `git remote -v` → only `origin` | PASS. Branches kept: 23 of them carry commits not in `main`, so nothing was deleted. |

## Production single-origin, measured

Served by the API bundle at `NODE_ENV=production PORT=8080`:

| Request | Expected | Actual |
|---|---|---|
| `GET /` | SPA html | 200, `text/html` |
| `GET /dispatch` (hard load of a client-side route) | SPA html, not 404 | 200 |
| `GET /assets/index-*.js` | 200 | 200 |
| `GET /api/healthz` | `{"status":"ok"}` | `{"status":"ok"}` |
| `GET /api/nope` | not swallowed into the SPA fallback | 401 from the auth gate |

Browser: `02-production-single-origin-8080-root.annotated.jpg`. Console carried
exactly one message — Clerk's development-keys warning. Crawled the full view:
header, hero, and all four feature cards render, matching the dev-server render
in `../local-bootstrap/01-landing-page-localhost-5173.jpg`.

## Findings

1. **Mangled `BASE_PATH` (found and fixed).**
   `01-DEFECT-mangled-base-path-blank-page.annotated.jpg`. Building with
   `BASE_PATH=/` from Git Bash produced `base: "/Program Files/Git/"` — MSYS
   rewrites a lone `/` — and every asset URL in `index.html` was wrong, so the
   page rendered blank. Fixed by adding `build.mjs`, which sets `BASE_PATH` from
   Node so no shell ever touches it. Re-verified: asset hrefs are now `/assets/…`
   and the page renders.

2. **Signed-out deep link renders a blank page — known behaviour, not a new defect.**
   `03-signed-out-deep-route-blank.annotated.jpg`. `/dispatch` loaded while signed
   out shows nothing: no sign-in prompt, no redirect. `App.tsx` wraps protected
   routes in `<Show when="signed-in">`, which renders null.

   This is already documented in the repo — `.agents/memory/blank-page-diagnosis.md`
   describes it as the first thing to rule out when a page looks broken. So it is
   a deliberate existing behaviour, and my serving change did not introduce it.

   It is still worth changing: on Replit people entered through one app link, but
   on a custom domain they will bookmark and share deep pages, and a blank page is
   indistinguishable from an outage. Proposed (not done): redirect to sign-in.
   Logged in `FINDINGS.md` as a proposal, not a bug.

## Not verified

- **Live Gmail send.** The code path is new and only covered by injected-proxy
  tests. Nothing has been sent through a real Google OAuth client, because none
  exists yet. This is the single largest untested surface in Phase 1.
- **Anything behind Clerk sign-in**, in either dev or production mode. Unchanged
  from the previous verification: reaching it requires an account.
- **The browser e2e suite** (`lib/e2e`).

## Source of truth for counts

- 94 tests: sum of the eight per-suite `ℹ pass` lines (6+5+4+24+24+10+9+12), each
  with `ℹ fail 0`. Same 94 as before Phase 1 — no tests were added for the Gmail
  swap, which is why "live send" is called out as untested rather than covered.
- 23 branches with unmerged commits: `git rev-list --count main..<branch>` per
  branch, non-zero for 23 of the 24 listed (`subrepl-l6siobxh` was 0).
