---
name: Server bundle externals
description: When a dependency must be externalized in the API server's esbuild bundle.
---

## Rule
Dependencies that load assets at runtime via package subpath imports or sibling-file reads (e.g. pdfkit's font data) must be in the esbuild `external` list; bundling them breaks only at runtime.

**Why:** esbuild cannot inline runtime subpath/file resolution, and the dev workflow runs the bundled output while tests run source via tsx — so the failure escapes the test suite.

**How to apply:** If a route works under tsx-run tests but 500s in the running workflow, suspect the bundle and externalize the offending package.
