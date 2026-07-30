/**
 * lib/apps/store.ts — server-side state for the apps XVibe builds.
 *
 * Phase-1 storage is the filesystem (.xvibe/, gitignored). XVibe's own
 * operational data moves to its own Pluggie project in Phase 2 — deliberately
 * not yet (SETUP.md §1). Layout per app:
 *
 *   .xvibe/apps/<slug>/app.json        — metadata (name, projectId, …)
 *   .xvibe/apps/<slug>/secret.json     — the app's DELIVERY token. Custody
 *                                        rule: written by the mint intercept,
 *                                        read ONLY by the serving proxy —
 *                                        never by the model, never into ws/.
 *   .xvibe/apps/<slug>/ws/**           — the static app the agent writes
 *   .xvibe/apps/<slug>/generated/**    — schema snapshots (typed client)
 *   .xvibe/apps/<slug>/transcript.jsonl— chat + build history
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, appendFileSync, cpSync } from "node:fs";
import { join, resolve, sep, posix } from "node:path";

// On Render (or any host with ephemeral filesystems) point XVIBE_STATE_DIR at
// the persistent disk mount (e.g. /var/data/xvibe) — locally it's ./.xvibe.
const ROOT = process.env.XVIBE_STATE_DIR ? resolve(process.env.XVIBE_STATE_DIR) : resolve(process.cwd(), ".xvibe");
const APPS = join(ROOT, "apps");

export interface AppMeta {
  slug: string;
  name: string;
  description?: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  publishedVersion?: number;
}

/* ── workspace write rules — the agent writes here, so be strict ─────────── */

/** Browser-ready static files only: no build step, no server code, no dotfiles. */
const ALLOWED_EXTENSIONS = new Set([
  "html", "css", "js", "mjs", "json", "svg", "txt", "md", "webmanifest", "ico", "png", "jpg", "jpeg", "gif", "webp", "woff2",
]);
const MAX_FILE_BYTES = 1_000_000; // 1 MB per file
const MAX_TOTAL_BYTES = 10_000_000; // 10 MB per app
const MAX_FILES = 200;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "app";
}

function appDir(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug)) throw new Error(`Bad app slug: ${slug}`);
  return join(APPS, slug);
}

/** Resolve a workspace-relative path, refusing traversal, absolutes and dotfiles. */
function wsPath(slug: string, relPath: string): string {
  const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.length > 300) throw new Error(`Bad path: ${relPath}`);
  for (const segment of cleaned.split("/")) {
    if (!segment || segment === "." || segment === ".." || segment.startsWith(".")) {
      throw new Error(`Path segment not allowed: "${segment}" in ${relPath}`);
    }
    if (!/^[\w][\w.-]*$/.test(segment)) throw new Error(`Path segment not allowed: "${segment}" in ${relPath}`);
  }
  const base = join(appDir(slug), "ws");
  const full = resolve(base, cleaned);
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`Path escapes workspace: ${relPath}`);
  return full;
}

/* ── app lifecycle ────────────────────────────────────────────────────────── */

/** Hostnames the studio itself owns — an app slug may never shadow them. */
const RESERVED_SLUGS = new Set(["www", "studio", "api", "admin", "mail", "unlock", "apps"]);

/** Always create a new app (multi-app: the switcher's "New app…"). */
export function createApp(projectId: string, name: string): AppMeta {
  mkdirSync(APPS, { recursive: true });
  let slug = slugify(name);
  if (RESERVED_SLUGS.has(slug)) slug = `app-${slug}`;
  let n = 2;
  while (existsSync(appDir(slug))) slug = `${slugify(name)}-${n++}`;

  const meta: AppMeta = {
    slug,
    name,
    projectId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(join(appDir(slug), "ws"), { recursive: true });
  mkdirSync(join(appDir(slug), "generated"), { recursive: true });
  writeFileSync(join(appDir(slug), "app.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export function ensureApp(projectId: string, name: string): AppMeta {
  // default app per project — reuse the first if it exists
  const existing = listApps().find((a) => a.projectId === projectId);
  if (existing) return existing;
  return createApp(projectId, name);
}

export function getApp(slug: string): AppMeta | undefined {
  const file = join(appDir(slug), "app.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as AppMeta;
}

export function updateApp(slug: string, patch: Partial<AppMeta>): AppMeta {
  const meta = getApp(slug);
  if (!meta) throw new Error(`Unknown app: ${slug}`);
  const next = { ...meta, ...patch, slug: meta.slug, projectId: meta.projectId, updatedAt: new Date().toISOString() };
  writeFileSync(join(appDir(slug), "app.json"), JSON.stringify(next, null, 2));
  return next;
}

export function listApps(): AppMeta[] {
  if (!existsSync(APPS)) return [];
  return readdirSync(APPS)
    .map((slug) => getApp(slug))
    .filter((a): a is AppMeta => Boolean(a));
}

/* ── workspace files ──────────────────────────────────────────────────────── */

export interface WsFile {
  path: string;
  bytes: number;
}

export function wsWrite(slug: string, relPath: string, content: string): WsFile {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `File type ".${ext}" is not allowed. Built apps are static, browser-ready bundles — no build step, no server code. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
    );
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) throw new Error(`File too large: ${bytes} bytes (max ${MAX_FILE_BYTES}).`);
  const existing = wsList(slug);
  const already = existing.find((f) => f.path === normalizeRel(relPath));
  if (!already && existing.length >= MAX_FILES) throw new Error(`App has ${MAX_FILES} files already — consolidate.`);
  const total = existing.reduce((s, f) => s + f.bytes, 0) - (already?.bytes ?? 0) + bytes;
  if (total > MAX_TOTAL_BYTES) throw new Error(`App exceeds ${MAX_TOTAL_BYTES} total bytes.`);

  const full = wsPath(slug, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
  updateApp(slug, {});
  return { path: normalizeRel(relPath), bytes };
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function wsRead(slug: string, relPath: string): string {
  return readFileSync(wsPath(slug, relPath), "utf8");
}

export function wsReadRaw(slug: string, relPath: string): Buffer {
  return readFileSync(wsPath(slug, relPath));
}

export function wsExists(slug: string, relPath: string): boolean {
  try {
    return existsSync(wsPath(slug, relPath));
  } catch {
    return false;
  }
}

export function wsDelete(slug: string, relPath: string): void {
  rmSync(wsPath(slug, relPath), { force: true });
}

export function wsList(slug: string): WsFile[] {
  const base = join(appDir(slug), "ws");
  if (!existsSync(base)) return [];
  const out: WsFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = prefix ? posix.join(prefix, entry) : entry;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else out.push({ path: rel, bytes: st.size });
    }
  };
  walk(base, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* ── delivery-token custody ───────────────────────────────────────────────── */

/**
 * The app's delivery token. Written when the builder mints one (the tool
 * wrapper intercepts the raw value — it never enters the model's context or
 * the transcript). Read only by the serving proxy, which injects it at the
 * edge. It must never appear in ws/ files (static bundles ship to browsers).
 */
export function setDeliveryToken(slug: string, token: string, label: string): void {
  writeFileSync(
    join(appDir(slug), "secret.json"),
    JSON.stringify({ deliveryToken: token, label, mintedAt: new Date().toISOString() }, null, 2),
  );
}

export function getDeliveryToken(slug: string): string | undefined {
  const file = join(appDir(slug), "secret.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as { deliveryToken?: string }).deliveryToken;
}

/* ── generated artifacts (typed client snapshots — reference, not shipped) ── */

export function saveGenerated(slug: string, filename: string, content: string): void {
  if (!/^[\w][\w.-]*$/.test(filename)) throw new Error(`Bad filename: ${filename}`);
  writeFileSync(join(appDir(slug), "generated", filename), content, "utf8");
}

/* ── transcript (chat + build history) ────────────────────────────────────── */

export interface TranscriptEvent {
  at: string;
  kind: "user" | "agent_text" | "tool" | "system";
  text?: string;
  tool?: { name: string; summary: string; ok: boolean };
  /** full Anthropic message turns for conversation resume (kind: "system") */
  turns?: unknown[];
}

export function appendTranscript(slug: string, event: Omit<TranscriptEvent, "at">): void {
  appendFileSync(join(appDir(slug), "transcript.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
}

export function readTranscript(slug: string): TranscriptEvent[] {
  const file = join(appDir(slug), "transcript.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptEvent;
      } catch {
        return undefined;
      }
    })
    .filter((e): e is TranscriptEvent => Boolean(e));
}

/* ── conversation state (model turns, for resume across messages) ─────────── */

export function saveConversation(slug: string, turns: unknown[]): void {
  writeFileSync(join(appDir(slug), "conversation.json"), JSON.stringify(turns));
}

export function loadConversation(slug: string): unknown[] {
  const file = join(appDir(slug), "conversation.json");
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown[];
  } catch {
    return [];
  }
}

/* ── deploys ──────────────────────────────────────────────────────────────── */

export function deploysDir(slug: string): string {
  return join(ROOT, "deploys", slug);
}

/** Absolute path of the app's static workspace (for byte-copy deploys). */
export function wsDir(slug: string): string {
  return join(appDir(slug), "ws");
}

export interface DeployVersionInfo {
  version: number;
  at: string;
  files: number;
  bytes: number;
}

/** Publish history from the immutable snapshot dirs, newest first. */
export function listDeploys(slug: string): DeployVersionInfo[] {
  const dir = deploysDir(slug);
  if (!existsSync(dir)) return [];
  const out: DeployVersionInfo[] = [];
  for (const entry of readdirSync(dir)) {
    const m = entry.match(/^v(\d+)$/);
    if (!m) continue;
    const snap = join(dir, entry);
    let files = 0;
    let bytes = 0;
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const full = join(d, f);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else {
          files += 1;
          bytes += st.size;
        }
      }
    };
    walk(snap);
    out.push({ version: Number(m[1]), at: statSync(snap).mtime.toISOString(), files, bytes });
  }
  return out.sort((a, b) => b.version - a.version);
}

/**
 * Rollback: restore the workspace from snapshot vN (replaces any unpublished
 * edits — the UI confirms before calling). Byte copy only, never a build.
 */
export function restoreDeployToWs(slug: string, version: number): WsFile[] {
  const snap = join(deploysDir(slug), `v${version}`);
  if (!existsSync(snap)) throw new Error(`No snapshot v${version} for ${slug}`);
  const ws = wsDir(slug);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  cpSync(snap, ws, { recursive: true });
  updateApp(slug, { publishedVersion: version, publishedAt: new Date().toISOString() });
  return wsList(slug);
}
