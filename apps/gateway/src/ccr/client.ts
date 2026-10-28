// HTTP client for the cloud session API (docs/ccr-supply.md §3–§5).
// Paths are relative to the account's effective base URL so a mock can stand
// in for api.anthropic.com in E2E tests.

import { responseBytes } from "../lifecycle.js";
import { CCR, anthropicFingerprintHeaders, type Credential } from "@1dayapi/core";
import type { CcrSession, EventPayload, SessionEvent } from "./types.js";

type Json = Record<string, any>;

/** Non-2xx from the session API; carries the upstream status for failover bookkeeping. */
export class CcrHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterSec?: number,
  ) {
    super(`ccr upstream HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

export interface CcrClientOptions {
  baseUrl: string;
  cred: Credential;
  clientHeaders: Record<string, string | string[] | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * fetch-shaped override (docs/onboarding.md §6.2): route=node CCR accounts
   * send session API calls through the provider-node tunnel pinned to the
   * account's bound proxy. Defaults to direct fetch.
   */
  transport?: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;
}

export class CcrClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly transport: NonNullable<CcrClientOptions["transport"]>;

  constructor(o: CcrClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = o.timeoutMs;
    this.signal = o.signal;
    this.transport =
      o.transport ??
      ((url, init) =>
        fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
        }));
    this.headers = {
      ...anthropicFingerprintHeaders(o.clientHeaders),
      "content-type": "application/json",
      authorization: `Bearer ${o.cred.accessToken ?? ""}`,
      "anthropic-version": CCR.anthropicVersion,
      "anthropic-beta": CCR.beta,
      "anthropic-client-feature": CCR.clientFeature,
    };
    if (o.cred.orgUuid) this.headers["x-organization-uuid"] = o.cred.orgUuid;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
    const res = await this.transport(this.base + path, {
      method,
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = (await responseBytes(res, 8_388_608, this.signal)).toString("utf8");
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after"));
      throw new CcrHttpError(res.status, text, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as Json;
    } catch {
      throw new CcrHttpError(502, `non-JSON body: ${text.slice(0, 120)}`);
    }
  }

  /** §3 — once per account; returns the environment id. */
  async createEnvironment(name: string): Promise<string> {
    const j = await this.call("POST", CCR.environmentCreatePath, {
      name,
      kind: "anthropic_cloud",
      description: "1dayAPI cloud session supply",
    });
    const id = j.environment_id ?? j.id;
    if (typeof id !== "string" || !id) throw new CcrHttpError(502, "environment create returned no environment_id");
    return id;
  }

  /** §4 */
  async createSession(environmentId: string, model: string, name: string): Promise<CcrSession> {
    const j = await this.call("POST", CCR.sessionsPath, {
      environment_id: environmentId,
      config: { model, sources: [], outcomes: [], cwd: "/workspace", name },
    });
    const id = j.session?.id ?? j.id;
    if (typeof id !== "string" || !id) throw new CcrHttpError(502, `session create returned no session id: ${JSON.stringify(j).slice(0, 240)}`);
    return { id };
  }

  /** §5 push */
  async pushEvents(sessionId: string, events: SessionEvent[]): Promise<void> {
    await this.call("POST", `${CCR.sessionsPath}/${encodeURIComponent(sessionId)}/events`, { events });
  }

  /** §5.3: release a pooled session. 200 and 409 (already archived) both count as success. */
  async archiveSession(sessionId: string): Promise<void> {
    try {
      await this.call("POST", `${CCR.sessionsPath}/${encodeURIComponent(sessionId)}/archive`);
    } catch (err) {
      if (err instanceof CcrHttpError && (err.status === 409 || err.status === 404)) return;
      throw err;
    }
  }

  /**
   * §5 read-back. PROVISIONAL pagination: follows `next_cursor` while
   * `has_more` is set; accepts either `events` or `data` as the array key
   * and bare payloads as well as `{payload}` envelopes.
   */
  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    let cursor: string | null = null;
    let bytes = 0;
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ sort_order: "asc" });
      if (cursor) qs.set("cursor", cursor);
      const j = await this.call("GET", `${CCR.sessionsPath}/${encodeURIComponent(sessionId)}/events?${qs}`);
      const arr: unknown[] = Array.isArray(j.events) ? j.events : Array.isArray(j.data) ? j.data : [];
      bytes += JSON.stringify(arr).length;
      if (bytes > 33_554_432 || out.length + arr.length > 50_000) throw new CcrHttpError(502, "session event history exceeds budget");
      for (const raw of arr) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Json;
        const id = typeof r.id === "string" ? r.id : undefined;
        if (r.payload && typeof r.payload === "object" && typeof r.payload.type === "string") {
          out.push({ id, payload: r.payload as EventPayload });
        } else if (typeof r.type === "string") {
          out.push({ id, payload: r as EventPayload });
        }
      }
      if (j.has_more && typeof j.next_cursor === "string") cursor = j.next_cursor;
      else break;
    }
    return out;
  }
}
