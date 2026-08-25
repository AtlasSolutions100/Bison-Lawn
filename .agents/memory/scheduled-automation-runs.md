---
name: Scheduled automation runs
description: Constraints for any recurring background job in this project — how a run is claimed, retried, and made visible.
---

## Rule
A recurring job must claim its calendar day in the database before running, and treat an unfinished claim as expired only after a lease window.

**Why:** This project deploys to autoscale, so instances start, stop, and overlap. Without a persisted claim, every restart after the run hour re-runs the job; with a claim but no lease, one crash blocks the job for the rest of the day. A blanket "clear all claims on startup" is wrong for the same reason — a sibling instance may still be running.

**How to apply:** Failures release the day so a retry can take it, and retries are capped per day. Compare wall-clock time in the business timezone on a short tick instead of sleeping to an exact instant, so DST shifts and restarts don't skip the window.

## Overlap safety
The run-level claim is not sufficient on its own: an expired lease can overlap a worker that resumes late. Each effect the run creates must have its own database-level idempotency key, with conflict-safe inserts; do not rely on a prior read to prevent duplicates.

**Why:** Two evaluators can both read an empty queue before either writes. A partial uniqueness rule scoped to the actionable/pending state preserves the ability to make a new suggestion after the older one is reviewed, while preventing duplicate concurrent review items.

**How to apply:** Renew a healthy run's lease while it works, put timeouts around external calls, and still protect the final write with a unique constraint plus `ON CONFLICT DO NOTHING`. Tests should force two evaluators through the same blocked external-call gate and assert one effect survives.

## Autoscale caveat
An in-process timer alone is not enough: no instance may be awake at the scheduled hour. Back it with a catch-up evaluated on incoming traffic and a one-shot entry point a platform scheduled job can invoke. Extra triggers are safe precisely because they all go through the same claim.

## Observability expectation
Persist a record per run — automatic and manual — and surface the latest of each to admins. Users cannot see log lines, so unattended automation that leaves no visible trace reads as broken.
