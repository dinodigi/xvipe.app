/**
 * POST /api/apps/<slug>/publish — the user's Publish button (P1.4).
 * Snapshots the static bundle and reports the live URL. Deploys move bytes;
 * they never build or execute app code.
 */
import { NextRequest } from "next/server";
import { deployApp } from "@/lib/deploy/target";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  try {
    // Behind Render's proxy nextUrl.origin reports the internal port
    // (localhost:10000) — the forwarded headers carry the real origin.
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
    const proto = req.headers.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
    const result = await deployApp(slug, `${proto}://${host}`);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
