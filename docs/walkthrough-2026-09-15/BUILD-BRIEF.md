# Build brief — Bison Lawn Care CRM, 2026-09-15 walkthrough

You are one of thirteen builders working IN PARALLEL in the same working tree. Each builder owns a track. Read this whole file first; it is the only place the shared rules and contracts live.

Repo: `C:\Users\kobys\OneDrive\Desktop\OptionallyWorking\BisonLawn\Bison-Lawn-Care-Adam-Johnson` (git repo; pnpm monorepo).
Requirements: `C:\Users\kobys\AppData\Local\Temp\claude\C--Users-kobys-OneDrive-Desktop-OptionallyWorking-BisonLawn\81dbc634-1aaf-4290-92a4-0607dc9b3ce8\scratchpad\meeting\requirements.md`
Survey of what already exists, per area (read yours fully; it has file:line evidence and a concrete approach): `...\scratchpad\meeting\survey\*.md`
What his current CRM's screens look like, by timestamp (grep it for the screen you are rebuilding): `...\scratchpad\meeting\screens.md`
His feedback items live in the `feedback` table; ids are referenced in requirements.md.

## Who Adam is
Adam Johnson owns Bison Lawn Care (Coeur d'Alene / Post Falls / Hayden, Idaho; a Washington branch). No employees, only subcontractors. 709 customers imported from Service Autopilot. He runs the office alone. Write UI copy and code comments in plain words he would use. Comments in this codebase explain the WHY in the owner's words; keep that style, and do not narrate what the code does.

## Hard rules (violating any of these is worse than not finishing)
1. Do NOT commit, stash, reset, checkout, rebase, or otherwise touch git state. The orchestrator commits. `git diff` / `git status` are fine for reading.
2. Do NOT deploy, do NOT ssh anywhere, do NOT touch production (31.220.50.13) or `.env.deploy`. Local only: DATABASE_URL in `.env` points at Postgres on localhost:5434.
3. Never run `seed-demo --reset`, never run `push-force`, never drop tables. Schema changes: edit `lib/db/src/schema/crm.ts` with the Edit tool (never Write the whole file) and run `pnpm --filter @workspace/db run push` (export `.env` first: `set -a; . ./.env; set +a` in bash). If push reports a conflict caused by another builder mid-edit, wait and retry; never force.
4. Emails: the only addresses anything may ever send to are koby@radiantaisoftware.com and kobystull123@gmail.com. Tests must not send real mail (mock Gmail like test/clientEmail.test.ts does). Never email Adam or any customer.
5. Other builders are editing other files right now. Use the Edit tool (targeted replacements) on any shared file; NEVER use Write on a file you do not own outright. Shared files: `lib/db/src/schema/crm.ts`, `lib/api-spec/openapi.yaml`, `artifacts/api-server/src/routes/index.ts`, `artifacts/api-server/package.json`, `artifacts/bison-crm/src/App.tsx`, `artifacts/bison-crm/src/components/layout/*`. If an Edit fails because the anchor changed, re-read that region and retry; do not restore old content you think is missing — another builder put it there.
6. Prefer NEW files: a new `routes/<yours>.ts` router mounted in routes/index.ts, new components under `artifacts/bison-crm/src/components/<area>/`, a new test file. Touch owned pages freely.
7. OpenAPI: `lib/api-spec/openapi.yaml` is the contract; after editing it run `pnpm --filter @workspace/api-spec run codegen`. If codegen fails on a YAML error in a region you did not write, another builder is mid-edit: wait 30 s and retry (up to 5 times). Never edit generated files. YAML gotcha: a description that begins with `true`/`false`/`yes`/`no`/`null` must be quoted.
8. Tests: node:test via `tsx --test`, pattern in `artifacts/api-server/test/integration.test.ts` (NODE_ENV=test + TEST_AUTH_TOKEN + `x-test-user-id`; admin seeded with role 'admin', roleSource 'owner_assigned'; clean up in `after`). Add `test/<yours>.test.ts` and a `"test:<yours>"` script, and append it to the `test` chain in `artifacts/api-server/package.json` (Edit tool). Run your own test file with `pnpm --filter @workspace/api-server run test:<yours>` (export .env first). Do not run the full `pnpm run test` chain (other builders' files may be mid-edit) — the orchestrator runs it at the end.
9. Typecheck your work: `pnpm --filter @workspace/api-server run typecheck` and `pnpm --filter @workspace/bison-crm run typecheck`. Errors in files you do not own belong to another builder; report them, do not fix them, unless the file is one you were told to consume (then tell the orchestrator which contract was broken).
10. The local dev servers are running: API http://localhost:3001 (restart NOT needed for tests; tests boot the app in-process), web http://localhost:5199. Do not restart or kill them. Do not use the browser tools; the orchestrator verifies in the browser.
11. Data: the local DB has 709 real customers plus seed data. Never delete or bulk-modify real customer rows; create your own test rows and remove them.
12. Do not narrow the requirement to make it fit. If something is genuinely impossible or needs a paid provider, build everything up to that line, make the UI say plainly what is off and why, and report it.

## Shared schema (already added and pushed — do not re-add; extend if you must, with Edit)
- users: displayName, birthday, hireDate, active, accessLevel ('full'|'office'|'mobile', default 'full'), permissions jsonb string[] (grants like "quickbooks" or denials like "!quickbooks"), smsProxyNumber.
- clients: parentClientId (master account), doNotEmail, source, referredByClientId. (lat/lng, officeNote, tags, billing* already existed.)
- services: code, invoiceDescription, billingMode ('fixed'|'time').
- client_services: assignedToId, frequency ('weekly'|'biweekly'|'monthly'), weekday (0-6), weekParity ('odd'|'even'), monthlyWeek (1-4), discountType ('amount'|'percent'), discountValue, discountLabel, contractorNote, noteStartDate, noteEndDate, pausedAt, pauseUntil, resumeWhenPaid, active.
- invoices: verifiedAt, verifiedById, deliveryMethod ('email'|'print'|'both'), printedAt.
- document_templates: category ('client'|'marketing'|'estimate').
- New tables: client_contacts, email_sends, automation_rules, automation_sends, user_locations, sms_messages. Read their definitions and comments at the end of crm.ts.

## Cross-track contracts (build EXACTLY these; someone else is coding against them right now)
C1. **Sending a document to customers** — owned by track DOCS. `POST /document-templates/{id}/send`, operationId `sendDocumentTemplate`, body `DocumentSendInput { clientIds: number[] (min 1), jobIds?: number[], tokens?: Record<string,string> (extra merge tokens like servicedate), source: 'dispatch'|'waiting_list'|'client_page'|'automation'|'invoice' }`, response `DocumentSendResult { batchId: string, sent: number, skipped: { clientId: number, clientName: string, reason: 'no_email'|'do_not_email'|'failed' }[] }`. Sends via Gmail with the merged HTML (logo + company block), writes one `email_sends` row per client (status sent/failed/skipped), respects `clients.doNotEmail` and empty emails, returns the counts. Consumers: DISPATCH (board + waiting list), CLIENT-ACCOUNT (Send button), DOCS (automations). Also `GET /document-templates?category=` already lists templates (operationId listDocumentTemplates) — DOCS adds the `category` filter.
C2. **Contractor colour** — exists: `artifacts/bison-crm/src/lib/contractor-color.ts` exports `contractorColor(userId)` and `initialsOf(name)`. Everyone uses it; nobody edits it.
C3. **Client page panels** — CLIENT-ACCOUNT owns `pages/client-detail.tsx` and mounts these components by exact path and default-export signature; the owning track creates the file:
   - `components/client/assigned-services.tsx` → `AssignedServicesPanel({ clientId }: { clientId: number })` — track CLIENT-SERVICES.
   - `components/client/accounting-panel.tsx` → `ClientAccountingPanel({ clientId })` — track INVOICES.
   - `components/client/jobs-panel.tsx` → `ClientJobsPanel({ clientId })` (All / Upcoming / History tabs + job detail dialog) — track CLIENT-ACTIVITY.
   - `components/client/activity-panel.tsx` → `ClientActivityPanel({ clientId })` (timeline, tickets, photos, notes open/closed) — track CLIENT-ACTIVITY.
   - `components/client/text-client-button.tsx` → `TextClientButton({ clientId, phone }: { clientId: number; phone: string | null })` — track GPS-SMS.
   If a file you must mount does not exist yet when you finish, create a stub with the exact signature that renders `null` and a `// STUB: <track> replaces this` comment; the owning track will overwrite it with Write (stubs are the ONE case where Write on another's file is allowed — only if the file contains the STUB marker).
C4. **Crew on the map** — track GPS-SMS creates `components/crew-locations.tsx` exporting `CrewLocationsLayer({ map, date }: { map: import('leaflet').Map | null; date: string })` (draws/updates its own L.layerGroup; safe to mount with map null) and `CrewStrip({ date }: { date: string })` (compact "last seen" list). Track DISPATCH mounts both (stub rule above applies).
C5. **Global search** — track REPORTS creates `components/global-search.tsx` exporting default `GlobalSearch()` (a button + dialog). Track TEAM-ACCESS mounts it in the admin layout header (stub rule applies).
C6. **Access** — track TEAM-ACCESS creates `artifacts/api-server/src/lib/access.ts` exporting `can(user, area)` and middleware `requireArea(area)` where area ∈ 'dispatch'|'clients'|'invoices'|'quickbooks'|'reports'|'settings'|'team'|'documents', and `artifacts/bison-crm/src/lib/access.ts` exporting `useCan(area)`. Other tracks keep using `requireAdmin` today; TEAM-ACCESS applies `requireArea` centrally.
C7. **Service pricing for an assigned service** — CLIENT-SERVICES owns `lib/invoiceFromJob.ts` changes for the discount line and time-billed amounts; INVOICES owns everything after an invoice exists (verify / edit lines / undo / send / print).
C8. **Jobs routes** — `routes/jobs.ts` is shared between CLIENT-SERVICES (generation, recurrence) and DISPATCH (bulk actions). DISPATCH puts bulk endpoints in a NEW `routes/dispatch-actions.ts`; CLIENT-SERVICES puts assigned-service endpoints in a NEW `routes/client-services.ts` (note: `router.use(["/clients","/client-services"], requireAuth, requireAdmin)` in routes/clients.ts already guards `/client-services`). Both may Edit jobs.ts sparingly.

## Definition of done for a track
- Every numbered requirement in your track is built, or explicitly reported as not built with the reason.
- New/changed endpoints are in openapi.yaml, codegen ran, server uses the generated zod bodies, web uses the generated hooks.
- Typecheck passes for api-server and bison-crm (except errors you can prove belong to another track).
- Your test file passes. Tests cover the server logic, not just happy paths (e.g. do-not-email skipped, discount math, week parity, undo restores the job).
- Every UI you add works against the local API (you may curl with the test escape hatch or write a quick tsx script; do not use the browser).
- Audit: every write that changes money, schedule or access logs an audit event via `logAudit` (lib/helpers.ts) with a description in his words.
- Report back (this is your return value; be exact): files created/changed; endpoints added; schema added; feedback ids addressed and, for each, a one-paragraph note in plain 3rd-grade words addressed to Adam saying what now works (this becomes the note he reads in the app); what you did NOT build and why; exact URLs + steps the orchestrator should click through to verify in the browser; any contract you had to deviate from.
