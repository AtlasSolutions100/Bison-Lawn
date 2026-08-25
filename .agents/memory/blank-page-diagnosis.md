---
name: Diagnosing a blank page in this app
description: Two non-bug causes of a completely empty admin page — a signed-out Clerk gate and a stale Vite module graph — to rule out before hunting for a crash.
---

A completely blank page (`document.readyState === "complete"`, empty body, only the
toaster/notifications region in the DOM, **no error in the browser console**) is
usually not a crash. A React render that throws logs an error; an empty body with a
silent console does not. Rule these two out first.

**1. It is the signed-out state.** Admin routes are wrapped in Clerk's `SignedIn`,
which renders literally nothing when there is no session — indistinguishable from a
broken page at a glance. Any screenshot tool that is not authenticated will always see
this. When a browser test reports a blank admin page, first confirm the session
actually took: the test must sign in *programmatically* via a `[Clerk Auth]` step
rather than driving Clerk's sign-in UI, and a newly created user still needs promoting
in the database before admin pages render.

**2. The Vite dev server is holding a stale module graph.** If generated files were
rewritten while the dev server was running (an API-client codegen step is the usual
trigger), Vite caches the failed resolution and keeps serving a broken graph — every
page importing the generated client goes blank, including pages nobody edited. A
browser reload does *not* clear it; restarting the web workflow does.

**Why:** a whole feature round once looked broken because pages that no one had
touched were also blank. "Pages nobody edited are broken too" points at the shell or
the dev server, not at the feature code — and a passing typecheck already rules out
a type error.

**How to apply:** blank page → check whether an unedited page is also blank → restart
the web workflow → confirm the bundle serves (curl a page module, screenshot a public
route that renders signed-out) → only then look for a runtime throw.
