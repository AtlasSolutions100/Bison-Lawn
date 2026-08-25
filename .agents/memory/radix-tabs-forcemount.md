---
name: Radix Tabs forceMount visibility
description: Why force-mounted Radix TabsContent needs its own CSS hiding, and when to reach for it.
---

## Rule
Radix `TabsContent` unmounts inactive panels, destroying their React state. Adding `forceMount` keeps the
panel mounted **but also keeps it visible** — Radix computes `hidden={!present}` from Presence, and with
`forceMount` `present` is always true. Pair `forceMount` with an explicit `hidden` class (or equivalent
`display:none`) driven by the active tab value.

**Why:** A form panel inside a tab (e.g. a multi-step builder) silently loses in-progress input on a tab
switch. Keeping it mounted is the fix, but the naive `forceMount` alone renders two panels at once.

**How to apply:** Only force-mount the panel that holds user input; list/table panels can keep unmounting.
Any state the panel hydrates from server data must also track a "baseline" snapshot so a dirty check can
tell prefilled/hydrated values apart from admin edits — that dirty flag is what gates discard confirms.
Two baselines are usually needed: the last *saved* state (drives leave-page warnings; for an unsaved new
record it stays empty) and the last *prefill* (drives "you are about to replace this prefill" confirms, so
swapping an untouched prefill never nags). A confirm must clear everything it claims to clear — a field the
prefill effect does not reset (free-text notes) survives the discard and makes the prompt a lie.

## Guarding the surrounding navigation
Keeping state alive only covers tab switches. The remaining escape routes need explicit handling:
- Actions that remount the form (switching which record is being edited, cancel) — confirm when dirty.
- Tab close/reload — `beforeunload`.
- In-app links — wouter renders plain anchors, so a capture-phase document click listener can intercept and
  confirm.
- Browser Back/Forward and programmatic navigation — see history-navigation-guard.md for the guard-entry
  technique that makes those cancellable too.
