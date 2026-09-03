# Adam's source material — full read

Date: 2026-09-02
Task: read every feedback item Adam supplied — 2 PDFs from his live CRM plus the
shared Drive folder — and record what they say the app must do.

**This is a read/diagnosis artifact. No code was changed.**

## Sources and how they were read

| Source | Files | Method | Result |
|---|---|---|---|
| `~/Downloads/Quote_Bison Lawn Care LLC.pdf` | 1 | custom extractor (`scratchpad/pdftext2.mjs`) | full text, 7 pages |
| `~/Downloads/Invoice.pdf` | 1 | custom extractor (`scratchpad/cidtext.mjs`) | full text, 1 page |
| `CRM Bison/` (shared Drive) | 43 | 39 PNG read directly; 2 XLS/XLSX parsed; 2 PDFs via AcroForm extractor | all 43 |

Both PDFs needed custom decoders and neither was readable by the default tooling:

- The quote uses a **subset font with a -0x1D glyph shift**. Naive extraction returns
  `6 W X O O` for `Stull` and silently drops every digit (digits encode to bytes
  0x13–0x1C, which are non-printable). **Every dollar figure came back blank on the
  first pass.** Corrected by adding +0x1D and re-reading.
- The invoice uses **Type0/CID fonts with hex strings**, so the `(...)`-string
  extractor matched nothing at all and returned two empty pages. Corrected by
  parsing the `ToUnicode` CMap (57 entries) and decoding `<hex>` strings.
- `Blank CDA Test.pdf` / `Blank BF signed.pdf` are **AcroForm** documents — content
  lives in field dictionaries, not content streams. Read via field/value extraction
  (96 fields on the signed one).

Flagging this because a "the PDF had no text" conclusion would have been wrong three
separate times here.

## Finding 1 — the benchmark product is named

Every screenshot is `my.serviceautopilot.com`. Adam's current CRM is **Service
Autopilot**, and "what he wants ours to do" is, concretely, the Service Autopilot
feature set. This was not stated in any prior transcript.

## Finding 2 — the quote PDF is the estimate template, with real numbers

Confirms the earlier template diagnosis and adds the price book.

Header block (top-left, above the greeting):

```
Stull, Koby            <- "Last, First" not "First Last"
111 Test Dr
Post Falls, ID 83854
Dear Koby,             <- [clientfname]
```

Footer: `Bison Lawn Care LLC` / `208-981-0176` / `Bisonlawncarellc@gmail.com`
Page foot: `Po Box 117 / Post Falls, ID 83877 / Bisonlawncarellc@gmail.com / Bisonlawncare.net`

Contract body names a **different** address: `PO Box 7156, Kalispell, MT 59904`.
Two addresses are in play (Post Falls ID mailing vs Kalispell MT legal). Do not
guess which is canonical — ask Adam.

Line-item grid columns: **Select One Plan | Estimate Description | Amount | Quantity**.
The "Select One Plan" checkbox column is the partial-acceptance mechanism.

Priced line items as sent:

| Service | Amount |
|---|---|
| Mowing | 49.00 (qty 1) |
| Aeration Program | 180.00 |
| Spinkler TO,BF,BO | 215.00 |
| 5 App Program (Lawn Program) | 440.00 |
| 8 App Program (Natural Lawn Health) | 704.00 |
| Bed Program | 420.00 |
| Clean-Up Program | 418.00 |
| Pest Control Program | 0.00 |
| Plant Health Care Program | 0.00 |
| Dethatching | 150.00 (qty 1) |
| Top Dressing | 826.67 (qty 1) |
| Sprinkler Blowout | 70.00 (qty 1) |
| **Total Estimated Cost** | **$3,472.67** |

Embedded fee schedule (currently free text in his descriptions, should be data):
$45 trip charge (<1wk cancellation), $25 reroute, $10/zone extra sprinkler zones,
$95/man-hour sprinkler repair (1hr min), backflow repairs pre-approved to $250 for
3/4"–1" and $500 for 1.25"+, cleanup $209/two-person-hour + $35 disposal ($240 min),
+$85/man-hour third crew member, cleanup packages $449/$795/$1,495/$2,400,
top dressing 50% deposit, 3% monthly late fee, 45-day collections.

Mowing skip policy in his own words: **one free skip per year**; additional skips
are "considered unpaid and will still be billed as a completed service." Our
`skipReason`/`skippedAt` feature currently has no free-skip counter and no billing
consequence.

## Finding 3 — the invoice PDF format

`Invoice #4848`, terms `Payment due in 15 days`, `Invoice Date`, `Account #`,
`PO Number`, `Terms`. Columns: **Description | Date/Time | Quantity | Price | Total**.
Separate **Bill To** and **Property Address** blocks. Footer carries a detachable
**PAYMENT COUPON** with Invoice Balance and Account Balance. Status stamp: `PAID`.

Our invoice has no PO number, no separate bill-to vs property address, no payment
coupon, and no per-line date/time.

## Finding 4 — the client record shape (closes the token gap)

`Client-view/Bison Asset Profile.png` shows the exact edit form:

- **Client Name**: Company/Last | First | Nickname | Display name (4 fields)
- **Contact**: Email, Home, Cell, Work, Other, FAX, Preferred, Title, Provider
- **Service Address**: Property Name, Property Name Continued, Address, Address 2,
  Postal Code, City, State, **Map Code**, **Branch**
- **Billing Address**: Name on Inv., Attention To, Address, Address 2, Postal Code,
  City, State, Country
- **Master Property**: "Select the client from the list that owns or manages this
  property" — this is the property-manager relationship Adam called his biggest
  time waster.

Other tabs: Details (Client Since, CSR, **Account Type = Commercial/Residential**,
Priority, Lat/Lng + Geocode button), Sales (Sales Person, Source, Referred By, Do
Not Market), Billing (Billing Email, Send Invoice By email/print/both, How They Pay
You, Flag Invoice for Review, Account #, **Billing Terms = Net 15**, **When to
Invoice = Monthly**, private Billing Notes), Office Notes (private rich text).

**Custom Fields** (`Customer Fields.png`) — 16 of them, and these are what the rate
matrix keys off:
Turf Sqft, Sprinkler Zones, Gate Code, Garage Code, Dog, Driveway Sq. Ft.,
Roof & Gutter Line, Exterior Windows, Interior Windows, Bed Sqft, Syncta ID,
House SQFT, Hose Bibs, Rental, Hours, Backflow Devices.

## Finding 5 — the Rate Matrix (biggest single gap)

`Mow Matrix.png` is `AdminServiceTypeList.aspx` → Edit Mowing → **Rate Matrix** tab.
Per-service banded pricing keyed off a custom field:

- Calculation mode: `Qty X Rate X Visits` (also `Calc x Qty x Rate x Visits`)
- Based on custom field: `Turf Sqft`
- Bands, each producing **Rate**, **B. Hrs** and **B. Cost**:

```
    0– 4000 -> $49  0.25hr $36.75      9001–10000 -> $80  0.70hr $60.00
 4001– 5000 -> $55  0.25hr $41.25     10001–11000 -> $85  0.90hr $63.75
 5001– 6000 -> $59  0.30hr $44.25     11001–12000 -> $95  0.90hr $71.25
 6001– 7000 -> $65  0.40hr $48.75     12001–13000 -> $98  1.00hr $73.50
 7001– 8000 -> $70  0.50hr $52.50     13001–14000 -> $101 1.00hr $75.75
 8001– 9000 -> $75  0.60hr $56.25     14001–15000 -> $105 1.05hr $78.75
                                       15001–16000 -> $105 1.05hr $78.75
                                       16001–17000 -> $107 1.05hr $80.25
                                       17001–18000 -> $112 1.10hr $84.00
                                       18001–19000 -> $112 1.15hr $84.00
```

Our shipped `calculatePrice(equations, value)` is a base+per-unit equation. His model
is **banded lookup returning three values** (price, budgeted hours, budgeted cost).
Budgeted hours is what drives the dispatch board's B.Hrs totals and the revenue/hour
projections. We have no equivalent.

`Top Dressing Formula update.xlsx` is the same idea done in Excel: 1,000–34,500 sqft
in 500-sqft steps, with cost build-up (yard cost, top dresser, dump trailer, skid,
delivery, hourly) producing Charge Price / Discount Price / Billable Hours. Row 2000
sqft → $826.67, which is exactly the Top Dressing line on the quote. **Confirms the
quote is generated from these tables, not typed by hand.**

## Finding 6 — automations are sequences, not single rules

Three automation screenshots, all `AutomationEdit.aspx`. Event palette:
Alert, Email, Form Email, IF, Note, Opt-In Email, Tags: Add/Remove, Text Message,
Ticket, Update, Wait Period.

**Estimate Follow up** (trigger: estimate created):
`Wait 2d -> Email "1 Follow Up" -> Wait 7d -> Snap to Weekday -> Email "2 Follow Up" -> Wait 7d -> To-Do "Close Estimate"`

**Past Due Automation** (trigger: invoice past due):
`Wait 5d -> Email "Day 5: Bill Past Due" -> Wait 2d -> Suspend Services (wait) -> Suspend Services (email) -> Wait 13d -> Wait 15 Days -> Email "Day 20: Bill Past Due" -> To-Do "Past Due - Collections" -> Email -> IF -> END -> Ticket`

Note the **Suspend Services** step — the payment disclosure's suspension clause is
enforced by automation, not just stated. Approve-Emails queue showed 1,044 pending
on the past-due automation, so these run at real volume.

Our `scheduling_rules` engine is one-shot offsets. There is no wait/branch/sequence
concept, no email step, no to-do step, and no tag step.

## Finding 7 — tags drive automations

`Tags.png` (`AdminTagsList.aspx`): tag + **Tag Category** + **Automation Tag** flag.
Live tags include `2024 Spring letter`, `2025 Spring Letter`, `2026 Spring Letter`,
`2026 AC Updated`, `BFT PI 2026` (categorised by year), `Above ground PVB/RP`,
`DC Backflow` (category Sprinkler), `Aeration`, `Bed Program`, `Christmas Lights`,
`Commercial`, `Credit Card on File`, `Customer second home` (flagged Automation Tag).

This is how he segments the spring-letter mailing. We have no tag entity at all.

## Finding 8 — the role model is a permission matrix

`AdminRoleList.aspx`. Roles: Accounting, Customer Support Rep, Owner, Sales,
Scheduler, **Subcontractor**, Team Leader — each active/inactive, each editable,
with **Add Role**. Permissions are checkboxes across five tabs: Home, CRM,
Scheduling, Accounting, Mobile — several hundred flags (Client Access, Lead Access,
CRM Reports, Tickets, Tags, Automation Access, Forms, Scheduling Access, Job Access,
Employee Access, Vendor Access, Chemical Tracking, Accounting Access, Payroll
Access, Mobile App, Mobile App Assets).

Mobile tab is the one that matters for Adam's crews — `View/Edit Client: Always vs
When Assigned Job`, `Send Emails From: Company/Branch/Employee`, Enable Drive Time,
Require "Before"/"After" Pictures, Require Chemical Logging, Collect Payment,
Dispatch from Mobile, Enable Estimates, Edit Timesheets.

We have owner / owner_assigned / contractor with no per-capability control.

## Finding 9 — dispatch board is map-first with lasso routing

`Map view.png`, `Highlight, Making routes.png`, `Screenshot 2026-08-27 094720.png`.

Filters: Branch, Resource, Service, **Proximity Search**, **Map Code**, Address,
Client, Status, Priority, Tags, Resource Tags. Numbered pins = route order.
**Lasso-select on the map** produces a Group Selection panel (B.Hrs, Services count,
**Total Revenue $3,405.00**) with bulk Move-to-date / Assign-to-resource / Permanent.

Actions menu:
- Job Status: Dispatch, Cancel Dispatch, Complete, Cancel Job, Waiting List,
  **Skip Job**, Extend Job (Multi-day), Shorten Job (Multi-day)
- Routing: Manual, Group Stops, **Optimize Stops**, Master Routes, Split Assignments,
  Cancel Split Assignments, Clear Rescheduled Flag
- Communication: **Email Clients**, Jobs without Emails

Job list columns: Service, Date, Map, City, Assigned, Last Svc, B Hrs, Amt.
Footer shows an audit line: `Skipped 8/26/2026 2:58 PM: "Schedule for monday"` —
skips carry a reason and appear in the audit trail. That matches what we shipped.

**"Email Clients" on a map-lassoed group is the property-manager batch notification**
Adam described. It is a dispatch-board action, not a separate feature.

## Finding 10 — chemical tracking is a whole module we have nothing for

`Products.xls` export header row:
`ProductName, PartNumber, Price, Active, PurchaseDescription, SalesDescription,
EstimateDescription, Category, TaxCode, BudgetedHours, BudgetedCost, TrackChemicals,
ShowInSnow, IncomeAccount, COGSAccount, AssetAccount, NumberOnHand, Vendor,
ProductCost, ApplicationVolume, ApplicationVolumeRate, ApplicationArea,
ApplicationMethod, ScientificName, EPARegistrationNumber, ProductTargets,
LabelInstructions, ClientInstructions, CustomFields`

Sample rows are irrigation parts (Solenoid AC $50, ICD Decoder $336.67, MP Rotor
$16.74, Test Cock $5, Trip Charge $45) and chemicals (24D amine 4 MOA 4).

Settings has a whole Chemical Tracking section: Chemical Instruction Emails,
General Chemical Settings (Application Methods, Area Units, Areas Treated, Targets,
Volume Units), Products, Legacy Mixes, Chemical Services. This is regulatory
(EPA reg #, label instructions, targets) — spray applicators must log it.

## Finding 11 — backflow testing is a document workflow

`Blank CDA Test.pdf` is a fillable city backflow test certificate:
Date, Customer, Address, Location, Make, Model, Serial, Size, Pressure, Hazard,
Replaces, Repair Date, plus check-valve reading fields.

`Blank BF signed.pdf` is a completed one. Values read back:
`A.P.M. 7183 N Joanna Dr` / `Savannah` / `406-581-1442` / map code `HLIG` /
serial `0121462` / `Left of house` / `Wilkins` `950XLT` / `replaced check` /
test kit `Midwest 845-5` `04190562`, calibrated `9-11-25`, cert `BAT23407`,
tested `5-21-26`, tester `Adam Johnson`, `Po Box 117 Post Falls, ID 83877`.

The client custom fields `Backflow Devices` (H16773) and `Syncta ID` (S252-654AX)
are the join keys — Syncta is the third-party backflow reporting service the
certificate gets submitted to.

## Finding 12 — settings surface (the full config inventory)

Company: Branches, Client Portal Settings, **Company Information**, **Company Logos**,
Countries, Integrations, States/Provinces, User Roles & Rights, **Validation**
(which fields are required when creating customers/tickets/services).

CRM: Calendar Event Categories, Cancellation Reasons, Client Source, Contact Types,
**Custom Fields**, **Documents** (welcome letters, marketing letters, document
templates), Email Categories, Email Integrations, Email Links, **Estimate Grids**,
Estimate Reasons, Estimate Settings, **Estimate Stages**, **Job/Estimate Templates**,
Legacy Estimate Templates, **Tags**, Ticket Categories, Two Way Texting.

Scheduling: Categories, Employee Time Off, **Map Code Colors**, **Master Packages**,
**Master Routes**, **Master Schedules**, Non-Billable Items, Products,
Resource Note Types, Route Sheet & Work Order Formats, Sales Rep, Services,
Sub Status, Vendor Types.

Chemical Tracking: (see Finding 10).

Accounting: **Bulk Price Update** ("Increase recurring jobs rates in bulk by
service" — this is the spring-letter step 1 already on our backlog), Chart of
Accounts, Compensation Types, Discounts, **Invoice Customization**, Invoice Grids,
**Job Costing**, Other Charges, Payment Methods, Payroll Settings, Purchase Order
Customization, Sales Tax.

**Company Information / Company Logos confirms Finding 1 of the earlier template
diagnosis**: a company profile is a first-class settings record in his world, and
it is what every `[company*]` merge token reads from.

## What this changes about the backlog

Reordered by what is now known to block other work:

1. **Company profile** — still first. Now confirmed to be a settings entity, and the
   two competing addresses (Post Falls ID vs Kalispell MT) need Adam to arbitrate.
2. **Structured client addresses + name parts** — now specified exactly (Finding 4),
   including the service/billing split and Map Code.
3. **Custom fields on clients** — 16 named fields (Finding 4). These are the input
   to everything priced.
4. **Rate matrix** — banded lookup returning price + budgeted hours + budgeted cost
   (Finding 5). Supersedes the equation-based pricing we shipped. Two real datasets
   available to seed it (mowing bands, top-dressing sheet).
5. **Partial estimate acceptance** — the "Select One Plan" checkbox column
   (Finding 2), still all-or-nothing in `routes/estimates.ts:155`.
6. **Tags** — prerequisite for spring letters and for automation targeting (Finding 7).
7. **Automation sequences** — wait/email/to-do/tag/branch steps (Finding 6).
   Estimate follow-up and past-due are the two he actually runs.
8. **Map-lasso group actions on dispatch, incl. Email Clients** (Finding 9) — this
   is the property-manager batch notify.
9. **Invoice format**: PO number, bill-to vs property address, payment coupon,
   per-line date/time, Net-15 terms (Finding 3).
10. **Free-skip-per-year counter with billing consequence** (Finding 2).
11. Chemical tracking (Finding 10) and backflow certificates (Finding 11) — large,
    self-contained, regulatory. Scope separately with Adam; do not start unasked.

## Open questions for Adam

1. Which address is canonical — `Po Box 117, Post Falls, ID 83877` (letterhead/
   invoice) or `PO Box 7156, Kalispell, MT 59904` (contract body)? Both appear in
   the same document.
2. Logo files. The quote letterhead and the invoice use a proper bison wordmark;
   the app ships a placeholder `logo.svg` that does not match. Need the source
   asset, not a screenshot.
3. Is the `Bisonlawncare.net` website URL current? It only appears in the page foot.
4. Are Pest Control and Plant Health Care genuinely $0.00, or unpriced placeholders
   on this particular quote?

## Resolved 2026-09-02 (same day)

**Q1 — canonical company address: ANSWERED.** Koby confirmed the Idaho address is
the company address: `Po Box 117, Post Falls, ID 83877`. The Kalispell MT address
in the contract body is stale boilerplate. Company-profile work is unblocked; seed
`[companyaddress]/[companycity]/[companystate]/[companyzip]` from Post Falls, and
flag the Kalispell string in the contract text as needing replacement.

**Q2 — logo assets: ALREADY IN HAND, no new asset needed.** Three files uploaded to
the repo root as `unnamed.png` / `unnamed (1).png` / `unnamed (2).png` are
**byte-identical duplicates** (md5) of `logo.png` and `logo1.png`, which have been
in the root since 2026-08-26:

| file | md5 (12) | size | what it is |
|---|---|---|---|
| `logo.png` = `unnamed.png` | `329654ea3119` | 1201x465 RGBA | "B"-as-bison wordmark + BISON LAWN CARE |
| `logo1.png` = `unnamed (1).png` = `unnamed (2).png` | `45d82aacb672` | 1201x1201 RGBA | bison-on-mountain roundel |

`template_design.png` (root, 2026-08-26) settles placement: **wordmark top-centre,
roundel bottom-centre**, thin blue page border, token block top-left. It is the Mow
Care letter rendered with `[clientname]`, `[physicaladdress1]`, `[physicaladdress2]`,
`[physicalcity]`, `[physicalstate]`, `[physicalzip]`, `[clientfname]`,
`[companyname]`, `[companyphonenumber]`, `[companyemail]`, `[companyaddress]`,
`[companycity]`, `[companystate]`, `[companyzip]`, `[companywebsite]` in place.

Both PNGs are RGBA at 1201px wide — fine for email and web. A vector (SVG/AI/EPS)
would only be needed for print; not blocking.

Consequence for work already shipped: `artifacts/bison-crm/public/favicon.svg` was
rebuilt from measured geometry of the **placeholder** `logo.svg`, which does not
match this wordmark. Favicon and nav logo should both be re-derived from `logo.png`.

## Still unread (real data, not yet processed)

`Customer_List.xls` (541 KB) and `services.xls` (74 KB), both in the repo root
dated 2026-08-27. These look like live exports from Service Autopilot and are
almost certainly the real client list and service catalogue. Not opened yet.
