# #15 — Claude Agent SDK spike: findings and verdict

> Written 2026-08-01. AGENT-PLAN §2 assumed the answer was "embed the Claude
> Code harness via the Claude Agent SDK." Researching the current SDK surface
> changed that conclusion. **Verdict: no-go on the Agent SDK; adopt the Tool
> Runner instead** — it delivers the harness benefits we actually wanted
> without breaking the boundary that makes XVibe safe to operate.

## The landscape (four ways to build an agent)

The distinction that matters is **who supplies the harness** (the loop +
context management) and **who supplies the deployment**:

| Approach | Harness | Built-in tools | Deployment |
|---|---|---|---|
| **Manual loop** (what we run today) | ours, ~200 lines | none | ours |
| **Tool Runner** (`client.beta.messages.tool_runner`) | SDK | none — only tools we define | ours |
| **Managed Agents** | Anthropic | Anthropic-hosted sandbox (bash, files, code exec) | Anthropic |
| **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, v0.3.220) | SDK (Claude Code's) | **Read/Write/Edit/Bash/Glob/Grep/WebSearch** + MCP + subagents | ours |

The Tool Runner and the Agent SDK are different packages and get conflated
constantly. The Tool Runner ships inside `@anthropic-ai/sdk` — **the dependency
we already have** (0.115.0).

## Why the Agent SDK is the wrong fit for XVibe

Not a capability judgement — it is genuinely the strongest harness available.
It is the wrong *shape* for this product:

1. **Its built-in tools are exactly what our boundary forbids.** It ships
   Bash, and Read/Write/Edit against the local filesystem. On Render that
   filesystem holds `.xvibe/apps/*/secret.json` — every app's delivery token —
   plus the studio's own env. Our entire custody model (CONNECTION.md §3c) is
   "the agent never sees a raw token." Handing the builder a shell on the
   custody host inverts that in one line of config.
2. **Deny-by-default permissions make it *survivable*, not *safe*.** We would
   be disabling most of what we imported, then trusting a permission config to
   hold. Boundaries enforced by configuration fail differently from boundaries
   enforced by absence — and we already learned this lesson the hard way when a
   Haiku build wrote `server.js` (see #9).
3. **It optimizes for a coding agent on a dev machine.** XVibe's builder does
   not edit a repo; it authors a *backend* over MCP and writes a handful of
   browser files through guarded `wsWrite`. Most of the Agent SDK's value —
   codebase understanding, grep/glob over a tree, bash workflows — is value we
   cannot use.

## What we actually wanted, and where to get it

Everything on our "why Claude Code errs less" list is available in the Tool
Runner, on the SDK we already ship:

| Want (AGENT-PLAN §2) | Tool Runner gives us |
|---|---|
| Stop hand-rolling the loop | drives request → execute → loop over **our** tools |
| Approval gates for destructive verbs | per-turn hooks: inspect a pending `tool_use` and allow/deny **before** it executes |
| Error interception | inspect/modify a tool result before it returns to the model |
| Result modification | e.g. attach `cache_control` to a result |
| Retries / per-turn param changes | supported; `max_iterations` bounds the loop |
| Context management | **server-side compaction** (beta `compact-2026-01-12`) and **context editing** (`clear_tool_uses_20250919`) — both better than our hand-rolled `trimConversation` |
| Streaming | supported (`stream: true`) — required for our SSE chat |
| Subagents | not provided — but we already have the shape we need (reviewer, #9) |

**Critically, it adds no new attack surface**: no built-in tools means the
agent's reachable capability set stays exactly the 50 Pluggie tools + our
workspace tools, enforced by absence rather than by policy.

## Follow-up 2026-08-01: step 2 (move the loop onto `tool_runner`) — NOT DONE, deliberately

Step 1 shipped. Before rewriting the loop, I read the installed runner's actual
type surface (`lib/tools/BetaToolRunner.d.ts`, `helpers/beta/json-schema.d.ts`)
rather than the prose. Two things it revealed, plus one that step 1 already
settled:

1. **`betaTool()` wants const-literal JSON Schemas.** Its signature is
   `<const Schema extends JSONSchema>` so it can infer argument types via
   `FromSchema`. Our tool schemas are read from the LIVE MCP surface at session
   start — runtime `Record<string, unknown>` values. The inference that makes
   the helper pleasant is unusable for us; every tool would be a cast.
2. **The runner owns tool execution, and our SSE UX owns event timing.** The
   studio streams `tool_start` *before* a call runs and `tool_done` carrying
   our own `summary` / `filesChanged`. Those come from inside `dispatchTool`,
   which the runner would invoke from its own callbacks — so a generator
   yielding events would need a queue to marshal them out, and `tool_done`
   would land a beat late. We would be trading precise, working UX for loop
   code we already have.
3. **The prize was already claimed without it.** Context management —
   the biggest item on the "why Claude Code errs less" list — turned out to be
   plain request parameters (step 1). It never needed the runner.

What remains is per-call approval gating, and that is an `if` statement in
`dispatchTool`, which we own outright. **Verdict: keep our loop.** The spike's
value was real, but it was steps 1 and the boundary correction, not the port.

### Shipped instead (same session)

- **Concurrent tool execution within a round.** Claude issues independent calls
  together on purpose — writing `index.html` + `app.css` + `app.js` in one
  round is the common case, and each write also costs a schema lookup for the
  API-lint. Results still return in ONE user message in original order, which
  is what keeps the model making parallel calls at all.
- **The schema cache now stores in-flight promises, not resolved values**, so
  concurrent writes referencing the same collection share a single
  `describe_collection` instead of racing to duplicate it. Transient failures
  are evicted rather than cached, so one hiccup cannot poison a whole turn.

Measured: the guestbook eval passed 11/11 in 60s / 10 rounds versus 67s / 11
rounds before. **Not a claimed speedup** — the round count differs, so that is
one noisy sample, not a benchmark. The change is correct regardless and cannot
be slower.

## Recommendation

1. **Drop the Agent SDK migration** from the roadmap. Record the reason so it
   is not re-litigated: built-in Bash/filesystem tools are incompatible with
   token custody on the studio host.
2. **Adopt the Tool Runner incrementally**, in this order — each step is
   independently valuable and independently revertible:
   - **Context management first** (highest value, lowest risk): replace
     `trimConversation` with server-side compaction + tool-result clearing.
     Long builds currently lose their own history on a crude boundary trim.
   - **Then the loop itself**: move `runBuilder`'s round loop onto
     `tool_runner`, keeping our `dispatchTool` as the execution function so
     every guard (mint interception, write verification, probe) is untouched.
   - **Then approval hooks**: promote the destructive-verb exclusions from a
     static allowlist to a per-call gate, which lets us *offer* dangerous
     tools with confirmation instead of withholding them.
3. **Keep watching Managed Agents** for the #17 functions runtime — Anthropic
   hosting the sandbox is a different trade than us renting Cloudflare
   isolates, and it may be the cheaper answer for per-app server code.

## Bugs this research found in what we shipped (fixed 2026-08-01)

The spike paid for itself before any migration:

1. **`stop_reason: "refusal"` was unhandled.** Our loop treated any non-
   `tool_use` stop as a clean finish, so a declined request rendered as a
   normal, empty, successful turn. Now surfaced honestly with its category.
2. **`stop_reason: "max_tokens"` was unhandled.** A round cut off mid-thought
   ended the build silently — with the app possibly half-written and the
   reviewer then auditing unfinished work. Now reported as incomplete, with a
   "continue" path, and the reviewer is skipped for that turn.
3. **`max_tokens: 16000` was too tight.** On Sonnet 5, adaptive thinking is on
   whenever `thinking` is omitted (which it is), and `max_tokens` caps
   thinking **and** response text together. Raised to 32k; we stream, so
   headroom is free unless used.

## Levers noted, deliberately not pulled

- **`output_config.effort`** — Sonnet 5 supports `low`→`max`; `xhigh` is the
  documented sweet spot for coding/agentic work and is what Claude Code
  itself defaults to. It would likely improve build quality, and it costs
  more. Operator's call, not a silent default. **Note: `effort` errors on
  Haiku 4.5** — if we adopt it, it must be tier-gated, never sent on the fast
  tier or the router.
- **Mid-conversation system messages** (`{role:"system"}` inside `messages`) —
  the correct channel for our reviewer's repair round (it preserves the cached
  prefix and carries operator authority, unlike the user-turn message we send
  today). **Not available on Sonnet 5**, which is our build tier, so it stays
  parked until the tier changes.
