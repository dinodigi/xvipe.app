# XVibe

A vibe-coding studio on the Pluggie backend: describe an app in chat, a
builder agent models its backend on Pluggie over MCP and writes a static
frontend, and one click ships it to a live URL. XVibe operates a control
plane — never a runtime.

**Start with the brief: [docs/xvibe-brief/README.md](docs/xvibe-brief/README.md).**
Everything there is settled; [CONNECTION.md](docs/xvibe-brief/CONNECTION.md)
is the contract this codebase builds against.

## The rules that shape everything

1. **XVibe is a client of Pluggie, never a fork.** HTTP/MCP only — enforced
   mechanically by `npm run boundary`.
2. **XVibe never executes tenant code.** Built apps are static bundles; a
   deploy is a byte copy, never a build. App logic runs in the visitor's
   browser; the backend is Pluggie's delivery API.
3. **Business logic lives in Pluggie's declarative layer** (access rules,
   workflows, computed fields, constraints, events, schedules) — never in the
   generated frontend. Inexpressible rules are reported via `send_feedback`,
   not faked client-side.
4. **Tokens:** the mcp token stays server-side, read through one seam
   (`lib/pluggie/token.ts`). A built app's delivery token lives at XVibe's
   serving edge — the bundle ships with **no** credential and calls
   same-origin `/api/v1/*`; the edge injects the token.

## Getting started

```
cp env.example .env.local     # fill in PLUGGIE_MCP_TOKEN etc. (SETUP.md)
npm install
npm run spine                 # the six-call acceptance test — must be green
npm run dev                   # studio at http://localhost:3000
```

Open the studio, and the preview of an app `<slug>` is served at
`http://<slug>.localhost:3000/` — the same host-per-app contract production
uses at `*.xvibe.app`.

## Layout

| Path | What |
|---|---|
| `lib/pluggie/` | the only door to Pluggie: JSON-RPC transport + the token seam |
| `lib/agent/` | builder-agent orchestration: system contract, curated tools, streaming loop |
| `lib/apps/` | app store: workspace files (guarded), delivery-token custody, transcript |
| `lib/deploy/` | deploy control plane: local snapshot target today, R2 seam ready |
| `app/studio/[projectId]` | the IDE — chat, live preview, code view |
| `app/apps/[slug]/…` | serving edge: static files + `/api/v1` token-injecting proxy |
| `middleware.ts` | host rewrite: `<slug>.localhost` / `<slug>.xvibe.app` → that app |
| `scripts/` | `prove-spine` (SETUP §4), `check-boundary` (CONNECTION §6), `verify-connection` |

## Scripts

- `npm run spine` — six-call integration proof against the live project
- `npm run verify-connection` — the generated client's own `verifyConnection()`
- `npm run boundary` — fails on any Pluggie import / client-side credential
- `npm run verify` — typecheck + boundary + spine
