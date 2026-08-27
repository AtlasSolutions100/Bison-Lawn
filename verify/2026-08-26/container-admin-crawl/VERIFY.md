# Verification — admin UI, served from the deployment container

Date: 2026-08-26
Under test: `bison-crm:test` image, `docker run` on 127.0.0.1:8081, pointed at the
local Postgres. Same image and same entrypoint the VPS will run.
Signed in as `koby@radiantaisoftware.com`.

## Admin access (ask #3)

Container env: `APP_OWNER_EMAIL=bisonlawncarellc@gmail.com`,
`APP_SECONDARY_OWNER_EMAIL=koby@radiantaisoftware.com`.

| Source of truth | Expected | Actual |
|---|---|---|
| `users` table | one row, admin, granted by owner-email config | `Koby Stull / koby@radiantaisoftware.com / admin / owner` |
| Team Directory UI | same person shown as ADMIN | ADMIN badge — `04-team.annotated.jpg` |
| Sidebar | full admin nav, not the contractor bottom-nav | 13 admin sections rendered |

The secondary-owner slot is proven end to end, in the container, with the exact
env proposed for the server. Adam takes `APP_OWNER_EMAIL`, you take the secondary
slot. Both are non-demotable (`resolveOwnerAccess` returns `roleSource: "owner"`).

## Pages crawled

| Page | Result |
|---|---|
| `/dashboard` | Renders. Tiles: Jobs Today 0, Open Invoices $0.00, Waiting List 0, Open Tickets 0, Total Clients 1, Revenue MTD $0.00. Recent Activity shows the weather-check run. |
| `/clients` | Renders 2 rows: Mike Reynolds (LEAD), Sarah Thompson (CLIENT) |
| `/estimates` | Renders; tabs All Estimates / Builder / Custom Fields / Charge Presets |
| `/estimates` → Builder | Renders; client select, property fields, services |
| `/team` | Renders (after ~4s; it showed "Loading…" at 2s) |

**Count cross-check:** dashboard says "Total Clients 1 / 1 active leads"; the
clients list shows 2 rows, one LEAD and one CLIENT; `SELECT count(*) FROM clients`
returns 2. Consistent — the tile counts clients and leads separately.

## Feedback items confirmed visually

- **#9, horizontal matrix.** `03-estimate-builder.annotated.jpg` — Property
  Fields render one per row down the page (Turf Sqft, Sprinkler Zones, Bed Sqft,
  Gate Code, Dog, Hours), each a label plus a single input. This is the vertical
  layout Adam asked to be horizontal.
- **#8, service priced off a property detail.** "Sprinkler Zones — $12 per 1
  units" exists, but only as an *estimate field*. Services still price from sqft
  equations; the two are separate systems.
- **#1, add a contractor.** `04-team.annotated.jpg` — Team Directory has no
  "Add"/"Invite" control, only a per-row pencil to edit someone who already
  signed up. Matches the API: there is no `POST /users`.

## Checked and NOT a defect

The Builder's Summary panel looked clipped at the right edge in the capture.
Measured rather than reported: `window.innerWidth` 1659,
`document.documentElement.scrollWidth` 1659, no horizontal overflow. The
clipping was the 1469 px screenshot crop of a 1659 px viewport, not a layout bug.

## Not verified

- **Live Gmail send** — still nothing sent through a real Google OAuth client.
- Dispatch, Waiting List, Invoices, Spray Runs, Spring Letters, Tickets, Web
  Requests, Automation, Services pages were not opened.
- Contractor (mobile) views were not opened.
- No write operations were performed — this was a read-only crawl.
