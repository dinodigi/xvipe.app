/**
 * /api/apps/<slug>/plan — the review step between "what shall I build" and
 * building it.
 *
 * This is the cheapest place a human can change the outcome: editing a
 * ten-line task list costs seconds, editing a finished 30KB app.js costs a
 * day. So approval is explicit, and editing the plan is a first-class action
 * rather than something you do by arguing with the agent in chat.
 *
 * Execution itself is NOT here — approving only records consent. The studio
 * then POSTs { runPlan: true } to /chat, which streams the run.
 */
import { NextRequest } from "next/server";
import { getApp, loadPlanState, savePlanState } from "@/lib/apps/store";
import type { PlanTask } from "@/lib/agent/backlog";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!getApp(slug)) return Response.json({ error: `Unknown app: ${slug}` }, { status: 404 });
  return Response.json(loadPlanState(slug));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!getApp(slug)) return Response.json({ error: `Unknown app: ${slug}` }, { status: 404 });

  const { action, tasks } = (await req.json().catch(() => ({}))) as {
    action?: "approve" | "discard" | "update";
    tasks?: { id?: string; title?: string; doneWhen?: string }[];
  };
  const state = loadPlanState(slug);
  const plan = state.current;
  if (!plan) return Response.json({ error: "No plan to act on." }, { status: 400 });

  if (action === "discard") {
    savePlanState(slug, { ...state, current: null });
    return Response.json({ ok: true, discarded: true });
  }

  if (action === "update" || Array.isArray(tasks)) {
    if (!Array.isArray(tasks) || !tasks.length) {
      return Response.json({ error: "tasks must be a non-empty array" }, { status: 400 });
    }
    // Reordering, editing and dropping are all the same operation: the client
    // sends the list it wants. Tasks that already ran keep their status and
    // receipt, so editing the tail of a part-run plan cannot rewrite history.
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    plan.tasks = tasks.slice(0, 12).map((t, i) => {
      const prev = t.id ? byId.get(t.id) : undefined;
      const next: PlanTask = {
        id: prev?.id ?? `task_edit_${Date.now().toString(36)}${i}`,
        title: String(t.title ?? prev?.title ?? "").slice(0, 200),
        doneWhen: String(t.doneWhen ?? prev?.doneWhen ?? "").slice(0, 300),
        status: prev?.status ?? "pending",
        ...(prev?.receipt ? { receipt: prev.receipt } : {}),
      };
      return next;
    });
    if (plan.tasks.some((t) => !t.title)) {
      return Response.json({ error: "every task needs a title" }, { status: 400 });
    }
  }

  if (action === "approve") plan.approvedAt = new Date().toISOString();

  savePlanState(slug, { ...state, current: plan });
  return Response.json({ ok: true, plan });
}
