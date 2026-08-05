/**
 * POST /api/apps/<slug>/chat — one user message in, an SSE stream of
 * AgentEvents out. The studio chat renders these as text + build steps.
 */
import { NextRequest } from "next/server";
import { runBuilder } from "@/lib/agent/builder";
import { isEffort, isModelPin } from "@/lib/agent/models";
import { getApp, updateApp } from "@/lib/apps/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One builder per app at a time. Held in memory on purpose: a restart (every
 * deploy is one) must not leave an app permanently "busy" with a build that
 * no longer exists. Each entry carries the controller so Stop can abort the
 * run server-side, not merely close the browser's stream.
 */
const running = new Map<string, AbortController>();

/** DELETE /api/apps/<slug>/chat — Stop. Aborts the run server-side. */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const abort = running.get(slug);
  if (!abort) return Response.json({ ok: true, wasRunning: false });
  abort.abort();
  running.delete(slug);
  return Response.json({ ok: true, wasRunning: true });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const { message, model, effort, runPlan } = (await req.json().catch(() => ({}))) as {
    message?: string;
    model?: string;
    effort?: string;
    /** run the app's already-approved plan instead of handling a new message */
    runPlan?: boolean;
  };
  if (!runPlan && !message?.trim()) {
    return Response.json({ error: "message required" }, { status: 400 });
  }
  if (running.has(slug)) {
    return Response.json({ error: "The builder is already working on this app — stop it or wait for it to finish." }, { status: 409 });
  }
  // Persist the studio's model selector with the message it applies to —
  // the builder reads it back off the app record.
  const app = getApp(slug);
  if (app) {
    const patch: { modelPin?: string; effortPin?: string } = {};
    if (isModelPin(model) && (app.modelPin ?? "auto") !== model) patch.modelPin = model;
    if (isEffort(effort) && app.effortPin !== effort) patch.effortPin = effort;
    if (Object.keys(patch).length) updateApp(slug, patch);
  }
  const abort = new AbortController();
  running.set(slug, abort);
  // A closed browser tab should stop the work too, not leave it burning tokens.
  req.signal.addEventListener("abort", () => abort.abort());

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runBuilder(slug, message?.trim() ?? "", abort.signal, { runPlan: Boolean(runPlan) })) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`));
      } finally {
        running.delete(slug);
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          /* client already gone */
        }
      }
    },
    cancel() {
      abort.abort();
      running.delete(slug);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
