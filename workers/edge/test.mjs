/**
 * Edge worker behaviour tests — plain node, no wrangler, no network.
 *
 *   node workers/edge/test.mjs
 *
 * Stubs the R2 and KV bindings and drives the real fetch handler, so the
 * routing, custody and caching rules are checked before this ever reaches a
 * zone. Pass-through cases stub global fetch: the worker must hand the apex
 * and reserved hosts to the studio origin untouched.
 */
import worker from "./src/worker.js";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ── stub bindings ── */
const bundle = {
  "demo/current.json": JSON.stringify({ version: 3, publishedAt: "2026-07-31T00:00:00Z", files: ["index.html"] }),
  "demo/v3/index.html": "<!doctype html><title>Demo</title><h1>hello</h1>",
  "demo/v3/css/app.css": "body{color:#111}",
};
const env = {
  XVIBE_APPS_BASE_DOMAIN: "xvibe.app",
  PLUGGIE_DELIVERY_BASE: "https://pluggie.app/api/v1",
  BUNDLES: {
    get: async (key) =>
      key in bundle
        ? { body: bundle[key], text: async () => bundle[key], httpEtag: `"etag-${key.length}"` }
        : null,
  },
  TOKENS: { get: async (key) => (key === "token:demo" ? "agx_edge_test_token" : null) },
};

const req = (url, init) => new Request(url, init);

/* ── serving ── */
let res = await worker.fetch(req("https://demo.xvibe.app/"), env);
check("root serves index.html from the current version", res.status === 200 && (await res.text()).includes("hello"));

res = await worker.fetch(req("https://demo.xvibe.app/"), env);
check("html is revalidated, not cached hard", res.headers.get("cache-control")?.includes("must-revalidate"), res.headers.get("cache-control"));
check("version is reported for debugging", res.headers.get("x-xvibe-version") === "3");

res = await worker.fetch(req("https://demo.xvibe.app/css/app.css"), env);
check("assets are immutable + correct type", res.status === 200 && res.headers.get("cache-control").includes("immutable") && res.headers.get("content-type").startsWith("text/css"));

res = await worker.fetch(req("https://demo.xvibe.app/dashboard"), env);
check("extensionless route falls back to the app shell (SPA)", res.status === 200 && (await res.text()).includes("hello"));

res = await worker.fetch(req("https://demo.xvibe.app/missing.png"), env);
check("missing asset is a real 404", res.status === 404);

const etag = (await worker.fetch(req("https://demo.xvibe.app/"), env)).headers.get("etag");
res = await worker.fetch(req("https://demo.xvibe.app/", { headers: { "if-none-match": etag } }), env);
check("etag match answers 304 (no body re-sent)", res.status === 304, `etag ${etag}`);

res = await worker.fetch(req("https://nosuchapp.xvibe.app/"), env);
check("unknown app gets the styled placeholder", res.status === 404 && (await res.text()).includes("Nothing is published"));

/* ── pass-through: the studio origin still owns these ── */
let passedThrough = 0;
globalThis.fetch = async () => {
  passedThrough++;
  return new Response("studio", { status: 200 });
};
for (const host of ["https://xvibe.app/", "https://www.xvibe.app/", "https://studio.xvibe.app/x", "https://demo.other.com/"]) {
  await worker.fetch(req(host), env);
}
check("apex, reserved labels and foreign hosts pass through", passedThrough === 4, `passed through ${passedThrough}/4`);

/* ── data proxy + token custody ── */
let seen;
globalThis.fetch = async (url, init) => {
  seen = { url: String(url), headers: new Headers(init?.headers) };
  return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
};
res = await worker.fetch(req("https://demo.xvibe.app/api/v1/guestbook?limit=5", { headers: { "x-user-token": "jwt-abc", cookie: "secret=1" } }), env);
check("proxy hits the delivery base with path + query", seen.url === "https://pluggie.app/api/v1/guestbook?limit=5", seen.url);
check("delivery token is injected at the edge", seen.headers.get("authorization") === "Bearer agx_edge_test_token");
check("end-user JWT passes through", seen.headers.get("x-user-token") === "jwt-abc");
check("cookies never cross to the platform", !seen.headers.has("cookie"));

res = await worker.fetch(req("https://nosuchapp.xvibe.app/api/v1/anything"), env);
check("app without an edge token answers 503, never an unauthenticated call", res.status === 503 && (await res.json()).code === "E_APP_NOT_CONNECTED");

res = await worker.fetch(req("https://demo.xvibe.app/index.html", { method: "POST" }), env);
check("writes to static paths are rejected", res.status === 405);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
