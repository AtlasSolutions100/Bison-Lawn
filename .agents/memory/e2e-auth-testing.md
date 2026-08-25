---
name: E2E auth testing pattern
description: How to run authenticated integration/browser tests against the Clerk-protected API safely.
---

## Rule
Integration tests authenticate via a test-only bypass in the API auth middleware that requires BOTH `NODE_ENV=test` AND a per-process random `TEST_AUTH_TOKEN` sent in a header alongside the user id. Never gate a bypass on `NODE_ENV` alone — a misconfigured deploy could open it.

**Why:** Code review flagged that a header-only bypass gated on `NODE_ENV=test` becomes a full auth bypass if a process is ever launched with that env value.

**How to apply:** Test runners generate a random token, export it, and send it per request; the middleware compares exactly and fails closed otherwise.

## Browser testing with Clerk
- The testing subagent signs users in programmatically (see testing skill's clerk-auth.md); never script Clerk's UI.
- New sign-ins provision as contractor; promote to admin by updating the users row (role=admin, role_source=owner_assigned) between test phases — testers share the dev DB.
- This applies to ANY manual promotion, not just tests: auth re-resolves role on every request, so setting `role=admin` without `role_source=owner_assigned` silently reverts to contractor on the next page load. Only owner-secret emails keep admin without that marker. The Team page role dropdown does this correctly — prefer it over raw SQL.
- Tester browser timezone may differ from server local date: date-scoped seed data (e.g. jobs "today") may be invisible; seed for the tester's UTC date or instruct date navigation.

## Self-hosted browser suite (committed Playwright tests)
- The API header bypass alone cannot render the SPA: the client sits behind a Clerk signed-in gate, so a browser suite also needs a dev-only client flag that skips *only* that gate, gated on the bundler's dev flag so production folds it to dead code. The API still enforces its own token.
- Never attach the test capability header as a browser-context default — it then goes to Clerk, fonts and every third-party origin, and the extra header turns cross-origin script loads into failing preflights. Route it onto same-origin API requests only.
- Chromium is already installed for the workspace; point `playwright-core` at it rather than downloading browsers, and keep the client library's version matched to that build.
- Running the API in the test process lets external services be stubbed by patching `globalThis.fetch`, so no production seam is needed for determinism.
- The suite shares the dev database with everything else, which has two consequences: purge seed rows **before** the run as well as after (an interrupted run leaves rows that silently match the next run's locators), and sync the schema first — concurrently merged columns otherwise surface as opaque API 500s mid-run.
- Scope UI locators by a per-run identity (a seeded row id), never by a name that a leftover row could also carry.

## Runner note
Node's `--experimental-strip-types --test` cannot resolve directory imports in workspace source packages (e.g. `@workspace/db`'s `./schema`); run tests with `tsx --test` instead.
