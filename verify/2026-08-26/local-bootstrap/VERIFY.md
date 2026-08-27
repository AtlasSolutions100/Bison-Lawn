# Verification — local bootstrap of Bison Lawn Care CRM off Replit

Date: 2026-08-26
Machine: Windows 11, Node v26.7.0, pnpm 11.22.0, Docker 29.7.2
Database: postgres:16-alpine container `agency-pg`, db `bisonlawn` (app) / `bisonlawn_test` (tests)

## What was tested

The repo as downloaded from Replit, started on a local Windows machine with no
Replit services available, driven from a real browser.

## Steps and measured results

| Stage | Command | Result |
|---|---|---|
| Install | `pnpm install` | PASS after removing Replit's linux-x64-only `overrides:` block from `pnpm-workspace.yaml` and regenerating `pnpm-lock.yaml`. Before that: `@esbuild/win32-x64 could not be found`. |
| Typecheck | `pnpm run typecheck` | PASS — 4 packages, 0 errors |
| Schema push | `pnpm --filter @workspace/db run push` | PASS after fixing Windows backslash path in `lib/db/drizzle.config.ts`. 24 tables created (verified with `\dt`). |
| Seed | `pnpm dlx tsx artifacts/api-server/src/seed.ts` | PASS — "Seeded services, package, estimate fields, and clients" |
| API build | `pnpm --filter @workspace/api-server run build` | PASS — dist/index.mjs 3.0mb |
| API tests | `pnpm --filter @workspace/api-server run test` | PASS — 94/94 tests across 8 suites, 0 fail (after removing POSIX-only `NODE_ENV=test` script prefixes) |
| API runtime | `node dev.mjs` | PASS — "Server listening" port 3001, weather scheduler armed for 05:00 America/Chicago |
| Web runtime | `node dev.mjs` | PASS — Vite v7.3.6 on 5173 |
| Same-origin proxy | `curl http://127.0.0.1:5173/api/healthz` | PASS — `{"status":"ok"}` served through the Vite `/api` proxy, so cookie auth has one origin as it did on Replit |
| Auth gate (API) | `curl http://127.0.0.1:3001/api/clients` | PASS — 401 `x-clerk-auth-status: signed-out` (Clerk middleware live) |
| Browser render | Chrome → http://localhost:5173/ | PASS — see `01-landing-page-localhost-5173.jpg`. Clerk JS loaded from the client's dev instance (`aware-walrus-1127.clerk.accounts.dev`), only console output is Clerk's development-keys warning. No page errors. |

## What was NOT verified

**Everything behind sign-in.** The admin dashboard, clients, estimates builder,
dispatch board, invoices, contractor views and the mobile job board have not been
opened in a browser, because reaching them requires creating or signing into a
Clerk account and I do not create accounts. Blocked on a human signing in once at
http://localhost:5173/ with an account whose verified email matches
`APP_OWNER_EMAIL` in `.env`.

The 94 passing API tests exercise those routes server-side, but per the working
contract that is an input to the diagnosis, not proof the UI works.

## Source of truth for counts

- 24 tables: expected = 24 tables declared in `lib/db/src/schema/crm.ts`; actual = 24 tables
  in `pg_tables` for schema `public` in database `bisonlawn`. Compared with `comm` on the two
  sorted lists: zero declared-but-missing, zero created-but-undeclared. (An earlier count of
  "25" came from `grep -c pgTable`, which also matches the import line — that number was wrong.)
- 94 tests: sum of the eight per-suite `ℹ pass` lines (6+5+4+24+24+10+9+12), all with `ℹ fail 0`.
