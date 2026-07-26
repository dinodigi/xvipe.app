#!/usr/bin/env node
/**
 * check-boundary.mjs — mechanical enforcement of CONNECTION.md §6.
 *
 * XVibe is a CLIENT of Pluggie. These rules fail the build, not the review:
 *   1. No imports of Pluggie source or its internals (drizzle/neon/pg/clerk
 *      server pieces). HTTP/MCP only.
 *   2. No NEXT_PUBLIC_* names that smell like credentials (TOKEN/KEY/SECRET).
 *   3. PLUGGIE_MCP_TOKEN is read in exactly one place: lib/pluggie/token.ts
 *      (the swappable seam). Everything else must call getPluggieToken().
 *
 *   node scripts/check-boundary.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib", "components"];
const SCAN_FILES = ["middleware.ts", "next.config.ts"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"]);

const FORBIDDEN_IMPORTS = [
  // Pluggie/AgentX source as a PACKAGE or a path that leaves this repo.
  // (XVibe's own HTTP client lives at @/lib/pluggie — that IS the boundary.)
  { pattern: /from\s+["'](?:@?pluggie(?:\/[^"']*)?|@?agentx(?:\/[^"']*)?)["']/i, why: "imports Pluggie/AgentX source — the boundary is HTTP/MCP only (CONNECTION.md §6.1)" },
  { pattern: /from\s+["'](?:\.\.\/)*\.\.\/(?:[^"']*(?:pluggie|agentx)[^"']*)["']/i, why: "relative import reaching outside the XVibe repo toward Pluggie source (§6.1)" },
  { pattern: /from\s+["'](?:drizzle-orm|@neondatabase\/[^"']+|pg|postgres)["']/, why: "direct database access — every read/write goes through the API (§6.2)" },
  { pattern: /from\s+["']@clerk\/[^"']+["']/, why: "Pluggie's auth internals — XVibe talks to surfaces, not stacks" },
];

const violations = [];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", ".xvibe", "out", "docs"].includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) yield full;
  }
}

const files = [];
for (const dir of SCAN_DIRS) {
  try {
    files.push(...walk(join(ROOT, dir)));
  } catch {
    /* dir may not exist yet */
  }
}
for (const f of SCAN_FILES) {
  try {
    statSync(join(ROOT, f));
    files.push(join(ROOT, f));
  } catch {
    /* absent */
  }
}

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    for (const rule of FORBIDDEN_IMPORTS) {
      if (rule.pattern.test(line)) violations.push({ rel, line: i + 1, text: line.trim(), why: rule.why });
    }
    if (/NEXT_PUBLIC_[A-Z0-9_]*(TOKEN|SECRET|KEY)/.test(line)) {
      violations.push({ rel, line: i + 1, text: line.trim(), why: "a NEXT_PUBLIC_ credential ships to every visitor's browser" });
    }
    if (/process\.env\.PLUGGIE_MCP_TOKEN/.test(line) && rel !== "lib/pluggie/token.ts" && !rel.startsWith("scripts/")) {
      violations.push({ rel, line: i + 1, text: line.trim(), why: "the mcp token is read ONLY via getPluggieToken() in lib/pluggie/token.ts (the §3 seam)" });
    }
  });
}

if (violations.length) {
  console.error(`✗ boundary check failed — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(`  ${v.rel}:${v.line}  ${v.text}\n    → ${v.why}\n`);
  process.exit(1);
}
console.log(`✓ boundary intact — ${files.length} files scanned, HTTP/MCP only, token seam respected`);
