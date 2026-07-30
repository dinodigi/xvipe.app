/**
 * Static file server for built apps — the app workspace, byte for byte.
 * Reached directly (/apps/<slug>/…) or via the host rewrite
 * (<slug>.localhost:<port>/…). No execution, ever: files out, nothing run.
 */
import { NextRequest } from "next/server";
import { getApp, wsExists, wsReadRaw } from "@/lib/apps/store";
import { contentTypeFor } from "@/lib/apps/mime";

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string; path?: string[] }> }) {
  const { slug, path = [] } = await ctx.params;
  const app = getApp(slug);
  if (!app) {
    return new Response(placeholder("No app here", `Nothing is deployed at this address.`), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  let rel = path.join("/");
  if (!rel) rel = "index.html";
  else if (!rel.includes(".")) rel = `${rel}/index.html`.replace(/^\/+/, "");

  let found = wsExists(slug, rel) ? rel : undefined;
  if (!found && rel !== "index.html" && !path.join("/").includes(".")) {
    // SPA-style fallback: unknown extensionless routes serve the app shell
    found = wsExists(slug, "index.html") ? "index.html" : undefined;
  }
  if (!found) {
    const empty = rel === "index.html";
    return new Response(
      placeholder(
        empty ? `${app.name} — not built yet` : "Not found",
        empty
          ? "This app has no index.html yet. Open the studio and describe what to build."
          : `No file at ${rel}.`,
      ),
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  let body: Buffer;
  try {
    body = wsReadRaw(slug, found);
  } catch {
    return new Response("read error", { status: 500 });
  }
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": contentTypeFor(found),
      // live preview — always fresh; the CDN does the caching in production
      "cache-control": "no-store",
    },
  });
}

function placeholder(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f6f4f0;color:#221f2b">
<div style="text-align:center;padding:40px;max-width:420px">
<div style="font-size:40px;margin-bottom:12px">◇</div>
<h1 style="font-size:18px;margin:0 0 8px">${title}</h1>
<p style="font-size:14px;color:#6b6577;margin:0">${message}</p>
</div></body>`;
}
