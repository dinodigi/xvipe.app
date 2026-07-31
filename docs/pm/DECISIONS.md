# Decision log

Standing until explicitly reversed. Newest first.

| Date | Decision | Why |
|---|---|---|
| 07-30 | **"No limits" is the goal; compute arrives as RENTED layers owned by XVibe** — connectors → Workers-for-Platforms functions → containers only if proven needed. Pluggie stays compute-free forever. | Reaches full capability without buying the incumbents' cost/abuse cliff (see SWOTs). Operator explicitly accepted full hosting if required. |
| 07-30 | **No model fine-tuning; strength comes from harness + context.** Keep logging build trajectories as a future distillation corpus. | Frontier models aren't tunable by us; weights freeze while the platform changes weekly; observed defects were all context gaps. |
| 07-30 | **Adopt the Claude Agent SDK path (spike first)** instead of growing the hand-rolled loop. | Operator's own comparison: Claude Code + Pluggie MCP errs less. Embed that harness rather than imitate it. |
| 07-30 | **Connectors are Pluggie's job; XVibe only surfaces them.** Filed on the wall as a platform feature (registry category + delivery invoke). | Pluggie already owns credential custody + connector registry; every tenant benefits, boundary stays clean. |
| 07-30 | **UI v3 = Replit-frame IDE workbench** (chat left, tool-tabbed stage right, Tools registry). v2 app-as-canvas rejected. | Operator direction after testing both prototypes. |
| 07-30 | **Analytics tool ships only with an honest data source.** Menu-listed as "soon". | No fake numbers in the product. |
| 07-30 | **Apps live at first-level subdomains `<app>.xvibe.app`** (name-slug, not project UUID); www/studio/api/admin/mail reserved. | Matches the original plan; short memorable URLs. Operator suggested; UUIDs rejected for readability. |
| 07-29 | **Studio deploys on Render** via render.yaml blueprint; persistent disk for state; **STUDIO_ACCESS_KEY gate mandatory** on any hosted studio. | Operator chose Render; an ungated studio spends the operator's API key. |
| 07-25 | **Builder model: cheapest-first, upgrade deliberately** (Haiku default after the Fable credit burn). Being superseded by P0 quality tiers — Sonnet for full builds — pending operator "go". | Fable drained the account in two builds; cost visibility (usage accounting) added the same day. |
| 07-25 | **Delivery tokens live at the serving edge, never in bundles or model context** (mint interception + `/api/v1` injecting proxy). | Static apps have no server; the edge is their server env. Contract §3c compliance. |
| 07-25 | **Deploys are byte copies — no build step, no tenant code execution on our infra.** Agent writes browser-ready files. | XVIBE-PLAN boundary; running vite on tenant code = executing tenant code. |
| 07-25 | **XVibe is a client of Pluggie, never a fork** — HTTP/MCP only, enforced by `npm run boundary`; mcp token behind one seam (`getPluggieToken`). | CONNECTION.md contract; mechanical enforcement over review discipline. |
| (brief) | **Business logic lives in Pluggie's declarative layer; inexpressible rules are declared honestly + filed on the wall, never faked client-side.** | CONNECTION.md §8 — the founding rule; also the drift-hardening yardstick. |
