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
D3. Map with a colour per contractor; date range on the board (15th-17th) with the date shown on each row.
D4. Filters: branch, resource (contractor), service, map code, address/city, tags, notes-present. Feedback 58, 60, 61.
D5. Show route order numbers; "set route order" resets and lets him renumber.
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
K4. Billing: billing email required for email delivery, else print/both; how they pay; terms net 15 / net 30 / due on receipt; invoice frequency (daily/weekly/bi-weekly/monthly); billing address copies from service address until changed; map code; branch (Idaho/Washington).
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
N2. Waiting-list job: date window, contractor optional, price auto-fills from the client field via the matrix (SA fails to populate; ours must).
N3. Active/assigned services auto-renew each year; window can be rescheduled; edit price and billable hours; a DISCOUNT that shows as its own line on the invoice; package notes with a date range; per-service history and upcoming; retail total vs discounted total; pause/suspend a service or package (restart when paid or on a date). Feedback 102, 107, 108, 109, 110.
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
