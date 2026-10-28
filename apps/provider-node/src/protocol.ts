/** WS protocol message shapes (docs/provider-protocol.md, json_base64_v1 only). */

export const PROTOCOL_CAPABILITIES = ["official_exit", "http_egress", "cc_worker", "team_isolation_v1"] as const;

export interface IsolationContext { teamId: string; conversationId: string; generation: number }
export interface IsolationReset { type: "isolation.reset"; isolation: IsolationContext; resetId: string }

export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Close reasons that permanently suppress reconnect until identity changes. */
export const SUPPRESS_RECONNECT_REASONS = new Set([
  "invalid_provider_secret",
  "node_paused",
  "node_revoked",
  "provider_identity_mismatch",
]);

export interface ProviderHello {
  type: "provider.hello";
  nodeId: string;
  providerId?: string;
  nodeVersion: string;
  capabilities: string[];
  acceptingSessions: boolean;
  runtimeTeamId?: string;
  isolatedContexts?: IsolationContext[];
  /** Sessions still running on the node (link grace, 2026-10-19): the platform fails the ones it held that are not listed. */
  sessions?: string[];
}

export interface ProviderHeartbeat {
  type: "provider.heartbeat";
  nodeId: string;
  inFlight: number;
  healthy: boolean;
  riskState?: "ready" | "cooling_down" | "auth_invalid";
  officialExit?: { activeSessions: number };
  acceptingSessions: boolean;
  /** v2 proxy pool report: id = sha256(url)[:12], url has userinfo stripped. */
  proxies?: ProxyStatusReport[];
  /** v2 sticky assignments: accountId -> proxyId. */
  assignments?: Record<string, string>;
  /**
   * Claude Code identities held in the per-account config dirs (.claude.json
   * userID / oauthAccount.accountUuid), delta since the last heartbeat (all on
   * the first one after connect). The platform pins these as the account's
   * device identity for the direct path too (docs/claude-code-compat.md §8).
   */
  ccIdentities?: Record<string, { deviceId: string | null; accountUuid: string | null; teamId?: string }>;
  /** Host / process metrics for the platform's node monitor (docs/operations.md §7.2). */
  host?: {
    totalMemMb: number;
    freeMemMb: number;
    load1: number;
    load5: number;
    cpus: number;
    uptimeSec: number;
    processRssMb: number;
    processUptimeSec: number;
    bunVersion: string | null;
    nodeVersion: string;
    bundleHash: string | null;
    draining: boolean;
  };
  /** Protocol-v2 egress sessions in flight. */
  egress?: { activeSessions: number };
  /** Worker mode telemetry (docs/ccr-supply.md §8.1); enabled=false when no claude binary. */
  ccWorker?: {
    enabled: boolean;
    claudeVersion: string | null;
    /** Startup isolation self-test failure (null = passed); see CcWorkerManager.selfTestError. */
    selfTestError?: string | null;
    /** Persistent session pool (docs/worker-sessions.md §2). */
    pool?: { live: number; idle: number; busy: number; maxLive: number; rssMb: number; evictions: Record<string, number> };
    maxConcurrency: number;
    active: number;
    queued: number;
  };
}

export interface OfficialExitOpen {
  type: "official_exit.open";
  sessionId: string;
  routeMode: "official_exit";
  providerId: string;
  nodeId: string;
  credentialBindingId: string;
  targetHost: string;
  targetPort: number;
  deadlineMs: number;
}

export interface OfficialExitOpenResponse {
  type: "official_exit.open_response";
  sessionId: string;
  accepted: boolean;
  reasonCode?: string;
}

export interface OfficialExitData {
  type: "official_exit.data";
  sessionId: string;
  seq: number;
  payloadBase64: string;
}

export interface OfficialExitClose {
  type: "official_exit.close";
  sessionId: string;
  reasonCode?: string;
}

export interface OfficialExitError {
  type: "official_exit.error";
  sessionId: string;
  errorCode: string;
  errorMessage?: string;
  retryable?: boolean;
}

// --- protocol v2: http_egress (docs/provider-protocol.md 协议 v2) ---

export interface HttpEgressOpen {
  /** Restricted cleanup of an archived/deleted account; cannot execute another path. */
  archiveSessionId?: string;
  type: "http_egress.open";
  sessionId: string;
  routeMode: "http_egress";
  providerId: string;
  nodeId: string;
  credentialBindingId: string;
  /** Sticky proxy assignment key. */
  accountId: string;
  isolation?: IsolationContext;
  /** Background probes / onboarding also require the proxy's team and account allowlist. */
  teamId?: string;
  /** Pinned pool proxy (docs/onboarding.md §6.2); overrides sticky assignment. */
  proxyId?: string;
  /** How long the node waits for the request spec line after accepting (ms). */
  deadlineMs: number;
  /** How long the node waits for upstream response headers once the request is sent (ms; default 300 s, cap 600 s). */
  headersTimeoutMs?: number;
}

export interface HttpEgressOpenResponse {
  type: "http_egress.open_response";
  sessionId: string;
  accepted: boolean;
  reasonCode?: string;
}

export interface HttpEgressData {
  type: "http_egress.data";
  sessionId: string;
  seq: number;
  payloadBase64: string;
}

export interface HttpEgressClose {
  type: "http_egress.close";
  sessionId: string;
  reasonCode?: string;
}

export interface HttpEgressError {
  type: "http_egress.error";
  sessionId: string;
  errorCode: string;
  errorMessage?: string;
  retryable?: boolean;
}

/** Platform pushes a full replacement of the node proxy pool. */
export interface ProxiesSet {
  type: "proxies.set";
  proxies: string[];
  proxyTeams?: Record<string, string>;
  proxyAccounts?: Record<string, string[]>;
}

export interface ProxyStatusReport {
  id: string;
  /** Redacted URL (userinfo stripped). */
  url: string;
  /** Last probe / request failure, null when healthy. */
  error?: string | null;
  /** null = not probed yet (platform keeps the row `unknown`). */
  live: boolean | null;
  latencyMs: number | null;
  exitIp?: string | null;
}

// --- cc_worker: on-node real Claude Code worker (docs/ccr-supply.md §8.1) ---

/** Credential material for .credentials.json; travels only inside the WSS envelope. */
export interface CcWorkerCred {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch or ISO string. */
  expiresAt?: number | string;
  subscriptionType?: string;
}

export interface CcWorkerOpen {
  type: "cc_worker.open";
  sessionId: string;
  routeMode: "cc_worker";
  providerId: string;
  nodeId: string;
  credentialBindingId: string;
  /** Pinned pool proxy (docs/onboarding.md §6.2); missing => sticky assignment. */
  proxyId?: string;
  accountId: string;
  isolation?: IsolationContext;
  model: string;
  /** Folded prompt (translate.messagesToPrompt), passed as `claude -p`. */
  prompt: string;
  /** System prompt replacing Claude Code's default (written to the scratch dir, `--system-prompt-file`). */
  systemPrompt?: string;
  /** Platform-side device id to seed a fresh config dir with (.claude.json userID); ignored when one exists. */
  deviceId?: string;
  /** Extended thinking budget for the process (`--max-thinking-tokens`); absent = Claude Code default. */
  thinkingBudget?: number;
  /** Reasoning effort for the process (`--effort low|medium|high|xhigh|max`); absent = default. */
  effort?: string;
  /** Client max_tokens → env CLAUDE_CODE_MAX_OUTPUT_TOKENS of the process; absent = Claude Code default. */
  maxTokens?: number;
  /**
   * Persistent session (docs/worker-sessions.md): keep the claude process alive
   * after this turn under `reuseKey`; `turnMode:"continue"` feeds only `content`
   * (the new turn) to the live process whose completed-turn counter equals
   * `expectedTurn`. When no such process can take the turn (busy, parked on tool
   * calls, exited, counter mismatch) the node starts a fresh process from
   * `history` (the whole conversation) — never from the tail alone.
   */
  persist?: boolean;
  reuseKey?: string;
  /** "tool_result": answer the parked MCP tool calls of the live process with `results`, same turn continues. */
  turnMode?: "fresh" | "continue" | "tool_result";
  expectedTurn?: number;
  /**
   * turnMode "continue": the full conversation as content blocks, used only when the
   * continue misses (2026-10-22). Without it a miss is refused (`session_lost`) rather
   * than answered from the tail — that was the 10-22 "history dropped" incident.
   */
  history?: Array<Record<string, unknown>>;
  /** Caller-defined tools served natively through the node's loopback MCP server (docs/worker-sessions.md §3). */
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  /** turnMode "tool_result": the client's tool results keyed by the node's callId. */
  results?: Array<{ callId: string; content: string; isError?: boolean }>;
  /** Messages-style content blocks (text + images). Present → `--input-format stream-json` with one user message on stdin. */
  content?: Array<Record<string, unknown>>;
  /** true => --include-partial-messages (stream_event increments). */
  stream?: boolean;
  cred: CcWorkerCred;
  deadlineMs: number;
}

export interface CcWorkerOpenResponse {
  type: "cc_worker.open_response";
  sessionId: string;
  accepted: boolean;
  reasonCode?: string;
}

export interface CcWorkerData {
  type: "cc_worker.data";
  sessionId: string;
  seq: number;
  payloadBase64: string;
}

export interface CcWorkerClose {
  type: "cc_worker.close";
  sessionId: string;
  reasonCode?: string;
}

export interface CcWorkerError {
  type: "cc_worker.error";
  sessionId: string;
  errorCode: string;
  errorMessage?: string;
  retryable?: boolean;
}

export type PlatformToNodeMessage =
  | { type: "platform.ready"; nodeId: string; /** Sessions the platform kept across the reconnect; absent on older platforms. */ retainedSessions?: string[] }
  | OfficialExitOpen
  | OfficialExitData
  | OfficialExitClose
  | HttpEgressOpen
  | HttpEgressData
  | HttpEgressClose
  | CcWorkerOpen
  | CcWorkerClose
  | IsolationReset
  | ProxiesSet;
