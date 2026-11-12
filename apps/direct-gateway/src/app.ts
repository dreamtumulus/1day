import crypto from "node:crypto";
import { clientVisibleUsage } from "./billing.js";
import { CompanionManager } from "./companion.js";
import { ControlPlaneClient, ControlPlaneError } from "./control-plane.js";
import { AnthropicToOpenaiStream, anthropicMessageToOpenai, openaiChatToAnthropic } from "./convert.js";
import { Egress, EgressError } from "./egress.js";
import { conversationSession, metadataSession, pinIdentity } from "./identity.js";
import { accountMachine, pinMachineEnvironment } from "./machine.js";
import { OAuthManager } from "./oauth.js";
import { alignBillingSuffix, assertOutgoingShape, canonicalBetas, canonicalBodyOrder, normalizeThinking, ShapeError } from "./shape.js";
import { ACTIVE_PROFILE, agentBody, agentHeaders, claudeCodeLike, isClaudeCodeRequest, nativeProfileOverrides, normalizeNativeBody } from "./profile.js";
import { StateStore } from "./state.js";
import { UsageAccumulator, collectText } from "./usage.js";
import type { GatewayConfig, Json, RuntimeAccount } from "./types.js";

const DEFAULT_MODELS = ["claude-sonnet-4-5-20250929", "claude-opus-5-5"];
const DROP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "expect", "authorization", "x-api-key", "proxy-authorization", "proxy-connection", "via", "forwarded", "x-real-ip"]);

type Dialect = "anthropic" | "openai";

interface Accounting {
  requestId: string;
  meter: UsageAccumulator;
  native: boolean;
  input: Json;
  upstreamBody: Json;
  clientKey: string;
  endpoint: string;
  started: number;
}

interface StreamBlock {
  raw: string;
  json: Json | null;
  terminal: boolean;
}

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

async function* streamBlocks(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamBlock> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index + match[0].length);
        buffer = buffer.slice(match.index + match[0].length);
        const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        let json: Json | null = null;
        if (data && data !== "[DONE]") {
          try { json = JSON.parse(data) as Json; } catch {}
        }
        yield { raw, json, terminal: json?.type === "message_stop" || data === "[DONE]" };
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
  private readonly controlPlane: ControlPlaneClient | null;
  readonly companion: CompanionManager;
  private readonly affinity = new Map<string, string>();
  private readonly inFlight = new Map<string, number>();
  private readonly lastUsed = new Map<string, number>();

  constructor(readonly config: GatewayConfig, private readonly state: StateStore, private readonly egress = new Egress()) {
    this.accounts = config.accounts.filter((a) => a.enabled !== false).map((a) => state.account(a, config.nodeName));
    this.controlPlane = config.controlPlane ? new ControlPlaneClient(config.controlPlane) : null;
    this.oauth = new OAuthManager(state, egress, this.controlPlane);
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
      return Response.json({ status: "ok", service: "1dayapi-direct", node: this.config.nodeName, profile: ACTIVE_PROFILE.claudeCodeVersion, companion: this.companion.stats(), controlPlane: this.controlPlane ? "aligned" : "standalone" });
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

  private selectAccount(model: string, sessionKey: string, eligibleIds?: string[]): RuntimeAccount | null {
    let candidates = this.accounts.filter((a) => (a.models ?? DEFAULT_MODELS).some((p) => modelMatches(p, model)));
    if (eligibleIds) candidates = candidates.filter((a) => eligibleIds.includes(a.id));
    const bound = this.affinity.get(sessionKey);
    if (bound) return candidates.find((a) => a.id === bound) ?? null;
    return candidates.sort((a, b) => {
      const ai = eligibleIds ? eligibleIds.indexOf(a.id) : 0;
      const bi = eligibleIds ? eligibleIds.indexOf(b.id) : 0;
      return ai - bi || (this.inFlight.get(a.id) ?? 0) - (this.inFlight.get(b.id) ?? 0) || (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0) || a.id.localeCompare(b.id);
    })[0] ?? null;
  }

  private async handle(request: Request, input: Json, clientKey: string, dialect: Dialect, countTokens: boolean): Promise<Response> {
    const requestId = crypto.randomUUID();
    const endpoint = new URL(request.url).pathname;
    let eligibleIds: string[] | undefined;
    if (this.controlPlane) {
      try {
        const admission = await this.controlPlane.admission({ requestId, clientKey, model: input.model, endpoint, stream: input.stream === true });
        eligibleIds = admission.accountIds;
      } catch (error) {
        if (error instanceof ControlPlaneError) return errorResponse(dialect, error.status, error.code, error.message);
        throw error;
      }
    }
    const native = dialect === "anthropic" && isClaudeCodeRequest(request.headers, input);
    if (dialect === "anthropic" && claudeCodeLike(request.headers) && !native) console.log(`[direct] repairing non-canonical Claude Code request model=${input.model}`);
    const sessionId = native ? metadataSession(input.metadata?.user_id)! : conversationSession(request.headers, input, clientKey, input.model);
    const sessionKey = `${clientKey}:${input.model}:${sessionId}`;
    const selected = this.selectAccount(input.model, sessionKey, eligibleIds);
    if (!selected) return errorResponse(dialect, 503, "no_available_account", "No bound or eligible worker-0 account is available");
    this.affinity.set(sessionKey, selected.id);
    this.inFlight.set(selected.id, (this.inFlight.get(selected.id) ?? 0) + 1);
    this.lastUsed.set(selected.id, Date.now());
    const started = Date.now();
    const meter = new UsageAccumulator();
    meter.observeRequest(input);
    let upstreamBody: Json = input;
    try {
      let account = await this.oauth.fresh(selected);
      Object.assign(selected, account);
      await this.companion.sync(account);
      const source = dialect === "openai" ? openaiChatToAnthropic(input, input.model) : input;
      const normalizedSource = native ? normalizeNativeBody(source, request.headers) : source;
      upstreamBody = native ? pinIdentity({ ...normalizedSource }, account, sessionId) : agentBody(source, input.model, account, sessionId);
      if (countTokens) {
        const { max_tokens: _max, thinking: _thinking, context_management: _context, stream: _stream, ...rest } = upstreamBody;
        upstreamBody = rest;
      }
      upstreamBody = alignBillingSuffix(canonicalBodyOrder(pinMachineEnvironment(normalizeThinking(upstreamBody, input.model), accountMachine(account), sessionId)));
      const path = countTokens ? "/v1/messages/count_tokens" : "/v1/messages?beta=true";
      const send = async (current: RuntimeAccount): Promise<Response> => {
        const headers = native ? this.nativeHeaders(request.headers, current) : agentHeaders(sessionId, current);
        assertOutgoingShape(headers, upstreamBody, countTokens);
        return this.egress.request(account = current, `${current.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(upstreamBody), signal: request.signal });
      };
      let response = await send(account);
      if (response.status === 401 && account.refreshToken) {
        await response.body?.cancel();
        account = await this.oauth.fresh(account, true);
        Object.assign(selected, account);
        await this.companion.sync(account);
        response = await send(account);
      }
      console.log(`[direct] request=${requestId} account=${account.id} model=${input.model} status=${response.status} ms=${Date.now() - started}`);
      if (!response.ok) {
        const text = await response.text();
        await this.accountEvent(account, input.model, response, text);
        const accounting = { requestId, meter, native, input, upstreamBody, clientKey, endpoint, started };
        await this.settle(account, accounting, response.status, `upstream_http_${response.status}`, text, false);
        return this.upstreamError(response, dialect, text);
      }
      await this.accountEvent(account, input.model, response, "");
      if (countTokens) return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) });
      const accounting = { requestId, meter, native, input, upstreamBody, clientKey, endpoint, started };
      if (input.stream === true && (response.headers.get("content-type") ?? "").includes("text/event-stream")) return this.streamResponse(response, input, account, accounting, dialect);
      const json = await response.json() as Json;
      this.observeNonStream(meter, json);
      await this.settle(account, accounting, 200, null, null, false);
      if (dialect === "anthropic") return Response.json(json, { headers: responseHeaders(response.headers) });
      return Response.json(anthropicMessageToOpenai(json, input.model));
    } catch (error) {
      const code = error instanceof ShapeError ? "cc_shape_mismatch" : error instanceof EgressError ? error.code : error instanceof ControlPlaneError ? error.code : "upstream_error";
      const status = error instanceof ShapeError ? 400 : error instanceof ControlPlaneError ? error.status : code === "no_proxy_available" ? 503 : 502;
      try {
        const headers = new Headers({ "content-type": "application/json" });
        await this.accountEvent(selected, input.model, { status, headers } as Response, (error as Error).message);
        await this.settle(selected, { requestId, meter, native, input, upstreamBody, clientKey, endpoint, started }, status, code, (error as Error).message, false);
      } catch {}
      return errorResponse(dialect, status, code, (error as Error).message);
    } finally {
      this.inFlight.set(selected.id, Math.max(0, (this.inFlight.get(selected.id) ?? 1) - 1));
    }
  }

  private observeNonStream(meter: UsageAccumulator, json: Json): void {
    meter.addAnthropic(json.usage);
    meter.addAnthropicContent(json.content);
    meter.observeModel(json.model);
    meter.addText(collectText(json));
  }

  private async accountEvent(account: RuntimeAccount, model: string, response: Response, text: string): Promise<void> {
    if (!this.controlPlane) return;
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    await this.controlPlane.accountEvent({ accountId: account.id, model, statusCode: response.status, headers, body: text, retryAfterSec: Number(response.headers.get("retry-after")) || undefined });
  }

  private async settle(account: RuntimeAccount, accounting: Accounting, statusCode: number, errorCode: string | null, errorMessage: string | null, partial: boolean): Promise<void> {
    if (!this.controlPlane) return;
    const { requestId, meter, native, input, upstreamBody, clientKey, endpoint, started } = accounting;
    const finalized = meter.finalize(input, { partial });
    const visible = clientVisibleUsage(finalized.usage, native, input, upstreamBody);
    await this.controlPlane.settle({
      requestId,
      clientKey,
      accountId: account.id,
      model: input.model,
      upstreamModel: input.model,
      actualModel: meter.actualModel,
      endpoint,
      stream: input.stream === true,
      statusCode,
      errorCode,
      errorMessage,
      usage: visible,
      usageEstimated: finalized.estimated,
      durationMs: Date.now() - started,
      streamTruncated: partial,
      toolCalls: meter.toolCalls,
      toolResults: meter.toolResults,
      mode: native ? "worker0-native" : "worker0-agent",
      upstreamStatus: statusCode,
      nodeId: this.config.nodeName,
      accountSwitched: false,
    });
  }

  private nativeHeaders(incoming: Headers, account: RuntimeAccount): Record<string, string> {
    const headers: Record<string, string> = {};
    incoming.forEach((value, key) => {
      const name = key.toLowerCase();
      if (DROP_HEADERS.has(name) || name.startsWith("cf-") || name.startsWith("x-forwarded-") || name.startsWith("x-1dayapi-")) return;
      headers[name] = value;
    });
    Object.assign(headers, nativeProfileOverrides(incoming, account));
    headers["content-type"] = "application/json";
    headers["accept-encoding"] = "gzip, deflate, br, zstd";
    if (account.accessToken) headers.authorization = `Bearer ${account.accessToken}`;
    else headers["x-api-key"] = account.apiKey!;
    headers["anthropic-beta"] = canonicalBetas(Boolean(account.accessToken), headers["anthropic-beta"]);
    return headers;
  }

  private upstreamError(response: Response, dialect: Dialect, text: string): Response {
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

  private observeStreamEvent(meter: UsageAccumulator, event: Json): void {
    if (event.type === "message_start") {
      meter.addAnthropic(event.message?.usage);
      meter.observeModel(event.message?.model);
    } else if (event.type === "message_delta") meter.addAnthropic(event.usage);
    else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") meter.toolCalls++;
    else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") meter.addText(event.delta.text);
  }

  private streamResponse(response: Response, input: Json, account: RuntimeAccount, accounting: Accounting, dialect: Dialect): Response {
    const blocks = streamBlocks(response.body!);
    const converter = dialect === "openai" ? new AnthropicToOpenaiStream(input.model, input.stream_options?.include_usage === true) : null;
    let completed = false;
    let settled = false;
    const finish = async (partial: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      await this.settle(account, accounting, 200, partial ? "upstream_stream_error" : null, partial ? "Upstream stream ended before its terminal event" : null, partial);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const encoder = new TextEncoder();
        let terminal: StreamBlock | null = null;
        try {
          for await (const block of blocks) {
            if (block.terminal) {
              terminal = block;
              completed = true;
              break;
            }
            if (block.json) this.observeStreamEvent(accounting.meter, block.json);
            if (converter) for (const chunk of converter.push(block.json ?? {})) controller.enqueue(encoder.encode(chunk));
            else controller.enqueue(encoder.encode(block.raw));
          }
          await finish(!completed);
          if (terminal && !converter) controller.enqueue(encoder.encode(terminal.raw));
          if (converter && terminal?.json) for (const chunk of converter.push(terminal.json)) controller.enqueue(encoder.encode(chunk));
          if (converter) for (const chunk of converter.end()) controller.enqueue(encoder.encode(chunk));
        } catch (error) {
          if (!settled) {
            try { await finish(true); } catch {}
          }
          if (converter) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: (error as Error).message, type: "api_error" } })}\n\n`));
          else controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: (error as Error).message } })}\n\n`));
        } finally {
          controller.close();
        }
      },
      cancel: async () => {
        await blocks.return(undefined);
        await finish(true);
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  }
}
