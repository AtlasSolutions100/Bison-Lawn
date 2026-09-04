# Task: move Clerk from the development instance to a production instance

Status: **deferred, deliberately.** Written 2026-09-03 after the invoice deploy
put the dev-key warning on a live public URL; on the same day the owner decided
to stay on development keys until Adam confirms the app works the way he wants.
That is a reasonable call — he is still sending feedback daily, the swap wants a
DNS change on a domain hosted elsewhere, and every account migration risk below
is easier to take once at the end than twice.

**What makes it urgent again:** the moment real crew accounts start being
created. A Clerk development instance caps users, so the wall arrives without
warning. Revisit when Adam signs off, or sooner if more than a handful of
contractors are invited.

## Why this is a real deadline, not tidying

The production bundle currently loads Clerk with `pk_test_…` (instance
`aware-walrus-1127`). The browser console on
<https://bisonlawncare.workoptional.tech> says so on every page load:

```
Clerk: Clerk has been loaded with development keys. Development instances have
strict usage limits and should not be used when deploying your application to
production.
```

This was a deliberate choice while the app was being tested — `HANDOFF.md`
records it as such — and it is still the right choice for a demo. It stops being
the right choice the moment Adam's crew sign in for real, because a Clerk
development instance:

- **caps users.** Dev instances are limited (Clerk's published cap has been 100
  users); the crew plus every `@example.com` account the automated suites have
  left behind all count against it.
- **shows Clerk's dev banner** on the sign-in card. Adam's crew will see
  "Development mode" on the screen they log into their job with.
- **is rate-limited**, and the limits are not the production ones.
- **shares its user list with our testing.** The test suites sign up accounts on
  this same instance. Adam's real staff would live alongside them.

## The specific trap: this is a rebuild, not a restart

`VITE_CLERK_PUBLISHABLE_KEY` is a **build argument**, not a runtime variable:

```dockerfile
# Dockerfile
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
RUN test -n "$VITE_CLERK_PUBLISHABLE_KEY" || (echo "… is required" && exit 1)
```

Vite inlines `import.meta.env.VITE_*` into the JS bundle at build time. Editing
`.env.deploy` and restarting changes the server's key and leaves the **browser**
on the old one — an app that loads, looks fine, and signs nobody in. `deploy.sh`
already uses `up -d --build` for exactly this reason; do not shortcut it with
`docker compose restart`.

Both keys must change together. A `pk_live_` frontend against an `sk_test_`
backend fails at token verification, which surfaces as a signed-in user getting
401s from every API call rather than as an obvious key error.

## Steps

1. **Create the production instance in Clerk** (or promote the existing one) and
   set its allowed origin to `https://bisonlawncare.workoptional.tech`.
2. **Configure sign-in methods to match the dev instance** — Google OAuth and
   email are both enabled today. A production instance starts fresh; Google OAuth
   in particular needs its own credentials, and Clerk requires custom OAuth
   credentials for production (the shared dev Google app is dev-only).
3. **Add the DNS records Clerk asks for.** A production instance wants CNAMEs on
   the app's domain (`clerk.`, `accounts.`, plus DKIM records for its email).
   These are on `workoptional.tech`, which per the runbook is hosted elsewhere and
   points at a different IP — so whoever holds that DNS has to make the change.
   Certificate issuance is not instant; do this first, not last.
4. **Update `.env.deploy` on the server** — all three, together:
   ```
   CLERK_PUBLISHABLE_KEY=pk_live_…
   CLERK_SECRET_KEY=sk_live_…
   VITE_CLERK_PUBLISHABLE_KEY=pk_live_…
   ```
5. **Rebuild**: `bash /root/bisonlawn/deploy/deploy.sh`. Nothing else; the script
   already forces `--build`.
6. **Confirm the console warning is gone** on a hard reload, and that the
   sign-in card no longer shows "Development mode".

## After the switch — the part that will bite

**Every existing account is invalidated.** Clerk user ids are per-instance, and
`users.clerk_id` in our database points at dev-instance ids. After the swap,
signing in creates a *new* Clerk identity, so `requireAuth` provisions a **new
local app user** rather than matching the existing row.

This is mostly handled: `resolveAccountForClerkId` keys accounts on the person's
**verified email**, not the Clerk id, and `mergeAccountsForEmail` folds a
duplicate back together. So a user who signs into the production instance with
the same verified email address lands back on their existing account, role and
history intact.

Two ways that still goes wrong, both worth checking deliberately:

- **A different email.** Someone who signed up as `bob@gmail.com` on dev and
  signs into prod with `bob@bisonlawncare.net` gets a fresh contractor account
  and loses their role. Owners are safe — `APP_OWNER_EMAIL` and
  `APP_SECONDARY_OWNER_EMAIL` re-grant admin on any verified match — but
  contractors promoted by hand from `/team` are not.
- **An unverified email.** Owner access is only ever matched against a
  Clerk-*verified* address, deliberately. If the production instance has not
  verified the owner's address yet, the owner signs in as a contractor and
  cannot reach `/team` to fix it.

So: **verify the owner email on the production instance before the swap**, and
list the promoted contractors from `/team` beforehand so their roles can be
restored.

## Cleanup this unblocks

`HANDOFF.md` notes the dev instance is accumulating `@example.com` accounts left
by the automated test suites. Once production is on its own instance, the dev
instance can be wiped without touching anyone real — which is also the right
moment to stop the suites polluting whatever instance they run against.

## Not doing this yet, deliberately

Nothing about the current invoice work needs it, and the swap wants DNS access
and a chosen maintenance window. It is written down here so it does not get
found by Adam hitting a user cap on a Monday morning.
