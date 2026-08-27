# Handoff — 2026-08-27

Where things stand, so this is recoverable without the chat session.

## State

Live at **https://bisonlawncare.workoptional.tech**, commit `3cd4159`, server
level with `origin/main`, working tree clean, takeoff untouched throughout.

Deploy with one command on the server:

```
/root/bisonlawn/deploy/deploy.sh
```

See `DEPLOY.md` for why it aborts on a failed fetch (a deploy that pulls then
builds will otherwise build stale code and report success — that happened once).

## Blocking before Adam uses this for real

1. **Clerk is on test keys** — `sk_test_` / `pk_test_`. A development instance is
   not meant to carry a real business, and 40 of the 42 users in it are
   `@example.com` accounts left by the test suites. Needs a production Clerk
   instance, then the same key swap and rebuild done for Intuit.
2. **The Intuit app logo is broken on the OAuth consent screen** — a
   broken-image placeholder sits next to the QuickBooks mark on the page where
   Adam approves access to his real books. Upload the icon on the Intuit
   dashboard listing.

## Adam's backlog: 9 of 11 done

Loaded into the Feedback screen under his own address with a "What we did" note
on each, so the Done tab doubles as his progress report.

Not done, deliberately not marked Done:

- **Documents sent with an estimate** (marked Read, half done). Picking services
  and packages works. Attaching his service-description and meet-and-greet
  documents does not: `estimateDelivery.ts` builds a multipart message with
  exactly one attachment, the estimate PDF, and `documentTemplatesTable` is
  referenced only by `settings.ts`. The templates can be written but never reach
  a customer.
- **Matrix input horizontal** (marked New). Not started. His note pointed at
  "Screenshot 1", which is not in the Replit export, so the screen he means is
  genuinely ambiguous — ask him to point at it rather than guess at a layout he
  will use daily.

## Known, not yet acted on

- **Contractors receive `clientBalance`** through the shared `hydrateJobs`. It is
  not rendered on the job card, but it is in the API response a sub can read.
  Worth deciding whether a sub should see a customer's account balance.
- **QuickBooks production is unproven end to end.** Everything up to Intuit's
  consent screen is verified; the token exchange, CompanyInfo and reports against
  a real company file can only be proven when Adam connects — and it should be
  him who does it, not us on his behalf.
- **23 `subrepl-*` branches** carry unmerged commits and are not on GitHub.
- **`artifacts/mockup-sandbox`** is Replit-agent scaffolding nothing imports.
  Proposed for deletion; still present.
- Local test suite needs `DATABASE_URL` exported; several suites fail without a
  migrated local database. Those failures are environmental and pre-existing —
  verified by running the same suites against a clean checkout.

## Demo data

Three demo subs exist (`Dale Reyes`, `Marcus Webb`, `Tony Alvarez`) with a day of
jobs on 2026-08-27, so the dispatch board and routing can actually be shown — the
database previously held one user and no assignments, which for a business run
entirely on subs meant dispatch could not be demonstrated at all.

They carry `email NULL` and a synthetic `demo_` clerk id **on purpose**: accounts
link on verified email, so a row with no email can never be inherited by a real
person signing in, and no genuine Clerk id starts `demo_`. Delete them before
handover if you want a clean board.

Do **not** run `seed-demo --reset` — it deletes the feedback table, which now
holds Adam's real backlog.
