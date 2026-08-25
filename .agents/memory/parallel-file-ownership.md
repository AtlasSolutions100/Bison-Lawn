---
name: Parallel subagent file ownership
description: How to split a multi-feature build across parallel subagents without merge conflicts — feature independence is not file independence.
---

Before fanning work out to parallel subagents, partition by **file ownership**, not by
feature. Two features that sound unrelated routinely land in the same shared files
(DB schema, the OpenAPI spec, route registration, nav, the app's route table), and
parallel agents editing those produce conflicts or silent clobbering.

The structure that works here is three phases:

1. **Serial, done by the main agent alone:** every shared/contended file. Schema
   changes and the DB push, the API contract plus codegen, route registration, nav
   entries, app routes, and empty page/route stubs for each new feature.
2. **Parallel subagents:** one per feature, each given a strictly disjoint list of
   files it owns — typically its own route module, its own lib helpers, and its own
   page. An agent that needs to touch a file it does not own must be told to route
   the change back through the main agent instead.
3. **Serial again:** integration, typecheck, tests, and browser verification.

**Why:** a previous attempt scoped many "independent" tasks that all converged on the
same two files and had to be redone. Phase 1 removes contention up front, so the
parallel phase has nothing to fight over.

**How to apply:** when a request bundles several features, list the files each one
will touch *before* delegating. Anything appearing in two lists moves into phase 1.
Deliberately steering a feature away from a file another agent owns (reusing an
existing endpoint rather than adding one to a contended module) is a legitimate and
often cheaper design choice than adding coordination.
