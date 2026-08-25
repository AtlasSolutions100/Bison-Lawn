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
- Tester browser timezone may differ from server local date: date-scoped seed data (e.g. jobs "today") may be invisible; seed for the tester's UTC date or instruct date navigation.

## Runner note
Node's `--experimental-strip-types --test` cannot resolve directory imports in workspace source packages (e.g. `@workspace/db`'s `./schema`); run tests with `tsx --test` instead.
