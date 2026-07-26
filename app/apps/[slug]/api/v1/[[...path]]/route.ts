/**
 * The serving edge for built apps: same-origin /api/v1/* → Pluggie delivery.
 *
 * This is the piece that makes "static bundle + full backend" true. The
 * bundle ships with NO credential; this proxy injects the app's delivery
 * token server-side (CONNECTION.md §3c: server-side env only — for a static
 * app, the serving edge IS its server env). End-user identity (X-User-Token)
 * passes through untouched; the project token never reaches the browser.
 */
import { NextRequest } from "next/server";
import { getApp, getDeliveryToken } from "@/lib/apps/store";

const DELIVERY_BASE = () => process.env.PLUGGIE_DELIVERY_BASE ?? "https://pluggie.app/api/v1";

/** request headers forwarded upstream (allowlist — cookies etc. never cross) */
const FORWARD_REQUEST = ["content-type", "if-none-match", "x-user-token", "accept"];
/** response headers passed back to the app */
const FORWARD_RESPONSE = ["content-type", "etag", "cache-control", "retry-after", "location"];

async function proxy(req: NextRequest, ctx: { params: Promise<{ slug: string; path?: string[] }> }) {
  const { slug, path = [] } = await ctx.params;

  if (!getApp(slug)) {
    return Response.json({ error: `No app "${slug}" here`, code: "E_APP_NOT_FOUND" }, { status: 404 });
  }
  const token = getDeliveryToken(slug);
  if (!token) {
    return Response.json(
      {
        error:
          "This app has no delivery token yet — the builder mints one (mint_delivery_token) when the app first needs data. Ask it to connect the backend.",
        code: "E_APP_NOT_CONNECTED",
      },
      { status: 503 },
    );
  }

  const upstream = new URL(`${DELIVERY_BASE()}/${path.map(encodeURIComponent).join("/")}`);
  upstream.search = req.nextUrl.search;

  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(upstream, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    redirect: "manual", // image transforms answer 302 to R2 — hand it to the browser
    cache: "no-store",
  });

  const out = new Headers();
  for (const h of FORWARD_RESPONSE) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.status === 204 || res.status === 304 ? null : res.body, {
    status: res.status,
    headers: out,
  });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE, proxy as HEAD };
