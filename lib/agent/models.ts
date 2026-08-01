/**
 * lib/agent/models.ts — model tiers + the request router (P0.1).
 *
 * "Agents" in XVibe are specialized passes of one system; the router is the
 * first pass. Auto mode classifies each message and spends the strong model
 * only where it pays: questions and small edits ride Haiku, feature work gets
 * Sonnet. The studio selector can pin a tier per app; XVIBE_FORCE_MODEL is
 * the operator's cost-emergency override (BUILDER_MODEL is retired).
 */
import type Anthropic from "@anthropic-ai/sdk";

export const MODELS = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
} as const;

/** What the studio selector stores per app. */
export type ModelPin = "auto" | keyof typeof MODELS;
export const MODEL_PINS = ["auto", "haiku", "sonnet", "opus"] as const;
export const isModelPin = (v: unknown): v is ModelPin =>
  typeof v === "string" && (MODEL_PINS as readonly string[]).includes(v);

/**
 * Server-side context management (compaction + tool-result clearing) is
 * available on the Sonnet/Opus/Fable families but NOT on Haiku 4.5. Turns
 * routed to the fast tier keep the local trim as their floor.
 */
export const supportsContextManagement = (model: string): boolean => !/haiku/i.test(model);

export type Route = "question" | "edit" | "build";

const ROUTE_MODEL: Record<Route, string> = {
  question: MODELS.haiku,
  edit: MODELS.haiku,
  build: MODELS.sonnet,
};

export interface RouteDecision {
  /** the classified route, or how auto-routing was bypassed */
  route: Route | "pinned" | "forced";
  model: string;
  why: string;
}

/**
 * Classify one user message. Deliberately cheap (Haiku, ~30 output tokens)
 * and deliberately biased: anything ambiguous is a "build" — misrouting a
 * small edit to Sonnet costs cents; misrouting a build to Haiku costs a
 * broken app. Any router failure also falls back to the build tier.
 */
export async function routeRequest(
  anthropic: Anthropic,
  message: string,
  fileCount: number,
): Promise<RouteDecision> {
  if (fileCount === 0) {
    return { route: "build", model: ROUTE_MODEL.build, why: "fresh app — full build tier" };
  }
  try {
    const res = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 30,
      system: 'You route requests inside an app-builder IDE. Answer with ONLY a JSON object, no prose.',
      messages: [
        {
          role: "user",
          content: `The app already has ${fileCount} files. The user's request:\n"""\n${message.slice(0, 2000)}\n"""\nPick exactly one route:\n- "question": asking or explaining only — no change requested\n- "edit": a small tweak (copy, colors, one element or page)\n- "build": features, new pages, data-model or flow changes, anything multi-file\nWhen unsure pick "build". Reply: {"route":"..."}`,
        },
      ],
    });
    const text = res.content.find((b) => b.type === "text")?.text ?? "";
    const m = text.match(/"route"\s*:\s*"(question|edit|build)"/);
    const route: Route = (m?.[1] as Route) ?? "build";
    const why =
      route === "question" ? "question — answering, not changing"
      : route === "edit" ? "small edit — fast tier"
      : "feature work — full build tier";
    return { route, model: ROUTE_MODEL[route], why };
  } catch {
    return { route: "build", model: ROUTE_MODEL.build, why: "router unavailable — defaulted to build tier" };
  }
}
