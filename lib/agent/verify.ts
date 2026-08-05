/**
 * lib/agent/verify.ts — the builder's "sight" (P0.2): static checks every
 * write_app_file must pass, in the same self-repair loop the platform uses.
 *
 * Two layers:
 *  - PARSE: esbuild syntax checks for JS/CSS (+ inline <script> blocks) and
 *    JSON.parse for JSON. Syntax failures BLOCK the write — the preview never
 *    regresses to a file that cannot run.
 *  - API-LINT: every /api/v1/<collection> reference in the file is checked
 *    against the LIVE schema (describe_collection, cached per build turn).
 *    A missing collection is a finding; a collection with zero publicRead
 *    fields is the empty-dashboard trap caught at write time. The public
 *    field list is returned to the model either way — it is the truth of
 *    what the shipped app will receive.
 */
import { transform } from "esbuild";
import { callTool } from "@/lib/pluggie/mcp";
import { loaderFor } from "@/lib/agent/transpile";

export interface CollectionFacts {
  exists: boolean;
  /** names with publicRead:true — null when the shape could not be parsed */
  publicFields: string[] | null;
}

/**
 * Per-build-turn cache so N files referencing one collection cost one describe.
 * Stores the in-flight PROMISE, not the resolved value: tool calls in a round
 * run concurrently, so several files can ask about the same collection at
 * once and must share a single request rather than racing to duplicate it.
 */
export interface BuildContext {
  collections: Map<string, Promise<CollectionFacts | undefined>>;
  /**
   * collection name → epoch ms of its last schema mutation. Pluggie's delivery
   * layer converges in ~15s, and for that window a read is ambiguous: "not
   * converged yet", "doesn't exist" and "stale" all look identical. The agent
   * used to resolve that ambiguity by rewriting app code that was never broken
   * (it was caught inventing its own waits — 500ms, then 2s). Reads now wait
   * the window out instead of guessing.
   */
  converging: Map<string, number>;
}
export const createBuildContext = (): BuildContext => ({ collections: new Map(), converging: new Map() });

/** How long a schema change stays ambiguous. Pluggie states ~15s; round up. */
export const CONVERGENCE_MS = 20_000;

/** Milliseconds still to wait before a read of `name` means anything. */
export function convergenceWait(name: string, ctx: BuildContext, now = Date.now()): number {
  const at = ctx.converging.get(name);
  if (at === undefined) return 0;
  return Math.max(0, CONVERGENCE_MS - (now - at));
}

export interface VerifyReport {
  /** syntax problems — the write is refused */
  blockers: string[];
  /** API-lint problems — the write lands, but the tool result is an error */
  findings: string[];
  /** facts worth telling the model (public field lists) */
  notes: string[];
}

/** Delivery paths that are platform surface, not collections. */
const NON_COLLECTION_PATHS = new Set(["assets", "auth", "changes", "files", "health", "hooks", "me", "search"]);

/**
 * Which collections does this file talk to? Two shapes, because apps write
 * both — and an eval sweep caught us seeing only the first:
 *  - `certain`: a literal "/api/v1/<name>" in the source.
 *  - `candidates`: the app hoisted the base (`const API = "/api/v1"`) and then
 *    built URLs (`${API}/bookings`, API + "/bookings"). The name is a guess,
 *    so callers must treat these as leads to confirm, never as accusations.
 */
export function extractCollectionRefs(text: string): { certain: string[]; candidates: string[] } {
  const certain = new Set<string>();
  for (const m of text.matchAll(API_REF)) if (!NON_COLLECTION_PATHS.has(m[1])) certain.add(m[1]);

  const candidates = new Set<string>();
  if (/["'`]\/api\/v1\/?["'`]/.test(text)) {
    const patterns = [
      /\$\{[^}]{1,40}\}\/([A-Za-z0-9_-]+)/g, //  `${API}/bookings`
      /\+\s*["'`]\/([A-Za-z0-9_-]+)/g, //        API + "/bookings"
    ];
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        if (!NON_COLLECTION_PATHS.has(m[1]) && !certain.has(m[1])) candidates.add(m[1]);
      }
    }
  }
  return { certain: [...certain], candidates: [...candidates] };
}

const SCRIPT_TAG = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

/**
 * Inline blocks that are actually JavaScript. A <script> with a src has no
 * body worth checking, and a typed block may not be JS at all — an import map
 * is JSON, and parsing it as JavaScript rejects a perfectly valid page. (It
 * did: this is why index.html could not be written once JSX shipped.)
 */
function* inlineScripts(html: string): Generator<string> {
  for (const m of html.matchAll(SCRIPT_TAG)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    if (type && !/^(module|text\/javascript|application\/javascript|text\/ecmascript)$/.test(type)) continue;
    if (m[2]?.trim()) yield m[2];
  }
}
export const API_REF = /\/api\/v1\/([A-Za-z0-9_-]+)/g;

/** The collection a delivery path reads, e.g. "/api/v1/tasks?x=1" → "tasks". */
export const collectionOf = (p: string): string => p.replace(/^\/api\/v1\//, "").split(/[?/#]/)[0] ?? "";

/* ── constraint drift ─────────────────────────────────────────────────────── */

const hasKeys = (v: unknown): boolean => Boolean(v && typeof v === "object" && Object.keys(v as object).length);
const hasTransitions = (wf: unknown): boolean =>
  Boolean(wf && typeof wf === "object" && Array.isArray((wf as { transitions?: unknown[] }).transitions) && (wf as { transitions: unknown[] }).transitions.length);

/** Schedules whose action is a workflow transition on `collection`. */
async function transitionSchedules(collection: string, mcpToken: string): Promise<string[]> {
  try {
    const raw = await callTool<unknown>("list_schedules", {}, mcpToken);
    const all = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.schedules as unknown[]) ?? [];
    return all
      .filter((s) => {
        const json = JSON.stringify(s);
        return json.includes(`"${collection}"`) && /"transition"\s*:/.test(json);
      })
      .map((s) => String((s as { name?: string; id?: string }).name ?? (s as { id?: string }).id ?? "unnamed"));
  } catch {
    return [];
  }
}

export interface DriftReport {
  /** load-bearing things the new shape would remove */
  lost: string[];
  /** declared automation that would stop working if they went */
  dependents: string[];
}

/**
 * define_collection is full-replace, so an omitted `workflow` or `access` is a
 * silent deletion. That is how a nightly archive schedule died unnoticed for
 * days: the builder removed a workflow to make a transition error go away, and
 * the schedule's transition action then had nothing to act on — a loud failure
 * converted into a silent one, which is the worst trade available.
 *
 * Returns undefined when the collection is new (nothing to lose).
 */
export async function collectionDrift(
  name: string,
  next: Record<string, unknown>,
  mcpToken: string,
): Promise<DriftReport | undefined> {
  let prev: Record<string, unknown>;
  try {
    const raw = await callTool<Record<string, unknown>>("describe_collection", { name }, mcpToken);
    prev = ((raw.collection as Record<string, unknown>) ?? raw) as Record<string, unknown>;
  } catch {
    return undefined; // new collection
  }
  const lost: string[] = [];
  const dependents: string[] = [];

  if (hasTransitions(prev.workflow) && !hasTransitions(next.workflow)) {
    const states = (prev.workflow as { transitions?: { from?: string; to?: string }[] }).transitions ?? [];
    lost.push(`the workflow (${states.length} transition${states.length === 1 ? "" : "s"})`);
    for (const s of await transitionSchedules(name, mcpToken)) {
      dependents.push(`schedule "${s}" performs a workflow transition on ${name} and would silently stop matching`);
    }
  }
  if (hasKeys(prev.access) && !hasKeys(next.access)) {
    lost.push(`the access rules (${JSON.stringify(prev.access)})`);
  }
  return lost.length ? { lost, dependents } : undefined;
}

/**
 * A schedule whose action is a transition, on a collection that has no
 * workflow, is dead code that fails silently every night. Checked after a
 * schema change rather than before, because that is when it becomes true.
 */
export async function deadScheduleWarning(name: string, mcpToken: string): Promise<string | undefined> {
  const schedules = await transitionSchedules(name, mcpToken);
  if (!schedules.length) return undefined;
  try {
    const raw = await callTool<Record<string, unknown>>("describe_collection", { name }, mcpToken);
    const c = ((raw.collection as Record<string, unknown>) ?? raw) as Record<string, unknown>;
    if (hasTransitions(c.workflow)) return undefined;
    return `DEAD SCHEDULE: ${schedules.map((s) => `"${s}"`).join(", ")} perform${schedules.length === 1 ? "s" : ""} a workflow transition on ${name}, which now has no workflow. ${schedules.length === 1 ? "It" : "They"} will run every night and match nothing. Restore the workflow or delete the schedule — do not leave it silently failing.`;
  } catch {
    return undefined;
  }
}

/**
 * Server-code drift patterns (task #9 — a real Haiku build once wrote a Node
 * backend). None of these have any meaning in a browser file; each one means
 * the model is hallucinating a server it does not have.
 */
const SERVER_CODE_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\brequire\s*\(\s*['"]/, what: 'require("…") — Node module loading' },
  { re: /\bmodule\.exports\b/, what: "module.exports — Node module system" },
  { re: /\bprocess\.env\b/, what: "process.env — server environment access" },
  { re: /\.listen\s*\(\s*\d/, what: ".listen(<port>) — starting a server" },
  { re: /\bfrom\s+['"](?:express|node:|fs|http|https|path|crypto)['"]/, what: "importing a Node/server module" },
];

function serverCodeFindings(label: string, code: string): string[] {
  const hits = SERVER_CODE_PATTERNS.filter((p) => p.re.test(code));
  if (!hits.length) return [];
  return [
    `${label} contains SERVER code (${hits.map((h) => h.what).join("; ")}). The shipped app is static browser files — there is no server, no Node, no build step. Rewrite as browser JS calling /api/v1; business rules belong in Pluggie's declarative layer.`,
  ];
}

async function parseCheck(label: string, code: string, loader: "js" | "css" | "ts" | "tsx" | "jsx"): Promise<string[]> {
  try {
    await transform(code, { loader });
    return [];
  } catch (e) {
    const errs = (e as { errors?: { text: string; location?: { line: number } | null }[] }).errors;
    if (Array.isArray(errs) && errs.length) {
      return errs.slice(0, 3).map((er) => `${label} line ${er.location?.line ?? "?"}: ${er.text}`);
    }
    return [`${label}: ${e instanceof Error ? e.message : String(e)}`];
  }
}

async function collectionFacts(name: string, mcpToken: string, ctx: BuildContext): Promise<CollectionFacts | undefined> {
  const cached = ctx.collections.get(name);
  if (cached) return cached;
  const inFlight = describeOnce(name, mcpToken);
  ctx.collections.set(name, inFlight);
  const facts = await inFlight;
  // A transient failure must not poison the rest of the turn — only a real
  // answer (exists / does not exist) is worth remembering.
  if (!facts) ctx.collections.delete(name);
  return facts;
}

async function describeOnce(name: string, mcpToken: string): Promise<CollectionFacts | undefined> {
  try {
    const desc = await callTool<Record<string, unknown>>("describe_collection", { name }, mcpToken);
    const coll = (desc.collection && typeof desc.collection === "object" ? desc.collection : desc) as Record<string, unknown>;
    const fieldsRaw = coll.fields;
    const publicFields = Array.isArray(fieldsRaw)
      ? fieldsRaw
          .filter((f) => f && typeof f === "object" && (f as { publicRead?: unknown }).publicRead === true)
          .map((f) => String((f as { name?: unknown }).name ?? ""))
          .filter(Boolean)
      : null;
    return { exists: true, publicFields };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code ?? "";
    if (/NOT_FOUND/i.test(code) || /not[ _-]?found|unknown collection|no such|does not exist/i.test(msg)) {
      return { exists: false, publicFields: null };
    }
    return undefined; // infra hiccup — never block a build on lint plumbing
  }
}

export async function verifyAppFile(
  path: string,
  content: string,
  mcpToken: string,
  ctx: BuildContext,
): Promise<VerifyReport> {
  const report: VerifyReport = { blockers: [], findings: [], notes: [] };
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  /* ── parse layer ── */
  const sourceLoader = loaderFor(path);
  if (sourceLoader) {
    // .ts / .tsx / .jsx — type errors are not caught here (esbuild strips
    // types rather than checking them), but syntax errors are, and a file
    // that cannot parse cannot be compiled either.
    report.blockers.push(...(await parseCheck(path, content, sourceLoader)));
  } else if (ext === "js" || ext === "mjs") {
    report.blockers.push(...(await parseCheck(path, content, "js")));
  } else if (ext === "css") {
    report.blockers.push(...(await parseCheck(path, content, "css")));
  } else if (ext === "json" || ext === "webmanifest") {
    try {
      JSON.parse(content);
    } catch (e) {
      report.blockers.push(`${path}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (ext === "html") {
    let i = 0;
    for (const code of inlineScripts(content)) {
      i += 1;
      report.blockers.push(...(await parseCheck(`${path} inline <script> #${i}`, code, "js")));
    }
  }

  /* ── server-code drift layer (js/ts sources + inline scripts) ── */
  if (ext === "js" || ext === "mjs" || sourceLoader) {
    report.findings.push(...serverCodeFindings(path, content));
  } else if (ext === "html") {
    for (const code of inlineScripts(content)) {
      report.findings.push(...serverCodeFindings(`${path} (inline script)`, code));
    }
  }

  /* ── API-lint layer (wherever fetches live: html, js, and ts/tsx/jsx) ── */
  if (ext === "html" || ext === "js" || ext === "mjs" || sourceLoader) {
    const { certain, candidates } = extractCollectionRefs(content);
    // Candidates come from string-built URLs, so a name that doesn't resolve
    // is probably not a collection at all — inform, never accuse.
    for (const name of candidates) {
      const facts = await collectionFacts(name, mcpToken, ctx);
      if (facts?.exists && facts.publicFields?.length) {
        report.notes.push(`/api/v1/${name} (URL built from a base constant) → public fields: [${facts.publicFields.join(", ")}].`);
      }
    }
    for (const name of certain) {
      const facts = await collectionFacts(name, mcpToken, ctx);
      if (!facts) {
        report.notes.push(`API-lint could not verify /api/v1/${name} right now — double-check it yourself.`);
      } else if (!facts.exists) {
        report.findings.push(
          `${path} fetches /api/v1/${name} but no collection "${name}" exists — define_collection first, or fix the path.`,
        );
      } else if (facts.publicFields && facts.publicFields.length === 0) {
        report.findings.push(
          `Collection "${name}" has NO publicRead fields — every delivery response will be empty rows. Set publicRead:true on each field the app reads (describe → exact-merge → redefine), never work around it client-side.`,
        );
      } else if (facts.publicFields) {
        report.notes.push(
          `/api/v1/${name} → public fields: [${facts.publicFields.join(", ")}]. Anything not in this list arrives as undefined.`,
        );
      }
    }
  }

  return report;
}
