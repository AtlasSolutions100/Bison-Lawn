---
name: Reusable templates are copied, never referenced
description: Why charge presets and service packages must be copied by value into estimates and client services rather than referenced.
---

Reusable charge presets (haul-away, dump fee, seasonal discount) are copied into an
estimate's custom lines by value — label and price only. An estimate line must never
carry a preset id or otherwise reference the preset row.

**Why:** An estimate is a document the customer has been quoted (and possibly emailed a
PDF of). If lines resolved through a preset, renaming or repricing a preset would
retroactively change what a customer was already quoted. The office renames and reprices
presets constantly across seasons, so this is a routine operation, not an edge case.

**How to apply:** Any feature that touches presets — bulk insert, preset categories,
per-preset defaults — keeps the copy-on-insert rule. Deleting a preset is always safe and
needs no cascade or usage check. Preset validation must stay identical to hand-typed
custom line validation (non-empty trimmed label, finite price rounded to cents), so a
preset can never carry a value onto an estimate the estimate itself would reject.

## Service packages follow the same rule

A package carries its own scheduling defaults (schedule type, start/end, frequency,
season end, renew date). Assigning a package **copies** those onto each client-service
row; the row keeps a `packageId` for provenance only and must never read its schedule
through it. Explicit values in the assignment request always win over the package's.

**Why:** identical reasoning — the office edits packages between seasons, and a client
already on last year's schedule must not silently be re-scheduled by an unrelated
package edit. It also means a client's schedule can be corrected individually without
forking the package.

**How to apply:** because the package can supply the schedule type, that field is
optional on the assignment request and is only required when neither the request nor
the package provides one. Resolve every inherited field before validating, then
validate the resolved values — not the raw request.
