# Parked — deliberately not now

| Idea | Revisit when |
|---|---|
| **Richer frontend stack: TypeScript + JSX + vendored Preact** (agent writes `.ts`/`.tsx`; transpile on `write_app_file` with the esbuild we already ship; store the `.js` beside it so the workspace stays browser-ready, preview needs no build, and deploys stay byte copies). **Boundary correction recorded 08-01: the rule is "no arbitrary third-party code execution", NOT "no transformation".** `esbuild.transform()` is text-in/text-out with no config, no plugins and no npm — the same risk class as the parse check we already run. Verified working on TS and JSX with our installed esbuild. Do not re-litigate this as a compute-ladder item; it needs no new infrastructure. | after the current queue; it is a decision + ~half a day, not infrastructure |
| **Tailwind for generated apps** — the awkward middle case: a faithful build evaluates a JS config and runs an engine (closer to a toolchain than a transform); the browser build is vendorable but does runtime JIT (~hundreds of KB + FOUC). Open question worth an eval-harness A/B rather than a guess: models are extremely well-trained on Tailwind, so utility classes may produce better-looking output than hand-rolled CSS even though the agent writes both markup and styles. | with the TS/JSX work, and only if the eval A/B shows a visual-quality win |
| **Privacy/PII pass** — policy, retention, deletion story for data in built apps (sibling of #12 abuse path) | before public publishing / Phase 2 door |
| **Export to GitHub** (one-way mirror of app snapshots to a user-connected repo — ownership/portability trust feature; NOT our versioning engine, which stays snapshot-based). **Owned by XVibe** (authoring/control-plane concern; studio-user OAuth); Pluggie contributes the backend half via existing `export_project` manifest bundled into the repo | Phase 2 accounts, or when Workers functions (#17) make apps code-heavy; two-way sync much later |
| **Distilled/fine-tuned Pluggie model** (cheap specialist trained on our trajectories — logging already accumulates the corpus) | thousands of successful builds + a real cost problem at scale |
| **Multi-provider models (non-Claude)** behind the same selector/router | operator-flagged "eventually"; needs a provider abstraction + per-model contract evals |
| **Containers / full arbitrary runtimes** (beyond Workers functions) | Workers (#17) proves insufficient for real user demand |
| **Move xvibe.app zone to Cloudflare** | edge/CDN offload (#10) or R2 custom domains actually needed |
| **Managed Agents / platform-hosted skills for the builder** | if we ever want Anthropic-hosted sessions; SDK spike (#15) supersedes for now |
| **Analytics tool** | honest data source exists (changes-feed aggregation / edge metrics) |
| **Phase 2 standalone front door** (XVibe accounts, project provisioning) | Pluggie D3/OAuth + MT-1 land platform-side |
| **Pluggie as a claude.ai connector** (one-click MCP for everyone) | D3/OAuth ships |
| **Vertical starter kits** (clinic/agency/booking prompt+plugin packs) | after plan mode (#16); packaging mechanism = Pluggie plugins |
| ~~**Theme editor**~~ — **SHIPPED 2026-08-01**, see DONE. Six token themes + studio picker + `set_app_theme`. Follow-ups if wanted: per-app token overrides (nudge one colour without leaving the theme), a dark variant per theme, and vendored woff2 faces if system stacks ever feel limiting | — |
| **Semantic search, per-row ACL sharing** (platform) | user demand via wall reports |
| **Agent-suggested next steps as dynamic chips** (agent-generated, not static) | with SDK migration (#15) — structured output support makes it trivial |
