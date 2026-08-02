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
import { deploysDir, getApp, getDeliveryToken, isSourceOnly, updateApp, wsDir, wsList } from "@/lib/apps/store";
import { r2Configured, uploadBundle } from "@/lib/deploy/r2";
import { kvConfigured, syncDeliveryToken } from "@/lib/deploy/kv";

export interface DeployResult {
  url: string;
  version: number;
  target: "local" | "r2";
  files: number;
  bytes: number;
  note?: string;
}

/** `studioOrigin` is the origin the studio was opened on (drives local URLs). */
export async function deployApp(slug: string, studioOrigin: string): Promise<DeployResult> {
  const app = getApp(slug);
  if (!app) throw new Error(`Unknown app: ${slug}`);
  // Publish the browser-ready bundle only: .ts/.tsx/.jsx sources live in the
  // workspace so the agent can re-read and edit them, but shipping them would
  // send dead bytes to every visitor. Their compiled .js siblings are already
  // in the list.
  const files = wsList(slug).filter((f) => !isSourceOnly(f.path));
  if (!files.some((f) => f.path === "index.html")) {
    throw new Error("Nothing to publish yet — the app has no index.html. Ask the builder to create the app first.");
  }
  const bytes = files.reduce((s, f) => s + f.bytes, 0);

  // Snapshot ws → <state>/deploys/<slug>/v<N> (immutable history).
  const dir = deploysDir(slug);
  mkdirSync(dir, { recursive: true });
  const version = readdirSync(dir).filter((d) => /^v\d+$/.test(d)).length + 1;
  const snapshot = join(dir, `v${version}`);
  cpSync(wsDir(slug), snapshot, { recursive: true, filter: (src) => !isSourceOnly(src) });

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

  // Durable copy to R2 (versioned prefix + current.json pointer). A failed
  // upload doesn't unpublish — the local snapshot serves; the miss is
  // reported honestly in the note.
  let note = `Snapshot v${version} on the studio host.`;
  let target: DeployResult["target"] = "local";
  if (r2Configured()) {
    try {
      const r2 = await uploadBundle(slug, version, snapshot, files);
      target = "r2";
      note = `Snapshot v${version} · ${r2.uploaded} objects to R2 (${process.env.R2_BUCKET}/${r2.prefix}).`;
    } catch (e) {
      note = `Snapshot v${version} serving locally — R2 upload FAILED: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    note += " R2 offload inactive (no R2_* credentials).";
  }

  // Publishing is also when the edge's token copy heals: an app minted before
  // the worker existed gets its credential mirrored on its next deploy.
  if (kvConfigured()) {
    const token = getDeliveryToken(slug);
    if (token) {
      const kv = await syncDeliveryToken(slug, token);
      if (!kv.ok) note += ` Edge token sync FAILED: ${kv.error} — the app will answer 503 on /api/v1 at the edge.`;
    }
  }

  return { url, version, target, files: files.length, bytes, note };
}
