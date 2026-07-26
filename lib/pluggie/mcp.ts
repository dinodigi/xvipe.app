/**
 * lib/pluggie/mcp.ts — the only way XVibe talks to Pluggie's authoring surface.
 *
 * Plain JSON-RPC 2.0 over HTTP POST (CONNECTION.md §2). No SDK, no session,
 * no imports from Pluggie — HTTP is the boundary (§6). SERVER-SIDE ONLY:
 * everything here handles the mcp token.
 */

const MCP_URL = process.env.PLUGGIE_MCP_URL ?? "https://pluggie.app/api/mcp";

/** Errors carry stable E_* codes — branch on `code`, never on message text (§5). */
export class PluggieError extends Error {
  readonly code: string | undefined;
  readonly retryAfterSec: number | undefined;
  readonly raw: string;
  constructor(toolName: string, rawText: string) {
    let code: string | undefined;
    let retryAfterSec: number | undefined;
    let message = rawText;
    try {
      const parsed = JSON.parse(rawText);
      code = parsed.code;
      message = parsed.error ?? rawText;
      retryAfterSec = parsed.retryAfterSec ?? parsed.data?.retryAfterSec;
    } catch {
      /* non-JSON error text — keep raw */
    }
    super(`${toolName}: ${message}`);
    this.name = "PluggieError";
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.raw = rawText;
  }
}

let rpcId = 0;

export async function rpc(
  method: string,
  params: unknown,
  token: string,
): Promise<{ result?: { tools?: unknown[]; content?: { text?: string }[]; isError?: boolean } }> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    cache: "no-store",
  });
  const text = await res.text();
  let body: { error?: unknown; result?: { content?: { text?: string }[]; isError?: boolean } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Pluggie MCP: HTTP ${res.status}, non-JSON body: ${text.slice(0, 300)}`);
  }
  if (body.error) {
    throw new Error(`Pluggie MCP: JSON-RPC error ${JSON.stringify(body.error).slice(0, 500)}`);
  }
  return body;
}

/**
 * Call one MCP tool. Tools return JSON as text; errors return isError + text
 * with a stable E_* code. E_RATE_LIMITED (300 calls/min/project) is retried
 * once after the structured retryAfterSec — anything else surfaces.
 */
export async function callTool<T = unknown>(name: string, args: unknown, token: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const body = await rpc("tools/call", { name, arguments: args }, token);
    const text = body.result?.content?.[0]?.text ?? "";
    if (body.result?.isError) {
      const err = new PluggieError(name, text);
      if (err.code === "E_RATE_LIMITED" && attempt === 0) {
        const waitSec = Math.min(err.retryAfterSec ?? 5, 30);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw err;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T; // a few tools (e.g. get_client_code) may answer plain text
    }
  }
}

/** Enumerate the live tool surface — prefer this over any cached contract dump. */
export async function listTools(token: string): Promise<{ name: string; description?: string; inputSchema?: object }[]> {
  const body = await rpc("tools/list", {}, token);
  return (body.result?.tools ?? []) as { name: string; description?: string; inputSchema?: object }[];
}

/** The orientation call, every session (CONNECTION.md §2). */
export interface ProjectInfo {
  project?: { name?: string; branding?: { displayName?: string; primaryColor?: string } };
  briefing?: {
    attention?: string[];
    updates?: unknown[];
    notices?: unknown[];
    health?: { connectors?: { type: string; status: string }[]; failedDeliveries24h?: number };
  };
  urls?: { deliveryBase?: string; admin?: string; mcp?: string; changes?: string; changesStream?: string };
  endUserAuth?: { configured?: boolean; issuer?: string };
  [k: string]: unknown;
}

export async function getProjectInfo(token: string): Promise<ProjectInfo> {
  return callTool<ProjectInfo>("get_project_info", {}, token);
}
