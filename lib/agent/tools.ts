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
import {
  collectionDrift,
  collectionOf,
  convergenceWait,
  createBuildContext,
  deadScheduleWarning,
  verifyAppFile,
  type BuildContext,
} from "@/lib/agent/verify";
import { teardownBackend } from "@/lib/agent/teardown";
import { newBacklogItem } from "@/lib/agent/backlog";
import { isTranspilable, transpileAppFile } from "@/lib/agent/transpile";
import { THEMES, getTheme } from "@/lib/themes";
import { applyTheme } from "@/lib/themes/apply";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the vendored runtime lands inside an app, matching the import map. */
const VENDOR_PREACT_PATH = "vendor/preact.js";
let vendoredPreact: string | undefined;
/** Read once per process — it is a committed build artefact, not user data. */
const readVendoredPreact = (): string =>
  (vendoredPreact ??= readFileSync(join(process.cwd(), "lib", "vendor", "preact.js"), "utf8"));
import {
  getApp,
  loadPlanState,
  savePlanState,
  saveGenerated,
  setDeliveryToken,
  getDeliveryToken,
  updateApp,
  wsDelete,
  wsExists,
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
  /** set on the long tail so its schema loads on demand, not every round */
  defer_loading?: boolean;
  /** server-tool discriminator (tool search); absent on ordinary tools */
  type?: string;
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
    name: "edit_app_file",
    description:
      "Change PART of an existing app file: replaces old_string with new_string, in place. Prefer this over write_app_file for anything short of a rewrite — write_app_file re-sends the whole file, which is slow and expensive on a file of any size. old_string must appear EXACTLY ONCE (include surrounding lines to make it unique); the edit is refused otherwise rather than guessing which match you meant. The result is parse-checked and transpiled exactly like a full write.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "workspace-relative path of an existing file" },
        old_string: { type: "string", description: "exact text to replace — must be unique in the file" },
        new_string: { type: "string", description: "replacement text" },
      },
      required: ["path", "old_string", "new_string"],
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
    name: "teardown_backend",
    description:
      "Delete EVERY collection in this project, in a working order. Use this when the user asks to wipe/reset the backend or start fresh — do not loop delete_collection yourself. delete_collection refuses while another collection points a relation field at the target, and a relation CYCLE (A ⇄ B) cannot be resolved by ordering at all; this computes the order and strips relation fields where it has to. Destructive and irreversible: requires confirm:true. Pass dryRun:true first if you want to show the user the plan.",
    input_schema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "must be true — this deletes all collections and their data" },
        dryRun: { type: "boolean", description: "report the plan without deleting anything" },
      },
      required: ["confirm"],
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
    name: "set_app_theme",
    description:
      "Apply one of XVibe's design-token themes to this app. Rewrites css/theme.css only — your own CSS is untouched, which is exactly why you must style against the token names rather than raw values. Choose the theme that fits the business you are building for.",
    input_schema: {
      type: "object",
      properties: {
        theme: { type: "string", enum: THEMES.map((t) => t.id), description: THEMES.map((t) => `${t.id}: ${t.suits}`).join(" | ") },
      },
      required: ["theme"],
    },
  },
  {
    name: "propose_plan",
    description:
      "Propose the ordered list of tasks that will build what the user asked for, then STOP. This is the only action of a planning turn — you hold read-only tools until the user approves, so nothing you propose is built yet. 3–12 tasks. Each is one coherent unit of work with an observable done-when, and the order must respect reality: collection shape before seeding, seeding before the UI that reads it, data wiring before polish. Anything worth doing that you are deliberately leaving out goes to add_to_backlog — never drop it silently.",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "3–12 tasks, in execution order",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: 'imperative and specific, e.g. "Define support_requests with public intake + staff triage rules"',
              },
              doneWhen: {
                type: "string",
                description:
                  'the observable condition that proves it, e.g. "probe_app returns rows on /api/v1/support_requests carrying all six fields"',
              },
            },
            required: ["title", "doneWhen"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "add_to_backlog",
    description:
      "Record something worth doing that is deliberately NOT in the plan you are about to propose — a follow-up, a known gap, a nice-to-have the user did not ask for. This is how scope stays honest: named and deferred beats silently dropped or silently built.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        why: { type: "string", description: "one line — why it matters and why it is not in this plan" },
      },
      required: ["title", "why"],
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

/**
 * Cost control: the tool block is re-read on EVERY round of a turn, and it is
 * by far the largest thing in the prefix (measured 2026-08-01: 38,123 tokens
 * of schema against a 5,043-token system prompt — `define_collection` alone
 * is 10,165 of it). Sending the authoring surface to a turn that is only
 * restyling a page is the single most wasteful thing the loop does.
 *
 * So the surface is scoped to what the router already decided the turn is.
 * Anything not clearly a frontend-only change routes to "build" and gets
 * everything, so scoping can cost capability only when the router is wrong —
 * and the router is deliberately biased toward "build".
 */

/** Read-only: enough to answer a question about the app without changing it. */
const QUESTION_TOOLS = new Set([
  "list_app_files", "read_app_file",
  "list_collections", "describe_collection", "query_entries", "count_entries", "get_deliveries",
]);

/** Frontend-only work: files, look, and reading the data the UI renders. */
const EDIT_TOOLS = new Set([
  ...QUESTION_TOOLS,
  "write_app_file", "edit_app_file", "delete_app_file", "set_app_theme", "set_app_meta",
  "probe_app", "get_changes", "send_feedback",
]);

/**
 * Builds legitimately need the authoring surface, so scoping cannot help them.
 * Instead the everyday tools stay resident and the long tail is deferred:
 * Claude searches for what it needs and the schema is APPENDED, which leaves
 * the cached prefix intact rather than invalidating it.
 *
 * Resident = what a typical build touches every time (measured against eval
 * traces). Everything else — transactions, aggregates, CAS, schedules,
 * inbound mail, plugins, SEO, assets, trash, versions — is real capability
 * the agent reaches for occasionally and should not pay for constantly.
 */
const BUILD_RESIDENT = new Set([
  "list_collections", "describe_collection", "define_collection",
  "create_entry", "bulk_create_entries", "get_client_code",
  "mint_delivery_token", "probe_app",
  "write_app_file", "edit_app_file", "read_app_file", "list_app_files", "delete_app_file",
  "set_app_theme", "set_app_meta", "send_feedback",
]);

/**
 * Anthropic's server-side tool-search tool. Server tools carry ONLY `type` and
 * `name` — adding a description or input_schema is rejected. It must never be
 * deferred itself, and at least one ordinary tool must stay resident too.
 */
const TOOL_SEARCH = { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" };

/**
 * Planning is deliberately read-only plus the two plan verbs. The agent gets
 * enough to orient — collections, files, plugins, connectors, schedules — and
 * literally cannot build anything before the user has seen the plan.
 */
const PLAN_TOOLS = new Set([
  ...QUESTION_TOOLS,
  "list_plugins", "get_plugin", "list_connectors", "list_schedules", "list_field_types",
  "propose_plan", "add_to_backlog",
]);

export type ToolScope = "question" | "edit" | "build" | "plan";

/** Narrow a session's tools to the turn's scope. */
export function scopeTools(tools: AnthropicTool[], scope: ToolScope): AnthropicTool[] {
  if (scope !== "build") {
    const keep = scope === "question" ? QUESTION_TOOLS : scope === "plan" ? PLAN_TOOLS : EDIT_TOOLS;
    return tools.filter((t) => keep.has(t.name));
  }
  // Build: everything stays available, but only the everyday set is loaded.
  const scoped = tools.map((t) =>
    BUILD_RESIDENT.has(t.name) ? t : { ...t, defer_loading: true },
  );
  return [TOOL_SEARCH as unknown as AnthropicTool, ...scoped];
}

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

/**
 * The one path a file takes onto disk, whether it arrived whole
 * (write_app_file) or as a patch (edit_app_file): parse-check + API-lint,
 * then write, then transpile TS/JSX to a browser-ready sibling. Sharing it is
 * the point — an edit that skipped verification would be a hole in P0.2.
 */
async function landAppFile(
  slug: string,
  path: string,
  content: string,
  mcpToken: string,
  bctx: BuildContext,
  verb: "wrote" | "edited",
): Promise<ToolOutcome> {
  const v = await verifyAppFile(path, content, mcpToken, bctx);
  if (v.blockers.length) {
    return {
      result: {
        error:
          verb === "edited"
            ? "File NOT changed — the result would not parse. Check new_string, then retry."
            : "File NOT written — syntax errors. Fix them and resend the complete file.",
        problems: v.blockers,
      },
      isError: true,
      summary: `✗ ${path} — ${preview(v.blockers[0], 90)}`,
    };
  }
  const file = wsWrite(slug, path, content);
  const changed = [file.path];
  const extras: Record<string, unknown> = {};

  // .ts / .tsx / .jsx compile to a sibling .js right here, so the workspace
  // stays browser-ready and the preview never needs a build step.
  if (isTranspilable(path)) {
    const out = await transpileAppFile(path, content);
    const compiled = wsWrite(slug, out.path, out.code);
    changed.push(compiled.path);
    extras.compiledTo = compiled.path;
    // JSX output imports preact/jsx-runtime — make sure the runtime is
    // actually present rather than trusting the agent to remember it.
    if (/\.(tsx|jsx)$/i.test(path) && !wsExists(slug, VENDOR_PREACT_PATH)) {
      wsWrite(slug, VENDOR_PREACT_PATH, readVendoredPreact());
      changed.push(VENDOR_PREACT_PATH);
      extras.runtimeAdded = `${VENDOR_PREACT_PATH} — reference it with the import map in index.html (see the contract).`;
    }
  }

  const clean = v.findings.length === 0;
  return {
    result: {
      ok: clean,
      ...file,
      ...extras,
      ...(v.findings.length ? { apiLint: v.findings } : {}),
      ...(v.notes.length ? { api: v.notes } : {}),
    },
    isError: !clean,
    summary: clean
      ? `${verb} ${file.path}${extras.compiledTo ? ` → ${extras.compiledTo}` : ""} (${file.bytes} B)${v.notes.length ? " · api-lint ok" : ""}`
      : `${verb} ${file.path} — ${preview(v.findings[0], 90)}`,
    filesChanged: changed,
  };
}

/** Row-level writes — they take the same ~15s to show up on the delivery API. */
const ROW_WRITES = new Set([
  "create_entry", "bulk_create_entries", "update_entry", "update_entry_if", "delete_entry",
  "restore_entry", "restore_entry_version",
]);

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
      return landAppFile(slug, String(input.path), String(input.content), mcpToken, bctx, "wrote");
    }
    if (name === "edit_app_file") {
      const path = String(input.path);
      const oldStr = String(input.old_string ?? "");
      const newStr = String(input.new_string ?? "");
      if (!oldStr) {
        return {
          result: { error: "old_string is required and must not be empty. To create a file or replace it wholesale, use write_app_file." },
          isError: true,
          summary: `edit ${path}: empty old_string`,
        };
      }
      let current: string;
      try {
        current = wsRead(slug, path);
      } catch {
        return {
          result: { error: `No such file: ${path}. Use write_app_file to create it, or list_app_files to check the name.` },
          isError: true,
          summary: `edit ${path}: not found`,
        };
      }
      // split/length beats a global regex here: old_string is literal text and
      // may contain regex metacharacters.
      const hits = current.split(oldStr).length - 1;
      if (hits === 0) {
        return {
          result: { error: `old_string was not found in ${path}. It must match EXACTLY, including indentation and line breaks — read_app_file first if you are unsure.` },
          isError: true,
          summary: `edit ${path}: no match`,
        };
      }
      if (hits > 1) {
        return {
          result: { error: `old_string matches ${hits} times in ${path}. Include enough surrounding context to make it unique — the edit is refused rather than guessing which one you meant.` },
          isError: true,
          summary: `edit ${path}: ${hits} matches`,
        };
      }
      return landAppFile(slug, path, current.replace(oldStr, newStr), mcpToken, bctx, "edited");
    }
    if (name === "teardown_backend") {
      if (!input.confirm) {
        return {
          result: { error: "teardown_backend deletes every collection and all of its data, irreversibly. Confirm with the user first, then pass confirm:true. Pass dryRun:true to show them the plan." },
          isError: true,
          summary: "teardown_backend: confirm required",
        };
      }
      const rep = await teardownBackend(mcpToken, { dryRun: Boolean(input.dryRun) });
      if (!rep.dryRun) {
        bctx.collections.clear();
        for (const n of rep.deleted) bctx.converging.set(n, Date.now());
      }
      const ok = rep.remaining.length === 0;
      return {
        result: rep,
        isError: !ok,
        summary: rep.dryRun
          ? `teardown plan: ${rep.deleted.length} collection(s)`
          : ok
            ? `deleted ${rep.deleted.length} collection(s)${rep.brokeCycles.length ? ` · broke ${rep.brokeCycles.length} relation cycle(s)` : ""}`
            : `deleted ${rep.deleted.length} — ${rep.remaining.length} still standing`,
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
      // A probe fired inside Pluggie's ~15s delivery convergence window reports
      // a perfectly healthy schema as broken — and the agent then "fixes" code
      // that was never wrong. Wait it out once, for the slowest path, so the
      // answer below means something either way.
      const wait = Math.max(0, ...paths.map((p) => convergenceWait(collectionOf(p), bctx)));
      let converged: string | undefined;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
        converged = `Waited ${Math.ceil(wait / 1000)}s for a just-changed collection to reach the delivery layer. These results are POST-convergence: an empty or 404 answer here is real, not a timing artefact — do not add retries or sleeps to the app to work around it.`;
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
          ...(converged ? { convergence: converged } : {}),
          note: "fields = what the app actually receives after publicRead projection. Empty fields on a 200 = fix publicRead on the collection, never the client.",
        },
        isError: false,
        summary:
          (issues ? `probed ${probes.length} endpoint(s) — ${issues} issue(s) to read` : `probed ${probes.length} endpoint(s) — all healthy`) +
          (wait > 0 ? ` (after ${Math.ceil(wait / 1000)}s convergence wait)` : ""),
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
    if (name === "set_app_theme") {
      const applied = applyTheme(slug, String(input.theme));
      const theme = getTheme(applied.themeId)!;
      return {
        result: {
          ok: true,
          theme: theme.name,
          file: applied.file,
          note: "Link /css/theme.css first in <head> and style with the token names — never raw colours, or the next theme switch will miss them.",
        },
        isError: false,
        summary: `theme → ${theme.name}`,
        filesChanged: [applied.file],
      };
    }
    if (name === "propose_plan") {
      const raw = Array.isArray(input.tasks) ? input.tasks : [];
      const tasks = raw
        .map((t) => t as { title?: unknown; doneWhen?: unknown })
        .map((t) => ({ title: String(t.title ?? "").trim(), doneWhen: String(t.doneWhen ?? "").trim() }))
        .filter((t) => t.title);
      if (!tasks.length) {
        return {
          result: { error: "tasks must be a non-empty array of { title, doneWhen } objects." },
          isError: true,
          summary: "propose_plan: no tasks",
        };
      }
      if (tasks.length > 12) {
        return {
          result: { error: `${tasks.length} tasks is too many — a plan the user cannot read in one glance is not a plan. Merge related work into at most 12.` },
          isError: true,
          summary: `propose_plan: ${tasks.length} tasks (max 12)`,
        };
      }
      const missing = tasks.filter((t) => !t.doneWhen).length;
      if (missing) {
        return {
          result: { error: `${missing} task(s) have no doneWhen. Every task needs an observable finish condition — it is what the task is checked against before it can be called done.` },
          isError: true,
          summary: "propose_plan: missing doneWhen",
        };
      }
      return {
        result: {
          ok: true,
          tasks,
          note: "Plan captured and shown to the user. STOP HERE — do not begin building. Execution starts only once they approve it.",
        },
        isError: false,
        summary: `planned ${tasks.length} task(s)`,
      };
    }
    if (name === "add_to_backlog") {
      const title = String(input.title ?? "").trim();
      if (!title) return { result: { error: "title is required" }, isError: true, summary: "add_to_backlog: no title" };
      const state = loadPlanState(slug);
      const item = newBacklogItem(title, String(input.why ?? "").trim());
      state.backlog.push(item);
      savePlanState(slug, state);
      return { result: { ok: true, id: item.id }, isError: false, summary: `backlog + ${preview(item.title, 60)}` };
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

    // Two define_collection misfires that have each cost a whole session. Both
    // are answered here, on the FIRST call, rather than letting the model
    // theorize its way through twenty identical rejections.
    if (name === "define_collection") {
      const shapeless = input.fields === undefined || (Array.isArray(input.fields) && input.fields.length === 0);
      if (shapeless && input.addFields === undefined && input.confirm) {
        return {
          result: {
            error:
              "define_collection replaces a collection's shape — it does not delete one. To remove a single collection use delete_collection { name, confirm: true }. To wipe every collection (it works out the relation order and breaks cycles for you) use teardown_backend { confirm: true }.",
          },
          isError: true,
          summary: "define_collection used as a delete → point at delete_collection",
        };
      }
      if (typeof input.fields === "string" || typeof input.addFields === "string") {
        return {
          result: {
            error:
              'fields must be a JSON ARRAY of field objects, but arrived as a string. Re-send this one call with the value typed as a real array — [{"name":"title","type":"text"}] — not as a quoted JSON blob. Nothing is wrong with the tool or the platform: other calls in this session used arrays successfully, so this is a formatting slip in this call alone.',
          },
          isError: true,
          summary: "define_collection: fields arrived as a string, not an array",
        };
      }
      // Full-replace means an omitted workflow or access rule is a SILENT
      // deletion. Removing a constraint to make its error go away is the most
      // expensive habit available here — it converts a loud failure into a
      // quiet one. Same shape as Pluggie's own confirm gate for field removal.
      if (Array.isArray(input.fields) && !input.confirm) {
        const drift = await collectionDrift(String(input.name), input, mcpToken);
        if (drift) {
          return {
            result: {
              error: `This would REMOVE ${drift.lost.join(" and ")} from ${input.name}. define_collection is full-replace, so anything you leave out is deleted — describe_collection, merge your change into the whole shape, and re-send it.`,
              wouldRemove: drift.lost,
              ...(drift.dependents.length ? { breaks: drift.dependents } : {}),
              ifIntended: "Re-send with confirm:true, and tell the user what stopped working and why.",
            },
            isError: true,
            summary: `define_collection would drop ${drift.lost.join(" + ")} — blocked`,
          };
        }
      }
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
    // Nothing reaches the delivery layer instantly (~15s). Record WHEN, so a
    // read inside that window waits instead of reporting a false empty — this
    // covers rows as well as schema, which is the case that had the agent
    // sprinkling its own setTimeouts into shipped app code.
    if (name === "define_collection" || name === "delete_collection") {
      bctx.collections.delete(String(input.name)); // API-lint must re-describe it
      bctx.converging.set(String(input.name), Date.now());
    } else if (ROW_WRITES.has(name) && typeof input.collection === "string") {
      bctx.converging.set(input.collection, Date.now());
    }
    // A transition schedule against a collection that no longer has a workflow
    // runs every night and matches nothing. Say so at the moment it becomes
    // true, rather than leaving it to be discovered weeks later — or never.
    if (name === "define_collection" || name === "define_schedule") {
      const target = String(input.name ?? input.collection ?? "");
      const dead = target ? await deadScheduleWarning(target, mcpToken) : undefined;
      if (dead) {
        return {
          result: { ...(result as object), warning: dead },
          isError: true,
          summary: `${summarize(name, input, result)} · dead schedule`,
        };
      }
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
  let envelope: string | undefined;
  let arr: unknown[] | undefined;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object") {
    for (const k of ["items", "entries", "data", "results"]) {
      const v = (parsed as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        arr = v;
        envelope = k;
        break;
      }
    }
  }
  if (arr) {
    out.count = arr.length;
    // The shape the CLIENT must destructure. A 200 with the right fields still
    // breaks the app if the code does `rows.map(...)` on a wrapper object —
    // that exact mismatch shipped a queue app where every probe said "healthy"
    // and the admin dashboard crashed on load. State it, don't imply it.
    out.responseShape = envelope
      ? `{"${envelope}":[…]} — a WRAPPER OBJECT, not a bare array. Client code must read res.${envelope} before mapping/filtering/.length. Treating this response as an array is a crash (.map is not a function) or a silent undefined.`
      : "a bare JSON array — map/filter it directly.";
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
