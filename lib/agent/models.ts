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

/**
 * How hard the model works before answering: fewer, more consolidated tool
 * calls at the low end, deeper exploration at the high end. This is the main
 * lever on ROUND COUNT, and rounds are what drive cost — the whole prefix is
 * re-read every round.
 *
 * Verified 2026-08-04: Sonnet 5 accepts low→max; **Haiku 4.5 returns a hard
 * 400** ("This model does not support the effort parameter"). So this is
 * gated in code, not merely hidden in the UI — a fast-tier turn must never
 * carry it.
 */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The API's own default; selecting it explicitly changes nothing. */
export const DEFAULT_EFFORT: Effort = "high";

export const isEffort = (v: unknown): v is Effort =>
  typeof v === "string" && (EFFORTS as readonly string[]).includes(v);

export const supportsEffort = (model: string): boolean => !/haiku/i.test(model);

/**
 * Measured 2026-08-04 on the guestbook eval (Sonnet 5, identical task):
 *   medium → 22 rounds / $0.87   high → 7 rounds / $0.26   xhigh → 9 / $0.28
 *
 * Lower effort does NOT save money here, and the reason is structural: it
 * takes more, smaller steps, and every step re-reads the whole prefix. Cost
 * follows ROUND COUNT, not thinking depth. So the copy below sells depth,
 * never savings — turning this down to economise backfires.
 */
export const EFFORT_BLURB: Record<Effort, string> = {
  low: "Shallowest reasoning. Often takes more small steps — usually costs more here, not less.",
  medium: "Less reasoning per step. Measured slower AND dearer than the default on our evals.",
  high: "The default, and the cheapest setting we have measured. Leave it here unless a build is struggling.",
  xhigh: "Explores more before acting. Costs about the same as the default; worth it on harder builds.",
  max: "Thinks hardest. Reach for it when correctness matters more than spend.",
};

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
          content: `The app already has ${fileCount} files. The user's request:\n"""\n${message.slice(0, 2000)}\n"""\nPick exactly one route:\n- "question": asking or explaining only — no change to the app requested\n- "edit": a FRONTEND-ONLY change — copy, colours, layout, styling, one element or page. Nothing that touches stored data, fields, rules, schedules or emails.\n- "build": anything else — new features or pages, ANY change to the data model, access rules, workflows, notifications or background jobs, and anything spanning several files\nA turn routed "edit" is given only frontend tools, so if the request might need the backend at all, pick "build". When unsure pick "build". Reply: {"route":"..."}`,
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
