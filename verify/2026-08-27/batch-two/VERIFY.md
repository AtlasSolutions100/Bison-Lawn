# Verification — second feature batch, live

Date: 2026-08-27 · https://bisonlawncare.workoptional.tech

## Gate before deploy

| | |
|---|---|
| Full typecheck (build info cleared first) | PASS, 0 errors |
| API tests | PASS, 94/94 |
| Production build | PASS — also proves the spray matcher's cross-package import bundles |
| takeoff (`workoptional.studio`) | 200 before and after |
| App errors since boot | 0 |
| Routes checked | `/`, `/settings`, `/spray-runs`, `/spring-letters`, `/automation` all 200 |

## Estimate document — his letterhead, reproduced

Generated a real PDF and read all three pages in a browser.

- **74,210 bytes**, `%PDF-1.3`, **3 pages**, **4 image XObjects** (both logos plus
  their soft masks).
- Page 1 (`02-estimate-pdf-letterhead.jpg`): his wordmark top-left; company block
  right-aligned with PO Box 7156 / Kalispell, MT 59904 / 406-885-5296 / email /
  bisonlawncare.net; brand rule in #215343; `ESTIMATE #498`; PREPARED FOR with
  the client's full address **including state and zip** — the fields that did not
  exist before this batch; `Dear Sarah,`; line items; TOTAL $355.00; service
  descriptions.
- Page 2 (`03-estimate-pdf-signoff-footer.jpg`): `Your Friendly Bison,` sign-off,
  company block, the bison-on-mountain emblem, and a centred "Thank you for your
  business!" with the address and contact line. This is his own letter structure.
- Page 3: the contract with tokens merged — "between **Bison Lawn Care LLC**,
  with a business address at **PO Box 7156, Kalispell, MT 59904**" — through the
  payment disclosure and the 3% late fee.

## Settings — `01-settings-company-and-templates.jpg`

Every company field is labelled with the token it fills (`Phone
[companyphonenumber]`), which is the connection the owner otherwise has to hold
in his head. All five of his documents are listed; the editor shows his aeration
letter verbatim; merge tokens sit beside it as click-to-copy chips, served by the
API rather than hardcoded in the page.

## Spray invoice matching — `04-spray-matching-live.jpg`, exercised live

Pasted deliberately messy vendor text into production: letterhead, an invoice
number, a `Page 1 of 1`, a column header, reordered columns, a differently
spelled address, an abbreviated name, a non-customer, and subtotal/total lines.

Result: **2 matched and ticked · 0 to confirm · 1 invoice line with no customer ·
5 header/total lines ignored.**

- `77 KAGY BOULEVARD, BOZEMAN MT` → matched Marcy Olander (file says "77 Kagy Blvd")
- `202 Cedar Hollow Wy.` → matched Cedar Hollow HOA (file says "Cedar Hollow Way")
- `Bob Sandoval 1450 Durston Rd` → flagged as explained by no customer

That last one is the owner's actual complaint: "I sometimes miss spray
customers." The red card says so in his terms — "this is where a spray customer
gets missed."

## Bulk repricing — measured, not browsed

+10% with rounding to $5, previewed against the real catalogue:

| Service | From | To |
|---|---|---|
| Weekly Mowing | $45 | $50 |
| Aeration | $60 | $65 |
| Fall Clean-Up | $220 | $240 |
| Sprinkler Blow-Out | $95 | $105 |

Preview confirmed to write nothing by re-reading `rate` and `pricingEquations`
byte-for-byte afterwards. Apply moved the equation `basePrice` as well as `rate`,
left the `*Sqft` measurements untouched, and wrote an audit row.

## Not verified

- The bulk-repricing and settings screens were not clicked through on the **live**
  host (settings was verified on localhost, repricing only via API).
- The estimate → email → accept → schedule round trip against the live public URL.
  Every part is proven separately; the customer-facing chain end to end is not.
- Contractor/mobile views on the live host.
- No mail was sent from production in this batch.
