# Project management — how this folder works

One place to see the state of XVibe. Five files, each with one job:

| File | Holds | Rule |
|---|---|---|
| [BOARD.md](BOARD.md) | what's in progress, queued next, waiting on you, and later | mirrors the working task list (task #ids) |
| [DONE.md](DONE.md) | shipped-and-verified log, by date | only verified work lands here |
| [DECISIONS.md](DECISIONS.md) | choices we've made and why | a decision stays until explicitly reversed — link the reversal |
| [OPEN.md](OPEN.md) | discussed but not decided / blocked on operator input | each item names what unblocks it |
| [PARKED.md](PARKED.md) | good ideas deliberately not now | each names its "revisit when" trigger |

**The ritual:** every working session updates BOARD (status moves), DONE
(when verified), and DECISIONS/OPEN (when a discussion concludes or opens).
Plans live in their own docs ([AGENT-PLAN.md](../AGENT-PLAN.md),
[GAP-MAP.md](../GAP-MAP.md)); this folder tracks their execution, not their
content.
