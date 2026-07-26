/**
 * POST /api/apps/<slug>/chat — one user message in, an SSE stream of
 * AgentEvents out. The studio chat renders these as text + build steps.
 */
import { NextRequest } from "next/server";
import { runBuilder } from "@/lib/agent/builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// one builder per app at a time — a second message queues behind the button
const running = new Set<string>();

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const { message } = (await req.json().catch(() => ({}))) as { message?: string };
  if (!message?.trim()) {
    return Response.json({ error: "message required" }, { status: 400 });
  }
  if (running.has(slug)) {
    return Response.json({ error: "The builder is already working on this app — wait for it to finish." }, { status: 409 });
  }
  running.add(slug);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runBuilder(slug, message.trim())) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`));
      } finally {
        running.delete(slug);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
    cancel() {
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
