/**
 * evals/run.mts — the eval harness runner (P0.5, task #14).
 *
 *   npm run evals                    # core suite (4 tasks)
 *   npm run evals -- --all           # every task
 *   npm run evals -- --tasks=guestbook,sms-honesty
 *   npm run evals -- --pin=sonnet    # force a tier instead of Auto routing
 *   npm run evals -- --keep          # leave apps + collections behind to inspect
 *
 * Each task runs through the REAL builder pipeline (router → builder →
 * verification → probe → reviewer), then mechanical assertions read the
 * shipped files, the live schema and real delivery responses. Nothing is
 * graded by a model except the reviewer verdict, which is itself an assertion.
 *
 * Costs real money — the estimate is printed per task and in the summary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/* .env.local by hand (tsx does not load it) */
for (const raw of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim();
}

const { TASKS, COMMON_ASSERTIONS } = await import("@/evals/tasks.mts");
type EvalContext = import("@/evals/tasks.mts").EvalContext;
type EvalTask = import("@/evals/tasks.mts").EvalTask;
type ProbeResult = import("@/evals/tasks.mts").ProbeResult;

const { runBuilder } = await import("@/lib/agent/builder");
const { reviewBuild } = await import("@/lib/agent/reviewer");
const { callTool, getProjectInfo, PluggieError } = await import("@/lib/pluggie/mcp");
const { extractCollectionRefs } = await import("@/lib/agent/verify");
const { DELIVERY_BASE } = await import("@/lib/pluggie/delivery");
const { createApp, deleteApp, getDeliveryToken, updateApp, wsList, wsRead } = await import("@/lib/apps/store");
const { removeDeliveryToken } = await import("@/lib/deploy/kv");
const AnthropicMod = await import("@anthropic-ai/sdk");

const TOKEN = process.env.PLUGGIE_MCP_TOKEN!;
const PROJECT_ID = process.env.PLUGGIE_PROJECT_ID!;
if (!TOKEN || !PROJECT_ID) throw new Error("PLUGGIE_MCP_TOKEN and PLUGGIE_PROJECT_ID must be set");

/* ── args ─────────────────────────────────────────────────────────────────── */
const ARGV = process.argv.slice(2);
const arg = (name: string) => ARGV.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name: string) => ARGV.includes(`--${name}`);
const only = arg("tasks")?.split(",").map((s) => s.trim()).filter(Boolean);
const pin = arg("pin");
/** --effort=low|medium|high|xhigh|max — the round-count lever, for A/Bs. */
const effort = arg("effort");
const keep = flag("keep");
const selected: EvalTask[] = only
  ? TASKS.filter((t) => only.includes(t.id))
  : flag("all")
    ? TASKS
    : TASKS.filter((t) => t.tier === "core");
if (!selected.length) {
  console.error(`No tasks matched. Known ids: ${TASKS.map((t) => t.id).join(", ")}`);
  process.exit(2);
}

/* Same table the studio quotes, so a sweep and the UI never disagree. */
const { estimateCostUsd } = await import("@/lib/agent/pricing");
const dollars = estimateCostUsd;

/* ── helpers ──────────────────────────────────────────────────────────────── */
const listCollectionNames = async (): Promise<string[]> => {
  const res = await callTool<unknown>("list_collections", {}, TOKEN);
  const arr = Array.isArray(res) ? res : ((res as Record<string, unknown>)?.collections as unknown[]) ?? [];
  return arr.map((c) => (typeof c === "string" ? c : String((c as Record<string, unknown>)?.name ?? ""))).filter(Boolean);
};

const probeFor = (slug: string) => async (path: string): Promise<ProbeResult> => {
  const token = getDeliveryToken(slug);
  if (!token) return { status: 0, fields: [] };
  const res = await fetch(`${DELIVERY_BASE()}${path.replace(/^\/api\/v1/, "")}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: res.status, fields: [], error: text.slice(0, 300) };
  }
  const error = (parsed as Record<string, unknown>)?.error;
  if (typeof error === "string") return { status: res.status, fields: [], error };
  const arr = Array.isArray(parsed)
    ? parsed
    : (["items", "entries", "data", "results"].map((k) => (parsed as Record<string, unknown>)?.[k]).find(Array.isArray) as unknown[] | undefined);
  if (!arr) return { status: res.status, fields: Object.keys((parsed as object) ?? {}) };
  const first = (arr[0] ?? {}) as Record<string, unknown>;
  const flat = first.data && typeof first.data === "object" ? { ...first, ...(first.data as Record<string, unknown>) } : first;
  return { status: res.status, count: arr.length, fields: Object.keys(flat) };
};

/** Delete collections created by an eval, dependents first (E_BLOCKED = retry). */
async function cleanupCollections(names: string[]): Promise<string[]> {
  let pending = [...names];
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    // Relations release across surfaces that converge (~15s), so a blocked
    // delete usually succeeds on the next pass — give it room.
    if (pass > 0) await new Promise((r) => setTimeout(r, 6000));
    const stillPending: string[] = [];
    for (const name of pending) {
      try {
        await callTool("delete_collection", { name, confirm: true }, TOKEN);
      } catch (e) {
        if (e instanceof PluggieError && e.code === "E_BLOCKED") stillPending.push(name);
        else stillPending.push(name);
      }
    }
    pending = stillPending;
  }
  return pending;
}

const TEXT_EXT = /\.(html|css|js|mjs|json|txt|md|svg|webmanifest)$/i;

/* ── run ──────────────────────────────────────────────────────────────────── */
interface TaskReport {
  id: string;
  passed: boolean;
  failures: { name: string; reason: string }[];
  checks: number;
  cost: number;
  model: string;
  rounds: number;
  seconds: number;
  error?: string;
  leftovers?: string[];
}

const anthropic = new AnthropicMod.default({ apiKey: process.env.ANTHROPIC_API_KEY!.trim() });
const info = await getProjectInfo(TOKEN);
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const reports: TaskReport[] = [];

console.log(`\n▸ XVibe eval sweep — ${selected.length} task(s)${pin ? ` · pinned ${pin}` : " · Auto routing"}${keep ? " · keeping artifacts" : ""}\n`);

for (const [i, task] of selected.entries()) {
  const started = Date.now();
  const app = createApp(PROJECT_ID, `ev ${task.id} ${stamp}`);
  if (pin) updateApp(app.slug, { modelPin: pin });
  if (effort) updateApp(app.slug, { effortPin: effort });
  console.log(`[${i + 1}/${selected.length}] ${task.id} → ${app.slug}`);

  const report: TaskReport = { id: task.id, passed: false, failures: [], checks: 0, cost: 0, model: "?", rounds: 0, seconds: 0 };
  let created: string[] = [];

  try {
    const before = await listCollectionNames();
    let finalText = "";
    const toolsCalled: string[] = [];

    for await (const ev of runBuilder(app.slug, task.prompt)) {
      if (ev.type === "text_delta") finalText += ev.text;
      else if (ev.type === "tool_start") toolsCalled.push(ev.name);
      else if (ev.type === "route") report.model = ev.model;
      else if (ev.type === "turn_done" && ev.usage) {
        report.cost = dollars(ev.usage);
        report.rounds = ev.usage.rounds;
        report.model = ev.usage.model;
      } else if (ev.type === "error") report.error = ev.message;
    }
    // A billing/auth failure makes every remaining task a false negative —
    // stop the sweep instead of reporting a wall of bogus regressions.
    if (report.error && /credit balance|invalid_request_error|authentication_error|401/i.test(report.error)) {
      console.log(`\n⚠ Sweep aborted — the Anthropic account cannot run builds:\n  ${report.error.slice(0, 200)}\n`);
      reports.push({ ...report, seconds: Math.round((Date.now() - started) / 1000) });
      if (!keep) {
        await cleanupCollections(created);
        await removeDeliveryToken(app.slug);
        try {
          deleteApp(app.slug);
        } catch {
          /* best effort */
        }
      }
      break;
    }

    const after = await listCollectionNames();
    created = after.filter((c) => !before.includes(c));

    /* dossier for the assertions */
    const files = wsList(app.slug);
    const readCache = new Map<string, string>();
    const read = (path: string): string => {
      if (!readCache.has(path)) {
        try {
          readCache.set(path, wsRead(app.slug, path));
        } catch {
          readCache.set(path, "");
        }
      }
      return readCache.get(path)!;
    };
    const allText = files.filter((f) => TEXT_EXT.test(f.path)).map((f) => read(f.path)).join("\n");

    const refs = extractCollectionRefs(allText);
    const referenced = [...refs.certain, ...refs.candidates];
    // What the app USES — the sandbox is shared, so a task whose collection
    // already existed creates nothing. Cleanup still only touches `created`.
    const appCollections = [...new Set([...created, ...referenced.filter((r) => after.includes(r))])];
    const collections = new Map<string, Record<string, unknown>>();
    for (const name of after) collections.set(name, {});
    for (const name of appCollections) {
      try {
        collections.set(name, await callTool<Record<string, unknown>>("describe_collection", { name }, TOKEN));
      } catch {
        /* leave the empty marker — existence is what the common assertion checks */
      }
    }
    let schedules: unknown = [];
    try {
      schedules = await callTool("list_schedules", {}, TOKEN);
    } catch {
      /* non-fatal */
    }

    // Fresh review of the FINAL state (the in-loop one may predate a repair round).
    let reviewPassed = true;
    try {
      const rev = await reviewBuild(anthropic, app.slug, app.name, TOKEN, info);
      reviewPassed = rev.verdict === "pass";
      report.cost += dollars({ model: "claude-haiku-4-5", ...rev.usage });
      if (!reviewPassed) report.failures.push({ name: "fresh-eyes review", reason: rev.findings.join(" | ") });
    } catch {
      /* reviewer plumbing must not fail a task on its own */
    }

    const ctx: EvalContext = {
      slug: app.slug,
      files,
      read,
      allText,
      collections,
      created,
      appCollections,
      schedules: Array.isArray(schedules) ? schedules : [schedules],
      finalText,
      toolsCalled,
      reviewPassed,
      probe: probeFor(app.slug),
    };

    const assertions = [...COMMON_ASSERTIONS.filter((a) => a.name !== "fresh-eyes review passed"), ...task.assertions];
    report.checks = assertions.length + 1;
    for (const a of assertions) {
      try {
        const reason = await a.run(ctx);
        if (reason) report.failures.push({ name: a.name, reason });
      } catch (e) {
        report.failures.push({ name: a.name, reason: `assertion threw: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    report.passed = report.failures.length === 0 && !report.error;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
  }

  report.seconds = Math.round((Date.now() - started) / 1000);
  if (!keep) {
    const leftovers = await cleanupCollections(created);
    if (leftovers.length) report.leftovers = leftovers;
    // A build that minted a token also mirrored it to the edge — drop that
    // too, or every sweep leaves a live credential for a deleted app in KV.
    await removeDeliveryToken(app.slug);
    try {
      deleteApp(app.slug);
    } catch {
      /* best effort */
    }
  }

  const mark = report.passed ? "✓ PASS" : "✗ FAIL";
  console.log(
    `        ${mark} · ${report.checks - report.failures.length}/${report.checks} checks · ${report.model.replace("claude-", "")} · ${report.rounds} rounds · ${report.seconds}s · ~$${report.cost.toFixed(2)}`,
  );
  for (const f of report.failures) console.log(`          ✗ ${f.name}: ${f.reason}`);
  if (report.error) console.log(`          ⚠ build error: ${report.error}`);
  if (report.leftovers?.length) console.log(`          ⚠ collections left behind: ${report.leftovers.join(", ")}`);
  reports.push(report);
}

/* ── summary ──────────────────────────────────────────────────────────────── */
const passed = reports.filter((r) => r.passed).length;
const totalCost = reports.reduce((s, r) => s + r.cost, 0);
console.log(`\n▸ ${passed}/${reports.length} tasks passed · ~$${totalCost.toFixed(2)} total\n`);
for (const r of reports) console.log(`  ${r.passed ? "✓" : "✗"} ${r.id.padEnd(24)} ${r.failures.length ? `${r.failures.length} failure(s)` : ""}`);

writeFileSync(
  resolve(process.cwd(), "evals/last-run.json"),
  JSON.stringify({ at: new Date().toISOString(), pin: pin ?? "auto", reports }, null, 2),
);
console.log(`\nreport → evals/last-run.json`);
process.exit(passed === reports.length ? 0 : 1);
