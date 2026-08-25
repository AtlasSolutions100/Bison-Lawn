---
name: Rebasing parallel task branches
description: Why a clean-looking rebase of two tasks that touched the same route file can still be broken, and how to recover.
---

# Rebasing parallel task branches onto main

When two tasks edit the same large, repetitive file (an Express route module with
many similarly-shaped handlers is the worst case), git's auto-merge can produce a
result with **no conflict markers that is still semantically wrong** — handlers
get spliced together, a block lands after `export default`, identifiers from one
handler leak into another. The rebase reports success; only the typechecker
notices.

**Why:** the three-way merge matches on textual similarity. Sibling handlers in
these files share long identical spans (lock the row, log the audit, hydrate,
return), so non-overlapping hunks get grafted into the wrong function.

**How to apply:**

- After **every** rebase round — including rounds that reported no conflict in a
  given file — run the typechecker and the affected test suite before continuing.
  A marker-free file is not a merged file.
- To recover, do not hand-repair the mangled output. Reset the file to the
  upstream version (`git checkout <upstream-branch> -- <path>`) and re-apply the
  task's change onto it. Re-applying is fast; untangling an interleaved merge is
  not, and it silently drops the other task's work.
- Re-applying is also the moment to *integrate* rather than restore: upstream may
  have changed the model the change depends on (e.g. a new claim stamp or a new
  delivery state), and the original patch will typecheck while ignoring it.
- When a later round conflicts on the task's *own* earlier revision, keep the
  already-applied side — that is the one adapted to upstream.
- **The upstream commit itself can be the corrupted one.** Resetting a file to
  upstream is not a guaranteed clean base: a merged sibling task can land a route
  module or test file that neither typechecks nor runs (whole handlers replaced by
  fragments of an unrelated feature). Verify the reset baseline before re-applying;
  if it is broken, rebuild the file as *last-good commit + the merged task's
  genuinely new blocks*, then re-apply the current change. Repairing that damage is
  in scope, because completion validation runs on the current branch.
- A multi-commit rebase re-mangles a file on *every* round, including rounds where
  that file reports no conflict at all. After the rebase reports success, diff the
  final tree against the round you actually validated and restore any file that
  silently drifted, then re-run the suite — a clean earlier round is no evidence
  about the final commit.
- Generated code (orval output and similar) is never worth hand-merging: resolve
  the source spec, regenerate, and confirm the regeneration produces no other
  diff.
- After rebasing onto a sibling task that added database columns, the dev
  database is still on the old schema. Push the schema before running tests, or
  the failures look like application bugs (`column ... does not exist`).
- Upstream itself can already be broken this way: the damage from a bad merge is
  not limited to the feature that merge was about, and it lands in test files as
  much as in source (whole test bodies spliced into unrelated tests). Judge a
  file by whether it compiles and runs, not by whether the incoming commit
  claimed to touch it.
- An incremental typecheck (`tsBuildInfoFile`) can report a single error where a
  clean run reports thirty. When a rebase produces one implausible-looking type
  error in a file, delete the build info and re-run before believing the count.
- Repair by finding the last commit where the file was actually clean, then
  re-applying each later commit's *intent* by hand — the recorded diffs are the
  thing that broke it, so replaying them reproduces the damage.
