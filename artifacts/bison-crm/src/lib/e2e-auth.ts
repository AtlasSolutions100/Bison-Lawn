/**
 * Dev-only hook that lets the browser end-to-end suite drive the app without a
 * Clerk session. It is enabled only when BOTH:
 *   - the app is served by the Vite dev server (`import.meta.env.DEV`), and
 *   - `VITE_E2E_AUTH_BYPASS=1` is set for that dev server.
 *
 * Production builds fold `import.meta.env.DEV` to `false`, so the whole branch
 * is dead code there. On its own it grants no access either: it only skips the
 * client-side Clerk gate, and every API call still fails unless the API process
 * is running with `NODE_ENV=test` and the caller presents the per-process
 * `TEST_AUTH_TOKEN` (see the API's requireAuth middleware).
 */
export const e2eAuthBypass =
  import.meta.env.DEV && import.meta.env.VITE_E2E_AUTH_BYPASS === '1';
