/**
 * evals/reset.mts — factory-reset the eval project (Pluggie OPS-6).
 *
 *   npm run evals:reset            # PLAN ONLY — prints what would be wiped
 *   npm run evals:reset -- --wipe  # actually does it (two-step on purpose)
 *
 * This exists because we asked for it: "one-call project reset (eval-harness
 * ergonomics)" went on the Pluggie feedback wall on 2026-07-30 and shipped as
 * `reset_project`. It replaces N delete_collection calls in dependency order.
 *
 * ⚠ It is NOT part of a normal sweep, and must never become one. `npm run
 * evals` already removes the apps and collections it creates; this wipes the
 * ENTIRE project — including anything the operator built there by hand (the
 * guestbook demo, the support-inbox test app). Unrecoverable: trash and
 * version history go too, and synced clients must treat it as a full resync.
 * Delivery tokens, connectors and the audit log survive.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const raw of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim();
}

const { callTool } = await import("@/lib/pluggie/mcp");
const TOKEN = process.env.PLUGGIE_MCP_TOKEN!;
const PROJECT = process.env.PLUGGIE_PROJECT_NAME ?? process.env.PLUGGIE_PROJECT_ID;
const wipe = process.argv.includes("--wipe");

// Always show what is there and what the platform plans to remove, wipe or not.
const collections = await callTool<unknown>("list_collections", {}, TOKEN);
const names = (Array.isArray(collections) ? collections : [])
  .map((c) => String((c as Record<string, unknown>)?.name ?? ""))
  .filter(Boolean);
console.log(`\nProject: ${PROJECT}\nCollections present (${names.length}): ${names.join(", ") || "none"}`);

const plan = await callTool<unknown>("reset_project", {}, TOKEN);
console.log(`\nReset plan (nothing has been changed):\n${JSON.stringify(plan, null, 2)}`);

if (!wipe) {
  console.log(
    `\nPlan only — nothing was wiped.\nRe-run with --wipe to execute. Everything above disappears permanently,\nincluding apps built by hand in this project.\n`,
  );
  process.exit(0);
}

console.log(`\n⚠ WIPING ${PROJECT} …`);
const result = await callTool<unknown>("reset_project", { confirm: true }, TOKEN);
console.log(JSON.stringify(result, null, 2));
console.log(
  `\nDone. Local app workspaces under .xvibe still reference collections that no\nlonger exist — delete the stale apps, or rebuild them, before the next sweep.\n`,
);
