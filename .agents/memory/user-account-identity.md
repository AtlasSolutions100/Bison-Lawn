---
name: User account identity model
description: App accounts belong to a person (verified email), not to a Clerk identity; how linking, merging, and role changes must behave.
---

# Accounts are keyed on the person, not on the sign-in method

An app account represents a **person**, identified by their Clerk-**verified**
primary email (trimmed, lowercased). Every Clerk identity the person signs in
with (email/password, Google, ...) maps to that one account through an
identity mapping table; the account row also keeps its original primary Clerk
id for backwards compatibility.

**Why:** keying accounts on the Clerk identity created a second row whenever
someone signed in a different way, both with their own role. Demoting or
removing a person then only changed the row that was clicked, and they kept
admin access through the other sign-in method with nothing to indicate it.

**How to apply:**
- Any role/access change must apply to *every* row for that person (match on
  the normalized email), not just the row addressed by id.
- Never link or merge on an **unverified** email, and never store an unverified
  address on an account row — otherwise signing up with a colleague's address
  inherits their access. Unverified sign-ins get their own, email-less account.
- Merging duplicates keeps the **oldest** row (references and history point at
  it), repoints every user foreign key to it, and takes the **strongest** role
  among the merged rows. Weakening access during a merge risks locking the
  configured owner out of their own app; taking access away is a deliberate
  action from the team page instead.
- Duplicate cleanup is idempotent and self-healing: it runs at server startup
  and when provisioning an unknown identity, serialized with a Postgres
  advisory lock on the email so simultaneous sign-ins cannot re-create a pair.
  Cleanup is deliberately *not* a database unique index, because a deploy-time
  schema push against a production table that still has duplicates would fail.
- An admin must not be able to demote their own account (or another account of
  the same person): they would lose the team page and could not undo it.
