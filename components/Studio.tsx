"use client";

/**
 * The studio, v3 — IDE workbench (docs/design/prototype-v3.html made real).
 * Agent panel left; right stage hosts TOOLS behind a Tools menu + tab strip:
 * Preview (browser chrome + device widths), Code, Deploys (real R2/local
 * versions + rollback), Data (live MCP reads), Logs (Pluggie delivery log).
 * Analytics stays "soon" until it has an honest data source.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppMeta, DeployVersionInfo, TranscriptEvent, WsFile } from "@/lib/apps/store";
import type { AgentEvent, TurnUsage } from "@/lib/agent/events";
import type { Plan, PlanTask, TaskReceipt } from "@/lib/agent/backlog";
import { estimateCostUsd, formatUsd } from "@/lib/agent/pricing";
import { DEFAULT_EFFORT, EFFORTS, EFFORT_BLURB, isEffort, type Effort } from "@/lib/agent/models";

type Item =
  | { kind: "text"; text: string }
  | { kind: "step"; id?: string; name: string; label: string; state: "wait" | "ok" | "fail"; summary?: string }
  /** end-of-turn receipt: what this build actually cost */
  | { kind: "checkpoint"; usage: TurnUsage }
  /** a proposed plan, awaiting the user's approval — nothing built yet */
  | { kind: "plan"; planId: string }
  /** one task of a running plan, with its receipt once it finishes */
  | { kind: "task"; id: string; title: string; index: number; total: number; state: "wait" | "ok" | "fail"; receipt?: TaskReceipt };
interface Block {
  role: "user" | "agent";
  items: Item[];
}

const STARTERS = [
  "Build me a lead desk for a roofing company — site form in, triage to a site visit",
  "A booking page for a barber — pick a slot, no double-booking",
  "Support inbox with a staff sign-in and a status pipeline",
];
const FOLLOWUPS = ["Add a nightly cleanup job", "Let staff filter and search", "Make the empty states friendlier"];

/* ── tool registry ── */
const ICONS: Record<string, string> = {
  preview:
    '<circle cx="12" cy="12" r="9"/><path d="M3.5 12h17M12 3.5c2.6 2.3 4 5.2 4 8.5s-1.4 6.2-4 8.5c-2.6-2.3-4-5.2-4-8.5s1.4-6.2 4-8.5Z"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  deploys: '<path d="M12 3v12m0-12L7.5 7.5M12 3l4.5 4.5"/><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3"/>',
  data: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5V12c0 1.7 3.6 3 8 3s8-1.3 8-3V5.5M4 12v6.5c0 1.7 3.6 3 8 3s8-1.3 8-3V12"/>',
  analytics: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  logs: '<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>',
  theme:
    '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18 4.5 4.5 0 0 1 0-9 4.5 4.5 0 0 0 0-9Z"/>',
};
const TOOLS: { id: string; name: string; soon?: boolean }[] = [
  { id: "preview", name: "Preview" },
  { id: "code", name: "Code" },
  { id: "theme", name: "Theme" },
  { id: "deploys", name: "Deploys" },
  { id: "data", name: "Data" },
  { id: "logs", name: "Logs" },
  { id: "analytics", name: "Analytics", soon: true },
];
function ToolIcon({ id, className }: { id: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[id] ?? "" }}
    />
  );
}

export function Studio(props: {
  app: AppMeta;
  apps: AppMeta[];
  projectId: string;
  projectName: string;
  dbStatus: string;
  attention: string[];
  endUserAuth: boolean;
  /** where PUBLISHED apps live (edge/R2) — used for the publish result + status bar */
  appsDomain?: string;
  /** where the LIVE workspace is served — the preview must show unpublished edits */
  previewDomain?: string;
  /** short commit sha this studio is running, so deploys are verifiable */
  build?: string;
  initialTranscript: TranscriptEvent[];
  initialFiles: WsFile[];
}) {
  const { app, projectName } = props;

  /* chat */
  const [blocks, setBlocks] = useState<Block[]>(() => fromTranscript(props.initialTranscript));
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  /** A proposed, not-yet-approved plan. Survives a refresh — it lives on disk. */
  const [plan, setPlan] = useState<Plan | null>(null);
  const [lastUsage, setLastUsage] = useState<TurnUsage | null>(null);
  /** Running total for this session — the number that answers "what am I spending?" */
  const [spentUsd, setSpentUsd] = useState(0);
  const [modelPin, setModelPin] = useState<string>(app.modelPin ?? "auto");
  const [effort, setEffort] = useState<Effort>(isEffort(app.effortPin) ? app.effortPin : DEFAULT_EFFORT);
  // Effort is rejected outright by the fast tier, so the control is disabled
  // when the turn is certain to run there. Under Auto it stays live: the
  // router may pick either tier, and the builder drops it when it picks Haiku.
  const effortApplies = modelPin !== "haiku";
  const msgsRef = useRef<HTMLDivElement>(null);

  /* files / code */
  const [files, setFiles] = useState<WsFile[]>(props.initialFiles);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [fileContent, setFileContent] = useState("");

  /* tools */
  const [openTools, setOpenTools] = useState<string[]>(["preview"]);
  const [activeTool, setActiveTool] = useState("preview");
  const [toolsMenu, setToolsMenu] = useState(false);
  const [appMenu, setAppMenu] = useState(false);
  const toolsBtnRef = useRef<HTMLButtonElement>(null);
  const appBtnRef = useRef<HTMLButtonElement>(null);

  /* preview */
  const [devW, setDevW] = useState("");
  const [frameNonce, setFrameNonce] = useState(0);
  const [origin, setOrigin] = useState<{ protocol: string; port: string; isLocal: boolean } | null>(null);
  const reloadRef = useRef<SVGSVGElement>(null);

  /* deploys / data / logs */
  const [deploys, setDeploys] = useState<{ versions: DeployVersionInfo[]; live: number | null }>({ versions: [], live: null });
  const [rbConfirm, setRbConfirm] = useState<number | null>(null);
  const [dataCols, setDataCols] = useState<string[]>([]);
  const [dataActive, setDataActive] = useState<string | undefined>();
  const [dataRows, setDataRows] = useState<{ id: string; data: Record<string, unknown> }[]>([]);
  const [dataCount, setDataCount] = useState<number | undefined>();
  const [dataErr, setDataErr] = useState<string | undefined>();
  const [logs, setLogs] = useState<Record<string, unknown>[]>([]);
  const [logsErr, setLogsErr] = useState<string | undefined>();

  /* theme */
  interface ThemeCard { id: string; name: string; suits: string; swatch: string[]; fontDisplay: string; radius: string }
  const [themes, setThemes] = useState<ThemeCard[]>([]);
  const [themeId, setThemeId] = useState<string | undefined>(app.themeId);
  const [themeBusy, setThemeBusy] = useState<string | undefined>();

  /* palette + misc */
  const [palOpen, setPalOpen] = useState(false);
  const [palQ, setPalQ] = useState("");
  const [palSel, setPalSel] = useState(0);
  const palInputRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState<{ ok: boolean; title: string; url?: string; sub?: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(Boolean(app.publishedVersion));
  const [agentW, setAgentW] = useState(392);
  const dividerRef = useRef<HTMLDivElement>(null);
  /** Lets Stop cut the request client-side the instant it is pressed. */
  const chatAbortRef = useRef<AbortController | null>(null);

  const stopBuild = useCallback(async () => {
    chatAbortRef.current?.abort();
    // Also tell the server: closing our stream alone would leave the loop
    // running there, still spending.
    try {
      await fetch(`/api/apps/${app.slug}/chat`, { method: "DELETE" });
    } catch {
      /* the abort above already stopped our side */
    }
  }, [app.slug]);

  useEffect(() => {
    const h = window.location.hostname;
    setOrigin({ protocol: window.location.protocol, port: window.location.port, isLocal: h === "localhost" || h.endsWith(".localhost") });
  }, []);
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [blocks]);

  // The preview deliberately uses the PREVIEW domain, not the published one:
  // published apps are served by the edge from the last R2 snapshot, so
  // pointing the iframe there would hide the agent's edits until publish.
  const previewDomain = props.previewDomain ?? props.appsDomain;
  const previewUrl = origin
    ? origin.isLocal
      ? `${origin.protocol}//${app.slug}.localhost${origin.port ? `:${origin.port}` : ""}/`
      : previewDomain
        ? `https://${app.slug}.${previewDomain}/`
        : `/apps/${app.slug}/`
    : undefined;
  // The address bar shows the host the iframe is ACTUALLY loading.
  const previewHost = origin?.isLocal
    ? `${app.slug}.localhost${origin.port ? `:${origin.port}` : ""}`
    : previewDomain
      ? `${app.slug}.${previewDomain}`
      : `/apps/${app.slug}/`;

  // The published snapshot lives on a DIFFERENT host to the preview, and the
  // two are easy to confuse — so link it explicitly once the app has shipped.
  // Shown in local dev too: publishing from a local studio still uploads to R2
  // and the short URL really does serve it, so hiding the link would lie.
  const publishedUrl = published && props.appsDomain ? `https://${app.slug}.${props.appsDomain}/` : undefined;

  /* ── data fetchers ── */
  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/${app.slug}/files`);
      if (res.ok) setFiles(((await res.json()) as { files: WsFile[] }).files);
    } catch {}
  }, [app.slug]);

  const loadDeploys = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/${app.slug}/deploys`);
      if (res.ok) setDeploys((await res.json()) as { versions: DeployVersionInfo[]; live: number | null });
    } catch {}
  }, [app.slug]);

  const loadDataCols = useCallback(async () => {
    setDataErr(undefined);
    try {
      const res = await fetch(`/api/apps/${app.slug}/data`);
      const body = (await res.json()) as { collections?: string[]; error?: string };
      if (!res.ok) setDataErr(body.error ?? `HTTP ${res.status}`);
      else {
        setDataCols(body.collections ?? []);
        if (!dataActive && body.collections?.length) void loadDataRows(body.collections[0]);
      }
    } catch (e) {
      setDataErr(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.slug, dataActive]);

  const loadDataRows = useCallback(
    async (collection: string) => {
      setDataActive(collection);
      setDataErr(undefined);
      try {
        const res = await fetch(`/api/apps/${app.slug}/data?collection=${encodeURIComponent(collection)}`);
        const body = (await res.json()) as { entries?: { id: string; data: Record<string, unknown> }[]; count?: number; error?: string };
        if (!res.ok) setDataErr(body.error ?? `HTTP ${res.status}`);
        else {
          setDataRows(body.entries ?? []);
          setDataCount(body.count);
        }
      } catch (e) {
        setDataErr(String(e));
      }
    },
    [app.slug],
  );

  const loadThemes = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/${app.slug}/theme`);
      if (!res.ok) return;
      const body = (await res.json()) as { current: string | null; themes: ThemeCard[] };
      setThemes(body.themes);
      setThemeId(body.current ?? undefined);
    } catch {}
  }, [app.slug]);

  const loadLogs = useCallback(async () => {
    setLogsErr(undefined);
    try {
      const res = await fetch(`/api/apps/${app.slug}/logs`);
      const body = (await res.json()) as { items?: Record<string, unknown>[]; error?: string };
      if (!res.ok) setLogsErr(body.error ?? `HTTP ${res.status}`);
      else setLogs(Array.isArray(body.items) ? body.items : []);
    } catch (e) {
      setLogsErr(String(e));
    }
  }, [app.slug]);

  const openTool = useCallback(
    (id: string) => {
      const tool = TOOLS.find((t) => t.id === id);
      if (!tool || tool.soon) return;
      setOpenTools((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActiveTool(id);
      setToolsMenu(false);
      if (id === "deploys") void loadDeploys();
      if (id === "data") void loadDataCols();
      if (id === "logs") void loadLogs();
      if (id === "theme") void loadThemes();
    },
    [loadDeploys, loadDataCols, loadLogs, loadThemes],
  );
  const closeTool = useCallback(
    (id: string) => {
      setOpenTools((prev) => prev.filter((t) => t !== id));
      setActiveTool((cur) => (cur === id ? "preview" : cur));
    },
    [],
  );

  const bumpPreview = useCallback(() => {
    setFrameNonce((n) => n + 1);
    const svg = reloadRef.current;
    if (svg) {
      svg.classList.remove("spinning");
      void svg.getBoundingClientRect();
      svg.classList.add("spinning");
    }
  }, []);

  // Declared after bumpPreview: applying a theme reloads the preview so the
  // new look lands immediately — that instant feedback is the feature.
  const chooseTheme = useCallback(
    async (id: string) => {
      if (themeBusy) return;
      setThemeBusy(id);
      try {
        const res = await fetch(`/api/apps/${app.slug}/theme`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ theme: id }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (res.ok && body.ok) {
          setThemeId(id);
          void refreshFiles();
          bumpPreview();
        } else {
          setToast({ ok: false, title: "Couldn't apply theme", sub: body.error });
          setTimeout(() => setToast(null), 4200);
        }
      } catch (e) {
        setToast({ ok: false, title: "Couldn't apply theme", sub: e instanceof Error ? e.message : String(e) });
        setTimeout(() => setToast(null), 4200);
      } finally {
        setThemeBusy(undefined);
      }
    },
    [app.slug, themeBusy, refreshFiles, bumpPreview],
  );

  /* ── chat send (SSE) ──
     One streaming path for both kinds of turn: a message the user typed, and
     "run the plan you already approved", which has no message at all. */
  const runStream = useCallback(
    async (body: Record<string, unknown>, echo?: string) => {
      if (busy) return;
      setBusy(true);
      setBlocks((b) => [
        ...b,
        ...(echo ? [{ role: "user" as const, items: [{ kind: "text" as const, text: echo }] }] : []),
        { role: "agent", items: [] },
      ]);

      const apply = (ev: AgentEvent) =>
        setBlocks((prev) => {
          const next = prev.slice();
          const cur = { ...next[next.length - 1], items: next[next.length - 1].items.slice() };
          next[next.length - 1] = cur;
          const dropReasoning = () => {
            cur.items = cur.items.filter((it) => !(it.kind === "step" && it.name === "__thinking"));
          };
          if (ev.type === "route") {
            cur.items.push({
              kind: "step",
              name: "__route",
              label: `${ev.route} → ${ev.model.replace("claude-", "")}`,
              state: "ok",
              summary: ev.why,
            });
          } else if (ev.type === "thinking") {
            const last = cur.items[cur.items.length - 1];
            if (!(last?.kind === "step" && last.name === "__thinking"))
              cur.items.push({ kind: "step", name: "__thinking", label: "reasoning", state: "wait" });
          } else if (ev.type === "text_delta") {
            dropReasoning();
            const last = cur.items[cur.items.length - 1];
            if (last?.kind === "text") cur.items[cur.items.length - 1] = { kind: "text", text: last.text + ev.text };
            else cur.items.push({ kind: "text", text: ev.text });
          } else if (ev.type === "tool_start") {
            dropReasoning();
            cur.items.push({ kind: "step", id: ev.id, name: ev.name, label: ev.label, state: "wait" });
          } else if (ev.type === "tool_done") {
            // Match on the tool_use id when we have one. Matching by name alone
            // mispaired results whenever a round ran several calls to the same
            // tool concurrently — which is the common case for reads/writes.
            for (let i = cur.items.length - 1; i >= 0; i--) {
              const it = cur.items[i];
              if (it.kind !== "step" || it.state !== "wait") continue;
              const hit = ev.id && it.id ? it.id === ev.id : it.name === ev.name;
              if (hit) {
                cur.items[i] = { ...it, state: ev.ok ? "ok" : "fail", summary: ev.summary };
                break;
              }
            }
          } else if (ev.type === "plan") {
            dropReasoning();
            cur.items.push({ kind: "plan", planId: ev.plan.id });
          } else if (ev.type === "task_start") {
            dropReasoning();
            cur.items.push({ kind: "task", id: ev.id, title: ev.title, index: ev.index, total: ev.total, state: "wait" });
          } else if (ev.type === "task_done") {
            for (let i = cur.items.length - 1; i >= 0; i--) {
              const it = cur.items[i];
              if (it.kind === "task" && it.id === ev.id) {
                cur.items[i] = { ...it, state: ev.ok ? "ok" : "fail", receipt: ev.receipt };
                break;
              }
            }
          } else if (ev.type === "turn_done" && ev.usage) {
            dropReasoning();
            cur.items.push({ kind: "checkpoint", usage: ev.usage });
          } else if (ev.type === "error") {
            cur.items.push({ kind: "text", text: `\n⚠ ${ev.message}` });
          }
          return next;
        });

      try {
        const ac = new AbortController();
        chatAbortRef.current = ac;
        const res = await fetch(`/api/apps/${app.slug}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, model: modelPin, effort }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          apply({ type: "error", message: err.error ?? `chat failed (${res.status})` });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            let ev: AgentEvent;
            try {
              ev = JSON.parse(data) as AgentEvent;
            } catch {
              continue;
            }
            apply(ev);
            if (ev.type === "plan") setPlan(ev.plan);
            if (ev.type === "files_changed") {
              void refreshFiles();
              bumpPreview();
            }
            if (ev.type === "turn_done" && ev.usage) {
              setLastUsage(ev.usage);
              setSpentUsd((s) => s + (ev.usage!.costUsd ?? estimateCostUsd(ev.usage!)));
            }
          }
        }
      } catch (e) {
        // An abort is the user pressing Stop, not a failure to report.
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          apply({ type: "error", message: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        chatAbortRef.current = null;
        setBusy(false);
        void refreshFiles();
        bumpPreview();
      }
    },
    [app.slug, busy, modelPin, effort, refreshFiles, bumpPreview],
  );

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      setInput("");
      await runStream({ message }, message);
    },
    [busy, runStream],
  );

  /* ── plan review ──
     The cheapest moment to change the outcome: editing a ten-line task list
     costs seconds, editing a finished app costs a day. Approve records
     consent; the run is a second call so a plan can be re-run after a stop. */
  const approvePlan = useCallback(async () => {
    if (!plan) return;
    const res = await fetch(`/api/apps/${app.slug}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", tasks: plan.tasks }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setToast({ ok: false, title: "Couldn't start the plan", sub: err.error });
      setTimeout(() => setToast(null), 5000);
      return;
    }
    setPlan(null);
    await runStream({ runPlan: true });
  }, [app.slug, plan, runStream]);

  const discardPlan = useCallback(async () => {
    await fetch(`/api/apps/${app.slug}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "discard" }),
    });
    setPlan(null);
  }, [app.slug]);

  /** Edit in place — drop, retitle, or move a task before any of it runs. */
  const editPlan = useCallback((mutate: (tasks: PlanTask[]) => PlanTask[]) => {
    setPlan((p) => (p ? { ...p, tasks: mutate(p.tasks.slice()) } : p));
  }, []);

  /* ── code viewer ── */
  const openFile = useCallback(
    async (path: string) => {
      setSelectedFile(path);
      setFileContent("… loading");
      try {
        const res = await fetch(`/api/apps/${app.slug}/files?path=${encodeURIComponent(path)}`);
        const body = (await res.json()) as { content?: string; error?: string };
        setFileContent(body.content ?? `⚠ ${body.error ?? "failed to read"}`);
      } catch (e) {
        setFileContent(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [app.slug],
  );

  /* ── publish / rollback ── */
  const publish = useCallback(async () => {
    if (publishing || busy) return;
    setPublishing(true);
    try {
      const res = await fetch(`/api/apps/${app.slug}/publish`, { method: "POST" });
      const body = (await res.json()) as { url?: string; version?: number; note?: string; error?: string };
      if (res.ok && body.url) {
        setPublished(true);
        setToast({ ok: true, title: `Published v${body.version}.`, url: body.url, sub: body.note });
        void loadDeploys();
      } else setToast({ ok: false, title: "Publish failed", sub: body.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setToast({ ok: false, title: "Publish failed", sub: e instanceof Error ? e.message : String(e) });
    } finally {
      setPublishing(false);
      setTimeout(() => setToast(null), 5200);
    }
  }, [app.slug, publishing, busy, loadDeploys]);

  const rollback = useCallback(
    async (version: number) => {
      if (rbConfirm !== version) {
        setRbConfirm(version);
        setTimeout(() => setRbConfirm((v) => (v === version ? null : v)), 3000);
        return;
      }
      setRbConfirm(null);
      try {
        const res = await fetch(`/api/apps/${app.slug}/deploys`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rollback: version }),
        });
        const body = (await res.json()) as { ok?: boolean; note?: string; versions?: DeployVersionInfo[]; live?: number; error?: string };
        if (res.ok && body.ok) {
          setDeploys({ versions: body.versions ?? [], live: body.live ?? version });
          setToast({ ok: true, title: `Rolled back to v${version}.`, sub: body.note });
          void refreshFiles();
          bumpPreview();
        } else setToast({ ok: false, title: "Rollback failed", sub: body.error ?? `HTTP ${res.status}` });
      } catch (e) {
        setToast({ ok: false, title: "Rollback failed", sub: e instanceof Error ? e.message : String(e) });
      }
      setTimeout(() => setToast(null), 5200);
    },
    [app.slug, rbConfirm, refreshFiles, bumpPreview],
  );

  /* ── divider drag ── */
  useEffect(() => {
    const div = dividerRef.current;
    if (!div) return;
    const down = (e: PointerEvent) => {
      e.preventDefault();
      div.classList.add("drag");
      const move = (ev: PointerEvent) => setAgentW(Math.min(560, Math.max(300, ev.clientX)));
      const up = () => {
        div.classList.remove("drag");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    div.addEventListener("pointerdown", down);
    return () => div.removeEventListener("pointerdown", down);
  }, []);

  // A plan proposed just before a refresh is still waiting to be approved —
  // reload it rather than stranding the user with work they cannot start.
  useEffect(() => {
    let live = true;
    void fetch(`/api/apps/${app.slug}/plan`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { current?: Plan | null } | null) => {
        if (live && s?.current && !s.current.approvedAt) setPlan(s.current);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.slug]);

  /* ── palette ── */
  const commands = useMemo(
    () => [
      { label: "Publish", k: "⇧⌘P", run: publish },
      ...TOOLS.filter((t) => !t.soon).map((t) => ({ label: `Open ${t.name}`, run: () => openTool(t.id) })),
      { label: "Reload preview", run: bumpPreview },
      { label: "Device: fluid", run: () => setDevW("") },
      { label: "Device: tablet · 768", run: () => setDevW("768") },
      { label: "Device: phone · 390", run: () => setDevW("390") },
      { label: "New app…", run: () => void newApp() },
      { label: "Start fresh — clear this chat (keeps files)", run: () => void resetApp({}) },
      { label: "Start fresh — clear chat AND app files", run: () => void resetApp({ files: true }) },
      { label: "Start fresh — wipe EVERYTHING, backend included", run: () => void resetApp({ files: true, backend: true }) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publish, openTool, bumpPreview],
  );
  const palHits = useMemo(
    () => commands.filter((c) => c.label.toLowerCase().includes(palQ.trim().toLowerCase())),
    [commands, palQ],
  );
  useEffect(() => {
    if (palOpen) {
      setPalQ("");
      setPalSel(0);
      setTimeout(() => palInputRef.current?.focus(), 30);
    }
  }, [palOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setPalOpen(false);
        setToolsMenu(false);
        setAppMenu(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Clears the STUDIO's memory of this app, and optionally the backend with it.
   *
   * The chat/files half and the collections half used to be separate chores in
   * separate places, and the seam between them is where a reset got stuck: a
   * clean studio still talking to a populated project, or the reverse. `backend`
   * closes it — one action, one confirmation, everything gone.
   */
  const resetApp = useCallback(
    async ({ files = false, backend = false }: { files?: boolean; backend?: boolean }) => {
      const what = [
        "this chat",
        files && "every file in the app",
        backend && "EVERY collection in Pluggie, and all of its data",
      ]
        .filter(Boolean)
        .join(", ");
      const tail = backend
        ? "The backend teardown works out the relation order for you, including cycles."
        : "Collections live in Pluggie and are NOT touched — clear those separately if you want the data gone.";
      if (!window.confirm(`Clear ${what}?\n\n${tail}\n\nThis cannot be undone.`)) return;
      try {
        const res = await fetch(`/api/apps/${app.slug}/reset`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ files, backend }),
        });
        const body = (await res.json()) as {
          ok?: boolean;
          cleared?: string;
          error?: string;
          backend?: { deleted: string[]; brokeCycles: string[]; remaining: string[] };
        };
        if (res.ok && body.ok) {
          setBlocks([]);
          setSpentUsd(0);
          setLastUsage(null);
          void refreshFiles();
          bumpPreview();
          const b = body.backend;
          setToast({
            ok: true,
            title: `Cleared ${body.cleared}.`,
            sub: b
              ? `${b.deleted.length} collection(s) deleted${b.brokeCycles.length ? `, ${b.brokeCycles.length} relation cycle(s) broken` : ""}. The builder starts from scratch on your next message.`
              : "The builder starts from scratch on your next message.",
          });
        } else {
          // A partial teardown must name what survived — "failed" alone would
          // leave you guessing which half of the reset actually happened.
          const left = body.backend?.remaining ?? [];
          setToast({
            ok: false,
            title: "Couldn't clear everything",
            sub: left.length ? `Still standing: ${left.join(", ")}` : body.error,
          });
        }
      } catch (e) {
        setToast({ ok: false, title: "Couldn't clear", sub: e instanceof Error ? e.message : String(e) });
      }
      setTimeout(() => setToast(null), 6500);
    },
    [app.slug, refreshFiles, bumpPreview],
  );

  const newApp = useCallback(async () => {
    const name = window.prompt("Name the new app:");
    if (!name?.trim()) return;
    const res = await fetch(`/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: props.projectId, name: name.trim() }),
    });
    const body = (await res.json()) as { app?: AppMeta; error?: string };
    if (res.ok && body.app) window.location.href = `/studio/${props.projectId}?app=${body.app.slug}`;
    else {
      setToast({ ok: false, title: "Couldn't create app", sub: body.error });
      setTimeout(() => setToast(null), 4200);
    }
  }, [props.projectId]);

  /* ── derived ── */
  const backendItems = useMemo(() => deriveBackend(blocks), [blocks]);
  const hasApp = files.some((f) => f.path === "index.html");
  const chips = hasApp ? FOLLOWUPS : STARTERS;
  const dataColumns = useMemo(() => {
    const cols = new Set<string>();
    for (const r of dataRows) for (const k of Object.keys(r.data ?? {})) cols.add(k);
    return [...cols].slice(0, 8);
  }, [dataRows]);

  const menuPos = (ref: React.RefObject<HTMLButtonElement | null>) => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { top: r.bottom + 6, left: r.left } : { top: 80, left: 100 };
  };

  return (
    <div className="bench">
      {/* header */}
      <header className="hd">
        <a className="brand" href="/">
          <span className="x">X</span>Vibe
        </a>
        <div className="crumb">
          <span className="sep">/</span>
          <span>{projectName}</span>
          <span className="sep">/</span>
          <button className="appbtn" ref={appBtnRef} aria-haspopup="menu" aria-expanded={appMenu} onClick={() => setAppMenu((v) => !v)}>
            <b>{app.name}</b>
            <span className="car">▾</span>
          </button>
        </div>
        <div className="grow" />
        <div className="chip" title="Builder model and last-build cache rate">
          <span className={`dot${busy ? " busy" : ""}`} />
          <span>{busy ? "building" : "live"}</span>
          {lastUsage && (
            <>
              <span>·</span>
              <span>
                {lastUsage.model.replace("claude-", "")}
                {lastUsage.cacheReadTokens > 0 &&
                  ` · ${Math.round((100 * lastUsage.cacheReadTokens) / (lastUsage.inputTokens + lastUsage.cacheReadTokens + lastUsage.cacheWriteTokens))}% cached`}
              </span>
            </>
          )}
        </div>
        <button className="btn primary" onClick={publish} disabled={publishing || busy || !hasApp}>
          {publishing ? "Publishing…" : "Publish"}
        </button>
      </header>

      {/* main */}
      <div className="main">
        <section className="agent" style={{ width: agentW }} aria-label="Builder agent">
          <div className="agent-hd">
            <span className="av" />
            <span className="label" style={{ color: "var(--mute)" }}>
              Builder agent
            </span>
            <span className="state">{busy ? "working…" : "idle"}</span>
          </div>
          <div className="msgs" ref={msgsRef}>
            {blocks.length === 0 && (
              <div className="msg agent">
                <div className="who">◆</div>
                <div className="bubble">
                  Describe the app you want. I&apos;ll model its backend on <code>{projectName}</code>, build the frontend, and
                  you&apos;ll watch it appear in the preview.
                </div>
              </div>
            )}
            {blocks.map((block, i) => (
              <div key={i} className={`msg ${block.role}`}>
                <div className="who">{block.role === "agent" ? "◆" : "you"}</div>
                <div className="bubble">
                  {block.items.length === 0 && (
                    <span className="typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {block.items.map((item, j) =>
                    item.kind === "text" ? (
                      <Rich key={j} text={item.text} />
                    ) : item.kind === "checkpoint" ? (
                      <span key={j} className="ckpt" title={`${formatTokens(item.usage.inputTokens + item.usage.cacheReadTokens + item.usage.cacheWriteTokens)} in / ${formatTokens(item.usage.outputTokens)} out · estimated from list pricing`}>
                        <b>{formatUsd(item.usage.costUsd ?? estimateCostUsd(item.usage))}</b>
                        <span>{item.usage.model.replace("claude-", "")}</span>
                        <span>{item.usage.rounds} {item.usage.rounds === 1 ? "step" : "steps"}</span>
                        {item.usage.seconds !== undefined && <span>{item.usage.seconds}s</span>}
                      </span>
                    ) : item.kind === "plan" ? (
                      <span key={j} className="step">
                        <code>plan</code>
                        <span className="sum">
                          {plan && plan.id === item.planId ? " — waiting for your approval below" : " — reviewed"}
                        </span>
                      </span>
                    ) : item.kind === "task" ? (
                      <TaskRow key={j} item={item} />
                    ) : (
                      <span key={j} className={`step ${item.state === "wait" ? "wait" : item.state === "fail" ? "fail" : ""}`}>
                        <code>{item.label}</code>
                        {item.summary && item.state !== "wait" ? <span className="sum"> — {item.summary}</span> : null}
                      </span>
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="composer">
            {/* Anchored here rather than inline in the chat: a plan proposed
                just before a refresh must still be approvable, and the chat
                block that announced it does not survive a reload. */}
            {plan && (
              <PlanCard
                plan={plan}
                busy={busy}
                onApprove={() => void approvePlan()}
                onDiscard={() => void discardPlan()}
                onEdit={editPlan}
              />
            )}
            <div className="suggest">
              {chips.map((c) => (
                <button key={c} className="schip" disabled={busy} onClick={() => void send(c)}>
                  {c.length > 46 ? `${c.slice(0, 46)}…` : c}
                </button>
              ))}
            </div>
            <div className="inrow">
              <textarea
                rows={1}
                value={input}
                placeholder="Describe a change — it ships live…"
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 110)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
              />
              {busy ? (
                <button className="send stop" aria-label="Stop the builder" title="Stop — work so far is saved" onClick={() => void stopBuild()}>
                  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
                  </svg>
                </button>
              ) : (
                <button className="send" aria-label="Send" disabled={!input.trim()} onClick={() => void send(input)}>
                  ↑
                </button>
              )}
            </div>
            <div className="hint">
              <select
                className="modelsel"
                aria-label="Builder model"
                title="Auto lets the router pick per request: questions and small edits ride the fast tier, feature work gets the strong tier."
                value={modelPin}
                onChange={(e) => setModelPin(e.target.value)}
              >
                <option value="auto">Model: Auto</option>
                <option value="haiku">Fast · Haiku</option>
                <option value="sonnet">Strong · Sonnet</option>
                <option value="opus">Max · Opus</option>
              </select>
              <span
                className={`effort${effortApplies ? "" : " off"}`}
                title={
                  effortApplies
                    ? `Effort: ${effort} — ${EFFORT_BLURB[effort]}\nCost follows the number of steps, not the thinking depth, so turning this DOWN usually costs more.`
                    : "The fast tier does not accept an effort setting — pick Auto, Strong or Max to use it."
                }
              >
                <span className="lbl">effort</span>
                <input
                  type="range"
                  min={0}
                  max={EFFORTS.length - 1}
                  step={1}
                  value={EFFORTS.indexOf(effort)}
                  disabled={!effortApplies}
                  aria-label={`Model effort: ${effort}`}
                  aria-valuetext={effort}
                  onChange={(e) => setEffort(EFFORTS[Number(e.target.value)])}
                />
                <span className="val">{effortApplies ? effort : "n/a"}</span>
              </span>
              <span>↵ send · shift+↵ newline · ⌘K commands</span>
              {lastUsage && (
                <span className="r">
                  last build {formatTokens(lastUsage.inputTokens + lastUsage.cacheReadTokens + lastUsage.cacheWriteTokens)} in /{" "}
                  {formatTokens(lastUsage.outputTokens)} out
                </span>
              )}
            </div>
          </div>
        </section>

        <div className="divider" ref={dividerRef} role="separator" aria-label="Resize panels" />

        {/* stage */}
        <section className="stage" aria-label="Workspace">
          <div className="toolbar">
            <button className="tools-btn" ref={toolsBtnRef} aria-haspopup="menu" aria-expanded={toolsMenu} onClick={() => setToolsMenu((v) => !v)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
                <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
                <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
                <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
              </svg>
              Tools
            </button>
            <div className="tabs" role="tablist">
              {openTools.map((id) => {
                const t = TOOLS.find((x) => x.id === id)!;
                return (
                  <button key={id} className="tab" role="tab" aria-selected={activeTool === id} onClick={() => openTool(id)}>
                    <ToolIcon id={id} className="ico" />
                    {t.name}
                    {id !== "preview" && (
                      <span
                        className="x"
                        title="Close"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTool(id);
                        }}
                      >
                        ✕
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="grow" />
            <div className="devices" aria-label="Screen size">
              {[
                { w: "", title: "Fluid width", d: '<rect x="2.5" y="5" width="19" height="13" rx="2"/><path d="M8 21h8"/>' },
                { w: "768", title: "Tablet · 768", d: '<rect x="4.5" y="3" width="15" height="18" rx="2"/><circle cx="12" cy="18" r=".7" fill="currentColor"/>' },
                { w: "390", title: "Phone · 390", d: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><circle cx="12" cy="18.5" r=".7" fill="currentColor"/>' },
              ].map((d) => (
                <button
                  key={d.w}
                  className="dev"
                  aria-pressed={devW === d.w}
                  title={d.title}
                  aria-label={d.title}
                  onClick={() => setDevW(d.w)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" dangerouslySetInnerHTML={{ __html: d.d }} />
                </button>
              ))}
            </div>
            <span className="width-read">{devW ? `${devW} px` : "fluid"}</span>
          </div>

          <div className="stage-body">
            {/* PREVIEW */}
            <div className="pane preview-pane" hidden={activeTool !== "preview"}>
              <div className="preview-shell" style={{ ["--dev-w" as string]: devW ? `${devW}px` : "100%" }}>
                <div className="navbar">
                  <button className="nav" title="Back (browser history)" aria-label="Back" onClick={() => window.history.back()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M15 5l-7 7 7 7" />
                    </svg>
                  </button>
                  <button className="nav" title="Forward" aria-label="Forward" onClick={() => window.history.forward()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="m9 5 7 7-7 7" />
                    </svg>
                  </button>
                  <button className="nav" title="Reload preview" aria-label="Reload preview" onClick={bumpPreview}>
                    <svg ref={reloadRef} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 12a8 8 0 1 1-2.5-5.8M20 3.5V8h-4.5" />
                    </svg>
                  </button>
                  <div className="addr" title="This is the live working copy — it updates as the builder writes files, before you publish.">
                    <svg className="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                      <rect x="5" y="10.5" width="14" height="10" rx="2" />
                      <path d="M8 10V7a4 4 0 1 1 8 0v3" />
                    </svg>
                    <span>
                      <b>{previewHost}</b>
                    </span>
                    <span className="addr-tag">live · unpublished edits</span>
                  </div>
                  {previewUrl && (
                    <a className="nav" href={previewUrl} target="_blank" rel="noreferrer" title="Open this live preview in a new tab" aria-label="Open live preview in a new tab">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 4h6v6M20 4 11 13M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
                      </svg>
                    </a>
                  )}
                  {publishedUrl && (
                    <a
                      className="nav pub"
                      href={publishedUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={`Published app — ${publishedUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")} (the snapshot your visitors see)`}
                      aria-label="Open the published app"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M3.5 12h17M12 3.5c2.6 2.3 4 5.2 4 8.5s-1.4 6.2-4 8.5c-2.6-2.3-4-5.2-4-8.5s1.4-6.2 4-8.5Z" />
                      </svg>
                    </a>
                  )}
                </div>
                <div className={`appframe${busy ? " busy" : ""}`}>
                  {previewUrl ? (
                    <iframe
                      key={frameNonce}
                      src={previewUrl}
                      title={`${app.name} preview`}
                      sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                    />
                  ) : null}
                </div>
              </div>
            </div>

            {/* CODE */}
            <div className="pane code-pane" hidden={activeTool !== "code"}>
              <div className="tree">
                <div className="grp label">app · {files.length} files</div>
                {files.length === 0 && <div className="empty">no files yet — ask the builder</div>}
                {files.map((f) => (
                  <button key={f.path} className="f" aria-selected={selectedFile === f.path} onClick={() => void openFile(f.path)}>
                    <span className="d">◆</span>
                    <span className="nm">{f.path}</span>
                    <span className="sz">{formatBytes(f.bytes)}</span>
                  </button>
                ))}
                {backendItems.length > 0 && <div className="grp label" style={{ marginTop: 8 }}>backend · pluggie</div>}
                {backendItems.map((b) => (
                  <div key={b} className="f" role="listitem">
                    <span className="d bk">●</span>
                    <span className="nm">{b}</span>
                  </div>
                ))}
              </div>
              <div className="codewrap">
                <div className="codehead">{selectedFile ? `${selectedFile} — read-only · written by the builder` : "select a file"}</div>
                <pre className="code">
                  {selectedFile ? (
                    fileContent.split("\n").map((l, i) => (
                      <span key={i} className="ln">
                        {l || " "}
                      </span>
                    ))
                  ) : (
                    <span className="placeholder">
                      {"// The builder writes browser-ready files here — no build step, no runtime.\n// The backend lives on Pluggie; the bundle calls /api/v1 and the edge injects credentials."}
                    </span>
                  )}
                </pre>
              </div>
            </div>

            {/* THEME */}
            <div className="pane tool-pane" hidden={activeTool !== "theme"}>
              <div className="tool-card">
                <h3>
                  Theme <span className="tag">design tokens · applies instantly, no rebuild</span>
                </h3>
                <div className="note" style={{ marginBottom: 14 }}>
                  Rewrites <code style={{ fontFamily: "var(--mono)", color: "var(--coral-hot)" }}>css/theme.css</code> only. The
                  builder styles against token names, so switching re-skins the whole app without touching its markup or logic.
                </div>
                <div className="themegrid">
                  {themes.length === 0 && <div className="note">Loading themes…</div>}
                  {themes.map((t) => (
                    <button
                      key={t.id}
                      className="themecard"
                      aria-pressed={themeId === t.id}
                      disabled={Boolean(themeBusy)}
                      onClick={() => void chooseTheme(t.id)}
                    >
                      <span className="swatch" aria-hidden="true">
                        {t.swatch.map((c, i) => (
                          <i key={i} style={{ background: c }} />
                        ))}
                      </span>
                      <span className="tname" style={{ fontFamily: t.fontDisplay }}>
                        {t.name}
                        {themeId === t.id && <span className="on">applied</span>}
                        {themeBusy === t.id && <span className="on">applying…</span>}
                      </span>
                      <span className="tsuits">{t.suits}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* DEPLOYS */}
            <div className="pane tool-pane" hidden={activeTool !== "deploys"}>
              <div className="tool-card">
                <h3>
                  Publish history <span className="tag">immutable snapshots · r2 offload</span>
                </h3>
                {deploys.versions.length === 0 ? (
                  <div className="note">Nothing published yet — hit Publish and versions appear here.</div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Published</th>
                        <th>Bundle</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {deploys.versions.map((v) => (
                        <tr key={v.version}>
                          <td>
                            <b>v{v.version}</b>
                          </td>
                          <td>{new Date(v.at).toLocaleString()}</td>
                          <td>
                            {v.files} files · {formatBytes(v.bytes)}
                          </td>
                          <td>{deploys.live === v.version ? <span className="pillch ok">live</span> : <span className="pillch dim">kept</span>}</td>
                          <td>
                            {deploys.live !== v.version && (
                              <button
                                className="btn sm"
                                title="Replaces the current workspace with this snapshot"
                                onClick={() => void rollback(v.version)}
                              >
                                {rbConfirm === v.version ? "Confirm?" : "Roll back"}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="tool-card">
                <h3>How rollback works</h3>
                <div className="note">
                  Every publish is an immutable snapshot. Rolling back restores the workspace from that version and repoints{" "}
                  <code style={{ fontFamily: "var(--mono)", color: "var(--coral-hot)" }}>current.json</code> on R2 — unpublished edits are
                  replaced, nothing is rebuilt, and rolling forward is the same one click.
                </div>
              </div>
            </div>

            {/* DATA */}
            <div className="pane tool-pane" hidden={activeTool !== "data"}>
              <div className="tool-card">
                <h3>
                  Collections <span className="tag">live from pluggie · read-only · converges ~15s</span>
                </h3>
                <div className="colpills">
                  {dataCols.length === 0 && !dataErr && <span style={{ color: "var(--faint)", fontSize: 12 }}>no collections yet</span>}
                  {dataCols.map((c) => (
                    <button key={c} className="colpill" aria-pressed={dataActive === c} onClick={() => void loadDataRows(c)}>
                      {c}
                      {dataActive === c && dataCount !== undefined ? ` · ${dataCount}` : ""}
                    </button>
                  ))}
                </div>
                {dataErr && <div className="note">⚠ {dataErr}</div>}
                {!dataErr && dataActive && (
                  <div style={{ overflowX: "auto" }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>id</th>
                          {dataColumns.map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {dataRows.map((r) => (
                          <tr key={r.id}>
                            <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{r.id.slice(0, 8)}…</td>
                            {dataColumns.map((c) => (
                              <td key={c}>{cell(r.data?.[c])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* LOGS */}
            <div className="pane tool-pane" hidden={activeTool !== "logs"}>
              <div className="tool-card">
                <h3>
                  Delivery log <span className="tag">pluggie · webhooks + emails</span>
                  <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => void loadLogs()}>
                    Refresh
                  </button>
                </h3>
                {logsErr && <div className="note">⚠ {logsErr}</div>}
                {!logsErr && logs.length === 0 && <div className="note">No deliveries yet — webhooks and emails your app fires will appear here.</div>}
                {!logsErr && logs.length > 0 && (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>when</th>
                        <th>type</th>
                        <th>target</th>
                        <th>status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.slice(0, 30).map((l, i) => {
                        const id = str(l.id ?? l.deliveryId);
                        const status = str(l.status ?? l.result ?? l.outcome);
                        const ok = /^(2|deliver|success|sent|ok)/i.test(status);
                        return (
                          <tr key={id || i}>
                            <td>{str(l.at ?? l.created_at ?? l.createdAt).slice(0, 19).replace("T", " ")}</td>
                            <td>{str(l.type ?? l.kind ?? l.event)}</td>
                            <td>{str(l.target ?? l.to ?? l.url)}</td>
                            <td>
                              <span className={`pillch ${ok ? "ok" : "err"}`}>{status || "?"}</span>
                            </td>
                            <td>
                              {id && (
                                <button
                                  className="btn sm"
                                  onClick={() =>
                                    void fetch(`/api/apps/${app.slug}/logs`, {
                                      method: "POST",
                                      headers: { "content-type": "application/json" },
                                      body: JSON.stringify({ deliveryId: id }),
                                    }).then(() => loadLogs())
                                  }
                                >
                                  Re-fire
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* status bar */}
      <footer className="status">
        <span className="s">
          <span className={`d${busy ? " busy" : ""}`} />
          <span>{busy ? "building…" : "ready"}</span>
        </span>
        <span className="s">pluggie · connected</span>
        <span className="s">db · neon ({props.dbStatus})</span>
        {!props.endUserAuth && <span className="s">end-user auth · off</span>}
        <span className="grow" />
        {spentUsd > 0 && (
          <span className="s" title="Estimated from list pricing, this session only. Each reply carries its own receipt.">
            this session · <b style={{ color: "var(--ink)" }}>{formatUsd(spentUsd)}</b>
          </span>
        )}
        {lastUsage && (
          <span className="s">
            last · {formatTokens(lastUsage.inputTokens + lastUsage.cacheReadTokens + lastUsage.cacheWriteTokens)} in (
            {Math.round((100 * lastUsage.cacheReadTokens) / Math.max(1, lastUsage.inputTokens + lastUsage.cacheReadTokens + lastUsage.cacheWriteTokens))}%
            cached) / {formatTokens(lastUsage.outputTokens)} out
          </span>
        )}
        <span className="s">deploys · r2 → *.{props.appsDomain ?? "xvibe.app"}</span>
        {props.build && (
          <span className="s" title="The commit this studio is running — check it after a deploy.">
            build · {props.build}
          </span>
        )}
      </footer>

      {/* tools menu */}
      {toolsMenu && (
        <div className="menu" role="menu" aria-label="Tools" style={menuPos(toolsBtnRef)}>
          <div className="mhd label">Tools</div>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`mitem${t.soon ? " soon" : ""}`}
              role="menuitem"
              aria-disabled={t.soon}
              onClick={() => openTool(t.id)}
            >
              <ToolIcon id={t.id} />
              {t.name}
              {t.soon ? <span className="soon-tag">soon</span> : openTools.includes(t.id) ? <span className="on">open</span> : null}
            </button>
          ))}
        </div>
      )}
      {toolsMenu && <div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={() => setToolsMenu(false)} />}

      {/* app switcher */}
      {appMenu && (
        <div className="menu" role="menu" aria-label="Apps" style={menuPos(appBtnRef)}>
          <div className="mhd label">Apps in {projectName}</div>
          {props.apps.map((a) => (
            <button
              key={a.slug}
              className="mitem"
              role="menuitem"
              onClick={() => {
                if (a.slug !== app.slug) window.location.href = `/studio/${props.projectId}?app=${a.slug}`;
                setAppMenu(false);
              }}
            >
              <span className="appdot" />
              {a.name}
              {a.slug === app.slug && <span className="on">open</span>}
            </button>
          ))}
          <button className="mitem" role="menuitem" style={{ color: "var(--mute)" }} onClick={() => void newApp()}>
            ＋ New app…
          </button>
        </div>
      )}
      {appMenu && <div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={() => setAppMenu(false)} />}

      {/* palette */}
      {palOpen && (
        <div className="palette" onClick={(e) => e.target === e.currentTarget && setPalOpen(false)}>
          <div className="pal-card">
            <div className="pal-in">
              <span className="caret">›</span>
              <input
                ref={palInputRef}
                value={palQ}
                placeholder="Type a command…"
                aria-label="Command"
                onChange={(e) => {
                  setPalQ(e.target.value);
                  setPalSel(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setPalSel((s) => Math.min(s + 1, palHits.length - 1));
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setPalSel((s) => Math.max(s - 1, 0));
                  }
                  if (e.key === "Enter" && palHits[palSel]) {
                    setPalOpen(false);
                    palHits[palSel].run();
                  }
                }}
              />
            </div>
            <div className="pal-list">
              {palHits.length === 0 && <div className="pal-empty">No matching command.</div>}
              {palHits.map((c, i) => (
                <button
                  key={c.label}
                  className="pal-item"
                  aria-selected={i === palSel}
                  onClick={() => {
                    setPalOpen(false);
                    c.run();
                  }}
                >
                  {c.label}
                  {"k" in c && c.k ? <span className="k">{c.k}</span> : null}
                </button>
              ))}
            </div>
            <div className="pal-foot label">↑↓ navigate · ↵ run · esc close</div>
          </div>
        </div>
      )}

      {/* toast */}
      {toast && (
        <div className="toast show" role="status">
          <div className={`ck${toast.ok ? "" : " err"}`}>{toast.ok ? "✓" : "!"}</div>
          <div>
            <b>{toast.title}</b>{" "}
            {toast.url && (
              <a href={toast.url} target="_blank" rel="noreferrer">
                {toast.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
            )}
            {toast.sub && <div className="sm">{toast.sub}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── plan review ── */

/**
 * The plan, before any of it runs. Editable in place on purpose: arguing a
 * task list into shape through chat costs a round-trip each time, whereas
 * retitling or dropping one here is free and instant.
 */
function PlanCard({
  plan,
  busy,
  onApprove,
  onDiscard,
  onEdit,
}: {
  plan: Plan;
  busy: boolean;
  onApprove: () => void;
  onDiscard: () => void;
  onEdit: (mutate: (tasks: PlanTask[]) => PlanTask[]) => void;
}) {
  const move = (from: number, to: number) =>
    onEdit((ts) => {
      if (to < 0 || to >= ts.length) return ts;
      const [t] = ts.splice(from, 1);
      ts.splice(to, 0, t);
      return ts;
    });
  return (
    <div className="plan">
      <div className="plan-hd">
        <b>
          {plan.tasks.length} task{plan.tasks.length === 1 ? "" : "s"}
        </b>
        <span>nothing is built yet — review, then approve</span>
      </div>
      <ol className="plan-tasks">
        {plan.tasks.map((t, i) => (
          <li key={t.id}>
            <span className="pn">{i + 1}</span>
            <div className="pbody">
              <input
                value={t.title}
                aria-label={`Task ${i + 1} title`}
                disabled={busy}
                onChange={(e) =>
                  onEdit((ts) => {
                    ts[i] = { ...ts[i], title: e.target.value };
                    return ts;
                  })
                }
              />
              <span className="pdw">{t.doneWhen}</span>
            </div>
            <div className="pacts">
              <button disabled={busy || i === 0} title="Move up" aria-label={`Move task ${i + 1} up`} onClick={() => move(i, i - 1)}>
                ↑
              </button>
              <button
                disabled={busy || i === plan.tasks.length - 1}
                title="Move down"
                aria-label={`Move task ${i + 1} down`}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </button>
              <button
                disabled={busy || plan.tasks.length === 1}
                title="Remove this task"
                aria-label={`Remove task ${i + 1}`}
                onClick={() => onEdit((ts) => ts.filter((_, n) => n !== i))}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="plan-foot">
        <button className="btn primary sm" onClick={onApprove} disabled={busy || !plan.tasks.length}>
          Approve &amp; build
        </button>
        <button className="btn sm" onClick={onDiscard} disabled={busy}>
          Discard
        </button>
        <span className="phint">Tasks run one at a time, and each is checked against the live API before the next starts.</span>
      </div>
    </div>
  );
}

/** One executed task and what it actually did — the receipt, not a summary. */
function TaskRow({
  item,
}: {
  item: { id: string; title: string; index: number; total: number; state: "wait" | "ok" | "fail"; receipt?: TaskReceipt };
}) {
  const r = item.receipt;
  return (
    <div className={`task ${item.state}`}>
      <div className="task-hd">
        <span className="tn">
          {item.index}/{item.total}
        </span>
        <b>{item.title}</b>
        {r ? <span className="tcost">{formatUsd(r.costUsd)}</span> : null}
      </div>
      {r ? (
        <div className="task-rc">
          <span className="tnote">{r.note}</span>
          <div className="tmeta">
            {r.changed.length ? (
              <span>
                {r.changed.length} file{r.changed.length === 1 ? "" : "s"}
              </span>
            ) : null}
            {r.probed.length ? <span className="good">verified {r.probed.length}</span> : null}
            {/* The honesty field: an endpoint the app calls that nobody checked. */}
            {r.unprobed.length ? <span className="warn">NOT verified: {r.unprobed.join(", ")}</span> : null}
            <span>
              {r.rounds} {r.rounds === 1 ? "step" : "steps"} · {r.seconds}s
            </span>
            {r.error ? <span className="bad">{r.error}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── helpers ── */

function Rich({ text }: { text: string }) {
  const parts = text.split(/`([^`\n]+)`/g);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}</>;
}

function fromTranscript(events: TranscriptEvent[]): Block[] {
  const blocks: Block[] = [];
  for (const ev of events) {
    if (ev.kind === "user") {
      blocks.push({ role: "user", items: [{ kind: "text", text: ev.text ?? "" }] });
    } else if (ev.kind === "agent_text" || ev.kind === "tool") {
      let last = blocks[blocks.length - 1];
      if (!last || last.role !== "agent") {
        last = { role: "agent", items: [] };
        blocks.push(last);
      }
      if (ev.kind === "agent_text") last.items.push({ kind: "text", text: ev.text ?? "" });
      else if (ev.tool)
        last.items.push({ kind: "step", name: ev.tool.name, label: ev.tool.name, state: ev.tool.ok ? "ok" : "fail", summary: ev.tool.summary });
    } else if (ev.kind === "system" && ev.text?.startsWith("usage: ")) {
      // Receipts survive a reload — the transcript already records each turn's usage.
      try {
        const usage = JSON.parse(ev.text.slice(7)) as TurnUsage;
        const last = blocks[blocks.length - 1];
        if (last?.role === "agent") last.items.push({ kind: "checkpoint", usage });
      } catch {
        /* older transcript lines predate the receipt shape */
      }
    }
  }
  return blocks;
}

function deriveBackend(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks)
    for (const it of b.items) {
      if (it.kind !== "step" || it.state !== "ok") continue;
      if (it.name === "define_collection") {
        const m = it.summary?.match(/^defined (\S+)/);
        if (m) out.push(`${m[1]}`);
      }
      if (it.name === "define_schedule") out.push("schedule (nightly)");
      if (it.name === "enable_plugin") {
        const m = it.summary?.match(/^enabled plugin (\S+)/);
        if (m) out.push(`plugin: ${m[1]}`);
      }
      if (it.name === "mint_delivery_token") out.push("delivery token · edge");
    }
  return [...new Set(out)];
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 60);
  return String(v).slice(0, 80);
}
function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
