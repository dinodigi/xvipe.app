/**
 * GET  /api/apps/<slug>/deploys           → publish history (immutable snapshots)
 * POST /api/apps/<slug>/deploys           → { rollback: N } — restore ws from vN
 *                                           and repoint R2's current.json.
 * Rollback replaces unpublished workspace edits; the UI confirms first.
 */
import { NextRequest } from "next/server";
import { getApp, listDeploys, restoreDeployToWs } from "@/lib/apps/store";
import { r2Configured, repointCurrent } from "@/lib/deploy/r2";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const app = getApp(slug);
  if (!app) return Response.json({ error: "unknown app" }, { status: 404 });
  return Response.json({ versions: listDeploys(slug), live: app.publishedVersion ?? null });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!getApp(slug)) return Response.json({ error: "unknown app" }, { status: 404 });
  const { rollback } = (await req.json().catch(() => ({}))) as { rollback?: number };
  if (!rollback || !Number.isInteger(rollback)) {
    return Response.json({ error: "rollback: <version number> required" }, { status: 400 });
  }
  try {
    const files = restoreDeployToWs(slug, rollback);
    let note = `Workspace restored from v${rollback}.`;
    if (r2Configured()) {
      try {
        await repointCurrent(slug, rollback, files.map((f) => f.path));
        note += " R2 current.json repointed.";
      } catch (e) {
        note += ` R2 repoint failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return Response.json({ ok: true, live: rollback, versions: listDeploys(slug), note });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
