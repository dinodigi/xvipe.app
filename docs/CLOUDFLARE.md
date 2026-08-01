# Cloudflare: zone move (CF-1) → edge serving (#10)

Two steps, in order. Step 1 is yours (registrar + dashboard); step 2 is a
deploy I can run once step 1 lands.

Nothing here is urgent — the studio serves apps fine today. This buys CDN
speed, takes app traffic off the Render dyno, and is the prerequisite for
custom domains (#18) and per-app functions (#17).

---

## Step 1 — move the `xvibe.app` zone to Cloudflare ✅ DONE 2026-07-31

Nameservers `damian.ns.cloudflare.com` / `deb.ns.cloudflare.com`, switched at
20:59 PDT; delegation propagated within minutes. All 11 records serve from
Cloudflare, **all still DNS-only (grey cloud)**. Kept for the record because
the method is reusable for the next domain — and because Cloudflare's scan
silently missed all three CNAMEs, two of which are Render's cert-verification
records.

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

## Step 2 — deploy the edge worker (#10) ✅ DEPLOYED + VERIFIED 2026-08-01

`xvibe-edge` is live on Cloudflare (version `0ef48bd1`), route `*.xvibe.app/*`,
bindings: `TOKENS` KV (`4cf7af4bb17d441a9c74e63f60a01282`), `BUNDLES` →
`xvibe-apps`. **It serves no production traffic yet** — every real record is
still DNS-only, so the route cannot fire on them.

Proven end to end against `xvibe.xvibe.app`, a throwaway proxied hostname
added for the test (nothing else used it, so nothing could break):

| Check | Result |
|---|---|
| page served from R2 via `current.json` | 200, `x-xvibe-version: 7` |
| HTML revalidates, assets immutable | `max-age=0, must-revalidate` / `max-age=31536000, immutable` |
| SPA fallback on extensionless route | 200 |
| missing asset | real 404 |
| `GET /api/v1/…` with edge-injected token | 200 + real rows |
| **`POST /api/v1/…` (form submission)** | **201 Created** |
| cookies forwarded upstream | none (stripped) |

Known limitation: Cloudflare strips the ETag from compressed streamed Worker
responses, so HTML revalidation re-fetches instead of answering 304. Cost is
one small HTML body; versioned assets are immutable and unaffected.

### Remaining for full cutover

1. Set `CLOUDFLARE_API_TOKEN` + `CF_KV_NAMESPACE_ID` on Render so publishing
   mirrors each app's delivery token to KV automatically (today one token was
   written by hand for the test).
2. Move traffic by orange-clouding `*.apps` — or skip straight to Step 3 and
   put the short `<app>.xvibe.app` form on the edge instead.
3. Delete the temporary `xvibe` CNAME once the real path is live.

---

## Step 2 (original plan) — deploy the edge worker

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

### Order of operations (matters)

Everything is DNS-only today, which means **a Worker route cannot fire yet** —
routes only intercept hostnames that resolve *through* Cloudflare. Use that:
deploy the worker while it is still inert, then switch traffic to it one
record at a time.

1. `wrangler kv namespace create` + `wrangler deploy` — route exists, fires on
   nothing. Zero risk.
2. Set `CF_API_TOKEN` / `CF_KV_NAMESPACE_ID` on Render, then **re-publish one
   app** so its delivery token lands in KV.
3. Proxy **one** record (orange-cloud `*.apps`) and test that app end to end —
   page loads, form submits, `x-xvibe-version` present.
4. Only then consider the apex/`www`, which the studio serves and the worker
   deliberately passes through.

Rollback at any point is one click: grey-cloud the record and traffic returns
to Render exactly as before.

---

## Step 3 — short URLs (`<app>.xvibe.app`) — separate change

The current wildcard is `*.apps`, so apps live at `<app>.apps.xvibe.app`. For
the short form:

1. Cloudflare: add `CNAME  *  →  <render service hostname>`.
2. Render: add `*.xvibe.app` as a custom domain and satisfy its verification.
3. Flip `XVIBE_APPS_BASE_DOMAIN` from `apps.xvibe.app` to `xvibe.app`.

Do this *after* the worker rollout, not during — one moving part at a time.
Note the worker already handles both shapes: it treats a label containing a
dot (`foo.apps`) as not-an-app and passes it through, so the old URLs keep
working during the transition.
