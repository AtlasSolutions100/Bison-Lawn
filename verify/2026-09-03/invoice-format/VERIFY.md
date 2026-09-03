# Invoice format parity + skip policy

Date: 2026-09-03
Scope: bring invoices to the format Adam already sends (from `Invoice.pdf`,
his "Bison Bill"), plus the one-free-skip-a-year term from his quote.

## Status: verified at the API and document layer. **Browser pass not done.**

The Chrome extension was not connected this session
(`tabs_context_mcp` -> "Browser extension is not connected"), so the working
contract's browser requirement is **not** satisfied for the UI changes. What was
verified is stated precisely below; what was not is stated just as plainly.

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

## Not verified — be specific about this

- **No browser pass.** The extension would not connect. Unverified in a browser:
  the Invoice # / Terms column, the PDF and Send buttons, the line-item editor in
  New Invoice, the skip toast, and the "Chargeable" marker on the dispatch board.
  All typecheck and are wired to endpoints proven at the API layer, but per the
  working contract that is **not** the same as done.
- **No live email send.** `POST /invoices/:id/send` is proven only against a fake
  Gmail proxy in tests. The real Gmail path is the same one estimates already use
  in production, but this specific endpoint has not sent a real message.
- **Not deployed.** All of the above is local.

## Next

1. Reconnect the Chrome extension and do the browser crawl on the five UI items.
2. Send one real invoice to a Work Optional address before Adam sees the button.
3. Deploy: `ALTER TABLE` first, then `push`, then the app — per DEPLOY.md.
