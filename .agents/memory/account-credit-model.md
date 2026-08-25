---
name: Account credit is an unattached payment
description: How overpayment, credit on account, and invoice voiding are modelled in the billing tables, and the locking rule that keeps balances correct.
---

A payment row whose `invoiceId` is NULL **is** unapplied credit on that client's account.
There is no separate credit table, no credit column, and no extra invoice status.

**Why:** Credit is money already received. Modelling it as anything other than a payment
means two places can disagree about how much the client has paid, and reconciliation
against the bank becomes guesswork. Keeping it as a payment row makes
`sum(payments)` the single truth for money received, whatever it is currently attached to.

**How to apply:**

- Overpaying an invoice applies only what fits and writes the excess as a *second*,
  unattached payment row. The invoice never records `amountPaid > total`.
- Applying credit splits the credit row rather than moving it, so any leftover stays
  unattached. Applying is guarded by a row lock on the credit so two clicks cannot
  spend the same money twice.
- **Voiding an invoice must detach its payments** (set `invoiceId` to NULL), turning them
  back into credit. The balance is `sum(non-void invoice totals) - sum(all payments)`, so
  an attached payment on a void invoice drops the total out of the sum while the payment
  stays counted — inventing credit nobody ever paid.
- The client balance is a **read-then-write aggregate**, so every writer must lock the
  client row before recomputing it. Without that, two payments against *different*
  invoices of the same client each sum a partial payment set and the later writer
  persists a stale total. Row locks on the invoice alone do not protect this.
- Recomputation must happen **inside the same transaction as the write it derives from**.
  A recalc that runs after the transaction commits leaves a permanently stale balance if
  the process dies in the gap, and it races other writers.

## Lock ordering

The order is **(job) → invoice → payment → client**, and every money path must follow it.

**Why:** a bulk `UPDATE payments WHERE invoiceId = ...` takes row locks on those payments
even though it is not written as `FOR UPDATE`. Voiding therefore goes invoice → payment.
A delete path that locked the payment first and then its invoice closed a real cycle and
Postgres aborted one side. The lock a statement takes is not always the lock you wrote.

**How to apply:** when a route needs a lock on a row it can only find *through* another
row, read the pointer unlocked first, lock the parent, then re-read the child under its
own lock and re-check that the pointer still holds. If it changed while you were
acquiring, retry the transaction rather than grabbing the second lock out of order.
