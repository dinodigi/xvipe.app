/**
 * lib/agent/builder.ts — the builder-agent orchestration loop (P1.3).
 *
 * One user message in → a stream of AgentEvents out. Server-side only:
 * this file holds the mcp token and the Anthropic key, neither of which
 * ever reaches the studio client (it sees events, not credentials).
 *
 * Three modes share one inner loop (`agentTurn`):
 *   - NORMAL   — a question or an edit; answers directly, as it always did.
 *   - PLAN     — a build request. Read-only tools; the agent proposes an
 *                ordered task list and stops. Nothing is built until the user
 *                approves, because a ten-line plan is the cheapest thing they
 *                will ever review.
 *   - EXECUTE  — runs an approved plan one task at a time, each with its own
 *                short context, each ending in a probe and a receipt.
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
import { dispatchTool, getAgentTools, scopeTools, type AnthropicTool, type ToolScope } from "@/lib/agent/tools";
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
import { collectionOf, createBuildContext, extractCollectionRefs, type BuildContext } from "@/lib/agent/verify";
import {
  isPlanFinished,
  newPlan,
  planBrief,
  planProgress,
  type Plan,
  type PlanTask,
  type TaskReceipt,
} from "@/lib/agent/backlog";
import { reviewBuild } from "@/lib/agent/reviewer";
import { estimateCostUsd } from "@/lib/agent/pricing";
import type { AgentEvent, TurnUsage } from "@/lib/agent/events";
import {
  appendTranscript,
  getApp,
  loadConversation,
  loadPlanState,
  savePlanState,
  saveConversation,
  wsList,
  wsRead,
} from "@/lib/apps/store";

// P0.1 model policy: the router picks the tier per request (Haiku for
// questions/edits, Sonnet for builds); the studio selector pins per app.
// XVIBE_FORCE_MODEL is the operator's cost-emergency override of everything.
const FORCED_MODEL = process.env.XVIBE_FORCE_MODEL?.trim();

/** Round budgets per mode. A task is smaller than a build, so it needs fewer. */
const ROUNDS = { normal: 40, plan: 6, task: 24, verify: 8 };

/**
 * Output ceiling per round. On Sonnet 5 adaptive thinking is ON whenever the
 * `thinking` field is omitted, and max_tokens caps thinking AND response text
 * together — a build turn that thinks hard can hit the ceiling mid-answer. We
 * stream, so a large ceiling costs nothing unless it is used. (Haiku 4.5 caps
 * at 64k output; everything else is far higher.)
 */
const MAX_OUTPUT_TOKENS = 32000;

/**
 * How much conversation history a NORMAL turn carries. This matters more than
 * it looks: history is re-read every round like the tool block, and on the fast
 * tier the API cannot compact it (context management is unavailable on Haiku),
 * so an app with a long transcript made even a one-line question expensive —
 * measured 59,625 cache-write tokens on a question that needed almost none.
 *
 * Executing tasks sidesteps this entirely: a task carries the plan and the
 * receipts so far instead of the transcript, which is a few hundred tokens.
 */
const TURNS_KEPT: Record<string, number> = { question: 12, edit: 24, build: 80 };

/**
 * How many times the same tool may fail the same way before the turn is cut
 * off. The record is ~20 identical E_VALIDATION rejections in one turn: $7.40
 * spent, one file written, and the model talking itself into believing the
 * platform was broken. Each failure in context also teaches the next round
 * that malformed calls are normal here, so a spiral feeds itself.
 */
const FAIL_LIMIT = 3;

/**
 * What makes two failures "the same". Deliberately includes a normalized slice
 * of the message, not just the E_* code: a build legitimately hits several
 * different E_VALIDATIONs while self-repairing a schema, and stopping that
 * would break the loop's best feature.
 */
export const failSignature = (tool: string, result: unknown): string => {
  const raw =
    typeof result === "string"
      ? result
      : JSON.stringify((result as { error?: unknown })?.error ?? result ?? "");
  const norm = raw
    .replace(/["'`]/g, "")
    // uuids and entity ids first, or their surviving letters keep two otherwise
    // identical failures apart — a loop of E_NOT_FOUNDs on different rows is
    // still a loop, and it means the agent's view of what exists is stale.
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${tool}::${norm}`;
};

const toolLabel = (name: string, input: Record<string, unknown>): string => {
  switch (name) {
    case "define_collection": return `define_collection ${input.name ?? ""}`;
    case "describe_collection": return `describe_collection ${input.name ?? ""}`;
    case "create_entry":
    case "bulk_create_entries": return `${name} → ${input.collection ?? ""}`;
    case "write_app_file":
    case "edit_app_file":
    case "read_app_file":
    case "delete_app_file": return `${name} ${input.path ?? ""}`;
    case "enable_plugin": return `enable_plugin ${input.id ?? input.name ?? ""}`;
    case "probe_app": return `probe_app · ${Array.isArray(input.paths) ? input.paths.length : 0} endpoint(s)`;
    case "propose_plan": return `propose_plan · ${Array.isArray(input.tasks) ? input.tasks.length : 0} task(s)`;
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

/**
 * Which collections does the code a task just wrote actually call? This is the
 * required-probe set: the app is not verified until every endpoint it fetches
 * has been answered by the real delivery API with the real token.
 */
function endpointsFor(slug: string, files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (!/\.(html|js|mjs|ts|tsx|jsx)$/i.test(f)) continue;
    let text: string;
    try {
      text = wsRead(slug, f);
    } catch {
      continue; // deleted during the task — nothing to check
    }
    for (const c of extractCollectionRefs(text).certain) out.add(c);
  }
  return [...out];
}

/* ── the inner loop ───────────────────────────────────────────────────────── */

interface LoopCtx {
  slug: string;
  anthropic: Anthropic;
  model: string;
  system: string;
  mcpToken: string;
  buildCtx: BuildContext;
  signal?: AbortSignal;
  manageContext: boolean;
  effort?: Effort;
  usage: TurnUsage;
}

interface TurnOpts {
  tools: AnthropicTool[];
  maxRounds: number;
  /** trim history to N turns before each round (normal mode only) */
  trim?: number;
}

interface TurnResult {
  /** end_turn | stuck | round_cap | max_tokens | refusal | stopped */
  stopReason: string;
  text: string;
  filesTouched: string[];
  /** delivery paths passed to a successful probe_app during this turn */
  probedPaths: string[];
  proposedTasks?: { title: string; doneWhen: string }[];
  error?: string;
}

/**
 * One agent conversation to completion. Mutates `messages` so the caller keeps
 * the resulting history, and accumulates spend onto ctx.usage. It never yields
 * a user-facing verdict — the caller decides what a given stopReason means in
 * its own mode.
 */
async function* agentTurn(
  ctx: LoopCtx,
  messages: MessageParam[],
  opts: TurnOpts,
): AsyncGenerator<AgentEvent, TurnResult> {
  const { slug, anthropic, model, system, mcpToken, buildCtx, signal } = ctx;
  const filesTouched = new Set<string>();
  const probedPaths = new Set<string>();
  let proposedTasks: { title: string; doneWhen: string }[] | undefined;
  let failSig: string | null = null;
  let failCount = 0;
  let lastText = "";

  for (let round = 0; round < opts.maxRounds; round++) {
    // Stop is checked at the round boundary so the conversation is always
    // saved in a consistent state — never mid tool_use/tool_result pair.
    if (signal?.aborted) {
      return { stopReason: "stopped", text: lastText, filesTouched: [...filesTouched], probedPaths: [...probedPaths] };
    }

    if (opts.trim) {
      const trimmed = trimConversation(messages, opts.trim);
      if (trimmed !== messages) messages.splice(0, messages.length, ...trimmed);
    }

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
      tools: opts.tools as Tool[],
      ...(ctx.effort ? { output_config: { effort: ctx.effort } } : {}),
      ...(ctx.manageContext
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
    // both tiers; only the context-management fields differ. The signal also
    // cuts the in-flight model call, so Stop is immediate rather than
    // "finishes the current round first".
    const stream = anthropic.beta.messages.stream(
      request as Parameters<typeof anthropic.beta.messages.stream>[0],
      signal ? { signal } : undefined,
    );

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
    ctx.usage.rounds += 1;
    ctx.usage.inputTokens += final.usage.input_tokens;
    ctx.usage.outputTokens += final.usage.output_tokens;
    ctx.usage.cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;
    ctx.usage.cacheWriteTokens += final.usage.cache_creation_input_tokens ?? 0;
    if (turnText.trim()) {
      appendTranscript(slug, { kind: "agent_text", text: turnText });
      lastText = turnText;
    }
    messages.push({ role: "assistant", content: final.content });

    const toolUses = final.content.filter((b) => b.type === "tool_use");
    const base = { text: lastText, filesTouched: [...filesTouched], probedPaths: [...probedPaths], proposedTasks };

    // Not every non-tool_use stop means "finished". Two of them mean the
    // opposite, and both used to look exactly like a clean turn.
    if (final.stop_reason === "refusal") {
      const why = (final as { stop_details?: { category?: string } }).stop_details?.category;
      appendTranscript(slug, { kind: "system", text: `refusal: ${why ?? "unspecified"}` });
      return { ...base, stopReason: "refusal", error: why ?? "unspecified" };
    }
    if (final.stop_reason === "max_tokens") {
      appendTranscript(slug, { kind: "system", text: "stopped: max_tokens (truncated round)" });
      return { ...base, stopReason: "max_tokens" };
    }
    if (final.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { ...base, stopReason: "end_turn" };
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
      appendTranscript(slug, { kind: "tool", tool: { name: c.use.name, summary: outcome.summary, ok: !outcome.isError } });
      if (outcome.filesChanged) {
        changed.push(...outcome.filesChanged);
        for (const f of outcome.filesChanged) filesTouched.add(f);
      }
      if (!outcome.isError && c.use.name === "probe_app" && Array.isArray(c.input.paths)) {
        for (const p of c.input.paths) probedPaths.add(String(p));
      }
      if (!outcome.isError && c.use.name === "propose_plan") {
        proposedTasks = (outcome.result as { tasks?: { title: string; doneWhen: string }[] }).tasks;
      }
      yield { type: "tool_done", name: c.use.name, label: c.label, ok: !outcome.isError, summary: outcome.summary };

      let body = typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result);
      if (outcome.isError) {
        const sig = failSignature(c.use.name, outcome.result);
        if (sig === failSig) failCount += 1;
        else {
          failSig = sig;
          failCount = 1;
        }
        // From the second identical failure, stop handing the model another
        // verbatim copy of a call it already got wrong — that repetition is
        // what normalizes the bad shape and keeps the spiral going.
        if (failCount >= 2) {
          body = JSON.stringify({
            error: `Identical to the previous ${failCount - 1} failure(s) on ${c.use.name}; the full text is above and has not changed. Retrying this shape will not work — change the call, or stop and tell the user what you are blocked on.`,
          });
        }
      } else {
        failSig = null; // any success means progress
        failCount = 0;
      }
      results.push({ type: "tool_result", tool_use_id: c.use.id, content: body, is_error: outcome.isError });
    }
    if (changed.length) yield { type: "files_changed", files: [...new Set(changed)] };
    messages.push({ role: "user", content: results });

    if (failSig && failCount >= FAIL_LIMIT) {
      const [tool, why] = failSig.split("::");
      appendTranscript(slug, { kind: "system", text: `halted: ${failCount}× identical failure on ${tool}` });
      return {
        text: lastText,
        filesTouched: [...filesTouched],
        probedPaths: [...probedPaths],
        proposedTasks,
        stopReason: "stuck",
        error: `\`${tool}\` failed ${failCount} times with the same error: ${why?.slice(0, 240) ?? "unknown"}`,
      };
    }

    // A plan turn's job is done the moment the plan exists — anything further
    // would be the agent starting work the user has not seen yet.
    if (proposedTasks) {
      return { text: lastText, filesTouched: [...filesTouched], probedPaths: [...probedPaths], proposedTasks, stopReason: "end_turn" };
    }
  }
  return { stopReason: "round_cap", text: lastText, filesTouched: [...filesTouched], probedPaths: [...probedPaths], proposedTasks };
}

/* ── the entry point ──────────────────────────────────────────────────────── */

export async function* runBuilder(
  slug: string,
  userMessage: string,
  /** aborts when the user hits Stop, or the client disconnects */
  signal?: AbortSignal,
  opts: { runPlan?: boolean } = {},
): AsyncGenerator<AgentEvent> {
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
  const planState = loadPlanState(slug);

  // Route FIRST (cheap, parallel with orientation): which tier does this
  // message deserve? Pin > forced-env > auto-router. Executing an approved
  // plan is a build by definition, so it skips classification entirely.
  const pin = isModelPin(app.modelPin) ? app.modelPin : "auto";
  const decide = async (): Promise<RouteDecision> => {
    if (opts.runPlan) return { route: "build", model: MODELS.sonnet, why: "executing an approved plan" };
    if (FORCED_MODEL) return { route: "forced", model: FORCED_MODEL, why: "XVIBE_FORCE_MODEL is set" };
    if (pin !== "auto") return { route: "pinned", model: MODELS[pin], why: `pinned to ${pin} in the studio` };
    return routeRequest(anthropic, userMessage, wsList(slug).length);
  };

  // Orient every session (CONNECTION.md §2) + read the LIVE tool surface.
  const [info, allTools, decision] = await Promise.all([getProjectInfo(mcpToken), getAgentTools(mcpToken), decide()]);
  const system = buildSystemPrompt(app, info);
  const model = decision.model;

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

  const ctx: LoopCtx = {
    slug,
    anthropic,
    model,
    system,
    mcpToken,
    buildCtx: createBuildContext(),
    signal,
    // Long builds used to lose their own history to a crude boundary trim.
    // Where the model supports it, the API compacts (summarizes) and clears
    // stale tool results instead — the agent keeps a summary of what it did.
    manageContext: supportsContextManagement(model),
    // Effort governs how many rounds the model takes, and rounds drive cost.
    // Gated hard: Haiku 4.5 returns a 400 for this parameter, so a turn the
    // router sent to the fast tier must not carry it even if the app pins one.
    effort: supportsEffort(model) && isEffort(app.effortPin) ? app.effortPin : undefined,
    usage,
  };

  /** Stop, refusal and truncation mean the same thing in every mode. */
  const explain = (res: TurnResult): string | undefined => {
    switch (res.stopReason) {
      case "stopped":
        return "Stopped. Everything up to this point is saved — send a message to carry on.";
      case "refusal":
        return `The model declined this request (${res.error ?? "unspecified"}). Nothing was changed. Rephrase, or ask for a different approach.`;
      case "max_tokens":
        return `The builder hit its output limit mid-round, so this is INCOMPLETE. ${res.filesTouched.length ? `Files written so far: ${res.filesTouched.slice(0, 12).join(", ")}. ` : ""}Send "continue" to pick up from here.`;
      case "stuck":
        return `Stopped — ${res.error}. The builder was going in circles rather than making progress. Everything up to this point is saved; tell me what to try differently.`;
      case "round_cap":
        return `Stopped after ${ROUNDS.normal} tool rounds — this is INCOMPLETE, not finished. ${res.filesTouched.length ? `Files written so far: ${res.filesTouched.slice(0, 12).join(", ")}. ` : "No files were written. "}Send "continue" to carry on.`;
      default:
        return undefined;
    }
  };

  try {
    /* ── EXECUTE: run an approved plan, one task at a time ── */
    if (opts.runPlan) {
      const plan = planState.current;
      if (!plan?.approvedAt) {
        yield { type: "error", message: "There is no approved plan to run." };
        yield { type: "turn_done", stopReason: "error", usage: seal() };
        return;
      }
      yield { type: "route", route: "build", model, why: `executing ${plan.tasks.length}-task plan` };
      yield* executePlan(ctx, plan, allTools, seal, app.name, info);
      return;
    }

    yield { type: "route", route: decision.route, model, why: decision.why };
    appendTranscript(slug, { kind: "system", text: `route: ${decision.route} → ${model} (${decision.why})` });
    appendTranscript(slug, { kind: "user", text: userMessage });

    /* ── PLAN: a build request produces a plan, not a build ── */
    const wantsPlan = decision.route === "build" || decision.route === "forced" || decision.route === "pinned";
    if (wantsPlan) {
      // Deliberately a FRESH context: a plan should be grounded in what the
      // app actually is right now (list_app_files, list_collections), not in
      // what a long chat log says it was. That is also what stops an
      // ambiguous message resurrecting a task from fifteen turns ago.
      const planMessages: MessageParam[] = [
        {
          role: "user",
          content: `${userMessage}\n\n[XVibe — this is a PLANNING turn. Orient with the read-only tools if you need to (what collections and files already exist), then call propose_plan exactly once and stop. Nothing you propose is built yet: the user reviews the plan first. Keep prose to one short sentence — they read the task list, not a description of it.]`,
        },
      ];
      const res = yield* agentTurn(ctx, planMessages, { tools: scopeTools(allTools, "plan"), maxRounds: ROUNDS.plan });

      if (res.proposedTasks?.length) {
        const plan = newPlan(userMessage, res.proposedTasks);
        savePlanState(slug, { ...planState, current: plan });
        appendTranscript(slug, { kind: "system", text: `plan proposed: ${plan.tasks.length} task(s)` });
        yield { type: "plan", plan };
        yield { type: "turn_done", stopReason: "plan", usage: seal() };
        return;
      }
      const why = explain(res);
      if (why) yield { type: "error", message: why };
      else {
        yield {
          type: "error",
          message: "The builder finished the planning turn without proposing a plan. Send the request again, or rephrase it as a concrete build.",
        };
      }
      yield { type: "turn_done", stopReason: res.stopReason, usage: seal() };
      return;
    }

    /* ── NORMAL: questions and edits answer directly ── */
    const scope = decision.route as ToolScope;
    const messages = [...(loadConversation(slug) as MessageParam[]), { role: "user" as const, content: userMessage }];
    const res = yield* agentTurn(ctx, messages, {
      tools: scopeTools(allTools, scope),
      maxRounds: ROUNDS.normal,
      trim: TURNS_KEPT[scope] ?? TURNS_KEPT.edit,
    });
    saveConversation(slug, messages);
    const why = explain(res);
    if (why) yield { type: "error", message: why };
    appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(seal())}` });
    yield { type: "turn_done", stopReason: res.stopReason, usage: seal() };
  } catch (e) {
    // An aborted model call surfaces as an exception; that is a Stop, not a
    // failure, and the work so far is still worth keeping.
    if (signal?.aborted) {
      appendTranscript(slug, { kind: "system", text: "stopped by the user" });
      yield { type: "error", message: "Stopped. Everything up to this point is saved — send a message to carry on." };
      yield { type: "turn_done", stopReason: "stopped", usage: seal() };
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    appendTranscript(slug, { kind: "system", text: `builder error: ${message}` });
    if (usage.rounds > 0) appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(seal())}` });
    yield { type: "error", message };
  }
}

/* ── plan execution ───────────────────────────────────────────────────────── */

/**
 * Run every pending task in order. A task gets its own short context (the plan
 * plus the receipts before it, not the transcript), its own probe gate, and its
 * own receipt. A failure halts the queue right there and leaves the rest
 * pending — a stopped plan you can read beats a build that just goes quiet.
 */
async function* executePlan(
  ctx: LoopCtx,
  plan: Plan,
  allTools: AnthropicTool[],
  seal: () => TurnUsage,
  appName: string,
  info: unknown,
): AsyncGenerator<AgentEvent> {
  const { slug } = ctx;
  const tools = scopeTools(allTools, "build");
  const persist = () => {
    const state = loadPlanState(slug);
    savePlanState(slug, { ...state, current: plan });
  };
  let touchedApp = false;

  for (const [i, task] of plan.tasks.entries()) {
    if (task.status !== "pending") continue;
    if (ctx.signal?.aborted) break;

    task.status = "running";
    persist();
    yield { type: "task_start", id: task.id, title: task.title, index: i + 1, total: plan.tasks.length };
    appendTranscript(slug, { kind: "system", text: `task ${i + 1}/${plan.tasks.length}: ${task.title}` });

    const snap = { ...ctx.usage };
    const startedAt = Date.now();
    const messages: MessageParam[] = [
      {
        role: "user",
        content: `${planBrief(plan, task.id)}\n\n[XVibe — work ONLY on task ${i + 1}: "${task.title}".\nDone when: ${task.doneWhen}\nDo not start any later task; each gets its own turn with its own budget. When this one is finished, stop and state in ONE short line what changed.]`,
      },
    ];

    let res = yield* agentTurn(ctx, messages, { tools, maxRounds: ROUNDS.task });

    /* probe gate — a task is not done until the endpoints its code calls
       have answered. One nudge, then the receipt records the truth either
       way; looping here would just be a more expensive way to be wrong. */
    const probedNames = new Set(res.probedPaths.map(collectionOf));
    let unprobed = endpointsFor(slug, res.filesTouched).filter((c) => !probedNames.has(c));
    if (unprobed.length && res.stopReason === "end_turn" && !ctx.signal?.aborted) {
      messages.push({
        role: "user",
        content: `[XVibe — this task is not verified yet. The code you just wrote calls ${unprobed
          .map((c) => `/api/v1/${c}`)
          .join(", ")}, and ${unprobed.length === 1 ? "it has" : "they have"} never been probed. Call probe_app on ${
          unprobed.length === 1 ? "it" : "them"
        } now, fix anything it reveals (an almost-empty 200 is the publicRead projection trap), then stop.]`,
      });
      const verify = yield* agentTurn(ctx, messages, { tools, maxRounds: ROUNDS.verify });
      res = {
        ...verify,
        text: verify.text || res.text,
        filesTouched: [...new Set([...res.filesTouched, ...verify.filesTouched])],
        probedPaths: [...new Set([...res.probedPaths, ...verify.probedPaths])],
      };
      const after = new Set(res.probedPaths.map(collectionOf));
      unprobed = endpointsFor(slug, res.filesTouched).filter((c) => !after.has(c));
    }

    const delta: TurnUsage = {
      model: ctx.usage.model,
      rounds: ctx.usage.rounds - snap.rounds,
      inputTokens: ctx.usage.inputTokens - snap.inputTokens,
      outputTokens: ctx.usage.outputTokens - snap.outputTokens,
      cacheReadTokens: ctx.usage.cacheReadTokens - snap.cacheReadTokens,
      cacheWriteTokens: ctx.usage.cacheWriteTokens - snap.cacheWriteTokens,
    };
    const ok = res.stopReason === "end_turn";
    const receipt: TaskReceipt = {
      changed: res.filesTouched,
      probed: res.probedPaths,
      unprobed,
      verified: unprobed.length === 0,
      note: (res.text.trim().split("\n").filter(Boolean).pop() ?? (ok ? "done" : "did not finish")).slice(0, 300),
      costUsd: estimateCostUsd(delta),
      rounds: delta.rounds,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      ...(ok ? {} : { error: res.error ?? res.stopReason }),
    };
    task.status = ok ? "done" : "failed";
    task.receipt = receipt;
    if (res.filesTouched.length) touchedApp = true;
    persist();
    yield { type: "task_done", id: task.id, title: task.title, ok, receipt };

    if (!ok) {
      const stopped = res.stopReason === "stopped";
      const { done, pending } = planProgress(plan);
      yield {
        type: "error",
        message: stopped
          ? `Stopped during task ${i + 1}. ${done} task(s) finished, ${pending} still pending — approve the plan again to resume from here.`
          : `Task ${i + 1} ("${task.title}") failed, so the rest of the plan is on hold. ${res.error ?? res.stopReason}. ${done} task(s) finished before it; ${pending} are still pending. Tell me how to proceed and I will resume from this task.`,
      };
      appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(seal())}` });
      yield { type: "turn_done", stopReason: stopped ? "stopped" : "task_failed", usage: seal() };
      return;
    }
  }

  // Fresh-eyes review once per PLAN, not once per task — the reviewer audits a
  // finished app, and running it between tasks would audit a half-built one.
  if (touchedApp && isPlanFinished(plan) && !ctx.signal?.aborted) {
    yield { type: "tool_start", name: "review", label: "fresh-eyes review" };
    try {
      const rev = await reviewBuild(ctx.anthropic, slug, appName, ctx.mcpToken, info as never);
      ctx.usage.rounds += 1;
      ctx.usage.inputTokens += rev.usage.inputTokens;
      ctx.usage.outputTokens += rev.usage.outputTokens;
      ctx.usage.cacheReadTokens += rev.usage.cacheReadTokens;
      ctx.usage.cacheWriteTokens += rev.usage.cacheWriteTokens;
      const issues = rev.verdict === "issues";
      yield {
        type: "tool_done",
        name: "review",
        label: "fresh-eyes review",
        ok: !issues,
        summary: issues ? `${rev.findings.length} finding(s)` : "pass — no findings",
      };
      appendTranscript(slug, {
        kind: "tool",
        tool: { name: "review", summary: issues ? `${rev.findings.length} finding(s)` : "pass", ok: !issues },
      });
      if (issues) {
        // Reported, not auto-repaired: a plan that has already verified every
        // task with a real probe should not hand a fresh-context critic a
        // free round of edits over the top of it.
        yield {
          type: "error",
          message: `Reviewer flagged ${rev.findings.length}:\n${rev.findings.map((f, n) => `${n + 1}. ${f}`).join("\n")}\n\nEvery task above was probe-checked, so treat these as leads rather than facts — say the word and I will look into any of them.`,
        };
      }
    } catch (e) {
      yield {
        type: "tool_done",
        name: "review",
        label: "fresh-eyes review",
        ok: true,
        summary: `review skipped — ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  const { done, total } = planProgress(plan);
  const unverified = plan.tasks.filter((t) => t.receipt && !t.receipt.verified).length;
  appendTranscript(slug, { kind: "system", text: `plan finished: ${done}/${total}` });
  appendTranscript(slug, { kind: "system", text: `usage: ${JSON.stringify(seal())}` });
  if (unverified) {
    yield {
      type: "error",
      message: `${done}/${total} tasks done, but ${unverified} could not be verified — see the "not verified" lines on those receipts. Those endpoints were never answered by the live API, so treat them as untested.`,
    };
  }
  yield { type: "turn_done", stopReason: "plan_done", usage: seal() };
}
