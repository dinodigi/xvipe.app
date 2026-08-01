/**
 * lib/deploy/kv.ts — delivery-token custody at the edge (companion to the
 * worker in workers/edge/).
 *
 * When apps are served by the edge worker instead of the studio host, the
 * worker needs each app's delivery token to inject at /api/v1. It cannot read
 * the studio's disk, so the token is mirrored into a Cloudflare KV namespace:
 * written here, read only by the worker.
 *
 * The custody rule is unchanged (CONNECTION.md §3c): the token never enters a
 * bundle, a browser, or the model's context. R2 holds public bytes; KV holds
 * the credential. Deliberately separate stores.
 *
 * Unconfigured is a normal state — until the zone moves and the worker is
 * deployed, the studio serves apps and injects tokens itself. Every function
 * here no-ops rather than failing a build.
 */

export function kvConfigured(): boolean {
  return Boolean(process.env.CF_API_TOKEN && process.env.CF_KV_NAMESPACE_ID && (process.env.CF_ACCOUNT_ID || process.env.R2_ACCOUNT_ID));
}

export interface KvSyncResult {
  ok: boolean;
  /** absent when the edge is simply not configured yet */
  skipped?: boolean;
  error?: string;
}

const kvUrl = (key: string): string => {
  const account = process.env.CF_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
  return `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
};

/**
 * Mirror one app's delivery token to the edge. Called after minting and again
 * on publish, so an app whose token predates the edge heals on its next
 * deploy. Never throws — the caller reports, the build continues.
 */
export async function syncDeliveryToken(slug: string, token: string): Promise<KvSyncResult> {
  if (!kvConfigured()) return { ok: true, skipped: true };
  try {
    // KV's write API is multipart, not raw-body.
    const form = new FormData();
    form.set("value", token);
    form.set("metadata", JSON.stringify({ slug, syncedAt: new Date().toISOString() }));

    const res = await fetch(kvUrl(`token:${slug}`), {
      method: "PUT",
      headers: { authorization: `Bearer ${process.env.CF_API_TOKEN!.trim()}` },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `KV write failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Remove an app's token from the edge (app deleted, or token revoked). */
export async function removeDeliveryToken(slug: string): Promise<KvSyncResult> {
  if (!kvConfigured()) return { ok: true, skipped: true };
  try {
    const res = await fetch(kvUrl(`token:${slug}`), {
      method: "DELETE",
      headers: { authorization: `Bearer ${process.env.CF_API_TOKEN!.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 404) return { ok: false, error: `KV delete failed: HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
