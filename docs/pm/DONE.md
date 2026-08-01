# Shipped & verified

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
