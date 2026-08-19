---
name: Generated schema compatibility
description: Durable compatibility rules for generated validation schemas and parameter names
---

Keep the schema generator and validation library on compatible major versions.

**Why:** Generated schemas may use APIs unavailable in an older validation-library major, causing failures only after regeneration.

**How to apply:** Check generated output compatibility whenever either dependency's major version changes.

Avoid giving one operation both path and query parameter groups that generate the same exported type name.

**Why:** Separate generated barrels can emit colliding exports for the two parameter groups.

**How to apply:** Use distinct operation/parameter names, split the operation, or move one input group into a request body.
