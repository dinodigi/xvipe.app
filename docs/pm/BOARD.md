# Board — updated 2026-07-31

## In progress
- **#10 Edge serving worker** — **deployed + verified 08-01** (serving, token
  injection and POST all proven on a test hostname). Remaining: Render env
  vars for automatic token sync, then move real traffic (orange-cloud
  `*.apps`, or go straight to short URLs). See docs/CLOUDFLARE.md.

## Next up (queued, in order — Cloudflare route decided 07-31)
1. **#19 Tool Runner adoption** — replaces the reversed #15 (spike said no-go
   on the Agent SDK, see docs/AGENT-SDK-SPIKE.md). Order: server-side
   compaction + context editing → move the round loop onto `tool_runner`
   (keep `dispatchTool`) → per-call approval hooks for destructive verbs.
2. ~~**CF-1: move xvibe.app zone to Cloudflare**~~ — **DONE 2026-07-31**, see
   DONE.md. Unblocked #10 / #18 / #17.
3. **#10 Edge serving worker** — **code written + tested 07-31**
   (`workers/edge/`, 15/15 behaviour tests). Waiting only on CF-1, then one
   `wrangler deploy` + 3 env vars. Steps: `docs/CLOUDFLARE.md`.
4. **#18 Custom domains** (Cloudflare for SaaS custom hostnames) — user
   CNAMEs their domain, CF issues/renews certs, edge worker maps hostname →
   app; Domains tool in the studio. The flagship paid-tier anchor.
5. **#17 Workers-for-Platforms functions** — per-app server code on rented
   isolates, behind `xvibe/runtime` shim + `RuntimeTarget` (exit insurance in
   AGENT-PLAN §4). Includes the one XVibe-owned secrets store: per-app
   per-env function env-vars (write-only, encrypted, bound at deploy via the
   shim). Gated on #12 kill-switch + cost caps.
6. **#16 Planning layer + task trees** — PRD builder → per-app backlog →
   agent-assisted sprints (agent proposes scope, splits into tasks,
   predicts footprint collisions, parallelizes disjoint work); parallel
   tasks as independent copies of main, each with its own live preview
   (`<app>--t<n>` subdomains); serialized merge queue with agent
   semantic-merge on overlaps; **dev/prod envs (operator building with
   Pluggie): previews on dev, merges promote schema to prod as approved
   diffs** (design decided 07-31, see DECISIONS).

## Waiting on operator ⚑
- **Anthropic credit top-up** — the key ran dry during the 07-31 eval sweep.
  Blocks every builder run (studio + evals); nothing else is affected.
- **Render env hygiene** — `BUILDER_MODEL` there is now ignored (safe to
  delete); `XVIBE_FORCE_MODEL` exists as a cost-emergency override.
- **`*.xvibe.app` wildcard** — 3 CNAMEs at Namecheap + Render custom domain,
  then flip `XVIBE_APPS_BASE_DOMAIN` to `xvibe.app` (until then apps live at
  `*.apps.xvibe.app`).
- **Pluggie repo path** — unlocks #8 (the "Build & deploy" button).
- **Clerk staff-role setup** — token template + `publicMetadata.role`; until
  then demos use "any signed-in user".
- **Finish the support-inbox test** — pipeline move + reload; watch the
  resolved-email land in the Logs tool.
- **Token rotation** (mcp token + Anthropic key) — recommended hygiene.

## Later
- **#8** Build & deploy button in the Pluggie repo (needs path).
- **#10** Edge/CDN offload — CF worker serves apps from R2 (needs zone move).
- **#12** Abuse kill-switch + report path — **required before public
  publishing / #17 exposure**.
- Studio polish batch: publish-serves-snapshot, richer new-app modal, mobile
  layout, Analytics tool when it has an honest data source.
