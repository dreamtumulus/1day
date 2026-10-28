// Loopback MCP server for worker sessions (docs/worker-sessions.md §3).
//
// Each persistent claude process that serves a request with caller-defined
// tools gets an MCP server entry pointing here (`--mcp-config`), so the model
// calls the customer's tools *natively* (tool_use blocks) instead of through
// the prompt-level ```tool_call fence. Nothing is executed on the node: a
// `tools/call` is parked as a pending promise and surfaced to the gateway,
// which turns it into the client's tool_use; the client's tool_result comes
// back on its next request and resolves the promise, letting Claude Code
// continue the very same turn.
//
// Transport: MCP "Streamable HTTP"; JSON responses, except a tools/call which is
// answered as a one-event SSE stream with keepalive comments while it is parked. Bound to 127.0.0.1; every session has its own
// path + random token, and a session's tool list is fixed for its lifetime.

import crypto from "node:crypto";

type Json = Record<string, unknown>;

// The node runs under Bun (index.ts refuses Node); keep the type surface we use minimal instead of pulling bun-types.
declare const Bun: {
  serve(opts: { hostname: string; port: number; idleTimeout?: number; fetch: (req: Request) => Response | Promise<Response> }): { port?: number; stop(closeActive?: boolean): void };
};

export interface McpToolDef {
  name: string;
  description?: string;
  input_schema?: Json;
}

export interface PendingToolCall {
  callId: string;
  name: string;
  input: Json;
  resolve: (result: { content: string; isError: boolean }) => void;
  startedAt: number;
}

interface McpSession {
  sid: string;
  token: string;
  tools: McpToolDef[];
  pending: Map<string, PendingToolCall>;
  /** Observer: a new call is waiting for the client's result. */
  onCall: (call: PendingToolCall) => void;
}

const PROTOCOL_VERSION = "2025-03-26";
/** SSE comment cadence on a parked tools/call; well inside undici's 300 s body timeout and Bun's idle timeout. */
const KEEPALIVE_MS = 10_000;

export class McpServer {
  private server: { port?: number; stop(closeActive?: boolean): void } | null = null;
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly log: (m: string) => void = () => {}) {}

  start(): number {
    if (this.server) return this.server.port ?? 0;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 255, // seconds (Bun's maximum); the SSE keepalive below keeps parked calls well inside it
      fetch: (req: Request) => this.handle(req),
    });
    this.log(`mcp server on 127.0.0.1:${this.server.port}`);
    return this.server.port ?? 0;
  }

  stop(): void {
    for (const s of this.sessions.values()) this.unregister(s.sid, "server stopped");
    this.server?.stop(true);
    this.server = null;
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  /** Register a session's tool set; returns the URL to put in the process's mcp-config. */
  register(sid: string, tools: McpToolDef[], onCall: (call: PendingToolCall) => void): string {
    const token = crypto.randomBytes(16).toString("hex");
    this.sessions.set(sid, { sid, token, tools, pending: new Map(), onCall });
    return `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(sid)}/${token}`;
  }

  /** Drop a session; any parked calls fail so the process can finish or die cleanly. */
  unregister(sid: string, reason = "session closed"): void {
    const s = this.sessions.get(sid);
    if (!s) return;
    for (const p of s.pending.values()) p.resolve({ content: `tool call aborted: ${reason}`, isError: true });
    s.pending.clear();
    this.sessions.delete(sid);
  }

  pendingCount(sid: string): number {
    return this.sessions.get(sid)?.pending.size ?? 0;
  }

  isPending(sid: string, callId: unknown): boolean {
    return typeof callId === "string" && (this.sessions.get(sid)?.pending.has(callId) ?? false);
  }

  /** The client's tool_result for one parked call; false when unknown (already answered / expired). */
  resolveCall(sid: string, callId: string, content: string, isError: boolean): boolean {
    const s = this.sessions.get(sid);
    const p = s?.pending.get(callId);
    if (!s || !p) return false;
    s.pending.delete(callId);
    p.resolve({ content, isError });
    return true;
  }

  /** Fail every parked call of a session (timeout / retire) without dropping the registration. */
  failPending(sid: string, reason: string): number {
    const s = this.sessions.get(sid);
    if (!s) return 0;
    const n = s.pending.size;
    for (const p of s.pending.values()) p.resolve({ content: `tool call aborted: ${reason}`, isError: true });
    s.pending.clear();
    return n;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/mcp\/([^/]+)\/([0-9a-f]{32})$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const s = this.sessions.get(decodeURIComponent(m[1]));
    if (!s || s.token !== m[2]) return new Response("not found", { status: 404 });
    if (req.method === "GET") return new Response("SSE stream not offered", { status: 405 });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    const msgs = Array.isArray(body) ? body : [body];
    // A parked tools/call can wait minutes for the client's tool_result. Claude Code's HTTP client
    // (Node undici) gives up when no response *headers* arrive within 300 s and then no body
    // bytes for 300 s: the model got a timeout error instead of the client's result and re-issued
    // the call (2026-10-22). Answer such a call as an SSE stream — headers at once, a comment
    // line every KEEPALIVE_MS, the JSON-RPC response as the one event when it is in — which the
    // Streamable HTTP client accepts for any POST.
    const single = !Array.isArray(body) && String((body as Json).method ?? "") === "tools/call" && (body as Json).id !== undefined;
    if (single && (req.headers.get("accept") ?? "").includes("text/event-stream")) {
      const encoder = new TextEncoder();
      const dispatch = this.dispatch(s, body as Json);
      let timer: ReturnType<typeof setInterval> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const write = (t: string) => {
            try {
              controller.enqueue(encoder.encode(t));
            } catch {
              /* client gone */
            }
          };
          write(": open\n\n");
          timer = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);
          void dispatch.then((r) => {
            if (timer) clearInterval(timer);
            timer = null;
            if (r) write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        },
        cancel: () => {
          if (timer) clearInterval(timer);
          timer = null;
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
    }
    const replies: Json[] = [];
    for (const msg of msgs) {
      const r = await this.dispatch(s, msg as Json);
      if (r) replies.push(r);
    }
    if (replies.length === 0) return new Response(null, { status: 202 }); // notifications only
    return json(Array.isArray(body) ? replies : replies[0], 200);
  }

  private async dispatch(s: McpSession, msg: Json): Promise<Json | null> {
    const id = msg.id as string | number | undefined;
    const method = String(msg.method ?? "");
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Json;
    if (id === undefined) return null; // notification (initialized, cancelled, …)
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "caller", version: "1.0.0" },
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: s.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              inputSchema: t.input_schema ?? { type: "object", properties: {} },
              // Claude Code runs MCP tools one at a time unless the server marks them read-only
              // (bundle: isConcurrencySafe = annotations.readOnlyHint). Nothing runs here — the
              // client executes its own tools — so every call is "read-only" from this process's
              // point of view, and parallel tool_use blocks must all be issued at once: with
              // sequential execution the second call only appeared after the first timed out
              // (60 s), and the model got a timeout error instead of the client's result (2026-10-17).
              annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            })),
          },
        };
      case "tools/call": {
        const name = String(params.name ?? "");
        if (!s.tools.some((t) => t.name === name)) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } };
        }
        const input = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json;
        const callId = `call_${crypto.randomBytes(8).toString("hex")}`;
        const result = await new Promise<{ content: string; isError: boolean }>((resolve) => {
          const call: PendingToolCall = { callId, name, input, resolve, startedAt: Date.now() };
          s.pending.set(callId, call);
          s.onCall(call);
        });
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result.content }], isError: result.isError } };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
