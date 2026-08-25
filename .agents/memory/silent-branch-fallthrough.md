---
name: Optional fields must not select a branch
description: Why a guard like (mode === 'x' && field1 && field2) silently produces wrong data, and why native form validation hides the missing server check.
---

Never let the presence of an optional field decide which branch of a write runs.
A guard shaped like `if (mode === "recurring" && firstDate && frequency) { ... } else { ...one-off... }`
does not reject a bad request — it quietly performs a *different, valid-looking* write.

**Why:** This exact shape shipped in the service-assignment route. The UI sent a
mis-named date field, so the recurring branch's condition failed and every recurring
assignment fell through to the one-off branch, creating a single undated job. Nothing
errored, nothing logged, and the office only noticed because crews were never scheduled.
A missing required field must produce a 4xx, never a different branch.

**How to apply:**

- Validate the discriminator's required fields explicitly and return an error. Do not
  fold them into the branch condition.
- Validate **before** the first write, and wrap multi-row writes in one transaction.
  Validation that happens inside a per-item loop leaves earlier items committed.
- Range-check anything that drives a loop. A frequency of `0` or a negative number
  passes an integer schema and a truthiness check, then generates a run of wrong rows.
- Date strings need real calendar validation (format *and* round-trip). An invalid
  string survives schema checks and only throws later at `new Date(...)`, mid-write.

**Testing note:** a browser test cannot prove the server guard exists. An HTML `required`
attribute blocks submission first, so the request never leaves the page and the test
passes whether or not the server validates. Always exercise these guards by calling the
API directly with the authenticated session.
