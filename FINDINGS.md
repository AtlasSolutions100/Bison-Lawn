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
