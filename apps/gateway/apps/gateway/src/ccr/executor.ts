// CCR executor (docs/ccr-supply.md §4–§5, §8): runs one Messages request as a
// cloud session and returns an Anthropic-wire `Response` (JSON or SSE), so the
// gateway's existing delivery / usage / settlement pipeline handles it exactly
// like a passthrough-anthropic upstream.
//
// Session policy (X-12 pending): one session per request; the session is left
// to the platform's own lifecycle (no close call documented yet).

import { accountBaseUrl, writeCredential, type AccountRow, type Credential } from "@1dayapi/core";
import { config } from "../config.js";
import { pinnedTunnelTransport } from "../tunnel.js";
import { CcrClient, CcrHttpError } from "./client.js";
import { SessionTranslator, buildSessionEvents, messagesToPrompt } from "./translate.js";
import type { EventPayload, SessionEvent } from "./types.js";

type Json = Record<string, any>;

export interface CcrRunInput {
  account: AccountRow;
  cred: Credential;
  /** Anthropic Messages body (chat clients are converted before this point). */
  body: Json;
  /** Model to report back to the client. */
  clientModel: string;
  /** Model after model_mapping (what the session is configured with). */
  upstreamModel: string;
  stream: boolean;
  requestId: string;
  clientHeaders: Record<string, string | string[] | undefined>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function eventKey(e: SessionEvent, i: number): string {
  if (e.id) return `id:${e.id}`;
  const p = e.payload as Json;
  if (typeof p.uuid === "string") return `uuid:${p.uuid}:${p.type}`;
  return `idx:${i}`;
}

/** Error-shaped upstream Response so proxy.ts applies its normal status handling. */
function errorResponse(status: number, message: string, retryAfterSec?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfterSec) headers["retry-after"] = String(retryAfterSec);
  return new Response(JSON.stringify({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "api_error", message } }), { status, headers });
}

function toResponse(err: unknown): Response {
  // 诊断：故障转移会吞掉单账户的错误体，这里留一条日志（journal）。
  if (err instanceof CcrHttpError) {
    console.warn(`[ccr] upstream HTTP ${err.status}: ${(err.body || err.message).slice(0, 300)}`);
    return errorResponse(err.status, err.body || err.message, err.retryAfterSec);
  }
  const msg = (err as Error)?.message ?? String(err);
  console.warn(`[ccr] infra error: ${msg.slice(0, 300)}`);
  // Timeouts / network: 502 so the account gets a transient cooldown and the next one is tried.
  return errorResponse(502, `ccr: ${msg}`);
}

/** Resolve (lazily provisioning) the environment id, persisting it on success (§3). */
async function ensureEnvironment(client: CcrClient, account: AccountRow, cred: Credential): Promise<string> {
  if (cred.environmentId) return cred.environmentId;
  const envId = await client.createEnvironment(`1dayapi-${account.id.slice(0, 8)}`);
  writeCredential(account.id, { ...cred, environmentId: envId });
  console.log(`[ccr] provisioned environment ${envId} for account ${account.id}`);
  return envId;
}

export async function runCcr(input: CcrRunInput): Promise<Response> {
  const { account, cred, body, stream } = input;
  if (!cred.accessToken) return errorResponse(401, "ccr: credential has no accessToken");
  if (!cred.orgUuid) return errorResponse(401, "ccr: credential has no orgUuid (x-organization-uuid)");
  const base = accountBaseUrl(account);
  if (!base) return errorResponse(502, "ccr: account has no base URL");

  // route=node: every session API call egresses through the account's node on
  // its bound proxy (docs/onboarding.md §6.2); executor=direct is unchanged.
  const transport =
    account.route === "node" ? pinnedTunnelTransport(account.id, account.bound_proxy_id) : undefined;
  const client = new CcrClient({ baseUrl: base, cred, clientHeaders: input.clientHeaders, timeoutMs: config.ccrHttpTimeoutMs, transport });
  const prompt = messagesToPrompt(body);
  const translator = new SessionTranslator({
    model: input.clientModel,
    simulateTools: Array.isArray(body.tools) && body.tools.length > 0,
  });

  let sessionId: string;
  try {
    const envId = await ensureEnvironment(client, account, cred);
    const session = await client.createSession(envId, input.upstreamModel, `1dayapi ${input.requestId}`);
    sessionId = session.id;
    await client.pushEvents(sessionId, buildSessionEvents(sessionId, input.upstreamModel, prompt));
  } catch (err) {
    return toResponse(err);
  }
  console.log(`[ccr] ${input.requestId} session ${sessionId} on ${account.name}`);

  const seen = new Set<string>();
  const deadline = Date.now() + config.ccrSessionTimeoutMs;

  /** Poll once; returns new payloads in order. */
  const pollNew = async (): Promise<EventPayload[]> => {
    const events = await client.listEvents(sessionId);
    const fresh: EventPayload[] = [];
    events.forEach((e, i) => {
      const k = eventKey(e, i);
      if (seen.has(k)) return;
      seen.add(k);
      fresh.push(e.payload);
    });
    return fresh;
  };

  if (!stream) {
    try {
      while (!translator.finished) {
        if (Date.now() > deadline) throw new Error(`session ${sessionId} timed out after ${config.ccrSessionTimeoutMs}ms`);
        for (const p of await pollNew()) translator.push(p);
        if (!translator.finished) await sleep(config.ccrPollIntervalMs);
      }
    } catch (err) {
      return toResponse(err);
    }
    if (translator.error) return errorResponse(502, `ccr: ${translator.error}`);
    if (translator.upstreamUsage) console.log(`[ccr] ${input.requestId} upstream modelUsage: ${JSON.stringify(translator.upstreamUsage).slice(0, 400)}`);
    return new Response(JSON.stringify(translator.message()), { status: 200, headers: { "content-type": "application/json" } });
  }

  // Streaming: SSE body produced from the poll loop. Failures before the first
  // byte surface as an error Response; afterwards as an SSE `error` event.
  const encoder = new TextEncoder();
  let first: EventPayload[];
  try {
    first = await pollNew();
  } catch (err) {
    return toResponse(err);
  }
  const bodyStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (s: string) => {
        if (s) controller.enqueue(encoder.encode(s));
      };
      try {
        for (const p of first) write(translator.push(p));
        while (!translator.finished) {
          if (Date.now() > deadline) throw new Error(`session ${sessionId} timed out`);
          await sleep(config.ccrPollIntervalMs);
          for (const p of await pollNew()) write(translator.push(p));
        }
        if (translator.error) {
          write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `ccr: ${translator.error}` } })}\n\n`);
        } else {
          if (translator.upstreamUsage) console.log(`[ccr] ${input.requestId} upstream modelUsage: ${JSON.stringify(translator.upstreamUsage).slice(0, 400)}`);
          write(translator.end());
        }
      } catch (err) {
        write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `ccr: ${(err as Error).message}` } })}\n\n`);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(bodyStream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
