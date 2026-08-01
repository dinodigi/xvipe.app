/**
 * lib/agent/reviewer.ts — the fresh-eyes review pass (P0.4, task #9).
 *
 * A separate, fresh-context agent audits the FINAL state of the app after a
 * build turn — it never sees the builder's conversation, so it has no tunnel
 * vision about what the builder meant to do. Read-only: its only tool is the
 * verdict itself (forced tool_choice), so it cannot "fix" anything — findings
 * go back to the builder for one repair round.
 *
 * Deliberately Haiku: the dossier is small and the checklist is concrete;
 * this costs ~$0.02/build and catches the drift class that shipped bugs.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/lib/agent/models";
import { API_REF } from "@/lib/agent/verify";
import { callTool, type ProjectInfo } from "@/lib/pluggie/mcp";
import { wsList, wsRead } from "@/lib/apps/store";

export interface ReviewResult {
  verdict: "pass" | "issues";
  findings: string[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

/** text files the reviewer reads (binaries carry no reviewable intent) */
const REVIEWABLE = new Set(["html", "css", "js", "mjs", "json", "svg", "txt", "md", "webmanifest"]);
const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 90_000;
const MAX_FINDINGS = 6;

const REVIEW_SYSTEM = `You are XVibe's fresh-eyes reviewer. You did NOT build this app — audit its FINAL state against the platform contract. Be strict about real violations, silent about style and taste. Every finding must be concrete and actionable in ≤2 sentences. Maximum ${MAX_FINDINGS} findings; if the app is sound, verdict "pass" with zero findings.

The contract you enforce:
1. STATIC ONLY. The shipped app is browser files — any server code (require(), module.exports, process.env, app.listen, express/node imports, "npm run" instructions) is a violation. There is no build step and no server.
2. NO CREDENTIALS IN THE BUNDLE. No agx_/sk_/pk-secret tokens, no Authorization headers with literal tokens (the serving edge injects the project token). The ONLY sanctioned browser credential flow is Clerk: the issuer-hosted clerk-js script + per-request X-User-Token JWT.
3. NO CREDENTIAL COLLECTIONS. Collections must never hold passwords, sessions, reset tokens, or API keys. Profile data keyed by Clerk user id is fine.
4. PROJECTION TRUTH. Every field the UI renders from /api/v1/<collection> must exist in that collection with publicRead:true (publicRead is the field filter for EVERYONE; access gates rows, not fields). Flag rendered fields that are missing or not publicRead.
5. RULES LIVE SERVER-SIDE. Client-only enforcement of a business rule (validation, gating, no-double-booking) with no matching constraint/workflow/access rule in the schema is a violation — the browser is a suggestion, Pluggie is the law.
6. HONESTY. If the UI promises what the platform cannot do (SMS, subscriptions, third-party API calls, per-slot capacity >1), it must say so honestly or not promise it — flag silent fakes, not honest "coming soon" copy.
7. NO EXTERNAL CDNs for core function (fonts/decoration tolerable; app logic never) — exception: the project's own Clerk issuer script.
8. BASIC ACCESS: form inputs need labels; interactive controls must be keyboard-reachable. Flag only flagrant failures.

Judge only what you can see in the dossier. If a schedule/workflow the copy promises is absent from the live schema section, that IS visible — flag it.`;

const REPORT_TOOL = {
  name: "report_review",
  description: "File the review verdict. This is the only action you have.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: { type: "string", enum: ["pass", "issues"] },
      findings: {
        type: "array",
        items: { type: "string" },
        description: `actionable findings, ≤2 sentences each, max ${MAX_FINDINGS}; empty when verdict is "pass"`,
      },
    },
    required: ["verdict", "findings"],
  },
};

/** Assemble the dossier: final files + the live schema they depend on. */
async function buildDossier(slug: string, appName: string, mcpToken: string, info: ProjectInfo): Promise<string> {
  const parts: string[] = [`# App under review: ${appName} (slug: ${slug})`];
  let budget = MAX_TOTAL_CHARS;
  const referenced = new Set<string>();

  const files = wsList(slug).filter((f) => REVIEWABLE.has(f.path.split(".").pop()?.toLowerCase() ?? ""));
  parts.push(`\n## Files (${files.length})`);
  for (const f of files) {
    if (budget <= 0) {
      parts.push(`\n(…file budget reached — remaining files omitted)`);
      break;
    }
    let content = "";
    try {
      content = wsRead(slug, f.path);
    } catch {
      continue;
    }
    for (const m of content.matchAll(API_REF)) referenced.add(m[1]);
    const clipped = content.slice(0, Math.min(MAX_FILE_CHARS, budget));
    budget -= clipped.length;
    parts.push(`\n### ${f.path} (${f.bytes} B${clipped.length < content.length ? ", clipped" : ""})\n\`\`\`\n${clipped}\n\`\`\``);
  }

  parts.push(`\n## Live schema for referenced collections`);
  if (referenced.size === 0) parts.push(`(the app references no /api/v1 collections)`);
  for (const name of [...referenced].slice(0, 8)) {
    try {
      const desc = await callTool<unknown>("describe_collection", { name }, mcpToken);
      parts.push(`\n### ${name}\n${JSON.stringify(desc).slice(0, 2500)}`);
    } catch (e) {
      parts.push(`\n### ${name}\nDESCRIBE FAILED: ${e instanceof Error ? e.message : String(e)} (if it does not exist, that is a finding)`);
    }
  }

  try {
    const schedules = await callTool<Record<string, unknown>>("list_schedules", {}, mcpToken);
    parts.push(`\n## Schedules live on the project\n${JSON.stringify(schedules).slice(0, 1500)}`);
  } catch {
    parts.push(`\n## Schedules live on the project\n(unavailable)`);
  }

  parts.push(
    `\n## Environment\n- End-user auth (Clerk): ${info.endUserAuth?.configured ? `configured, issuer ${info.endUserAuth.issuer}` : "NOT configured — any sign-in UI in the app is a violation"}`,
  );
  return parts.join("\n");
}

export async function reviewBuild(
  anthropic: Anthropic,
  slug: string,
  appName: string,
  mcpToken: string,
  info: ProjectInfo,
): Promise<ReviewResult> {
  const dossier = await buildDossier(slug, appName, mcpToken, info);
  const res = await anthropic.messages.create({
    model: MODELS.haiku,
    max_tokens: 1200,
    system: REVIEW_SYSTEM,
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: "report_review" },
    messages: [{ role: "user", content: dossier }],
  });
  const use = res.content.find((b) => b.type === "tool_use");
  const input = (use?.input ?? {}) as { verdict?: string; findings?: unknown[] };
  const findings = (Array.isArray(input.findings) ? input.findings : [])
    .map((f) => String(f).trim())
    .filter(Boolean)
    .slice(0, MAX_FINDINGS);
  return {
    verdict: input.verdict === "issues" && findings.length ? "issues" : "pass",
    findings: input.verdict === "issues" ? findings : [],
    usage: {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    },
  };
}
