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

/** Pluggie tools the builder may call — authoring essentials only. */
const PLUGGIE_ALLOWLIST = new Set([
  "get_project_info",
  "list_field_types",
  "list_collections",
  "describe_collection",
  "define_collection",
  "delete_collection",
  "define_block",
  "list_blocks",
  "create_entry",
  "bulk_create_entries",
  "update_entry",
  "delete_entry",
  "query_entries",
  "count_entries",
  "search_entries",
  "upload_asset",
  "list_assets",
  "set_locales",
  "list_plugins",
  "get_plugin",
  "enable_plugin",
  "list_delivery_tokens",
  "mint_delivery_token",
  "get_client_code",
  "test_hook",
  "get_deliveries",
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
): Promise<ToolOutcome> {
  try {
    /* ── workspace tools ── */
    if (name === "write_app_file") {
      const file = wsWrite(slug, String(input.path), String(input.content));
      return { result: { ok: true, ...file }, isError: false, summary: `wrote ${file.path} (${file.bytes} B)`, filesChanged: [file.path] };
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
      if (getDeliveryToken(slug)) {
        return {
          result: { ok: true, note: "This app already has a delivery token at the serving edge — reusing it. Rotation happens via revoke + re-mint in the console." },
          isError: false,
          summary: "delivery token already in custody — reused",
        };
      }
      const minted = await callTool<{ token?: string; value?: string; project?: { name?: string } }>(name, input, mcpToken);
      const raw = minted.token ?? minted.value;
      if (!raw) return { result: minted, isError: true, summary: "mint returned no token" };
      setDeliveryToken(slug, raw, String(input.label ?? "xvibe app"));
      return {
        result: {
          ok: true,
          label: input.label,
          project: minted.project ?? undefined,
          token: "<redacted — stored by XVibe at the serving edge; the app calls /api/v1 with no credential>",
        },
        isError: false,
        summary: `minted delivery token "${preview(input.label, 40)}" → edge custody`,
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
    return { result, isError: false, summary: summarize(name, input, result) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Structured E_* errors go back to the model verbatim — they self-repair.
    return { result: { error: message }, isError: true, summary: preview(message, 120) };
  }
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
