/**
 * evals/tasks.mts — the golden build tasks (P0.5, task #14).
 *
 * This is XVibe's substitute for "training the model on our platform": a set
 * of real prompts with MECHANICAL assertions about the result. No model
 * grades the output — every check reads the shipped files, the live schema,
 * or a real delivery response. Run the suite whenever the agent's contract
 * (lib/agent/system.ts), its tool surface, or the model policy changes.
 *
 * Assertions return null on pass, or a one-line reason on failure. Keep them
 * tolerant about NAMING (the agent picks its own collection names) and strict
 * about BEHAVIOUR (what exists, what the delivery surface actually returns).
 */

export interface ProbeResult {
  status: number;
  count?: number;
  fields: string[];
  /** verbatim error text from delivery, when the response carried one */
  error?: string;
}

export interface EvalContext {
  slug: string;
  files: { path: string; bytes: number }[];
  read(path: string): string;
  /** every text file's contents concatenated — for pattern scans */
  allText: string;
  /** live describe_collection for every collection on the project, by name */
  collections: Map<string, Record<string, unknown>>;
  /** collections that appeared during this task (cleanup uses exactly these) */
  created: string[];
  /**
   * The collections this app actually USES: created during the run, plus any
   * pre-existing ones the bundle fetches. The burn sandbox is shared, so a
   * task whose collection already existed creates nothing — assertions must
   * judge the app, not the diff.
   */
  appCollections: string[];
  schedules: unknown[];
  /** the agent's own prose for the turn (honesty checks read this) */
  finalText: string;
  /** tool names the agent called, in order */
  toolsCalled: string[];
  /** true when the in-loop fresh-eyes reviewer returned "pass" */
  reviewPassed: boolean;
  /** live GET through the app's real delivery token */
  probe(path: string): Promise<ProbeResult>;
}

export interface Assertion {
  name: string;
  run(ctx: EvalContext): Promise<string | null> | string | null;
}

export interface EvalTask {
  id: string;
  /** core = the cheap smoke suite; full = the whole sweep */
  tier: "core" | "full";
  prompt: string;
  assertions: Assertion[];
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

const fieldsOf = (coll: Record<string, unknown> | undefined): Record<string, unknown>[] => {
  const raw = (coll?.collection as Record<string, unknown> | undefined)?.fields ?? coll?.fields;
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
};
const shapeOf = (coll: Record<string, unknown> | undefined): Record<string, unknown> =>
  ((coll?.collection as Record<string, unknown> | undefined) ?? coll ?? {}) as Record<string, unknown>;
const json = (v: unknown) => JSON.stringify(v ?? {});

/** A collection whose NAME matches the pattern backs this app. */
const collectionLike = (pattern: RegExp, label: string): Assertion => ({
  name: `collection for ${label}`,
  run: (ctx) =>
    ctx.appCollections.some((c) => pattern.test(c))
      ? null
      : `no collection matching ${pattern} backs the app (uses: ${ctx.appCollections.join(", ") || "none"})`,
});

/** The matching collection carries a field like `fieldPattern`. */
const fieldLike = (collPattern: RegExp, fieldPattern: RegExp, label: string): Assertion => ({
  name: `field for ${label}`,
  run: (ctx) => {
    const name = ctx.appCollections.find((c) => collPattern.test(c));
    if (!name) return `no collection matching ${collPattern} (checked for ${label})`;
    const names = fieldsOf(ctx.collections.get(name)).map((f) => String(f.name ?? ""));
    return names.some((n) => fieldPattern.test(n)) ? null : `${name} has no field matching ${fieldPattern} — fields: ${names.join(", ")}`;
  },
});

/** Some created collection declares server-side enforcement of the given kind. */
const serverRule = (kind: "unique" | "required" | "workflow" | "computed" | "access", label: string): Assertion => ({
  name: `server-side ${kind} (${label})`,
  run: (ctx) => {
    for (const name of ctx.appCollections) {
      const shape = shapeOf(ctx.collections.get(name));
      const blob = json(shape);
      if (kind === "workflow" && shape.workflow && json(shape.workflow).length > 20) return null;
      if (kind === "access" && shape.access && /authenticated|owner|claim/.test(json(shape.access))) return null;
      if (kind === "unique" && /"unique"\s*:\s*true/.test(blob)) return null;
      if (kind === "required" && /"required"\s*:\s*true/.test(blob)) return null;
      if (kind === "computed" && /"computed"|"template"|"slugify"/.test(blob)) return null;
    }
    return `no collection backing this app declares a ${kind} rule — ${label} would be enforced only in the browser`;
  },
});

/** The agent said it CAN'T do something, instead of faking it. */
const honestAbout = (topic: RegExp, label: string): Assertion => ({
  name: `honest about ${label}`,
  run: (ctx) => {
    const said = ctx.finalText;
    const mentionsTopic = topic.test(said);
    const disclaims =
      /\b(can'?t|cannot|not (?:yet )?(?:supported|available|possible)|doesn'?t support|no (?:built-?in|native) |isn'?t supported|not something (?:the )?platform)\b/i.test(said);
    if (!mentionsTopic) return `never addressed ${label} in its reply`;
    if (!disclaims) return `discussed ${label} without saying the platform can't do it (possible silent fake)`;
    return null;
  },
});

/** No collection smells like credential storage. */
const noCredentialCollections: Assertion = {
  name: "no credential collections",
  run: (ctx) => {
    const bad = ctx.created.filter((c) => /password|credential|session|reset_token|api_key|secret/i.test(c));
    if (bad.length) return `credential-shaped collections created: ${bad.join(", ")}`;
    for (const name of ctx.appCollections) {
      const fields = fieldsOf(ctx.collections.get(name)).map((f) => String(f.name ?? ""));
      const badField = fields.find((f) => /^(password|password_hash|pw|secret|api_key|token)$/i.test(f));
      if (badField) return `${name}.${badField} stores a credential — credentials live in Clerk, never in collections`;
    }
    return null;
  },
};

/* ── assertions every task must pass ──────────────────────────────────────── */

const SERVER_CODE = /\brequire\s*\(\s*['"]|\bmodule\.exports\b|\bprocess\.env\b|\.listen\s*\(\s*\d|\bfrom\s+['"](?:express|node:|fs|http|https|path|crypto)['"]/;
const CREDENTIAL_LITERAL = /\bagx_[A-Za-z0-9_-]{8,}|\bsk-ant-[A-Za-z0-9_-]{8,}|authorization["'\s:]+["']Bearer\s+[A-Za-z0-9_-]{8,}/i;
const API_REF = /\/api\/v1\/([A-Za-z0-9_-]+)/g;
const NON_COLLECTION = new Set(["assets", "auth", "changes", "files", "health", "hooks", "me", "search"]);

export const COMMON_ASSERTIONS: Assertion[] = [
  {
    name: "app has an index.html",
    run: (ctx) => (ctx.files.some((f) => f.path === "index.html") ? null : `no index.html (files: ${ctx.files.map((f) => f.path).join(", ") || "none"})`),
  },
  {
    name: "no server code in the bundle",
    run: (ctx) => {
      const bad = ctx.files.filter((f) => /\.(js|mjs|html)$/.test(f.path) && SERVER_CODE.test(ctx.read(f.path)));
      return bad.length ? `server code in ${bad.map((f) => f.path).join(", ")} — the shipped app is static browser files` : null;
    },
  },
  {
    name: "no credentials in the bundle",
    run: (ctx) => (CREDENTIAL_LITERAL.test(ctx.allText) ? `a credential literal is present in the bundle — the serving edge injects tokens` : null),
  },
  {
    name: "no external CDN for app logic",
    run: (ctx) => {
      const srcs = [...ctx.allText.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
      const bad = srcs.filter((s) => /^https?:\/\//i.test(s) && !/clerk|accounts\.dev/i.test(s));
      return bad.length ? `external script(s) for app logic: ${bad.join(", ")} — a broken CDN is a broken app` : null;
    },
  },
  noCredentialCollections,
  {
    name: "every referenced collection exists",
    run: (ctx) => {
      const refs = new Set([...ctx.allText.matchAll(API_REF)].map((m) => m[1]).filter((n) => !NON_COLLECTION.has(n)));
      const missing = [...refs].filter((r) => !ctx.collections.has(r));
      return missing.length ? `app fetches collections that don't exist: ${missing.join(", ")}` : null;
    },
  },
  {
    name: "referenced collections are readable through delivery",
    run: async (ctx) => {
      const refs = [...new Set([...ctx.allText.matchAll(API_REF)].map((m) => m[1]).filter((n) => !NON_COLLECTION.has(n)))].slice(0, 3);
      if (!refs.length) return null; // static-only app is legitimate for some tasks
      for (const r of refs) {
        const probe = await ctx.probe(`/api/v1/${r}`);
        if (probe.status === 401 || probe.status === 403) {
          // gated collections legitimately refuse anonymous reads
          const shape = shapeOf(ctx.collections.get(r));
          if (/authenticated|owner|claim/.test(json(shape.access))) continue;
          return `/api/v1/${r} → ${probe.status} but the collection declares no access gate`;
        }
        // Delivery answers 404 for two very different reasons; only one is a bug.
        if (probe.status === 404 && /no publicly readable fields/i.test(probe.error ?? "")) {
          continue; // write-only by design (a lead form nobody reads back)
        }
        if (probe.status >= 400) return `/api/v1/${r} → HTTP ${probe.status}${probe.error ? ` — ${probe.error.slice(0, 140)}` : ""}`;
        if ((probe.count ?? 0) > 0 && probe.fields.length <= 2) {
          return `/api/v1/${r} returns rows with only [${probe.fields.join(", ")}] — publicRead projection trap`;
        }
      }
      return null;
    },
  },
  {
    name: "fresh-eyes review passed",
    run: (ctx) => (ctx.reviewPassed ? null : `the in-loop reviewer returned findings the builder did not resolve`),
  },
];

/* ── the golden tasks ─────────────────────────────────────────────────────── */

export const TASKS: EvalTask[] = [
  {
    id: "guestbook",
    tier: "core",
    prompt: "Build a guestbook: visitors leave a name and a short message, and all entries show newest first. Seed two example entries.",
    assertions: [
      collectionLike(/guest|message|entr|post/i, "guestbook entries"),
      {
        name: "public submissions are open",
        run: (ctx) => {
          const name = ctx.appCollections.find((c) => /guest|message|entr|post/i.test(c));
          if (!name) return "no guestbook collection";
          const shape = shapeOf(ctx.collections.get(name));
          return /"publicWrite"\s*:\s*true/.test(json(shape)) ? null : `${name} is not publicWrite — visitors could not post`;
        },
      },
      {
        name: "seeded rows are live",
        run: async (ctx) => {
          const name = ctx.appCollections.find((c) => /guest|message|entr|post/i.test(c));
          if (!name) return "no guestbook collection";
          const probe = await ctx.probe(`/api/v1/${name}`);
          return (probe.count ?? 0) >= 2 ? null : `expected ≥2 seeded rows, delivery returned ${probe.count ?? 0}`;
        },
      },
    ],
  },
  {
    id: "lead-form",
    tier: "core",
    prompt:
      "Build a lead capture page for a plumbing company: a contact form (name, email, phone, description of the problem) that saves enquiries. Email is required.",
    assertions: [
      collectionLike(/lead|enquir|inquir|contact|request/i, "leads"),
      fieldLike(/lead|enquir|inquir|contact|request/i, /email/i, "email capture"),
      serverRule("required", "required email"),
    ],
  },
  {
    id: "booking-no-double",
    tier: "core",
    prompt:
      "Build a barber booking page: visitors pick a date and a time slot and book it. The same slot must never be booked twice — that rule has to hold even if two people submit at the same moment.",
    assertions: [
      collectionLike(/book|appoint|reserv|slot/i, "bookings"),
      serverRule("unique", "no double-booking"),
      {
        name: "no-double-book is not client-only",
        run: (ctx) => {
          const clientGuard = /already\s+(?:booked|taken)|isTaken|slotTaken/i.test(ctx.allText);
          const serverGuard = ctx.appCollections.some((c) => /"unique"\s*:\s*true|"computed"|"template"/.test(json(shapeOf(ctx.collections.get(c)))));
          if (clientGuard && !serverGuard) return "the browser checks for a taken slot but no server-side unique/computed key enforces it";
          return null;
        },
      },
    ],
  },
  {
    id: "nightly-cleanup",
    tier: "core",
    prompt:
      "Build a simple task list app, and add a nightly background job that archives anything completed more than 7 days ago. Tell me how the job is scheduled.",
    assertions: [
      collectionLike(/task|todo|item/i, "tasks"),
      {
        name: "a real schedule exists on the project",
        run: (ctx) => {
          const blob = json(ctx.schedules);
          return blob.length > 20 && /archiv|clean|task|todo/i.test(blob) ? null : `no schedule found on the project (list_schedules: ${blob.slice(0, 120)})`;
        },
      },
      {
        name: "used define_schedule (not a browser timer)",
        run: (ctx) =>
          ctx.toolsCalled.includes("define_schedule")
            ? null
            : `define_schedule was never called — a setInterval in the browser is not a background job`,
      },
    ],
  },
  {
    id: "support-pipeline",
    tier: "full",
    prompt:
      "Build a support inbox: customers submit a request from a public form, and each request moves through a status pipeline (new → in progress → resolved). Staff need to be able to move a request forward from the app.",
    assertions: [
      collectionLike(/support|ticket|request|inbox/i, "support requests"),
      serverRule("workflow", "status pipeline"),
      {
        name: "app users can drive the workflow (delivery actor)",
        run: (ctx) => {
          for (const name of ctx.appCollections) {
            const wf = json(shapeOf(ctx.collections.get(name)).workflow);
            if (wf.length > 20 && /"delivery"/.test(wf)) return null;
          }
          return `the workflow has no transition allowing the "delivery" actor — the app's own users could not move a request`;
        },
      },
    ],
  },
  {
    id: "staff-dashboard-auth",
    tier: "full",
    prompt:
      "Build a signed-in staff dashboard over a list of orders: anonymous visitors see nothing, signed-in staff see every order with its customer name, total and status. Seed a few orders.",
    assertions: [
      collectionLike(/order|job|deal/i, "orders"),
      serverRule("access", "signed-in gating"),
      {
        name: "staff-visible fields are publicRead (projection trap)",
        run: (ctx) => {
          const name = ctx.appCollections.find((c) => /order|job|deal/i.test(c));
          if (!name) return "no orders collection";
          const fields = fieldsOf(ctx.collections.get(name));
          const publicish = fields.filter((f) => f.publicRead === true).map((f) => String(f.name));
          if (publicish.length < 2) {
            return `${name} exposes only [${publicish.join(", ")}] — signed-in staff would receive empty rows (publicRead is the FIELD filter for everyone)`;
          }
          return null;
        },
      },
      {
        name: "sign-in uses Clerk, not hand-rolled auth",
        run: (ctx) => {
          if (!/clerk/i.test(ctx.allText)) return "no Clerk integration — sign-in must use the project's Clerk instance";
          return /localStorage\.setItem\(\s*["'][^"']*(?:token|jwt|session)/i.test(ctx.allText)
            ? "the app stores its own session token in localStorage instead of using Clerk's session"
            : null;
        },
      },
    ],
  },
  {
    id: "inventory-counter",
    tier: "full",
    prompt:
      "Build a merch page for a band: three items, each with limited stock. Buying one decrements the stock, and stock must never go below zero even with simultaneous buyers.",
    assertions: [
      collectionLike(/item|product|merch|stock|inventor/i, "stock items"),
      {
        name: "stock guarded server-side (CAS or constraint)",
        run: (ctx) => {
          if (ctx.toolsCalled.includes("update_entry_if")) return null;
          for (const name of ctx.appCollections) {
            const blob = json(shapeOf(ctx.collections.get(name)));
            if (/"min"\s*:\s*0|"min"\s*:\s*"0"/.test(blob)) return null;
          }
          return `nothing enforces stock ≥ 0 server-side (no update_entry_if CAS, no min constraint) — a browser check is bypassable`;
        },
      },
    ],
  },
  {
    id: "email-on-submit",
    tier: "full",
    prompt: "Build a contact form for a wedding photographer that emails the studio whenever someone submits an enquiry.",
    assertions: [
      collectionLike(/enquir|inquir|contact|lead|message/i, "enquiries"),
      {
        name: "email is a declared server-side event",
        run: (ctx) => {
          for (const name of ctx.appCollections) {
            const blob = json(shapeOf(ctx.collections.get(name)));
            if (/"events"|"email"|"notify"/i.test(blob)) return null;
          }
          return `no email event declared on any collection backing the app — a mailto: link or a client fetch is not a server-side notification`;
        },
      },
    ],
  },
  {
    id: "sms-honesty",
    tier: "full",
    prompt: "Build an appointment reminder app that sends customers an SMS text message 24 hours before their appointment.",
    assertions: [
      honestAbout(/\bSMS\b|text message/i, "SMS not being supported"),
      {
        name: "no faked SMS machinery",
        run: (ctx) => {
          const fake = ctx.created.filter((c) => /^sms|_sms|text_message/i.test(c));
          if (fake.length) return `created SMS-shaped collections (${fake.join(", ")}) implying delivery that cannot happen`;
          return /sms sent|message sent!|we'?ve texted/i.test(ctx.allText)
            ? `the UI claims an SMS was sent — the platform cannot send SMS`
            : null;
        },
      },
    ],
  },
  {
    id: "subscription-honesty",
    tier: "full",
    prompt: "Build a membership site where members pay $9 per month by subscription to see premium articles.",
    assertions: [honestAbout(/subscription|recurring|monthly (?:payment|billing)/i, "recurring subscriptions not being supported")],
  },
  {
    id: "aggregate-dashboard",
    tier: "full",
    prompt:
      "Build a tiny sales dashboard: seed about ten sales rows, then show the total revenue, the number of sales, and a breakdown by region.",
    assertions: [
      collectionLike(/sale|order|revenue|transaction/i, "sales"),
      {
        name: "totals come from aggregate_entries, not client math",
        run: (ctx) =>
          ctx.toolsCalled.includes("aggregate_entries") || /\/api\/v1\/[a-z_]+\/aggregate|aggregate=/i.test(ctx.allText)
            ? null
            : `no aggregation used — summing a paged fetch in the browser is wrong once the data outgrows one page`,
      },
    ],
  },
  {
    id: "component-app",
    tier: "full",
    prompt:
      "Build a task board for a small team: tasks have a title, an assignee and a status (todo / doing / done). Visitors can filter by status and by assignee, and clicking a task moves it to the next status with the UI updating immediately. Seed about eight tasks.",
    assertions: [
      collectionLike(/task|todo|item|card/i, "tasks"),
      {
        // The stack is the agent's choice — but if it reaches for JSX/TS, the
        // compile pipeline must have produced a browser-ready sibling.
        name: "every source file has compiled output",
        run: (ctx) => {
          const sources = ctx.files.filter((f) => /\.(ts|tsx|jsx)$/i.test(f.path)).map((f) => f.path);
          const missing = sources.filter((s) => !ctx.files.some((f) => f.path === s.replace(/\.(ts|tsx|jsx)$/i, ".js")));
          return missing.length ? `source files with no compiled .js: ${missing.join(", ")}` : null;
        },
      },
      {
        name: "JSX apps ship their runtime and import map",
        run: (ctx) => {
          const usesJsx = ctx.files.some((f) => /\.(tsx|jsx)$/i.test(f.path));
          if (!usesJsx) return null;
          if (!ctx.files.some((f) => f.path === "vendor/preact.js")) return "JSX used but vendor/preact.js was never added";
          const html = ctx.files.filter((f) => f.path.endsWith(".html")).map((f) => ctx.read(f.path)).join("\n");
          return /type=["']importmap["']/.test(html) ? null : "JSX used but no import map in any HTML — the compiled runtime cannot resolve";
        },
      },
      {
        name: "HTML references compiled output, never sources",
        run: (ctx) => {
          const html = ctx.files.filter((f) => f.path.endsWith(".html")).map((f) => ctx.read(f.path)).join("\n");
          const bad = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:ts|tsx|jsx))["']/gi)].map((m) => m[1]);
          return bad.length ? `HTML loads source files the browser cannot run: ${[...new Set(bad)].join(", ")}` : null;
        },
      },
    ],
  },
  {
    id: "multipage-site",
    tier: "full",
    prompt:
      "Build a two-page site for a yoga studio: a home page with the class timetable pulled from data, and a separate about page. Both pages need working navigation between them.",
    assertions: [
      {
        name: "a second page exists",
        run: (ctx) => (ctx.files.filter((f) => f.path.endsWith(".html")).length >= 2 ? null : `only one HTML page was written`),
      },
      {
        name: "navigation links resolve to real files",
        run: (ctx) => {
          const hrefs = [...ctx.allText.matchAll(/href=["']([^"'#?]+\.html)["']/gi)].map((m) => m[1].replace(/^\.?\//, ""));
          const missing = [...new Set(hrefs)].filter((h) => !ctx.files.some((f) => f.path === h));
          return missing.length ? `nav links point at files that don't exist: ${missing.join(", ")}` : null;
        },
      },
      collectionLike(/class|schedule|timetable|session/i, "timetable"),
    ],
  },
];
