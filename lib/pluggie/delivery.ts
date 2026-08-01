/**
 * lib/pluggie/delivery.ts — the one place that knows where Pluggie's
 * delivery API lives. Used by the serving proxy (token injection) and by
 * probe_app (build-time smoke tests) so the two can never drift apart.
 */
export const DELIVERY_BASE = (): string =>
  process.env.PLUGGIE_DELIVERY_BASE ?? "https://pluggie.app/api/v1";
