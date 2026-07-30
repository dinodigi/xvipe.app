/**
 * lib/pluggie/token.ts — THE swappable credential seam (CONNECTION.md §3).
 *
 * Every caller gets the mcp token from this ONE function, never from env
 * directly. Today (§3a) it returns the hand-minted dev token for the single
 * Phase-1 project. When D3/OAuth lands (§3b), this function exchanges the
 * user's consent grant for a scoped, expiring token — and nothing else in
 * XVibe changes. If you are designing a token handoff anywhere else: stop.
 *
 * SERVER-SIDE ONLY. The mcp token never reaches a browser or a built app.
 */

export function getPluggieToken(projectId: string): string {
  // .trim() everywhere: env values pasted into hosting dashboards routinely
  // carry trailing whitespace/newlines, and a strict compare then fails in a
  // way that looks like a wrong id.
  const configuredId = process.env.PLUGGIE_PROJECT_ID?.trim();
  const token = process.env.PLUGGIE_MCP_TOKEN?.trim();
  projectId = projectId.trim();

  if (!token) {
    throw new Error(
      "PLUGGIE_MCP_TOKEN is not set. Copy env.example → .env.local and mint a token (SETUP.md §2–3).",
    );
  }
  if (!configuredId || projectId !== configuredId) {
    // Phase 1 is a single-project development setup by design (§3a): one
    // token = one project. Arbitrary projects connect via OAuth in Phase 2.
    throw new Error(
      `No credential for project ${projectId}. This dev setup holds a token for exactly one project` +
        ` (PLUGGIE_PROJECT_ID=${configuredId ?? "unset"}). Connecting other projects arrives with D3/OAuth.`,
    );
  }
  return token;
}

/** The one project this dev environment can open (drives the Phase-1 door). */
export function getDevProjectId(): string | undefined {
  return process.env.PLUGGIE_PROJECT_ID?.trim();
}
