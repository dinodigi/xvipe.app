# Cloudflare: zone move (CF-1) → edge serving (#10)

Two steps, in order. Step 1 is yours (registrar + dashboard); step 2 is a
deploy I can run once step 1 lands.

Nothing here is urgent — the studio serves apps fine today. This buys CDN
speed, takes app traffic off the Render dyno, and is the prerequisite for
custom domains (#18) and per-app functions (#17).

---

## Step 1 — move the `xvibe.app` zone to Cloudflare ⚑ you

Today `xvibe.app` DNS is authoritative at **Namecheap**
(`dns1/dns2.registrar-servers.com`). Cloudflare cannot attach a Worker route
to a zone it does not host, so the zone has to move. The domain stays
registered at Namecheap — only the nameservers change.

1. **Cloudflare → Add a site → `xvibe.app`**, Free plan. Use the account that
   already holds `pluggie.app` and the `xvibe-apps` R2 bucket
   (Partners@dinodigi.com).
2. Cloudflare scans and imports the existing records. **Check the import
   before continuing** — it must contain the records that keep the studio and
   apps alive today:
   - the apex `xvibe.app` → Render
   - `www` → Render
   - the `*.apps.xvibe.app` wildcard → Render
   Anything missing, add by hand now. A missing record here is downtime.
3. Set the two Cloudflare nameservers at **Namecheap → Domain List →
   xvibe.app → Nameservers → Custom DNS**. Save. (Namecheap's save is a
   two-step: the row, then the tick.)
4. Wait for Cloudflare to report the zone **Active** (usually minutes, up to
   24h). Nothing breaks meanwhile: the old records answer until the switch.
5. **Proxy status**: leave the apex/`www`/wildcard records **proxied**
   (orange cloud). That is what lets a Worker route intercept them.

**Verify before moving on** — apex still loads the gated studio, and an app
subdomain still serves:

```bash
curl -sI https://xvibe.app/ | head -1
curl -sI https://xvibe.apps.xvibe.app/ | head -1
```

### While you are there: the `*.xvibe.app` wildcard

Still outstanding from the board. Once the zone is on Cloudflare this is one
record instead of a Namecheap/Render dance:

- `CNAME  *  →  <the Render service hostname>`, proxied.
- Then flip `XVIBE_APPS_BASE_DOMAIN` from `apps.xvibe.app` to `xvibe.app` in
  the Render dashboard.

Apps then live at `<app>.xvibe.app` — the short URL that was always the plan.

---

## Step 2 — deploy the edge worker (#10) — me, after step 1

Written and tested already: `workers/edge/` (15/15 behaviour tests green via
`node workers/edge/test.mjs` — routing, SPA fallback, caching, 304s, token
injection, cookie stripping, pass-through).

What it does per request to `<app>.xvibe.app`:

| Path | Behaviour |
|---|---|
| `/api/v1/*` | proxies to Pluggie delivery, **injecting the app's token at the edge** — the bundle still ships with no credential |
| anything else | serves `<slug>/v<N>/…` from R2, resolved through `<slug>/current.json` |
| apex / `www` / `studio` / other reserved labels | passes straight through to the studio origin |

Assets are cached immutably (the version prefix guarantees it) while HTML
revalidates, so a publish or a rollback is live immediately.

**Token custody at the edge.** A static app has no server, so the serving edge
*is* its server environment. The worker reads each token from a **KV
namespace** — never from R2 (public bytes) and never from the bundle. The
studio writes it (`lib/deploy/kv.ts`) when the builder mints a token, and
re-writes it on every publish, so older apps heal on their next deploy.

Deploy:

```bash
cd workers/edge && npx wrangler kv namespace create XVIBE_TOKENS && npx wrangler deploy
```

Then set on Render, so the studio starts mirroring tokens to the edge:

- `CF_API_TOKEN` — a scoped API token with **Workers KV Storage: Edit**
- `CF_KV_NAMESPACE_ID` — the id printed by the `kv namespace create` command
- `CF_ACCOUNT_ID` — optional; falls back to `R2_ACCOUNT_ID`

Until those exist the sync is a silent no-op and the studio keeps serving apps
itself, which is exactly the fallback we want.

**Rollout check**: publish any app, load it, submit a form. `x-xvibe-version`
in the response headers tells you the worker served it; a `503
E_APP_NOT_CONNECTED` on `/api/v1` means the KV token never synced — re-publish
to heal.
