# The 2026-09-15 walkthrough

Adam spent 67 minutes on a call walking through Service Autopilot, screen by
screen, saying what this CRM has to do. This folder is that call, turned into
something you can work from. It is the spec the 2026-09-16 build worked to, and
the thing to argue with when a feature here looks wrong.

| File | What it is |
|---|---|
| `requirements.md` | The spec. Sections A–P, each item tied to a timestamp in the call and to the feedback ids it answers. Section P is his own written checklist, the Google Doc he showed near the end. |
| `transcript.txt` | The call, timestamped. The recording came with no transcript, so it was transcribed locally (faster-whisper, small.en on CPU — CUDA fails on this machine on a missing cuBLAS DLL, do not retry it). |
| `screens.md` | Every Service Autopilot screen he shared, by timestamp, with its columns, fields, menus and sample data. Read from 402 frames cropped to the shared-screen region. Grep it for the screen you are rebuilding. |
| `survey/*.md` | What this app already did in each area before the build, with file:line evidence. Stale the moment it was written, but it is why each decision went the way it did. |
| `BUILD-BRIEF.md` | The brief the twelve parallel builders worked from: the hard rules, the shared schema, and the cross-track contracts. Useful as a template for the next pass of this shape. |

## What came of it

Built and deployed as `24ad022`, with fixes in `c3fe005`, `5837acd` and
`813b341`. His feedback went from 62 open to 4. `BACKLOG.md` says which four and
why; `FINDINGS.md` says what the build and the review of it taught.

## If you pick this up again

The recording is `Work Optional Demo (Bison Lawn Care LLC) - 2026_09_15 10_54
CDT - Recording.mp4`, in Koby's Downloads. `requirements.md` is faithful to it,
but the timestamps are there so you can go back and hear him say it — which is
worth doing before building anything he described in passing.
