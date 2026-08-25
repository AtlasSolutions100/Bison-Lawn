---
name: Field payment accounting
description: Rules for on-site payments, card surcharges, and payment/completion concurrency in the CRM billing flow.
---

Any surcharge collected with a payment (e.g. card processing fee) must also be added to the invoice total; never record a payment larger than the sum of its charges.

**Why:** Code review rejected a version where a $103 card payment against a $100 invoice produced an unexplained $3 customer credit — recalc helpers derive amountPaid and account balance purely from invoice totals vs payment sums.

**How to apply:** Store the fee portion on the payment row; bump the invoice total in the same transaction when attaching, and have job completion fold pending payments' fees into the invoice it creates.

Payments recorded before a job is completed must carry a job reference and be attached atomically when completion creates the invoice, and both handlers must serialize on the job row (SELECT ... FOR UPDATE) or a racing payment lands detached forever.

**How to apply:** Lock the job row in every handler that reads job.invoiceId to decide payment attachment; test the race by holding the lock in a test transaction while firing the API request.
