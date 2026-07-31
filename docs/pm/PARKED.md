# Parked — deliberately not now

| Idea | Revisit when |
|---|---|
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
| **Theme editor** — design-token themes for generated apps (palette/type/spacing presets the agent applies; answers the brief's open question "does XVibe ship themes?" — scope as its own design system when taken up) | operator-flagged 07-31 as a priority product investment; take up after P0/#15 free the capacity |
| **Semantic search, per-row ACL sharing** (platform) | user demand via wall reports |
| **Agent-suggested next steps as dynamic chips** (agent-generated, not static) | with SDK migration (#15) — structured output support makes it trivial |
