# Adam's backlog, triaged

Source of truth is the Feedback screen in the app, not this file — this is a
working order, written 2026-09-03 against the 47 items that were New that day.
Ids are `feedback.id`. Mark items done **in the app**, with a "what we did"
note, because that note is the only thing Adam ever sees.

Counts when this was written: 67 total, 47 New, 1 Read, 19 Done.
After the first pass: **43 New, 23 Done.**
After the 2026-09-04 pass: **35 New, 29 Done, 3 Read**.
After the 2026-09-08 pass: **58 New, 38 Done, 5 Read** — 34 new items arrived
over the weekend (ids 73-106), so the New count rose while the older block was
being cleared. The whole original quick-win block is now done.

## Done in the 2026-09-03 pass

| id | Item | What happened |
|---|---|---|
| 53 | Sprinkler Package prices 5 services, should be 3 | Real referential bug — see below |
| 31 | Dashboard boxes should link; tickets disappeared | Boxes link; tickets explained |
| 57 | Jobs Today should open the dispatch board | Tile links |
| 65 | Open invoices should open the invoice board | Tile links |

`53` was not bad data. `packages.service_ids` is a jsonb array with no foreign
key, so deleting a service left its id in every package that listed it. It had
also silently emptied "Full Season Care" (two ids, neither existing). Deleting a
service now cleans the packages, and the read path reports only ids that
resolve.

## Next up — cheap, self-contained, and each one visible to him

Done 2026-09-04: **41** (Enter moves to the next cell), **44** and **40**
(descriptions are multi-line), **54** and half of **36** (Add Tier moved to the
bottom), **37** (the pricing column is one line, and flags bands with no price).
**36** stays open for its second half — a rule that steps prices up by size.

**All done as of 2026-09-08**: 43 (Added column + sort), 62 (one word, said on
the Team page), 34 and 103 (tickets on the board, assigned and due today), 71
(money in one cell), 56 (source stated, email copies on click). 67 went with 71;
60 is half done — its filter list is still open.

## Then — real features, roughly in the order they pay off

**The invoice review loop (65 is done, these are the rest of what he described)**

| id | Item |
|---|---|
| 66 | A completed job becomes a *pending verification* invoice, not a sent one |
| 35 | Confirms the same: completed jobs make invoices he verifies then sends |
| 70 | Undo an accidental completion; pull a service back off an invoice |

Read these three together before building more invoicing. What shipped on
2026-09-03 creates the invoice on completion and waits for a Send press — close
to, but not the same as, the verify-then-send queue he is describing.

**Dispatch board** — his largest cluster by far

| id | Item |
|---|---|
| 58, 60 | Filters: branch, resource, service, city, map code, status, proximity, priority, tags |
| 67 | Customisable columns so it fits on one screen without sideways scrolling |
| 60 | Select-all |
| 61 | Filter to jobs carrying a contractor's note |
| 68 | Show a contractor what is assigned to them; preview recurring routes before dispatch |
| 69 | A pre-set list of parts / fees to add to a job |
| 59 | Send a prepared document by email from the board |

**Services and the rate matrix**

| id | Item |
|---|---|
| 38, 55 | Copy a matrix from one service to another |
| 64 | Price a service as a multiple of another (1x mow = 1.5x) |
| 63 | Assigning a service prices from the service or from the package |
| 72 | Two of the same service in a package = core aeration |
| 45 | Custom parameters for the parallel cells |
| 36 | A rule for how bands step up (＄5 up to 10k sqft, ＄4.50 per 2k above 20k) |
| 52 | Budgeted hours derived from the average of past jobs at that size |
| 42 | Import a matrix from Excel |
| 40 | Service descriptions with formatting |

**Estimates**

| id | Item |
|---|---|
| 48 | Add services and packages to an estimate |
| 47 | A cover document, then a link the customer uses to choose services |
| 46 | Populate the estimate number from the matrix and the customer's fields |
| 26 | Tag new-construction addresses by lat/long so subs can navigate |

**Automation**

| id | Item |
|---|---|
| 32 | Net 15 / Net 30 per account, late notice at 2 days, final notice 15 days later |
| 33 | Estimate follow-up at 2 days, then a "don't forget us" at 7 |
| 49 | "Crew is on their way" notification when a sub navigates to the job |

**Roles and access** — the biggest single piece

| id | Item |
|---|---|
| 50 | Separate contractor/employee logins with owner-set access |
| 51 | Multiple roles per person (crew lead, second lead) with different access |

Worth doing near the Clerk production switch
(`TASK-clerk-production-keys.md`), since both touch how people sign in.

**Scheduling**

| id | Item |
|---|---|
| 28 | Assigning a recurring service |
| 29 | Bi-weekly and monthly mowing options |
| 30 | Choose which services go in a package |
| 27 | Rate matrix horizontal for data entry |
| 39 | Route from a map per contractor |

**Check these first — they may already be built.** 27 and 39 both look like
work that already shipped (the matrix became a From/To/Rate/Hrs/Cost table on
2026-08-21; the dispatch map and per-crew "Route in Maps" on 2026-08-27), and 46
overlaps the estimate autofill. If so they cost a reply rather than a build, and
answering them is the cheapest progress available.

## How to close one

1. Build and verify it in a browser.
2. Deploy: `ssh -i /c/Users/kobys/bison_ssh root@31.220.50.13` then
   `bash /root/bisonlawn/deploy/deploy.sh`.
3. `PATCH /api/feedback/<id>` with `status: "done"` and an `adminNote` that says
   what was built, in his words, and names anything you decided differently.
   That note is his progress report — it is the only part he reads.
