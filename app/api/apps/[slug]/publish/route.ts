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
    const result = await deployApp(slug, req.nextUrl.origin);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
