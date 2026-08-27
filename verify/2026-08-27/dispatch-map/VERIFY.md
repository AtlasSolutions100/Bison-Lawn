# Dispatch map: area selection and route ordering

Date: 2026-08-27 · deployed e7a3b1d

## What the screenshots changed

His three dispatch-board screenshots arrived after feedback #24 and #25 had been
marked done. They showed the marking was wrong.

"Select area for routing" is literal: he drags a shape on a map, and a Group
Selection panel totals what is inside it — B. Hrs, Services, Total Revenue —
before he assigns it to a crew and a date in one action. Clicking a single pin
opens that stop and lets him type its route order.

I had read "area" as a filter and built dropdowns for zone and city. The caps,
the geographic ordering and the preview were right; the selection gesture was
not. Marking it done before the screenshot arrived was premature, especially
since he had said one was coming.

## Verified live, against his real imported customers

Map renders 698 geocoded customers' jobs as pins over Coeur d'Alene, Post Falls
and Hayden. Pins are numbered by route order and greyed when unassigned.

**Area selection.** Dragged a box over the Post Falls cluster:
**15 stops selected, $1,719.00, 11.3 hrs budgeted** — the same three figures his
own panel shows. The one pin outside the box stayed grey and unselected. Totals
reconcile: all 16 came to $1,832.00 / 12.0h, so the excluded stop accounts for
$113 / 0.7h exactly.

**Route ordering follows the dispatcher, not the database.** Picked five jobs in
a deliberately scrambled order — 456, 451, 453, 452, 455, against their existing
1,2,3,4,5 — and they came back numbered 1 to 5 *in the picked order*. That is the
whole point of the feature: the order he taps stops is the order the crew drives
them.

**Absent fields are left alone.** The request carried only `routeOrderFrom`.
Every job kept its date and its assignment. Assigning a crew to forty stops must
never blank the dates somebody set that morning, and this is what proves it.

## A defect this pass caught

The first build used a freehand lasso needing three or more traced points. A
normal drag produces two, so the selection silently did nothing — the user
believes they selected an area and the app quietly disagrees. Looking again at
his screenshot, the shape has corner handles: it is a dragged rectangle. Changed
to that, which is both what he uses and the gesture that cannot fail this way. A
stray click now clears rather than selecting an empty box.

## Deliberate differences from his system

**OpenStreetMap tiles, not Google.** Google's JS map needs a billed API key per
client deployment. The interactions are what he works with; the tile layer is one
line to change if that trade-off stops making sense.

**The map is hidden by default.** Someone checking one job's status should not
wait for hundreds of pins.

**Jobs with no coordinates are counted on the map itself**, not logged. A stop
that cannot be lassoed would otherwise be invisible to a dispatcher working only
from the map.

## Not verified

- **Assigning to a crew through the map.** The demo subs were removed with the
  demo data and Adam has no crew in the system yet, so the Assign to dropdown had
  nobody in it. The date and route-order paths are proven; the assignment branch
  is code-verified only.
- **Several hundred pins at once.** Tested with 16. Leaflet handles far more, but
  his autumn board is not what this ran against.
- The 16 verification jobs were created against real customers and deleted
  afterwards. Two clearly-named test accounts now exist for this instead.
