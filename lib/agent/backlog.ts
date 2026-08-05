/**
 * lib/agent/backlog.ts — the plan a build runs against.
 *
 * Why a plan exists at all: a build used to be one enormous turn that wrote an
 * app and then summarized it, and the summary described work nobody had
 * checked. Decomposing it buys three things that turn out to be the same
 * thing —
 *
 *   1. a task boundary is the natural place to VERIFY (probe, then receipt),
 *   2. a failed queue is legible where a dead build is silent (2 done, 3
 *      failed, 4-8 pending beats a turn that just stops), and
 *   3. the human review point moves to the cheapest possible moment: reading
 *      a ten-line plan takes seconds, reading a 30KB app.js takes a day.
 *
 * Serial only, deliberately. Parallel task trees multiply an agent across
 * branches nobody is watching; that comes after this flow has earned trust.
 */

export type TaskStatus = "pending" | "running" | "done" | "failed";

/** What a finished task actually did — the honest replacement for a summary. */
export interface TaskReceipt {
  /** workspace files this task wrote or deleted */
  changed: string[];
  /** delivery endpoints this task actually probed */
  probed: string[];
  /** endpoints the shipped code calls that nobody checked — the honesty field */
  unprobed: string[];
  verified: boolean;
  /** one line, in the agent's words, of what changed */
  note: string;
  costUsd: number;
  rounds: number;
  seconds: number;
  error?: string;
}

export interface PlanTask {
  id: string;
  title: string;
  /** the observable condition that makes this task finished */
  doneWhen: string;
  status: TaskStatus;
  receipt?: TaskReceipt;
}

export interface Plan {
  id: string;
  /** the message that produced this plan, kept so tasks retain their why */
  request: string;
  createdAt: string;
  approvedAt?: string;
  tasks: PlanTask[];
}

/** Something worth doing that is NOT in this plan. Named, not silently dropped. */
export interface BacklogItem {
  id: string;
  title: string;
  why: string;
  addedAt: string;
}

export interface PlanState {
  current: Plan | null;
  backlog: BacklogItem[];
}

export const emptyPlanState = (): PlanState => ({ current: null, backlog: [] });

/** Ids only need to be unique within one app's plan, and readable in a log. */
let seq = 0;
const mkId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newPlan(request: string, tasks: { title: string; doneWhen: string }[]): Plan {
  return {
    id: mkId("plan"),
    request,
    createdAt: new Date().toISOString(),
    tasks: tasks.map((t) => ({
      id: mkId("task"),
      title: String(t.title ?? "").slice(0, 200),
      doneWhen: String(t.doneWhen ?? "").slice(0, 300),
      status: "pending" as const,
    })),
  };
}

export const newBacklogItem = (title: string, why: string): BacklogItem => ({
  id: mkId("bl"),
  title: title.slice(0, 200),
  why: why.slice(0, 400),
  addedAt: new Date().toISOString(),
});

export const nextPendingTask = (plan: Plan): PlanTask | undefined =>
  plan.tasks.find((t) => t.status === "pending");

export const planProgress = (plan: Plan) => ({
  done: plan.tasks.filter((t) => t.status === "done").length,
  failed: plan.tasks.filter((t) => t.status === "failed").length,
  pending: plan.tasks.filter((t) => t.status === "pending").length,
  total: plan.tasks.length,
});

/** A plan is finished when nothing is left to run — failures end it too. */
export const isPlanFinished = (plan: Plan): boolean =>
  plan.tasks.every((t) => t.status === "done") || plan.tasks.some((t) => t.status === "failed");

/**
 * The context a running task carries INSTEAD of the whole conversation. This
 * is the cost lever of the whole lane: the old loop re-read up to 80 turns of
 * history every round, and history is re-read like the tool block. A task
 * needs the goal, the shape of the plan, and what earlier tasks left behind —
 * which fits in a few hundred tokens as long as receipts stay one line each.
 */
export function planBrief(plan: Plan, currentId?: string): string {
  const lines = plan.tasks.map((t, i) => {
    const mark =
      t.id === currentId ? "▶ NOW" : t.status === "done" ? "done" : t.status === "failed" ? "FAILED" : "pending";
    const head = `${i + 1}. [${mark}] ${t.title}`;
    if (!t.receipt) return head;
    const r = t.receipt;
    const bits = [
      r.changed.length ? `files: ${r.changed.join(", ")}` : "",
      r.probed.length ? `probed: ${r.probed.join(", ")}` : "",
      r.unprobed.length ? `NOT verified: ${r.unprobed.join(", ")}` : "",
      r.error ? `error: ${r.error}` : "",
    ].filter(Boolean);
    return `${head}\n     → ${r.note}${bits.length ? `\n       (${bits.join(" · ")})` : ""}`;
  });
  return `The user asked for: "${plan.request}"\n\nPLAN (you are executing it one task at a time):\n${lines.join("\n")}`;
}
