import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

export const E2E_TEAM_ID = "11111111-1111-4111-8111-111111111111";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function genuineCcRequest({ model = "claude-sonnet-5", stream = false, sessionId = randomUUID(), messages = [{ role: "user", content: "E2E Claude Code request" }], ...extra } = {}) {
  return {
    headers: {
      "user-agent": "claude-cli/2.1.303 (external, cli)", "x-app": "cli", "anthropic-beta": "claude-code-20250219",
      "x-stainless-lang": "js", "x-stainless-runtime": "node", "x-stainless-runtime-version": "v26.3.0",
      "x-stainless-package-version": "0.128.0", "x-claude-code-session-id": sessionId,
      accept: "application/json", "anthropic-version": "2023-06-01",
    },
    body: {
      model, stream, max_tokens: 64,
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.303.e2e; cc_entrypoint=cli;" }, { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      metadata: { user_id: JSON.stringify({ device_id: "e".repeat(64), account_uuid: "", session_id: sessionId }) },
      messages, ...extra,
    },
  };
}

/** Real console import/reservation/validation flow; only the remote node/upstream are test doubles. */
export async function createTeamFixture({ admin, provider, providerKey, consoleBase, upstreamBase, orgUuid = E2E_TEAM_ID, proxyCount = 8 }) {
  if (!provider) {
    const login = await fetch(consoleBase + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: providerKey }) });
    if (login.status !== 200) throw new Error("E2E provider login failed");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    provider = async (method, path, body) => {
      const res = await fetch(consoleBase + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, ...await res.json() };
    };
  }
  const bind = await provider("POST", "/api/provider/bind-codes");
  if (!bind.data?.code) throw new Error(`E2E bind code: ${JSON.stringify(bind)}`);
  const nodeId = `e2e_${randomUUID().replaceAll("-", "")}`;
  const node = spawn(process.execPath, [new URL("../../apps/console/scripts/fake-node.mjs", import.meta.url).pathname,
    "--node-id", nodeId, "--bind-code", bind.data.code, "--platform", consoleBase], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FAKE_NODE_HEARTBEAT_MS: "100", FAKE_NODE_ORG_UUID: orgUuid, FAKE_NODE_UPSTREAM_BASE: upstreamBase },
  });
  let log = "";
  node.stdout.on("data", (d) => { log += d; }); node.stderr.on("data", (d) => { log += d; });
  const stop = async () => { if (node.exitCode === null) { node.kill("SIGTERM"); await Promise.race([new Promise((resolve) => node.once("exit", resolve)), pause(1000)]); } };
  const onExit = () => node.kill("SIGTERM"); process.once("exit", onExit);
  try {
    let online = false;
    for (let i = 0; i < 100; i++) {
      if (node.exitCode !== null) throw new Error(`Fake node exited: ${log}`);
      const list = await provider("GET", "/api/provider/nodes");
      if (list.data?.some((n) => n.nodeId === nodeId && n.online) && log.includes("platform.ready")) { online = true; break; }
      await pause(30);
    }
    if (!online) throw new Error(`Fake node did not become ready: ${log}`);
    const octet = createHash("sha256").update(nodeId).digest()[0];
    const proxies = Array.from({ length: proxyCount }, (_, i) => ({ url: `http://fixture:fixture@198.18.${octet}.${i + 1}:8000`, label: `e2e-${i + 1}` }));
    const added = await admin("PUT", `/api/admin/nodes/${nodeId}/proxies`, { proxies });
    if (added.status !== 200) throw new Error(`E2E proxy import: ${JSON.stringify(added)}`);
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      const list = await admin("GET", `/api/admin/nodes/${nodeId}/proxies`);
      if (list.data?.length === proxyCount && list.data.every((p) => p.status === "live" && p.exitIp)) { healthy = true; break; }
      await pause(30);
    }
    if (!healthy) throw new Error(`E2E exit observations did not become ready: ${log}`);
    // Disable the deliberate onboarding delay in this isolated test stack.
    const settings = await admin("PUT", "/api/admin/settings", { onboard_cooldown_min_sec: "0", onboard_cooldown_max_sec: "0" });
    if (settings.status !== 200) throw new Error(`E2E onboarding settings: ${JSON.stringify(settings)}`);
    return {
      nodeId, orgUuid, log: () => log,
      stop: async () => { process.removeListener("exit", onExit); await stop(); },
      async createAccount(data) {
        let accessToken = data.accessToken ?? "oauth-fixture";
        // Healthy fixture identities are distinct actual upstream accounts. Failure-injection
        // keys are intentionally exact strings understood by mock-upstream.mjs.
        if (!accessToken.startsWith("mock-")) accessToken += "-" + randomUUID();
        return admin("POST", "/api/admin/accounts", { ...data, accessToken, nodeId, orgUuid });
      },
    };
  } catch (err) { process.removeListener("exit", onExit); await stop(); throw err; }
}
