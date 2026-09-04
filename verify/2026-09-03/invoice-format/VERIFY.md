# Invoice format parity + skip policy

Date: 2026-09-03
Scope: bring invoices to the format Adam already sends (from `Invoice.pdf`,
his "Bison Bill"), plus the one-free-skip-a-year term from his quote.

## Status: verified in a browser, and by two real emails. Not deployed.

The browser pass and the live send are both done. The browser pass found one
real defect — the payment coupon was landing on a page of its own — which is
fixed and guarded by tests below. What is still outstanding is only the deploy.

The extension would not connect at first. The cause was not a missing install:
**Chrome was not running at all** (0 processes). Started it and it paired first
try. Worth knowing before assuming an extension fault next time.

## What was built

| Gap (from 2026-09-02 review) | Built |
|---|---|
| No invoice number | `invoices.number`, gap-free, starts at `INVOICE_NUMBER_START` (4900) |
| No invoice/due date, no terms | `invoiceDate`, `dueDate`, `terms` snapshotted from the client at issue |
| No PO number | `invoices.poNumber` |
| No line items at all | `invoice_line_items` (description, serviceDate, qty, unitPrice, total, sortOrder) |
| Bill To == property address | 11 billing columns on `clients`, named after his own export |
| No payment coupon | Rendered on the PDF |
| No invoice document or send | `invoiceDocument.ts`, `invoiceDelivery.ts`, `GET /invoices/:id/pdf`, `POST /invoices/:id/send` |
| Free-skip term unenforced | `jobs.skipBillable` + `skipPolicy.ts`, surfaced on skip and on the board |

Job-completion invoices were the important half: **both** completion paths
(`jobs.ts` and `vendor-runs.ts`) previously inserted an invoice with a total and
a one-line note — no number, no detail. Those are most of the invoices the
business issues. Both now go through one shared `createInvoiceForJob`.

## Evidence 1 — the rendered PDF

`rendered-invoice.pdf` in this directory, produced by the real code path against
the real local database (a property-managed customer, three lines, one of them a
card fee). Text extracted from that exact file:

```
Bison Lawn Care LLC / Po Box 117 / Post Falls, ID 83877
208-981-0176 / bisonlawncarellc@gmail.com / bisonlawncare.net
INVOICE #4900
Invoice Date 9/2/2026   Terms Net 15   Due Date 9/17/2026
PO Number PO-VERIFY-1   Account # VEPR4242

BILL TO                              PROPERTY ADDRESS
Blue Sage Property Management        Verify Property Group
1712 W Durham Dr                     615 E 18th Ave
Hayden, ID 83835                     Post Falls, ID 83854

DESCRIPTION          DATE        QTY  PRICE    TOTAL
Mowing               8/12/2026   4    $49.00   $196.00
Sprinkler Blowout    8/28/2026   1    $70.00   $70.00
Card processing fee  —           1    $7.98    $7.98
                            Subtotal          $273.98
                            Invoice Total     $273.98
                            Balance Due       $273.98

PAYMENT COUPON
Blue Sage Property Management / 1712 W Durham Dr / Hayden, ID 83835
Invoice # 4900   Invoice Balance $273.98   Account Balance $0.00
Remit to: Bison Lawn Care LLC, Po Box 117, Post Falls, ID 83877
```

Compared against his own invoice (`Invoice.pdf`, #4848) field by field: Invoice
#, Invoice Date, Terms, PO Number, Account #, separate Bill To / Property
Address, Description|Date|Quantity|Price|Total columns, Invoice Total, Account
Balance, PAYMENT COUPON. **Bill To (Hayden) is correctly a different address
from Property Address (Post Falls)** — the single thing this work exists for.

## Evidence 2 — behaviour against the live database

Run output, real rows:

```
allocated number: 4900 | invoiceDate: 2026-09-02 | terms: Net 15 | dueDate: 2026-09-17
stored total: 273.98 | expected: 273.98 MATCH
stored lines: 3
balance: 273.98 | number shown: 4900
next number: 4901 SEQUENTIAL
```

Terms were read from the client and the due date derived from them; the stored
total equals the sum of the stored lines; numbering is gap-free.

## Evidence 3 — tests

`105 pass / 0 fail` across all nine suites, run against the local database with
the full `.env` exported:

```
invoiceDocument 11   estimateDelivery 5   customerMessageDelivery 4
userAccounts 9       ownerAccess 6        extraWork 10
creditAndSchedule 12 automation 24        integration 24
```

`invoiceDocument.test.ts` is new (11 cases) and needs no database — the document
builders take the company profile as a parameter for exactly that reason. It
covers the bill-to/property split, overpayment flooring, Net-terms arithmetic
across a month boundary, HTML escaping of customer text, an empty-line invoice,
and the Gmail MIME envelope.

**Correction to HANDOFF.md:** it records the local suites as failing for
environmental reasons. They do not. They fail only when `.env` is not exported —
`DATABASE_URL` alone is not enough, `CLERK_SECRET_KEY` is also required, and its
absence surfaces as a 500 rather than as a missing-config message. With the full
env exported every suite passes. Command in this file's Evidence 3.

## Deploy hazard found (important)

Adding `invoices.number` made `drizzle-kit push` offer to **TRUNCATE the invoices
table** in order to add its unique constraint. `pnpm push-force` accepts every
such offer silently and would have destroyed the invoice history.

The offer is also unnecessary: Postgres permits unlimited NULLs in a unique
constraint, and every existing invoice has `number = NULL`. Verified locally on a
table of 6 invoices — added the constraint by hand, all 6 survived, and the
subsequent `push` applied cleanly with no prompt.

`DEPLOY.md` now carries the explicit `ALTER TABLE` and a "never run push-force"
warning. **Production has not been touched.**

## Two data corrections

1. **Company profile held the wrong address.** `seed-demo.ts` had taken
   `PO Box 7156, Kalispell, MT 59904` with a 406 phone number from the *contract
   body* of his quote. The letterhead and invoice of that same document both say
   `Po Box 117, Post Falls, ID 83877` / `208-981-0176`. Owner confirmed the Idaho
   one on 2026-09-02. Corrected in the seed and in the local database. The
   contract template reads the address through merge tokens, so it follows.
2. **Invoice dates would have used Mountain time.** `todayISO` defaulted to
   `America/Denver`; the Idaho panhandle (Post Falls, Coeur d'Alene, Hayden) is
   Pacific. An invoice raised on a weekday evening would have been dated the next
   day. Default is now `America/Los_Angeles`.

Related, **not** changed: `weatherScheduler.ts` independently hardcodes
`America/Chicago` for when its daily job fires. That is a third timezone in the
codebase and probably wrong too, but changing when a background job runs is not
a safe side effect of invoice work. Flagged for Adam/Koby to decide.

## One display bug fixed while in the file

The invoices table computed `total - amountPaid` in the browser, so an overpaid
invoice showed a **negative** "Balance Due" — reading as the company owing the
customer. The server now returns a floored `balance` and the UI uses it. The
overpayment was already correctly held as account credit; only the display was
wrong.

## Evidence 4 — the browser pass (2026-09-03)

Chrome, signed in as the owner, against the local API and database.

| Item | Result |
|---|---|
| Invoice # column with terms beneath | `#4900` over `Net 15`. Legacy rows show their id |
| PDF button | Opens `/api/invoices/412/pdf` inline in a new tab, titled "Invoice 4900" |
| Send vs Resend | #4900 reads **Resend** (it has a `sentAt`); every other row reads **Send** |
| Resend confirm | "This invoice was already emailed on Sep 3, 2026. Send it again?" |
| New Invoice line editor | Client pick showed "Terms: Net 15"; live total `$147.00` for 3 x $49 |
| Create through the dialog | Created **#4901**, $147.00, Net 15 — numbering advanced through the UI |
| Skip toast (first skip) | "Skip recorded — free / Free skip — the customer's one allowed skip for 2026." |
| Skip toast (second skip) | "Skip recorded — chargeable / ... already used their free skip in 2026." |
| "Chargeable" marker | Renders under SKIPPED on the second skip only, and **survives a reload** |

Database after the two skips, confirming the toast was not merely cosmetic:

```
  id  | client_id | status  | skip_billable |       skipped_at
  867 |       309 | skipped | f             | 2026-09-03 23:23:16.671
 1237 |       309 | skipped | t             | 2026-09-03 23:23:31.664
```

`window.confirm` was stubbed to return **false** for the Resend check rather than
clicked through — a native modal freezes the extension, and cancelling also
proved the cancel path: `sent_at` stayed at `22:55:25.146`, unchanged.

Screenshots: `browser-invoice-one-page.jpg`, `browser-skip-chargeable.jpg`.

## Evidence 5 — two real invoice emails

`POST /invoices/:id/send` through the real route, the real PDF builder and the
real Gmail API. Nothing mocked but Clerk. Sent to Work Optional addresses only,
via the route's `toEmail` override, so no customer record was touched.

| To | Gmail message id | `sentAt` stamped |
|---|---|---|
| koby@radiantaisoftware.com | `1a0697bfb532fa5b` | 2026-09-03 22:55:25 |
| kobystull123@gmail.com | `1a0697c2442fdc76` | 2026-09-03 22:55:35 |

Attachment `Bison-Lawn-Care-LLC-Invoice-4902.pdf`, 32,897 bytes. Numbering ran
4900 -> 4903 across four invoices with no gaps.

## The defect the browser pass found: the coupon on its own page

The rendered invoice was **two pages**, the second holding nothing but the
payment coupon. His own #4848 is one page with the coupon at the bottom — a
tear-off stub on a separate sheet is not a tear-off stub, and it doubles the
paper and postage on every mailed invoice.

Cause: `needSpace` compared against a hardcoded `700`, but a Letter page's real
content bottom is `792 - 54 = 738`. That wasted 38pt of every sheet. The coupon
also claimed a flat `150pt` when it measures **133.9pt**.

Measured page counts, before and after:

| Lines | Note | Before | After |
|---|---|---|---|
| 3 | yes | 2 | **1** |
| 5 | no | 2 | **1** |
| 24 | yes | 3 | **2** |

Nothing overflows: across every line count the largest single-page coupon ends
at **706.9** against the 738 bottom, and every spilled case starts the coupon
cleanly at the top of the next page rather than tearing across the break. The
`needed` figure is now derived from the address block's real line count and
deliberately kept an upper bound — underestimating splits the coupon, which is
worse than a second sheet.

The other two `needSpace` bounds were checked before raising the limit and are
honest: a row asks `descHeight + 22` and draws `descHeight + 18`; the totals
block asks `96` and draws at most `78`.

Two tests now guard it, in both directions — that ordinary invoices stay on one
page, and that long ones still break. **`invoiceDocument.test.ts` was not in the
`pnpm test` script**, so it had never run in the aggregate; it is now.

## Tests

`107 pass / 0 fail` across all nine suites (94 previously + 13 invoice-document,
up from 11). Workspace typecheck clean.

## Not verified — be specific about this

- **Not deployed.** Everything above is local. Production has not been touched.
- **The `ALTER TABLE` has not been run anywhere.** See the deploy hazard above.
- Reports and Books were not re-checked after the skip rows were added; the two
  skipped jobs are demo data created for this pass and are still in the local
  database.

## Next

1. Deploy: `ALTER TABLE` first, then `push`, then the app — per DEPLOY.md.
2. Decide the `weatherScheduler.ts` `America/Chicago` question (flagged, not changed).

## Deployed 2026-09-03 — `dafbd0a`

Ran on the server by Koby; I have no SSH to that box.

The corrected sequence worked exactly as the scratch-database test predicted:

```
ALTER TABLE   (add column number)
ALTER TABLE   (add invoices_number_unique)
deploy.sh     e7a3b1d -> dafbd0a, built, container healthy,
              https://bisonlawncare.workoptional.tech/api/healthz -> 200
push          [✓] Changes applied          <- no truncate prompt
```

Had we followed the runbook as it stood, `push` would have run first, stopped on
the truncate prompt having applied nothing, and the documented recovery
(`ALTER TABLE ... ADD CONSTRAINT`) would have failed on `column "number" does
not exist` — on production, mid-deploy. The correction was worth making first.

The neighbouring stack was untouched, as `deploy.sh` prints:

```
bisonlawn-app  Up 7 seconds (healthy)
takeoff-app-1  Up 3 days (healthy)
bisonlawn-db-1  Up 7 days (healthy)
takeoff-caddy-1  Up 7 days
```

### Production has no invoices, and that is correct

The invoices page reads "No invoices found." That is the expected state, not
data loss:

- `scripts/import/service-autopilot-to-sql.js` writes **only** `clients`,
  `estimate_fields` and `services`. It has never had an `INSERT INTO invoices`.
- The only code that inserts invoices outside the app itself is `seed-demo.ts`,
  which must not be run on a real account.
- His actual invoice history lives in Service Autopilot. Not importing it is why
  numbering starts at `INVOICE_NUMBER_START` (4900) — to continue past the ~4848
  his old system reached rather than restart at 1 alongside it.

Clients confirm the real book is intact and untouched: real names, phone
numbers, and Coeur d'Alene / Hayden / Post Falls / Spirit Lake addresses with
map codes.

Outstanding as a formality — `select n_tup_ins, n_tup_del, n_live_tup from
pg_stat_user_tables where relname='invoices'` would turn "never had any" from an
inference off the import code into a recorded fact.

### Not verified on production

The Invoice # column header renders and New Invoice is present, but with no
invoices there is no row to exercise, so **PDF, Send/Resend and the void balance
are unverified against production**. All three are verified locally and at the
API layer. Proving them on production means raising a real invoice on Adam's
live account, which is his call, not mine to assume.

## Production pass, 2026-09-03 — test invoice #4900, raised and voided

Authorised by Koby. Billed to **Adam Johnson's own client record**, not a
customer's, so the row sits on his account rather than in someone's history.

| Check | Result |
|---|---|
| Numbering | **#4900** — the configured start, continuing past his ~4848 |
| PDF | One page, letterhead through coupon, no second sheet |
| Void | `#4900 VOID  Total $1.00  Balance Due $0.00`, in plain text not red |

The void row is the fix from `34cd176` confirmed against production data.

### The pass paid for itself: production had the wrong company address

The first PDF came out on **`PO Box 7156, Kalispell, MT 59904 / 406-885-5296`** —
the Montana address corrected on 2026-09-02, when the owner confirmed the Idaho
one. The correction had been made in `seed-demo.ts` and in the *local* database
only. Seed code never runs on production, so the live `company_profile` row was
never touched and nobody had looked at a production document since.

Every invoice, estimate and letter Adam sent from production carried it,
including the payment coupon's `Remit to:` line — customers posting cheques to
the wrong state.

Fixed through the app's own Settings > Company details form (not raw SQL), which
is also the source of the `[companyaddress]`, `[companycity]`, `[companystate]`,
`[companyzip]` and `[companyphonenumber]` merge tokens, so letters and estimate
emails follow. Re-rendered the same invoice and confirmed both the letterhead
and the remit line now read `Po Box 117, Post Falls, ID 83877 / 208-981-0176`.

Before and after: `prod-wrong-address-before.jpg`,
`prod-corrected-address-after.jpg`. Void row: `prod-void-zero-balance.jpg`.

**This is a class of bug, not a one-off.** Seed and local fixtures are not
production data. Anything corrected in `seed-demo.ts` needs a matching change to
the live row, or it silently only ever holds locally.

### Correction to the section above

That section said production "never had any" invoices and predicted
`n_tup_ins = 0`. **The prediction is wrong.** The test invoice was created with
row id **19**, so the sequence had already issued eighteen ids — invoices did
exist on this database at some point and are gone now.

What that does *not* mean is that this deploy lost them:

- `push` reported `Changes applied` with no truncate prompt, and the scratch-DB
  test showed that path applies its diff without deleting rows.
- Numbering fell back to `INVOICE_NUMBER_START` rather than `max(number) + 1`,
  which means no *numbered* invoice existed — consistent with rows that predate
  the numbering column entirely.

The likely explanation is earlier demo seeding and resets on this box, which is
the same reason the standing instruction exists never to run
`seed-demo --reset` here. Worth confirming from `pg_stat_user_tables` rather
than leaving as inference — but the reasoning above stands on its own, and the
real client book is intact either way.

### Unexplained, not claimed as a bug

The first Void click (driven by element reference) did not register; later
clicks did. No network request was captured for the failed attempt, but network
capture had not started at that point, so there is no evidence either way.
Most likely a stale element handle after a React re-render rather than an app
fault. Not reproduced deliberately, so not filed as a defect.

Genuinely worth raising though: **Void has no confirmation of any kind.** One
click on a ghost button immediately voids an invoice, and it sits directly
beside "Pay". `handleUpdate` fires the mutation with no `window.confirm`, unlike
Send and Delete-payment which both confirm. A misclick silently cancels a bill.

## Void now confirms (follow-up)

Void was the one destructive control on the row that fired on a single click,
sitting beside "Pay", with no way back — every action is gated on
`status !== 'void'`, so a voided invoice renders with no buttons at all.

Verified in the browser by stubbing `window.confirm` (a native modal freezes the
extension) and reading back the exact message it was called with:

```
Void invoice #4901 for Verify Property Group ($147.00)?

The customer will no longer owe it, and this cannot be undone here.
```

Paid invoices get the extra clause, because voiding one turns the money into
account credit rather than making it disappear:

```
Void invoice #321 for Sarah Thompson ($190.00)?

The customer will no longer owe it, and this cannot be undone here.
The $190.00 already paid stays on the account as credit.
```

Both paths exercised: returning **false** left #4901 `OPEN $147.00`; returning
**true** left it `VOID $147.00 $0.00`. Typecheck clean.
