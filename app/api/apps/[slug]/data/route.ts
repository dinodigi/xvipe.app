/**
 * GET /api/apps/<slug>/data                → { collections: [name…] }
 * GET /api/apps/<slug>/data?collection=x   → { entries, count }
 * Read-only Data tool backing: live MCP reads with the server-held token.
 */
import { NextRequest } from "next/server";
import { getApp } from "@/lib/apps/store";
import { getPluggieToken } from "@/lib/pluggie/token";
import { callTool } from "@/lib/pluggie/mcp";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const app = getApp(slug);
  if (!app) return Response.json({ error: "unknown app" }, { status: 404 });

  let token: string;
  try {
    token = getPluggieToken(app.projectId);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }

  const collection = req.nextUrl.searchParams.get("collection");
  try {
    if (!collection) {
      const res = await callTool<{ collections?: { name: string }[] }>("list_collections", {}, token);
      const collections = (Array.isArray(res) ? res : res.collections ?? []).map((c) =>
        typeof c === "string" ? c : c.name,
      );
      return Response.json({ collections });
    }
    const [rows, count] = await Promise.all([
      callTool<{ entries?: unknown[] }>("query_entries", { collection, limit: 50 }, token),
      callTool<{ count?: number }>("count_entries", { collection }, token).catch(() => ({ count: undefined })),
    ]);
    return Response.json({
      entries: (rows as { entries?: unknown[] }).entries ?? rows,
      count: (count as { count?: number }).count,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
