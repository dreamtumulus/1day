import crypto from "node:crypto";
import { CompanionManager } from "./companion.js";
import { AnthropicToOpenaiStream, anthropicMessageToOpenai, openaiChatToAnthropic } from "./convert.js";
import { Egress, EgressError } from "./egress.js";
import { conversationSession, metadataSession, pinIdentity } from "./identity.js";
import { OAuthManager } from "./oauth.js";
import { ACTIVE_PROFILE, agentBody, agentHeaders, claudeCodeLike, isClaudeCodeRequest, nativeProfileOverrides, normalizeNativeBody } from "./profile.js";
import { StateStore } from "./state.js";
import type { GatewayConfig, Json, RuntimeAccount } from "./types.js";

const DEFAULT_MODELS = ["claude-sonnet-4-5-20250929", "claude-opus-5-5"];
const DROP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "expect", "authorization", "x-api-key", "proxy-authorization", "proxy-connection", "via", "forwarded", "x-real-ip"]);

type Dialect = "anthropic" | "openai";

function errorResponse(dialect: Dialect, status: number, code: string, message: string): Response {
  const error = dialect === "anthropic"
    ? { type: "error", error: { type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "invalid_request_error", message, code } }
    : { error: { type: status === 401 ? "authentication_error" : "invalid_request_error", message, code } };
  return Response.json(error, { status });
}

function modelMatches(pattern: string, model: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return regex.test(model);
}

function responseHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of ["connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]) out.delete(name);
  out.set("x-accel-buffering", "no");
  return out;
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        try { yield JSON.parse(data) as Json; } catch {}
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export class DirectGateway {
  private readonly accounts: RuntimeAccount[];
  private readonly oauth: OAuthManager;
  readonly companion: CompanionManager;
  private readonly affinity = new Map<string, string>();
  private readonly inFlight = new Map<string, number>();
  private readonly lastUsed = new Map<string, number>();

  constructor(readonly config: GatewayConfig, private readonly state: StateStore, private readonly egress = new Egress()) {
    this.accounts = config.accounts.filter((a) => a.enabled !== false).map((a) => state.account(a, config.nodeName));
    this.oauth = new OAuthManager(state, egress);
    this.companion = new CompanionManager(config, state, egress);
  }

  async start(): Promise<void> {
    await this.companion.startAll(this.accounts);
  }

  async close(): Promise<void> {
    await this.companion.stopAll();
    this.egress.close();
  }

  fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", service: "1dayapi-direct", node: this.config.nodeName, profile: ACTIVE_PROFILE.claudeCodeVersion, companion: this.companion.stats() });
    }
    const dialect: Dialect = url.pathname === "/v1/chat/completions" ? "openai" : "anthropic";
    const clientKey = this.clientKey(request);
    if (!clientKey) return errorResponse(dialect, 401, "invalid_api_key", "Missing or invalid gateway API key");
    if (request.method === "GET" && url.pathname === "/v1/models") return this.modelsResponse();
    if (request.method !== "POST") return errorResponse(dialect, 404, "not_found", "Endpoint not found");
    if (url.pathname !== "/v1/messages" && url.pathname !== "/v1/chat/completions" && url.pathname !== "/v1/messages/count_tokens") {
      return errorResponse(dialect, 404, "not_found", "Endpoint not found");
    }
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 32 * 1024 * 1024) return errorResponse(dialect, 413, "request_too_large", "Request body exceeds 32 MB");
    let body: Json;
    try { body = await request.json() as Json; } catch { return errorResponse(dialect, 400, "invalid_json", "Request body must be valid JSON"); }
    if (typeof body.model !== "string" || !body.model) return errorResponse(dialect, 400, "missing_model", "model is required");
    if (url.pathname === "/v1/messages/count_tokens") return this.handle(request, body, clientKey, "anthropic", true);
    return this.handle(request, body, clientKey, dialect, false);
  };

  private clientKey(request: Request): string | null {
    const bearer = request.headers.get("authorization");
    const value = bearer?.startsWith("Bearer ") ? bearer.slice(7) : request.headers.get("x-api-key") ?? "";
    for (const candidate of this.config.clientApiKeys) {
      const a = Buffer.from(value);
      const b = Buffer.from(candidate);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return candidate;
    }
    return null;
  }

  private modelsResponse(): Response {
    const models = new Set<string>();
    for (const account of this.accounts) {
      for (const pattern of account.models ?? DEFAULT_MODELS) {
        if (pattern.includes("*")) for (const model of DEFAULT_MODELS) if (modelMatches(pattern, model)) models.add(model);
        else models.add(pattern);
      }
    }
    return Response.json({ object: "list", data: [...models].sort().map((id) => ({ id, object: "model", created: 0, owned_by: "anthropic" })) });
  }

  private selectAccount(model: string, sessionKey: string): RuntimeAccount | null {
    const candidates = this.accounts.filter((a) => (a.models ?? DEFAULT_MODELS).some((p) => modelMatches(p, model)));
    const bound = this.affinity.get(sessionKey);
    if (bound) return candidates.find((a) => a.id === bound) ?? null;
    return candidates.sort((a, b) => (this.inFlight.get(a.id) ?? 0) - (this.inFlight.get(b.id) ?? 0) || (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0) || a.id.localeCompare(b.id))[0] ?? null;
  }

  private async handle(request: Request, input: Json, clientKey: string, dialect: Dialect, countTokens: boolean): Promise<Response> {
    const native = dialect === "anthropic" && isClaudeCodeRequest(request.headers, input);
    if (dialect === "anthropic" && claudeCodeLike(request.headers) && !native) {
      console.log(`[direct] repairing non-canonical Claude Code request model=${input.model}`);
    }
    const sessionId = native ? metadataSession(input.metadata?.user_id)! : conversationSession(request.headers, input, clientKey, input.model);
    const sessionKey = `${clientKey}:${input.model}:${sessionId}`;
    const selected = this.selectAccount(input.model, sessionKey);
    if (!selected) return errorResponse(dialect, 503, "no_available_account", "No bound or eligible worker-0 account is available");
    this.affinity.set(sessionKey, selected.id);
    this.inFlight.set(selected.id, (this.inFlight.get(selected.id) ?? 0) + 1);
    this.lastUsed.set(selected.id, Date.now());
    const started = Date.now();
    try {
      let account = await this.oauth.fresh(selected);
      Object.assign(selected, account);
      await this.companion.sync(account);
      const source = dialect === "openai" ? openaiChatToAnthropic(input, input.model) : input;
      const normalizedSource = native ? normalizeNativeBody(source, request.headers) : source;
      let body = native ? pinIdentity({ ...normalizedSource }, account, sessionId) : agentBody(source, input.model, account, sessionId);
      if (countTokens) {
        const { max_tokens: _max, thinking: _thinking, context_management: _context, stream: _stream, ...rest } = body;
        body = rest;
      }
      const path = countTokens ? "/v1/messages/count_tokens" : "/v1/messages?beta=true";
      const send = async (current: RuntimeAccount): Promise<Response> => {
        const headers = native ? this.nativeHeaders(request.headers, current) : agentHeaders(sessionId, current);
        return this.egress.request(account = current, `${current.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal });
      };
      let response = await send(account);
      if (response.status === 401 && account.refreshToken) {
        await response.body?.cancel();
        account = await this.oauth.fresh(account, true);
        Object.assign(selected, account);
        await this.companion.sync(account);
        response = await send(account);
      }
      console.log(`[direct] account=${account.id} model=${input.model} status=${response.status} ms=${Date.now() - started}`);
      if (!response.ok) return this.upstreamError(response, dialect);
      if (countTokens || dialect === "anthropic") return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) });
      if (input.stream === true && (response.headers.get("content-type") ?? "").includes("text/event-stream")) return this.openAiStream(response, input);
      const json = await response.json() as Json;
      return Response.json(anthropicMessageToOpenai(json, input.model));
    } catch (error) {
      const code = error instanceof EgressError ? error.code : "upstream_error";
      const status = code === "no_proxy_available" ? 503 : 502;
      return errorResponse(dialect, status, code, (error as Error).message);
    } finally {
      this.inFlight.set(selected.id, Math.max(0, (this.inFlight.get(selected.id) ?? 1) - 1));
    }
  }

  private nativeHeaders(incoming: Headers, account: RuntimeAccount): Record<string, string> {
    const headers: Record<string, string> = {};
    incoming.forEach((value, key) => {
      const name = key.toLowerCase();
      if (DROP_HEADERS.has(name) || name.startsWith("cf-") || name.startsWith("x-forwarded-") || name.startsWith("x-1dayapi-")) return;
      headers[name] = value;
    });
    Object.assign(headers, nativeProfileOverrides(incoming));
    headers["content-type"] = "application/json";
    headers["accept-encoding"] = "gzip, deflate, br, zstd";
    const betas = new Set((headers["anthropic-beta"] ?? "").split(",").filter(Boolean));
    betas.add("claude-code-20250219");
    if (account.accessToken) {
      headers.authorization = `Bearer ${account.accessToken}`;
      betas.add("oauth-2025-04-20");
    } else headers["x-api-key"] = account.apiKey!;
    headers["anthropic-beta"] = [...betas].join(",");
    return headers;
  }

  private async upstreamError(response: Response, dialect: Dialect): Promise<Response> {
    const text = await response.text();
    if (dialect === "anthropic") return new Response(text, { status: response.status, headers: responseHeaders(response.headers) });
    let message = text || `Upstream HTTP ${response.status}`;
    let type = "api_error";
    try {
      const json = JSON.parse(text) as Json;
      message = String(json.error?.message ?? json.message ?? message);
      type = String(json.error?.type ?? type);
    } catch {}
    return Response.json({ error: { message, type, code: `upstream_${response.status}` } }, { status: response.status });
  }

  private openAiStream(response: Response, input: Json): Response {
    const converter = new AnthropicToOpenaiStream(input.model, input.stream_options?.include_usage === true);
    const events = sseEvents(response.body!);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const event of events) {
            for (const chunk of converter.push(event)) controller.enqueue(encoder.encode(chunk));
          }
          for (const chunk of converter.end()) controller.enqueue(encoder.encode(chunk));
        } catch (error) {
          if (!converter.errored) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: (error as Error).message, type: "api_error" } })}\n\n`));
        } finally {
          controller.close();
        }
      },
      async cancel() {
        await events.return(undefined);
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  }
}
