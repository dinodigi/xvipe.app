/**
 * GET  /api/apps/<slug>/logs                 → Pluggie delivery log (webhooks/emails)
 * POST /api/apps/<slug>/logs { deliveryId }  → re-fire one delivery
 */
import { NextRequest } from "next/server";
import { getApp } from "@/lib/apps/store";
import { getPluggieToken } from "@/lib/pluggie/token";
import { callTool } from "@/lib/pluggie/mcp";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const app = getApp(slug);
  if (!app) return Response.json({ error: "unknown app" }, { status: 404 });
  try {
    const token = getPluggieToken(app.projectId);
    const res = await callTool<{ deliveries?: unknown[] }>("get_deliveries", {}, token);
    return Response.json({ items: (res as { deliveries?: unknown[] }).deliveries ?? res });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const app = getApp(slug);
  if (!app) return Response.json({ error: "unknown app" }, { status: 404 });
  const { deliveryId } = (await req.json().catch(() => ({}))) as { deliveryId?: string };
  if (!deliveryId) return Response.json({ error: "deliveryId required" }, { status: 400 });
  try {
    const token = getPluggieToken(app.projectId);
    const res = await callTool("refire_delivery", { deliveryId }, token);
    return Response.json({ ok: true, result: res });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
