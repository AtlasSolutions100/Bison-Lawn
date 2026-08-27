# Live verification of the parallel feature build

Date: 2026-08-27 · https://bisonlawncare.workoptional.tech · deployed 1a097e6

Everything below was exercised in a browser against the deployed app and the
production database. Four subagents each ended their run saying "not verified in
a browser"; this is that pass.

## Rate matrix (feedback: matrix layout, service calculation)

Editor renders one band per row — From / To / Rate / B. Hrs / B. Cost — matching
the Service Autopilot screen he asked us to copy. The derived "From" is correct
at every boundary: 4000 -> 4001, 5000 -> 5001.

Priced through the real API with Live Test: **4500 sqft -> $55.00**, the band-2
rate. Boundary cases were checked separately against his own figures (3999/4000
-> $49/0.25h, 4001/5000 -> $55/0.25h, 5001 -> $59/0.3h, 18500 -> $112/1.15h).

## Route builder (feedback #24)

Seeded a 14-job, $1,890 backlog across three zones to make the caps meaningful.

Preview with a $500 cap: **4 stops, $500.00, 3.2 hrs, 10 left waiting**, with
"Stopped at the dollar cap. 10 matching jobs stay on the waiting list,
untouched." Running total reads $95 → $170 → $305 → $500 — it lands *exactly* on
the cap, which is the float-epsilon case the author flagged. 95+75+135+195 = 500,
and 4 + 10 = 14.

Applied. Result in the database: four jobs dispatched with route orders 1–4 and
the chosen date; **10 still waiting, of which 0 wrongly carry a route order** —
the remainder is genuinely untouched, not half-modified. One audit line, not 400:

    route_built: Built a 4 stop route for 2026-08-27 from the waiting list
    (all areas), 500 total, 10 left waiting

The bulk `CASE` update the author called out as his one untested risk was also
exercised separately against production inside a rolled-back transaction before
this: statement accepted, orders assigned, and the rollback restored the rows.

## Clock in/out and photos (feedback #23)

- Clock in: on-site strip with a live counter; the state survived a page reload,
  so it is server-side rather than a client timer.
- **Second clock-in returned 409** ("Already clocked in to this job") and left
  exactly one open entry — the double-tapped-phone case, which would otherwise
  bill the visit twice.
- Clock out: entry closed at **1.1 minutes** for a 65-second visit, attributed to
  the right person.
- **Clock-out with nothing open returned 409** ("Not clocked in to this job").
- Location was unavailable in this browser and neither punch was blocked, which
  is the designed behaviour.
- Photo round-trip: upload 201; content route returned 200, `image/png`, **3195
  bytes out against 3195 recorded**, PNG magic bytes intact. Thumbnail renders on
  the card with its BEFORE badge.

## Map code, water district, timer locations (feedback #17, #18)

Zone badges render with one colour per code, consistent across rows. Filter works
(12 rows -> 4, every row BELG). Client record carries Map Code and Water District
with a "Look up provider" link, and copy explaining the district governs the
backflow test and blow-out.

Timer locations saved on the client page and **appeared on the crew's job card** —
the round trip that is the entire point of that request.

## Estimate attachments (feedback #19, and the gap open since week one)

Send dialog offers "Documents to include", each labelled "Attached as a PDF with
<customer>'s details filled in", and "Photos to attach" (correctly empty for a
customer with none). Nothing preselected.

Sent a real estimate with two documents. Audit trail:

    Emailed estimate #3 to kobystull123@gmail.com with 2 attachments
    (aeration-notice.pdf, mow-care-welcome.pdf)

Delivery state `sent`, no errors logged. Document templates could be written in
Settings since the first week and had no path to a customer until now.

## Two defects this pass found

**Long property details were unreadable on the job card.** The sprinkler timer
directions arrived squeezed into a 130px column with the label truncated to
"Spr...". Unreadable on a phone in a yard, which is the only place it gets read.
Long or multi-line values now take the full width. Judged on the value rather
than the label, so an unanticipated detail still lands correctly.

**The Maps route started from the first customer.** Naming the first stop as the
origin skips the leg to it, and on a one-stop day produced directions from an
address to itself, which navigates nowhere. Origin is now omitted so Maps starts
from wherever the driver is.

Both were found by using the feature, not by reading the code.

## Not verified

- **Photo capture from an actual phone camera.** The upload path is proven with
  real bytes, but `capture="environment"`, the browser downscale step, and
  one-handed use in sunlight are unexercised — no phone here.
- **Attachment size refusal.** The 23MB budget and its error message are not
  exercised; nothing that large was to hand.
- **A route of 400 stops.** The largest run was 14 jobs. The nearest-neighbour
  walk is O(n²) and untested at his real autumn volume.
- **Contractor-role authorisation.** Everything was done as an admin, because
  only two people have ever signed in and both are admins. The contractor-only
  restrictions are code-verified, not observed.
