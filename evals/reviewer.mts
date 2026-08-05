/**
 * evals/reviewer.mts — precision of the fresh-eyes reviewer.
 *
 *   npm run evals:reviewer
 *
 * The reviewer's problem was never recall, it was precision: across five real
 * review rounds on the Brightpearl Dental build it filed 14 findings, of which
 * ONE was real — and the builder then spent tokens disproving the other 13.
 * Prompting alone had already been tried, so the fixes were structural (quoted
 * evidence checked against the dossier, a bigger per-file budget so a clipped
 * file stops reading as a truncated one). This measures whether they worked.
 *
 * Cases are the real failure shapes from that log, plus true positives that
 * must still be caught — a reviewer that files nothing scores perfectly on
 * precision and is worthless, so both directions are graded.
 *
 * One Haiku call per case, roughly $0.02 for the suite.
 */
import { readFileSync } from "node:fs";
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

const { judgeDossier } = await import("@/lib/agent/reviewer");
const AnthropicMod = await import("@anthropic-ai/sdk");
const anthropic = new AnthropicMod.default({ apiKey: process.env.ANTHROPIC_API_KEY!.trim() });

interface Case {
  name: string;
  /** true = the dossier contains a real defect the reviewer MUST report */
  defective: boolean;
  /** why this case exists — printed on failure */
  from: string;
  dossier: string;
}

const head = (files: string) => `# App under review: Acme Desk (slug: acme)\n\n## Files\n${files}`;
const env = `\n## Environment\n- End-user auth (Clerk): configured, issuer https://clerk.acme.dev\n- This is a SHARED project: collections belonging to other apps exist and are none of your business.`;

/* A long, complete file that gets CLIPPED by the dossier builder — the exact
   shape that produced "the fetch call is truncated" twice. */
const longApp = `### app.js (32461 B, clipped)
\`\`\`
const API = "/api/v1";
async function loadTickets() {
  const res = await fetch(API + "/tickets");
  const rows = await res.json();
  render(rows.items ?? []);
}
function render(rows) {
  const host = document.getElementById("list");
  host.innerHTML = "";
  for (const r of rows) {
    const li = document.createElement("li");
    li.textContent = r.subject + " — " + r.status;
    host.appendChild(li);
  }
}
${Array.from({ length: 40 }, (_, i) => `function helper${i}() { return ${i}; }`).join("\n")}
async function submit(ev) {
  ev.preventDefault();
  const body = { subject: form.subject.value, body: form.body.value };
  await fetch(API + "/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bo
\`\`\``;

const ticketsSchema = `
## Live schema for referenced collections

### tickets
  publicWrite: true · access: {"read":"authenticated","write":"authenticated","ownerField":"owner"}
  fields (5):
  - subject (text) [publicRead, required]
  - body (richtext) [publicRead, required]
  - status (enum) [publicRead, options:new/open/closed]
  - owner (text) [NOT publicRead]
  - created_at (date) [publicRead, computed {"kind":"now"}]
  workflow: none
  events: none`;

const CASES: Case[] = [
  /* ── false positives: every one of these was filed for real, and was wrong ── */
  {
    name: "clipped-file-is-not-truncated-code",
    defective: false,
    from: 'filed twice as "app.js is truncated / the fetch call is cut off" — the dossier clipped it, the file was intact at 32,461 B',
    dossier: `${head(longApp)}${ticketsSchema}${env}`,
  },
  {
    name: "publicWrite-plus-authenticated-write-compose",
    defective: false,
    from: 'filed as "anonymous users can post without validation" — anyone-submits/staff-triage is the documented shape',
    dossier: `${head(
      `### index.html (900 B)\n\`\`\`\n<form id="f"><label for="subject">Subject</label><input id="subject" name="subject" required>\n<label for="body">Message</label><textarea id="body" name="body" required></textarea>\n<button>Send</button></form>\n\`\`\``,
    )}${ticketsSchema}${env}`,
  },
  {
    name: "field-not-rendered-may-stay-private",
    defective: false,
    from: 'filed as "owner/author_id is exposed" — the field is never rendered, and NOT publicRead is correct',
    dossier: `${head(
      `### app.js (600 B)\n\`\`\`\nconst rows = await (await fetch("/api/v1/tickets")).json();\nrows.items.forEach(r => list.append(el("li", r.subject + " " + r.status)));\n\`\`\``,
    )}${ticketsSchema}${env}`,
  },
  {
    name: "authenticated-read-via-user-token",
    defective: false,
    from: 'filed as "reads will fail because fields are not publicRead" — the app sends X-User-Token and the fields are publicRead',
    dossier: `${head(
      `### desk.js (700 B)\n\`\`\`\nconst jwt = await Clerk.session.getToken();\nconst res = await fetch("/api/v1/tickets", { headers: { "X-User-Token": jwt } });\nconst rows = (await res.json()).items;\nrows.forEach(r => row(r.subject, r.status, r.created_at));\n\`\`\``,
    )}${ticketsSchema}${env}`,
  },
  {
    name: "collection-absent-from-dossier-is-not-absent",
    defective: false,
    from: 'filed as "the faqs collection does not exist" minutes after a probe returned seven live rows from it',
    dossier: `${head(
      `### faq.js (400 B)\n\`\`\`\nconst base = "/api/v1";\nconst res = await fetch(\`\${base}/faqs?sort=order:asc\`);\nrender((await res.json()).items);\n\`\`\``,
    )}\n## Live schema for referenced collections\n(showing 10 of 12 referenced names)${ticketsSchema}${env}`,
  },
  {
    name: "no-csrf-no-client-validation-boilerplate",
    defective: false,
    from: 'filed as "no CSRF token" and "insufficient client-side validation" — neither exists in this platform model',
    dossier: `${head(
      `### form.js (500 B)\n\`\`\`\nform.addEventListener("submit", async (e) => {\n  e.preventDefault();\n  await fetch("/api/v1/tickets", { method: "POST", body: JSON.stringify({ subject: s.value, body: b.value }) });\n});\n\`\`\``,
    )}${ticketsSchema}${env}`,
  },

  /* ── true positives: it must still catch these ── */
  {
    name: "server-code-in-a-browser-file",
    defective: true,
    from: "contract rule 1 — a real Haiku build once shipped an express server",
    dossier: `${head(
      `### server.js (700 B)\n\`\`\`\nconst express = require("express");\nconst app = express();\napp.get("/tickets", async (req, res) => res.json(await db.query("select * from tickets")));\napp.listen(process.env.PORT || 3000);\n\`\`\``,
    )}${ticketsSchema}${env}`,
  },
  {
    name: "literal-delivery-token-in-the-bundle",
    defective: true,
    from: "contract rule 2 — the serving edge injects the token; a token in a file is a leak",
    dossier: `${head(
      `### app.js (400 B)\n\`\`\`\nconst res = await fetch("/api/v1/tickets", { headers: { Authorization: "Bearer agx_9fKq2Lm4Rt7wZx1c" } });\n\`\`\``,
    )}${ticketsSchema}${env}`,
  },
  {
    name: "renders-a-field-that-is-not-publicRead",
    defective: true,
    from: "contract rule 4 — the projection trap, the real bug that cost six debug rounds",
    dossier: `${head(
      `### desk.js (500 B)\n\`\`\`\nconst rows = (await (await fetch("/api/v1/tickets")).json()).items;\nrows.forEach(r => card(r.subject, r.owner, r.status));\n\`\`\``,
    )}${ticketsSchema}${env}`,
  },
  {
    name: "credentials-stored-in-a-collection",
    defective: true,
    from: "contract rule 3 — credentials live in Clerk, never in a collection",
    dossier: `${head(`### login.js (300 B)\n\`\`\`\nawait fetch("/api/v1/staff_users", { method: "POST", body: JSON.stringify({ email, password }) });\n\`\`\``)}
## Live schema for referenced collections

### staff_users
  publicWrite: true · access: {}
  fields (3):
  - email (text) [publicRead, required]
  - password (text) [NOT publicRead, required]
  - created_at (date) [publicRead]
  workflow: none
  events: none${env}`,
  },
];

/* ── run ──────────────────────────────────────────────────────────────────── */

const only = process.argv.slice(2).find((a) => a.startsWith("--case="))?.split("=")[1];
const cases = only ? CASES.filter((c) => c.name.includes(only)) : CASES;

let truePos = 0;
let falsePos = 0;
let falseNeg = 0;
let trueNeg = 0;

console.log(`\nReviewer precision — ${cases.length} case(s)\n`);

for (const c of cases) {
  const res = await judgeDossier(anthropic, c.dossier);
  const filed = res.findings.length > 0;
  const correct = filed === c.defective;
  if (c.defective && filed) truePos++;
  else if (c.defective && !filed) falseNeg++;
  else if (!c.defective && filed) falsePos++;
  else trueNeg++;

  console.log(`${correct ? "  ok  " : "FAIL  "}${c.name}  ${c.defective ? "(should flag)" : "(should pass)"}`);
  if (!correct) {
    console.log(`        why the case exists: ${c.from}`);
    for (const f of res.findings) console.log(`        filed: ${f}`);
    if (c.defective) console.log(`        filed nothing — this defect went unreported`);
  }
}

const precision = truePos + falsePos ? truePos / (truePos + falsePos) : 1;
const recall = truePos + falseNeg ? truePos / (truePos + falseNeg) : 1;
console.log(
  `\nprecision ${(precision * 100).toFixed(0)}%  (baseline from the live log: 7%)` +
    `\nrecall    ${(recall * 100).toFixed(0)}%` +
    `\n${truePos} true positive · ${trueNeg} correctly quiet · ${falsePos} FALSE positive · ${falseNeg} MISSED\n`,
);

// Precision is the number this pass exists to fix, but a reviewer that files
// nothing would score 100% — so recall has to clear a bar too.
const ok = precision >= 0.6 && recall >= 0.75;
console.log(ok ? "PASS — meets the sprint's exit criteria (precision ≥60%, recall ≥75%)\n" : "BELOW TARGET\n");
process.exit(ok ? 0 : 1);
