---
name: Unsaved-work navigation guard (history entry technique)
description: How browser Back and programmatic navigation are made cancellable in the wouter SPA, and the browser quirks that break naive attempts.
---

## Rule
Back/Forward and programmatic navigation *can* be guarded, despite the History API having no cancellable
hook: while the guard is armed, push a duplicate of the current URL as a "guard entry" (marked via
`history.state`). Back then pops that entry instead of leaving the page — same URL, so the router sees no
path change and no component unmounts — and the confirm happens with all state still alive. Cancel = push
the duplicate again; accept = disarm and traverse back once more.

**Why:** A form that keeps state across tab switches still loses everything to a reflexive Back press, and
`beforeunload` does not fire for same-document history traversal.

**How to apply:**
- Every guard-entry write needs a matching reclaim, or the extra entries pile up and Back hits dead steps
  that repeat the same URL. A router **push** while guarded stacks on top of the guard entry — both the
  confirmed and the cancelled branch have to give one entry back (traverse, then rewrite). A **replace**
  overwrites the guard entry instead, so it needs no reclaim: distinguish them by the history event's type.
  A stale *forward* entry left after such a traversal is harmless — the next push truncates it.
- Remove the guard entry the moment the guard disarms (work saved, discarded, page unmounted), or the user
  gets a dead Back press later. Detect it with the marker on `history.state`, never with a local boolean —
  a router push can bury the entry, and popping blindly then drags the user backwards.
- When the admin confirms leaving via an in-app link, spend the guard entry on the destination with
  `replaceState` instead of letting the router push on top of it; that keeps the stack the same shape as an
  unguarded navigation.
- Keep the "self-inflicted history change" flags (a pop the guard asked for, a write the guard made) in
  refs that outlive the effect, so a guard re-armed mid-flight can consume them and self-heal.

## Browser quirks that cost the most time
- A `history.back()` issued **synchronously inside a `popstate` handler** can be dropped: the browser is
  still settling a traversal. Defer it (`setTimeout(..., 0)`). Symptom: accepting the confirm appears to do
  nothing, and the page stays put with listeners half torn down.
- wouter v3 monkey-patches `pushState`/`replaceState` and dispatches same-named window events. That is both
  the hook for detecting programmatic navigation and the reason a raw `history.replaceState` is enough to
  drive an SPA navigation. Undo an unwanted programmatic push with a synchronous `replaceState` inside that
  event — the router re-reads the URL at render time and never renders the destination.
