# Adam's notes doc, as of 2026-09-28

Source: his Google Doc "Notes for google meet CRM", last edited 2026-09-28 at
20:59, four minutes before he emailed "Just following on progress... The flow
and the operation of accessing needed stuff is not convenient yet."

He keeps this doc himself and ticks items off, so the `Complete` section at the
bottom of his doc is **his** verdict on our work, not ours. Everything below is
what was still unticked, grouped the way he grouped it, with a note on what we
found when we went looking.

Quoted text is his. Where his speech-to-text wrote "beagle" he means "be able".

---

## Bugs he has reported

B1. **"When creating an estimate the numbers don't match the matrix based on
clients account — example 615 E 18th."** His own property. Reproduce against
that account before changing anything.

B2. **"Accepted Contractor not popping up on dispatch board."** A contractor who
accepted an invitation does not appear where he expects to assign them.

B3. **"Creating invoice needs to show up on clients account."** An invoice he
raises is not appearing on the customer's account.

B4. **"Add/edit Team member — Eich did not receive email."** Adam Eich's
invitation. Note he did accept on 2026-09-14, so this may be stale, but it is
his report and the send path should be proven either way.

B5. **"Document comes from Koby, needs from Bison Lawn Care."** Letters and
invoices reach his customers showing Koby's address as the sender. His
customers should see his company.

## Invoices and money

M1. **"Ability to unlock invoice after being sent out to make changes and edit
invoice."**

M2. **"Jackie Wagner — beagle to get rid of balance, via written off and turned
into collections."** A balance he will never collect needs a way out that is not
a silent delete: written off, or passed to collections, and visible as such.

M3. **"Take payments in the field under invoices with fee percentage."** The
card fee already exists on a payment; he wants the contractor able to take one.

M4. **"When creating invoice having ability to search by info on clients account
and when adding service to bill pulling info from matrix based on customer
account."**

M5. **"Admin see running total for customer."**

## The rate matrix

X1. **"My starting field on matrix has a min and then from there the Price
equation need to take over but I cant set a base."** He wants a minimum charge
and a base the equation builds from.

X2. **"Beagle to see all of the rate matrix without having to scroll over"** and
**"In Bison app — unable to see all of from=to."**

X3. **"In Coping of service matrix to another, be able to add additional dollars
(product) based on square footage to original price (ex, Aeration + seed = AE
overseed) or Top dressing (beagle to add topdressing cost, product cost/sqft +
delivery + Trailer)."**

X4. **"Ability to extract matrix from crm to excel"**, and its pair, feedback
#42, importing one from Excel ("Example in google drive (top dressing)").

## Services and packages

S1. **"Making changes to service info. Ask if want to push on to current
assigned jobs/customers."**

S2. **"When Creating packages does not need year as they will be renewed every
year and have the same date window of service."**

S3. **"Renew date is not client specific but Product based."**

S4. **"Season End date will be the same for all mowing clients. If some decide
to end earlier having the ability to cancel upcoming or future jobs."**

S5. **"Package listing on account based on window of start times"** — order them
by when they start.

S6. **"Mowing jobs stay on account with last year's details."**

S7. **"Jobs board for additional work not yet assigned to contractors, admin
limit access/filter."**

## The customer's account

C1. **"Show all clients on map."**

C2. Sub accounts: **"When adding a sub account. Have the previous one unviewable
instead of greyed out"**, **"Former clients — restrict ability to add to as sub
account"**, **"List sub account in alpha numeric order."**

C3. **"Create a tag list for drop down selection, ability to add multiple
tags."** Today a tag is free text, so a typo makes a second tag.

C4. **"Activity on account most receipt to latest"** — most recent first.

C5. **"Billing, Property details all in button on editing client."**

## Email

E1. **"Central location for all emails that when out at the same time, not just
in clients account, List with clients name and information"**, with
**"Delivered opens up to customer account"** and **"Results, completed."**

E2. **"Post unopened email to account."**

E3. **"Automation sent to admin for unopened invoices/emails."**

E4. **"When sending emails — having an option to use AI for clarity and
professionalism, currently use chatgpt. Like in GMail"**, and **"Be able to Copy
and paste ChatGPT creation into Doc or have an AI version in CRM."**

E5. **"Be able to make document info bold, underline, italic ext Word Doc
features."** Bold, italic and bullets shipped 2026-10-03; underline did not.

## The dispatch board

D1. **"Going to the dispatch board. After leaving to another screen. When coming
back would be nice to come back to same screen that I left."**

D2. **"Show all contractors jobs on the dispatch board automatically when
opening the dispatch board, then if I want to select individual ones I have the
option."**

D3. **"Ability to adjust route and save manually without having to redo all the
numbers."** Pressing Set route order no longer wipes anything (fixed
2026-10-03), but he wants to change one stop's number without redoing the run.

D4. **"Dispatch board — columns search using custom fields."**

D5. **"Job start and stop time status when the contractor is driving
automatically."**

D6. **"After clocked out beagle to view invoice with option to turn that off per
contractor."**

D7. **"Document crew member on clean ups, add crew members to day."** More than
one person on a job.

## Reports

R1. **"Cash report"** and **"Accrual report"** — the two he actually used in his
old system.

R2. **"Time to complete jobs."**

R3. **"Spread of crews."**

R4. **"Sqft in a day per crew"** (we have per week).

## Settings

G1. **"Ticket Categories, Account Issue, Billing, Cancel Request, Change
Service, Email, Estimate, other, Reschedule request, Review, Schedule Service,
Terminate service, Upsell, Marketing."** His exact list.

G2. **"Add Customer Field Effects all Clients."**

G3. **"Customer Lines — Products, Examples. Small bags, pinecones, beagle to add
to with sprinkler parts."**

G4. **"Signed estimates to send to management companies."**

G5. **Spring letters: "Some options select all and some custom prices, some
increase %."**

## Questions, not builds

Q1. **"Spray runs — What is this?"** A page in his own navigation he does not
recognise. Either the name is wrong or it should not be there.

Q2. **"David Ramsey — backflow information."** Unexplained; ask him.

Q3. **"Be able to work off line through an app?"** A web app cannot; this is the
one item that argues for a native app.

Q4. The employee HR record (W-4, W-2, 1099, I-9, marital status, dependents,
sales quota) is in his doc but he said out loud on the call, "I have no use for
it." Confirm before building.
