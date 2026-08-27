# Route builder at real scale, and job costing

Date: 2026-08-27 · https://bisonlawncare.workoptional.tech · deployed 0b0ab43

## Route builder at 400 stops

Previously verified on 14 jobs. Adam's actual autumn case is several hundred
blow-outs at once, so 400 clients and 410 waiting jobs ($54,283, 423.7 hours)
were seeded and the builder run against them.

| run | result | time |
|---|---|---|
| preview, no cap (all 410) | 410 selected, $54,283, 423.66h | **90ms** |
| preview, 40-stop cap | 40 selected, 370 skipped, limitedBy `stops` | 74ms |
| same again | identical route and totals | 61ms |
| **apply**, 40-stop cap | 40 written, 370 untouched | **151ms** |

Totals match the database exactly. Two identical previews returned identical
routes, so the walk is deterministic as its author claimed. The O(n²)
nearest-neighbour walk over 410 stops is roughly 84,000 distance calculations
and finishes inside 90ms — no concern at his volume.

After applying: **40 jobs with route orders 1–40, forty distinct values, no gaps
or duplicates. 370 still waiting, 0 carrying a stray route order.** One audit
line. The 40-branch `CASE` update — the author's stated untested risk — is now
exercised at forty branches against production.

Load-test rows were deleted afterwards; the demo dataset is back to 12 clients
and 10 waiting jobs.

## Job costing

Seeded 18 completed jobs, of which **12 clocked and 6 deliberately not**, with
one crew running 45% over budget, one near budget, and one with no clock entries
at all.

Verified against figures computed independently in SQL before deploying:

| Crew | Clocked | Revenue | Budgeted | Actual | Variance | $/hour |
|---|---|---|---|---|---|---|
| Dale Reyes | 6/6 | $570.00 | 6.0h | 8.7h | +2.7h | $65.52 |
| Marcus Webb | 0/6 | $570.00 | — | — | — | — |
| Tony Alvarez | 6/6 | $570.00 | 6.1h | 6.1h | +0.1h | — |

Dale's 8.7h against 6.0h budgeted is exactly the 1.45 factor seeded, so the
aggregation is right. Revenue per hour: $1,710 / 14.8h = $115.54, as displayed.

**The row that matters is Marcus Webb.** Six completed jobs worth $570 and
nothing clocked. Every hour-derived cell is an em-dash. Had unmeasured work been
counted as zero hours he would show 0h and an infinite revenue-per-hour — reading
as the most efficient crew member on the page when he is simply unmeasured, and
pointing the owner at exactly the wrong conclusion. The `0/6` is flagged amber,
and a banner above every table states "12 of 18 completed jobs were clocked"
before any figure is read.

## The assistant

Not yet exercised: no key is set. The page states this plainly rather than
offering a control that always fails — "Plain-English questions are switched off:
no assistant key is set on this server."

Design, for the record: the model chooses which of four curated reports answers
the question and writes the prose. It never writes SQL and never produces a
figure. The rows render beneath the answer so a bad summary is checkable against
the data. Provider is xAI via its OpenAI-compatible endpoint; `XAI_API_KEY` and
optional `XAI_MODEL` (default `grok-3`) switch it on.

## Not verified

- **The assistant end to end** — needs the key. Both calls (report routing and
  summarising) are unexercised against the live API.
- **Report accuracy over a long period with real data.** These figures come from
  seeded jobs with synthetic clock entries; the arithmetic is proven, the shape
  of real-world data is not.
- The costing queries have no automated tests.
