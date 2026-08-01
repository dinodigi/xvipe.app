/**
 * lib/agent/tools.ts — the builder's tool surface.
 *
 * Two halves:
 *  - a CURATED passthrough of Pluggie MCP tools, with schemas read from the
 *    LIVE surface at session start (CONNECTION.md: a cached tool list is how
 *    a field agent lost a night), and
 *  - XVibe workspace tools for the static app files.
 *
 * One deliberate interception: mint_delivery_token. The raw token is stored
 * server-side for the app's serving proxy and NEVER returned to the model —
 * it stays out of the context window, the transcript, and any generated file.
 */
import { callTool, listTools } from "@/lib/pluggie/mcp";
import { DELIVERY_BASE } from "@/lib/pluggie/delivery";
import { syncDeliveryToken } from "@/lib/deploy/kv";
import { createBuildContext, verifyAppFile, type BuildContext } from "@/lib/agent/verify";
import {
  getApp,
  saveGenerated,
  setDeliveryToken,
  getDeliveryToken,
  updateApp,
  wsDelete,
  wsList,
  wsRead,
  wsWrite,
} from "@/lib/apps/store";

/**
 * Pluggie tools the builder may call — the full authoring envelope minus
 * destructive/ops-only verbs (purge, export/import, plugin authoring, token
 * revocation stay human-only). Widened 2026-07-30 per docs/GAP-MAP.md §1:
 * the platform did schedules, CAS, transactions, aggregations, inbound email
 * and version-restore all along — the agent just couldn't reach them.
 */
const PLUGGIE_ALLOWLIST = new Set([
  // orientation
  "get_project_info",
  "list_field_types",
  "list_connectors",
  // schema
  "list_collections",
  "describe_collection",
  "define_collection",
  "delete_collection",
  "define_block",
  "list_blocks",
  "delete_block",
  "set_locales",
  // writes
  "create_entry",
  "bulk_create_entries",
  "update_entry",
  "update_entry_if",
  "transact",
  "delete_entry",
  // reads
  "query_entries",
  "get_entry",
  "count_entries",
  "aggregate_entries",
  "search_entries",
  "get_changes",
  // safety net (recoverable only — purge/empty stay human-only)
  "list_trash",
  "restore_entry",
  "list_entry_versions",
  "restore_entry_version",
  // assets
  "upload_asset",
  "list_assets",
  "delete_asset",
  // automation
  "define_schedule",
  "list_schedules",
  "delete_schedule",
  "configure_inbound",
  "disable_inbound",
  "list_jobs",
  "cancel_job",
  // plugins (consume, not author)
  "list_plugins",
  "get_plugin",
  "enable_plugin",
  // seo advisors (unlocked by the seo plugin)
  "score_page",
  "audit_site",
  "fetch_page",
  // tokens + client
  "list_delivery_tokens",
  "mint_delivery_token",
  "get_client_code",
  // compute + observability
  "test_hook",
  "get_deliveries",
  "get_audit_log",
  // the loop
  "send_feedback",
]);

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const WORKSPACE_TOOLS: AnthropicTool[] = [
  {
    name: "write_app_file",
    description:
      "Write one file into the app's static workspace (creates parent folders). Browser-ready files only (html/css/js/mjs/json/svg/images) — there is no build step. index.html is the app root. Overwrites are fine.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "workspace-relative path, e.g. index.html or css/app.css" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_app_file",
    description: "Read one file from the app workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_app_files",
    description: "List all files in the app workspace with sizes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "delete_app_file",
    description: "Delete one file from the app workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "probe_app",
    description:
      "Smoke-test the app's live data endpoints server-side with the app's REAL delivery token (the same injection the serving edge does). Call it after wiring any page to data: pass the /api/v1/… paths the app fetches (with query strings if the app uses them). Returns per path: HTTP status, row count, and the field names actually present after publicRead projection — a 200 with near-empty rows is a projection problem to fix on the collection, not in the client. Pass userToken (a Clerk JWT) to test authenticated reads the way the app performs them.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: 'delivery paths to probe, e.g. ["/api/v1/tasks?status=open", "/api/v1/tasks"] — max 6',
        },
        userToken: { type: "string", description: "optional X-User-Token (end-user JWT) for gated reads" },
      },
      required: ["paths"],
    },
  },
  {
    name: "set_app_meta",
    description: "Set the app's display name and/or one-line description (shown in the studio chrome).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
      },
    },
  },
];

/** Assemble the session tool surface from the LIVE Pluggie tools/list. */
export async function getAgentTools(mcpToken: string): Promise<AnthropicTool[]> {
  const live = await listTools(mcpToken);
  const pluggie = live
    .filter((t) => PLUGGIE_ALLOWLIST.has(t.name))
    .map((t) => ({
      name: t.name,
      description: (t.description ?? "").slice(0, 2000),
      input_schema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    }));
  return [...pluggie, ...WORKSPACE_TOOLS];
}

export interface ToolOutcome {
  /** JSON-serializable content returned to the model */
  result: unknown;
  isError: boolean;
  /** one-line human summary for the studio step list */
  summary: string;
  filesChanged?: string[];
}

const preview = (v: unknown, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

/** Execute one tool call on behalf of the builder. */
export async function dispatchTool(
  slug: string,
  mcpToken: string,
  name: string,
  input: Record<string, unknown>,
  ctx?: BuildContext,
): Promise<ToolOutcome> {
  const bctx = ctx ?? createBuildContext();
  try {
    /* ── workspace tools ── */
    if (name === "write_app_file") {
      const path = String(input.path);
      const content = String(input.content);
      // P0.2 sight: parse-check + API-lint before anything lands on disk.
      const v = await verifyAppFile(path, content, mcpToken, bctx);
      if (v.blockers.length) {
        return {
          result: { error: "File NOT written — syntax errors. Fix them and resend the complete file.", problems: v.blockers },
          isError: true,
          summary: `✗ ${path} — ${preview(v.blockers[0], 90)}`,
        };
      }
      const file = wsWrite(slug, path, content);
      const clean = v.findings.length === 0;
      return {
        result: {
          ok: clean,
          ...file,
          ...(v.findings.length ? { apiLint: v.findings } : {}),
          ...(v.notes.length ? { api: v.notes } : {}),
        },
        isError: !clean,
        summary: clean
          ? `wrote ${file.path} (${file.bytes} B)${v.notes.length ? " · api-lint ok" : ""}`
          : `wrote ${file.path} — ${preview(v.findings[0], 90)}`,
        filesChanged: [file.path],
      };
    }
    if (name === "probe_app") {
      const token = getDeliveryToken(slug);
      if (!token) {
        return {
          result: { error: "This app has no delivery token yet — call mint_delivery_token first, then probe." },
          isError: true,
          summary: "probe_app: no delivery token yet",
        };
      }
      const paths = Array.isArray(input.paths) ? input.paths.map(String).slice(0, 6) : [];
      if (!paths.length) {
        return { result: { error: 'Pass paths: ["/api/v1/…"]' }, isError: true, summary: "probe_app: no paths given" };
      }
      const probes: Record<string, unknown>[] = [];
      for (const p of paths) {
        if (!p.startsWith("/api/v1/")) {
          probes.push({ path: p, error: "probe_app only accepts /api/v1/* paths" });
          continue;
        }
        try {
          const headers: Record<string, string> = { authorization: `Bearer ${token}` };
          if (input.userToken) headers["x-user-token"] = String(input.userToken);
          const res = await fetch(`${DELIVERY_BASE()}${p.slice("/api/v1".length)}`, {
            headers,
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          });
          const text = await res.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          probes.push(probeSummary(p, res.status, parsed, text));
        } catch (e) {
          probes.push({ path: p, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const issues = probes.filter((r) => r.error || r.warning).length;
      return {
        result: {
          probes,
          note: "fields = what the app actually receives after publicRead projection. Empty fields on a 200 = fix publicRead on the collection, never the client.",
        },
        isError: false,
        summary: issues ? `probed ${probes.length} endpoint(s) — ${issues} issue(s) to read` : `probed ${probes.length} endpoint(s) — all healthy`,
      };
    }
    if (name === "read_app_file") {
      const content = wsRead(slug, String(input.path));
      return { result: { path: input.path, content }, isError: false, summary: `read ${input.path}` };
    }
    if (name === "list_app_files") {
      const files = wsList(slug);
      return { result: { files }, isError: false, summary: `${files.length} file(s)` };
    }
    if (name === "delete_app_file") {
      wsDelete(slug, String(input.path));
      return { result: { ok: true }, isError: false, summary: `deleted ${input.path}`, filesChanged: [String(input.path)] };
    }
    if (name === "set_app_meta") {
      const app = updateApp(slug, {
        ...(input.name ? { name: String(input.name) } : {}),
        ...(input.description ? { description: String(input.description) } : {}),
      });
      return { result: { ok: true, name: app.name, description: app.description }, isError: false, summary: `app meta updated` };
    }

    /* ── Pluggie passthroughs with custody/snapshot interceptions ── */
    if (!PLUGGIE_ALLOWLIST.has(name)) {
      return { result: { error: `Unknown tool: ${name}` }, isError: true, summary: `unknown tool ${name}` };
    }

    if (name === "mint_delivery_token") {
      const existing = getDeliveryToken(slug);
      if (existing && (await deliveryTokenAlive(existing))) {
        return {
          result: { ok: true, note: "This app already has a delivery token at the serving edge — reusing it. Rotation happens via revoke + re-mint in the console." },
          isError: false,
          summary: "delivery token already in custody — reused",
        };
      }
      // No token, or the stored one is dead (revoked/rotated upstream) —
      // mint fresh and REPLACE custody, or the app 401s forever.
      const minted = await callTool<{ token?: string; value?: string; project?: { name?: string } }>(name, input, mcpToken);
      const raw = minted.token ?? minted.value;
      if (!raw) return { result: minted, isError: true, summary: "mint returned no token" };
      setDeliveryToken(slug, raw, String(input.label ?? "xvibe app"));
      // Mirror to the edge when the worker is live; a no-op until then.
      const kv = await syncDeliveryToken(slug, raw);
      return {
        result: {
          ok: true,
          label: input.label,
          project: minted.project ?? undefined,
          ...(existing ? { note: "The previously stored token was dead (revoked upstream) — replaced with this fresh one." } : {}),
          ...(kv.ok ? {} : { edgeSync: `Token stored, but the edge copy failed (${kv.error}) — publishing retries it.` }),
          token: "<redacted — stored by XVibe at the serving edge; the app calls /api/v1 with no credential>",
        },
        isError: false,
        summary: existing
          ? `stored delivery token was dead — minted a fresh replacement "${preview(input.label, 40)}"`
          : `minted delivery token "${preview(input.label, 40)}" → edge custody`,
      };
    }

    if (name === "get_client_code") {
      const code = await callTool<unknown>(name, input, mcpToken);
      const text = typeof code === "string" ? code : JSON.stringify(code);
      saveGenerated(slug, "agentx-client.ts", text);
      const head = text.split("\n").slice(0, 60).join("\n");
      return {
        result: {
          note: "Full client saved to the app's generated/ snapshot (reference for types/shapes — the shipped app uses plain fetch on /api/v1). First 60 lines:",
          head,
        },
        isError: false,
        summary: `typed client regenerated (${text.length} chars)`,
      };
    }

    const result = await callTool<unknown>(name, input, mcpToken);
    // schema changed mid-build → the API-lint cache must re-describe it
    if (name === "define_collection" || name === "delete_collection") {
      bctx.collections.delete(String(input.name));
    }
    return { result, isError: false, summary: summarize(name, input, result) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Structured E_* errors go back to the model verbatim — they self-repair.
    return { result: { error: message }, isError: true, summary: preview(message, 120) };
  }
}

/**
 * Is a stored delivery token still accepted upstream? A revoked token answers
 * 401 on ANY path; a live one answers 404/200 on a nonsense collection. On
 * network trouble assume alive — minting would fail on the same network.
 */
async function deliveryTokenAlive(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${DELIVERY_BASE()}/__token_check`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true;
  }
}

/** Compress one probe response into what the model needs: status, count, real fields. */
function probeSummary(path: string, status: number, parsed: unknown, rawText: string): Record<string, unknown> {
  const flatten = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object") return {};
    const rec = v as Record<string, unknown>;
    if (rec.data && typeof rec.data === "object") {
      const { data, ...rest } = rec;
      return { ...rest, ...(data as Record<string, unknown>) };
    }
    return rec;
  };
  const out: Record<string, unknown> = { path, status };
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (["items", "entries", "data", "results"]
          .map((k) => (parsed as Record<string, unknown>)[k])
          .find(Array.isArray) as unknown[] | undefined)
      : undefined;
  if (arr) {
    out.count = arr.length;
    const fields = arr.length ? Object.keys(flatten(arr[0])).filter((k) => flatten(arr[0])[k] !== undefined) : [];
    out.fields = fields.slice(0, 24);
    if (arr.length) out.sample = JSON.stringify(arr[0]).slice(0, 300);
    if (status === 200 && arr.length > 0 && fields.length <= 2) {
      out.warning =
        "rows arrive nearly EMPTY — publicRead projection problem. Fix the collection's publicRead flags (exact-merge redefine), not the client.";
    }
    if (status === 200 && arr.length === 0) out.note = "no rows — seed data, or check filters/access rules";
  } else if (parsed && typeof parsed === "object") {
    out.fields = Object.keys(parsed as object).slice(0, 24);
    out.sample = JSON.stringify(parsed).slice(0, 300);
  } else {
    out.sample = rawText.slice(0, 200);
  }
  if (status >= 400) out.warning = `HTTP ${status} — read the body; E_* errors state their own fix.`;
  return out;
}

function summarize(name: string, input: Record<string, unknown>, result: unknown): string {
  const r = result as Record<string, unknown> | null;
  switch (name) {
    case "define_collection":
      return `defined ${input.name}${r && (r.convergence ? " · converges ~15s" : "")}`;
    case "create_entry":
      return `created ${input.collection} → ${preview((r as { id?: string })?.id ?? "", 40)}`;
    case "bulk_create_entries": {
      const n = Array.isArray(input.entries) ? input.entries.length : "?";
      return `seeded ${n} × ${input.collection}`;
    }
    case "enable_plugin":
      return `enabled plugin ${input.id ?? input.name ?? ""}`;
    case "send_feedback":
      return `feedback filed: ${preview(input.summary, 80)}`;
    default:
      return `${name} ok`;
  }
}
