# Handoff — 2026-08-27

Where things stand, so this is recoverable without the chat session.

## State

Live at **https://bisonlawncare.workoptional.tech**, commit `3cd4159`, server
level with `origin/main`, working tree clean, takeoff untouched throughout.

Deploy with one command on the server:

```
bash /root/bisonlawn/deploy/deploy.sh
```

See `DEPLOY.md` for why it aborts on a failed fetch (a deploy that pulls then
builds will otherwise build stale code and report success — that happened once).

## Environment choices, decided

- **Clerk is on test keys** (`sk_test_`/`pk_test_`) — a deliberate choice while
  the app is being tested, not an oversight. Switch to a production Clerk
  instance before Adam and his crew sign in for real; the procedure is the same
  shape as the Intuit swap in DEPLOY.md. Note the dev instance is accumulating
  `@example.com` accounts left by the automated test suites, which are worth
  clearing out at some point.
- **The Intuit consent-screen logo** was reported broken on 2026-08-27 and has
  since been verified working by Koby. Nothing outstanding.

## Adam backlog: 19 of 20 done

All twenty items are in the Feedback screen with a "What we did" note on each,
so the Done tab is his progress report. Nineteen are done; one is honestly
half-done and marked Read rather than Done:

- **Notification email with documents and photos** (id 19). Attaching documents
  and before/after photos to an **estimate** works and is tested end to end.
  Sending a plain notification email from the customer page with the same
  attachments is a separate send and is not built. The note on the item asks him
  which he meant.

Two answers are worth chasing with him:

- **Route builder** (id 24): jobs that do not fit a cap stay on the **Waiting
  List**. He wrote "put the rest back on dispatch board", which may mean he wants
  the remainder pushed onto the board instead. Flagged in the note.
- **Map routing** (id 25): he mentioned emailing a screenshot that never arrived.
  We shipped a multi-stop Google Maps link per crew; if he meant dragging stops
  on a map inside the app, that is a different build.

Adam has now signed in himself (bisonlawncarellc@gmail.com, admin, user 5) and
is submitting feedback from inside the app.

## Known, not yet acted on

- ~~**Contractors receive `clientBalance`**~~ — **corrected 2026-09-03.** It *is*
  rendered to subs, deliberately: it appears in the record-on-site-payment dialog
  in `my-jobs.tsx`, where a sub collecting money needs to know what is owed. Not
  a leak and not an oversight. Still worth Adam confirming he wants subs to see
  it, but removing it would break the on-site payment flow.
- **QuickBooks production is unproven end to end.** Everything up to Intuit's
  consent screen is verified; the token exchange, CompanyInfo and reports against
  a real company file can only be proven when Adam connects — and it should be
  him who does it, not us on his behalf.
- **23 `subrepl-*` branches** carry unmerged commits and are not on GitHub.
- **`artifacts/mockup-sandbox`** is Replit-agent scaffolding nothing imports.
  Proposed for deletion; still present.
- ~~Local test suite needs `DATABASE_URL` exported~~ — **corrected 2026-09-03.**
  `DATABASE_URL` alone is not enough: `CLERK_SECRET_KEY` is also required, and
  without it the suites fail with an HTTP 500 rather than a missing-config
  message, which is what made this look like a database problem. Export the whole
  `.env` and every suite passes — 105 pass / 0 fail across all nine. The command
  is in `verify/2026-09-03/invoice-format/VERIFY.md`.

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
