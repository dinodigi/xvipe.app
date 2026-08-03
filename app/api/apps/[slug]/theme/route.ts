/**
 * GET  /api/apps/<slug>/theme — the theme catalogue + which one is applied.
 * POST /api/apps/<slug>/theme — apply a theme. One file write, no model call.
 */
import { NextRequest } from "next/server";
import { getApp } from "@/lib/apps/store";
import { THEMES } from "@/lib/themes";
import { applyTheme } from "@/lib/themes/apply";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const app = getApp(slug);
  if (!app) return Response.json({ error: `Unknown app: ${slug}` }, { status: 404 });
  return Response.json({
    current: app.themeId ?? null,
    themes: THEMES.map((t) => ({
      id: t.id,
      name: t.name,
      suits: t.suits,
      // enough for the studio to draw a swatch without shipping every token
      swatch: [t.tokens.bg, t.tokens.accent, t.tokens.ink, t.tokens.surface],
      fontDisplay: t.tokens.fontDisplay,
      radius: t.tokens.radius,
    })),
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!getApp(slug)) return Response.json({ error: `Unknown app: ${slug}` }, { status: 404 });
  const { theme } = (await req.json().catch(() => ({}))) as { theme?: string };
  if (!theme) return Response.json({ error: "theme required" }, { status: 400 });
  try {
    const applied = applyTheme(slug, theme);
    return Response.json({ ok: true, ...applied });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
