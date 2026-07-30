/**
 * GET  /api/apps?projectId=…  → apps for a project (the switcher)
 * POST /api/apps { projectId, name } → create a new app
 */
import { NextRequest } from "next/server";
import { createApp, listApps } from "@/lib/apps/store";
import { getPluggieToken } from "@/lib/pluggie/token";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId") ?? "";
  return Response.json({ apps: listApps().filter((a) => a.projectId === projectId) });
}

export async function POST(req: NextRequest) {
  const { projectId, name } = (await req.json().catch(() => ({}))) as { projectId?: string; name?: string };
  if (!projectId || !name?.trim()) return Response.json({ error: "projectId and name required" }, { status: 400 });
  try {
    getPluggieToken(projectId); // validates this deployment may build for the project
    const app = createApp(projectId, name.trim());
    return Response.json({ app });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 403 });
  }
}
