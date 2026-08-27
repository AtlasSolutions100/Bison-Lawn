# Verification — feature batch, live

Date: 2026-08-27
Live: https://bisonlawncare.workoptional.tech
Signed in as koby@radiantaisoftware.com (admin via APP_SECONDARY_OWNER_EMAIL)

## Gates before deploy

| Gate | Result |
|---|---|
| Full typecheck, `tsbuildinfo` deleted first | PASS, 4 packages, 0 errors |
| API test suite | PASS, 94/94 (6+5+4+24+24+10+9+12), 0 fail |
| Schema push to production | Applied |
| Re-seed production | 4 clients / 5 leads / 3 waiting / 2 open invoices ($150) / 1 ticket / 6 services |
| App errors since boot | 0 |
| `workoptional.studio` | 200 before and after |

The `tsbuildinfo` deletion is deliberate — `.agents/memory/parallel-task-rebases.md`
records that an incremental typecheck can report one error where a clean run
reports thirty.

## Features confirmed in the browser

**Scheduling rules** — `01-scheduling-rules-live.jpg`. Six rules render as
inline-editable rows above the weather panel, each with a plain-English sentence
under it ("Goes on the board from the next day onto whichever upcoming day
already has the closest stop"). Selects save on change, so it is genuinely
editable mid-demo.

**Horizontal property matrix** — `02-horizontal-matrix.jpg`. Seven property
fields render as a 4-across grid instead of a seven-row vertical stack. 2 cols
below 640px, 3 at 640-1023, 4 at 1024+.

**Property-detail pricing** — `03-zone-priced-services.jpg`. Side by side in one
screenshot: "Spring Sprinkler Turn-On — Priced from **Sprinkler Zones**
equations" and "Sprinkler Blow-Out — Priced from **Sprinkler Zones** equations",
against "Weekly Mowing — Priced from **Sqft** equations". Placeholders match.
This is the October request working.

**Feedback** — `04-feedback-board.jpg`. Submitted live from the estimate
builder; the toast confirmed, and the entry appears on the board attributed to
the right person, role, and **`on /estimates`** — the screen it was sent from,
captured without anyone typing it.

## Scheduler behaviour, measured end to end

A four-line estimate run through the real engine against the seeded catalogue:

| Line | Rule | Job created |
|---|---|---|
| Sprinkler Blow-Out | dispatch +1 | dispatched, 2026-08-28 |
| Weekly Mowing | route_fit | dispatched, 2026-08-28 |
| Fall Clean-Up | waiting_list | held, window 2026-09-01 → 2026-11-30 |
| Fertilizer Application (Acme Spray) | catch-all dispatch | **none — correctly skipped** |

3 jobs from 4 lines. See the defects section for why the fourth matters.

## Feedback notification, measured

| Check | Result |
|---|---|
| Subject line | `Problem from Koby Stull on /dispatch \| Bison Lawn Care CRM` |
| A 500 from the mail provider propagates out of `notifyFeedback`? | no — correct |
| Feedback row survives that mail failure? | yes — correct |
| Real send to `FEEDBACK_NOTIFY_EMAIL` | attempted; recipient to confirm |

## Two defects found at integration

Neither was visible to any single agent — each sat in the seam between two.

1. **Scheduling rules double-seeded.** `lib/schedulingRules.ts` seeds defaults
   lazily behind a marker row in `audit_events`; `seed-demo --reset` deletes
   `audit_events`, clearing that guard, and separately wrote the same list
   itself. A fresh seed would have produced two rules per service. Fixed to a
   single owner; verified 6 rules after a reset.

2. **Vendor work dispatched to our own crew.** Any service without its own rule
   fell through to the catch-all `dispatch +1`, so an accepted "Fertilizer
   Application" line created a crew job for work Acme Spray performs and Spray
   Runs already reconciles from the vendor invoice — a phantom stop and a second
   source of truth. Fixed in the engine, not as a default rule: it is an
   invariant of vendor work, so it must survive a vendor service added later
   that no default matches, and must beat the catch-all.

## Not verified

- The **skip-job** flow and **contractor invitations** were not exercised in the
  browser on the live host. Both are covered by the 94 tests and were verified by
  their agents (invitations end to end, including that an unverified email cannot
  redeem), but neither has been clicked through here.
- The estimate → email → accept → auto-schedule round trip against the live
  public URL. The engine is proven directly; the customer-facing link is not.
- Contractor/mobile views on the live host.
- Whether the feedback email actually landed — the send was attempted without
  error; only the recipient can confirm delivery.
