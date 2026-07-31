# Parked — deliberately not now

| Idea | Revisit when |
|---|---|
| **Distilled/fine-tuned Pluggie model** (cheap specialist trained on our trajectories — logging already accumulates the corpus) | thousands of successful builds + a real cost problem at scale |
| **Containers / full arbitrary runtimes** (beyond Workers functions) | Workers (#17) proves insufficient for real user demand |
| **Move xvibe.app zone to Cloudflare** | edge/CDN offload (#10) or R2 custom domains actually needed |
| **Managed Agents / platform-hosted skills for the builder** | if we ever want Anthropic-hosted sessions; SDK spike (#15) supersedes for now |
| **Analytics tool** | honest data source exists (changes-feed aggregation / edge metrics) |
| **Phase 2 standalone front door** (XVibe accounts, project provisioning) | Pluggie D3/OAuth + MT-1 land platform-side |
| **Pluggie as a claude.ai connector** (one-click MCP for everyone) | D3/OAuth ships |
| **Vertical starter kits** (clinic/agency/booking prompt+plugin packs) | after plan mode (#16); packaging mechanism = Pluggie plugins |
| **Semantic search, per-row ACL sharing** (platform) | user demand via wall reports |
| **Agent-suggested next steps as dynamic chips** (agent-generated, not static) | with SDK migration (#15) — structured output support makes it trivial |
