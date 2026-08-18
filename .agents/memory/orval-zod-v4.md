---
name: Orval zod v4
description: Codegen pitfalls with orval v8 + zod in this monorepo
---
- Orval v8's zod client generates zod v4 API calls (`zod.int()`), which fail against zod v3. **Why:** the pnpm catalog originally pinned zod ^3.25; codegen typecheck broke. **How to apply:** keep the `zod` catalog entry at ^4 (drizzle-zod ^0.8 supports it).
- An operation with BOTH path and query params makes the zod bundle export `<OpId>Params` (path) while the types bundle exports `<OpId>Params` (query) — ambiguous re-export in lib/api-zod. **How to apply:** avoid mixing path+query params on one operation (use a POST body or split), or rename.
