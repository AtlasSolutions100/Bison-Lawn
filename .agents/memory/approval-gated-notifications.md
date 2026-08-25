---
name: Approval-gated customer notifications
description: Rules for emailing a customer message that an admin approved alongside a state change.
---

## Claim delivery inside the approving transaction
The same transaction that flips a reviewed item from pending to approved must also record the delivery
intent ("sending"). Send the email only after that transaction commits.

**Why:** The pending → approved transition is the only concurrency gate. If delivery is decided outside it,
two concurrent approvals can each hand the same message to the mail provider. Sending inside the
transaction is worse: the provider call is not rollback-able and would hold row locks over network latency.

**How to apply:** Compute the delivery state (not_applicable / no_email / sending) in the transaction,
then perform the provider call and persist sent/failed afterwards.

## A failed notification must not undo an applied change
An email failure is recorded as a failed delivery and surfaced in the UI; it never rolls back the schedule
or state change that was already applied, and it never turns the request into an error response.

**Why:** The operational change (job moved or skipped) is already true in the business. Reverting it to make
the request "clean" would desynchronize the office from the crew's actual schedule.

**How to apply:** Return success with a visible delivery status, write the failure to the audit trail, and
tell the office to contact the customer directly.

## Missing contact details are a state, not a silent skip
A customer with no email on file gets an explicit "no_email" delivery state rather than being skipped
quietly.

**Why:** Silent skips make the office believe a customer was notified when they were not.

**How to apply:** Model unreachable recipients as a first-class delivery state and show it wherever the
delivered states are shown.
