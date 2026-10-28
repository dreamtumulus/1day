// CCR executor (docs/ccr-supply.md §4–§5, §8): runs one Messages request as a
// cloud session and returns an Anthropic-wire `Response` (JSON or SSE), so the
// gateway's existing delivery / usage / settlement pipeline handles it exactly
// like a passthrough-anthropic upstream.
//
// Session policy (§5.3, X-12 resolved): sticky-keyed requests reuse a pooled
// warm session (turns/idle/error caps, archive on retire); stateless requests
// still create a fresh session per request and archive it on completion.

import { encryptJson, sha256Hex, nowIso, run, INTERNAL_HEADER, internalToken, accountBaseUrl, getSetting, one, readCredential, writeCredential, type AccountRow, type Credential } from "@1dayapi/core";
import { wait, StreamDemand } from "../lifecycle.js";
import { config } from "../config.js";
import { pinnedTunnelTransport, type IsolationContext } from "../tunnel.js";
import { CcrClient, CcrHttpError } from "./client.js";
import { CcrSessionPool, type PoolEntry } from "./session-pool.js";
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
  /** Client conversation sticky key (proxy.ts); null/undefined = stateless, never pooled (§5.3 污染防护). */
  stickyKey?: string | null;
  isolation?: IsolationContext;
  signal?: AbortSignal;
}



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

// ---------- session pool (§5.3) ----------

function clientFor(a: AccountRow, cred: Credential): CcrClient | null {
  const base = accountBaseUrl(a);
  if (!base || !cred.accessToken) return null;
  const transport = a.route === "node" ? pinnedTunnelTransport(a.id, a.bound_proxy_id) : undefined;
  return new CcrClient({ baseUrl: base, cred, clientHeaders: {}, timeoutMs: config.ccrHttpTimeoutMs, transport });
}

/** Archive a retired session upstream; falls back to the entry's snapshot when the account row is already deleted. */
async function archivePoolEntry(e: PoolEntry): Promise<void> {
  try {
    const a = one<AccountRow>("SELECT * FROM accounts WHERE id = ?", e.accountId);
    const ctx = e.archiveCtx;
    if (ctx?.route === "node") {
      const snapshot = { accountId: e.accountId, nodeId: ctx.nodeId, teamId: ctx.teamId, proxyId: ctx.boundProxyId, baseUrl: ctx.baseUrl, sessionId: e.sessionId, cred: { accessToken: ctx.cred.accessToken, orgUuid: ctx.cred.orgUuid } };
      const id = sha256Hex(JSON.stringify([snapshot.accountId, snapshot.nodeId, snapshot.teamId, snapshot.proxyId, snapshot.sessionId]));
      run("INSERT INTO ccr_archive_jobs(id,payload_enc,next_attempt_at,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING", id, encryptJson(snapshot), nowIso(), nowIso());
      const res = await fetch(`${config.consoleBase}/internal/tunnel/archive`, {
        method: "POST", headers: { "content-type": "application/json", [INTERNAL_HEADER]: internalToken },
        body: JSON.stringify(snapshot),
        signal: AbortSignal.timeout(config.ccrHttpTimeoutMs),
      });
      if (!res.ok) throw new Error(`cleanup tunnel HTTP ${res.status}`);
      const result = await res.json() as { status?: number };
      if (![200, 202, 204, 404, 409].includes(result.status ?? 0)) throw new Error(`archive upstream HTTP ${result.status}`);
      return;
    }
    let client: CcrClient | null = null;
    if (a) client = clientFor(a, readCredential(a));
    else if (ctx) client = new CcrClient({ baseUrl: ctx.baseUrl, cred: ctx.cred, clientHeaders: {}, timeoutMs: config.ccrHttpTimeoutMs });
    if (!client) return;
    await client.archiveSession(e.sessionId);
    console.log(`[ccr-pool] archived ${e.sessionId} (account ${e.accountId}, turns=${e.turns})`);
  } catch (err) {
    console.warn(`[ccr-pool] archive failed for ${e.sessionId}: ${(err as Error).message}`);
  }
}

const pool = new CcrSessionPool(
  {
    isAccountAlive: (id) => !!one("SELECT 1 FROM accounts WHERE id = ? AND status = 'active' AND review_status = 'approved'", id),
    archive: (e) => void archivePoolEntry(e),
  },
  { maxTurns: config.ccrPoolMaxTurns, idleMs: config.ccrPoolIdleMs },
);
setInterval(() => pool.sweep(), config.ccrPoolSweepMs).unref();

export function retireCcrConversation(isolation: IsolationContext): void {
  pool.invalidateStickyNamespace(`team:${isolation.teamId}:conversation:${isolation.conversationId}:generation:${isolation.generation}:`);
}

export async function runCcr(input: CcrRunInput): Promise<Response> {
  const requestAbort = new AbortController();
  input = { ...input, signal: input.signal ? AbortSignal.any([input.signal, requestAbort.signal]) : requestAbort.signal };
  const { account, cred, body, stream } = input;
  if (!cred.accessToken) return errorResponse(401, "ccr: credential has no accessToken");
  if (!cred.orgUuid) return errorResponse(401, "ccr: credential has no orgUuid (x-organization-uuid)");
  const base = accountBaseUrl(account);
  if (!base) return errorResponse(502, "ccr: account has no base URL");

  // route=node: every session API call egresses through the account's node on
  // its bound proxy (docs/onboarding.md §6.2); executor=direct is unchanged.
  const transport =
    account.route === "node" ? pinnedTunnelTransport(account.id, account.bound_proxy_id, input.isolation, input.signal) : undefined;
  const client = new CcrClient({ baseUrl: base, cred, signal: input.signal, clientHeaders: input.clientHeaders, timeoutMs: config.ccrHttpTimeoutMs, transport });
  const prompt = messagesToPrompt(body);
  const translator = new SessionTranslator({
    model: input.clientModel,
    simulateTools: Array.isArray(body.tools) && body.tools.length > 0,
    cacheBaseline: Number(getSetting("ccr_cache_baseline_cloud")),
    cacheWriteAsInput: getSetting("ccr_cache_write_as_input") !== "0",
  });

  // §5.3: sticky-keyed requests reuse a pooled warm session; stateless ones
  // create a fresh session per request and archive it on completion.
  const stickyKey = input.stickyKey ?? null;
  const warmCap = account.concurrency > 0 ? account.concurrency : 8;
  const archiveCtx = { baseUrl: base, cred, route: account.route, boundProxyId: account.bound_proxy_id, nodeId: account.node_id, teamId: cred.orgUuid };

  let entry = pool.acquire(account.id, input.upstreamModel, stickyKey);
  let sessionId = ""; // assigned on every path that reaches past the catch
  try {
    const envId = await ensureEnvironment(client, account, cred);
    if (entry) {
      sessionId = entry.sessionId;
      try {
        // Model is part of the pool key: skip the redundant set_model on reuse.
        await client.pushEvents(sessionId, buildSessionEvents(sessionId, input.upstreamModel, prompt).slice(1));
      } catch (err) {
        if (err instanceof CcrHttpError && err.status === 404) {
          pool.invalidate(entry); // archived/expired upstream: fall through to a fresh session
          entry = null;
        } else {
          throw err;
        }
      }
    }
    if (!entry) {
      let session;
      try {
        session = await client.createSession(envId, input.upstreamModel, `1dayapi ${input.requestId}`);
      } catch (err) {
        // A persisted environment that upstream no longer knows (deleted/expired)
        // answers 400/404 forever: drop it and provision a fresh one once.
        if (!(err instanceof CcrHttpError && (err.status === 400 || err.status === 404) && cred.environmentId)) throw err;
        console.warn(`[ccr] environment ${cred.environmentId} rejected (${err.status}); re-provisioning for ${account.id}`);
        writeCredential(account.id, { ...cred, environmentId: undefined });
        const freshEnvId = await ensureEnvironment(client, account, { ...cred, environmentId: undefined });
        session = await client.createSession(freshEnvId, input.upstreamModel, `1dayapi ${input.requestId}`);
      }
      sessionId = session.id;
      await client.pushEvents(sessionId, buildSessionEvents(sessionId, input.upstreamModel, prompt));
      entry = pool.register(account.id, input.upstreamModel, stickyKey, sessionId, warmCap, archiveCtx);
    }
  } catch (err) {
    if (entry) pool.release(entry, true);
    else if (sessionId) void archivePoolEntry({ accountId: account.id, model: input.upstreamModel, stickyKey: "", sessionId, turns: 0, consumedEvents: new Set(), busy: false, hadError: true, createdAt: Date.now(), lastUsedAt: Date.now(), archiveCtx });
    return toResponse(err);
  }
  console.log(`[ccr] ${input.requestId} session ${sessionId} on ${account.name} ${pool.logLine()}`);

  let poolDone = false;
  const finishPool = (error: boolean): void => {
    if (poolDone) return;
    poolDone = true;
    if (entry) pool.release(entry, error);
    else void archivePoolEntry({ accountId: account.id, model: input.upstreamModel, stickyKey: "", sessionId, turns: 1, consumedEvents: new Set(), busy: false, hadError: error, createdAt: Date.now(), lastUsedAt: Date.now(), archiveCtx }); // cleanup is independent of the client connection
  };

  const seen = entry?.consumedEvents ?? new Set<string>();
  const deadline = Date.now() + config.ccrSessionTimeoutMs;

  /** Poll once; returns new payloads in order. */
  const pollNew = async (): Promise<EventPayload[]> => {
    input.signal?.throwIfAborted();
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
        if (!translator.finished) await wait(config.ccrPollIntervalMs, input.signal);
      }
    } catch (err) {
      finishPool(true);
      return toResponse(err);
    }
    if (translator.error) {
      finishPool(true);
      return errorResponse(502, `ccr: ${translator.error}`);
    }
    if (translator.upstreamUsage) console.log(`[ccr] ${input.requestId} upstream modelUsage: ${JSON.stringify(translator.upstreamUsage).slice(0, 400)}`);
    finishPool(false);
    return new Response(JSON.stringify(translator.message()), { status: 200, headers: { "content-type": "application/json" } });
  }

  // Streaming: SSE body produced from the poll loop. Failures before the first
  // byte surface as an error Response; afterwards as an SSE `error` event.
  const encoder = new TextEncoder();
  let first: EventPayload[];
  try {
    first = await pollNew();
  } catch (err) {
    finishPool(true);
    return toResponse(err);
  }
  const demand = new StreamDemand();
  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
      const write = (s: string) => demand.write(controller, encoder.encode(s));
      try {
        for (const p of first) await write(translator.push(p));
        while (!translator.finished) {
          if (Date.now() > deadline) throw new Error(`session ${sessionId} timed out`);
          await wait(config.ccrPollIntervalMs, input.signal);
          for (const p of await pollNew()) await write(translator.push(p));
        }
        if (translator.error) {
          finishPool(true);
          await write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `ccr: ${translator.error}` } })}\n\n`);
        } else {
          if (translator.upstreamUsage) console.log(`[ccr] ${input.requestId} upstream modelUsage: ${JSON.stringify(translator.upstreamUsage).slice(0, 400)}`);
          finishPool(false);
          await write(translator.end());
        }
      } catch (err) {
        finishPool(true);
        await write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `ccr: ${(err as Error).message}` } })}\n\n`).catch(() => {});
      } finally {
        demand.close(controller);
      }
      })();
    },
    pull() { demand.pull(); },
    cancel() { demand.cancel(); requestAbort.abort(); finishPool(true); },
  });
  return new Response(bodyStream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
