/**
 * lib/agent/teardown.ts — delete every collection in a project, in an order
 * that actually works.
 *
 * `delete_collection` refuses while another collection still points a relation
 * field at the target (E_BLOCKED). That guardrail is correct, but it makes a
 * naive loop fail on two shapes:
 *
 *   - a chain (A → B): delete B first and you are blocked; the order matters.
 *   - a CYCLE (A ⇄ B): no order works at all. This project has a live one —
 *     service_windows.current_ticket → queue_tickets, and queue_tickets.window
 *     → service_windows. Neither side can go first, so a wipe just deadlocks.
 *
 * The fix for a cycle is to drop the relation FIELD first (define_collection is
 * full-replace, so re-sending the shape minus that field removes it), which
 * breaks the edge and lets the normal order proceed. The agent shouldn't have
 * to rediscover that recipe mid-build, and today it can't — it just fails.
 *
 * Everything here is HTTP/MCP against Pluggie. No Pluggie source, no database.
 */
import { callTool } from "@/lib/pluggie/mcp";

interface FieldShape {
  name: string;
  type?: string;
  /** relation targets have gone by a few names across versions — read them all */
  target?: string;
  targetCollection?: string;
  collection?: string;
  [k: string]: unknown;
}

export interface TeardownReport {
  deleted: string[];
  /** collections whose relation fields were stripped to break a cycle */
  brokeCycles: string[];
  /** anything still standing when we gave up — empty on success */
  remaining: string[];
  steps: string[];
  dryRun: boolean;
}

/** The collection a relation field points at, whatever key the shape used. */
const relationTarget = (f: FieldShape): string | undefined => {
  if ((f.type ?? "").toLowerCase() !== "relation") return undefined;
  const t = f.target ?? f.targetCollection ?? f.collection;
  return typeof t === "string" && t ? t : undefined;
};

/** Unwrap the various envelopes list_collections has used. */
function collectionNames(raw: unknown): string[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (["collections", "items", "data", "results"]
          .map((k) => (raw as Record<string, unknown>)[k])
          .find(Array.isArray) as unknown[] | undefined)
      : undefined;
  if (!arr) return [];
  return arr
    .map((c) => (typeof c === "string" ? c : ((c as { name?: string })?.name ?? "")))
    .filter(Boolean);
}

function fieldsOf(raw: unknown): FieldShape[] {
  const f = (raw as { fields?: unknown })?.fields;
  return Array.isArray(f) ? (f as FieldShape[]) : [];
}

/**
 * Delete every collection in the project. Returns what happened rather than
 * throwing on partial progress — a half-finished teardown that says so is far
 * more useful than an exception that hides which half.
 */
export async function teardownBackend(
  mcpToken: string,
  opts: { dryRun?: boolean } = {},
): Promise<TeardownReport> {
  const dryRun = Boolean(opts.dryRun);
  const report: TeardownReport = { deleted: [], brokeCycles: [], remaining: [], steps: [], dryRun };

  let remaining = collectionNames(await callTool<unknown>("list_collections", {}, mcpToken));
  if (!remaining.length) {
    report.steps.push("nothing to delete — the project has no collections");
    return report;
  }
  report.steps.push(`found ${remaining.length}: ${remaining.join(", ")}`);

  // Read every shape once. Relations are the only thing that constrains order.
  const shapes = new Map<string, FieldShape[]>();
  await Promise.all(
    remaining.map(async (name) => {
      try {
        shapes.set(name, fieldsOf(await callTool<unknown>("describe_collection", { name }, mcpToken)));
      } catch {
        shapes.set(name, []); // unreadable shape: assume no relations and let delete_collection arbitrate
      }
    }),
  );

  /** Who still points at `name`, among collections not yet deleted? */
  const inboundFrom = (name: string, alive: string[]): string[] =>
    alive.filter(
      (other) => other !== name && (shapes.get(other) ?? []).some((f) => relationTarget(f) === name),
    );

  // Bounded: each pass either deletes something or breaks a cycle, and both
  // shrink the problem. The cap is a backstop against an upstream surprise.
  for (let pass = 0; remaining.length && pass < remaining.length * 3 + 10; pass++) {
    const free = remaining.filter((name) => inboundFrom(name, remaining).length === 0);

    if (free.length) {
      for (const name of free) {
        if (dryRun) {
          report.steps.push(`would delete ${name}`);
        } else {
          try {
            await callTool<unknown>("delete_collection", { name, confirm: true }, mcpToken);
            report.steps.push(`deleted ${name}`);
          } catch (e) {
            report.steps.push(`could NOT delete ${name}: ${e instanceof Error ? e.message : String(e)}`);
            continue; // leave it in `remaining` so the report shows it survived
          }
        }
        report.deleted.push(name);
        remaining = remaining.filter((n) => n !== name);
      }
      continue;
    }

    // Nothing is free ⇒ every survivor has an inbound relation ⇒ there is a
    // cycle. Break it on the collection holding the most outbound relations
    // (removes the most edges per redefine).
    const holder = [...remaining].sort(
      (a, b) =>
        (shapes.get(b) ?? []).filter((f) => relationTarget(f)).length -
        (shapes.get(a) ?? []).filter((f) => relationTarget(f)).length,
    )[0];
    const kept = (shapes.get(holder) ?? []).filter((f) => !relationTarget(f));
    const dropped = (shapes.get(holder) ?? []).filter((f) => relationTarget(f)).map((f) => f.name);

    if (!dropped.length) {
      // A cycle with no droppable edge means our shape read was wrong. Stop
      // rather than spin — the report says exactly what is still standing.
      report.steps.push(`stuck: ${remaining.join(", ")} block each other but no relation field is visible to drop`);
      break;
    }

    if (dryRun) {
      report.steps.push(`would strip relation field(s) ${dropped.join(", ")} from ${holder} to break a cycle`);
    } else {
      try {
        // Full-replace minus the relation fields. The collection is about to be
        // deleted, so dropping access/workflow along with them costs nothing —
        // and sending a minimal shape avoids round-tripping a definition whose
        // addFields path is known to lose `access` silently.
        await callTool<unknown>("define_collection", { name: holder, fields: kept, confirm: true }, mcpToken);
        report.steps.push(`stripped ${dropped.join(", ")} from ${holder} — cycle broken`);
      } catch (e) {
        report.steps.push(`could NOT break the cycle at ${holder}: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
    shapes.set(holder, kept);
    report.brokeCycles.push(holder);
  }

  report.remaining = remaining;
  return report;
}
