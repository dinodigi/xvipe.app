/**
 * POST /api/apps/<slug>/reset — start this app fresh.
 *
 * Exists because resetting the Pluggie project does NOT reset the studio: the
 * conversation and transcript survive, so the builder happily carries on with
 * a project whose collections were just deleted. This clears the studio side.
 *
 * { files: true } also empties the workspace and re-applies the theme, so the
 * app is genuinely blank rather than blank-with-someone-else's-markup.
 *
 * { backend: true } goes all the way through and drops every collection in
 * Pluggie too. That seam — studio clean, backend still populated — is exactly
 * where a reset got stuck before, so it is now reachable in one action. It is
 * irreversible; the caller is expected to have confirmed with the user.
 */
import { NextRequest } from "next/server";
import { clearAppHistory, getApp } from "@/lib/apps/store";
import { applyTheme } from "@/lib/themes/apply";
import { DEFAULT_THEME_ID } from "@/lib/themes";
import { teardownBackend, type TeardownReport } from "@/lib/agent/teardown";
import { getPluggieToken } from "@/lib/pluggie/token";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const app = getApp(slug);
  if (!app) return Response.json({ error: `Unknown app: ${slug}` }, { status: 404 });

  const { files, backend } = (await req.json().catch(() => ({}))) as { files?: boolean; backend?: boolean };
  try {
    // Backend first. If the teardown fails we have not yet destroyed the
    // conversation that explains what this app was, which keeps the failure
    // recoverable instead of merely reported.
    let teardown: TeardownReport | undefined;
    if (backend) teardown = await teardownBackend(getPluggieToken(app.projectId));

    clearAppHistory(slug, { files: Boolean(files) });
    if (files) applyTheme(slug, app.themeId ?? DEFAULT_THEME_ID);

    const cleared = ["chat history", files && "app files", backend && "Pluggie collections"]
      .filter(Boolean)
      .join(", ");
    return Response.json({
      ok: !teardown || teardown.remaining.length === 0,
      cleared,
      ...(teardown
        ? { backend: teardown }
        : { note: "This clears the studio only. Collections live in Pluggie — pass backend:true to drop those too." }),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
