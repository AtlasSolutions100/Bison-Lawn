export const meta = {
  name: 'review-and-fix-walkthrough',
  description: 'Fix known integration gaps, adversarially review every track diff, verify findings, fix confirmed ones, then run the whole suite',
  phases: [
    { title: 'Known fixes', detail: 'three fixers on disjoint files' },
    { title: 'Review', detail: 'one reviewer per track diff' },
    { title: 'Verify', detail: 'two lenses per finding' },
    { title: 'Fix', detail: 'one fixer per track for confirmed findings' },
    { title: 'Integrate', detail: 'typecheck, build, full suite' },
  ],
}
const REPO = 'C:\\Users\\kobys\\OneDrive\\Desktop\\OptionallyWorking\\BisonLawn\\Bison-Lawn-Care-Adam-Johnson'
const SP = 'C:\\Users\\kobys\\AppData\\Local\\Temp\\claude\\C--Users-kobys-OneDrive-Desktop-OptionallyWorking-BisonLawn\\81dbc634-1aaf-4290-92a4-0607dc9b3ce8\\scratchpad'
const BRIEF = SP + '\\meeting\\BUILD-BRIEF.md'
const REPORTS = SP + '\\meeting\\BUILD-REPORTS.md'
const RULES = `Repo: ${REPO}. Read the rules section of ${BRIEF} first (no git state changes, no deploy, no production, local DB only, Edit not Write on shared files, codegen after spec edits, run \`set -a; . ./.env; set +a\` before drizzle push or tests, never run seed-demo --reset or push-force, emails only to koby addresses). Other agents are editing other files at the same time. Build reports from the twelve builders (what each built, its endpoints, decisions and gaps) are in ${REPORTS}.`
const trackFiles = args.trackFiles
const TRACKS = Object.keys(trackFiles)

const FIX_SCHEMA = { type: 'object', properties: { done: { type: 'array', items: { type: 'string' } }, notDone: { type: 'array', items: { type: 'string' } }, filesChanged: { type: 'array', items: { type: 'string' } }, tests: { type: 'string' } }, required: ['done', 'notDone', 'filesChanged', 'tests'] }
const FINDINGS_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, title: { type: 'string' }, detail: { type: 'string', description: 'what is wrong, the concrete input/state that triggers it, and the wrong outcome' }, fix: { type: 'string', description: 'the concrete change' } }, required: ['file', 'line', 'severity', 'title', 'detail', 'fix'] } } }, required: ['findings'] }
const VERDICT_SCHEMA = { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] }

// ---------- Phase 1: known fixes (parallel, disjoint files) ----------
const KNOWN = [
  { key: 'invoices-tests', prompt: `${RULES}

Fix these failing tests without weakening what they check, by fixing the product behaviour:
1. test/extraWork.test.ts — 4 failures 'pending' !== 'paid' (log: ${SP}\\test-full.log lines 1986-2058). Cause: invoices created at job completion now start as status 'pending' (needs verification, INVOICES track) and a payment that covers the whole total no longer flips the invoice to 'paid'. Decide the rule and implement it in the payment path (routes/billing.ts and wherever payments recompute invoice status): money in hand wins — when amountPaid >= total the invoice becomes 'paid' whether or not it was verified; a partial payment on a pending invoice stays 'pending' (still needs verification) and the verify step then computes open/partial from amountPaid. Make sure the Invoices page queues (Needs verification / To email / To print / Open / Past due / Paid) still make sense with that rule and that the verify endpoint does not un-pay a paid invoice.
2. test/creditAndSchedule.test.ts — 2 failures (log: ${SP}\\test-credit-and-schedule.log). Read the assertion, find whether the product or the test intent changed (CLIENT-SERVICES changed package window handling: an inherited end date before an overridden start is refused with 400), and fix the product if the product is wrong, or update the test's dates if the test's intent is preserved. Explain which in your report.
Then run test:extra-work, test:credit-and-schedule, test:invoice-verify, test:client-services and test:integration and report counts.` },
  { key: 'dispatch-wiring', prompt: `${RULES}

Two wiring gaps on the dispatch board (artifacts/bison-crm/src/pages/dispatch.tsx, yours to edit):
1. ProductsPopover (around line 1093): the server now accepts POST /jobs/{id}/products with { presetId, quantity } (CLIENT-SERVICES track; hooks useListProductPresets / useAddJobProduct or similarly named — check lib/api-client-react/src/generated/api.ts). Add a preset picker (bag fee, sprinkler parts…) plus a quantity input so the office can add a preset with a quantity from the board, keeping the free-text path.
2. Undo a completed job from the board: the row menu currently says 'Completed and invoiced. Undo it from the invoice.' (around line 1046). INVOICES built POST /jobs/{id}/uncomplete (hook useUncompleteJob or similar) which puts the job back and removes its invoice line. Replace the message with an 'Undo completion' action calling that endpoint, with a window.confirm that says what will happen, and invalidate the jobs and invoices queries.
Typecheck bison-crm afterwards.` },
  { key: 'misc-guards', prompt: `${RULES}

Small cross-track fixes, each in a different file:
1. artifacts/api-server/src/lib/analytics.ts: the report SQL labels contractors with u.name; use coalesce(nullif(u.display_name,''), u.name) in every 'as contractor' select so the board and the reports show the same short name.
2. artifacts/api-server/src/routes/clients.ts: DELETE /clients/:id has no guard and no audit. Refuse (409, plain message) when the client has invoices or payments and point at 'Set status to Former' instead; otherwise delete and logAudit 'client_deleted' with the name. Keep the existing bulk-delete route in clients-bulk.ts as it is.
3. artifacts/api-server/src/routes/locations.ts: GET /team/locations uses requireAdmin; switch to requireArea('dispatch') from lib/access.ts so an office user can see the crew. Same check for routes/dispatch-actions.ts, routes/dispatch-map.ts, routes/route-builder.ts, routes/client-services.ts, routes/client-contacts.ts, routes/client-activity.ts, routes/clients-bulk.ts, routes/search.ts: where they use requireAdmin for office-type work, use requireArea('dispatch' or 'clients') — read lib/access.ts and test/access.test.ts first so full/office users keep working and mobile users are still refused. Do NOT touch routes/automation.ts (already scoped) or quickbooks/reports/settings/team/invoices (already fenced).
4. artifacts/api-server/src/routes/index.ts: leave the order; but confirm with a quick in-process test (copy the pattern from test/access.test.ts) that a contractor can POST /jobs/{id}/clock-in and GET /jobs/{id}/photos without a 403 now that automation.ts scopes its guard; add that assertion to test/access.test.ts.
Run test:access and test:reports and report counts.` },
]
phase('Known fixes')
const known = await parallel(KNOWN.map(k => () => agent(k.prompt, { label: k.key, phase: 'Known fixes', schema: FIX_SCHEMA, effort: 'high' })))
log(`known fixes: ${known.filter(Boolean).length}/3 reported`)

// ---------- Phase 2: adversarial review per track ----------
phase('Review')
const reviews = await pipeline(TRACKS,
  (t) => agent(`${RULES}

You are reviewing track ${t}. Its changed files (relative to the repo) are:
${trackFiles[t].map(f => '- ' + f).join('\n')}
Use \`git diff HEAD -- <file>\` for modified files and read new (untracked) files whole. Read the track's section in ${REPORTS} to know what it claims. Then hunt for real defects only — things that produce a wrong result, lose data, break another track's contract, let a contractor see office data, double-send an email, miscompute money or dates (timezones: his business is in Idaho; dates are stored as YYYY-MM-DD strings), or crash on an empty/odd input. For each, give the concrete input or state that triggers it and the wrong outcome. Skip style, naming, and speculation. Do not edit files.`,
    { label: `review:${t}`, phase: 'Review', schema: FINDINGS_SCHEMA, effort: 'high' }),
  (r, t) => (r ? r.findings.map(f => ({ ...f, track: t })) : []),
)
const allFindings = reviews.flat().filter(Boolean)
log(`${allFindings.length} findings from ${TRACKS.length} reviewers`)

// ---------- Phase 3: verify each finding with two lenses ----------
phase('Verify')
const verified = await pipeline(allFindings,
  (f) => parallel(['reproduce it by reading the exact code path and tracing the input', 'refute it: find the guard, test, or invariant that makes it impossible'].map(lens => () =>
    agent(`${RULES}

Finding from a reviewer on track ${f.track}: "${f.title}" at ${f.file}:${f.line}.
Detail: ${f.detail}
Proposed fix: ${f.fix}

Your lens: ${lens}. Read the code. Default to real=false if you cannot show the wrong outcome concretely. Do not edit files.`,
      { label: `verify:${f.track}:${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' }))),
  (votes, f) => ({ ...f, real: votes.filter(Boolean).filter(v => v.real).length >= 1 && !(votes.filter(Boolean).length === 2 && votes.filter(Boolean).every(v => !v.real)) , votes: votes.filter(Boolean).map(v => v.reason) }),
)
const confirmed = verified.filter(Boolean).filter(f => f.real)
log(`${confirmed.length}/${allFindings.length} findings confirmed`)

// ---------- Phase 4: fix confirmed findings, one fixer per track ----------
phase('Fix')
const byTrack = {}
for (const f of confirmed) (byTrack[f.track] ||= []).push(f)
const fixes = await parallel(Object.keys(byTrack).map(t => () => agent(`${RULES}

Fix these confirmed defects in track ${t}. Files of this track: ${trackFiles[t].join(', ')}. Keep changes minimal and add or extend a test in the track's test file for each fix. Run that test file.
${byTrack[t].map((f, i) => `${i + 1}. [${f.severity}] ${f.title} — ${f.file}:${f.line}\n   ${f.detail}\n   Proposed fix: ${f.fix}\n   Verifier notes: ${f.votes.join(' | ')}`).join('\n')}`,
  { label: `fix:${t}`, phase: 'Fix', schema: FIX_SCHEMA, effort: 'high' })))
log(`fixers reported: ${fixes.filter(Boolean).length}/${Object.keys(byTrack).length}`)

// ---------- Phase 5: integration ----------
phase('Integrate')
const integ = await agent(`${RULES}

You are the integrator. Run, in order: \`pnpm --filter @workspace/api-spec run codegen\`; \`pnpm --filter @workspace/db run push\` (env exported); \`pnpm run typecheck\` at the repo root; \`pnpm --filter @workspace/api-server run build\`; \`pnpm --filter @workspace/bison-crm run build\`; then the full \`pnpm --filter @workspace/api-server run test\` chain. Fix whatever fails (you may edit any file; keep fixes minimal and in the spirit of the track that owns the file — read its section in ${REPORTS}). Repeat until everything passes or you can prove a failure needs a product decision. Then restart the local API dev server so the orchestrator can verify in the browser: kill any node process running artifacts/api-server/dist/index.mjs, then from artifacts/api-server run \`PORT=3001 node --enable-source-maps dist/index.mjs\` in the background with .env exported (bash: \`set -a; . ../../.env; set +a; PORT=3001 nohup node --enable-source-maps dist/index.mjs > ${SP}\\api.log 2>&1 &\`) and confirm GET http://localhost:3001/api/health answers. Report exact counts.`,
  { label: 'integrate', phase: 'Integrate', schema: { type: 'object', properties: { typecheck: { type: 'string' }, build: { type: 'string' }, tests: { type: 'string' }, fixed: { type: 'array', items: { type: 'string' } }, unresolved: { type: 'array', items: { type: 'string' } }, apiUp: { type: 'boolean' } }, required: ['typecheck', 'build', 'tests', 'fixed', 'unresolved', 'apiUp'] }, effort: 'high' })
return { known, findings: allFindings.length, confirmed: confirmed.map(f => ({ track: f.track, severity: f.severity, title: f.title, file: f.file, line: f.line })), fixes, integ }