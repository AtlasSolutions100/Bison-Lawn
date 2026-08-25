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

## A delivery claim needs a timestamp and an expiry, or it becomes a permanent lie
Any state that means "a provider call is in flight" must be stamped with when it was claimed, and a claim
older than a short window must be aged out into a distinct terminal-ish state (e.g. "abandoned") that reads
as unresolved work.

**Why:** The claim is written before the provider call and the outcome after it. A crash or restart between
the two leaves the row in the in-flight state forever, and the office reads an in-flight badge as "it is
happening" rather than "nobody knows what happened".

**How to apply:** Stamp the claim time in the claiming transaction; sweep expired claims when the list is
read (treat a null claim time as expired, for rows written before stamping existed); keep the in-flight and
abandoned states visually distinct. Scope every outcome write to its own claim (id + claim timestamp +
allowed prior states) so a late-finishing send can still correct its own abandoned row but can never
overwrite a newer claim.

## Missing contact details are a state, not a silent skip
A customer with no email on file gets an explicit "no_email" delivery state rather than being skipped
quietly.

**Why:** Silent skips make the office believe a customer was notified when they were not.

**How to apply:** Model unreachable recipients as a first-class delivery state and show it wherever the
delivered states are shown.


## Retrying a notification re-claims from a terminal failure state
A manual retry is allowed only from a terminal "nothing was sent" state (failed, or unreachable-recipient
once contact details exist). The retry transaction moves that state back to "sending" under a row lock
before touching the provider, exactly like the original approval did.

**Why:** A delivered message must never go out twice, and two people clicking retry must not both reach the
provider. Reusing the same claim gate keeps one code path responsible for who may send.

**How to apply:** Reject retries from delivered or in-flight states with distinct errors, claim inside the
transaction, then reuse the same send-and-record helper the first attempt used. Audit the attempt itself in
addition to its outcome, so the trail shows how many times the office tried.
