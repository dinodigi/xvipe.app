/**
 * XVibe edge worker — serves published apps from R2 and proxies their data
 * calls to Pluggie, at the CDN edge instead of through the studio host.
 *
 * It is a byte server and a credential injector. It never executes app code:
 * that boundary is the whole reason XVibe can host other people's apps.
 *
 *   <slug>.xvibe.app/…            → R2: <slug>/current.json → <slug>/vN/<path>
 *   <slug>.xvibe.app/api/v1/…     → Pluggie delivery, Bearer token added here
 *
 * Token custody (CONNECTION.md §3c): a static bundle has no server, so the
 * serving edge IS its server environment. Delivery tokens live in KV, written
 * by the studio when the builder mints one, and are read only here. They never
 * enter a bundle, a browser, or the model's context.
 *
 * Deliberately dependency-free and standard: fetch handler, Request/Response,
 * env bindings. Same shape runs on any WinterCG runtime if we ever re-target
 * (docs/AGENT-PLAN.md §4, exit insurance rule 1).
 */

// Mirror of lib/apps/reserved.ts — this runtime cannot import from the studio,
// so the two lists are kept in sync by hand. Reserving costs nothing; taking a
// name back after a user's app is live on it costs them their URL.
const RESERVED = new Set([
  "www", "studio", "api", "admin", "unlock", "apps", "app", "dashboard", "console",
  "account", "accounts", "login", "signup", "signin", "auth", "oauth", "sso",
  "billing", "invoice", "invoices", "pay", "payments", "checkout",
  "blog", "docs", "doc", "help", "support", "status", "about", "pricing",
  "careers", "jobs", "press", "news", "changelog", "roadmap",
  "legal", "terms", "privacy", "security", "trust", "abuse", "dmca",
  "cdn", "assets", "static", "media", "files", "img", "images", "download",
  "mail", "smtp", "imap", "email", "ns", "ns1", "ns2", "dns", "mx",
  "health", "metrics", "monitor", "logs", "grafana",
  "dev", "staging", "stage", "test", "testing", "qa", "sandbox", "demo",
  "preview", "beta", "alpha", "next", "edge", "local",
]);

/** Request headers we pass upstream. Cookies never cross. */
const FORWARD_REQUEST = ["content-type", "if-none-match", "x-user-token", "accept"];
/** Response headers we hand back to the app. */
const FORWARD_RESPONSE = ["content-type", "etag", "cache-control", "retry-after", "location"];

const MIME = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  webmanifest: "application/manifest+json",
};
const contentTypeFor = (path) => MIME[path.split(".").pop()?.toLowerCase()] ?? "application/octet-stream";

/** <slug>.<appsDomain> → slug. Returns undefined for reserved/!matching hosts. */
function slugFromHost(hostname, appsDomain) {
  const host = hostname.toLowerCase().replace(/:\d+$/, "");
  const base = appsDomain.toLowerCase();
  if (host === base || !host.endsWith(`.${base}`)) return undefined;
  const label = host.slice(0, -(base.length + 1));
  if (!label || label.includes(".") || RESERVED.has(label)) return undefined;
  return label;
}

async function currentVersion(env, slug) {
  const obj = await env.BUNDLES.get(`${slug}/current.json`);
  if (!obj) return undefined;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return undefined;
  }
}

/* ── data proxy: the only place a delivery token is ever added ───────────── */
async function proxyDelivery(request, env, slug, url) {
  const token = await env.TOKENS.get(`token:${slug}`);
  if (!token) {
    return Response.json(
      {
        error:
          "This app has no delivery token at the edge yet — the builder mints one when the app first needs data, and publishing syncs it here.",
        code: "E_APP_NOT_CONNECTED",
      },
      { status: 503 },
    );
  }

  const base = (env.PLUGGIE_DELIVERY_BASE || "https://pluggie.app/api/v1").replace(/\/$/, "");
  const upstream = new URL(base + url.pathname.slice("/api/v1".length) + url.search);

  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual", // image transforms answer 302 to R2 — let the browser follow
  });

  const out = new Headers();
  for (const h of FORWARD_RESPONSE) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: out });
}

/* ── static serving from the immutable snapshot ──────────────────────────── */
async function serveBundle(request, env, slug, url) {
  const current = await currentVersion(env, slug);
  if (!current) return page(404, "No app here", "Nothing is published at this address yet.");

  let rel = url.pathname.replace(/^\/+/, "");
  if (!rel) rel = "index.html";
  else if (!rel.split("/").pop().includes(".")) rel = `${rel}/index.html`;

  const prefix = `${slug}/v${current.version}/`;
  let object = await env.BUNDLES.get(prefix + rel);

  // SPA fallback: unknown extensionless routes get the app shell
  if (!object && !url.pathname.split("/").pop().includes(".")) {
    object = await env.BUNDLES.get(`${prefix}index.html`);
    if (object) rel = "index.html";
  }
  if (!object) return page(404, "Not found", `No file at /${rel}.`);

  // Weak validator: a strong etag is invalid once the body is transformed.
  // Measured 2026-08-01: Cloudflare strips the validator entirely from
  // compressed streamed Worker responses (weak or strong), so revalidation
  // costs a fresh HTML fetch rather than a 304. Kept because it is correct
  // and costs nothing — the bulk of bytes are immutable versioned assets,
  // which never revalidate at all.
  const etag = object.httpEtag.startsWith("W/") ? object.httpEtag : `W/${object.httpEtag}`;

  const headers = new Headers();
  headers.set("content-type", contentTypeFor(rel));
  headers.set("etag", etag);
  // The version prefix makes every object immutable; the pointer is what moves,
  // so HTML is revalidated and assets are cached hard.
  headers.set(
    "cache-control",
    rel.endsWith(".html") ? "public, max-age=0, must-revalidate" : "public, max-age=31536000, immutable",
  );
  headers.set("x-xvibe-version", String(current.version));

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

function page(status, title, message) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f6f4f0;color:#221f2b">
<div style="text-align:center;padding:40px;max-width:420px">
<div style="font-size:40px;margin-bottom:12px">◇</div>
<h1 style="font-size:18px;margin:0 0 8px">${title}</h1>
<p style="font-size:14px;color:#6b6577;margin:0">${message}</p>
</div></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const slug = slugFromHost(url.hostname, env.XVIBE_APPS_BASE_DOMAIN || "xvibe.app");

    // Not an app host (apex, studio, reserved label) — the studio origin owns it.
    if (!slug) return fetch(request);

    if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
      return proxyDelivery(request, env, slug, url);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    return serveBundle(request, env, slug, url);
  },
};
