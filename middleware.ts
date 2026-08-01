/**
 * middleware.ts — host-based serving for built apps.
 *
 * Production contract: each app lives at <slug>.xvibe.app, a static bundle
 * whose /api/v1/* calls are answered same-origin with the delivery token
 * injected at the edge. Locally we honor the SAME contract on
 * <slug>.localhost:<port> (RFC 6761 makes *.localhost resolve to loopback),
 * so a bundle that works in the preview works in production unchanged.
 */
import { NextRequest, NextResponse } from "next/server";

// First-level subdomains that are never app slugs (apps live at <slug>.<apps domain>)
const RESERVED = new Set(["www", "studio", "api", "admin", "mail"]);

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";

  /**
   * Two app-serving domains, both host-rewritten here:
   *  - the PUBLISHED domain (XVIBE_APPS_BASE_DOMAIN) — normally served by the
   *    edge worker from R2, but this origin must still answer for it when the
   *    worker is bypassed or not yet routed.
   *  - the PREVIEW domain (XVIBE_PREVIEW_BASE_DOMAIN) — always this origin,
   *    serving the LIVE workspace so the studio shows the agent's edits as
   *    they happen rather than the last published snapshot.
   */
  const domains = [process.env.XVIBE_APPS_BASE_DOMAIN, process.env.XVIBE_PREVIEW_BASE_DOMAIN]
    .filter((d): d is string => Boolean(d))
    .map((d) => d.replace(/\./g, "\\."));
  if (domains.length === 0) domains.push("xvibe\\.app");

  const m =
    host.match(/^([a-z0-9-]+)\.localhost(?::\d+)?$/) ??
    domains.reduce<RegExpMatchArray | null>(
      (hit, d) => hit ?? host.match(new RegExp(`^([a-z0-9-]+)\\.${d}(?::\\d+)?$`)),
      null,
    );

  if (m && !RESERVED.has(m[1])) {
    // Built-app traffic: public by design, never gated.
    const url = req.nextUrl.clone();
    url.pathname = `/apps/${m[1]}${url.pathname === "/" ? "" : url.pathname}`;
    return NextResponse.rewrite(url);
  }

  // Studio access gate. A hosted studio spends real credits (the builder runs
  // on the operator's API key), so when STUDIO_ACCESS_KEY is set, everything
  // except built apps requires it. Unset locally → no gate.
  const accessKey = process.env.STUDIO_ACCESS_KEY;
  if (accessKey) {
    if (req.cookies.get("xvibe_key")?.value === accessKey) return NextResponse.next();

    const supplied = req.nextUrl.searchParams.get("key");
    if (supplied === accessKey) {
      const clean = req.nextUrl.clone();
      clean.searchParams.delete("key");
      const res = NextResponse.redirect(clean);
      res.cookies.set("xvibe_key", supplied, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.nextUrl.protocol === "https:",
        maxAge: 60 * 60 * 24 * 30,
      });
      return res;
    }

    if (req.nextUrl.pathname !== "/unlock") {
      const url = req.nextUrl.clone();
      url.pathname = "/unlock";
      url.search = "";
      return NextResponse.rewrite(url, { status: 401 });
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/).*)"],
};
