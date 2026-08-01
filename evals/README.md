# Eval harness

Golden build tasks with **mechanical** assertions. This is XVibe's substitute
for "training the model on our platform" — we cannot tune the weights, so we
measure the harness instead and fix what the numbers expose.

```bash
npm run evals                              # core suite (4 tasks)
npm run evals -- --all                     # every task
npm run evals -- --tasks=guestbook,sms-honesty
npm run evals -- --pin=sonnet              # force a tier instead of Auto routing
npm run evals -- --keep                    # leave apps + collections for inspection
```

## What a run does

For each task: create a throwaway app → run the **real** builder pipeline
(router → builder → write-time verification → probe → in-loop reviewer) →
grade the result → clean up.

Grading never asks a model whether the app is good. Every assertion reads
something factual:

- the shipped files (server code, credential literals, CDN scripts, nav links)
- the live schema (does the collection exist, is the rule declared server-side,
  are staff-visible fields `publicRead`)
- real delivery responses through the app's own token (status, row count, and
  the fields that survive projection)
- the tools the agent actually called (`define_schedule` vs. a browser timer)

The one model-graded check is the fresh-eyes reviewer's verdict, re-run against
the final state — an assertion about our own reviewer as much as the build.

## When to run it

Whenever something upstream of app quality changes: the agent contract
(`lib/agent/system.ts`), the tool surface/allowlist, the model policy or
router, the verification layer. A green sweep before a contract change and a
green sweep after is the whole point.

## Cost

Real builds on real models. Rough figures at Auto routing (Sonnet for build
prompts, ~$1–2 each):

| Suite | Tasks | Approx. cost |
|---|---|---|
| core | 4 | $4–8 |
| all | 12 | $12–25 |

The runner prints a per-task estimate and a sweep total; the cost model in
`run.mts` is approximate — verify against current pricing before quoting it.

## Sandbox hygiene

Tasks share the burn project, so each run snapshots `list_collections` before
and after and deletes what it created (dependents retried across passes).
Anything undeletable is reported as `collections left behind`.

Two consequences of a shared project, both deliberate:

- Assertions judge the collections the app **uses** (`appCollections` =
  created ∪ referenced-and-existing), not the before/after diff — otherwise a
  task whose collection name already existed grades as if it built nothing.
- Cleanup still deletes only what the run **created**, so a task that reuses
  a pre-existing collection never destroys it — but it may write rows into it.

### Factory reset (`npm run evals:reset`)

The one-call reset we filed on the Pluggie wall (2026-07-30) **shipped** as
`reset_project`, and `evals:reset` wraps it:

```bash
npm run evals:reset            # plan only — prints exactly what would be wiped
npm run evals:reset -- --wipe  # execute (deliberately two steps)
```

It is **not** part of a sweep and must not become one. A normal run already
cleans up after itself; this wipes the *entire project*, including anything
built there by hand (the guestbook demo, the support-inbox test app), and it
is unrecoverable — trash and version history go too. Delivery tokens,
connectors and the audit log survive. Reach for it when the project has drifted
into a mess, not on a schedule.

## Adding a task

Append to `TASKS` in `tasks.mts`. Keep assertions **tolerant about naming**
(the agent picks its own collection names — match with a pattern) and **strict
about behaviour** (what exists, what delivery actually returns). A failure
message should read like a bug report: what was expected, what was found.
