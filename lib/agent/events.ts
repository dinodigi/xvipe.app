/**
 * lib/agent/events.ts — the event stream the builder emits while working.
 * Serialized as SSE from the chat route; rendered as steps in the studio chat.
 */

import type { Plan, TaskReceipt } from "@/lib/agent/backlog";

export type AgentEvent =
  | { type: "route"; route: string; model: string; why: string } // model-tier decision for this turn (P0.1)
  | { type: "thinking" } // the model is reasoning before it speaks/acts (Fable thinks by default)
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; label: string }
  | { type: "tool_done"; name: string; label: string; ok: boolean; summary: string }
  | { type: "files_changed"; files: string[] }
  // A plan is proposed and awaiting approval — nothing has been built yet.
  | { type: "plan"; plan: Plan }
  | { type: "task_start"; id: string; title: string; index: number; total: number }
  | { type: "task_done"; id: string; title: string; ok: boolean; receipt: TaskReceipt }
  | { type: "turn_done"; stopReason: string; usage?: TurnUsage }
  | { type: "error"; message: string };

/** Cumulative token spend for one builder turn (all rounds), from the API's usage fields. */
export interface TurnUsage {
  model: string;
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** estimated dollars for this turn (lib/agent/pricing.ts) */
  costUsd?: number;
  /** wall-clock seconds the turn took, so cost has context */
  seconds?: number;
}
