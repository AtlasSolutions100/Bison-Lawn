# @workspace/e2e

Browser end-to-end tests for the Bison Lawn Care CRM.

```bash
pnpm --filter @workspace/e2e run test
```

The suite boots everything it needs:

- the Express API in-process with `NODE_ENV=test` and a random `TEST_AUTH_TOKEN`,
  so browser requests authenticate through the existing test-only header bypass
  in `requireAuth` (no Clerk session, no live Clerk needed);
- a Vite dev server for the web app with `VITE_E2E_AUTH_BYPASS=1` (skips only the
  client-side Clerk gate — dev builds only) and `/api` proxied to that API;
- headless Chromium: Playwright's own install (`pnpm exec playwright install chromium`),
  or an explicit build via `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

Open-Meteo is stubbed in-process (`setStubForecast`), so weather tests are
deterministic and make no network calls.

Covered flows:

1. A contractor opens *My Jobs*, adds a field note (typed fallback of the
   dictation dialog) and the office sees the generated ticket.
2. An admin creates a weather rule, runs a weather check, approves the
   suggestion and the job is rescheduled.

The tests run against the development database and sync it with the Drizzle
schema first (`pnpm --filter db push`), so newly merged columns can't leave the
API returning 500s mid-run. They seed their own client,
users and jobs (prefixed `E2E Browser Client` / `__e2e_rule_`) and purge those
rows both before and after the run, so an interrupted run cannot poison the next
one.
