# Verification — public legal pages and demo dataset, live

Date: 2026-08-27
Live at https://bisonlawncare.workoptional.tech

## Legal pages (required by Google OAuth verification)

| Request | Result |
|---|---|
| `GET /privacy` | 200 |
| `GET /terms` | 200 |

Both render **signed out** (they sit outside the `SignedIn` gate) — this is the
requirement, since Google's reviewer fetches them anonymously and a page that
renders null when signed out reads as a broken link.

`01-privacy-live.jpg` — header, effective date, and the first four sections
render. The "Google account data" section names the single `gmail.send` scope,
states the app cannot read/modify/delete mail, and carries the Limited Use
disclosure Google checks for.

Use these on the OAuth consent screen:
- Privacy policy: `https://bisonlawncare.workoptional.tech/privacy`
- Terms of service: `https://bisonlawncare.workoptional.tech/terms`

## Admin access on the live domain — previously unverified, now confirmed

`02-dashboard-live-signed-in.jpg`. Signed in as `koby@radiantaisoftware.com`
(the `APP_SECONDARY_OWNER_EMAIL` slot), the live host renders the full admin
shell: 13 admin nav sections and the Operations Dashboard.

Every earlier verification of admin access was on `localhost` or in a local
container. This is the first time it has been confirmed on the deployed
hostname, which was the outstanding gap.

## Seeded data, cross-checked against the database

| Dashboard tile | Shows | Source of truth |
|---|---|---|
| Total Clients | 4 | `SELECT count(*) FROM clients WHERE status='client'` = 4 |
| active leads | 5 | `... WHERE status='lead'` = 5 |
| Open Invoices | $150.00 | 2 open invoices at $75 each = $150 |
| Waiting List | 3 | 3 rows with `dispatched=false` |
| Open Tickets | 1 | 1 row with `status='open'` |
| Revenue (MTD) | $535.00 | paid invoices 190 + 85 + 260 = 535 |
| Jobs Today | 0 | correct — every seeded job is windowed, none dispatched to today |

Client balances are **computed** by the seed from invoices minus payments, not
hardcoded, so they agree with what the app recalculates on the next write.
Verified: the two clients carrying an unpaid $75 spray invoice show $75; all
others show $0.

## Deliberate departure from the pasted data

The dataset pasted from Replit contained random test identifiers (`Recheck
7MbOIW9u`, `cXUdTj`, `p9QNtB`, `Money p_IYwohz`, `de9NVR`). The seed reproduces
the *shape* of that data — same client/lead split, same invoice mix including a
voided duplicate, a vendor service to reconcile, one waiting-list job, one
ticket, one inbound web request — using believable names and Bozeman addresses,
because the owner reading random hashes would reasonably conclude the app is
broken.

Totals therefore differ from the pasted screenshot (Revenue MTD $535 vs $453).
The seeded numbers are internally consistent; they are not a reproduction of the
old figures.

## Not verified

- The estimate → email → accept/decline round trip against the live public URL.
- Contractor/mobile views on the live host.
- Spray Runs, Spring Letters, Automation screens were seeded but not opened.
