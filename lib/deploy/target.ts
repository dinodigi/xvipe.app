/**
 * lib/deploy/target.ts — the deploy control plane (P1.4).
 *
 * A deploy is a byte copy of the app's static workspace to a serving target —
 * never a build. Running a bundler over agent-written code would execute
 * tenant code on XVibe's infrastructure, which the boundary forbids
 * (XVIBE-PLAN: "We operate a control plane, never a runtime"). Agents write
 * browser-ready files; deploys move bytes.
 *
 * Targets:
 *  - LocalTarget (default): immutable snapshot under .xvibe/deploys/<slug>/vN
 *    and the app is served by this dev server at http://<slug>.localhost:port
 *    — the same host-based serving contract production will use.
 *  - R2Target: selected automatically once R2_* env vars exist. Push bundle
 *    to R2, purge CDN, live at https://<slug>.<XVIBE_APPS_BASE_DOMAIN>.
 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deploysDir, getApp, updateApp, wsDir, wsList } from "@/lib/apps/store";

export interface DeployResult {
  url: string;
  version: number;
  target: "local" | "r2";
  files: number;
  bytes: number;
  note?: string;
}

function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET,
  );
}

/** `studioOrigin` is the origin the studio was opened on (drives local URLs). */
export function deployApp(slug: string, studioOrigin: string): DeployResult {
  const app = getApp(slug);
  if (!app) throw new Error(`Unknown app: ${slug}`);
  const files = wsList(slug);
  if (!files.some((f) => f.path === "index.html")) {
    throw new Error("Nothing to publish yet — the app has no index.html. Ask the builder to create the app first.");
  }
  const bytes = files.reduce((s, f) => s + f.bytes, 0);

  if (r2Configured()) {
    // The seam is here on purpose: when R2 creds land, implement the S3 puts
    // + CDN purge in lib/deploy/r2.ts and flip this branch. Nothing upstream
    // changes — same result shape, same route.
    throw new Error(
      "R2 credentials are set but the R2 target is not wired yet (P1.4 second half). Remove the R2_* vars to keep publishing locally, or implement lib/deploy/r2.ts.",
    );
  }

  // LocalTarget: snapshot ws → <state>/deploys/<slug>/v<N> (immutable history).
  const dir = deploysDir(slug);
  mkdirSync(dir, { recursive: true });
  const version = readdirSync(dir).filter((d) => /^v\d+$/.test(d)).length + 1;
  const snapshot = join(dir, `v${version}`);
  cpSync(wsDir(slug), snapshot, { recursive: true });

  updateApp(slug, { publishedAt: new Date().toISOString(), publishedVersion: version });

  // Live URL: <slug>.localhost in dev; <slug>.<apps domain> when the studio is
  // hosted (Render) with a wildcard domain pointed at it.
  const origin = new URL(studioOrigin);
  const appsDomain = process.env.XVIBE_APPS_BASE_DOMAIN;
  const isLocal = origin.hostname === "localhost" || origin.hostname.endsWith(".localhost");
  const url = isLocal
    ? `${origin.protocol}//${slug}.localhost${origin.port ? `:${origin.port}` : ""}/`
    : appsDomain
      ? `https://${slug}.${appsDomain}/`
      : `${origin.origin}/apps/${slug}/`;
  return {
    url,
    version,
    target: "local",
    files: files.length,
    bytes,
    note: `Snapshot v${version} kept in state dir. R2/CDN offload activates when R2 credentials land (P1.5).`,
  };
}
