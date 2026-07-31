# Board — updated 2026-07-30

## In progress
*(nothing — awaiting the P0 go, see below)*

## Next up (queued, in order — Cloudflare route decided 07-31)
1. **#13 P0 agent strength** — Sonnet-5 build tier, static verification
   (JS parse + API-lint), `probe_app` smoke tool. **⚑ needs your "go P0"
   (build cost rises ~3× to $0.60–1.50/build).**
2. **#9 Reviewer pass** — fresh-context post-build audit vs. the contract
   (rides P0).
3. **#14 Eval harness v1** — 10–15 golden tasks, run on contract changes
   (~$3–5/sweep).
4. **#15 Claude Agent SDK spike** — embed the Claude Code harness; go/no-go
   on error rate + cost.
5. **CF-1: move xvibe.app zone to Cloudflare** (⚑ operator-assisted:
   nameserver flip at Namecheap; CF auto-imports records) — prerequisite for
   edge serving + Workers routing.
6. **#10 Edge serving worker** — apps served from R2 at the edge + token-
   injecting /api/v1 proxy in the worker; Render leaves the app-serving path.
7. **#17 Workers-for-Platforms functions** — per-app server code on rented
   isolates, behind `xvibe/runtime` shim + `RuntimeTarget` (exit insurance in
   AGENT-PLAN §4). Gated on #12 kill-switch + cost caps.
8. **#16 Plan mode** — PRD builder + per-task checkpoints + schema dry-runs.

## Waiting on operator ⚑
- **"go P0"** — approves the Sonnet build tier spend (top of queue).
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
