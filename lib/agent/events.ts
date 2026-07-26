/**
 * lib/agent/events.ts — the event stream the builder emits while working.
 * Serialized as SSE from the chat route; rendered as steps in the studio chat.
 */

export type AgentEvent =
  | { type: "thinking" } // the model is reasoning before it speaks/acts (Fable thinks by default)
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; label: string }
  | { type: "tool_done"; name: string; label: string; ok: boolean; summary: string }
  | { type: "files_changed"; files: string[] }
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
}
