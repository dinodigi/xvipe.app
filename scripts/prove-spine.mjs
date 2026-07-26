#!/usr/bin/env node
/**
 * prove-spine.mjs — the six-call acceptance test from SETUP.md §4.
 *
 * Proves the XVibe ↔ Pluggie contract end-to-end over the exact transport the
 * builder agent will use: plain JSON-RPC 2.0 over HTTP POST (CONNECTION.md §2).
 * No SDK, no session, no imports from Pluggie.
 *
 *   1. tools/list            → ~60 tools
 *   2. get_project_info      → project name + urls.deliveryBase + briefing
 *   3. define_collection     → ok + convergence note      (toy: spine_check)
 *   4. create_entry          → an id back                 (idempotent re-runs)
 *   5. get_client_code       → DEFAULT_BASE_URL must be pluggie.app/api/v1
 *   6. mint_delivery_token   → verifyConnection() from the generated client
 *      + one real read back through the delivery API (allowing ~15s convergence)
 *
 * Run:  node scripts/prove-spine.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "scripts", "out");
mkdirSync(OUT, { recursive: true });

// ── tiny .env.local loader (no deps; process.env wins) ─────────────────────
function loadEnvFile(path) {
  const env = {};
  try {
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch { /* missing file → empty */ }
  return env;
}
const fileEnv = loadEnvFile(join(ROOT, ".env.local"));
const env = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

const MCP_URL = env("PLUGGIE_MCP_URL", "https://pluggie.app/api/mcp");
const DELIVERY_BASE = env("PLUGGIE_DELIVERY_BASE", "https://pluggie.app/api/v1");
const MCP_TOKEN = env("PLUGGIE_MCP_TOKEN");
const EXPECT_NAME = env("PLUGGIE_PROJECT_NAME");
const EXPECT_ID = env("PLUGGIE_PROJECT_ID");

const mask = (t) => (t ? `${String(t).slice(0, 8)}…(${String(t).length} chars)` : "(none)");

if (!MCP_TOKEN) {
  console.error("✗ PLUGGIE_MCP_TOKEN missing. Copy env.example → .env.local and fill it in (SETUP.md §3).");
  process.exit(1);
}

// ── the transport XVibe's builder agent will use (CONNECTION.md §2) ────────
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${MCP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`${method}: HTTP ${res.status}, non-JSON body: ${text.slice(0, 300)}`); }
  if (body.error) throw new Error(`${method}: JSON-RPC error ${JSON.stringify(body.error).slice(0, 500)}`);
  return body;
}

async function callTool(name, args) {
  const body = await rpc("tools/call", { name, arguments: args });
  const text = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) throw new Error(`${name} → ${text.slice(0, 800)}`);
  try { return JSON.parse(text); } catch { return text; } // tools return JSON as text
}

// ── reporting ───────────────────────────────────────────────────────────────
const results = [];
function pass(step, note) { results.push({ step, ok: true, note }); console.log(`  ✓ ${step} — ${note}`); }
function fail(step, note) { results.push({ step, ok: false, note }); console.error(`  ✗ ${step} — ${note}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\nXVibe spine proof — ${MCP_URL}`);
console.log(`token ${mask(MCP_TOKEN)} · expecting project "${EXPECT_NAME ?? "?"}" (${EXPECT_ID ?? "?"})\n`);

try {
  // 1 ─ tools/list ──────────────────────────────────────────────────────────
  const listed = await rpc("tools/list", {});
  const tools = listed.result?.tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  if (tools.length >= 50 && names.has("send_feedback") && names.has("define_collection")) {
    pass("1 tools/list", `${tools.length} tools (send_feedback + define_collection present)`);
  } else {
    fail("1 tools/list", `${tools.length} tools — expected ~60 incl. send_feedback/define_collection`);
  }

  // 2 ─ get_project_info ────────────────────────────────────────────────────
  const info = await callTool("get_project_info", {});
  const projName = info?.project?.name ?? info?.name ?? "(unknown)";
  // the project id isn't a top-level field — it's the tail of urls.admin
  const projId = info?.urls?.admin?.match(/\/admin\/([0-9a-f-]{36})/)?.[1] ?? "(unknown)";
  const deliveryBase = info?.urls?.deliveryBase ?? info?.project?.urls?.deliveryBase;
  const briefing = info?.briefing;
  writeFileSync(join(OUT, "project-info.json"), JSON.stringify(info, null, 2));
  let n2 = `name="${projName}" id=${projId} deliveryBase=${deliveryBase ?? "(missing)"} briefing=${briefing ? "present" : "MISSING"}`;
  if (EXPECT_NAME && projName !== EXPECT_NAME) n2 += ` ⚠ name ≠ expected "${EXPECT_NAME}"`;
  if (EXPECT_ID && projId !== EXPECT_ID) n2 += ` ⚠ id ≠ expected ${EXPECT_ID}`;
  if (deliveryBase && briefing !== undefined) pass("2 get_project_info", n2);
  else fail("2 get_project_info", n2);
  if (briefing?.notices?.length) console.log(`    briefing.notices: ${JSON.stringify(briefing.notices).slice(0, 400)}`);

  // 3 ─ define_collection (toy) ─────────────────────────────────────────────
  // publicRead on fields so step 6 gets the STRONG verifyConnection pass
  // (a public collection to exercise the delivery token against).
  const defined = await callTool("define_collection", {
    name: "spine_check",
    displayName: "Spine check",
    fields: [
      { name: "title", label: "Title", type: "text", required: true, publicRead: true },
      { name: "note", label: "Note", type: "text", publicRead: true },
    ],
  });
  const convergence = defined?.convergence ?? defined?.result?.convergence;
  if (defined?.ok === true || defined?.collection || convergence) {
    pass("3 define_collection", `ok · convergence: ${JSON.stringify(convergence ?? "(none reported)").slice(0, 200)}`);
  } else {
    fail("3 define_collection", JSON.stringify(defined).slice(0, 300));
  }

  // 4 ─ create_entry ────────────────────────────────────────────────────────
  const created = await callTool("create_entry", {
    collection: "spine_check",
    data: { title: "hello from xvibe", note: "six-call acceptance test (SETUP.md §4)" },
    idempotencyKey: "xvibe-spine-proof-1", // re-runs return the original row
  });
  const entryId = created?.id ?? created?.entry?.id;
  if (entryId) pass("4 create_entry", `id=${entryId}`);
  else fail("4 create_entry", JSON.stringify(created).slice(0, 300));

  // 5 ─ get_client_code ─────────────────────────────────────────────────────
  const clientRes = await callTool("get_client_code", {});
  const code = typeof clientRes === "string" ? clientRes : clientRes?.code ?? clientRes?.content ?? "";
  const clientPath = join(OUT, "agentx-client.ts");
  writeFileSync(clientPath, code);
  const baseMatch = code.match(/DEFAULT_BASE_URL\s*=\s*["'`]([^"'`]+)["'`]/);
  const baseUrl = baseMatch?.[1];
  if (baseUrl === "https://pluggie.app/api/v1") {
    pass("5 get_client_code", `${code.length} chars TS · DEFAULT_BASE_URL=${baseUrl}`);
  } else {
    // SETUP.md §4: anything other than pluggie.app here means a proxy poisoned
    // the base URL — stop and report (cost a field agent three sessions).
    fail("5 get_client_code", `DEFAULT_BASE_URL=${baseUrl ?? "(not found)"} — expected https://pluggie.app/api/v1. STOP AND REPORT.`);
  }

  // 6 ─ mint_delivery_token → verifyConnection() ────────────────────────────
  // Reuse a previously minted token if we have one (cap: 25 live/project).
  const tokenFile = join(OUT, "delivery-token.local.json");
  let deliveryToken, tokenNote;
  if (existsSync(tokenFile)) {
    deliveryToken = JSON.parse(readFileSync(tokenFile, "utf8")).token;
    tokenNote = "reused from scripts/out (gitignored)";
  } else {
    const minted = await callTool("mint_delivery_token", { label: "xvibe spine proof" });
    deliveryToken = minted?.token ?? minted?.value;
    tokenNote = `minted on project "${minted?.project?.name ?? minted?.projectName ?? "?"}"`;
    if (!deliveryToken) throw new Error(`mint_delivery_token returned no token: ${JSON.stringify(minted).slice(0, 300)}`);
    writeFileSync(tokenFile, JSON.stringify({ token: deliveryToken, label: "xvibe spine proof", mintedAt: new Date().toISOString() }, null, 2));
  }
  console.log(`    delivery token ${mask(deliveryToken)} — ${tokenNote}`);

  let verified = false;
  try {
    // Node ≥23.6 strips types natively — run the generated client verbatim.
    const mod = await import(pathToFileURL(clientPath).href);
    const createClient = mod.createClient ?? mod.default?.createClient ?? mod.default;
    const ax = createClient({ token: deliveryToken, baseUrl: DELIVERY_BASE });
    const verdict = await ax.verifyConnection();
    const verdictText = typeof verdict === "string" ? verdict : JSON.stringify(verdict);
    verified = true;
    pass("6 verifyConnection()", verdictText.slice(0, 300));
  } catch (e) {
    console.log(`    (generated client not runnable directly: ${String(e.message).slice(0, 160)})`);
    console.log("    falling back to the documented curl-equivalents…");
    const health = await fetch(`${DELIVERY_BASE}/_health`);
    const authed = await fetch(`${DELIVERY_BASE}/spine_check`, {
      headers: { authorization: `Bearer ${deliveryToken}` },
    });
    if (health.ok && authed.ok) {
      verified = true;
      pass("6 verifyConnection (manual)", `_health ${health.status} · authed read ${authed.status}`);
    } else {
      fail("6 verifyConnection (manual)", `_health ${health.status} · authed read ${authed.status}`);
    }
  }

  // 6b ─ one real read back through the delivery API (CONNECTION.md §11.6).
  // The delivery plane converges within ~15s of the MCP write — poll politely.
  if (verified && entryId) {
    let found = false, lastStatus = "";
    for (let attempt = 0; attempt < 8 && !found; attempt++) {
      if (attempt > 0) await sleep(3000);
      const res = await fetch(`${DELIVERY_BASE}/spine_check`, {
        headers: { authorization: `Bearer ${deliveryToken}` },
      });
      lastStatus = String(res.status);
      if (!res.ok) continue;
      const body = await res.json();
      const rows = body?.items ?? body?.entries ?? body?.data ?? (Array.isArray(body) ? body : []);
      found = rows.some?.((r) => r.id === entryId || r?.title === "hello from xvibe");
    }
    if (found) pass("6b delivery read-back", `entry ${entryId} visible on ${DELIVERY_BASE}/spine_check`);
    else fail("6b delivery read-back", `entry not visible after ~21s (last status ${lastStatus}) — exceeds the documented ~15s convergence`);
  }
} catch (e) {
  fail("aborted", String(e.message ?? e).slice(0, 800));
}

// ── verdict ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "✅ ALL SIX PASS — the spine is good. Build the IDE against it." : `❌ ${failed.length} step(s) failed:`}`);
for (const f of failed) console.log(`   · ${f.step}: ${f.note}`);
process.exit(failed.length === 0 ? 0 : 1);
