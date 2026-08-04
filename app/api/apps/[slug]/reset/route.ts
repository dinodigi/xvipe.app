/**
 * POST /api/apps/<slug>/reset — start this app fresh.
 *
 * Exists because resetting the Pluggie project does NOT reset the studio: the
 * conversation and transcript survive, so the builder happily carries on with
 * a project whose collections were just deleted. This clears the studio side.
 *
 * { files: true } also empties the workspace and re-applies the theme, so the
 * app is genuinely blank rather than blank-with-someone-else's-markup.
 */
import { NextRequest } from "next/server";
import { clearAppHistory, getApp } from "@/lib/apps/store";
import { applyTheme } from "@/lib/themes/apply";
import { DEFAULT_THEME_ID } from "@/lib/themes";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const app = getApp(slug);
  if (!app) return Response.json({ error: `Unknown app: ${slug}` }, { status: 404 });

  const { files } = (await req.json().catch(() => ({}))) as { files?: boolean };
  try {
    clearAppHistory(slug, { files: Boolean(files) });
    if (files) applyTheme(slug, app.themeId ?? DEFAULT_THEME_ID);
    return Response.json({
      ok: true,
      cleared: files ? "chat history and app files" : "chat history",
      note: "This clears the studio only. Collections live in Pluggie — reset those there if you also want the data gone.",
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
