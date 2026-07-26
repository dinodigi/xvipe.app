"use client";

/**
 * The studio (P1.2): chat ↔ builder on the left, the app taking shape on the
 * right. Dark, tight, tool-like — while the preview renders the built app in
 * its own world (DESIGN-RELATIONSHIP.md: that contrast is load-bearing).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppMeta, TranscriptEvent, WsFile } from "@/lib/apps/store";
import type { AgentEvent, TurnUsage } from "@/lib/agent/events";

type Item =
  | { kind: "text"; text: string }
  | { kind: "step"; name: string; label: string; state: "wait" | "ok" | "fail"; summary?: string };

interface Block {
  role: "user" | "agent";
  items: Item[];
}

const STARTERS = [
  "Build me a lead desk for a roofing company — site form in, triage to a site visit",
  "A waitlist page for a supper club — email signups, a little hype",
  "Inventory list for a bike shop — add, count, mark sold",
];
const FOLLOWUPS = ["Add a priority flag", "Let me filter by status", "Make the empty state friendlier"];

export function Studio(props: {
  app: AppMeta;
  projectName: string;
  dbStatus: string;
  attention: string[];
  endUserAuth: boolean;
  /** wildcard apps domain when the studio is hosted (e.g. apps.xvipe.app) */
  appsDomain?: string;
  initialTranscript: TranscriptEvent[];
  initialFiles: WsFile[];
}) {
  const { app, projectName } = props;
  const [blocks, setBlocks] = useState<Block[]>(() => fromTranscript(props.initialTranscript));
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<WsFile[]>(props.initialFiles);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [fileContent, setFileContent] = useState<string>("");
  const [frameNonce, setFrameNonce] = useState(0);
  const [flash, setFlash] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; title: string; url?: string; sub?: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [lastUsage, setLastUsage] = useState<TurnUsage | null>(null);
  const msgsRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState<{ protocol: string; port: string; isLocal: boolean } | null>(null);

  useEffect(() => {
    const h = window.location.hostname;
    setOrigin({
      protocol: window.location.protocol,
      port: window.location.port,
      isLocal: h === "localhost" || h.endsWith(".localhost"),
    });
  }, []);

  // Dev: <slug>.localhost:<port>. Hosted: <slug>.<apps domain> (wildcard →
  // this same server). Without a wildcard domain configured, fall back to the
  // path form — the page renders, though same-origin /api/v1 calls won't
  // resolve until the domain is set.
  const previewUrl = origin
    ? origin.isLocal
      ? `${origin.protocol}//${app.slug}.localhost${origin.port ? `:${origin.port}` : ""}/`
      : props.appsDomain
        ? `https://${app.slug}.${props.appsDomain}/`
        : `/apps/${app.slug}/`
    : undefined;
  const previewHost = origin?.isLocal
    ? `${app.slug}.localhost${origin?.port ? `:${origin.port}` : ""}`
    : props.appsDomain
      ? `${app.slug}.${props.appsDomain}`
      : `/apps/${app.slug}/ (set XVIBE_APPS_BASE_DOMAIN)`;

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [blocks]);

  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/${app.slug}/files`);
      if (res.ok) setFiles(((await res.json()) as { files: WsFile[] }).files);
    } catch {
      /* transient */
    }
  }, [app.slug]);

  const bumpPreview = useCallback(() => {
    setFrameNonce((n) => n + 1);
    setFlash(true);
    setTimeout(() => setFlash(false), 650);
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      setInput("");
      setBusy(true);
      setBlocks((b) => [...b, { role: "user", items: [{ kind: "text", text: message }] }, { role: "agent", items: [] }]);

      const apply = (ev: AgentEvent) =>
        setBlocks((prev) => {
          const next = prev.slice();
          const cur = { ...next[next.length - 1], items: next[next.length - 1].items.slice() };
          next[next.length - 1] = cur;
          const dropReasoning = () => {
            cur.items = cur.items.filter((it) => !(it.kind === "step" && it.name === "__thinking"));
          };
          if (ev.type === "thinking") {
            const last = cur.items[cur.items.length - 1];
            if (!(last?.kind === "step" && last.name === "__thinking")) {
              cur.items.push({ kind: "step", name: "__thinking", label: "reasoning", state: "wait" });
            }
          } else if (ev.type === "text_delta") {
            dropReasoning();
            const last = cur.items[cur.items.length - 1];
            if (last?.kind === "text") cur.items[cur.items.length - 1] = { kind: "text", text: last.text + ev.text };
            else cur.items.push({ kind: "text", text: ev.text });
          } else if (ev.type === "tool_start") {
            dropReasoning();
            cur.items.push({ kind: "step", name: ev.name, label: ev.label, state: "wait" });
          } else if (ev.type === "tool_done") {
            for (let i = cur.items.length - 1; i >= 0; i--) {
              const it = cur.items[i];
              if (it.kind === "step" && it.state === "wait" && it.name === ev.name) {
                cur.items[i] = { ...it, state: ev.ok ? "ok" : "fail", summary: ev.summary };
                break;
              }
            }
          } else if (ev.type === "error") {
            cur.items.push({ kind: "text", text: `\n⚠ ${ev.message}` });
          }
          return next;
        });

      try {
        const res = await fetch(`/api/apps/${app.slug}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
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
            if (ev.type === "files_changed") {
              void refreshFiles();
              bumpPreview();
            }
            if (ev.type === "turn_done" && ev.usage) setLastUsage(ev.usage);
          }
        }
      } catch (e) {
        apply({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
        void refreshFiles();
        bumpPreview();
      }
    },
    [app.slug, busy, refreshFiles, bumpPreview],
  );

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

  const publish = useCallback(async () => {
    if (publishing || busy) return;
    setPublishing(true);
    try {
      const res = await fetch(`/api/apps/${app.slug}/publish`, { method: "POST" });
      const body = (await res.json()) as { url?: string; version?: number; note?: string; error?: string };
      if (res.ok && body.url) {
        setToast({ ok: true, title: "Published.", url: body.url, sub: "static frontend at the edge · backend stays on Pluggie" });
      } else {
        setToast({ ok: false, title: "Publish failed", sub: body.error ?? `HTTP ${res.status}` });
      }
    } catch (e) {
      setToast({ ok: false, title: "Publish failed", sub: e instanceof Error ? e.message : String(e) });
    } finally {
      setPublishing(false);
      setTimeout(() => setToast(null), 5200);
    }
  }, [app.slug, publishing, busy]);

  const backendItems = useMemo(() => deriveBackend(blocks), [blocks]);
  const hasApp = files.some((f) => f.path === "index.html");
  const chips = hasApp ? FOLLOWUPS : STARTERS;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="x">X</span>Vibe
        </a>
        <div className="proj">
          <span className="slash">/</span>
          <b>{projectName}</b>
          <span>— {app.name === projectName ? "studio" : app.name}</span>
        </div>
        <div className="stack">
          <div className="chip-stack" title="This app runs on Pluggie — you operate no runtime">
            <span className={`g${props.dbStatus === "connected" ? "" : " err"}`} />
            Pluggie · Neon · R2/CDN
          </div>
          <button className="btn" onClick={() => setTab(tab === "code" ? "preview" : "code")}>
            {tab === "code" ? "View app" : "View code"}
          </button>
          <button className="btn primary" onClick={publish} disabled={publishing || busy || !hasApp}>
            {publishing ? "Publishing…" : "Publish"}
          </button>
        </div>
      </header>

      <main className="studio">
        <section className="chat">
          <div className="chat-hd">
            <span className="av" />
            builder agent
          </div>
          <div className="msgs" ref={msgsRef}>
            {blocks.length === 0 && (
              <div className="msg agent">
                <div className="who">◆</div>
                <div className="bubble">
                  Describe the app you want. I&apos;ll model its backend on{" "}
                  <code>{projectName}</code>, build the frontend, and you&apos;ll watch it appear in
                  the preview. Publishing is one click when you like it.
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
            <div className="chips">
              {chips.map((c) => (
                <button key={c} className="chip" disabled={busy} onClick={() => void send(c)}>
                  {c.length > 42 ? `${c.slice(0, 42)}…` : c}
                </button>
              ))}
            </div>
            <div className="inrow">
              <textarea
                rows={1}
                value={input}
                placeholder="Describe a change — the builder ships it live…"
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
              <button className="send" aria-label="Send" disabled={busy || !input.trim()} onClick={() => void send(input)}>
                ↑
              </button>
            </div>
          </div>
        </section>

        <section className="workspace">
          <div className="tabs" role="tablist">
            <button className="tab" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>
              Preview
            </button>
            <button className="tab" role="tab" aria-selected={tab === "code"} onClick={() => setTab("code")}>
              Code <span className="cnt">{files.length} files</span>
            </button>
            <div className="spacer" />
            <div className="viewport">
              {previewUrl ? (
                <a href={previewUrl} target="_blank" rel="noreferrer">
                  {previewHost} ↗
                </a>
              ) : null}
              <span>· talking to Pluggie delivery API</span>
            </div>
          </div>
          <div className="stage">
            <div className="pane" hidden={tab !== "preview"}>
              <div className={`frame${flash ? " flash" : ""}`}>
                <div className="browser">
                  <div className="url">
                    <div className="dots">
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className="bar">
                      {app.slug}.<b>{props.appsDomain ?? "xvibe.app"}</b>
                      {origin?.isLocal && <span style={{ opacity: 0.55 }}> · dev: {previewHost}</span>}
                    </div>
                    <button className="reload" title="Reload preview" onClick={bumpPreview}>
                      ⟳
                    </button>
                  </div>
                  {previewUrl ? (
                    <iframe
                      key={frameNonce}
                      className="appframe"
                      src={previewUrl}
                      title={`${app.name} preview`}
                      sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                    />
                  ) : null}
                </div>
              </div>
            </div>
            <div className="pane" hidden={tab !== "code"}>
              <div className="code-wrap">
                <div className="tree">
                  <div className="grp">app · static bundle</div>
                  {files.length === 0 && <div className="empty">no files yet — ask the builder</div>}
                  {files.map((f) => (
                    <button
                      key={f.path}
                      className={`f${selectedFile === f.path ? " on" : ""}`}
                      onClick={() => void openFile(f.path)}
                    >
                      <span className="d">◆</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                      <span className="sz">{formatBytes(f.bytes)}</span>
                    </button>
                  ))}
                  {backendItems.length > 0 && <div className="grp">backend · pluggie</div>}
                  {backendItems.map((b) => (
                    <div key={b} className="f backend" role="listitem">
                      <span className="d">●</span>
                      <span>{b}</span>
                    </div>
                  ))}
                </div>
                <pre className="code">
                  {selectedFile ? (
                    fileContent
                  ) : (
                    <span className="placeholder">
                      {files.length === 0
                        ? "// The builder writes browser-ready files here — no build step, no runtime.\n// The backend lives on Pluggie; the bundle calls /api/v1 and the edge\n// injects credentials. Describe an app to begin."
                        : "// select a file"}
                    </span>
                  )}
                </pre>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="statusbar">
        <div className="s">
          <span className={`d ${busy ? "build" : "live"}`} />
          <span>{busy ? "building…" : "workspace ready"}</span>
        </div>
        <div className="s">connected to Pluggie · mcp token (dev)</div>
        <div className="s">db: Neon ({props.dbStatus})</div>
        {!props.endUserAuth && <div className="s">end-user auth: not configured</div>}
        {lastUsage && (
          <div className="s" title={`${lastUsage.rounds} rounds · cache write ${formatTokens(lastUsage.cacheWriteTokens)}`}>
            last build · {lastUsage.model.replace("claude-", "")} · {formatTokens(lastUsage.inputTokens + lastUsage.cacheReadTokens + lastUsage.cacheWriteTokens)} in
            {lastUsage.cacheReadTokens > 0 &&
              ` (${Math.round((100 * lastUsage.cacheReadTokens) / (lastUsage.inputTokens + lastUsage.cacheReadTokens + lastUsage.cacheWriteTokens))}% cached)`}{" "}
            / {formatTokens(lastUsage.outputTokens)} out
          </div>
        )}
        <div className="push">deploy target · R2 + CDN → *.xvibe.app</div>
      </footer>

      {toast && (
        <div className="toast show" role="status">
          <div className={`ck${toast.ok ? "" : " err"}`}>{toast.ok ? "✓" : "!"}</div>
          <div>
            <b>{toast.title}</b>{" "}
            {toast.url && (
              <>
                <span className="sm">Live at</span>{" "}
                <a href={toast.url} target="_blank" rel="noreferrer">
                  {toast.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </a>
              </>
            )}
            {toast.sub && <div className="sm">{toast.sub}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** `code` spans in agent prose, nothing more. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/`([^`\n]+)`/g);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}
    </>
  );
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
        last.items.push({
          kind: "step",
          name: ev.tool.name,
          label: ev.tool.name,
          state: ev.tool.ok ? "ok" : "fail",
          summary: ev.tool.summary,
        });
    }
  }
  return blocks;
}

/** What exists on Pluggie, derived from successful build steps. */
function deriveBackend(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks)
    for (const it of b.items) {
      if (it.kind !== "step" || it.state !== "ok") continue;
      if (it.name === "define_collection") {
        const m = it.summary?.match(/^defined (\S+)/);
        if (m) out.push(`${m[1]} collection`);
      }
      if (it.name === "enable_plugin") {
        const m = it.summary?.match(/^enabled plugin (\S+)/);
        if (m) out.push(`plugin: ${m[1]}`);
      }
      if (it.name === "mint_delivery_token") out.push("delivery token · edge custody");
    }
  return [...new Set(out)];
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
