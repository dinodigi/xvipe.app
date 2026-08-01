# Agent-strength plan — closing the gap with Claude Code, then removing limits

> Written 2026-07-30 from operator direction: (1) the builder errs far more
> than Claude Code + Pluggie MCP does; (2) Replit-style task planning on a
> copy of the app + a strong PRD builder are wanted; (3) "no limits on what
> you can build" is now the goal — full hosting acceptable if required.

## 0. Root-cause: why Claude Code beats our builder today

| Factor | Claude Code desktop | XVibe builder today | Weight |
|---|---|---|---|
| Model | Opus/Fable-class (subscription) | Haiku 4.5 (cost guard) | ~half the gap |
| Harness | Years of engineering: verification loops, read-before-edit, planning, subagents, retries | 200-line loop, no verification | ~the other half |
| Feedback | Sees results: runs code, reads errors, iterates | Builds blind — never loads the app, no lint, no render check | large |
| Context | CLAUDE.md + memory + huge context | contract (good, growing) + transcript | small |

The platform is NOT the weak link — Pluggie's self-repairing errors fixed the
agent's own mistakes repeatedly in testing. The loop around the model is.

## 1. P0 — this week (biggest lift per line of code)

1. **Model policy: quality tiers.** Full builds default `claude-sonnet-5`;
   small edits stay Haiku; per-app override in the studio ("quality mode").
   With caching, a Sonnet build ≈ $0.60–1.50 — 3× Haiku, 10× less than Fable.
   Single biggest error reducer available today.
2. **Sight: static verification the agent must pass.** After every
   `write_app_file`: JS parse check (esbuild), HTML sanity, and an
   **API-lint** — every `fetch("/api/v1/<x>")` in the bundle must reference a
   collection that exists, with `publicRead` fields matching what the code
   reads. Failures return to the agent as tool errors (same self-repair loop
   the platform uses).
3. **Delivery smoke test tool.** A builder-callable `probe_app` tool: server-
   side GETs of the endpoints the app uses (with the app's real token) so
   projection/access misconfigurations (the empty-dashboard class) surface
   during the build, not after.
4. **Reviewer pass (task #9 vehicle).** Fresh-context cheap agent after each
   build: checklist = no server code, no credential collections, publicRead
   on gated fields, schedules created where promised, honest not-yet answers.
   One repair round on failure. (~$0.02/build.)
5. **Eval harness v1.** 10–15 golden prompts run on demand against the burn
   sandbox with mechanical assertions. Run on every contract change. This is
   our substitute for "training on our tools."

## 2. P1 — the structural fix ⚠️ SUPERSEDED 2026-08-01

> **The spike ran and reversed this section.** Verdict: no-go on the Claude
> Agent SDK (its built-in Bash/filesystem tools are incompatible with token
> custody on the studio host); adopt the SDK **Tool Runner** instead, which
> supplies the loop, hooks and context management with no built-in tools.
> See `docs/AGENT-SDK-SPIKE.md`. Original text kept below for the record.

Replace the hand-rolled loop with the **Claude Agent SDK** (Claude Code as a
library): its loop, context management, planning, subagents and hooks —
running server-side in XVibe, on our key, with:
- **Pluggie via MCP directly** (it already IS an MCP server) — schemas stay
  live; the contract becomes the agent's CLAUDE.md-equivalent.
- **Workspace + custody as custom tools/hooks** — keep the delivery-token
  interception and the write guards; deny-by-default permissions (no bash).
- Spike goal: one golden task end-to-end on Render; compare error rate and
  cost vs. the current loop before committing.

This is the honest answer to "Claude Code works better": stop imitating the
harness, embed it.

## 3. P2 — the planning layer: backlog → sprints → parallel task trees
   (operator direction 07-31: "don't copy Replit, do it better" — productize
   the PM model we already run in docs/pm)

1. **PRD builder → backlog → sprints.** The planning pass turns a prompt
   into `PRD.md` + backlog items (per app, shown as a studio Plan tool that
   mirrors this folder: backlog / sprint / done / decisions). Sprint
   planning is agent-assisted: the agent proposes sprint scope from the
   backlog, splits it into tasks, **predicts collisions from each task's
   planned file/schema footprint, and parallelizes only disjoint work** —
   conflict avoidance at planning time, not just resolution at merge time.
   Sprint close = agent-written review (shipped / checkpoints / cost).
2. **Task copies + per-task previews (operator design, decided 07-31).**
   Opening a task byte-copies main's workspace into `tasks/<id>/ws` (same
   snapshot machinery as Deploys). Each task serves its own live preview at
   `<app>--t<n>.<domain>` — rides the existing wildcard, zero DNS work
   (`--` reserved in app slugs as the separator). Task went wrong → discard
   the copy; main never moved.
3. **Merge queue — one task at a time, all merging to main.** Three-way at
   merge turn: task base vs. main head vs. task copy. Disjoint files
   auto-merge; overlaps get an **agent semantic-merge** (base + both diffs +
   both task *intents* — never raw conflict markers), then the P0 quality
   gate, then a diff + merged preview for approval → lands as a new
   checkpoint. Open tasks keep their base and rebase the same way when their
   turn comes; conflicts stay two-sided forever.
4. **Backend split = dev/prod environments (operator is building this with
   Pluggie directly).** Task copies duplicate FILES; data splits by
   environment: task previews run against **dev**, main/live against
   **prod**. In dev, all schema ops apply immediately — full-fidelity task
   previews, mutations included. A task's merge turn **promotes** its
   schema changes to prod as the approved dry-run diff. What XVibe needs
   from the env feature to exploit it fully: (a) env-scoped MCP targeting
   (defines/queries against dev vs prod), (b) env-scoped delivery tokens
   (task previews mint dev tokens; live mints prod), (c) a schema
   diff/promote path dev→prod (or we replay defines). Interim policy until
   envs land: additive ops apply live, mutating ops defer to merge-time
   dry-run diffs. Endgame stays **per-task Neon branches** (filed on the
   wall) — parallel tasks currently share dev; branches give each task its
   own database too.

## 4. P3 — no limits (the compute ladder, now committed)

Goal accepted: nothing buildable should be off the table. Sequence that gets
there without ever OWNING a runtime:
1. **Connectors** (filed on the wall) — secret-custody proxying: AI features,
   Twilio-class integrations in static apps. No tenant code execution.
2. **Functions on rented isolates — commit, don't defer.** Agent writes
   `functions/*` → XVibe deploys to **Cloudflare Workers for Platforms**
   (dispatch namespaces: per-tenant isolation, we meter, CF sandboxes).
   Static frontend + Pluggie data + per-app functions ≈ full-stack parity
   with Bolt/Lovable for the 95% case. XVibe owns this layer; Pluggie stays
   compute-free forever.
3. **Containers only if Workers prove insufficient** (long-running
   processes, arbitrary runtimes) — rented again (Cloudflare Containers /
   Fly-class), decided on evidence, not upfront.
4. **Non-negotiable gates before 2 ships publicly** (from the plan, now
   scheduled work, not vetoes): abuse kill-switch (task #12), hard per-app
   cost caps, takedown/report path, support runbook.

### Exit insurance — decided 07-31 (own-runtime stays a re-target, not a rewrite)

The Cloudflare route is NOW; these rules keep the 100%-own-runtime exit open
for the funded-scale future:
1. **Standard code shape.** Agent-written functions are WinterCG-style fetch
   handlers importing ONLY `xvibe/runtime` (our thin shim) — never raw CF
   APIs. The same modules then run on Node/Bun/Deno/Firecracker with a shim
   swap.
2. **`RuntimeTarget` interface** in the deploy layer (same pattern as
   DeployTarget): Workers-for-Platforms today; Fly/own-Firecracker later are
   new targets, not new architectures.
3. **Data gravity stays portable.** App state lives in Pluggie (Neon =
   Postgres) and R2 (S3 API). Durable Objects only for ephemeral realtime,
   never as a primary store — DO data is the one thing that would not move.
4. **We own the domains and the routing** (`*.xvibe.app`), so a runtime swap
   is a per-app routing flip users never see. Migration play at scale: run
   both runtimes, canary per app, move heavy/paying apps first — our own
   metering data picks them.
5. **What the funded exit actually is:** Firecracker/gVisor on rented metal,
   an orchestrator, and a 3–5 person infra/SRE + abuse team, ~6–12 months.
   The trigger is margin math (sustained paid compute > owned-cluster cost +
   team), never capability.

## 5. What we deliberately do NOT do

- No model fine-tuning now: frontier models aren't tunable by us, weights
  freeze faster than the platform changes, and our defect class is context,
  not capability. Keep logging trajectories (already automatic) — that corpus
  is the future distillation asset if scale ever justifies a custom model.
- No agent committees for building: one strong builder + one fresh-context
  reviewer beats a schema-agent/UI-agent bureaucracy at this scale.

## 6. Order of execution

P0.1 model tiers → P0.2/3 sight+probe → P0.4 reviewer → P0.5 evals →
P1 SDK spike (go/no-go) → P2 plan+checkpoints+PRD → wall: Neon branches →
P3.2 Workers functions (+ #12 gates) → reassess containers.
