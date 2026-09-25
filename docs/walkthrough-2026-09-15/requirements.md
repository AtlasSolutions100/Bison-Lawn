# What Adam asked for in the 2026-09-15 walkthrough of Service Autopilot (his current CRM)

Source: 67-minute recording, transcribed. Timestamps are mm:ss. "SA" = Service Autopilot.
Koby (us) made promises in the call marked PROMISED.

## A. Clients list (08:25-09:30)
A1. Filter builder: pick a field, an operator (contains / starts with / equals), a value; stack several filters. Also former clients.
A2. Select-all on the list with bulk actions: delete, activate/deactivate, export, bulk edit.

## B. Services and the rate matrix (10:09-15:40)
B1. Service has: a name (shown on the dispatch board), a short CODE (shown on the waiting list), an INVOICE DESCRIPTION (printed on the invoice), and an ESTIMATE DESCRIPTION (rich text, customer-facing, bullet points/bold).
B2. Matrix pricing is driven by a customer custom field (e.g. "Turf sqft"): price = rate(from band) x qty x visits. He types 28 mows and the customer sees the quantity so they can divide total by visits.
B3. Copy a matrix from one service to another (Bison App 1 -> 2..8), optionally multiplied (one-time mow = 1.5x mowing). Feedback ids 38, 55, 64, 89.
B4. Budgeted cost per band alongside rate (he likes ours).

## C. Waiting list (15:43-19:33)
C1. A waiting-list job is a one-time job with a date WINDOW from the service; it only appears on the waiting list when the chosen date is inside its window.
C2. Filter the waiting list by service (resource), by date.
C3. Pick jobs on a map (lasso an area/direction), the picks highlight in the list, then in one action set a dispatch date and a contractor for all of them.
C4. Send a document email to the selected customers from the waiting list ("you are on the schedule, date to follow").

## D. Dispatch board (19:34-29:37)
D1. Dispatched vs not-yet-dispatched shown per job (calendar icon on not-dispatched); complete / cancel / skip from the board; completing puts the job on the customer account for billing.
D2. Change the date of one job or of the whole selection; change contractor for the selection. Feedback 78, 116, 117.
D3. Map with a colour per contractor — a colour HE designates per person, not one we assign ("a different color that I've designated for that contractor"). BUILT 2026-09-25: he picks it on the Team page and it carries to the board, the pins, the crew markers and the job cards; left alone, a person still gets a stable colour of their own. Date range on the board (15th-17th) with the date shown on each row. date range on the board (15th-17th) with the date shown on each row.
D4. Filters: branch, resource (contractor), service, map code, address/city, tags, notes-present. Feedback 58, 60, 61.
D5. Show route order numbers. CAREFUL: "set route order" resetting everything was his COMPLAINT, not a request — "it will reset all of them and then I have to go back in and click on them and number them again". Ours holds the change until Save.
D6. Special notes on a job such as "no email - call/text instead"; when a bulk email goes out it reports "42 of 44 sent" so he knows who lacks an email. Feedback 94.
D7. Send a document email to the selected jobs' customers from the board (e.g. "Sprinkler blowout day" with the date filled in). Feedback 59.
D8. Customisable columns: ALREADY DONE, he thanked us.

## E. SMS (24:12-26:15) PROMISED by Koby
E1. Free texting: each contractor gets a forwarding number so replies go to the contractor, not the office, and the customer never sees the contractor's real number. Design it, build what is possible without a paid subscription, and be honest about what needs a provider.

## F. Accounting / invoices (29:42-33:08)
F1. Completed jobs land in "incomplete/un-invoiced invoices" where he VERIFIES before sending: change service, invoice description, service date, rate, quantity; add notes to the customer; add missed jobs/services; see account balance vs invoice balance vs total. Feedback 35, 66, 70, 112.
F2. After verification an invoice goes to "invoices to email" or "invoices to print" depending on the customer delivery preference; email uses a document template ("Bison bill") with the disclosures; then it sits in open invoices with days past due, how they pay, status filter (past due).
F3. Payments and credits are searchable. Unapplied/prepaid/overpaid payments report, apply them to invoices.
F4. Audit trail on the invoice and on everything.

## G. Automations (33:18-35:21)
G1. Past-due: 2 days after the due date send the "past due" document; 15 days after that send "final notice". Feedback 32, 84.
G2. Seasonal notices: "turn up your sprinklers" in early summer, a fall notice on September 1, to everybody.
G3. Estimate follow-ups (feedback 33): 2 days after sending, then "don't forget us" 7 days later.
G4. Adding an automation must be easy for him.

## H. Email activity (35:24-36:22)
H1. For each bulk send: delivered count, opened count, click through to who.

## I. Team / access / GPS (36:37-38:47)
I1. Contractors with access levels: full user, partial, mobile-only. A second full user without QuickBooks access. Feedback 50, 51, 73, 75.
I2. GPS: see where a contractor is on the dispatch map (at the house / en route). PROMISED by Koby. Purpose: office answers "where is my guy" without calling the contractor.

## J. Reports and search (39:32-42:37)
J1. Reports he uses: P&L (QuickBooks), bounced emails, unapplied payments. Export by date range.
J2. Custom reports by asking in plain English: jobs skipped/cancelled per contractor and revenue lost, sqft per week, revenue per week per contractor.
J3. Global search box that searches clients, former clients, tickets, invoices, payments at once. Quick-add button for client/lead.
J4. Alerts: estimate accepted, invoices sent, customer unsubscribed.

## K. Client account (43:04-49:12)
K1. Property-manager MASTER account with related properties: each property has its own invoices, the master sees the total balance. Feedback 96.
K2. Notification email vs billing email (CPA). Do-not-email checkbox that stops every bulk email. Additional contacts (name, phone, email, birthday). Feedback 118, 96.
K3. Sales details: source (with add-a-source), referred by (a client).
K4. Billing: billing email required for email delivery, else print/both; how they pay; terms net 15 / net 30 / due on receipt; invoice frequency (he named daily, weekly, monthly — bi-weekly came from a truncated transcription); billing address copies from service address until changed; map code; branch (Idaho/Washington).
K5. Latitude/longitude tag for new-construction addresses so contractors can navigate. Feedback 26.
K6. Office notes on the front of the account; custom fields per property (Turf sqft etc.). Tags.

## L. Documents (49:14-53:01)
L1. Documents in categories client / marketing / estimate, built from a template with the logo, company fields and client fields auto-filled, body editable. Used from the client Send button, the dispatch board, the waiting list, and automations. Feedback 77, 79, 87.

## M. Jobs on the client account (53:07-58:08)
M1. Tabs: all jobs / upcoming / history, with amounts; click into a job: who did it, job notes (preset, the contractor must open them before starting the job), notes the contractor entered, notes to the client, invoice description, products added.
M2. Products/parts/fees preset (bag fee, sprinkler parts) with quantity entered by the contractor, total flows to the invoice. Feedback 69.
M3. Accounting tab: payments and invoices with remaining balance; add payment; delete invoice/payment. Feedback 100.
M4. Open estimates list; contracts (annual amount divided over 8 or 12 months). Feedback 101.
M5. Activity timeline (visits, events, transactions) with date range; notes open/closed (open ones surface on the day view); photos and attachments on the account; tickets on the client tab. Feedback 88.

## N. Assigning services to a client (58:19-64:37)
N1. Recurring job: weekly, bi-weekly (odd/even weeks), MONTHLY (week 1 / week 4); assigned contractor so it is always on their board; rate; notes the contractor sees first. Feedback 28, 29, 82.
N2. Waiting-list job: date window, contractor optional, price auto-fills from the client field via the matrix — in SA this one WORKS ("this will autofill as long as the client field is filled"). The rate that fails to populate, and annoys him, is on PACKAGE jobs: "the rate I don't know why it doesn't populate... so I have to go in and click on these every time I create a new one".
N3. PACKAGE jobs auto-renew each year (the official transcript says "Package jobs"; the local one misheard "Active jobs", and the spec then generalised it to every assigned service); window can be rescheduled; edit price and billable hours; a DISCOUNT that shows as its own line on the invoice; package notes with a date range; per-service history and upcoming; retail total vs discounted total; pause/suspend a service or package (restart when paid or on a date). Feedback 102, 107, 108, 109, 110.
N4. Time-billed services (cleanups, pruning, sprinkler repair): start/stop time on the job, price adjusted afterwards; fixed-price services (mowing, aeration, sprinkler turn-on/blowout/backflow/timer) keep their rate.

## O. Packages
O1. A package may contain the same service more than once (sprinkler timer adjustment x4, core aeration = aeration x2). Feedback 72, 114.
O2. Cancel waiting-list jobs after a package is assigned when the window has passed. Feedback 115.

## P. Adam's written checklist (Google Doc "Notes for google meet CRM", shown 64:54-65:40)
Section "Other":
P1. Audit trails track any update within the option provided (example: who added a package).
P2. Take pictures from the field and save them to the customer profile (he has 10 GB in SA today).
P3. Backflow test information per customer (David Ramsey example) — the backflow test documents in the CRM Bison folder.
P4. Use automation. SA workflow.
P5. Dispatch board: select all, or select some, and see the selection on the board/map.
P6. Estimate templates with a cover document.
P7. After an email is sent, see whether they opened it, with date and time; post unopened emails to the account; automation that tells the admin about unopened invoices/emails.
P8. Work offline through an app.
P9. Team: add info on employees — birthdays, hire date, payroll options, manager, branch, status, I-9, marital status, spouse, emergency contact, dependents, sales quota by month, photo; delete an employee; W-4 / W-2 / 1099; multiple admins.
P10. Document crew members on clean-ups; add crew members to a day.
P11. Recent activity in a horizontal view.
P12. Dispatch board: pick a month or a span of time, not only a day.
P13. Contractor on the dispatch board shows a NAME, not an email address.
Section "Service":
P14. Package listing on the account based on the window of start times.
P15. Date-window services are automatic, not recurring.
P16. When service info changes, ask whether to push the change to already-assigned jobs/customers.
P17. Putting a package on an account pre-fills start and stop dates from the services.
P18. Job start/stop time status set automatically when the contractor is driving.
P19. After clocking out the contractor can view the invoice, with an option to turn that off per contractor.
P20. In the matrix, make the full cell visible (numbers get cut off). Bison app: unable to see all of From/To. Feedback 113.
P21. Copy a matrix from one service to another; use one matrix with the base multiplied by Y for another service.
P22. Rate matrix rule: $X per 1000 sqft up to Y; Bison application: $X per 500 up to Y. Feedback 36.
P23. Jobs board for additional work not yet assigned to contractors, with admin limit/filter on access.
P24. Click the service row to open it instead of hunting for the edit pen.

## Q. Corrections and declines, from the platform's official transcript (added 2026-09-25)

The spec above was written from a local whisper transcription, before the
meeting platform's own transcript existed. Read against the official one, these
are the differences worth knowing.

Q1. **He declined satellite measuring, twice.** He raised that "some contractors
use the satellite view because they can measure properties from here", then:
"I don't do that because it's very inaccurate... my numbers are too far off",
and after the Google commercial-licence cost came up, "Nope. Don't worry about
it." His reasons for preferring to measure on site: "One, I'm more accurate. And
two, I am actually out in the field and I'm meeting people... adds way more
value." Pulling square footage from city permit records was his *condition* for
satellite measuring being useful, and died with it. He did endorse it as a paid
add-on for OTHER companies on the platform: "having that option for people like
myself to purchase and add that fee onto your guys' subscription... even at
1,200 bucks, that's actually pretty cheap." A product idea, not a Bison feature.

Q2. **He has no use for the HR record in section P9.** P9 came from his written
doc; on the call he said of the employee fields "This is going to be useful
information for people that have employees. I have no use for it, but I can see
where down the road somebody would use it", and of timesheets and payroll, "I
don't do any of that because I don't have any employees." Build it for the
platform, not for him.

Q3. **Lukewarm, do not spend a track on these.** Assets/equipment on a job
("if they have certain mowers and stuff, this could be handy"); My Day ("I
really don't use"); the website builder ("I already have one"); target hours on
a service ("we haven't got that far into our business"); sales priority and
salesperson ("since I'm the only salesperson, I don't really use this" — but he
DOES use source and referred-by from that same panel).

Q4. **Two numbers to confirm with him rather than guess.**
- The past-due trigger. He said both "two days after the bill is being sent" and
  "two days after it's due" within four sentences. We built it off the due date.
  With Net 15 those are thirteen days apart.
- The spring sprinkler notice date. He gave a date only for the fall notice
  ("We'd like that to be like September 1st"); for spring he said only "in the
  spring and in the kind of late early summer". The seeded rule guesses 06-15.
  It ships switched off, so no letter has gone out on a date he did not choose.

Q5. **Where the official transcript is the wrong one.** It renders his recurring
options as "On the weekly, it's either odd or even"; the local transcription has
"bi-weekly or weekly. On the bi-weekly, it's either odd or even", which is
plainly right, since odd/even weeks only mean anything for bi-weekly. N1 stands.
The official transcript also captures none of his Google Doc, so P1-P24 rest on
the screen frames alone — check them against the Doc in his Drive before
building from them.
