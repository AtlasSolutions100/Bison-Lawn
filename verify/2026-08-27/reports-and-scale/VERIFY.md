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

---

# The assistant, once the key was set

`XAI_API_KEY` installed on the server. Key accepted by xAI directly (HTTP 200).
Note: the request asks for `grok-3` and xAI resolves it to `grok-4.3`.

## Asked in the UI

> which crew is running over the time I priced the work for?

> **Dale Reyes crew ran over the budgeted time. They used 8.7 actual hours
> against 6 budgeted hours. Data is missing for Marcus Webb crew.**
> Read from: Budgeted vs actual hours by crew

Both figures match the table and the database. It routed to the right report, and
it volunteered the missing-data caveat rather than treating Marcus Webb's
unclocked work as zero — the failure this whole design exists to prevent.

## Negative test

| question | routed to | outcome |
|---|---|---|
| "what is the weather forecast for next Tuesday?" | **null** | declined, listed what it can answer, invented nothing |
| "what work have I finished but not billed yet?" | `unbilled_completed_work` | 2 rows, figures matching the tables |

Latency: 2.9s to decline (one call), 6.2s for a full answer (two calls).

## Two outages today, both worth recording

**Cause.** Compose was run without `docker-compose.proxy.yml`. That creates
`bisonlawn-app-1` on the default network instead of `bisonlawn-app` on
`web-proxy`. Every container reported healthy, nothing errored, and the site
returned 502 because Caddy proxies to a container name that no longer existed.
The deploy looks like it worked, which is what makes it dangerous.

**My contribution.** Symlinking `.env` earlier removed the loud failure: before
that, a bare `docker compose up -d` aborted on missing interpolation variables.
After it, the same command succeeded and produced a broken topology. I made a
noisy failure quiet.

**The second outage was mine outright.** Writing the fix into `.env.deploy` over
ssh, backticks inside a comment were substituted by the remote shell, which
executed a bare `docker compose up -d` and recreated the broken container.

**Fixed** with `COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml` in
`.env.deploy`, so a bare compose command resolves both files. Verified: a bare
`docker compose up -d` now produces `bisonlawn-app` and a 200.

takeoff was unaffected throughout — 200 at every check.
