export const meta = {
  name: 'build-adam-notes-2026-09-28',
  description: "Eleven parallel builders work through Adam's 2026-09-28 notes: his reported bugs first, then invoices, matrix, services, client, email, dispatch, reports, settings, AI assist",
  phases: [{ title: 'Build', detail: 'one builder per track, same working tree' }],
}
const REPO = 'C:\\Users\\kobys\\OneDrive\\Desktop\\OptionallyWorking\\BisonLawn\\Bison-Lawn-Care-Adam-Johnson'
const BRIEF = 'docs/notes-2026-09-28/BUILD-BRIEF.md'
const SPEC = 'docs/notes-2026-09-28/requests.md'

const TRACKS = [
  { key: 'BUGS', items: 'B1, B2, B3 (his three reported bugs)',
    owns: 'wherever the bug lives — estimates pricing, jobs/users hydration for the dispatch assignee list, invoice creation and its appearance on the client account; test/adamBugs.test.ts (NEW)',
    extra: `REPRODUCE EACH BEFORE CHANGING ANYTHING, and say in your report exactly how you reproduced it or why you could not.
B1 "when creating an estimate the numbers don't match the matrix based on clients account — example 615 E 18th". The local DB has his imported customers; find the one at 615 E 18th (BLC / Bison Idaho). Build an estimate line for a matrix-priced service against that account through the real route and compare with what the service page's live tester and assigned-services both produce for the same property value. Suspects: which custom field the service prices from vs which the client actually has (case/label mismatch), the band chosen at a boundary, quantity vs visits, or a flat-rate fallback when the field is missing. Fix the mismatch so all three paths agree, and add a test that asserts estimate line == assigned-service price == matrix tester for the same client and service.
B2 "accepted contractor not popping up on dispatch board". A contractor who accepted an invitation should be assignable. Check useContractors (components/dispatch/contractors.ts) — it filters role==='contractor' AND active!==false on GET /users. Check what a just-accepted invitation produces: role, accessLevel, active, and whether dedupeUsersByPerson or the non-team-user projection drops them. Adam Eich accepted on 2026-09-14 and is role admin — an admin who works jobs would never appear in that list, which may be the whole bug. Decide and fix so anyone who can be sent to a job is offerable, and say what rule you chose.
B4 is SENDER's. Do not touch sending.
B3 "creating invoice needs to show up on clients account": raise an invoice through POST /invoices for a client and confirm it appears in the client's Accounting panel and activity timeline; if the panel filters by a queue or by verification state it may hide a brand-new one. Fix so a bill he just made is visible on the account immediately.` },

  { key: 'SENDER', items: 'B4, B5, E2, E3',
    owns: 'artifacts/api-server/src/lib/sendAs.ts (NEW), lib/gmail.ts, lib/clientEmail.ts, lib/documentSend.ts (From header only), lib/invitationEmail.ts, lib/invoiceDelivery.ts, lib/letterDelivery.ts, routes/email-activity.ts, test/sendAs.test.ts (NEW)',
    extra: `B5 is the important one: "Document comes from Koby, needs from Bison Lawn Care." Everything we send a customer currently goes out as Koby's mailbox because that is the Gmail account behind GOOGLE_REFRESH_TOKEN. Own contract A1: lib/sendAs.ts exporting companyFrom(company) used by EVERY customer-facing send. Gmail will only let you set From to the authenticated address or a verified alias, so set a display name of his company and a Reply-To of his address (company_profile.email), which is what actually reaches his customers and what they hit Reply on. Make Gmail's sendAs aliases work if the account has one — check the API and fall back gracefully. Put a short honest line in Settings saying which address customers see and what would be needed to send fully as his own domain.
B4 "Eich did not receive email": prove the invitation path. Adam Eich accepted on 2026-09-14 so it may be stale, but check invitations.email_error, whether a resend works, and whether the invite lands in spam because of the From mismatch (which B5 fixes). Report what you find.
E2 "post unopened email to account": an email that was never opened should be visible on the customer's account — surface email_sends openedAt/not-opened on the client activity timeline (CLIENT-ACTIVITY owns the panel; expose what it needs through the API and tell them, or add it yourself if the panel already renders email rows).
E3 "automation sent to admin for unopened invoices/emails": a rule that tells HIM (not the customer) when an invoice email has gone N days unopened. Gmail opens are approximate (image proxies, Apple Mail prefetch) so the wording must say "not opened yet" rather than assert the customer ignored it. Ship it switched OFF like every other rule, with a Preview.` },

  { key: 'INVOICES', items: 'M1, M2, M3, M4, M5',
    owns: 'artifacts/api-server/src/routes/billing.ts, lib/invoiceDocument.ts (balanceOf), artifacts/bison-crm/src/pages/invoices.tsx, components/billing/*, components/client/accounting-panel.tsx, artifacts/bison-crm/src/pages/my-jobs.tsx (field payment only), test/invoiceMoney.test.ts (NEW)',
    extra: `Own contract A4 (written_off status; balanceOf treats it as owing nothing).
M1 unlock a sent invoice: a bill already emailed cannot be edited today. Add an explicit Unlock that says what it means (the customer has a copy of the old one), audits who did it, and puts the invoice back in Needs verification so it must be re-verified and re-sent.
M2 his Jackie Wagner case: write off a balance, or mark it sent to collections, instead of deleting it. Both keep the invoice and its history; the balance stops counting toward what the customer owes; the account shows why. Audit both with the amount and the reason.
M3 take a payment in the field: a contractor on a job can record a payment against that customer with the card fee percentage applied (payments.cardFee exists). Keep it behind an access check so only someone allowed to touch money can.
M4 when raising an invoice, find the customer by anything on their account (name, address, phone, account number), and adding a service prices it from that customer's matrix value rather than the flat rate.
M5 a running total for the customer, visible to the office: what they owe now, what is not yet invoiced, credits and prepayments. The client header already shows a balance — make the figure complete and explain each part in a word.` },

  { key: 'MATRIX', items: 'X1, X2, X3, X4 and feedback #42',
    owns: 'lib/db/src/schema/crm.ts (PricingEquation only), artifacts/api-server/src/lib/helpers.ts (calculatePrice), routes/services.ts, artifacts/bison-crm/src/pages/services.tsx, test/pricing.test.ts, test/matrixIO.test.ts (NEW)',
    extra: `You own contract A3. Nobody else touches PricingEquation or calculatePrice.
X1 is the one he is actually blocked on: "my starting field on matrix has a min and then from there the Price equation need to take over but I cant set a base." Give a service a minimum charge and a base price the per-unit equation builds from, so a band can read "start at $49, then $5 per 1000 over 5,000 sqft, never less than $49". Make calculatePrice honour both, keep every existing band working unchanged, and show it in the live tester.
X2 the matrix is too wide to read: he cannot see From→To without scrolling sideways. Make the whole band legible at a normal window — tighten columns, freeze the From/To pair, or lay it out so the numbers he compares sit together. Measure what you changed.
X3 copy a matrix and add a product cost that scales with square footage: his examples are Aeration + seed = AE overseed, and top dressing where the cost is product per sqft + delivery + trailer. Extend the existing copy dialog with an optional "add a product cost" of the shape (amount per N sqft) + (flat amount), previewed before applying like the current multiplier is.
X4 export a matrix to Excel (CSV is fine if you say so in the UI) and import one back, which is feedback #42 — "Example in google drive (top dressing)". The import must show him what it read and let him accept or cancel before anything is saved, because a bad import silently repricing his catalogue is the worst outcome here.` },

  { key: 'SERVICES', items: 'S1, S2, S3, S4, S5, S6',
    owns: 'artifacts/api-server/src/routes/client-services.ts, lib/jobGeneration.ts, lib/clientServiceTick.ts, routes/services.ts (packages only, coordinate with MATRIX), artifacts/bison-crm/src/components/client/assigned-services.tsx, test/serviceChanges.test.ts (NEW)',
    extra: `S1 is the valuable one: when he changes a service's price, hours or description, ask whether to push it onto the customers who already have it — and say how many are affected before he answers. Never push silently. Audit what was pushed.
S2 a package should not need a year: its window is a month and day that renews every year. Make a package's dates year-free where that is what he means, and keep assignment resolving them against the right season.
S3 "renew date is not client specific but Product based": the renew date belongs to the service, and every customer with it follows. Check what client_services.renewDate does today and make the service's date the one that governs, with the per-customer value as an override only if one was deliberately set.
S4 one season end date for all mowing, with the ability to end a customer earlier and cancel their upcoming visits. A bulk "season ends on" for a service, plus per-customer early finish.
S5 order the packages and services on an account by when their window starts, not by id.
S6 "mowing jobs stay on account with last year's details" — last season's assignment and its history stay visible on the account after it renews, rather than being replaced.` },

  { key: 'CLIENT', items: 'C1, C2, C3, C4, C5',
    owns: 'artifacts/bison-crm/src/pages/client-detail.tsx, components/client/* (except accounting-panel), artifacts/api-server/src/routes/clients.ts, routes/client-activity.ts, artifacts/bison-crm/src/pages/clients.tsx (map view), test/clientNotes.test.ts (NEW)',
    extra: `C1 "show all clients on map": a map of every customer, coloured or filtered the way the clients list is filtered, so he can see his book geographically. Reuse the Leaflet component the dispatch map uses rather than adding a mapping dependency.
C2 sub accounts: list them in alphanumeric order; stop a former client being added as a sub account; and when a property moves under a master, the old standalone entry should not sit greyed out in the list confusing him — decide what "unviewable" means (hidden from the main list but reachable from the master) and say what you chose.
C3 tags become a managed list he picks from, with multiple tags per customer, instead of free text that makes a second tag out of a typo. Keep every tag already on the 709 customers working; offer them as the starting list.
C4 the activity timeline newest first.
C5 "Billing, Property details all in button on editing client" — he wants to reach billing and property details without hunting. Look at what the Edit path does now and make those two reachable in one press from the account.` },

  { key: 'EMAIL-ACTIVITY', items: 'E1 and the Marketing group',
    owns: 'artifacts/api-server/src/routes/email-activity.ts, artifacts/bison-crm/src/pages/email-activity.tsx (NEW), App.tsx route + nav entry (Edit, carefully), test/emailActivity.test.ts (NEW)',
    extra: `"Central location for all emails that when out at the same time, not just in clients account, List with clients name and information", plus "Results, completed" and "Delivered opens up to customer account".
In his old system this was the screen he called huge: a bulk send, then counts back — "out of the 30 emails that were sent 30 were delivered and 21 were opened. That's very, very good data for me." Build it as its own page in the nav: every batch newest first with the document, what it was sent from (board, waiting list, client page, automation, invoice), how many went, failed, were skipped and why, and how many have been opened; open a batch to get the list of customers with their address, the time sent and whether and when they opened it; and every customer name links to their account. The email_sends table already records all of this including openToken/openedAt. Be honest in the wording that an open is approximate — image proxies and prefetching mean "not opened yet" is softer than "they ignored it".` },

  { key: 'DISPATCH', items: 'D1, D2, D3, D4, D7',
    owns: 'artifacts/bison-crm/src/pages/dispatch.tsx, components/dispatch/*, components/dispatch-map.tsx, artifacts/api-server/src/routes/dispatch-actions.ts, routes/jobs.ts (crew only), test/dispatchCrew.test.ts (NEW)',
    extra: `D1 "when coming back would be nice to come back to same screen that I left": the board should remember the date range, the contractor, the filters and the scroll position per session, so leaving to a customer and coming back does not reset his day. localStorage, wrapped in try/catch.
D2 show every contractor's jobs by default when the board opens, with picking one still available. Check what it does today before changing it — the contractor select already defaults to all, so find what actually made him say this (possibly the sub tiles filtering, or a remembered filter).
D3 "adjust route and save manually without having to redo all the numbers": let him type a new number on one stop and have the others shuffle around it, rather than renumbering the whole run. The Order box is already an input — make editing one number move that stop to that position and renumber the rest in order.
D4 "columns search using custom fields": filter the board by a customer custom field (Turf Sqft, gate code, sprinkler zones), and offer those fields as columns.
D7 "document crew member on clean ups, add crew members to day": more than one person on a job. jobs.assignedToId is single today — add a crew (additional people) on a job, show them on the board and on each person's own job list, and make sure the stop appears for everyone on it. Keep assignedToId as the lead so nothing that reads it breaks.` },

  { key: 'REPORTS', items: 'R1, R2, R3, R4',
    owns: 'artifacts/api-server/src/lib/analytics.ts, routes/reports.ts, artifacts/bison-crm/src/pages/reports.tsx, test/reportsMore.test.ts (NEW)',
    extra: `R1 the two he actually used in his old system every month: a cash-basis report (money received in the period, by date paid) and an accrual report (money invoiced in the period, by invoice date). Make the difference between them obvious in a sentence on screen, because that difference is the whole point of having both. Both exportable by date range like the existing reports.
R2 "time to complete jobs": how long jobs actually take, from job_time_entries, by service and by contractor, next to the budgeted hours.
R3 "spread of crews": how the work is distributed — stops, hours and revenue per contractor over a range, so he can see who is loaded and who is light.
R4 square footage per DAY per crew (there is a per-week one already; reuse its turf-sqft reading).
Follow the existing curated-report pattern in lib/analytics.ts so each one is answerable from the plain-English box too.` },

  { key: 'SETTINGS', items: 'G1, G2, G3, G4, G5, and E5 underline',
    owns: 'artifacts/bison-crm/src/pages/settings.tsx, artifacts/api-server/src/routes/settings.ts, routes/tickets.ts, artifacts/bison-crm/src/pages/tickets.tsx, artifacts/bison-crm/src/pages/spring-letters.tsx, routes/letters.ts, lib/richText.ts (underline only), test/ticketCategories.test.ts (NEW)',
    extra: `G1 ticket categories, his exact list: Account Issue, Billing, Cancel Request, Change Service, Email, Estimate, Other, Reschedule request, Review, Schedule Service, Terminate service, Upsell, Marketing. A category on a ticket, filterable, editable in Settings so he can add his own.
G2 "add customer field effects all clients": adding a custom field should make it available on every customer, not just the one he was looking at. Check how propertyData works today and give him a managed list of fields in Settings.
G3 his product list, seeded with the examples he named: small bags, pinecones, sprinkler parts. charge_presets exists; make sure the list is editable in Settings and reachable where a contractor adds one to a job.
G4 "signed estimates to send to management companies": an accepted estimate should produce a document showing who accepted it and when, suitable to forward to a management company. The public accept route already records acceptance — put that on the PDF.
G5 spring letters: select all, set a custom price for some, raise others by a percent — check what the bulk adjustment does today and close the gap.
E5 add underline to richText.ts (he asked for "bold, underline, italic ext Word Doc features"; bold and italic shipped). Use a marker that will not collide with the existing ones and render it in HTML and the PDF.` },

  { key: 'AI', items: 'E4',
    owns: 'artifacts/api-server/src/lib/aiAssistant.ts, routes/ai.ts (NEW), artifacts/bison-crm/src/components/ai-polish.tsx (NEW), wiring into components/client/email dialog and pages/settings.tsx document editor, test/aiPolish.test.ts (NEW)',
    extra: `"When sending emails — having an option to use AI for clarity and professionalism, currently use chatgpt. Like in GMail." And "be able to copy and paste ChatGPT creation into Doc or have an AI version in CRM."
Own contract A2: POST /ai/polish { text, tone? } -> { text, available }. Gate on XAI_API_KEY the way lib/aiAssistant.ts already does (xConfigured()), and when it is missing return available:false with the text untouched so the button can explain itself rather than fail.
The UI is a small "Polish" control next to any box where he types something a customer will read: the client email dialog and the document template editor. It must show him the rewrite and let him accept or reject it — never silently replace what he wrote. Keep his merge tokens ([clientname] etc.) intact through the rewrite; say so in the prompt you send and assert it in a test with a fake provider. Never send customer data beyond the text he is editing.` },
]

const SCHEMA = {
  type: 'object',
  properties: {
    track: { type: 'string' },
    built: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, status: { type: 'string', enum: ['built', 'partial', 'not_built'] }, note: { type: 'string' } }, required: ['item', 'status', 'note'] } },
    reproduced: { type: 'string', description: 'for BUGS: exactly how each bug was reproduced, or why it could not be' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    endpoints: { type: 'array', items: { type: 'string' } },
    schemaChanges: { type: 'array', items: { type: 'string' } },
    adamNotes: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, note: { type: 'string', description: 'plain 3rd-grade words to Adam: what now works' } }, required: ['item', 'note'] } },
    notBuilt: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, why: { type: 'string' } }, required: ['what', 'why'] } },
    verifySteps: { type: 'array', items: { type: 'string' } },
    questionsForAdam: { type: 'array', items: { type: 'string' } },
    typecheck: { type: 'string' },
    tests: { type: 'string' },
  },
  required: ['track', 'built', 'filesChanged', 'endpoints', 'schemaChanges', 'adamNotes', 'notBuilt', 'verifySteps', 'typecheck', 'tests'],
}

const RESUME_NOTE = `

IMPORTANT — YOU ARE RESUMING. A previous builder on this exact track was cut off part-way through. Its work is already in the working tree, uncommitted. Before writing anything: run \`git status --short\` and \`git diff --stat\`, read the files you own that it already changed, and read any new files it created in your area. Continue from where it stopped — do not start over, do not revert its work, and do not duplicate a thing it already finished. Its schema columns may already be pushed; run the push again to be sure (it is idempotent). Its openapi entries may be half-written, so run codegen and fix only what is yours. Other builders are resuming at the same time, so Edit rather than Write on shared files and retry when an anchor has moved.`
phase('Build')
const results = await parallel(TRACKS.map(t => () => agent(
`You are the builder for track ${t.key}.

Repo: ${REPO}
FIRST read ${BRIEF} in full, then your items in ${SPEC}.

Your items: ${t.items}
Files you own: ${t.owns}

${t.extra}

Work method: read the code you own and the code you consume before writing a line. Build server, spec, codegen, web and tests. Verify your endpoints by booting the app in-process with the test escape hatch — do not use the browser and do not start dev servers. Write code and comments the way this repo does: explain why, in his words. Run both typechecks and your own test file, then return the structured report. Do not stop to ask questions — decide, build, and put the decision in the report. If an item turns out to be already built, say so with the evidence rather than rebuilding it.` + ((args && args.resumed && args.resumed.includes(t.key)) ? RESUME_NOTE : ''),
  { label: t.key, phase: 'Build', schema: SCHEMA, effort: 'high' })))
const ok = results.filter(Boolean)
log(`${ok.length}/${TRACKS.length} tracks reported`)
return ok