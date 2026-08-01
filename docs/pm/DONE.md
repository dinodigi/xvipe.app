# Shipped & verified

## 2026-07-31 (night) — edge serving prep, no model spend
- **`npm run evals:reset`** wraps the shipped `reset_project` (our 07-30 wall
  ask came back as OPS-6). Plan-only by default, `--wipe` to execute; never
  part of a sweep — it wipes hand-built apps too. GAP-MAP now tracks wall
  asks that shipped.
- **Edge worker written + tested** (`workers/edge/`): serves published bundles
  from R2 via `current.json`, SPA fallback, immutable assets + revalidated
  HTML + 304s, and proxies `/api/v1` with the delivery token injected at the
  edge (cookies stripped, end-user JWT passed through). Apex/`www`/reserved
  labels pass through to the studio. **15/15 behaviour tests**
  (`node workers/edge/test.mjs`) with stubbed R2/KV — no zone needed.
- **Edge token custody** (`lib/deploy/kv.ts`): tokens mirrored to a Workers KV
  namespace on mint and re-mirrored on every publish (older apps heal on next
  deploy). R2 holds public bytes, KV holds the credential — deliberately
  separate. No-ops until `CF_*` env vars exist, so today's serving is
  unchanged.
- **`docs/CLOUDFLARE.md`**: the CF-1 nameserver move (with a pre-save record
  checklist — a missed record here is downtime), the `*.xvibe.app` wildcard,
  and the worker deploy + rollout check.

## 2026-07-31 (evening) — #14 eval harness
- **Eval harness v1 shipped** (`evals/`, `npm run evals`): 12 golden build
  tasks (4 core) with **mechanical** assertions — shipped files, live schema,
  real delivery responses, tools actually called. Runs the REAL pipeline
  (router → builder → verify → probe → reviewer), then cleans up the apps and
  the collections it created. `--all/--tasks=/--pin=/--keep`; report to
  `evals/last-run.json`.
- **Four production bugs the sweep found in the same-day P0/#9 work** — the
  harness paid for itself on first use:
  1. **API-lint blind spot**: apps that hoist the base
     (`const API="/api/v1"; fetch(\`${API}/bookings\`)`) referenced NO literal
     path, so lint saw nothing and the reviewer got an empty schema section →
     shared `extractCollectionRefs` (certain vs. inferred candidates), used by
     lint, reviewer and evals.
  2. **Reviewer false positive on compose semantics**: flagged
     `publicWrite:true` + `access.write` as a contradiction. Verified against
     the live support-inbox collection (both set simultaneously) — contract
     rule 4a added.
  3. **Reviewer fabricated schema facts**: raw `describe_collection` JSON was
     clipped at 2.5k, truncating the field array, so it "found" a missing
     publicRead on a field that had one → compact, complete per-field
     summaries instead (never truncated).
  4. **Reviewer scope creep**: project-wide `list_schedules` made it demand
     schemas for *other apps'* collections → scoped to this app's collections
     + explicit shared-project note.
- **Reviewer precision pass**: read-vs-write distinction (form inputs are not
  projection reads), input-format checks are not business rules, marketing
  copy is not a platform promise, plus a mechanical hedge filter (findings
  must assert a defect, not ask a question). Regression-checked: still catches
  all 6 planted violations on the dirty fixture, still passes a clean app.
- **Platform semantics learned + documented**: delivery 404s for two reasons —
  "no collection X" (bug) vs "exists but has no publicly readable fields"
  (correct for write-only collections). In the contract, the reviewer prompt
  and the eval assertions.
- **Status**: guestbook / lead-form / booking-no-double / nightly-cleanup each
  verified PASS. The final baseline sweep aborted at task 3 — **the Anthropic
  account ran out of credit** (⚑ operator: top up to re-run). Sweep now aborts
  on billing errors instead of reporting bogus regressions. Spend for the
  day's eval work ≈ $11.

## 2026-07-31 (later)
- **#9 Reviewer pass + drift hardening shipped + live-verified**:
  - `lib/agent/reviewer.ts`: fresh-context Haiku audit of the app's FINAL
    state (files + live schema dossier, forced-verdict tool, read-only) after
    any app-touching turn; findings buy exactly ONE repair round in the
    builder loop. Reviewer failures never sink a finished build (~$0.02).
  - Write-time server-code drift patterns in verify.ts (require/module.exports/
    process.env/.listen/node imports) — the HealthFlow `server.js` class now
    dies at write time AND at review time.
  - Live tests 3/3: dirty fixture → 5 findings (credential literal, client-
    only rule, missing collection, SMS honesty, server code); clean guestbook
    → pass; drift patterns fire. E2E chat turn: edit→Haiku route, api-lint ok,
    review chip "pass — no findings".
  - **The reviewer's first real catch**: the guestbook workspace still carried
    HealthFlow-era leftovers (BACKEND_SIMPLE.js — the original drift artifact
    — plus dead js/auth.js with demo creds + localhost:3000 AUTH_API). Builder
    tunnel vision missed them; fresh eyes didn't. Workspace cleaned; contract
    now orders list_app_files + delete-stale-files on rebuilds.

## 2026-07-31
- **P0 agent strength (#13) shipped + live-verified**:
  - **Model tiers + router** (`lib/agent/models.ts`): auto-classification per
    request — verified live: a question routed `question → claude-haiku-4-5`;
    a build prompt routed `build → claude-sonnet-5`. Bias-to-build on any
    ambiguity/failure. `BUILDER_MODEL` retired; `XVIBE_FORCE_MODEL` is the
    cost-emergency override.
  - **Studio model selector** (composer, persisted per app): Auto / Fast ·
    Haiku / Strong · Sonnet / Max · Opus; route + why shown as a chat chip.
  - **Static verification** (`lib/agent/verify.ts`, esbuild): syntax errors
    BLOCK the write (JS/CSS/JSON/inline scripts, line numbers); API-lint
    checks every `/api/v1/<collection>` reference against the LIVE schema and
    returns the collection's public-field list as ground truth. 5/5 live
    tests passed.
  - **probe_app tool**: server-side delivery GETs with the app's real token;
    reports status + fields-after-projection + empty-projection warnings.
  - **First Sonnet build end-to-end** (guestbook, ~$1.50): collection +
    seeds + 3 files (api-lint ok) + agent-called probes; rendered in the
    browser through the token-injecting proxy.
  - **Custody healing** (bug found BY probe_app on its first real build):
    mint interception had reused a locally stored token revoked in the 07-30
    wipe. Stored tokens are now health-checked on reuse and dead ones
    replaced by a fresh mint — verified live (probe 401 → 200). Retraction
    of the agent's mis-attributed wall report filed (Pluggie was correct).
- **Decisions recorded**: P0 approval + Claude-only selector; agents-as-
  passes + intent-replay merges; task trees v2 (per-task copies + previews,
  serialized merge queue); planning layer (backlog → sprints); dev/prod envs
  as the data split; secret ownership map (authority vs custody).

## 2026-07-30
- **Wall items 8–12 filed** (total now 12; #12 = doc-drift on publicWrite/access.write compose semantics): Neon-backed project branching
  (plan-mode enabler), one-call project reset (eval-harness ergonomics),
  define_collection dryRun (schema diff previews), machine-readable
  not-supported registry in the briefing (honesty at scale).
- **PM system** (this folder) + AGENT-PLAN.md (agent-strength roadmap P0–P3).
- **UI v3 live** (`b628e3e`→`2a8aef2`): IDE workbench — Tools menu/tabs,
  Preview with browser chrome + device widths, Code viewer, **Deploys with
  real rollback**, **Data browser (live MCP)**, **Logs (delivery log +
  re-fire)**, ⌘K palette, multi-app switcher. Verified locally against real
  sandbox data.
- **Auth test run graded**: define_schedule worked in production; SMS honesty
  probe passed; zero drift artifacts. Found + fixed the publicRead projection
  trap (contract 3a/3b); repaired the live app via exact-merge redefine.
- **Wall items filed** (total 7): stamp-on-transition gap; publicRead naming
  trap; connector category (third-party APIs); + agent-envelope study.
- **Agent envelope widened 27→50 tools** + GAP-MAP.md (the bridge index).
- **End-user auth recipe** in the contract (Clerk via issuer, derived pk,
  X-User-Token; credential collections banned).
- **Sandbox wiped clean** for testing (collections, tokens, R2, local state).

## 2026-07-29 (operator-side)
- xvibe.app apex live on Render (gated); `*.apps.xvibe.app` wildcard DNS via
  Namecheap verified; R2 bucket + keys provisioned via Claude-in-Chrome.

## 2026-07-25/26
- **R2 deploy target verified live** (9 objects, current.json readback) +
  publish-origin fix + env-trim fix + unlock-page relabel.
- **Render deployment ready**: render.yaml blueprint, STUDIO_ACCESS_KEY gate,
  XVIBE_STATE_DIR, hosted preview URLs.
- **Repo born**: pushed to github.com/dinodigi/xvipe.app (main).
- **Usage accounting** end-to-end (per-build tokens in transcript, SSE,
  statusbar) after the Fable credit burn; Haiku + prompt caching (verified
  $0.10 small build, 98% cached).
- **Phase 1 loop verified end-to-end**: six-call spine proof, studio v1,
  builder agent (self-repair observed), edge token custody, publish pipeline,
  first real app built + browser-tested (Ridgeline), Clerk JWKS alive.
- **First 3 wall items** incl. 2 filed by the builder agent itself.
