---
name: Charge presets are copied templates
description: Why reusable estimate charge presets must never become foreign-key references from estimate lines.
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
