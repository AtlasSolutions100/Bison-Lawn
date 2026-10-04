# Build brief — Adam's 2026-09-28 notes

You are one of eleven builders working IN PARALLEL in the same working tree.
Each owns a track. Read this whole file first; the shared rules and contracts
live only here.

Repo: `C:\Users\kobys\OneDrive\Desktop\OptionallyWorking\BisonLawn\Bison-Lawn-Care-Adam-Johnson`
Spec: `docs/notes-2026-09-28/requests.md` — his own words, grouped as he grouped them.
Background on the product and how it got here: `docs/walkthrough-2026-09-15/`
(especially `requirements.md` section Q, which lists what he has DECLINED — do
not build any of it) and `FINDINGS.md`.

## Who Adam is
Adam Johnson owns Bison Lawn Care (Coeur d'Alene / Post Falls / Hayden, Idaho,
plus a Washington branch). No employees, only subcontractors — Disa Nelson,
Spencer Eich, Gabe Theander, Adam Eich. 709 customers imported from Service
Autopilot. He runs the office alone and is using this app for real work right
now. Write UI copy and comments in plain words he would use. Comments in this
codebase explain WHY in the owner's words; keep that, and never narrate what the
code does.

## Hard rules
1. Do NOT commit, stash, reset, checkout or rebase. The orchestrator commits.
   `git diff` / `git status` for reading are fine.
2. Do NOT deploy, do NOT ssh anywhere, do NOT touch production (31.220.50.13) or
   `.env.deploy`. Local only: `.env` points at Postgres on localhost:5434. If
   the container is down, start it: `docker start agency-pg`.
3. Never `seed-demo --reset`, never `push-force`, never drop a table. Schema
   changes: Edit `lib/db/src/schema/crm.ts` (never Write the whole file), then
   `set -a; . ./.env; set +a; pnpm --filter @workspace/db run push`. A unique
   constraint or a NOT NULL without a default on an EXISTING table needs the
   column added and backfilled first — see DEPLOY.md.
4. Email: the only addresses anything may send to are koby@radiantaisoftware.com
   and kobystull123@gmail.com. Tests must not send real mail — inject a fake
   proxy the way `test/clientEmail.test.ts` does. Never email Adam, his crew or
   any customer.
5. Others are editing other files right now. Use Edit (targeted replacements) on
   any shared file; never Write a file you do not own. Shared: `lib/db/src/schema/crm.ts`,
   `lib/api-spec/openapi.yaml`, `artifacts/api-server/src/routes/index.ts`,
   `artifacts/api-server/package.json`, `artifacts/bison-crm/src/App.tsx`,
   `artifacts/bison-crm/src/components/layout/*`. If an Edit fails because the
   anchor moved, re-read and retry — never restore text you think is missing.
6. Prefer NEW files: a new `routes/<yours>.ts` mounted in routes/index.ts, new
   components under `artifacts/bison-crm/src/components/<area>/`, a new test file.
7. OpenAPI: `lib/api-spec/openapi.yaml` is the contract; after editing run
   `pnpm --filter @workspace/api-spec run codegen`. If codegen fails on YAML you
   did not write, another builder is mid-edit: wait 30s and retry, up to 5 times.
   Never edit generated files. A description starting with `true`/`false`/`no`
   must be quoted.
8. Tests: node:test via `tsx --test`, pattern in `test/integration.test.ts`
   (NODE_ENV=test + TEST_AUTH_TOKEN + `x-test-user-id`; admin seeded with
   role 'admin', roleSource 'owner_assigned'; clean up in `after`). Add
   `test/<yours>.test.ts`, a `"test:<yours>"` script, and append it to the
   `test` chain (Edit). Run only your own file; the orchestrator runs the chain.
9. Typecheck with `pnpm --filter @workspace/api-server run typecheck` and
   `pnpm --filter @workspace/bison-crm run typecheck`. Errors in files you do not
   own belong to someone else — report, do not fix.
10. Do NOT use the browser tools and do not start or restart dev servers; the
    orchestrator verifies in the browser.
11. The local DB holds real imported customers. Never bulk-modify or delete
    them; create your own rows and remove them.
12. Do not narrow a request to make it fit. If something genuinely cannot be
    built, build everything up to that line, make the UI say plainly what is off
    and why, and report it.

## What already exists (do not rebuild)
Filter builder and bulk actions on the clients list; matrix copy with a
multiplier and "fill bands by rule"; waiting-list map lasso; dispatch bulk
move/assign/skip/cancel/delete and document email; the invoice verify queue
(Needs verification → To email / To print) with undo; document templates in
client/marketing/estimate folders with merge tokens, an open-tracking pixel and
`email_sends` logging; automation rules as one-sentence builders, all shipped
switched OFF; access levels full/office/mobile with per-area grants; crew GPS
and `sms_messages` behind a provider that is switched off; global search;
assigned services with cadence, discount, pause and contractor; client tabs
(Overview now also shows the services); contractor colours he picks; and as of
2026-10-03 `**bold**`, `*italic*` and `- bullets` in typed text via
`artifacts/api-server/src/lib/richText.ts`.

## Cross-track contracts
A1. **Sender identity** (track SENDER owns it): one helper
`artifacts/api-server/src/lib/sendAs.ts` exporting
`companyFrom(company): string` returning the `From:` header value every outgoing
customer email must use (his company name, and his address when the mailbox
allows it). Everything that sends to a customer calls it. Other tracks must not
hand-roll a From header.
A2. **AI assist** (track AI owns it): `POST /ai/polish` body
`{ text: string, tone?: 'clear'|'professional'|'friendly' }` → `{ text: string,
available: boolean }`, gated on `XAI_API_KEY` exactly like `lib/aiAssistant.ts`
does today, returning `available: false` and the original text when the key is
missing. Consumers: the client email dialog, the document editor.
A3. **Matrix shape** (track MATRIX owns it): any change to `PricingEquation`
in the schema and to `calculatePrice` in `lib/helpers.ts` is MATRIX's alone.
Other tracks read prices through `priceService`/`calculatePrice` and must not
reach into the bands.
A4. **Write-off** (track INVOICES owns it): invoice statuses gain
`written_off`; `balanceOf` treats it like void (owes nothing). Anything that
sums balances must go through `balanceOf`.

## Definition of done
- Every item in your track built, or reported as not built with the reason.
- New endpoints in openapi.yaml, codegen run, server validates with the
  generated zod body, web uses the generated hook.
- Both typechecks pass except for other tracks' files.
- Your test file passes and covers the logic, not just the happy path.
- Every write that moves money, schedule or access calls `logAudit` with a
  description in his words.
- Report: files changed, endpoints, schema, what you did NOT build and why,
  exact URLs and clicks for the orchestrator to verify, and for each item a
  one-paragraph note in plain 3rd-grade words addressed to Adam saying what now
  works. That note is the only part he reads.
