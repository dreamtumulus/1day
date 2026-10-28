import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isoIn, nowIso, one, randomHex, run, sha256Hex } from "@1dayapi/core";
import { ensureBundle, findBun } from "./bundle.js";
import { generateNodeSecret, isNodeOnline, pushProxies } from "./registry.js";
import { replaceNodeProxies, type ProxyInput } from "./proxies.js";

// Server-side node deployment (protocol v2): create the node record +
// secret platform-side (admin authority), ship the bundle to the target
// host over SSH (or install locally), write the node config, and start it
// under systemd. Passwords/keys are used once and never stored. The bind
// code doubles as the one-time download token for /internal/provider/bundle.

export interface DeployTarget {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

export interface DeployOutcome {
  nodeId: string;
  online: boolean;
  ok: boolean;
  log: string;
  error?: string;
}

interface DeployCommon {
  providerId: string;
  adminId: string;
  name?: string;
  proxies?: ProxyInput[];
  platformHttpBase: string; // e.g. http://127.0.0.1:8401 or https://api.1dayapi.com
}

const SSH_TIMEOUT_MS = 420_000; // bun + claude (~270 MB) + bundle on a fresh host
const ONLINE_WAIT_MS = 30_000;

export class DeployError extends Error {}

function wsUrlFromHttpBase(base: string): string {
  const b = base.replace(/\/+$/, "");
  if (b.startsWith("https://")) return `wss://${b.slice(8)}/internal/provider/connect`;
  if (b.startsWith("http://")) return `ws://${b.slice(7)}/internal/provider/connect`;
  return `ws://${b}/internal/provider/connect`;
}

/** Create the nodes row (secret stored as sha256) + deploy_meta. */
function createNodeRecord(
  providerId: string,
  meta: Record<string, unknown>,
): { nodeId: string; secret: string } {
  const nodeId = `node_${randomUUID()}`;
  const secret = generateNodeSecret();
  run(
    "INSERT INTO nodes (node_id, provider_id, secret_hash, online, deploy_meta, created_at) VALUES (?, ?, ?, 0, ?, ?)",
    nodeId,
    providerId,
    sha256Hex(secret),
    JSON.stringify(meta),
    nowIso(),
  );
  return { nodeId, secret };
}

function updateDeployMeta(nodeId: string, patch: Record<string, unknown>): void {
  const row = one<{ deploy_meta: string | null }>("SELECT deploy_meta FROM nodes WHERE node_id = ?", nodeId);
  let cur: Record<string, unknown> = {};
  try {
    cur = row?.deploy_meta ? (JSON.parse(row.deploy_meta) as Record<string, unknown>) : {};
  } catch {
    cur = {};
  }
  run("UPDATE nodes SET deploy_meta = ? WHERE node_id = ?", JSON.stringify({ ...cur, ...patch }), nodeId);
}

function createBundleBindCode(providerId: string): string {
  const code = `bind_${randomHex(16)}`;
  run(
    "INSERT INTO node_bind_codes (code, provider_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    code,
    providerId,
    isoIn(10 * 60_000),
    nowIso(),
  );
  return code;
}

/** Single-quote a value for safe embedding in a shell prelude line. */
function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Full stdin payload for `ssh ... 'bash -s'`: a KEY='value' prelude (so
 * secrets travel inside the encrypted SSH channel, never in argv where ps
 * could see them) followed by the install script.
 */
export function buildRemoteScript(opts: {
  bundleUrl: string;
  nodeId: string;
  providerId: string;
  secret: string;
  wsUrl: string;
}): string {
  const prelude = [
    `NODE_BUNDLE_URL=${sq(opts.bundleUrl)}`,
    `NODE_ID=${sq(opts.nodeId)}`,
    `NODE_PROVIDER_ID=${sq(opts.providerId)}`,
    `NODE_SECRET=${sq(opts.secret)}`,
    `NODE_WS_URL=${sq(opts.wsUrl)}`,
  ].join("\n");
  return `${prelude}
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
echo "[deploy] start: $(uname -srm)"
# bun's installer needs unzip; a fresh Ubuntu image does not ship it (worker-01 and worker-02 both failed here first).
if [ "$(id -u)" -eq 0 ] && ! command -v unzip >/dev/null 2>&1; then
  echo "[deploy] installing unzip"
  (DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip) >/dev/null 2>&1 || echo "[deploy] WARN: unzip install failed"
fi
if ! command -v bun >/dev/null 2>&1 || ! bun --version 2>/dev/null | grep -q '^1\\.4\\.3$'; then
  echo "[deploy] installing bun 1.4.3"
  curl -fsSL https://bun.sh/install | bash -s bun-v1.4.3
  export PATH="$HOME/.bun/bin:$PATH"
  hash -r 2>/dev/null || true
fi
command -v bun >/dev/null 2>&1 || { echo "[deploy] ERROR: bun installation failed" >&2; exit 1; }
echo "[deploy] bun $(bun --version)"
# --- Claude Code worker prerequisites (docs/operations.md §6 checklist, ccr-supply.md §8.1) ---
# The node runs Claude Code as the unprivileged service user ccworker from
# /var/lib/1dayapi-cc-worker; the claude binary must live where that user can
# execute it (not under /root/.bun). Missing any of this = the 2026-10-16
# EACCES incident, so the same self-test the node runs at startup gates the deploy.
CLAUDE_VERSION=2.1.300
if [ "$(id -u)" -eq 0 ]; then
  if ! [ -x /opt/claude/claude ] || ! /opt/claude/claude --version 2>/dev/null | grep -q "$CLAUDE_VERSION"; then
    echo "[deploy] installing claude $CLAUDE_VERSION via bun"
    bun add -g "@anthropic-ai/claude-code@$CLAUDE_VERSION" >/dev/null 2>&1 || echo "[deploy] WARN: claude install failed; cc_worker mode will be disabled on this node"
    REAL="$(readlink -f "$HOME/.bun/bin/claude" 2>/dev/null || true)"
    if [ -n "$REAL" ] && [ -x "$REAL" ]; then
      mkdir -p /opt/claude && cp -f "$REAL" /opt/claude/claude && chmod 755 /opt/claude/claude
    fi
  fi
  if [ -x /opt/claude/claude ]; then
    ln -sfn /opt/claude/claude /usr/local/bin/claude
    echo "[deploy] claude $(/opt/claude/claude --version 2>/dev/null | head -1) at /opt/claude/claude"
  fi
  if ! id ccworker >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin ccworker && echo "[deploy] created service user ccworker"
  fi
  mkdir -p /var/lib/1dayapi-cc-worker && chmod 711 /var/lib/1dayapi-cc-worker
  SELFTEST=/var/lib/1dayapi-cc-worker/cc-sessions/install-selftest
  mkdir -p "$SELFTEST" && chmod 700 "$SELFTEST" && chown ccworker:ccworker "$SELFTEST"
  if OUT="$(su -s /bin/sh ccworker -c "cd $SELFTEST && HOME=$SELFTEST TMPDIR=$SELFTEST CLAUDE_CONFIG_DIR=$SELFTEST /usr/local/bin/claude --version" 2>&1)"; then
    echo "[deploy] worker isolation self-test PASSED: ccworker ran claude $OUT"
  else
    echo "[deploy] ERROR: worker isolation self-test FAILED: $OUT" >&2
    rm -rf "$SELFTEST"
    exit 1
  fi
  rm -rf "$SELFTEST"
else
  echo "[deploy] WARN: not root; skipping ccworker/claude setup (cc_worker mode needs a root deploy)"
fi
APP_DIR="$HOME/.1dayapi-node"
mkdir -p "$APP_DIR" && chmod 700 "$APP_DIR"
echo "[deploy] downloading node bundle"
curl -fsSL --retry 3 --connect-timeout 10 --max-time 300 "$NODE_BUNDLE_URL" -o "$APP_DIR/node-bundle.js"
CFG_DIR="$HOME/.config/1dayapi-provider-node"
mkdir -p "$CFG_DIR" && chmod 700 "$CFG_DIR"
cat > "$CFG_DIR/config.json" <<EOF
{
  "nodeId": "$NODE_ID",
  "providerId": "$NODE_PROVIDER_ID",
  "providerNodeSecret": "$NODE_SECRET",
  "platformWsUrl": "$NODE_WS_URL",
  "boundAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
chmod 600 "$CFG_DIR/config.json"
if [ "$(id -u)" -eq 0 ]; then
  UNIT=/etc/systemd/system/1dayapi-node.service
  WANTED=multi-user.target
  SYSCTL="systemctl"
else
  UNIT="$HOME/.config/systemd/user/1dayapi-node.service"
  mkdir -p "$HOME/.config/systemd/user"
  WANTED=default.target
  SYSCTL="systemctl --user"
fi
cat > "$UNIT" <<EOF
[Unit]
Description=1DayAPI provider node
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$HOME/.bun/bin/bun $APP_DIR/node-bundle.js
Restart=always
RestartSec=3

[Install]
WantedBy=$WANTED
EOF
if ! $SYSCTL daemon-reload || ! $SYSCTL enable --now 1dayapi-node; then
  echo "[deploy] WARN: systemd unavailable; starting node with nohup"
  nohup "$HOME/.bun/bin/bun" "$APP_DIR/node-bundle.js" >> "$APP_DIR/node.log" 2>&1 &
else
  if [ "$(id -u)" -ne 0 ]; then
    loginctl enable-linger "$(whoami)" 2>/dev/null \\
      || sudo -n loginctl enable-linger "$(whoami)" 2>/dev/null \\
      || echo "[deploy] WARN: loginctl enable-linger failed; the node stops when this user logs out"
  fi
fi
echo "[deploy] DONE node=$NODE_ID"
`;
}

function requireCmd(cmd: string, hint: string): void {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) throw new DeployError(hint);
}

interface SshRunResult {
  code: number | null;
  out: string;
  timedOut: boolean;
}

function runRemoteScript(target: DeployTarget, script: string): Promise<SshRunResult> {
  requireCmd("ssh", "ssh client not found on this server; apt-get install -y openssh-client");
  if (target.password) {
    requireCmd(
      "sshpass",
      "sshpass not found on this server (needed for password auth); apt-get install -y sshpass",
    );
  }
  let keyDir: string | null = null;
  const sshArgs: string[] = [];
  if (target.privateKey) {
    keyDir = mkdtempSync(join(tmpdir(), "1day-deploy-"));
    const keyFile = join(keyDir, "key");
    writeFileSync(keyFile, target.privateKey, { mode: 0o600 });
    sshArgs.push("-i", keyFile, "-o", "IdentitiesOnly=yes");
  }
  sshArgs.push(
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=15",
    "-p", String(target.port),
    `${target.username}@${target.host}`,
    "bash -s",
  );
  const cmd = target.password ? "sshpass" : "ssh";
  const args = target.password ? ["-e", "ssh", ...sshArgs] : sshArgs;
  const env = target.password ? { ...process.env, SSHPASS: target.password } : process.env;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SSH_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      if (keyDir) rmSync(keyDir, { recursive: true, force: true });
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (keyDir) rmSync(keyDir, { recursive: true, force: true });
      resolvePromise({ code, out, timedOut });
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

async function waitForNodeOnline(nodeId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isNodeOnline(nodeId)) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return isNodeOnline(nodeId);
}

function finishDeploy(
  nodeId: string,
  common: DeployCommon,
  online: boolean,
  log: string,
  error?: string,
): DeployOutcome {
  if (common.proxies?.length) {
    const pool = replaceNodeProxies(nodeId, common.proxies);
    if (online) pushProxies(nodeId, pool.urls);
  }
  updateDeployMeta(nodeId, {
    status: error ? "failed" : "ok",
    online,
    finishedAt: nowIso(),
    ...(error ? { error } : {}),
  });
  return { nodeId, online, ok: !error, log, ...(error ? { error } : {}) };
}

/** SSH deploy: install bun + bundle + config + systemd on the remote host. */
export async function deployNodeViaSsh(target: DeployTarget, common: DeployCommon): Promise<DeployOutcome> {
  await ensureBundle(); // fail fast before creating any records
  const { nodeId, secret } = createNodeRecord(common.providerId, {
    method: "ssh",
    host: target.host,
    port: target.port,
    username: target.username,
    name: common.name ?? null,
    deployedAt: nowIso(),
    deployedBy: common.adminId,
    status: "deploying",
  });
  const code = createBundleBindCode(common.providerId);
  const script = buildRemoteScript({
    bundleUrl: `${common.platformHttpBase.replace(/\/+$/, "")}/internal/provider/bundle?code=${code}`,
    nodeId,
    providerId: common.providerId,
    secret,
    wsUrl: wsUrlFromHttpBase(common.platformHttpBase),
  });
  let res: SshRunResult;
  try {
    res = await runRemoteScript(target, script);
  } catch (err) {
    return finishDeploy(nodeId, common, false, "", (err as Error).message);
  }
  const ok = res.code === 0 && !res.timedOut && res.out.includes("[deploy] DONE");
  if (!ok) {
    const why = res.timedOut
      ? `ssh timed out after ${SSH_TIMEOUT_MS / 1000}s`
      : `remote script failed (exit ${res.code})`;
    return finishDeploy(nodeId, common, false, res.out, why);
  }
  const online = await waitForNodeOnline(nodeId, ONLINE_WAIT_MS);
  return finishDeploy(
    nodeId,
    common,
    online,
    res.out,
    online ? undefined : "node did not come online within 30s",
  );
}

/** Local node console port: 16889 for the first local node, then upwards. */
function freeConsolePort(): Promise<number> {
  const tryPort = (p: number): Promise<boolean> =>
    new Promise((res) => {
      const s = createServer()
        .once("error", () => res(false))
        .once("listening", () => s.close(() => res(true)))
        .listen(p, "127.0.0.1");
    });
  return (async () => {
    for (let p = 16889; p < 16989; p++) {
      if (await tryPort(p)) return p;
    }
    return 16889; // saturated; the node will fail to listen and log it
  })();
}

/** Local deploy: run a node on this very server (no SSH). */
export async function deployNodeLocal(common: DeployCommon): Promise<DeployOutcome> {
  const bundle = await ensureBundle();
  const bun = findBun();
  if (!bun) {
    throw new DeployError("bun not found on this server; install it first (curl -fsSL https://bun.sh/install | bash)");
  }
  // Same machine as the console: always connect over loopback, whatever the
  // public api_base_url says.
  const wsUrl = `ws://127.0.0.1:${process.env.PORT ?? 8401}/internal/provider/connect`;
  const { nodeId, secret } = createNodeRecord(common.providerId, {
    method: "local",
    host: "127.0.0.1",
    name: common.name ?? null,
    deployedAt: nowIso(),
    deployedBy: common.adminId,
    status: "deploying",
  });
  const consolePort = await freeConsolePort();
  const dir = join(homedir(), ".1dayapi-node", nodeId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bundlePath = join(dir, "node-bundle.js");
  copyFileSync(bundle.path, bundlePath);
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        nodeId,
        providerId: common.providerId,
        providerNodeSecret: secret, // node re-encrypts it on first boot
        platformWsUrl: wsUrl,
        boundAt: nowIso(),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  const logPath = join(dir, "node.log");
  const fd = openSync(logPath, "a");
  const child = spawn(bun, [bundlePath], {
    env: {
      ...process.env,
      PROVIDER_CONFIG_PATH: configPath,
      PROVIDER_PLATFORM_WS_URL: wsUrl,
      PROVIDER_CONSOLE_PORT: String(consolePort),
    },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  const online = await waitForNodeOnline(nodeId, ONLINE_WAIT_MS);
  updateDeployMeta(nodeId, { consolePort });
  return finishDeploy(
    nodeId,
    common,
    online,
    `local node pid=${child.pid} dir=${dir} console=http://127.0.0.1:${consolePort} log=${logPath}`,
    online ? undefined : "node process did not come online within 30s (see node.log)",
  );
}
