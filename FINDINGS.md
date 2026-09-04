# Findings log

Append one line per behaviour-changing turn. Assume the next session has no context.

## 2026-08-26 — de-Replit: repo now boots on a plain machine

**Changed**
- `pnpm-workspace.yaml`: removed Replit's `overrides:` block (~75 entries pinning every
  native binary to linux-x64 by setting the others to `'-'`); set `allowBuilds` for
  `esbuild` and `@clerk/shared` to `true`.
- `pnpm-lock.yaml`: regenerated. The old one recorded `esbuild → @esbuild/linux-x64` only.
- `lib/db/drizzle.config.ts`: schema path now normalised to forward slashes.
- `artifacts/api-server/package.json`: dropped POSIX-only `export NODE_ENV=…` /
  `NODE_ENV=test …` prefixes from `dev` and the eight `test:*` scripts. Every test file
  already sets `process.env.NODE_ENV` itself, and `dev.mjs` sets it for the server.
- Added `dev.mjs`, `.env.example`; `.env` added to `.gitignore`.

**Fixed**
- `pnpm install` failed on Windows/macOS with "The package @esbuild/win32-x64 could not be found".
- `drizzle-kit push` failed with "No schema files found" (glob can't read backslashes).
- `pnpm run dev` / `pnpm test` failed with "'export' is not recognized" outside a POSIX shell.
- No same-origin `/api` route off Replit — `dev.mjs` sets `E2E_API_URL`, which is the only
  condition under which `vite.config.ts` mounts its `/api` proxy.

**Still open**
- Gmail sending goes through `@replit/connectors-sdk` (`artifacts/api-server/src/lib/gmail.ts`).
  Estimates, spring letters and weather messages cannot be delivered off Replit. No replacement yet.
- Public estimate links and CORS still key off `REPLIT_DEV_DOMAIN` / `REPLIT_DOMAINS`
  (`routes/estimates.ts:95`, `app.ts:49-53`). `APP_PUBLIC_URL` exists but is not the fallback everywhere.
- Nothing behind Clerk sign-in has been opened in a browser locally.
- 22 `subrepl-*` git remotes and branches plus a `gitsafe-backup` remote are still in the repo.

## 2026-08-26 — Phase 1: off-platform, end to end

**Changed**
- `lib/gmail.ts` now calls the Gmail REST API directly with a token from
  `lib/googleOAuth.ts` (our own `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`).
  `@replit/connectors-sdk` dropped from both package.jsons. The `GmailProxy`
  seam is unchanged, so all delivery tests still pass untouched.
- `scripts/google-oauth-setup.mjs`: one-time loopback OAuth flow that prints a
  refresh token. Scope is `gmail.send` only.
- `app.ts`: CORS allowlist is `APP_PUBLIC_URL` + optional `APP_EXTRA_ORIGINS`
  instead of `REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN`. In production the process
  now also serves `artifacts/bison-crm/dist/public` with an index.html fallback
  for any non-`/api` GET.
- `routes/estimates.ts`: dev fallback origin no longer reads `REPLIT_DEV_DOMAIN`.
- `vite.config.ts`: Replit plugins removed; the `/api` proxy now keys off
  `API_URL` (set by `dev.mjs`) as well as `E2E_API_URL` (set by the e2e harness).
- `build.mjs` added. Deleted `.replit`, `.replitignore`, `.agents/`, `.config/`.
  `replit.md` → `ARCHITECTURE.md`, de-Replit'd. 22 dead git remotes removed.
- `lib/e2e/src/harness.ts`: browser resolves via `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
  or Playwright's own install, not the Replit-only variable.

**Fixed**
- Nothing could send email off Replit.
- Production had no single-origin serving, which Clerk's cookie session requires.
- Windows builds baked a mangled `BASE_PATH` (`/Program Files/Git/`) into every
  asset URL, producing a blank page. `build.mjs` keeps `BASE_PATH` out of shells.

**Still open**
- **The Gmail path has never run against live Google.** No OAuth client exists
  yet. Covered only by tests that inject their own proxy.
- **Proposal: redirect signed-out deep links to sign-in.** `/dispatch` and every
  protected route render an empty page when signed out (`App.tsx` wraps them in
  `<Show when="signed-in">`, which renders null). This is existing intended
  behaviour — see `.agents/memory/blank-page-diagnosis.md` — not a regression. It
  is worth revisiting on a custom domain, where people bookmark deep pages and a
  blank page reads as an outage.
- Nothing behind Clerk sign-in has been opened in a browser.
- 23 `subrepl-*` branches carry commits not in `main`; kept, not deleted.
- `artifacts/mockup-sandbox` is a Replit-agent shadcn playground nothing imports.
  Proposed for deletion, not deleted.
- Nothing pushed to `origin` yet.

## 2026-08-26 — deployable: Docker stack + admin-access config

**Changed**
- `Dockerfile` (multi-stage, node:24-slim), `.dockerignore`, `docker-compose.yml`
  (app + postgres, app bound to 127.0.0.1), `.env.deploy.example`,
  `deploy/Caddyfile.example`, `DEPLOY.md`.
- `VITE_CLERK_PUBLISHABLE_KEY` / `VITE_CLERK_PROXY_URL` are Docker **build args**,
  not runtime env: Vite inlines `import.meta.env.VITE_*` into the bundle. The
  build fails fast if the publishable key is missing. Compose must therefore be
  run as `docker compose --env-file .env.deploy up -d --build`.

**Verified**
- Image builds and runs; container reports healthy; `/`, `/dispatch`,
  `/api/healthz` all correct from inside the container.
- Admin access proven: `koby@radiantaisoftware.com` in `APP_SECONDARY_OWNER_EMAIL`
  resolves to `role=admin, role_source=owner` in the DB and shows ADMIN in the
  Team UI. See `verify/2026-08-26/container-admin-crawl/`.
- Read-only crawl of dashboard, clients, estimates, builder, team.

**Still open**
- **Sender identity.** No `From:` header is set anywhere; Gmail stamps the
  authenticated account. Whoever runs `scripts/google-oauth-setup.mjs` becomes the
  visible sender on every customer email. Adam must consent from the Bison
  account before this is customer-ready.
- **Live Gmail send still untested.**
- Image is ~1.6 GB (whole installed tree ships; pdfkit is externalised from the
  bundle and drizzle-kit is needed for schema pushes). Slimmable.
- `drizzle-kit push` is the only schema mechanism; there are no migration files.
  DEPLOY.md deliberately keeps it a manual step.

## 2026-08-26 — target environment identified

Deploy target is a VPS already running `takeoff-caddy-1` (caddy:2-alpine, owns
80/443) in front of `takeoff-app-1` (8100/tcp, unpublished). Caddy is
containerised, so this stack uses `docker-compose.proxy.yml`: no host port, join
Caddy's network, and Caddy reaches it as `bisonlawn-app:8080`. The existing site
is not touched.

Domain is `bisonlawncare.workoptional.tech` (was written as `bison.` — corrected).
Container name standardised to `bisonlawn-app`.

Clerk stays on the existing development keys for now — they work on a custom
domain, with Clerk's dev banner and usage limits. No key rotation needed.

## 2026-08-26 — deploy alongside a live production stack

The target host also runs `takeoff` (caddy:2-alpine on 80/443 + an app on 8100),
serving `workoptional.studio` to ~20 clients. That constrains the deploy.

**Changed**
- `docker-compose.proxy.yml` now expects a **dedicated** shared network
  (`web-proxy`), not the proxy's own project network. Attaching this stack to
  `takeoff_default` would have made `docker compose down` in the takeoff project
  fail with "network in use" — coupling an unrelated live stack to ours.
- `deploy/RUNBOOK-srv1928610.md`: host-specific procedure with backup,
  validate-before-reload, per-step checks of the live site, and a full undo.

**Verified**
- Both compose configurations resolve: overlay yields `bisonlawn-app` on
  `default` + external `web-proxy`, zero published ports; base file alone keeps
  the `127.0.0.1` binding.

**Notes for whoever runs it**
- The takeoff Caddyfile is a host bind mount (`/home/deploy/takeoff/Caddyfile`,
  read-only into the container), so it can be backed up and restored on the host.
- `caddy reload` is atomic: an invalid config fails to load and the previous one
  keeps serving. Never `restart`.
- `docker network connect` attaches a running container with no restart.
- Remaining fragility: recreating the takeoff stack can drop the manually added
  network from its Caddy container. That 502s bisonlawn, never takeoff.

## 2026-08-26 — takeoff Caddyfile inspected; vhost tailored

The live Caddyfile at `/home/deploy/takeoff/Caddyfile` has one site block
addressed by the env placeholder `{$SITE_HOST}`, no global options block, and
proxies to the compose alias `app:8100`.

Consequences folded into the runbook:
- A trailing site block is the correct place to append; there is no global block
  to sit above.
- `{$SITE_HOST}` must resolve inside `docker exec` for `caddy validate` to pass.
  It should (exec inherits container env) but the runbook verifies it, because a
  failure there produces an error pointing at *their* block, not ours.
- Our block matches their `encode zstd gzip` order and uses `format console`,
  not json: both write to the same `docker logs takeoff-caddy-1` stream.
- No transport timeouts copied over — theirs exist for a measured 30m report
  render. Nothing here is slow.
- 25MB body cap, not their 512MB: no large-upload route exists in this app.

**Unresolved fragility:** the edit is an uncommitted local change inside
takeoff's git working tree. A `git pull`/`checkout` there reverts it, and
bisonlawn breaks on the next Caddy reload. takeoff is unaffected. Avoiding this
would need the Caddy container recreated to mount an importable `conf.d`, which
is not acceptable while it serves 20 clients.

## 2026-08-26 — takeoff side wired; two corrections taken

The takeoff owner corrected two assumptions in the earlier runbook, both right:

1. `~/takeoff` is **not** a git repo — the `git status Caddyfile` check would have
   returned a false all-clear.
2. Every takeoff deploy `scp`s `Caddyfile` from its own repo, so an appended
   vhost was **guaranteed** to be overwritten, not merely at risk. The earlier
   conclusion that "editing the file is the lower-risk option" was wrong.

Their fix, now live on the box: `web-proxy` declared as an external network on
the Caddy service in takeoff's compose, and `import /etc/caddy/conf.d/*.caddy`
backed by `~/takeoff/caddy-sites` (mounted read-only into the container,
excluded from the deploy). Both fragilities are gone — nothing survives only as
an untracked manual change.

Runbook rewritten to the drop-in model. No longer touches their Caddyfile.

**Contributed back:** `deploy/CADDY-IMPORT-FINDINGS.md`. Both sides measured that
an empty/absent `conf.d` is valid. Two cases only measured here:
- an invalid file makes `caddy reload` fail atomically (old config keeps
  serving — safe), but
- it makes `caddy run` **refuse to start**, so a bad file left in place takes
  takeoff down at the next unrelated restart, with no visible link to the change.

Hence the mandatory `|| rm` after validate, and the suggestion that the takeoff
deploy gate restarts on `caddy validate`.

**Settled:** hostname is `bisonlawncare.workoptional.tech`; DNS is live and
resolves to 31.220.50.13 (verified from this machine).

**Process note:** heredocs in this session were silently collapsing backslashes,
which put a literal two-character `backslash-n` into a runbook command instead
of a line continuation. Bash would have passed `n` as an argument to
`caddy validate`, failing it, which would then have fired the `|| rm` and
deleted the vhost file. Every fenced bash block in the deploy docs is now
syntax-checked with `bash -n`: 12 blocks in the runbook, 12 in DEPLOY.md, 0
errors. Worth re-running that check after any edit to those files.

## 2026-08-26 — SESSION_SECRET is dead config

`SESSION_SECRET` is set in the Replit environment and appears in the handover
notes, but **nothing in this codebase reads it** (grep across artifacts, lib,
scripts: zero hits). Auth is entirely Clerk, which manages its own sessions via
cookies; there is no local session store. Removed from `.env.example` and
`.env.deploy.example`, where it had been carried over unexamined.

Consequence: the value in the handover notes does not need to be transferred,
protected, or rotated for this app.

## 2026-08-27 — live Gmail send proven; two bugs fixed

**Live Gmail delivery works.** Sent through the app's real path
(`lib/clientEmail` -> `lib/gmail` -> `lib/googleOAuth` -> Gmail REST API), not a
hand-rolled request. Gmail message id `1a04153e858bbc71`. This closes the
largest untested surface of the Replit migration.

Getting there surfaced two real bugs:

1. **`scripts/google-oauth-setup.mjs` opened a broken URL on Windows.** It used
   `cmd /c start`, and cmd.exe treats `&` as a command separator — so the browser
   received only the URL up to the first `&`. That includes `client_id` but drops
   `response_type`, and Google answers "Required parameter is missing:
   response_type", which reads like a malformed request rather than a truncated
   URL. Now uses `rundll32 url.dll,FileProtocolHandler`, which takes the URL as
   one unparsed argument.

2. **The Gmail API was not enabled on the Google Cloud project.** The OAuth
   exchange succeeded and the failure only appeared at the API call, as a 403
   naming the project. Worth knowing that a valid token proves nothing about
   whether the API is on.

**Also corrected:** the runbook assumed the `import` line was at the tail of the
takeoff Caddyfile. It is at **line 11, top level, above the site block** — which
is correct placement, but `tail -3` would not have shown it and the check would
have looked like a failure. Now `grep -n import`.

**Paths:** the SSH key authorises `root`, not `deploy`, so `~` is `/root` while
takeoff lives at `/home/deploy/takeoff`. All runbook paths made absolute.

## 2026-08-27 — LIVE at https://bisonlawncare.workoptional.tech

Deployed to srv1928610 alongside the takeoff stack. Full record in
`verify/2026-08-27/production-deploy/`.

takeoff measured unaffected at every step: `takeoff-app-1` untouched for 27h
with `restarts=0`, its Caddyfile mtime unchanged from when the takeoff side
wrote it, and `workoptional.studio` returning 200 at every checkpoint including
three consecutive checks in the seconds after the Caddy reload. Caddy was
reloaded, never restarted.

**Bug found and fixed: URL-unsafe Postgres password.** Generated with
`openssl rand -base64`, which emits `/`. That broke `DATABASE_URL` parsing —
`postgres://bison:/h5e...@db:5432/x` resolves the host as `bison` — and every
query failed with `getaddrinfo EAI_AGAIN bison`. **The container reported
`healthy` the whole time**, because `/api/healthz` does not touch the database.
A green healthcheck on this app does not mean the database is reachable. Fixed
with `openssl rand -hex 32`; DEPLOY.md and `.env.deploy.example` now say why.

**Live email confirmed by delivered headers:** `From: Koby Stull
<koby@radiantaisoftware.com>`, `mailed-by: radiantaisoftware.com`. Confirms that
the consenting account becomes the visible sender, since no `From:` header is
set anywhere in the code.

**Open / next**
- Nothing behind sign-in verified on the live hostname (needs a human sign-in).
- OAuth consent screen is still in "Testing": refresh tokens expire after 7 days.
  Publish it or email dies silently around 2026-09-03.
- Sender is currently Koby, not the Bison account. Re-run the setup script signed
  in as Bison when ready for real customers.
- GitHub deploy key id 161442430 added to the repo (read-only, this host).

## 2026-08-27 — Phase 1: shared surfaces for the feature batch

Per `.agents/memory/parallel-file-ownership.md`, every contended file changed
once, serially, before any parallel work starts.

**Schema** (`lib/db/src/schema/crm.ts`, pushed; 26 tables now)
- `jobs.status` gains `skipped`, plus `skip_reason` / `skipped_at`. Skipped is
  terminal for the visit but explicitly not completed — it must never raise an
  invoice, so it must not go through the complete endpoint.
- `services.pricing_field_id` → `estimate_fields`. Null keeps today's behaviour
  (turf sqft), so every existing service is unchanged. Set it and the same
  equations evaluate against that field instead — a blow-out priced per
  sprinkler zone. The equation keys are still named `*Sqft`; read them as
  "units of the selected field".
- `invitations` table. Deliberately **not** placeholder rows in `users`:
  `.agents/memory/user-account-identity.md` forbids accounts without a verified
  email, and a pending invite is by definition unverified. Signing up with a
  matching verified email grants the invited role as `owner_assigned`, reusing
  the existing tested path. Inviting an address grants nothing on its own.
- `scheduling_rules` table. Rules are rows, not code, so the office can change
  what happens on estimate acceptance without a deploy. Actions: `dispatch`,
  `route_fit`, `waiting_list`, `none`. Null `service_id` is the catch-all.

**Contract** (`lib/api-spec/openapi.yaml`, codegen run)
- Job status enum in 3 places; `skipReason`/`skippedAt` on Job; `skipReason` on
  JobUpdate; `pricingFieldId` on Service/Input/Update.
- New: `/invitations`, `/invitations/{id}`, `/scheduling-rules`,
  `/scheduling-rules/{id}`. 73 paths, 96 schemas, all parse.

**Side effect of the earlier lockfile regeneration, found here.** orval floated
from its old pin to 8.26.0, which now emits `Object.fromEntries(h.entries())`.
`Headers.entries()` is standard but is declared in `dom.iterable`, which
`lib/api-client-react/tsconfig.json` did not include — 47 type errors in
generated code. Fixed by adding `dom.iterable` to that lib list. Worth knowing
that regenerating the lockfile can change generated code, not just dependencies.

## 2026-08-27 — feature batch: five features, plus favicon and feedback

Phase 2 ran five agents in parallel on strictly disjoint file sets, per
`.agents/memory/parallel-file-ownership.md`. **Zero merge conflicts** — the
failure that note was written about did not recur.

Shipped: skip-job status, contractor invitations, property-detail service
pricing, horizontal estimate matrix, estimate-acceptance auto-scheduler,
in-app feedback, and a real favicon.

**Two integration defects found and fixed in Phase 3 — neither visible to any
single agent, which is the point of the phase:**

1. **Double-seeded scheduling rules.** `lib/schedulingRules.ts` seeds defaults
   lazily, guarded by a marker row in `audit_events`. `seed-demo.ts --reset`
   deletes `audit_events` — clearing that very guard — and separately wrote its
   own copy of the same defaults. A fresh seed would have produced two rules per
   service. Fixed by deleting the duplicate list and having the seed call
   `ensureDefaultSchedulingRules()`, so the owning module is the only source.
   Verified: 6 rules after a reset, one per service plus the catch-all.

2. **Vendor work was being dispatched to our own crew.** The scheduler matched
   an accepted line to a rule by service, and any service without its own rule
   fell through to the catch-all `dispatch +1`. "Fertilizer Application" is
   performed by Acme Spray, so accepting it created a phantom job on the crew's
   board for work an outside company does — and a second source of truth for
   whether it happened, when Spray Runs already reconciles it from the vendor
   invoice. Fixed in the engine rather than as a default rule, because it is an
   invariant of vendor work: it must hold for a vendor service added next year
   that no default matches, and it must beat the catch-all.
   Verified end to end: a 4-line estimate (blow-out, mowing, clean-up,
   fertilizer) produced exactly 3 jobs — blow-out dispatched 2026-08-28, mowing
   route-fitted to 2026-08-28, clean-up held 09-01..11-30, fertilizer skipped.

**Feedback notification.** `FEEDBACK_NOTIFY_EMAIL` (deliberately separate from
`APP_OWNER_EMAIL`, which governs who may administer the app — overloading one to
mean the other makes changing either silently change both). Fire-and-forget and
non-throwing: measured that a 500 from the mail provider neither propagates out
of `notifyFeedback` nor loses the stored feedback row.

**Favicon.** The nav logo is unusable at 16px (wordmark ~1.3px tall, dashed ring
aliases to noise). Rebuilt from the path's measured bounding box — 190x120.9
centred at (200, 194.6); an eyeballed centre was off by 22px and clipped —
and inverted to cream-on-green, which is the variant that stays legible against
Chrome's tab-strip grey.

**Process note:** holding codegen while agents ran left the tree uncompilable and
cost two agents real time chasing a phantom `feedbackTable` error. Regeneration
is additive; it should have been immediate.

## 2026-08-27 — the owner's document templates are a data-model gap, not a formatting one

He sent four templates (aeration notice, mow-care welcome, estimate proposal,
sprinkler repair) using ~17 square-bracket merge tokens. Measured against the
app: **only 3 of them had anything to read from.**

| Token group | State before this change |
|---|---|
| `[clientname]` `[physicalcity]` `[quotetotal]` | existed |
| `[clientfname]` | only a single `name` column |
| `[physicaladdress2]` `[physicalstate]` `[physicalzip]` | no columns at all |
| all 8 `[company*]` tokens | **no company profile existed** — "Bison Lawn Care LLC" was hardcoded in 7 places across 3 files, and address/phone/website nowhere |
| `[signatureline]` `[Bison_Full_Service]` | no concept |

**Built (foundation only):**
- `company_profile`, a singleton like `billing_settings` but separate from it —
  card-fee policy and business identity change for different reasons.
- `clients.address_line2`, `.state`, `.postal_code`. Stored alongside
  `serviceAddress` rather than parsed out of it: address parsing is guesswork
  and mangles "Ridgeline Property Group, Suite 2".
- `document_templates`, superseding the single-row `letter_templates` (one
  letter, three tokens). `letter_templates` is left in place so the existing
  spring-letter run keeps working.
- `lib/mergeTokens.ts` — 21 tokens in **his** `[token]` syntax, not the app's
  `{{token}}`. He has years of documents written that way; making him rewrite
  them is the tax that stops a tool being adopted. Both syntaxes now coexist.

**Deliberate decisions worth knowing:**
- An unrecognised token is left visible, never blanked. `[speciallowerprice]`
  appearing in a customer letter is an obvious, fixable mistake; deleting it
  yields a sentence that reads fine and is wrong, and nobody catches it until it
  has gone to 400 people. `unknownTokensIn()` surfaces them before sending.
- `[clientfname]` is derived from the first word of `name`, not a new column: a
  new column is empty for every existing customer, so every letter would open
  "Dear ,". "Ridgeline Property Group" greets as "Ridgeline" — odd, not wrong.
- His two estimate documents name the services block with different tokens
  (`[Bison_Full_Service]`, `[Estimate_Bundle:_Estimate_Description_Only]`). Both
  resolve to the same block rather than making him standardise on ours.

Verified against his verbatim template text: all four documents render, case
mixed as he writes it, unknown tokens preserved and reported.

**Still open on this thread**
- Company-profile and template-editor API + UI; seeding his four documents.
- The 7 hardcoded "Bison Lawn Care LLC" sites should read the profile.
- **Per-service acceptance.** His estimate says "check the box corresponding to
  each service ... uncheck the respective box". Ours accepts the whole estimate.
  This is now a correctness issue, not only a feature gap: the auto-scheduler
  creates a job for *every* line, so partial acceptance would schedule work he
  never sold.
- Contract / payment-disclosure block below the quote.
- **The real logo is not the one in the app.** His letterhead is a "B" formed
  from a bison plus a wordmark; `logo.svg` is a crude arch. Ask him for the
  artwork — it cannot be recovered from a screenshot.

## 2026-08-27 — real logos, company profile, his five documents seeded

**Logos.** He supplied the actual artwork: a horizontal wordmark (B formed from a
bison + "BISON LAWN CARE") and a bison-on-mountain emblem, 1201px transparent
PNG. Brand green sampled from the files rather than guessed: **#215343**,
identical in both. Shipped as `logo-wordmark.png`, `logo-emblem.png`, and
`logo-mark.png` (the B alone, cropped at columns 43-413, found by scanning for
the gap between glyph and wordmark rather than by eye).

The favicon is now the real B, cream on green — the same comparison as before
against Chrome's tab-strip grey, and the real mark is legible at 16px where the
placeholder arch was not. Both placeholder SVGs deleted; a dangling reference in
Clerk's sign-in branding (`logoImageUrl`) was caught by sweeping for it rather
than by the typechecker, which would never have seen a 404 on a string URL.

**Company profile + template library.** `/company-profile` and `/merge-tokens`
endpoints; the token list is *served* rather than duplicated in the front end,
because the renderer is the only thing that knows what it can fill and a
hand-kept UI list drifts silently — the office would be shown a token that
reaches a customer as literal text.

His five documents (aeration notice, mow-care welcome, estimate proposal,
sprinkler repair proposal, contract + payment disclosure) are seeded verbatim,
matched to services by name, and marked `isSeeded` so an edit of his is never
overwritten by a later ship. All five render with **zero** unfillable tokens.

**Two defects found by rendering against real data, not by reading the code:**

1. **Empty tokens left visible wreckage.** A client with no zip rendered
   "Bozeman,  " with a dangling comma; a line holding only `[physicaladdress2]`
   rendered as a blank line mid-address. Fixed with a tidy pass.
2. **My first fix silently deleted his punctuation.** Working line-by-line, it
   stripped trailing separators from any line containing a token — which removed
   the comma from "Dear [clientfname]," and from his "Your Friendly Bison,"
   sign-off. Rewritten to anchor on a NUL marker emitted only where a token
   rendered empty, so author punctuation not adjacent to an empty value is
   untouchable by construction. Eight assertions now cover both the fix and the
   regression.

**Process note (third occurrence).** The Bash heredoc mangled backslashes again,
this time writing a literal NUL byte into a source file and turning `\n` escapes
into real newlines inside string literals. Use the Write tool for any file
containing escape sequences — this shell cannot be trusted with them.

**Correction for the record:** the estimate checkboxes cannot be auto-detected.
They are the *customer's* selection, made in their inbox ("check the box
corresponding to each service you desire"). Nothing on our side can know which
services a customer will decline. The workable equivalent, and what his current
system does, is to default every box checked so that clicking Accept with no
changes accepts everything — identical to today's behaviour, with unchecking
purely additive.

## 2026-08-27 — per-service acceptance, and the scheduler honouring it

His proposal has always promised the customer a choice: "check the box
corresponding to each service ... uncheck the respective box". The app accepted
or declined the whole estimate. Once the auto-scheduler shipped this stopped
being only a missing feature — the scheduler created a job for **every** line,
so partial acceptance would have scheduled work he never sold. The two had to
land together.

**Built.** `estimates.acceptedLines` (indexes into `lines`) and `acceptedTotal`,
stored alongside the quote rather than mutating it — the office needs to see what
was quoted next to what was bought to understand a decline. The public
confirmation page now renders a checkbox per priced line, every box pre-ticked,
using plain form controls with **no JavaScript**: that page opens from an email
link in whatever browser the customer's mail app hands it to, and a quote that
silently fails to submit is a lost sale. The scheduler filters to accepted lines
before any other filtering, because `acceptedLines` indexes the original array
and reindexing it first would schedule the wrong work.

**A real bug the verification caught.** Browsers omit unchecked boxes entirely,
so "the customer unticked everything" and "this form never had checkboxes" both
arrive as a missing `line` field. My first version treated both as "all lines" —
meaning unticking every box accepted the entire estimate. Fixed with a hidden
marker on forms that carried checkboxes, so the two are distinguishable; an
empty selection is now refused and re-prompted rather than guessed at.

Separately, an HTML comment containing backticks inside a template literal
terminated the string. Caught by the typechecker, but worth remembering when
documenting generated markup.

**Six cases measured end to end over real HTTP:**

| Case | Result |
|---|---|
| Checkboxes rendered, all pre-ticked, no JS | 3/3 correct |
| Accept lines 0 and 2 | acceptedLines `[0,2]`, acceptedTotal 355, quoted 485 preserved |
| Scheduling | 2 jobs; the declined mowing was **not** scheduled |
| Legacy `acceptedLines = null` | scheduled all 3 — sold work not dropped |
| Every box unticked | refused, status stays `sent`, customer re-prompted |
| Old-style submit with no marker | still accepts in full |

Gate: full typecheck clean, 94/94 tests.

## 2026-08-27 — sub notification closes the last half of the auto-scheduler ask

The owner asked for auto-scheduling with "(notification to sub that new job has
been added)". The scheduler shipped writing an audit event, which the office
sees and the sub does not — so a job could appear on someone's route overnight
with nothing telling them.

`lib/subNotification.ts` emails the assigned sub when a job is created from an
accepted estimate: service, customer, address, date or window, amount. Fire and
forget, and non-throwing for the same reason the feedback notifier is — an
exception here unwinds into the acceptance path, and losing a customer's
approval to a failed email would be far worse than a sub finding the job on
their board unannounced.

Measured: unassigned job sends nothing; an assigned sub with an email gets
exactly one; a phone-only sub with no address on file sends nothing and does not
error (the normal case, not a fault); a 500 from the provider is contained.

## 2026-08-27 — four features in parallel: branding, settings, bulk repricing, spray matching

Second parallel round on disjoint file sets. Zero merge conflicts again.

**Estimate documents now carry his real identity.** The PDF is a letterhead —
his wordmark, the company block from `company_profile`, brand green #215343
sampled from his artwork — with the sign-off, company block, bison emblem and
"Thank you for your business!" footer reproducing his own letter structure, and
his contract + payment disclosure on its own page with tokens merged. The logo
path is resolved at runtime by walking up to the first ancestor holding
`artifacts/bison-crm/public/`, which works from `src/lib` in dev and from
`dist/` in the image; not-found returns null and the draw is wrapped, so the
worst case is the old text header rather than a throw mid-document. Email logos
are decoration only — name, address and contact line are all present as text, so
it reads correctly with images blocked.

Verified by generating one and reading it: 74,210 bytes, %PDF-1.3, 3 pages, 4
image XObjects (both logos with their SMasks), and all three pages inspected in
a browser.

**Settings** gives him the company profile and a template editor with preview
against a real customer. The merge-token list is served by the API, never
duplicated in the page — a local copy drifts and starts telling him a token is
fine when the customer reads it literally. Unknown tokens are flagged in three
places: a badge on the list, a live warning in the editor, and above the
preview.

**Bulk seasonal repricing** closes step 1 of the seven-step winter job he
described. Percent or fixed, optional rounding, optional scope. Preview writes
nothing — confirmed by re-reading `rate` and `pricingEquations` byte-for-byte
after a preview call. Apply moves the equation money as well as `rate`, because
an equation-priced service ignores `rate` entirely and adjusting only that would
silently do nothing for exactly the services that matter most.

**Spray invoice matching** addresses his double-billing complaint directly. It
matches on address first and name second — a property manager has one billing
name across many addresses, so name alone is ambiguous precisely where a mistake
is most expensive. Only high-confidence matches are pre-ticked; nothing is ever
completed automatically, because a wrong tick bills someone for work nobody did.
It also flags when the vendor charges one customer twice, and when a matched
customer is already invoiced.

Its stated limits are worth keeping visible: a full name with no address is only
"probable" and never pre-ticked; a typo'd house number surfaces as both an
unmatched customer and an unmatched line rather than being attached to a
neighbour; non-customer prose without digits lands in the unmatched list.

**Integration fixes only visible once the four met:** `automation.ts` and the
estimate email subject still named the company literally, and the seeded spring
letter ended with a company name that now printed twice under the rendered
block.

Gate: full typecheck (build info cleared), 94/94 tests, production build passes
— which also confirms the spray matcher's cross-package import bundles.

## 2026-08-27 — full customer workflow proven live, and QuickBooks (read-only)

**The end-to-end chain finally ran in production**, which had been the largest
standing gap. New lead created through the estimate builder's "new prospect"
flow → estimate built (Turf 7,400 → $148, Sprinkler Zones 8 → $96, Sprinkler
Blow-Out 8 zones → **$135**, Weekly Mowing 7,400 sqft → $60, total $439) →
emailed → customer unticked mowing and accepted.

Result, read from the production database:
- `accepted_lines [0,1,2]`, `accepted_total 379` against a quoted `439`
- **one** job created — Sprinkler Blow-Out, dispatched 2026-08-28, $135
- Weekly Mowing declined and **not** scheduled
- audit: *"Accepted estimate #4 in part (3 of 4 items, $379.00 of $439.00).
  Declined: Weekly Mowing"*
- property details written back to the lead record

That is per-service acceptance, zone pricing, the scheduler honouring the
selection, and the vendor/service rules all working together on the real host.

**QuickBooks: read-only, on-demand, nothing stored.** OAuth with a discovery
document, transparent token refresh (both tokens persisted — storing only the
access token kills the grant ~100 days later for no visible reason), and the
expense view taken from the P&L's own Expenses/COGS/OtherExpenses sections so
the two figures on screen cannot disagree.

Notable decisions:
- The QuickBooks router is mounted **immediately after health**, ahead of the
  first router that calls `router.use(requireAuth)` with no path prefix.
  Mounted later, the OAuth callback returns 401. There is a comment saying so;
  a future reorder would break it silently.
- `state` is 32 CSPRNG bytes, single-use, 15-minute TTL, deleted on lookup. The
  callback trusts nothing else from the query string: `realmId` is shape-checked
  then *proved* by fetching CompanyInfo, the redirect target only honours a
  rooted single-slash path, and Intuit's `error` param is never echoed back.
- Unknown `INTUIT_ENVIRONMENT` values fall back to sandbox deliberately, so a
  typo cannot point real credentials at the live host.

**Correction to something I told the owner:** I said no Intuit credential
reaches the browser. The client **secret** never does (verified: 0 occurrences
across a full `LOG_LEVEL=trace` run). The client **id** does — it is a query
parameter of the authorize URL and therefore in the address bar during any
authorization-code flow. That is how OAuth works and Intuit treats it as public,
but "nothing reaches the browser" was too strong.

**Not verified without a live grant:** the authorize → code → token round trip,
the refresh *success* path and rotation persistence, the 401 retry, CompanyInfo
realm verification, and real report JSON. The flattener is verified against a
captured real payload plus synthetic depth-6 and empty-section variants.

**Action before connecting:** the redirect URI must be registered on the Intuit
dashboard exactly — `https://bisonlawncare.workoptional.tech/api/quickbooks/callback`
for the deployed app, `http://localhost:5173/api/quickbooks/callback` for local.

## 2026-09-02 — Adam's source material read in full (no code changed)

Read both PDFs from his live CRM plus all 43 files in the shared Drive folder.
Full write-up: `verify/2026-09-02/adam-crm-source-review/VERIFY.md`.

**His current CRM is Service Autopilot** (`my.serviceautopilot.com`) — every
screenshot is from it. "What he wants ours to do" is that feature set, which was
never named in any prior transcript.

Neither PDF was readable by default tooling and both failed *silently* rather than
erroring: the quote uses a subset font shifted by -0x1D (digits land on
non-printable bytes, so **every dollar amount extracted as blank** on the first
pass), and the invoice uses Type0/CID hex strings (returned two empty pages).
Wrote decoders for both. Treat "this PDF has no text" as a hypothesis, not a result.

Largest gap found: the **Rate Matrix** — per-service banded pricing keyed off a
client custom field, returning price *and budgeted hours and budgeted cost*. The
equation-based `calculatePrice()` we shipped is a strictly weaker model, and
budgeted hours is what the dispatch board's B.Hrs and revenue projections run on.
Two real datasets are available to seed it (mowing bands from the screenshot,
top-dressing from his xlsx — row 2000sqft = $826.67 matches the quote exactly,
confirming the quote is generated from those tables).

Also newly specified rather than inferred: the exact client record shape (service
vs billing address, 4-part name, Map Code, Master Property), 16 named custom
fields, tags-with-categories driving automations, automations as wait/email/to-do
sequences (not one-shot offsets), and a per-capability role matrix across five
tabs. "Email Clients" on a map-lassoed group *is* the property-manager batch
notification he described — it is a dispatch-board action, not a separate feature.

Two conflicting company addresses appear in the same quote (Po Box 117, Post Falls
ID 83877 on the letterhead; PO Box 7156, Kalispell MT 59904 in the contract body).
Do not pick one — the company profile work is blocked on Adam saying which.

## 2026-09-03 — Invoice format parity, skip policy, and a deploy hazard

Built the invoice half of the 2026-09-02 review: numbering, dates/terms/PO,
line items, Bill-To separate from Property Address, payment coupon, PDF and
email send. Full write-up: `verify/2026-09-03/invoice-format/VERIFY.md`.

The important half was job-completion invoices. Both completion paths
(`jobs.ts`, `vendor-runs.ts`) were inserting an invoice with a total and a
one-sentence note — no number, no detail — and those are most of the invoices
the business issues. Both now share one `createInvoiceForJob`.

**Deploy hazard: never run `pnpm push-force`.** Adding `invoices.number` made
`drizzle-kit push` offer to TRUNCATE the invoices table to add its unique
constraint, and `--force` accepts that offer without printing a question. The
offer is also unnecessary — Postgres allows unlimited NULLs in a unique
constraint and every existing invoice has `number = NULL`. Verified locally on 6
invoices: constraint added by hand, all 6 survived, next push clean. DEPLOY.md
now carries the ALTER TABLE and the warning.

**HANDOFF.md was wrong about the local tests.** It records them as failing for
environmental reasons. They fail only when `.env` is not exported, and
`DATABASE_URL` alone is not enough — `CLERK_SECRET_KEY` is also required and its
absence surfaces as a 500, not as a config error. With the full env exported:
105 pass, 0 fail across all nine suites.

Two data corrections. The seeded company profile carried `PO Box 7156,
Kalispell, MT` with a 406 number, taken from the *contract body* of Adam's quote
— the letterhead and invoice of that same document both say `Po Box 117, Post
Falls, ID 83877` / `208-981-0176`, and Koby confirmed the Idaho one. And
`todayISO` defaulted to America/Denver when the Idaho panhandle is Pacific, so an
invoice raised on a weekday evening would have been dated the next day.
`weatherScheduler.ts` hardcodes a third timezone (America/Chicago); left alone
rather than changing a background job's firing time as a side effect.

Also fixed: the invoices table computed the balance in the browser, so an
overpaid invoice displayed a negative "Balance Due" — reading as the company
owing the customer. Server now returns a floored `balance`.

**Not browser-verified.** The Chrome extension would not connect this session,
so the five UI changes typecheck and are wired to endpoints proven at the API
layer, but have not been seen in a browser. Not deployed.

## 2026-09-03 — browser pass, live sends, and the coupon page break

Browser pass done, so the previous entry's "not browser-verified" no longer
stands: Invoice #/Terms column, PDF, Send/Resend, the New Invoice line editor,
the skip toast and the durable "Chargeable" marker were all seen working in
Chrome. Two real invoice emails went out through the production Gmail path to
Work Optional addresses (message ids `1a0697bfb532fa5b`, `1a0697c2442fdc76`).

The browser pass earned its keep: the invoice rendered as **two pages with the
payment coupon alone on the second**. `needSpace` compared against a hardcoded
`700` when a Letter page's real content bottom is `738`, wasting 38pt of every
sheet. A three-line invoice with a note now fits on one page, as his own #4848
does. Guarded by two new tests in both directions.

`invoiceDocument.test.ts` was never in the `pnpm test` script — it had only ever
been run by hand. Added; the suite is now 107 tests.

The extension's failure to connect was **Chrome not running at all**, not a
missing install. Separately, `npx` in Git Bash translates `BASE_PATH=/` into the
MSYS root, serving the app at `/Program%20Files/Git/`; launch vite through
`node .../vite/dist/node/cli.js` instead.

Still not deployed, and the `ALTER TABLE` has not been run anywhere.

## 2026-09-03 — deployed dafbd0a, and the runbook error caught on the way

Live. `deploy.sh` took the server e7a3b1d -> dafbd0a, the container reports
healthy, `https://bisonlawncare.workoptional.tech/api/healthz` -> 200, and both
takeoff containers were still up afterwards.

**DEPLOY.md was wrong in a way that would have stranded this deploy.** It said
that if `invoices.number` did not exist you could run `push` first because it
"adds the column and stops at the constraint prompt with nothing applied". It
applies *nothing* — `push` computes the whole diff before applying any of it —
so the documented next step, `ALTER TABLE ... ADD CONSTRAINT`, would have failed
with `column "number" does not exist` on production, half-way through. Proved
both paths against scratch databases before touching the server; corrected the
runbook to add column and constraint together first. `push` then reported
`Changes applied` with no prompt, exactly as predicted.

**Production has no invoices, and that is correct.** The Service Autopilot
importer writes only clients, estimate_fields and services — it has never had an
`INSERT INTO invoices`. His invoice history stays in Service Autopilot, which is
the whole reason numbering starts at 4900. The real client book is intact.

**Clerk is still on development keys on a public URL.** Deliberate while
testing, but now a deadline rather than a note — dev instances cap users and
show a "Development mode" banner on the sign-in card. Written up as
`TASK-clerk-production-keys.md`, including the trap that it is a rebuild rather
than a restart (Vite inlines the publishable key at build time) and what happens
to existing accounts (they survive on verified email; an unverified one, or a
different address, silently demotes the person to contractor).

## 2026-09-03 — production pass found the wrong company address on live documents

Raised test invoice #4900 against Adam's own client record and voided it.
Numbering started at 4900 as designed, the PDF is one page, and the voided row
reads `Total $1.00 / Balance Due $0.00` — the void fix confirmed on production.

**The live company profile still held the Kalispell, MT address.** It was
corrected on 2026-09-02 in `seed-demo.ts` and the local database; production's
`company_profile` row was never touched, because seed code does not run there.
So every invoice, estimate and letter sent from production carried
`PO Box 7156, Kalispell, MT 59904 / 406-885-5296`, including the coupon's
`Remit to:` line — customers posting cheques to the wrong state. Fixed through
Settings > Company details, which also feeds the `[companyaddress]` merge
tokens, and confirmed by re-rendering the same invoice.

The general lesson: **a fix to seed data is not a fix to production.** Anything
corrected in `seed-demo.ts` needs a matching change to the live row.

**Correction to the previous entry.** It said production had never had invoices.
The test invoice came back with row id 19, so eighteen ids had already been
issued — rows existed at some point and are gone. That is not this deploy:
`push` applied its diff with no truncate prompt, and numbering fell back to
INVOICE_NUMBER_START rather than max+1, so no *numbered* invoice ever existed.
Most likely earlier demo seeding and resets on this box. The client book is
intact regardless.

**Void has no confirmation.** One click on a ghost button beside "Pay" voids an
invoice immediately — no `window.confirm`, unlike Send and delete-payment. A
misclick silently cancels a bill. Not fixed here; raised for a decision.

## 2026-09-03 — Adam's feedback is not missing: 47 new items are waiting

Reported as "not seeing anything on the feedback tab". The production feedback
screen is full. Counted from the filters on
`https://bisonlawncare.workoptional.tech/feedback`:

| Filter | Count |
|---|---|
| All | 67 |
| **New** | **47** |
| Read | 1 |
| Done | 19 |

The 19 Done plus 1 Read are the original twenty-item backlog HANDOFF.md
describes. The **47 New are all since Aug 27**, and nine of them arrived on the
morning of Sep 3. Nothing was lost.

The likely explanation for "not seeing it" is looking at `localhost:5173`, which
runs the local demo database, rather than at production. Worth remembering:
**the feedback screen is the one place where local and production differ in a
way that matters**, because production's rows are the real backlog and local's
are seed data.

Themes in the 47, for planning rather than as a spec:

- **Dispatch board** is the biggest cluster — customisable columns and filters
  (branch, resource, service, city, map code, status, proximity, priority,
  tags), select-all, seeing price / outstanding balance / last invoice balance
  on the row, and filtering to jobs that carry a contractor's note.
- **Undo** — reversing an accidental completion, pulling a service back off an
  invoice and returning it to the dispatch board or waiting list.
- **Invoice review flow** — completed jobs landing in a "pending verification"
  state, then an invoice board to verify, then send / print / past-due queues.
  This is adjacent to the invoice work just shipped and should be read before
  building more of it.
- **Services and matrix** — services priced off other services (1x mow = 1.5x),
  copying a matrix between services, hiding matrix numbers, adding a tier at the
  bottom, importing a matrix from Excel, matrix billable hours auto-derived from
  the average of past jobs, and Enter moving to the next cell instead of closing
  the editor.
- **Estimates** — a custom cover document with a link the customer uses to pick
  services, adding packages, populating from the matrix, and Enter for newlines
  in descriptions.
- **Roles** — separate contractor/employee logins with owner-set access, and
  multiple roles per person (crew lead, second lead). Also a vocabulary note:
  contractor, employee and crew lead should read as the same thing.
- **Automation** — estimate follow-up at 2 and 7 days; invoice Net 15/Net 30 per
  account with a late notice at 2 days and a final notice 15 days after that.

One is filed as a **Problem**, not an idea: "Sprinkler Package says price 5
services but only should be 3 services."

## 2026-09-03 — deployed 398553e, and the invoice-history question is settled

The SSH key for this box is **`C:\Users\kobys\bison_ssh`** on the Windows
machine (public half `bison_ssh.pub`), not in `~/.ssh/`, which is why an earlier
listing missed it and two sessions were spent handing deploy commands over
instead of running them. `ssh -i /c/Users/kobys/bison_ssh root@31.220.50.13`.

Deployed `398553e` — the void confirm. Container healthy, health endpoint 200
through Caddy, both takeoff containers untouched. Verified the built bundle
actually carries the change rather than trusting the log:
`grep "cannot be undone here"` hits
`/app/artifacts/bison-crm/dist/public/assets/index-CFRMrflV.js`.

**The missing invoices are accounted for.** From `pg_stat_user_tables`:

```
 ever_inserted | ever_deleted | rows_now
            19 |           18 |        1
```

Nineteen invoice rows have ever been inserted on this database, eighteen
deleted, one remaining — the test invoice raised today. So the eighteen went
before today: this deploy applied no deletes, and the test accounts for the
nineteenth insert exactly. They also carried no invoice number (numbering fell
back to `INVOICE_NUMBER_START` rather than `max(number) + 1`), so they predate
the numbering column entirely — demo seed rows from earlier seed/reset cycles,
not customer invoices. The importer has never written to `invoices` at all.

Alongside: **709 clients** and **67 feedback rows**, the latter matching the
count read off the UI. The real book is intact.

Scope of what is proven for the void confirm: the message text and both the
cancel and accept paths were exercised in a browser **locally**; on production
only that the built bundle contains the change. Production has no open invoice
to click, and raising another one to prove it was not worth a second test row.

## 2026-09-03 — first pass through the backlog: 4 closed, one real bug among them

47 New -> 43. Done 19 -> 23. Triage written to `BACKLOG.md`.

**53 was a genuine bug, not bad data.** "Sprinkler Package says price 5 services
but only should be 3." `packages.service_ids` is a jsonb array with no foreign
key, so deleting a service left its id in every package that listed it; the
package kept counting a service that no longer existed. The same bug had
silently emptied **Full Season Care** — two ids, neither resolving — and nothing
surfaced it. Deleting a service now strips it from every package in the same
transaction, and the read path returns only ids that resolve. Both tests were
confirmed failing against the unfixed code before being kept.

**The mass deletion is now fully accounted for.** Adam's "I created some tickets
but they disappeared" is the same event as the missing invoices and the deleted
services. From `pg_stat_user_tables`:

```
 clients   1138 inserted   429 deleted   709 now
 jobs       496 inserted   466 deleted    30 now
 services   304 inserted   158 deleted   146 now
 invoices    19 inserted    18 deleted     1 now
 tickets      6 inserted     4 deleted     2 now
 packages    10 inserted     4 deleted     6 now
```

A reset during setup, not the app losing data — which is exactly what the
standing rule about `seed-demo --reset` exists to prevent. Told him plainly,
and offered to re-enter the tickets if he remembers them.

**Local port 5173 was serving a different project** ("Idaho Healthcare
Staffing") — two listeners were bound, and the newer one answered. Verifying
against it would have proved nothing about this app. Bison dev now runs on 5199.
Check `document.title` before trusting a localhost screenshot.

## 2026-09-04 — checking an "already built" item found a $0 pricing hole

Item 27 asked for a horizontal rate matrix. It was already built. Opening it to
confirm that is what found the following, on live data:

```
  4,000 sqft mow  -> $55.00
 25,000 sqft mow  -> $181.25
 30,000 sqft mow  -> $0.00      <-
 50,000 sqft mow  -> $0.00      <-
```

Mowing carries 40 bands and **18 are empty rows** — a range with no price, no
hours, no cost. `calculatePrice` matched the first band whose ceiling covered
the value, and an empty row matched as readily as a real one. Core Aeration has
12 empty bands of 15; Bison App 1 has nine of twelve.

This was not confined to quoting. A job completing on such a property builds its
invoice from the same number, so the customer would have been **billed nothing**
and nothing on screen would have looked wrong.

Fixed: only bands that carry money may price a job. Above every priced band it
now falls back to the largest priced band — still wrong for a property larger
than the matrix, but wrong by a number the office recognises rather than
silently by nothing. Verified on production after deploy: 30,000 and 50,000 sqft
now both return $203.75.

`test/pricing.test.ts` is new and in the aggregate script; two of its seven
cases were confirmed failing against the unfixed code before being kept.

**Open question for Adam, asked on the item:** whether those empty bands are
rows nobody filled in or real bands the import dropped. He has to say what a
property over 30,000 sqft should cost. $203.75 is us refusing to quote zero, not
a price.

### Item 39 was already live when he re-raised it

"Route from a map on the dispatch board per contractor." The map shipped
2026-08-27 in `9186057`, which is an ancestor of what the server was running, so
it was live on Aug 28 when he asked again. Either it does not do what he means or
he could not find it. Marked **read**, not done, with a note saying exactly where
it is, what it does, that the map is empty unless the selected date has jobs, and
asking which of two different things he actually wants. Re-answering "already
done" to someone who has just told you otherwise is how a backlog item gets
closed twice and fixed never.
