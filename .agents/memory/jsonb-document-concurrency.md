---
name: JSONB document read-modify-write
description: Why every read-modify-write of a whole-document JSONB column (clients.property_data and friends) must lock its row first
---

Any handler that reads a whole JSONB document column, merges keys in JS, and writes the
document back must take `SELECT ... FOR UPDATE` on the owning row inside the same
transaction (Drizzle: `.for("update")`). Do the row's existence check with that same locked
read instead of a separate unlocked select.

**Why:** The column is one value, not a set of independent keys. Two concurrent requests
that each touch a *different* key both read the old document and the later commit rewrites
it wholesale, silently dropping the earlier one's key. A transaction alone does not prevent
this — it makes each write atomic, not serialized. This pattern shows up wherever the CRM
stores per-entity blobs (saved property details, settings-style maps).

**How to apply:** Reach for the lock (or a database-side `jsonb ||` merge) whenever a write
path is "load blob → spread → set". Cover it with an integration test that fires two
concurrent requests updating distinct keys and asserts both survive; a single-request test
passes either way.
