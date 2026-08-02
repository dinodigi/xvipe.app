# Board — updated 2026-08-01

Infrastructure is done. Everything open below is product work.

## In progress
*(nothing — pick from Next up)*

## Next up (recommended order)

1. **#20 Frontend stack: TypeScript + JSX + vendored Preact** — raises the
   ceiling on what the agent can build (real components, hooks, props instead
   of hand-rolled DOM). Transpile on `write_app_file` with the esbuild we
   already ship; workspace stays browser-ready, preview needs no build,
   deploys stay byte copies. **Needs no new infrastructure** — the boundary is
   "no arbitrary third-party code execution", not "no transformation" (see
   PARKED). ~half a day + eval tasks for a component build.
2. **Theme editor** — operator-flagged as a priority product investment.
   Design-token themes the agent applies (palette / type / spacing presets),
   answering the brief's open "does XVibe ship themes?". Scope as its own
   design system when taken up.
3. **#16 Planning layer + task trees** — the strategic centrepiece. PRD
   builder → per-app backlog → agent-assisted sprints (agent proposes scope,
   splits into tasks, predicts footprint collisions, parallelizes disjoint
   work); parallel tasks as independent copies of main, each with its own
   live preview (`<app>--t<n>`); serialized merge queue with agent
   semantic-merge on overlaps; dev/prod envs — previews on dev, merges
   promote schema to prod as approved diffs. Design decided 07-31, see
   DECISIONS. Big; do it after the two above.
4. **#12 Abuse kill-switch + report path** — **required before public
   publishing and before #17 exposure.** Not urgent while the studio is
   passphrase-gated and the operator is the only publisher.
5. **#18 Custom domains** (Cloudflare for SaaS custom hostnames) — user CNAMEs
   their domain, CF issues/renews certs, the edge worker maps hostname → app;
   Domains tool in the studio. The flagship paid-tier anchor. De-risked now
   that proxied wildcards are confirmed working on the Free plan.
6. **#17 Workers-for-Platforms functions** — per-app server code on rented
   isolates behind the `xvibe/runtime` shim + `RuntimeTarget` (exit insurance,
   AGENT-PLAN §4). Includes the one XVibe-owned secrets store: per-app,
   per-env function env-vars. Gated on #12 + cost caps.
7. **#8 Build & deploy button in the Pluggie repo** — blocked on the repo path.
8. **Studio polish batch** — richer new-app modal, mobile layout, Analytics
   tool once it has an honest data source.

## Waiting on operator ⚑
- **Pluggie repo path** — unblocks #8.
- **Clerk staff-role setup** — token template + `publicMetadata.role`; until
  then demos use "any signed-in user".
- **Finish the support-inbox test** — pipeline move + reload; watch the
  resolved-email land in the Logs tool.
- **Token rotation** (mcp token + Anthropic key) — hygiene, overdue.
- **Tidy-ups, both optional**: delete the now-redundant explicit `xvibe` CNAME
  (the `*` wildcard covers it; the deploy token deliberately has no DNS-edit
  permission), and delete `BUILDER_MODEL` on Render (ignored since P0).

## Recently completed — see DONE.md for detail
- **08-01** #19 agent loop: server-side context management; concurrent tool
  execution; Tool Runner port declined with reasons recorded.
- **08-01** Short URLs live — apps at `<slug>.xvibe.app` via the edge worker,
  preview split onto `apps.xvibe.app`, ~80 subdomains reserved.
- **08-01** #10 edge worker deployed + verified end to end (serving from R2,
  token injection, POST, cookie stripping).
- **08-01** #15 harness spike — NO-GO on the Agent SDK, plus 3 bug fixes.
- **07-31** CF-1 zone move; #14 eval harness; #9 reviewer pass; #13 P0 agent
  strength (model tiers, router, selector, verification, probe).
