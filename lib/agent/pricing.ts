/**
 * lib/agent/pricing.ts — what a turn cost, in dollars.
 *
 * One table, used by the studio, the transcript and the eval harness, so a
 * number quoted in the UI matches the number an eval sweep reports. Rates are
 * list price per million tokens; cache reads bill at ~0.1x input and cache
 * writes at ~1.25x. Verify against current pricing before quoting these
 * externally — they are an estimate shown to the operator, not an invoice.
 */
export interface TokenUsageLike {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Dollars for one turn. Unknown models fall back to the build tier. */
export function estimateCostUsd(u: TokenUsageLike): number {
  const p = PRICES[u.model] ?? PRICES["claude-sonnet-5"];
  return (
    (u.inputTokens * p.in +
      u.cacheReadTokens * p.in * CACHE_READ_MULTIPLIER +
      u.cacheWriteTokens * p.in * CACHE_WRITE_MULTIPLIER +
      u.outputTokens * p.out) /
    1_000_000
  );
}

/** Compact money for a dense UI: sub-cent work should read as "<$0.01", not "$0.00". */
export function formatUsd(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}
