---
name: Estimate delivery reliability
description: Durable security and state-transition rules for emailed customer response links.
---

## Customer response links
Bearer response tokens must be redacted from request logs. Opening an email link must be read-only; require an explicit POST confirmation before accepting or declining.

**Why:** Email security scanners prefetch links and can otherwise accept/decline an estimate without the customer. Hashed database storage does not protect a token leaked through request logs.

**How to apply:** Keep GET confirmation-only, compare-and-set the terminal response on POST, and redact the capability segment in all application request logs.

## Mutability window
An estimate's lines, notes, and total are only editable while it is a draft AND no delivery is in flight (delivery state not sending/provider_accepted). Every write reprices lines from the current field/service definitions rather than trusting submitted prices, and re-checks the draft state inside the UPDATE's WHERE clause.

**Why:** Once a customer has been emailed the PDF, the numbers they saw must match what is stored; a send claimed between the read and the write would otherwise email one set of figures and keep another.

**How to apply:** Reject non-draft edits with 409, block edits during a claimed delivery, and make the update compare-and-set on status plus delivery state.

## Reliable retries
Keep the active response token separate from a pending delivery token. A resend claim must not replace the active token until Gmail accepts and the delivery state finalizes.

**Why:** Failed retries must not invalidate links from an earlier successful email. A customer can also respond through the old link while a resend is in flight; finalization must preserve that terminal decision.

**How to apply:** Serialize sends with persisted sending and provider-accepted states, hash-guard claim/release/finalize transitions, preserve accepted/declined status during resend races, and reconcile provider-accepted or confirmed interrupted sends without issuing a duplicate.