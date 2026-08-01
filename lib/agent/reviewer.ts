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
import { extractCollectionRefs } from "@/lib/agent/verify";
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

/**
 * Hedged "findings" are the reviewer's failure mode on a clean build: it
 * reaches for something to say and files a question or a self-answering
 * observation. Prompting alone did not stop it, so the shapes below are
 * dropped mechanically — a finding must assert a defect, not ask about one.
 */
const HEDGE =
  /\b(?:no change (?:is )?needed|not a violation|no violation|this is (?:fine|correct|acceptable|honest)|if (?:the intent|this is intended|it is intended)|verify (?:that|whether|these|this)|confirm (?:that|whether|these|this)|could be clearer|consider (?:adding|using|renaming)|may(?: want to)? (?:wish|want) to|for (?:audit|future) (?:transparency|access))\b/i;

const REVIEW_SYSTEM = `You are XVibe's fresh-eyes reviewer. You did NOT build this app — audit its FINAL state against the platform contract. Be strict about real violations, silent about style and taste. Every finding must be concrete and actionable in ≤2 sentences. Maximum ${MAX_FINDINGS} findings; if the app is sound, verdict "pass" with zero findings.

The contract you enforce:
1. STATIC ONLY. The shipped app is browser files — any server code (require(), module.exports, process.env, app.listen, express/node imports, "npm run" instructions) is a violation. There is no build step and no server.
2. NO CREDENTIALS IN THE BUNDLE. No agx_/sk_/pk-secret tokens, no Authorization headers with literal tokens (the serving edge injects the project token). The ONLY sanctioned browser credential flow is Clerk: the issuer-hosted clerk-js script + per-request X-User-Token JWT.
3. NO CREDENTIAL COLLECTIONS. Collections must never hold passwords, sessions, reset tokens, or API keys. Profile data keyed by Clerk user id is fine.
4. PROJECTION TRUTH — READS ONLY. This rule is about data the app GETs and displays. A form <input> that COLLECTS a value to POST is not a read: a lead/contact/booking form whose collection has zero publicRead fields is CORRECT, and "the app should not render fields the backend cannot surface" is a misreading of this rule — never write it. Only when the app fetches rows and displays their values: every field the UI RENDERS from /api/v1/<collection> must exist in that collection with publicRead:true (publicRead is the field filter for EVERYONE; access gates rows, not fields). Direction matters: rendered-but-not-publicRead is the bug. A field that exists with publicRead:false and is NOT rendered is correct and deliberate — never flag it, and never ask for a field to be removed. A collection with no publicRead fields at all is fine when the app only writes to it (a lead form nobody reads back); delivery answers 404 on GET for that, by design.
4a. publicWrite and access.write COMPOSE — they are not a contradiction. publicWrite:true opens anonymous POST (new rows); access.write gates edits/deletes of existing rows. "publicWrite:true with access.write authenticated/owner/none" is the correct shape for "anyone submits, staff triage". Never report that pairing as a bug.
5. RULES LIVE SERVER-SIDE. Client-only enforcement of a BUSINESS rule — who may see or do something, capacity limits, no-double-booking, pricing, state transitions — with no matching constraint/workflow/access rule in the schema is a violation; the browser is a suggestion, Pluggie is the law. Input-format checks are NOT business rules: an email regex, a maxlength, a "required" attribute or a friendly inline error in the browser is ordinary UX and never a violation on its own, whether or not the schema mirrors it.
6. HONESTY. If the UI promises what the PLATFORM cannot do (SMS, subscriptions, third-party API calls, per-slot capacity >1), it must say so honestly or not promise it — flag silent fakes, not honest "coming soon" copy. Ordinary business claims a human fulfils ("we usually call back within the hour", "free quotes", opening times) are marketing copy, not platform capabilities — never flag those.
7. NO EXTERNAL CDNs for core function (fonts/decoration tolerable; app logic never) — exception: the project's own Clerk issuer script.
8. BASIC ACCESS: form inputs need labels; interactive controls must be keyboard-reachable. Flag only flagrant failures.

Judge only what you can see in the dossier. If a schedule/workflow the copy promises is absent from the live schema section, that IS visible — flag it.

Do not speculate. If a collection's schema is missing from the dossier you cannot judge its fields — raise that as ONE finding, not one per field. Do not invent requirements the user never asked for: "required" plus a sensible field type is enough validation; pattern/format rules, matching the client regex to the server's, extra indexes and defensive normalisation are not violations. A finding you cannot point at evidence for is worse than no finding — it costs a repair round and teaches the builder to distrust you.

Before you file: every entry in "findings" must be a defect you would block a release for, stated as the defect. If your own reasoning ends in "this is fine", "no violation", "acceptable", or "could be clearer", it is NOT a finding — drop it. Suggestions, polish, and observations do not belong in the list. Zero findings with verdict "pass" is the expected result for a competent build, not a failure on your part.`;

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

/**
 * A complete, compact rendering of one collection. Raw describe_collection
 * JSON is verbose enough that clipping it truncates the field array — and a
 * reviewer that sees half a schema invents findings about the other half
 * (observed: it "found" a missing publicRead on a field that had one).
 * Everything the checklist needs is here, and it always fits.
 */
function summarizeCollection(name: string, desc: Record<string, unknown>): string {
  const c = ((desc.collection as Record<string, unknown>) ?? desc) as Record<string, unknown>;
  const fields = Array.isArray(c.fields) ? (c.fields as Record<string, unknown>[]) : [];
  const lines = fields.map((f) => {
    const flags: string[] = [];
    if (f.publicRead === true) flags.push("publicRead");
    else flags.push("NOT publicRead");
    if (f.required) flags.push("required");
    if (f.unique) flags.push("unique");
    if (f.min !== undefined) flags.push(`min:${String(f.min)}`);
    if (f.max !== undefined) flags.push(`max:${String(f.max)}`);
    if (f.pattern) flags.push("pattern");
    if (f.computed) flags.push(`computed ${JSON.stringify(f.computed).slice(0, 80)}`);
    if (Array.isArray(f.options) && f.options.length) flags.push(`options:${f.options.slice(0, 8).join("/")}`);
    return `  - ${String(f.name)} (${String(f.type ?? "?")}) [${flags.join(", ")}]`;
  });

  const wf = c.workflow as Record<string, unknown> | undefined;
  let workflow = "none";
  if (wf && Object.keys(wf).length) {
    const states = Array.isArray(wf.states) ? wf.states.map((s) => (typeof s === "string" ? s : String((s as Record<string, unknown>).name))) : [];
    const transitions = Array.isArray(wf.transitions)
      ? (wf.transitions as Record<string, unknown>[]).map(
          (t) => `${String(t.from ?? "?")}→${String(t.to ?? "?")}(actors: ${Array.isArray(t.actors) ? t.actors.join("|") : "unset"})`,
        )
      : [];
    workflow = `states: ${states.join(", ") || "?"}\n    transitions: ${transitions.join("; ") || "?"}`;
  }

  const events = c.events ? JSON.stringify(c.events).slice(0, 600) : "none";
  return [
    `\n### ${name}`,
    `  publicWrite: ${String(c.publicWrite ?? false)} · access: ${JSON.stringify(c.access ?? {})}`,
    `  fields (${fields.length}):`,
    ...lines,
    `  workflow: ${workflow}`,
    `  events: ${events}`,
  ].join("\n");
}

/** Assemble the dossier: final files + the live schema they depend on. */
async function buildDossier(slug: string, appName: string, mcpToken: string, info: ProjectInfo): Promise<string> {
  const parts: string[] = [`# App under review: ${appName} (slug: ${slug})`];
  let budget = MAX_TOTAL_CHARS;
  const referenced = new Set<string>();

  const files = wsList(slug).filter((f) => REVIEWABLE.has(f.path.split(".").pop()?.toLowerCase() ?? ""));
  parts.push(`\n## Files (${files.length})`);
  // Read everything and collect collection references FIRST: the clipping
  // loop below can exhaust its budget, and a schema section that silently
  // went missing is how the reviewer once failed a perfectly good build.
  const contents = new Map<string, string>();
  for (const f of files) {
    try {
      const content = wsRead(slug, f.path);
      contents.set(f.path, content);
      const refs = extractCollectionRefs(content);
      for (const name of [...refs.certain, ...refs.candidates]) referenced.add(name);
    } catch {
      /* unreadable file — nothing to review */
    }
  }

  for (const f of files) {
    if (budget <= 0) {
      parts.push(`\n(…file budget reached — remaining files omitted)`);
      break;
    }
    const content = contents.get(f.path);
    if (content === undefined) continue;
    const clipped = content.slice(0, Math.min(MAX_FILE_CHARS, budget));
    budget -= clipped.length;
    parts.push(`\n### ${f.path} (${f.bytes} B${clipped.length < content.length ? ", clipped" : ""})\n\`\`\`\n${clipped}\n\`\`\``);
  }

  parts.push(`\n## Live schema for referenced collections`);
  if (referenced.size === 0) parts.push(`(the app references no /api/v1 collections)`);
  for (const name of [...referenced].slice(0, 8)) {
    try {
      const desc = await callTool<Record<string, unknown>>("describe_collection", { name }, mcpToken);
      parts.push(summarizeCollection(name, desc));
    } catch (e) {
      parts.push(
        `\n### ${name}\nDESCRIBE FAILED: ${e instanceof Error ? e.message : String(e)}\n(if the app fetches a LITERAL /api/v1/${name} this is a real finding; if the name was inferred from a string-built URL it may simply not be a collection — do not report it in that case)`,
      );
    }
  }

  // Only THIS app's schedules. The project is shared, and dumping every
  // schedule made the reviewer demand schemas for other apps' collections.
  try {
    const raw = await callTool<unknown>("list_schedules", {}, mcpToken);
    const all = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.schedules as unknown[]) ?? [];
    const mine = all.filter((s) => [...referenced].some((name) => JSON.stringify(s).includes(name)));
    parts.push(
      `\n## Schedules touching this app's collections\n${mine.length ? JSON.stringify(mine).slice(0, 1500) : "(none — if the app promises a recurring job, that is a finding)"}`,
    );
  } catch {
    parts.push(`\n## Schedules touching this app's collections\n(unavailable — do not judge scheduling either way)`);
  }

  parts.push(
    `\n## Environment\n- End-user auth (Clerk): ${info.endUserAuth?.configured ? `configured, issuer ${info.endUserAuth.issuer}` : "NOT configured — any sign-in UI in the app is a violation"}`,
    `- This is a SHARED project: collections belonging to other apps exist and are none of your business. Judge only the app above and the collections listed here.`,
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
    .filter((f) => f.length > 20 && !HEDGE.test(f))
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
