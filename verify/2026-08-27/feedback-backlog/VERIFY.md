# Adam's feedback backlog: status, and the two features built tonight

Date: 2026-08-27
Host: https://bisonlawncare.workoptional.tech

## Correction recorded first

Two rows were sitting in the Feedback screen attributed to "Adam Johnson" and
"Dale (sub)". **Both were fabricated by us**, seeded from `seed-demo.ts` under a
comment reading "a little feedback, so the screen is not empty at the demo".
Neither came from Adam or from any sub; both had `user_id NULL`, which a real
in-app submission never has. Koby nearly acted on them as real client input.

They have been deleted. The two features they described were built anyway and
are real — they are good features — but words must not be put in a client's
mouth, and a demo screen is not worth that.

## Adam's real backlog: 9 of 11 done

Loaded into the Feedback table under his own address with `admin_note` set, so
the Done tab now doubles as a progress report he can read himself.

Done (9):
1. Contractor added under contractor — team page invite, admin or contractor role
2. Skip job as a status — own status, raises no invoice, reason shows on dispatch
3. Auto-schedule on estimate acceptance — by rule, per service type, sub notified
4. QuickBooks P&L and expenses without signing in — Books page, read-only
5. Spray vendor invoice reconciliation — matched / probable / unmatched / invoiced
6. Spring letters — reprice, renew, merge, preview, send
7. Squarespace requests into the database and a ticket — webhook fixed tonight
8. Service priced off a chosen property detail — sprinkler zones vs turf sqft
9. Estimate in the field for a brand-new person — inline client entry

Not done (2), and deliberately not marked Done:
10. **Matrix input horizontal instead of vertical.** Not started. The original
    note pointed at "Screenshot 1", which is not in the Replit export, so the
    screen he means is genuinely ambiguous. Needs him to point at it.
11. **Documents sent with an estimate.** Half done. Choosing services and
    packages works. Attaching the service-description and meet-and-greet
    documents does not: `estimateDelivery.ts` builds a multipart message with
    exactly one attachment, the estimate PDF, and `documentTemplatesTable` is
    referenced only by `settings.ts`. The templates can be written but never
    reach a customer.

## Built tonight

**Dispatch — per-sub load strip.** Stops, dollars and budgeted hours per sub,
heaviest first, bar scaled to the busiest. Verified live against the database:
Dale Reyes $520.00/4 stops/6.3 hrs, Marcus Webb $225.00/3, Koby Stull $130.00/1,
Tony Alvarez $120.00/2, Unassigned $60.00/1 — every figure ties to
`SELECT ... GROUP BY assigned_to_id`. (screenshots 01, 02)

Deliberately ignores the contractor filter: filtering to one sub and reading
their total cannot answer "heavy compared to whom".

The Unassigned tile was verified separately by dispatching an unassigned job,
because "on the board, not yet given to a sub" is exactly the flow Adam
described for one-off jobs. It renders dashed, with no load bar, pinned last.

**Job card — property details.** The client's saved details now ride on the job.
Access-type labels (gate, code, lock, key, alarm, dog, entry, combo) are promoted
into a highlighted Access block in monospace; everything else renders below.
Verified live on Sarah Thompson: Access shows Dog "Yes" and Gate Code "4417",
Property Details shows Turf Sqft 6200. (screenshot 03)

The pattern only chooses emphasis. Every saved detail renders either way, so an
unrecognised label still reaches the person at the gate. Wrong emphasis costs a
glance; a hidden value costs a phone call.

## Two defects found by crawling, not reported by anyone

**The Squarespace webhook had never worked.** Two independent faults:

1. `WEB_REQUEST_WEBHOOK_SECRET=` was empty on the server — the Replit prompt
   asking for a value was never answered, so the key existed with no value. With
   `configured` falsy, `secretMatches` returned false for every request.
2. Worse, and invisible behind the first: `webRequestsRouter` was mounted *after*
   `jobsRouter`, which applies `requireAuth` to everything reaching it. The
   public `/inbound/web-request` was shadowed, so every submission got 401 **no
   matter what secret was sent**. Fixing the secret alone would not have helped.

This is the same failure mode as the QuickBooks OAuth callback, which is already
commented in `routes/index.ts` — the comment did not stop it happening again, so
the new one names the cost.

Now verified live: no header 401, wrong secret 401, correct secret 202.

**Contractor date navigation was off by one.** `new Date('2026-08-27')` parses as
UTC midnight, which renders as the previous day anywhere behind UTC. The crew's
schedule header read "Aug 26" above Aug 27's jobs, and next-day resolved to the
same string — the arrow did nothing, while previous-day skipped two. Fixed with
`parseISO` on both `/my/jobs` and `/my/route`.

**The admin note was never displayed.** `adminNote` has been on the feedback
table since it was added and no screen rendered it. Adam could see an item marked
Done but not what was built. Now shown as "What we did" / "Where this stands".
(screenshot 04)

## Demo data

The database held 10 clients but only 1 user and 4 jobs, none assigned — so
dispatch and routing could not be demonstrated at all, which matters for a
business run entirely on subs. Added three demo subs and a day of eleven jobs.

`seed-demo --reset` was **not** used: it deletes the feedback table, which would
have destroyed the very items being tracked. The additions are inserts only.

The demo subs carry `email NULL` and a synthetic `demo_` clerk id on purpose.
Accounts link on verified email, so a row with no email can never be inherited by
a real person signing in later, and no genuine Clerk id starts `demo_`.

## Still outstanding, for the handover

- **Clerk is on test keys.** `sk_test_` / `pk_test_`. A development instance is
  not meant to carry a real business, and of the 42 users in it, 40 are
  `@example.com` accounts left by the automated test suites. Needs a production
  Clerk instance before Adam and his crew sign in.
- **Only two people have ever signed in**: Koby and Christian, both Radiant AI.
  Adam has never signed in, and there is no team to restore — the Replit export
  contains no database dump, only code.
- **The server cannot pull from GitHub.** Its key is not authorised, so the last
  deploy silently rebuilt old code. Tonight's changes were shipped by `scp`,
  which leaves the server's working tree dirty. Add a deploy key.
- **Contractors receive `clientBalance`** through the shared `hydrateJobs`. Not
  rendered on the card, but it is in the API response a sub can read. Worth
  deciding whether a sub should see a customer's account balance.
