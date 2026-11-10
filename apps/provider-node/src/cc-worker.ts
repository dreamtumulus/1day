import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer, type PendingToolCall } from "./mcp-server.js";
import type { CcWorkerClose, CcWorkerCred, CcWorkerOpen } from "./protocol.js";
import type { ProxyPool } from "./proxy-pool.js";
import { IsolationGuard, sameIsolation, validIsolation } from "./isolation.js";
import type { IsolationContext } from "./protocol.js";
import { prepareMachineRuntime, machineEnvironment, type MachineRuntime } from "./machine-runtime.js";

// cc_worker mode (docs/ccr-supply.md §8.1): run the real Claude Code binary
// per request on this node and stream its stream-json stdout back as data
// frames. Credential material arrives inside the WSS open envelope and is
// materialized as the native `.credentials.json` under a per-account
// CLAUDE_CONFIG_DIR (0700/0600); tokens are never logged.
//
// Concurrency guardrail: measured peak is ~262MB/process, so at most
// floor((freeMemMB-512)/320) workers run at once (floor 1); excess opens queue
// FIFO (cap 30, then worker_overloaded). Each process is hard-killed after
// timeoutMs (default 600s).

const CC_VERSION_PIN = "2.1.312";
const FIXED_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const STDERR_TAIL = 4000;

/**
 * What to quote when claude exits: the shim's own line ("claude-tui: <why>: <screen>") names the cause at its head, and
 * the screen tail alone said nothing (2026-11-09: 41 × "claude exited 1: ─── ❯ [Pasted text #1 +58 lines]/var/lib/…" on
 * ccr-tui, the cause cut off by a tail-only quote). The last cause line first, then the tail of what was drawn.
 */
export function stderrCause(tail: string, max = 460): string {
  const t = tail.replace(/\s+/g, " ").trim();
  const at = t.lastIndexOf("claude-tui: ");
  if (at < 0) return t.slice(-max);
  const cause = t.slice(at);
  return cause.length <= max ? cause : `${cause.slice(0, max - 80)} … ${cause.slice(-70)}`;
}

/** claude 二进制解析：PATH 之外补查常见安装位置（systemd 服务 PATH 很窄）。 */
function findClaudeBin(): string {
  const candidates = [
    "claude",
    path.join(os.homedir(), ".bun", "bin", "claude"),
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    try {
      if (c === "claude") {
        const r = spawnSync("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
        if (!r.error && r.status === 0) return c;
      } else if (fs.existsSync(c)) {
        return c;
      }
    } catch {
      /* next */
    }
  }
  return "claude";
}

export function defaultMaxConcurrency(freeMemBytes = os.freemem()): number {
  return Math.max(1, Math.floor((freeMemBytes / 1_048_576 - 512) / 320));
}

interface QueuedOpen {
  msg: CcWorkerOpen;
  proxyUrl: string;
}

interface WorkerSession {
  isolation?: IsolationContext;
  sessionId: string;
  accountId: string;
  child: ChildProcess | null;
  closed: boolean;
  outSeq: number;
  stderrTail: string;
  timer: NodeJS.Timeout | null;
  /** Per-session scratch directory (cwd + HOME of the worker); removed when the session ends. null when a pooled process owns it. */
  workDir: string | null;
  /** Pooled claude process serving this turn (docs/worker-sessions.md); null for one-shot workers. */
  proc: Proc | null;
}

/** A live claude process kept across turns (persistent session, docs/worker-sessions.md §1). */
interface Proc {
  isolation?: IsolationContext;
  key: string;
  accountId: string;
  child: ChildProcess;
  workDir: string;
  /** Completed turns; the gateway's `expectedTurn` must match for a `continue`. */
  turn: number;
  busy: WorkerSession | null;
  createdAt: number;
  lastUsedAt: number;
  lineBuf: string;
  stderrTail: string;
  retiring: boolean;
  /** Native tools: the process has MCP tool calls parked, waiting for the client's tool_result request. */
  awaitingTools: boolean;
  toolDeadline: number;
  hasTools: boolean;
  /** sha256 of the access token the process was started with: a rotated credential retires an idle process. */
  credHash: string;
}

const TOOL_RESULT_WAIT_MS = 10 * 60_000;

function credHash(cred: CcWorkerCred): string {
  return createHash("sha256").update(String(cred.accessToken ?? "")).digest("hex").slice(0, 16);
}

const POOL_SWEEP_MS = 30_000;
// Measured 235–260 MB RSS per `claude` process on worker-01 (docs/worker-sessions.md §2); 300 MB leaves
// headroom for context growth. The live cap uses the same 75% of RAM as the memory high-water
// mark, which evicts idle sessions first anyway — the cap only bounds the worst case.
const PER_SESSION_BUDGET_BYTES = 300 * 1024 * 1024;
const POOL_MEM_FRACTION = 0.75;

/** Resident set size of a process from /proc (0 when unavailable). */
function procRssBytes(pid: number | undefined): number {
  if (!pid) return 0;
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/** uid/gid of the unprivileged account the workers run as (null = no privilege drop). */
export interface RunAs {
  user: string;
  uid: number;
  gid: number;
}

/** Resolve a system user from /etc/passwd (no NSS call needed for a local service account). */
export function resolveRunAs(user: string | undefined, isRoot = typeof process.getuid === "function" && process.getuid() === 0): RunAs | null {
  if (!user || !isRoot) return null;
  try {
    for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === user && f.length >= 4) return { user, uid: Number(f[2]), gid: Number(f[3]) };
    }
  } catch {
    /* no passwd → no drop */
  }
  return null;
}

/** Environment variables that must never reach a customer-driven worker process. */
const SECRET_ENV = /(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE)/i;

export interface CcWorkerManagerOptions {
  isolationGuard?: IsolationGuard;
  send: (message: unknown) => boolean;
  identity: () => { nodeId: string; providerId?: string };
  isDraining: () => boolean;
  pool: ProxyPool;
  /** Node data dir; per-account CLAUDE_CONFIG_DIRs live under <dataDir>/cc-accounts. */
  dataDir: string;
  /** claude binary; CC_WORKER_CLAUDE_BIN env wins, else "claude" from PATH. */
  claudeBin?: string;
  /** Extra argv before `-p` (tests point this at a fixture script). */
  claudeArgsPrefix?: string[];
  /**
   * Isolation (docs/ccr-supply.md §8.1 "worker 隔离"): run workers as this
   * unprivileged user (env CC_WORKER_USER, default "ccworker"; only effective
   * when the node itself runs as root and the user exists) and with this
   * built-in tool list (env CC_WORKER_TOOLS, comma-separated; default none —
   * a customer prompt must never execute anything on the node).
   */
  runAsUser?: string | null;
  tools?: string[];
  /** Canonical worker (spec WP2): accept `mode:"canonical"` opens. Env CC_WORKER_CANONICAL=1. Default off. */
  canonical?: boolean;
  /**
   * TUI worker (docs/tui-worker-2026-11-08.md): canonical opens run Claude Code's *interactive* mode behind the
   * cc-tui-shim (third_party/magpie-claudetui) instead of `claude -p`: the shim speaks -p's stream-json on its stdio and
   * drives the real interactive binary in a pseudo-terminal, so the upstream sees entrypoint `cli` and the interactive
   * request scaffold. Env CC_WORKER_TUI=1; the shim path from CC_WORKER_TUI_SHIM (default /opt/cc-tui-shim/cc-tui-shim).
   * Legacy opens on such a node still run `-p`.
   */
  tui?: boolean;
  tuiShim?: string;
  /**
   * Root for per-account config dirs and per-session scratch dirs. When workers
   * are privilege-dropped this must be traversable by that user, so the default
   * moves out of the node's (0700, root-owned) data dir: env CC_WORKER_ROOT or
   * /var/lib/1dayapi-cc-worker; without a privilege drop it stays under dataDir.
   */
  workerRoot?: string;
  /** Per-account kernel/distro/architecture identity for native workers and their telemetry. */
  machineIdentity?: boolean;
  machineRuntimeDir?: string;
  maxConcurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Text present in every canonical system prompt the gateway appends (CANONICAL_ENV_NOTE / _V2 both open with it). */
export const TUI_TAP_MATCH = "Environment note:";

export class CcWorkerManager {
  private readonly isolation: IsolationGuard;
  private opts: CcWorkerManagerOptions;
  private sessions = new Map<string, WorkerSession>();
  private queue: QueuedOpen[] = [];
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  readonly claudeBin: string;
  readonly claudeVersion: string | null;
  /**
   * Why the startup self-test failed (null = passed). The self-test runs the
   * real binary under the exact isolation a session gets (worker user, scratch
   * cwd/HOME, config dir under workerRoot) so a misconfigured node reports
   * "self_test_failed: <cause>" at startup and in the node page instead of
   * 502ing customer traffic after the first deploy (2026-10-16: /root 0700).
   */
  readonly selfTestError: string | null;
  // Persistent session pool (docs/worker-sessions.md §2 回收与容量)
  private readonly procs = new Map<string, Proc>();
  readonly maxLive: number;
  readonly idleTtlMs: number;
  readonly maxTurns: number;
  readonly maxAgeMs: number;
  readonly memHigh: number;
  private readonly evictions: Record<string, number> = {};
  private sweeper: NodeJS.Timeout | null = null;
  /** Loopback MCP server for native caller tools (started lazily on the first tool-bearing session). */
  private readonly mcp: McpServer;
  readonly runAs: RunAs | null;
  readonly tools: string[];
  /** spec WP2: canonical opens accepted (env CC_WORKER_CANONICAL=1). */
  readonly canonicalEnabled: boolean;
  /** TUI worker (interactive Claude Code behind cc-tui-shim) for canonical opens; implies canonicalEnabled. */
  readonly tuiEnabled: boolean;
  readonly tuiShim: string;
  readonly workerRoot: string;
  private readonly sessionsDir: string;
  private readonly teamUsers = new Map<string, RunAs>();
  private machineRuntime: MachineRuntime | null = null;
  private machinePreparationError: string | null = null;

  /** Each organization gets a distinct Linux UID; this is not a separate kernel or VM. */
  /**
   * Platform-initiated cleanup of organizations that no longer exist (teams.retire, 2026-11-01): remove the team's
   * worker root (account configs, device identities, scratch) and its system user — only when nothing of that team
   * is running here. Each result goes back to the platform.
   */
  retireTeams(teamIds: string[]): Array<{ teamId: string; removed: boolean; error?: string }> {
    const out: Array<{ teamId: string; removed: boolean; error?: string }> = [];
    for (const teamId of teamIds) {
      if (typeof teamId !== "string" || !teamId) continue;
      const busy = [...this.sessions.values()].some((s) => !s.closed && s.isolation?.teamId === teamId) || [...this.procs.values()].some((p) => p.isolation?.teamId === teamId);
      if (busy) { out.push({ teamId, removed: false, error: "team_busy" }); continue; }
      try {
        const dir = path.join(this.workerRoot, "teams", createHash("sha256").update(teamId).digest("hex"));
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        const user = `cc-t-${createHash("sha256").update(teamId).digest("hex").slice(0, 24)}`;
        if (process.env.CC_WORKER_TEAM_UIDS === "1" && resolveRunAs(user)) {
          const r = spawnSync("userdel", [user], { encoding: "utf8", timeout: 15_000 });
          if (r.status !== 0) throw new Error(`userdel ${user}: ${(r.stderr || r.stdout || "").trim() || r.status}`);
        }
        this.teamUsers.delete(teamId);
        this.log(`retired team ${teamId.slice(0, 8)}: worker root and system user removed`);
        out.push({ teamId, removed: true });
      } catch (err) {
        out.push({ teamId, removed: false, error: (err as Error).message.slice(0, 200) });
      }
    }
    return out;
  }

  private teamRunAs(teamId?: string): RunAs | null {
    if (!teamId || process.env.CC_WORKER_TEAM_UIDS !== "1") return this.runAs;
    if (process.getuid?.() !== 0) throw new Error("Per-team worker identities require a root supervisor");
    let identity = this.teamUsers.get(teamId);
    if (identity) return identity;
    const user = `cc-t-${createHash("sha256").update(teamId).digest("hex").slice(0, 24)}`;
    identity = resolveRunAs(user) ?? undefined;
    if (!identity) {
      const result = spawnSync("useradd", ["--system", "--no-create-home", "--user-group", "--shell", "/usr/sbin/nologin", user], { encoding: "utf8", timeout: 15_000 });
      identity = resolveRunAs(user) ?? undefined;
      if (!identity) throw new Error(`Cannot provision team worker identity (${result.status ?? "spawn_failed"})`);
    }
    if (identity.uid === 0) throw new Error("Invalid team worker identity");
    this.teamUsers.set(teamId, identity);
    return identity;
  }

  constructor(opts: CcWorkerManagerOptions) {
    this.opts = opts;
    this.isolation = opts.isolationGuard ?? new IsolationGuard();
    this.claudeBin = opts.claudeBin ?? process.env.CC_WORKER_CLAUDE_BIN ?? findClaudeBin();
    this.maxConcurrency = opts.maxConcurrency ?? (Number(process.env.CC_WORKER_MAX_CONCURRENCY ?? 0) || defaultMaxConcurrency());
    this.maxQueue = opts.maxQueue ?? 30;
    // Whole-turn cap (env CC_WORKER_TIMEOUT_MS). 20 min since 2026-10-19 (was 10: long agent turns were hitting it 4×/15 min).
    this.timeoutMs = opts.timeoutMs ?? (Number(process.env.CC_WORKER_TIMEOUT_MS) || 1_200_000);
    this.runAs = resolveRunAs(opts.runAsUser === undefined ? (process.env.CC_WORKER_USER ?? "ccworker") : (opts.runAsUser ?? undefined));
    const toolsEnv = process.env.CC_WORKER_TOOLS;
    this.tools = opts.tools ?? (toolsEnv ? toolsEnv.split(",").map((t) => t.trim()).filter(Boolean) : []);
    this.canonicalEnabled = opts.canonical ?? process.env.CC_WORKER_CANONICAL === "1";
    this.tuiEnabled = (opts.tui ?? process.env.CC_WORKER_TUI === "1") && this.canonicalEnabled;
    this.tuiShim = opts.tuiShim ?? process.env.CC_WORKER_TUI_SHIM ?? "/opt/cc-tui-shim/cc-tui-shim";
    this.workerRoot = opts.workerRoot ?? process.env.CC_WORKER_ROOT ?? (this.runAs ? "/var/lib/1dayapi-cc-worker" : opts.dataDir);
    fs.mkdirSync(this.workerRoot, { recursive: true, mode: 0o711 });
    fs.mkdirSync(path.join(this.workerRoot, "cc-accounts"), { recursive: true, mode: 0o711 });
    this.sessionsDir = path.join(this.workerRoot, "cc-sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o711 });
    // Traversal (not listing) for the worker user; the node's own files stay 0600/0700.
    for (const d of [this.workerRoot, path.join(this.workerRoot, "cc-accounts"), this.sessionsDir]) {
      try {
        fs.chmodSync(d, 0o711);
      } catch {
        /* best effort */
      }
    }
    // Scratch dirs of sessions that died with a previous node process.
    for (const d of fs.readdirSync(this.sessionsDir)) fs.rmSync(path.join(this.sessionsDir, d), { recursive: true, force: true });
    this.maxLive = Number(process.env.CC_WORKER_MAX_SESSIONS) || Math.max(4, Math.floor((os.totalmem() * POOL_MEM_FRACTION) / PER_SESSION_BUDGET_BYTES));
    this.idleTtlMs = Number(process.env.CC_WORKER_IDLE_TTL_MS) || 600_000;
    this.maxTurns = Number(process.env.CC_WORKER_MAX_TURNS) || 50;
    this.maxAgeMs = Number(process.env.CC_WORKER_MAX_AGE_MS) || 3_600_000;
    this.memHigh = Number(process.env.CC_WORKER_MEM_HIGH) || 0.75;
    this.sweeper = setInterval(() => this.sweep(), POOL_SWEEP_MS);
    this.sweeper.unref?.();
    this.mcp = new McpServer((m) => this.log(m));
    if (opts.machineIdentity ?? process.env.CC_WORKER_MACHINE_IDENTITY === "1") {
      if (process.getuid?.() !== 0) {
        this.machinePreparationError = "machine_identity_requires_root: mount namespaces cannot be created by this node user";
      } else {
        try {
          this.machineRuntime = prepareMachineRuntime(opts.machineRuntimeDir ?? process.env.CC_WORKER_MACHINE_RUNTIME_DIR ?? "/opt/claude/machine-identity");
        } catch (err) {
          this.machinePreparationError = (err as Error).message;
        }
      }
    }
    const probe = this.selfTest();
    this.claudeVersion = probe.version;
    this.selfTestError = probe.error;
    if (this.selfTestError) this.log(`SELF-TEST FAILED, cc_worker sessions will be rejected: ${this.selfTestError}`);
    this.log(`workers run as ${this.runAs ? `${this.runAs.user} (uid ${this.runAs.uid})` : "the node user (no privilege drop)"}, tools: ${this.tools.length ? this.tools.join(",") : "none"}, root ${this.workerRoot}`);
    if (this.machineRuntime) this.log(`machine identity: per-account kernel/distro/arch via ${this.machineRuntime.directory}`);
    this.log(`session pool: max ${this.maxLive} live, idle ttl ${this.idleTtlMs / 1000}s, max ${this.maxTurns} turns, max age ${this.maxAgeMs / 1000}s, mem high-water ${Math.round(this.memHigh * 100)}%`);
  }

  /**
   * chown a tree to the worker user (config dir written by the node as root). The tree is live while other sessions
   * of the same account run (canary 2026-11-02, concurrency 9): Claude Code creates and removes `.claude.json.lock`
   * and friends between our readdir and lchown, so a vanished entry is skipped, not fatal — it took the whole turn
   * down as `tunnel closed by node: ENOENT … lchown … .claude.json.lock` (2 × 502 on the canary account).
   */
  private chownTree(p: string, identity = this.runAs): void {
    if (!identity) return;
    const { uid, gid } = identity;
    const gone = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";
    const walk = (f: string) => {
      try {
        fs.lchownSync(f, uid, gid);
      } catch (err) {
        if (gone(err)) return;
        throw err;
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(f);
      } catch {
        return;
      }
      if (!st.isDirectory()) return;
      let children: string[];
      try {
        children = fs.readdirSync(f);
      } catch (err) {
        if (gone(err)) return;
        throw err;
      }
      for (const c of children) walk(path.join(f, c));
    };
    walk(p);
  }

  /** `claude --version` under session isolation; see `selfTestError`. */
  private selfTest(): { version: string | null; error: string | null } {
    if (this.machinePreparationError) return { version: null, error: `self_test_failed: ${this.machinePreparationError}` };
    const dir = path.join(this.sessionsDir, "selftest");
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.chownTree(dir);
      const machineEnv = this.machineRuntime ? machineEnvironment("selftest", dir, this.machineRuntime, this.runAs) : {};
      const r = spawnSync(this.machineRuntime?.launcher ?? this.claudeBin, [...(this.machineRuntime ? [this.claudeBin] : []), ...(this.opts.claudeArgsPrefix ?? []), "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
        cwd: dir,
        ...(!this.machineRuntime && this.runAs ? { uid: this.runAs.uid, gid: this.runAs.gid } : {}),
        env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, CLAUDE_CONFIG_DIR: dir, ...machineEnv },
      });
      const where = `as ${this.runAs ? `${this.runAs.user}` : "node user"} in ${dir}`;
      if (r.error) {
        // No binary at all keeps the historical reason code; anything else is an isolation problem.
        const missing = (r.error as NodeJS.ErrnoException).code === "ENOENT";
        return { version: null, error: missing ? "claude_not_installed" : `self_test_failed: cannot run ${this.claudeBin} ${where}: ${r.error.message}` };
      }
      if (r.status !== 0) {
        const tail = (r.stderr?.toString() ?? "").trim().split("\n").slice(-2).join(" | ").slice(0, 300);
        return { version: null, error: `self_test_failed: ${this.claudeBin} --version exited ${r.status} ${where}: ${tail || "(no stderr)"}` };
      }
      const out = r.stdout?.toString().trim() ?? "";
      if (!out) return { version: null, error: `self_test_failed: ${this.claudeBin} --version printed nothing ${where}` };
      if (this.tuiEnabled) {
        // The shim must be runnable under the same identity as the binary it will wrap (it is exec'd through the same launcher).
        const s = spawnSync(this.machineRuntime?.launcher ?? this.tuiShim, [...(this.machineRuntime ? [this.tuiShim] : []), "--version"], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15_000,
          cwd: dir,
          ...(!this.machineRuntime && this.runAs ? { uid: this.runAs.uid, gid: this.runAs.gid } : {}),
          env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, ...machineEnv },
        });
        const shimOut = s.stdout?.toString().trim() ?? "";
        if (s.error || s.status !== 0 || !shimOut.startsWith("cc-tui-shim")) {
          return { version: null, error: `tui_shim_unusable: ${this.tuiShim} --version ${where}: ${s.error?.message ?? `exit ${s.status}`} ${(s.stderr?.toString() ?? "").trim().slice(0, 200)}` };
        }
        return { version: `${out} (${shimOut})`, error: null };
      }
      return { version: out, error: null };
    } catch (e) {
      return { version: null, error: `self_test_failed: ${(e as Error).message}` };
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  stats(): {
    enabled: boolean;
    claudeVersion: string | null;
    selfTestError: string | null;
    maxConcurrency: number;
    active: number;
    queued: number;
    pool: { live: number; idle: number; busy: number; awaitingTools: number; maxLive: number; rssMb: number; evictions: Record<string, number> };
    canonical: { enabled: boolean; profiles: string[]; tui: boolean };
  } {
    let busy = 0;
    let awaiting = 0;
    let rss = 0;
    for (const p of this.procs.values()) {
      if (p.busy) busy++;
      if (p.awaitingTools) awaiting++;
      rss += procRssBytes(p.child.pid);
    }
    return {
      enabled: this.claudeVersion !== null,
      claudeVersion: this.claudeVersion,
      selfTestError: this.selfTestError,
      maxConcurrency: this.maxConcurrency,
      active: this.sessions.size,
      queued: this.queue.length,
      canonical: { enabled: this.canonicalEnabled, profiles: this.canonicalEnabled && this.claudeVersion && /\d+\.\d+\.\d+/.test(this.claudeVersion) ? [`cc-${/\d+\.\d+\.\d+/.exec(this.claudeVersion)![0]}-restricted`] : [], tui: this.tuiEnabled },
      pool: { live: this.procs.size, idle: this.procs.size - busy - awaiting, busy, awaitingTools: awaiting, maxLive: this.maxLive, rssMb: Math.round(rss / 1048576), evictions: { ...this.evictions } },
    };
  }

  // ---- persistent session pool (docs/worker-sessions.md) ----

  private evict(reason: string): void {
    this.evictions[reason] = (this.evictions[reason] ?? 0) + 1;
  }

  /** Retire a pooled process: idle → quiet; busy → its turn fails with `worker_retired`. */
  private retire(proc: Proc, reason: string): void {
    if (proc.retiring) return;
    proc.retiring = true;
    this.procs.delete(proc.key);
    this.evict(reason);
    const s = proc.busy;
    proc.busy = null;
    try {
      proc.child.stdin?.end();
    } catch {
      /* ignore */
    }
    if (proc.child.exitCode === null && proc.child.pid) {
      try {
        process.kill(-proc.child.pid, "SIGKILL");
      } catch {
        proc.child.kill("SIGKILL");
      }
    }
    this.removeDir(proc.workDir);
    if (proc.hasTools) this.mcp.unregister(proc.key, reason);
    this.log(`retired session ${proc.key.slice(0, 8)} (${reason}) after ${proc.turn} turn(s), age ${Math.round((Date.now() - proc.createdAt) / 1000)}s`);
    if (s && !s.closed) this.failSession(s, "worker_retired", reason);
  }

  /** One-shot process: surface the parked call to its only session (the call dies with the process at close). */
  private onToolCallOneShot(s: WorkerSession, call: PendingToolCall): void {
    if (s.closed) return;
    const line = JSON.stringify({ type: "1dayapi_tool_call", callId: call.callId, name: call.name, input: call.input }) + "\n";
    s.outSeq += 1;
    if (!this.opts.send({ type: "cc_worker.data", sessionId: s.sessionId, seq: s.outSeq, payloadBase64: Buffer.from(line).toString("base64") })) this.failSession(s, "transport_backpressure", "Platform send buffer unavailable");
  }

  /** A parked MCP call: tell the gateway (as a synthetic stdout line) so it can hand the tool_use to the client. */
  private onToolCall(proc: Proc, call: PendingToolCall): void {
    const s = proc.busy;
    const line = JSON.stringify({ type: "1dayapi_tool_call", callId: call.callId, name: call.name, input: call.input }) + "\n";
    if (s && !s.closed) {
      s.outSeq += 1;
      if (!this.opts.send({ type: "cc_worker.data", sessionId: s.sessionId, seq: s.outSeq, payloadBase64: Buffer.from(line).toString("base64") })) this.failSession(s, "transport_backpressure", "Platform send buffer unavailable");
    } else {
      this.log(`tool call ${call.callId} (${call.name}) parked with no gateway session attached to ${proc.key.slice(0, 8)}`);
    }
  }

  /** The client's tool results arrived (turnMode "tool_result"): resolve the parked calls, the same turn resumes. */
  private resumeWithToolResults(msg: CcWorkerOpen, proc: Proc): void {
    // Latest credential on disk for a process that re-reads .credentials.json (a rotated token
    // reaches a live process this way; its in-memory copy is replaced by the retire in launch()).
    try {
      this.materializeConfig(msg.accountId, msg.cred, msg.deviceId, msg.isolation?.teamId);
    } catch (err) {
      this.log(`could not refresh credentials for ${proc.key.slice(0, 8)}: ${(err as Error).message}`);
    }
    const session: WorkerSession = {
      isolation: msg.isolation,
      sessionId: msg.sessionId,
      accountId: msg.accountId,
      child: proc.child,
      closed: false,
      outSeq: 0,
      stderrTail: "",
      timer: null,
      workDir: null,
      proc,
    };
    this.sessions.set(msg.sessionId, session);
    proc.busy = session;
    proc.awaitingTools = false;
    proc.lastUsedAt = Date.now();
    session.timer = setTimeout(() => {
      if (!session.closed) this.failSession(session, "worker_timeout", `claude exceeded ${this.timeoutMs}ms`);
    }, this.timeoutMs);
    session.timer.unref?.();
    let n = 0;
    for (const r of msg.results ?? []) {
      if (typeof r?.callId !== "string") continue;
      if (this.mcp.resolveCall(proc.key, r.callId, typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? ""), r.isError === true)) n++;
      else this.log(`tool result for unknown call ${r.callId} on ${proc.key.slice(0, 8)} ignored`);
    }
    this.log(`resumed session ${proc.key.slice(0, 8)} with ${n} tool result(s) for ${msg.sessionId}`);
    if (this.mcp.pendingCount(proc.key) > 0) this.log(`session ${proc.key.slice(0, 8)} still has ${this.mcp.pendingCount(proc.key)} parked call(s)`);
  }

  /** Oldest-idle first; false when every live process is busy. */
  private evictOneIdle(reason: string): boolean {
    let victim: Proc | null = null;
    for (const p of this.procs.values()) if (!p.busy && !p.retiring && (!victim || p.lastUsedAt < victim.lastUsedAt)) victim = p;
    if (!victim) return false;
    this.retire(victim, reason);
    return true;
  }

  /** Drain / shutdown: idle processes go now, busy ones finish their turn and are not kept. */
  retireIdle(reason: string): void {
    for (const p of [...this.procs.values()]) if (!p.busy) this.retire(p, reason);
  }

  /** Every 30 s: idle TTL, max age, memory high-water (LRU). */
  private sweep(): void {
    const now = Date.now();
    for (const p of [...this.procs.values()]) {
      if (p.busy || p.retiring) continue;
      if (p.awaitingTools) {
        if (now > p.toolDeadline) {
          this.mcp.failPending(p.key, "client never returned tool results");
          this.retire(p, "tool_timeout");
        }
        continue;
      }
      if (now - p.lastUsedAt > this.idleTtlMs) this.retire(p, "idle");
      else if (now - p.createdAt > this.maxAgeMs) this.retire(p, "age");
    }
    const used = () => 1 - os.freemem() / os.totalmem();
    let n = 0;
    while (used() > this.memHigh && this.evictOneIdle("memory")) n++;
    if (n) this.log(`memory high-water ${Math.round(this.memHigh * 100)}%: evicted ${n} idle session(s), now ${Math.round(used() * 100)}%`);
  }

  private removeDir(d: string): void {
    const attempt = (n: number) => {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      if (n > 0 && fs.existsSync(d)) setTimeout(() => attempt(n - 1), 500).unref();
    };
    attempt(4);
  }

  /** stdout lines of a pooled process: a `result` line ends the current turn (process stays). */
  private scanForResult(proc: Proc, chunk: Buffer): void {
    proc.lineBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = proc.lineBuf.indexOf("\n")) !== -1) {
      const line = proc.lineBuf.slice(0, nl);
      proc.lineBuf = proc.lineBuf.slice(nl + 1);
      if (!line.includes('"type":"result"')) continue;
      try {
        if ((JSON.parse(line) as { type?: string }).type === "result") this.turnDone(proc);
      } catch {
        /* partial / not JSON */
      }
    }
    if (proc.lineBuf.length > 4_000_000) proc.lineBuf = proc.lineBuf.slice(-1_000_000);
  }

  private turnDone(proc: Proc): void {
    const s = proc.busy;
    proc.busy = null;
    proc.awaitingTools = false;
    proc.turn += 1;
    proc.lastUsedAt = Date.now();
    if (s && !s.closed) this.finishSession(s, "complete");
    if (proc.turn >= this.maxTurns) this.retire(proc, "turns");
  }

  /** Feed the new turn to a live idle process. */
  private continueTurn(msg: CcWorkerOpen, proc: Proc): void {
    // Latest credential on disk for a process that re-reads .credentials.json (a rotated token
    // reaches a live process this way; its in-memory copy is replaced by the retire in launch()).
    try {
      this.materializeConfig(msg.accountId, msg.cred, msg.deviceId, msg.isolation?.teamId);
    } catch (err) {
      this.log(`could not refresh credentials for ${proc.key.slice(0, 8)}: ${(err as Error).message}`);
    }
    const session: WorkerSession = {
      isolation: msg.isolation,
      sessionId: msg.sessionId,
      accountId: msg.accountId,
      child: proc.child,
      closed: false,
      outSeq: 0,
      stderrTail: "",
      timer: null,
      workDir: null,
      proc,
    };
    this.sessions.set(msg.sessionId, session);
    proc.busy = session;
    proc.lastUsedAt = Date.now();
    session.timer = setTimeout(() => {
      if (!session.closed) this.failSession(session, "worker_timeout", `claude exceeded ${this.timeoutMs}ms`);
    }, this.timeoutMs);
    session.timer.unref?.();
    const content = Array.isArray(msg.content) && msg.content.length > 0 ? msg.content : [{ type: "text", text: msg.prompt }];
    try {
      proc.child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
    } catch (err) {
      this.retire(proc, "stdin_failed");
      if (!session.closed) this.failSession(session, "worker_failed", `stdin: ${(err as Error).message}`);
      return;
    }
    this.log(`reused session ${proc.key.slice(0, 8)} turn ${proc.turn + 1} for ${msg.sessionId} (account ${msg.accountId})`);
  }

  /**
   * A continue / tool_result that no live process can take: turn the open into a fresh
   * one over the whole conversation (`history`, or the tool_result's full `content`).
   * Before 2026-10-22 a continue miss started a new process from the tail alone, so the
   * model answered without the conversation ("前面的消息都没传过来"). With no full
   * history at hand the open is refused (`session_lost`, retryable) — a wrong answer is
   * worse than an error. Returns false when the open was refused.
   */
  private fallBackToFresh(msg: CcWorkerOpen, mode: "continue" | "tool_result", why: string): boolean {
    const key = (msg.reuseKey ?? "").slice(0, 8);
    // Canonical (spec WP3): no folded history exists; the conversation lives in the native transcript. A continue that
    // no live process can take becomes `--resume <nativeSession.id>` fed with the new turn only (G4). Nothing to
    // resume → session_lost, never a fresh process over a tail.
    if (msg.mode === "canonical") {
      if (mode === "continue" && msg.nativeSession?.action === "resume" && Array.isArray(msg.content) && msg.content.length > 0) {
        this.log(`${mode} miss ${key}: ${why} -> native --resume ${msg.nativeSession.id.slice(0, 8)}`);
        msg.turnMode = "fresh";
        return true;
      }
      this.log(`${mode} miss ${key}: ${why} -> canonical, nothing to resume; refusing ${msg.sessionId} (session_lost)`);
      const session: WorkerSession = { isolation: msg.isolation, sessionId: msg.sessionId, accountId: msg.accountId, child: null, closed: false, outSeq: 0, stderrTail: "", timer: null, workDir: null, proc: null };
      this.sessions.set(msg.sessionId, session);
      this.failSession(session, "session_lost", `no live canonical session for this conversation (${why})${mode === "tool_result" ? "; the parked tool round cannot be resumed" : ""}`);
      return false;
    }
    const full = Array.isArray(msg.history) && msg.history.length > 0 ? msg.history : mode === "tool_result" && Array.isArray(msg.content) && msg.content.length > 0 ? msg.content : null;
    if (!full) {
      this.log(`${mode} miss ${key}: ${why} -> no full history in the open; refusing ${msg.sessionId} (session_lost)`);
      const session: WorkerSession = { isolation: msg.isolation, sessionId: msg.sessionId, accountId: msg.accountId, child: null, closed: false, outSeq: 0, stderrTail: "", timer: null, workDir: null, proc: null };
      this.sessions.set(msg.sessionId, session);
      this.failSession(session, "session_lost", `no live session for this conversation (${why}) and the open carries no history`);
      return false;
    }
    this.log(`${mode} miss ${key}: ${why} -> fresh with full history (${full.length} blocks)`);
    msg.content = full;
    msg.turnMode = "fresh";
    delete msg.results;
    return true;
  }

  /** Fresh vs continue decision for an accepted open (docs/worker-sessions.md §1). */
  private launch(msg: CcWorkerOpen, proxyUrl: string): void {
    if (msg.isolation && (!this.isolation.allows(msg.isolation) || !this.opts.pool.getPinned(msg.proxyId!, msg.accountId, msg.isolation.teamId))) {
      this.reject(msg.sessionId, "isolation_retired");
      return;
    }
    let persist = msg.persist === true && typeof msg.reuseKey === "string" && msg.reuseKey.length > 0;
    const key = msg.reuseKey ?? "";
    const candidate = this.procs.get(key);
    if (candidate && (candidate.accountId !== msg.accountId || (msg.isolation && !sameIsolation(candidate.isolation, msg.isolation)))) {
      this.reject(msg.sessionId, "isolation_mismatch");
      return;
    }
    // The platform rotated this account's OAuth tokens since the process started (console
    // keep-alive / gateway refresh): Claude Code still holds the old pair in memory, its next API
    // call 401s and its own refresh then replays an already-rotated refresh token (2026-10-22,
    // "OAuth session expired and could not be refreshed"). An idle process is simply replaced; a
    // busy one finishes its turn (the open below never reuses a busy process anyway).
    if (persist) {
      const stale = this.procs.get(key);
      if (stale && !stale.busy && !stale.retiring && stale.credHash !== credHash(msg.cred)) {
        this.log(`session ${key.slice(0, 8)}: credential rotated since the process started; retiring it`);
        this.retire(stale, "credential_rotated");
      }
    }
    if (persist && msg.turnMode === "tool_result") {
      const proc = this.procs.get(key);
      const resultsMatchParked = (msg.results ?? []).some((r) => r && this.mcp.isPending(key, r.callId));
      if (proc && proc.busy && !proc.retiring && resultsMatchParked && proc.turn === msg.expectedTurn) {
        // The client's results reference calls parked on this very process: the previous
        // request is over on the gateway side even if its close frame has not arrived yet.
        const old = proc.busy;
        proc.busy = null;
        old.closed = true;
        this.sessions.delete(old.sessionId);
        if (old.timer) clearTimeout(old.timer);
        this.opts.send({ type: "cc_worker.close", sessionId: old.sessionId, reasonCode: "awaiting_tool_result" });
        this.log(`session ${key.slice(0, 8)}: tool results arrived before the close of ${old.sessionId}; detached it`);
      }
      if (proc && !proc.busy && !proc.retiring && proc.child.exitCode === null && proc.turn === msg.expectedTurn && (proc.awaitingTools || resultsMatchParked)) {
        this.resumeWithToolResults(msg, proc);
        return;
      }
      // tool_result opens carry the whole conversation as `content` (protocol): fall back to a fresh process on it.
      const why = proc ? (proc.busy ? "busy" : !proc.awaitingTools ? "not awaiting" : `turn ${proc.turn} != ${msg.expectedTurn}`) : "no session";
      if (!this.fallBackToFresh(msg, "tool_result", why)) return;
    }
    if (persist && msg.turnMode === "continue") {
      const proc = this.procs.get(key);
      // A process parked on tool calls (awaitingTools) is blocked inside an MCP call: a user line
      // written to its stdin is never read, the request hangs until the client gives up (10-22 incident).
      if (proc && !proc.busy && !proc.retiring && !proc.awaitingTools && proc.child.exitCode === null && proc.turn === msg.expectedTurn) {
        this.continueTurn(msg, proc);
        return;
      }
      const why = proc
        ? proc.busy ? "busy" : proc.retiring ? "retiring" : proc.child.exitCode !== null ? "exited" : proc.awaitingTools ? "awaiting_tools" : `turn ${proc.turn} != ${msg.expectedTurn}`
        : "no session";
      if (!this.fallBackToFresh(msg, "continue", why)) return;
    }
    if (persist) {
      const old = this.procs.get(key);
      if (old && !old.busy) this.retire(old, "replaced");
      else if (old && old.busy) persist = false; // never two processes per key: serve this one one-shot
    }
    if (persist && this.procs.size >= this.maxLive && !this.evictOneIdle("capacity")) {
      this.evict("capacity_oneshot");
      persist = false; // pool full of busy sessions: degrade to a one-shot process rather than queue
    }
    void this.start(msg, proxyUrl, persist);
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  private log(msg: string): void {
    this.opts.log?.(`[cc-worker] ${msg}`);
  }

  private reject(sessionId: string, reasonCode: string): void {
    this.opts.send({ type: "cc_worker.open_response", sessionId, accepted: false, reasonCode });
    this.log(`rejected ${sessionId}: ${reasonCode}`);
  }

  handleOpen(msg: CcWorkerOpen): void {
    const identity = this.opts.identity();
    if (msg.nodeId !== identity.nodeId || (identity.providerId && msg.providerId !== identity.providerId)) {
      this.reject(msg.sessionId, "node_identity_mismatch");
      return;
    }
    if (this.opts.isDraining()) return this.reject(msg.sessionId, "node_draining");
    if (this.claudeVersion === null) return this.reject(msg.sessionId, this.selfTestError ?? "claude_not_installed");
    if (typeof msg.accountId !== "string" || !msg.accountId) return this.reject(msg.sessionId, "missing_account_id");
    if (typeof msg.prompt !== "string" || !msg.prompt || typeof msg.model !== "string" || !msg.model) {
      return this.reject(msg.sessionId, "bad_request");
    }
    if (typeof msg.cred?.accessToken !== "string" || !msg.cred.accessToken) return this.reject(msg.sessionId, "bad_credential");
    if (this.sessions.has(msg.sessionId)) return this.reject(msg.sessionId, "duplicate_session");
    // Canonical worker (spec WP2): only when the operator enabled it on this node (capability canonical_v1); a
    // supplied native session id must be a UUID (it becomes `--session-id`, i.e. a file name under the config dir).
    if (msg.mode === "canonical") {
      if (!this.canonicalEnabled) return this.reject(msg.sessionId, "canonical_unsupported");
      if (msg.nativeSessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.nativeSessionId)) return this.reject(msg.sessionId, "bad_native_session_id");
      if (msg.nativeSession && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.nativeSession.id) || !["start", "resume", "fork"].includes(msg.nativeSession.action))) return this.reject(msg.sessionId, "bad_native_session_id");
      if (msg.historyImport !== undefined && (!Array.isArray(msg.historyImport) || msg.historyImport.length > 5000 || !msg.nativeSession)) return this.reject(msg.sessionId, "bad_history_import");
    }

    if (msg.isolation !== undefined && !validIsolation(msg.isolation)) return this.reject(msg.sessionId, "invalid_isolation");
    if (this.isolation.teamRequired && !msg.isolation) return this.reject(msg.sessionId, "isolation_required");
    if (this.opts.pool.isTeamAccount(msg.accountId) && !msg.isolation) return this.reject(msg.sessionId, "isolation_required");
    if (msg.isolation) {
      if (!this.isolation.allows(msg.isolation)) return this.reject(msg.sessionId, "isolation_retired");
      if (!msg.proxyId || !msg.deviceId || !/^[0-9a-f]{64}$/i.test(msg.deviceId)) return this.reject(msg.sessionId, "isolation_identity_required");
      // The node creates its own namespace; a caller-supplied reuseKey alone is never an authority.
      msg = { ...msg, ...(msg.reuseKey ? { reuseKey: createHash("sha256").update(JSON.stringify([msg.isolation.teamId, msg.isolation.conversationId, msg.isolation.generation, msg.accountId, msg.proxyId, msg.deviceId, msg.reuseKey])).digest("hex") } : {}) };
    }

    // Mandatory proxy: pinned wins (missing/dead pin is a hard reject), else
    // the sticky assignment. Never direct.
    const proxyUrl = msg.proxyId ? this.opts.pool.getPinned(msg.proxyId, msg.accountId, msg.isolation?.teamId) : this.opts.pool.pickForAccount(msg.accountId);
    if (!proxyUrl) return this.reject(msg.sessionId, "no_proxy_available");

    if (this.sessions.size >= this.maxConcurrency) {
      if (this.queue.length >= this.maxQueue) return this.reject(msg.sessionId, "worker_overloaded");
      if (this.queue.some((q) => q.msg.sessionId === msg.sessionId)) return this.reject(msg.sessionId, "duplicate_session");
      this.queue.push({ msg, proxyUrl });
      if (!this.opts.send({ type: "cc_worker.open_response", sessionId: msg.sessionId, accepted: true })) { this.queue = this.queue.filter(q => q.msg.sessionId !== msg.sessionId); return; }
      this.log(`queued ${msg.sessionId} (${this.queue.length} waiting)`);
      return;
    }
    if (!this.opts.send({ type: "cc_worker.open_response", sessionId: msg.sessionId, accepted: true })) return;
    this.launch(msg, proxyUrl);
  }

  /** Per-account CLAUDE_CONFIG_DIR with the native credential files (0700/0600). */
  private materializeConfig(accountId: string, cred: CcWorkerCred, deviceId?: string, teamId?: string): string {
    const identity = this.teamRunAs(teamId);
    const dir = this.accountConfigDir(accountId, teamId);
    if (teamId) {
      const accountsRoot = path.dirname(dir);
      const teamRoot = path.dirname(accountsRoot);
      for (const parent of [path.dirname(teamRoot), teamRoot, accountsRoot]) {
        fs.mkdirSync(parent, { recursive: true, mode: 0o711 });
        fs.chmodSync(parent, 0o711);
      }
      if (identity && process.env.CC_WORKER_TEAM_UIDS === "1") {
        for (const parent of [teamRoot, accountsRoot]) {
          fs.chownSync(parent, identity.uid, identity.gid);
          fs.chmodSync(parent, 0o700);
        }
      }
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    if (teamId) {
      const ownership = path.join(this.workerRoot, "team-device-owners.json");
      const owners: Record<string, { teamId: string; accountId: string }> = fs.existsSync(ownership) ? JSON.parse(fs.readFileSync(ownership, "utf8")) : {};
      const old = deviceId ? owners[deviceId] : undefined;
      if (!deviceId || (old && (old.teamId !== teamId || old.accountId !== accountId))) throw new Error("device belongs to another team/account");
      if (Object.values(owners).some((owner) => owner.accountId === accountId && owner.teamId !== teamId)) throw new Error("account belongs to another team");
      owners[deviceId] = { teamId, accountId };
      fs.writeFileSync(ownership, JSON.stringify(owners), { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "team-account.json"), JSON.stringify({ teamId, accountId }), { mode: 0o600 });
      const prior = path.join(dir, ".claude.json");
      if (fs.existsSync(prior)) {
        const value = JSON.parse(fs.readFileSync(prior, "utf8")) as { userID?: string };
        if (value.userID && value.userID !== deviceId) throw new Error("fixed team device identity changed");
      }
    }
    // Fresh config dir: seed Claude Code's device identity with the platform's
    // value so the account presents the same device on every path from day one.
    const claudeJson = path.join(dir, ".claude.json");
    if (deviceId && /^[0-9a-f]{64}$/i.test(deviceId) && !fs.existsSync(claudeJson)) {
      fs.writeFileSync(claudeJson, JSON.stringify({ userID: deviceId, firstStartTime: new Date().toISOString() }), { mode: 0o600 });
      this.log(`seeded device identity for account ${accountId}`);
    }
    // Claude Code copies the OAuth profile (e-mail, names) into .claude.json and quotes it to the model as a
    // "# userEmail" context block — on a customer turn that is the account owner's e-mail (customer report
    // 2026-10-19). Blank it: CC's check is `oauthAccount?.emailAddress && …`, so "" drops the block; stamp
    // profileFetchedAt so the next launch does not refetch the profile before the first turn.
    try {
      const raw = fs.existsSync(claudeJson) ? (JSON.parse(fs.readFileSync(claudeJson, "utf8")) as Record<string, unknown>) : null;
      const acc = raw && raw.oauthAccount && typeof raw.oauthAccount === "object" ? (raw.oauthAccount as Record<string, unknown>) : null;
      if (raw && acc && (acc.emailAddress || acc.displayName || acc.fullName)) {
        acc.emailAddress = "";
        acc.displayName = "";
        acc.fullName = "";
        acc.profileFetchedAt = Date.now();
        fs.writeFileSync(claudeJson, JSON.stringify(raw), { mode: 0o600 });
      }
    } catch (err) {
      this.log(`could not scrub oauth profile for account ${accountId}: ${(err as Error).message}`);
    }
    const expiresAt =
      typeof cred.expiresAt === "number"
        ? cred.expiresAt
        : Date.parse(typeof cred.expiresAt === "string" ? cred.expiresAt : "") || Date.now() + 8 * 3_600_000;
    fs.writeFileSync(
      path.join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: cred.accessToken,
          refreshToken: cred.refreshToken,
          expiresAt,
          scopes: FIXED_SCOPES,
          subscriptionType: cred.subscriptionType ?? "pro",
        },
      }),
      { mode: 0o600 },
    );
    const settingsPath = path.join(dir, "settings.json");
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
    }
    this.chownTree(dir, identity);
    return dir;
  }

  private accountConfigDir(accountId: string, teamId?: string): string {
    if (teamId) return path.join(this.workerRoot, "teams", createHash("sha256").update(teamId).digest("hex"), "cc-accounts", encodeURIComponent(accountId));
    return path.join(this.workerRoot, "cc-accounts", accountId);
  }

  private async start(msg: CcWorkerOpen, proxyUrl: string, persist = false): Promise<void> {
    const session: WorkerSession = {
      isolation: msg.isolation,
      sessionId: msg.sessionId,
      accountId: msg.accountId,
      child: null,
      closed: false,
      outSeq: 0,
      stderrTail: "",
      timer: null,
      workDir: null,
      proc: null,
    };
    this.sessions.set(msg.sessionId, session);
    try {
      const identity = this.teamRunAs(msg.isolation?.teamId);
      // socks5 pins go through the loopback bridge; CC only honors http(s) proxies.
      const proxy = await this.opts.pool.transportProxy(proxyUrl);
      if (session.closed) return; // closed (gateway / transport loss) while the bridge was starting: never spawn
      if (msg.isolation && (!this.isolation.allows(msg.isolation) || this.opts.pool.getPinned(msg.proxyId!, msg.accountId, msg.isolation.teamId) !== proxyUrl)) throw new Error("isolation retired or proxy binding changed");
      const configDir = this.materializeConfig(msg.accountId, msg.cred, msg.deviceId, msg.isolation?.teamId);
      // Fresh, empty, private scratch dir per session: cwd + HOME of the worker.
      // Nothing from other sessions, the node, or the host is reachable there.
      const scope = msg.isolation ? createHash("sha256").update(JSON.stringify(msg.isolation)).digest("hex") + "-" : "";
      const workDir = path.join(this.sessionsDir, scope + msg.sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
      fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
      this.chownTree(workDir, identity);
      session.workDir = workDir;
      // Fixed cwd per account (and isolation scope), 2026-11-05: Claude Code writes the working directory into its system
      // prompt, so a per-session cwd made every session's 16–34k system prefix a fresh cache write (magpie reached the same
      // conclusion). The dir stays empty and is never removed; HOME/TMPDIR and the session's own files stay per session above.
      fs.mkdirSync(path.join(this.sessionsDir, "cwd"), { recursive: true, mode: 0o711 });
      const cwdDir = path.join(this.sessionsDir, "cwd", scope + "acct-" + msg.accountId.replace(/[^A-Za-z0-9_-]/g, "_"));
      fs.mkdirSync(cwdDir, { recursive: true, mode: 0o700 });
      this.chownTree(cwdDir, identity);
      // The prompt goes over stdin: argv is world-readable (/proc/<pid>/cmdline)
      // and capped at 128 KiB per argument on Linux. With image blocks the input
      // is one stream-json user message (Messages-style content) instead of text.
      // Persistent processes always speak stream-json on stdin (later turns arrive as more lines).
      const structured = persist || (Array.isArray(msg.content) && msg.content.length > 0);
      const firstContent = Array.isArray(msg.content) && msg.content.length > 0 ? msg.content : [{ type: "text", text: msg.prompt }];
      // The caller's system prompt replaces Claude Code's own identity/tool
      // instructions: with no tools, the default prompt made the model write
      // <invoke>…</invoke> markup into customer answers. File, not argv (size, /proc).
      const canonical = msg.mode === "canonical";
      let systemPromptFile: string | null = null;
      if (!canonical && typeof msg.systemPrompt === "string" && msg.systemPrompt) {
        systemPromptFile = path.join(workDir, "system-prompt.md");
        fs.writeFileSync(systemPromptFile, msg.systemPrompt, { mode: 0o600 });
        this.chownTree(workDir, identity);
      }
      // Native caller tools (docs/worker-sessions.md §3): a per-session MCP server
      // entry; only persistent sessions can hold a turn open across requests.
      const nativeTools = Array.isArray(msg.tools) ? msg.tools.filter((t) => t && typeof t.name === "string" && t.name) : [];
      let mcpConfigFile: string | null = null;
      let procRef: Proc | null = null; // bound after spawn; the MCP callback needs the proc
      const mcpKey = persist ? msg.reuseKey! : msg.sessionId; // one-shot processes register under their own session id
      if (nativeTools.length > 0) {
        if (!this.mcp.port) this.mcp.start();
        const url = this.mcp.register(mcpKey, nativeTools, (call) => {
          if (procRef) this.onToolCall(procRef, call);
          else this.onToolCallOneShot(session, call);
        }, canonical && this.tuiEnabled ? { listedFile: path.join(workDir, "mcp-listed") } : undefined);
        mcpConfigFile = path.join(workDir, "mcp-config.json");
        fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { caller: { type: "http", url } } }), { mode: 0o600 });
        this.chownTree(workDir, identity);
      }
      // Canonical (spec WP2, invariants I1/I3): the native system prompt stays; the caller's system text is appended
      // (G1: lands at the tail of the main prompt block, billing header and identity sentence untouched).
      let appendFile: string | null = null;
      if (canonical && typeof msg.appendSystemPrompt === "string" && msg.appendSystemPrompt) {
        appendFile = path.join(workDir, "caller-system.md");
        fs.writeFileSync(appendFile, msg.appendSystemPrompt, { mode: 0o600 });
        this.chownTree(workDir, identity);
      }
      const nativeSessionId = canonical ? (msg.nativeSession?.id ?? (typeof msg.nativeSessionId === "string" && msg.nativeSessionId ? msg.nativeSessionId : randomUUID())) : null;
      // spec WP3: resume an existing native transcript (G4), or import one the gateway built from the client's history
      // (G3: written in Claude Code's own jsonl shape under projects/<cwd-hash>/<id>.jsonl, then resumed).
      let resumeId: string | null = canonical && msg.nativeSession?.action === "resume" ? msg.nativeSession.id : null;
      if (canonical && Array.isArray(msg.historyImport) && msg.historyImport.length > 0 && nativeSessionId) {
        const projDir = path.join(configDir, "projects", cwdDir.replace(/[^a-zA-Z0-9]/g, "-"));
        fs.mkdirSync(projDir, { recursive: true, mode: 0o700 });
        const lines = msg.historyImport.map((l) => JSON.stringify({ ...l, sessionId: nativeSessionId, cwd: cwdDir }));
        fs.writeFileSync(path.join(projDir, `${nativeSessionId}.jsonl`), lines.join("\n") + "\n", { mode: 0o600 });
        this.chownTree(projDir, identity);
        resumeId = nativeSessionId;
        this.log(`session ${msg.sessionId}: imported ${lines.length} transcript line(s) into native session ${nativeSessionId.slice(0, 8)}`);
      }
      const effort = typeof msg.effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(msg.effort) ? msg.effort : null;
      const args = [
        ...(this.opts.claudeArgsPrefix ?? []),
        "-p",
        "--model",
        msg.model,
        "--output-format",
        "stream-json",
        ...(structured ? ["--input-format", "stream-json"] : []),
        "--verbose",
        // Customer prompts drive this process: no built-in tools unless the node
        // operator whitelists some (CC_WORKER_TOOLS), and no transcript on disk.
        ...(canonical
          ? [
              // Native session on disk (transcript under the account's CLAUDE_CONFIG_DIR, TTL by the node cleanup timer);
              // `--restricted` keeps file tools inside cwd and drops Bash (G6/G7); no permission prompts in -p mode.
              ...(resumeId ? ["--resume", resumeId] : ["--session-id", nativeSessionId!]),
              "--restricted", "--permission-prompts", "none",
              ...(msg.builtInToolProfile === "tools-disabled-canonical" ? ["--tools", ""] : []),
              ...(appendFile ? ["--append-system-prompt-file", appendFile] : []),
              ...(msg.jsonSchema && typeof msg.jsonSchema === "object" ? ["--json-schema", JSON.stringify(msg.jsonSchema)] : []),
            ]
          : [
              "--tools",
              ...(this.tools.length ? this.tools : [""]),
              "--no-session-persistence",
              ...(systemPromptFile ? ["--system-prompt-file", systemPromptFile] : []),
            ]),
        ...(mcpConfigFile ? ["--mcp-config", mcpConfigFile, "--strict-mcp-config", "--allowedTools", "mcp__caller"] : []),
        // Extended thinking on the client's request: the budget flag alone does not turn thinking on in -p mode,
        // the session setting does (plus MAX_THINKING_TOKENS in env below for older code paths).
        ...(typeof msg.thinkingBudget === "number" && msg.thinkingBudget > 0
          ? ["--max-thinking-tokens", String(Math.floor(msg.thinkingBudget)), "--settings", JSON.stringify({ alwaysThinkingEnabled: true })]
          : []),
        ...(effort ? ["--effort", effort] : []),
        // Always emit partial messages, one-shot non-stream turns included. Without them the gateway
        // only sees complete `assistant` messages, which Claude Code emits with stop_reason null: a
        // max_tokens stop went unnoticed, Claude Code ran its own "continue from where you left off"
        // call, and the client got two API calls' output merged while the usage row carried only the
        // last call (2026-10-22: 16k + 2k tokens answered, output_tokens billed as 17). With the
        // message_delta in hand the gateway ends the message at max_tokens and cancels the session.
        "--include-partial-messages",
      ];
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.test(k)) env[k] = v;
      // A host-level NO_PROXY/ALL_PROXY must not let the worker bypass the pinned proxy —
      // except loopback, where the node's own MCP server for native tools lives.
      for (const k of ["NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
      // The caller asked for one specific model. Left to itself, Claude Code pivots to a fallback
      // model (e.g. Opus) when the requested one refuses or is unavailable and answers as it — a
      // different model than requested, whose name then leaks in the refusal text ("Opus 5's
      // safeguards flagged…", ztest D19 2026-10-18). Forbid the pivot: the requested model's own
      // result goes back to the caller, who decides whether to retry elsewhere — the same thing
      // an interactive Claude Code session does when it shows the refusal instead of switching.
      env.CLAUDE_CODE_NO_MODEL_FALLBACK = "1";
      // Customer text is data, not an operator prompt: Claude Code otherwise reads every `@path` in it
      // (file → contents, directory → listing; `@/etc/hostname` came back verbatim, 2026-10-19) into the
      // request as "attachment content". That inflated conversations 2–4× past the 1M window
      // ("Prompt is too long … this conversation is only ~385k tokens") and exposed node files.
      env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = "1";
      // Same family: Claude Code's own context attachments (userEmail of the OAuth account, Environment =
      // the node's cwd/platform, gitStatus, currentDate, CLAUDE.md …). On a customer turn they leak the
      // account owner's e-mail and make the model believe it works in /var/lib/1dayapi-cc-worker on Linux
      // (customer report 2026-10-19). The customer's own system prompt already carries their environment.
      env.CLAUDE_CODE_DISABLE_ATTACHMENTS = "1";
      // Telemetry stays ON (measured 2026-10-29 with a local MITM, 2.1.312, 8 sessions): a normal session
      // calls /api/claude_cli/bootstrap, /api/eval/*, /mcp-registry and posts one /api/event_logging/v2/batch
      // (~120 events, ~230 KB) — all of it on the account's proxy. Its payload carries the pinned device_id,
      // session_id and a machine `env` block; no hostname, user or path. With DISABLE_TELEMETRY /
      // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC those calls vanish entirely, which is the more visible oddity
      // (user rule 2026-10-29: 关闭遥测是不正常的行为). Only the two parts that add nothing visible stay off:
      // Sentry (never fired in normal or API-500 sessions; a crash report would carry the node's hostname) and
      // the autoupdater (no update check was observed in -p sessions; a download into the per-session HOME
      // would be wasted on every turn). machineEnvironment below supplies the account's kernel/distro/arch/shell
      // when machine identity is enabled, so telemetry and the direct path use one profile.
      env.DISABLE_ERROR_REPORTING = "1";
      env.DISABLE_AUTOUPDATER = "1";
      // Without machine identity, SHELL unset under systemd falls back to the uid's login shell (nologin for
      // team identities); use bash. With machine identity, machineEnvironment selects the account's bash/zsh.
      if (!env.SHELL) env.SHELL = "/bin/bash";
      // NOT CLAUDE_CODE_SIMPLE / --bare: both stop Claude Code from reading the OAuth credentials file
      // ("Not logged in · Please run /login", canary 2026-10-19 08:53 CEST).
      if (mcpConfigFile) {
        env.NO_PROXY = "127.0.0.1,localhost";
        env.no_proxy = "127.0.0.1,localhost";
        // A parked tools/call waits for the client's tool_result (TOOL_RESULT_WAIT_MS); Claude Code's own
        // per-call timeout (default 60 s) must not fire first, or the model sees a timeout where the client
        // later delivers a real result. Concurrency: the default cap of 10 parallel tool_use blocks would
        // park the 11th behind the first batch.
        env.MCP_TOOL_TIMEOUT = String(TOOL_RESULT_WAIT_MS);
        env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = "50";
      }
      if (typeof msg.thinkingBudget === "number" && msg.thinkingBudget > 0) env.MAX_THINKING_TOKENS = String(Math.floor(msg.thinkingBudget));
      // No thinking asked for (no budget, no effort): switch Claude Code's default-on thinking off
      // (MAX_THINKING_TOKENS=0 → thinking {type:"disabled"}). Otherwise the model spends the client's
      // max_tokens on reasoning they never see and are billed for (Haiku 4.5: 60–200 hidden tokens per
      // short answer, 2026-10-17). Never together with --effort: Claude Code rejects effort while thinking is off.
      // Canonical keeps Claude Code's own default (adaptive thinking): the request shape must be the native one (I1).
      else if (!effort && !canonical) env.MAX_THINKING_TOKENS = "0";
      // The client's max_tokens: Claude Code caps the API request with it (any positive value; it clamps to the
      // model's limit). The gateway ends the message at the first max_tokens stop and cancels the session, so
      // Claude Code's own "continue from where you left off" turn never runs.
      if (typeof msg.maxTokens === "number" && msg.maxTokens > 0) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(msg.maxTokens));
      const machineEnv = this.machineRuntime ? machineEnvironment(msg.accountId, configDir, this.machineRuntime, identity) : {};
      // TUI worker: the shim wraps the binary and turns the -p argv into the interactive mode's (cc-tui-shim, vendored
      // magpie claudetui). It answers the trust dialog itself (the cwd is the account's own), and waits for the node's MCP
      // server to have listed the caller tools (the marker file) before it pastes the first message.
      const tui = canonical && this.tuiEnabled;
      if (tui) {
        env.ONEDAY_CC_TUI_TRUST = "1";
        // Interactive Claude Code moves an MCP tool call that is still running after 120 s to the background and hands
        // the model a placeholder result ("MCP tool … is still running after 120s. It was moved to the background …"),
        // so the turn goes on without the caller's answer; when the client's real tool_result arrives the session is
        // no longer awaiting (502 session_lost "not awaiting" / "turn N != M", 5 of 347 tool rounds on ccr-tui,
        // 2026-11-09 — every one with a >120 s client-side tool). The caller's tools are the parked MCP calls the node
        // answers within TOOL_RESULT_WAIT_MS: never background them, and align the auto-background threshold.
        env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND = "1";
        env.CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS = String(TOOL_RESULT_WAIT_MS);
        if (mcpConfigFile) env.ONEDAY_TUI_LISTED = path.join(workDir, "mcp-listed");
        // The tap tells the main turn's requests apart by the environment note the gateway appends to every canonical
        // system prompt (CANONICAL_ENV_NOTE*, worker.ts); Claude Code 2.1.319 sends no request-class header.
        env.ONEDAY_CC_TAP_MATCH = TUI_TAP_MATCH;
        this.seedFolderTrust(configDir, cwdDir, identity);
      }
      const program = tui ? this.tuiShim : this.claudeBin;
      const programArgs = tui ? [this.claudeBin, ...args] : args;
      const child = spawn(this.machineRuntime?.launcher ?? program, this.machineRuntime ? [program, ...programArgs] : programArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // own process group so the whole tree (MCP children, shells) can be killed
        cwd: cwdDir,
        ...(!this.machineRuntime && identity ? { uid: identity.uid, gid: identity.gid } : {}),
        env: {
          ...env,
          ...machineEnv,
          HOME: workDir,
          TMPDIR: workDir,
          CLAUDE_CONFIG_DIR: configDir,
          HTTPS_PROXY: proxy,
          HTTP_PROXY: proxy,
          https_proxy: proxy,
          http_proxy: proxy,
        },
      });
      session.child = child;
      let proc: Proc | null = null;
      if (persist) {
        proc = { key: msg.reuseKey!, isolation: msg.isolation, accountId: msg.accountId, child, workDir, turn: msg.expectedTurn ?? 0, busy: session, createdAt: Date.now(), lastUsedAt: Date.now(), lineBuf: "", stderrTail: "", retiring: false, awaitingTools: false, toolDeadline: 0, hasTools: nativeTools.length > 0, credHash: credHash(msg.cred) };
        procRef = proc;
        this.procs.set(proc.key, proc);
        session.proc = proc;
        session.workDir = null; // the process owns its scratch dir now
      }
      child.stdin?.on("error", () => {});
      const first = structured ? JSON.stringify({ type: "user", message: { role: "user", content: firstContent } }) + "\n" : msg.prompt;
      if (persist) child.stdin?.write(first);
      else child.stdin?.end(first);
      session.timer = setTimeout(() => {
        if (!session.closed) {
          session.stderrTail += `\nworker killed after ${this.timeoutMs}ms`;
          this.failSession(session, "worker_timeout", `claude exceeded ${this.timeoutMs}ms`);
        }
      }, this.timeoutMs);
      session.timer.unref?.();
      child.stdout?.on("data", (chunk: Buffer) => {
        const target = proc ? proc.busy : session;
        if (target && !target.closed) {
          target.outSeq += 1;
          if (!this.opts.send({ type: "cc_worker.data", sessionId: target.sessionId, seq: target.outSeq, payloadBase64: chunk.toString("base64") })) { this.failSession(target, "transport_backpressure", "Platform send buffer unavailable"); return; }
        }
        if (proc) this.scanForResult(proc, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const t = chunk.toString("utf8");
        const target = proc ? proc.busy : session;
        if (target) target.stderrTail = (target.stderrTail + t).slice(-STDERR_TAIL);
        if (proc) proc.stderrTail = (proc.stderrTail + t).slice(-STDERR_TAIL);
      });
      child.on("error", (err) => {
        if (proc) this.procs.delete(proc.key);
        const target = proc ? proc.busy : session;
        if (target) this.failSession(target, "worker_spawn_failed", err.message);
      });
      child.on("close", (code) => {
        if (proc) {
          // A pooled process ended on its own: the turn in flight (if any) failed; the pool entry is gone.
          const wasBusy = proc.busy;
          proc.busy = null;
          if (this.procs.get(proc.key) === proc) this.procs.delete(proc.key);
          if (!proc.retiring) this.removeDir(proc.workDir);
          if (!proc.retiring && !wasBusy) this.log(`session ${proc.key.slice(0, 8)} exited while idle (code ${code}) after ${proc.turn} turn(s)`);
          if (wasBusy && !wasBusy.closed) {
            if (code === 0) this.finishSession(wasBusy, "complete");
            else this.failSession(wasBusy, "worker_failed", `claude exited ${code}: ${stderrCause(proc.stderrTail)}`);
          }
          return;
        }
        if (session.closed) return;
        if (code === 0) this.finishSession(session, "complete");
        else this.failSession(session, "worker_failed", `claude exited ${code}: ${stderrCause(session.stderrTail)}`);
      });
      this.log(`started ${session.sessionId} (account ${msg.accountId}, model ${msg.model}${persist ? `, pooled ${msg.reuseKey!.slice(0, 8)} turn ${(msg.expectedTurn ?? 0) + 1}` : ""})`);
    } catch (err) {
      this.failSession(session, "worker_spawn_failed", (err as Error).message);
    }
  }

  // ---- device identities (docs/claude-code-compat.md §8) ----
  private identities = new Map<string, { deviceId: string | null; accountUuid: string | null; teamId?: string }>();
  private identityDirty = new Set<string>();

  /**
   * TUI worker (2026-11-10): interactive Claude Code asks "Do you trust the files in this folder?" the first time it
   * starts in a cwd, and every open gets a cwd of its own scope (1242 new cwd dirs in 24 h on ccr-tui). The shim answers
   * the dialog, but now and then its arrow key is echoed as text and the default "No, exit" is taken — ≈25 × "Claude
   * Code ended before it showed its prompt" a day. Seed the per-project answer in .claude.json (the key Claude Code
   * itself writes, `projects[cwd].hasTrustDialogAccepted`) so the dialog never shows; an entry already there is kept.
   */
  private seedFolderTrust(configDir: string, cwdDir: string, identity: { uid: number; gid: number } | null | undefined): void {
    const file = path.join(configDir, ".claude.json");
    try {
      const raw = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}) as Record<string, unknown>;
      const projects = (raw.projects && typeof raw.projects === "object" ? raw.projects : {}) as Record<string, Record<string, unknown>>;
      const cur = projects[cwdDir];
      if (cur && cur.hasTrustDialogAccepted === true) return;
      projects[cwdDir] = {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: false,
        ...(cur ?? {}),
        hasTrustDialogAccepted: true,
      };
      raw.projects = projects;
      // Atomic replace: Claude Code rewrites the file itself (lock + rename); a torn file would break every later launch.
      const tmp = `${file}.trust-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(raw), { mode: 0o600 });
      // The replacement must stay readable by the uid Claude Code runs as. With machine identity the launcher drops to
      // the team uid itself, so "the node does not setuid" never meant "the file may stay root's": a root-owned 0600
      // .claude.json reads as a first run and Claude Code mints a new userID (2026-11-10: 30 ccr-tui accounts, X-49).
      const owner = fs.existsSync(file) ? fs.statSync(file) : identity ?? null;
      if (owner && process.getuid?.() === 0) fs.chownSync(tmp, owner.uid, owner.gid);
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log(`could not seed folder trust for ${cwdDir}: ${(err as Error).message}`);
    }
  }

  /** Read .claude.json of one account dir; marks it dirty for the next heartbeat when changed. */
  refreshIdentity(accountId: string, teamId?: string): void {
    const file = path.join(this.accountConfigDir(accountId, teamId), ".claude.json");
    let next: { deviceId: string | null; accountUuid: string | null; teamId?: string };
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as { userID?: unknown; oauthAccount?: { accountUuid?: unknown } };
      next = {
        ...(teamId ? { teamId } : {}),
        deviceId: typeof j.userID === "string" && j.userID ? j.userID : null,
        accountUuid: typeof j.oauthAccount?.accountUuid === "string" && j.oauthAccount.accountUuid ? j.oauthAccount.accountUuid : null,
      };
    } catch {
      return; // no config yet (or unreadable): nothing to report
    }
    if (!next.deviceId && !next.accountUuid) return;
    const prev = this.identities.get(accountId);
    if (!prev || prev.deviceId !== next.deviceId || prev.accountUuid !== next.accountUuid || prev.teamId !== next.teamId) {
      this.identities.set(accountId, next);
      this.identityDirty.add(accountId);
    }
  }

  /** Scan every account dir (startup / reconnect): all identities become pending for the next heartbeat. */
  scanIdentities(): void {
    const root = path.join(this.workerRoot, "cc-accounts");
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const d of dirs) this.refreshIdentity(d);
    const teamsRoot = path.join(this.workerRoot, "teams");
    if (fs.existsSync(teamsRoot)) for (const team of fs.readdirSync(teamsRoot)) {
      const accounts = path.join(teamsRoot, team, "cc-accounts");
      if (!fs.existsSync(accounts)) continue;
      for (const account of fs.readdirSync(accounts)) {
        try {
          const binding = JSON.parse(fs.readFileSync(path.join(accounts, account, "team-account.json"), "utf8")) as { teamId: string; accountId: string };
          this.refreshIdentity(binding.accountId, binding.teamId);
        } catch { /* incomplete account dir: never report an unowned identity */ }
      }
    }
    for (const id of this.identities.keys()) this.identityDirty.add(id);
  }

  /** Identities changed since the last call (heartbeat payload); empty object when nothing changed. */
  identityDelta(): Record<string, { deviceId: string | null; accountUuid: string | null; teamId?: string }> {
    const out: Record<string, { deviceId: string | null; accountUuid: string | null; teamId?: string }> = {};
    for (const id of this.identityDirty) {
      const v = this.identities.get(id);
      if (v) out[id] = v;
    }
    this.identityDirty.clear();
    return out;
  }

  private finishSession(session: WorkerSession, reasonCode: string): void {
    if (session.closed) return;
    session.closed = true;
    if (!session.proc) this.mcp.unregister(session.sessionId, "one-shot session ended");
    this.refreshIdentity(session.accountId, session.isolation?.teamId); // Claude Code may have (re)written .claude.json during the run
    this.sessions.delete(session.sessionId);
    if (session.timer) clearTimeout(session.timer);
    this.removeWorkDir(session);
    this.opts.send({ type: "cc_worker.close", sessionId: session.sessionId, reasonCode });
    this.drainQueue();
  }

  private removeWorkDir(session: WorkerSession): void {
    const d = session.workDir;
    session.workDir = null;
    if (!d) return;
    // The child may still be exiting: retry briefly so a late write cannot resurrect the dir.
    const attempt = (n: number) => {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      if (n > 0 && fs.existsSync(d)) setTimeout(() => attempt(n - 1), 500).unref();
    };
    attempt(4);
  }

  /** Kill the worker and everything it spawned (its own process group). */
  private killTree(session: WorkerSession): void {
    const child = session.child;
    if (!child || child.exitCode !== null || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }

  private failSession(session: WorkerSession, errorCode: string, errorMessage: string): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.sessionId);
    if (session.timer) clearTimeout(session.timer);
    if (session.proc && !session.proc.retiring) {
      // A failed turn poisons the process (unknown state): drop it from the pool.
      const proc = session.proc;
      proc.busy = null;
      this.retire(proc, "turn_failed");
    }
    if (!session.proc) this.mcp.unregister(session.sessionId, "one-shot session failed");
    this.killTree(session);
    this.removeWorkDir(session);
    // stderr may quote the prompt but never carries tokens (they live only in
    // the config dir); still cap it hard.
    this.opts.send({ type: "cc_worker.error", sessionId: session.sessionId, errorCode, errorMessage: errorMessage.slice(0, 500), retryable: true });
    // Keep the cause in the node journal too: the gateway drops this frame when it already finished the response.
    this.log(`error ${session.sessionId}: ${errorCode}${errorCode === "worker_failed" ? ` — ${errorMessage.replace(/\s+/g, " ").slice(0, 480)}` : ""}`);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.sessions.size < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.launch(next.msg, next.proxyUrl);
    }
  }

  /** Strong reset differs from close: parked native tool calls must die, never remain reusable. */
  resetConversation(context: IsolationContext): void {
    this.isolation.retire(context);
    for (const q of [...this.queue]) if (sameIsolation(q.msg.isolation, context)) {
      this.queue.splice(this.queue.indexOf(q), 1);
      this.reject(q.msg.sessionId, "isolation_retired");
    }
    for (const p of [...this.procs.values()]) if (sameIsolation(p.isolation, context)) this.retire(p, "conversation_reset");
    for (const s of [...this.sessions.values()]) if (sameIsolation(s.isolation, context)) {
      this.killTree(s);
      this.failSession(s, "isolation_retired", "Conversation generation was retired");
    }
  }

  isolatedContexts(): IsolationContext[] {
    const contexts = [...this.procs.values(), ...this.sessions.values()].map((s) => s.isolation).concat(this.queue.map((q) => q.msg.isolation));
    return [...new Map(contexts.filter((c): c is IsolationContext => !!c).map((c) => [JSON.stringify(c), c])).values()];
  }

  handleClose(msg: CcWorkerClose): void {
    const session = this.sessions.get(msg.sessionId);
    this.log(`close frame ${msg.sessionId} (${msg.reasonCode ?? "-"}): ${session ? `${session.proc ? `pooled ${session.proc.key.slice(0, 8)}, pending ${this.mcp.pendingCount(session.proc.key)}` : "one-shot"}${session.closed ? ", already closed" : ""}` : "no such session"}`);
    if (!session) {
      // Still queued: drop it so drainQueue never spawns a worker nobody waits for.
      const i = this.queue.findIndex((q) => q.msg.sessionId === msg.sessionId);
      if (i >= 0) {
        this.queue.splice(i, 1);
        this.opts.send({ type: "cc_worker.close", sessionId: msg.sessionId, reasonCode: msg.reasonCode ?? "gateway_closed" });
      }
      return;
    }
    if (session.closed) return;
    if (session.proc && session.proc.hasTools && this.mcp.pendingCount(session.proc.key) > 0 &&
        ["tool_handoff", "gateway_closed"].includes(msg.reasonCode ?? "")) {
      // The gateway handed the tool_use to the client and closed this request; the
      // turn stays open on the node until the tool results come back (or time out).
      const proc = session.proc;
      proc.busy = null;
      proc.awaitingTools = true;
      proc.toolDeadline = Date.now() + TOOL_RESULT_WAIT_MS;
      proc.lastUsedAt = Date.now();
      session.closed = true;
      this.sessions.delete(session.sessionId);
      if (session.timer) clearTimeout(session.timer);
      this.opts.send({ type: "cc_worker.close", sessionId: session.sessionId, reasonCode: "awaiting_tool_result" });
      this.log(`session ${proc.key.slice(0, 8)} parked with ${this.mcp.pendingCount(proc.key)} tool call(s), waiting for the client`);
      this.drainQueue();
      return;
    }
    // Gateway went away mid-turn (client disconnected): a pooled process cannot be
    // trusted to stop generating on its own, so it is retired like a one-shot.
    if (session.proc) {
      const proc = session.proc;
      proc.busy = null;
      this.retire(proc, "client_closed");
    }
    this.killTree(session);
    this.finishSession(session, msg.reasonCode ?? "gateway_closed");
  }

  /** Open session ids (link-grace hello / reconciliation). */
  sessionIds(): string[] {
    return [...this.sessions.values()].filter((s) => !s.closed).map((s) => s.sessionId);
  }

  closeAll(reasonCode = "node_shutdown"): void {
    for (const p of [...this.procs.values()]) {
      p.busy = null;
      this.retire(p, reasonCode);
    }
    this.mcp.stop(); // restarted lazily by the next tool-bearing session
    for (const session of [...this.sessions.values()]) {
      this.killTree(session);
      if (!session.closed) this.finishSession(session, reasonCode);
    }
    for (const q of this.queue.splice(0)) {
      this.opts.send({ type: "cc_worker.error", sessionId: q.msg.sessionId, errorCode: reasonCode, retryable: true });
    }
    this.sessions.clear();
  }
}

export { CC_VERSION_PIN };
