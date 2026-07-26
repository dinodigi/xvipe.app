/**
 * GET /api/apps/<slug>/files          → { files: [{path, bytes}] }
 * GET /api/apps/<slug>/files?path=x   → { path, content }
 * The studio's Code tab reads the app workspace through this.
 */
import { NextRequest } from "next/server";
import { getApp, wsList, wsRead } from "@/lib/apps/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!getApp(slug)) return Response.json({ error: "unknown app" }, { status: 404 });

  const path = req.nextUrl.searchParams.get("path");
  try {
    if (path) return Response.json({ path, content: wsRead(slug, path) });
    return Response.json({ files: wsList(slug) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
