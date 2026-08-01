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

export interface CollectionFacts {
  exists: boolean;
  /** names with publicRead:true — null when the shape could not be parsed */
  publicFields: string[] | null;
}

/** Per-build-turn cache so N files referencing one collection cost one describe. */
export interface BuildContext {
  collections: Map<string, CollectionFacts>;
}
export const createBuildContext = (): BuildContext => ({ collections: new Map() });

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

const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
export const API_REF = /\/api\/v1\/([A-Za-z0-9_-]+)/g;

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

async function parseCheck(label: string, code: string, loader: "js" | "css"): Promise<string[]> {
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
    const facts: CollectionFacts = { exists: true, publicFields };
    ctx.collections.set(name, facts);
    return facts;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code ?? "";
    if (/NOT_FOUND/i.test(code) || /not[ _-]?found|unknown collection|no such|does not exist/i.test(msg)) {
      const facts: CollectionFacts = { exists: false, publicFields: null };
      ctx.collections.set(name, facts);
      return facts;
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
  if (ext === "js" || ext === "mjs") {
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
    for (const m of content.matchAll(INLINE_SCRIPT)) {
      i += 1;
      if (m[1]?.trim()) report.blockers.push(...(await parseCheck(`${path} inline <script> #${i}`, m[1], "js")));
    }
  }

  /* ── server-code drift layer (js + inline scripts) ── */
  if (ext === "js" || ext === "mjs") {
    report.findings.push(...serverCodeFindings(path, content));
  } else if (ext === "html") {
    for (const m of content.matchAll(INLINE_SCRIPT)) {
      if (m[1]?.trim()) report.findings.push(...serverCodeFindings(`${path} (inline script)`, m[1]));
    }
  }

  /* ── API-lint layer (html/js only — where fetches live) ── */
  if (ext === "html" || ext === "js" || ext === "mjs") {
    const names = new Set<string>();
    for (const m of content.matchAll(API_REF)) {
      if (!NON_COLLECTION_PATHS.has(m[1])) names.add(m[1]);
    }
    for (const name of names) {
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
