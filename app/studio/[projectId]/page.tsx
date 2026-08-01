/**
 * /studio/<projectId> — the IDE (P1.2). Server side: authenticate to Pluggie
 * (token seam), orient with get_project_info, ensure the project's app
 * exists, then hand everything to the client Studio. The mcp token itself
 * never crosses this boundary — only derived, displayable facts do.
 */
import { getPluggieToken } from "@/lib/pluggie/token";
import { getProjectInfo } from "@/lib/pluggie/mcp";
import { ensureApp, getApp, listApps, readTranscript, wsList } from "@/lib/apps/store";
import { Studio } from "@/components/Studio";

export const dynamic = "force-dynamic";

export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ app?: string }>;
}) {
  const { projectId } = await params;
  const { app: requestedSlug } = await searchParams;

  let token: string;
  try {
    token = getPluggieToken(projectId);
  } catch (e) {
    return (
      <Fault
        title="No credential for this project"
        body={e instanceof Error ? e.message : String(e)}
      />
    );
  }

  try {
    const info = await getProjectInfo(token);
    const projectName = info.project?.branding?.displayName ?? info.project?.name ?? "project";
    const requested = requestedSlug ? getApp(requestedSlug) : undefined;
    const app =
      requested && requested.projectId === projectId ? requested : ensureApp(projectId, projectName);
    const apps = listApps().filter((a) => a.projectId === projectId);
    const transcript = readTranscript(app.slug);
    const files = wsList(app.slug);
    const connectors = info.briefing?.health?.connectors ?? [];
    const dbStatus = connectors.find((c) => c.type === "neon")?.status ?? "unknown";
    const attention = info.briefing?.attention ?? [];

    return (
      <Studio
        app={app}
        apps={apps}
        projectId={projectId}
        projectName={projectName}
        dbStatus={dbStatus}
        attention={attention}
        endUserAuth={Boolean(info.endUserAuth?.configured)}
        appsDomain={process.env.XVIBE_APPS_BASE_DOMAIN}
        previewDomain={process.env.XVIBE_PREVIEW_BASE_DOMAIN ?? process.env.XVIBE_APPS_BASE_DOMAIN}
        initialTranscript={transcript}
        initialFiles={files}
      />
    );
  } catch (e) {
    return (
      <Fault
        title="Pluggie did not answer"
        body={`get_project_info failed: ${e instanceof Error ? e.message : String(e)}. Check PLUGGIE_MCP_TOKEN in .env.local, then run npm run spine to re-prove the connection.`}
      />
    );
  }
}

function Fault({ title, body }: { title: string; body: string }) {
  return (
    <main className="fault">
      <div className="fault-card">
        <h1>{title}</h1>
        <p>{body}</p>
        <p>
          The studio needs a live Pluggie project: set <code>PLUGGIE_MCP_TOKEN</code> and{" "}
          <code>PLUGGIE_PROJECT_ID</code> in <code>.env.local</code> (SETUP.md), or open the studio
          from that project once the console button lands.
        </p>
      </div>
    </main>
  );
}
