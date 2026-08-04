/**
 * lib/agent/builder.ts — the builder-agent orchestration loop (P1.3).
 *
 * One user message in → a stream of AgentEvents out. Server-side only:
 * this file holds the mcp token and the Anthropic key, neither of which
 * ever reaches the studio client (it sees events, not credentials).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

// The loop runs on the beta namespace (context management), whose content-block
// union is wider than the stable one — so the conversation is typed to match.
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
import { getPluggieToken } from "@/lib/pluggie/token";
import { getProjectInfo } from "@/lib/pluggie/mcp";
import { buildSystemPrompt } from "@/lib/agent/system";
import { dispatchTool, getAgentTools, scopeTools, type ToolScope } from "@/lib/agent/tools";
import {
  MODELS,
  isEffort,
  isModelPin,
  routeRequest,
  supportsContextManagement,
  supportsEffort,
  type Effort,
  type RouteDecision,
} from "@/lib/agent/models";
import { createBuildContext } from "@/lib/agent/verify";
import { reviewBuild } from "@/lib/agent/reviewer";
import { estimateCostUsd } from "@/lib/agent/pricing";
import type { AgentEvent, TurnUsage } from "@/lib/agent/events";
import { appendTranscript, getApp, loadConversation, saveConversation, wsList } from "@/lib/apps/store";

// P0.1 model policy: the router picks the tier per request (Haiku for
// questions/edits, Sonnet for builds); the studio selector pins per app.
// XVIBE_FORCE_MODEL is the operator's cost-emergency override of everything.
const FORCED_MODEL = process.env.XVIBE_FORCE_MODEL?.trim();
const MAX_ROUNDS = 40;

/**
 * Output ceiling per round. On Sonnet 5 adaptive thinking is ON whenever the
 * `thinking` field is omitted, and max_tokens caps thinking AND response text
 * together — a build turn that thinks hard can hit the ceiling mid-answer. We
 * stream, so a large ceiling costs nothing unless it is used. (Haiku 4.5 caps
 * at 64k output; everything else is far higher.)
 */
const MAX_OUTPUT_TOKENS = 32000;

/**
 * How much conversation history a turn carries. This matters more than it
 * looks: history is re-read every round like the tool block, and on the fast
 * tier the API cannot compact it (context management is unavailable on Haiku),
 * so an app with a long transcript made even a one-line question expensive —
 * measured 59,625 cache-write tokens on a question that needed almost none.
 *
 * A question needs the last exchange or two; an edit needs enough to resolve
 * "make it blue"; only a build needs the long tail.
 */
const TURNS_KEPT: Record<ToolScope, number> = { question: 12, edit: 24, build: 80 };

const toolLabel = (name: string, input: Record<string, unknown>): string => {
  switch (name) {
    case "define_collection": return `define_collection ${input.name ?? ""}`;
    case "describe_collection": return `describe_collection ${input.name ?? ""}`;
    case "create_entry":
    case "bulk_create_entries": return `${name} → ${input.collection ?? ""}`;
    case "write_app_file":
    case "read_app_file":
    case "delete_app_file": return `${name} ${input.path ?? ""}`;
    case "enable_plugin": return `enable_plugin ${input.id ?? input.name ?? ""}`;
    case "probe_app": return `probe_app · ${Array.isArray(input.paths) ? input.paths.length : 0} endpoint(s)`;
    default: return name;
  }
};

/**
 * Local fallback trim, used only where server-side context management is not
 * available (the Haiku fast tier). Crude by nature: it drops whole turns, so
 * the agent forgets what it already did. On tiers that support it we let the
 * API compact and clear instead, which preserves a summary of the history.
 */
function trimConversation(messages: MessageParam[], keep: number): MessageParam[] {
  if (messages.length <= keep) return messages;
  const hasToolResult = (m: MessageParam) =>
    Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === "tool_result");
  for (let i = Math.max(1, messages.length - keep); i < messages.length; i++) {
    if (messages[i].role === "user" && !hasToolResult(messages[i])) {
      return [messages[0], ...messages.slice(i)];
    }
  }
  return messages;
}

export async function* runBuilder(slug: string, userMessage: string): AsyncGenerator<AgentEvent> {
  const app = getApp(slug);
  if (!app) {
    yield { type: "error", message: `Unknown app: ${slug}` };
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    yield { type: "error", message: "ANTHROPIC_API_KEY is not set — the builder has no brain. Fill .env.local." };
    return;
  }

  let mcpToken: string;
  try {
    mcpToken = getPluggieToken(app.projectId);
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
    return;
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim() });

  // Route FIRST (cheap, parallel with orientation): which tier does this
  // message deserve? Pin > forced-env > auto-router.
  const pin = isModelPin(app.modelPin) ? app.modelPin : "auto";
  const decide = async (): Promise<RouteDecision> => {
    if (FORCED_MODEL) return { route: "forced", model: FORCED_MODEL, why: "XVIBE_FORCE_MODEL is set" };
    if (pin !== "auto") return { route: "pinned", model: MODELS[pin], why: `pinned to ${pin} in the studio` };
    return routeRequest(anthropic, userMessage, wsList(slug).length);
  };

  // Orient every session (CONNECTION.md §2) + read the LIVE tool surface.
  const [info, allTools, decision] = await Promise.all([getProjectInfo(mcpToken), getAgentTools(mcpToken), decide()]);
  const system = buildSystemPrompt(app, info);
  const model = decision.model;

  // Scope the tool block to the turn. A pinned or forced model bypasses the
  // router, so it has no classification to trust — give those everything.
  const scope: ToolScope =
    decision.route === "question" || decision.route === "edit" ? decision.route : "build";
  const tools = scopeTools(allTools, scope);

  yield { type: "route", route: decision.route, model, why: decision.why };
  appendTranscript(slug, { kind: "system", text: `route: ${decision.route} → ${model} (${decision.why})` });

  let messages = [...(loadConversation(slug) as MessageParam[]), { role: "user" as const, content: userMessage }];
  appendTranscript(slug, { kind: "user", text: userMessage });

  // Per-turn caches for the verification layer (collection facts).
  const buildCtx = createBuildContext();

  // Long builds used to lose their own history to a crude boundary trim.
  // Where the model supports it, the API compacts (summarizes) and clears
  // stale tool results instead — the agent keeps a summary of what it did.
  const manageContext = supportsContextManagement(model);

  // Effort governs how many rounds the model takes, and rounds drive cost.
  // Gated hard: Haiku 4.5 returns a 400 for this parameter, so a turn the
  // router sent to the fast tier must not carry it even if the app pins one.
  const effort: Effort | undefined =
    supportsEffort(model) && isEffort(app.effortPin) ? app.effortPin : undefined;

  // Fresh-eyes review state (P0.4): runs once per turn, after the builder
  // stops, if the turn actually touched the app. Findings buy exactly ONE
  // repair round — never a loop.
  let touchedApp = false;
  let reviewSpent = false;
  const TOUCHING_TOOLS = new Set(["write_app_file", "delete_app_file", "define_collection", "define_schedule", "define_block"]);

  // Every build reports what it spent — nobody discovers a drained balance
  // from a 400 again. Totals accumulate across all rounds of this turn.
  const usage: TurnUsage = { model, rounds: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const startedAt = Date.now();
  /** Stamp cost + duration right before the usage leaves this function. */
  const seal = (): TurnUsage => {
    usage.costUsd = estimateCostUsd(usage);
    usage.seconds = Math.round((Date.now() - startedAt) / 1000);
    return usage;
  };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Trim by scope always: compaction handles overflow on the capable
      // tiers, but it does not stop a cheap turn from carrying a long history
      // it never needed. The fast tier has no compaction at all.
      messages = trimConversation(messages, TURNS_KEPT[scope]);

      const request = {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Prompt caching: the marker on the system block caches tools+system
        // (they render first), so every loop round re-reads the big stable
        // prefix at ~0.1× instead of full price. The top-level marker
        // auto-caches the conversation tail between rounds.
        cache_control: { type: "ephemeral" as const },
        system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
        messages,
        tools: tools as Tool[],
        ...(effort ? { output_config: { effort } } : {}),
        ...(manageContext
          ? {
              betas: ["compact-2026-01-12", "context-management-2025-06-27"],
              context_management: {
                edits: [
                  // Tool results dominate our context — a single
                  // get_client_code or describe_collection dwarfs the prose.
                  // Clear the stale ones first, then compact what remains.
                  { type: "clear_tool_uses_20250919" },
                  { type: "compact_20260112" },
                ],
              },
            }
          : {}),
      };

      // The beta namespace serves plain requests too, so one call site covers
      // both tiers; only the context-management fields differ.
      const stream = anthropic.beta.messages.stream(request as Parameters<typeof anthropic.beta.messages.stream>[0]);

      let turnText = "";
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "thinking") {
          // surfaced so the studio can show a live "reasoning" state instead
          // of dead air — Fable's first token can be minutes into a hard task
          yield { type: "thinking" };
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          turnText += event.delta.text;
          yield { type: "text_delta", text: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      usage.rounds += 1;
      usage.inputTokens += final.usage.input_tokens;
      usage.outputTokens += final.usage.output_tokens;
      usage.cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += final.usage.cache_creation_input_tokens ?? 0;
      if (turnText.trim()) appendTranscript(slug, { kind: "agent_text", text: turnText });
      messages.push({ role: "assistant", content: final.content });

      const toolUses = final.content.filter((b) => b.type === "tool_use");

      // Not every non-tool_use stop means "finished". Two of them mean the
      // opposite, and both used to look exactly like a clean turn.
      if (final.stop_reason === "refusal") {
        const why = (final as { stop_details?: { category?: string } }).stop_details?.category;
        const message = `The model declined this request${why ? ` (${why})` : ""}. Nothing was changed. Rephrase, or ask for a different approach.`;
        appendTranscript(slug, { kind: "system", text: `refusal: ${why ?? "unspecified"}` });
        yield { type: "error", message };
        saveConversation(slug, messages);
        yield { type: "turn_done", stopReason: "refusal", usage: seal() };
        return;
      }
      if (final.stop_reason === "max_tokens") {
        // The round was cut off mid-thought — the app may be half-written, so
        // a reviewer pass here would audit work the builder never finished.
        appendTranscript(slug, { kind: "system", text: "stopped: max_tokens (truncated round)" });
        yield {
          type: "error",
          message: "The builder hit its output limit mid-round, so this turn is incomplete. Send \"continue\" and it will pick up from here.",
        };
        saveConversation(slug, messages);
        yield { type: "turn_done", stopReason: "max_tokens", usage: seal() };
        return;
      }

      if (final.stop_reason !== "tool_use" || toolUses.length === 0) {
        // The builder is done — fresh-eyes review before we call it a turn.
        if (touchedApp && !reviewSpent && decision.route !== "question") {
          reviewSpent = true;
          yield { type: "tool_start", name: "review", label: "fresh-eyes review" };
          try {
            const rev = await reviewBuild(anthropic, slug, app.name, mcpToken, info);
            usage.rounds += 1;
            usage.inputTokens += rev.usage.inputTokens;
            usage.outputTokens += rev.usage.outputTokens;
            usage.cacheReadTokens += rev.usage.cacheReadTokens;
            usage.cacheWriteTokens += rev.usage.cacheWriteTokens;
            if (rev.verdict === "issues") {
              yield { type: "tool_done", name: "review", label: "fresh-eyes review", ok: false, summary: `${rev.findings.length} finding(s) — one repair round` };
              appendTranscript(slug, { kind: "tool", tool: { name: "review", summary: `${rev.findings.length} finding(s) → repair`, ok: false } });
              appendTranscript(slug, { kind: "system", text: `review findings: ${JSON.stringify(rev.findings)}` });
              messages.push({
                role: "user",
                content: `[XVibe fresh-context reviewer — findings on the app's final state. You get ONE repair round.]\n${rev.findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}\nFix what is real. If a finding is mistaken, say why in one line instead of complying blindly. Keep changes minimal, then stop and summarize.`,
              });
              saveConversation(slug, messages);
              continue;
            }
            yield { type: "tool_done", name: "review", label: "fresh-eyes review", ok: true, summary: "pass — no findings" };
            appendTranscript(slug, { kind: "tool", tool: { name: "review", summary: "pass", ok: true } });
          } catch (e) {
            // Reviewer infrastructure must never sink a finished build.
            yield { type: "tool_done", name: "review", label: "fresh-eyes review", ok: true, summary: `review skipped — ${e instanceof Error ? e.message : String(e)}` };
          }
        }
        saveConversation(slug, messages);
        appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(seal())}` });
        yield { type: "turn_done", stopReason: final.stop_reason ?? "end_turn", usage: seal() };
        return;
      }

      // Claude issues independent tool calls in one round on purpose (writing
      // index.html + app.css + app.js together is the common case). Running
      // them concurrently turns that round from N round-trips into one —
      // each write also costs a schema lookup for the API-lint, so the saving
      // is real. Results still go back in ONE user message, in the original
      // order, which is what keeps the model issuing parallel calls at all.
      const calls = toolUses.map((use) => ({
        use,
        input: (use.input ?? {}) as Record<string, unknown>,
        label: toolLabel(use.name, (use.input ?? {}) as Record<string, unknown>),
      }));
      for (const c of calls) yield { type: "tool_start", name: c.use.name, label: c.label };

      const outcomes = await Promise.all(
        calls.map((c) => dispatchTool(slug, mcpToken, c.use.name, c.input, buildCtx)),
      );

      const results: ContentBlockParam[] = [];
      const changed: string[] = [];
      for (const [i, c] of calls.entries()) {
        const outcome = outcomes[i];
        if (!outcome.isError && TOUCHING_TOOLS.has(c.use.name)) touchedApp = true;
        appendTranscript(slug, { kind: "tool", tool: { name: c.use.name, summary: outcome.summary, ok: !outcome.isError } });
        if (outcome.filesChanged) changed.push(...outcome.filesChanged);
        yield { type: "tool_done", name: c.use.name, label: c.label, ok: !outcome.isError, summary: outcome.summary };
        results.push({
          type: "tool_result",
          tool_use_id: c.use.id,
          content: typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result),
          is_error: outcome.isError,
        });
      }
      if (changed.length) yield { type: "files_changed", files: [...new Set(changed)] };
      messages.push({ role: "user", content: results });
      saveConversation(slug, messages); // persist between rounds — a dropped stream resumes cleanly
    }
    appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(seal())}` });
    yield { type: "error", message: `Stopped after ${MAX_ROUNDS} tool rounds — send a follow-up to continue.` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    appendTranscript(slug, { kind: "system", text: `builder error: ${message}` });
    if (usage.rounds > 0) appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(seal())}` });
    yield { type: "error", message };
  }
}
