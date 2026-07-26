#!/usr/bin/env node
/**
 * mcp-call.mjs — ad-hoc Pluggie MCP tool call from the shell.
 *
 *   node scripts/mcp-call.mjs get_project_info
 *   node scripts/mcp-call.mjs define_collection '{"name":"x","fields":[...]}'
 *   node scripts/mcp-call.mjs tools/list            (bare JSON-RPC method)
 *
 * Uses PLUGGIE_MCP_TOKEN / PLUGGIE_MCP_URL from .env.local. Prints the parsed
 * JSON result to stdout; exits 1 on isError with the error text on stderr.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
  } catch { /* empty */ }
  return env;
}
const fileEnv = loadEnvFile(join(ROOT, ".env.local"));
const env = (k, d) => process.env[k] ?? fileEnv[k] ?? d;
const MCP_URL = env("PLUGGIE_MCP_URL", "https://pluggie.app/api/mcp");
const TOKEN = env("PLUGGIE_MCP_TOKEN");
if (!TOKEN) { console.error("PLUGGIE_MCP_TOKEN missing (.env.local)"); process.exit(1); }

const [, , tool, argsJson] = process.argv;
if (!tool) { console.error("usage: node scripts/mcp-call.mjs <toolName|jsonrpc-method> [argsJson]"); process.exit(1); }
const args = argsJson ? JSON.parse(argsJson) : {};

const isBareMethod = tool.includes("/");
const payload = isBareMethod
  ? { jsonrpc: "2.0", id: 1, method: tool, params: args }
  : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } };

const res = await fetch(MCP_URL, {
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(payload),
});
const body = await res.json();
if (body.error) { console.error(JSON.stringify(body.error, null, 2)); process.exit(1); }
if (isBareMethod) { console.log(JSON.stringify(body.result, null, 2)); process.exit(0); }
const text = body.result?.content?.[0]?.text ?? "";
if (body.result?.isError) { console.error(text); process.exit(1); }
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
