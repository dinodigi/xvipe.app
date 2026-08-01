/**
 * lib/agent/builder.ts — the builder-agent orchestration loop (P1.3).
 *
 * One user message in → a stream of AgentEvents out. Server-side only:
 * this file holds the mcp token and the Anthropic key, neither of which
 * ever reaches the studio client (it sees events, not credentials).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import { getPluggieToken } from "@/lib/pluggie/token";
import { getProjectInfo } from "@/lib/pluggie/mcp";
import { buildSystemPrompt } from "@/lib/agent/system";
import { dispatchTool, getAgentTools } from "@/lib/agent/tools";
import { MODELS, isModelPin, routeRequest, type RouteDecision } from "@/lib/agent/models";
import { createBuildContext } from "@/lib/agent/verify";
import { reviewBuild } from "@/lib/agent/reviewer";
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
const MAX_TURNS_KEPT = 80;

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

/** Trim old turns on safe boundaries (never split a tool_use/tool_result pair). */
function trimConversation(messages: MessageParam[]): MessageParam[] {
  if (messages.length <= MAX_TURNS_KEPT) return messages;
  const hasToolResult = (m: MessageParam) =>
    Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === "tool_result");
  for (let i = Math.max(1, messages.length - MAX_TURNS_KEPT); i < messages.length; i++) {
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
  const [info, tools, decision] = await Promise.all([getProjectInfo(mcpToken), getAgentTools(mcpToken), decide()]);
  const system = buildSystemPrompt(app, info);
  const model = decision.model;
  yield { type: "route", route: decision.route, model, why: decision.why };
  appendTranscript(slug, { kind: "system", text: `route: ${decision.route} → ${model} (${decision.why})` });

  let messages = [...(loadConversation(slug) as MessageParam[]), { role: "user" as const, content: userMessage }];
  appendTranscript(slug, { kind: "user", text: userMessage });

  // Per-turn caches for the verification layer (collection facts).
  const buildCtx = createBuildContext();

  // Fresh-eyes review state (P0.4): runs once per turn, after the builder
  // stops, if the turn actually touched the app. Findings buy exactly ONE
  // repair round — never a loop.
  let touchedApp = false;
  let reviewSpent = false;
  const TOUCHING_TOOLS = new Set(["write_app_file", "delete_app_file", "define_collection", "define_schedule", "define_block"]);

  // Every build reports what it spent — nobody discovers a drained balance
  // from a 400 again. Totals accumulate across all rounds of this turn.
  const usage: TurnUsage = { model, rounds: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      messages = trimConversation(messages);
      const stream = anthropic.messages.stream({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Prompt caching: the marker on the system block caches tools+system
        // (they render first), so every loop round re-reads the big stable
        // prefix at ~0.1× instead of full price. The top-level marker
        // auto-caches the conversation tail between rounds.
        cache_control: { type: "ephemeral" },
        system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
        messages,
        tools: tools as Tool[],
      });

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
        yield { type: "turn_done", stopReason: "refusal", usage };
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
        yield { type: "turn_done", stopReason: "max_tokens", usage };
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
        appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(usage)}` });
        yield { type: "turn_done", stopReason: final.stop_reason ?? "end_turn", usage };
        return;
      }

      const results: ContentBlockParam[] = [];
      const changed: string[] = [];
      for (const use of toolUses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        const label = toolLabel(use.name, input);
        yield { type: "tool_start", name: use.name, label };
        const outcome = await dispatchTool(slug, mcpToken, use.name, input, buildCtx);
        if (!outcome.isError && TOUCHING_TOOLS.has(use.name)) touchedApp = true;
        appendTranscript(slug, { kind: "tool", tool: { name: use.name, summary: outcome.summary, ok: !outcome.isError } });
        if (outcome.filesChanged) changed.push(...outcome.filesChanged);
        yield { type: "tool_done", name: use.name, label, ok: !outcome.isError, summary: outcome.summary };
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result),
          is_error: outcome.isError,
        });
      }
      if (changed.length) yield { type: "files_changed", files: [...new Set(changed)] };
      messages.push({ role: "user", content: results });
      saveConversation(slug, messages); // persist between rounds — a dropped stream resumes cleanly
    }
    appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(usage)}` });
    yield { type: "error", message: `Stopped after ${MAX_ROUNDS} tool rounds — send a follow-up to continue.` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    appendTranscript(slug, { kind: "system", text: `builder error: ${message}` });
    if (usage.rounds > 0) appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(usage)}` });
    yield { type: "error", message };
  }
}
