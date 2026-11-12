import fs from "node:fs";
import path from "node:path";
import { DirectGateway } from "./app.js";
import { defaultConfigPath, loadConfig } from "./config.js";
import { ACTIVE_PROFILE } from "./profile.js";
import { StateStore } from "./state.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function init(configPath: string): void {
  if (fs.existsSync(configPath)) throw new Error(`Refusing to overwrite existing config: ${configPath}`);
  const config = {
    nodeName: "worker-0",
    listen: { host: "127.0.0.1", port: 8410 },
    clientApiKeys: ["env:DIRECT_GATEWAY_CLIENT_KEY"],
    companion: { enabled: false, claudeBin: "claude" },
    accounts: [{
      id: "account-0",
      baseUrl: "https://api.anthropic.com",
      accessToken: "env:WORKER_0_CLAUDE_ACCESS_TOKEN",
      refreshToken: "env:WORKER_0_CLAUDE_REFRESH_TOKEN",
      expiresAt: null,
      proxy: "env:WORKER_0_CLAUDE_PROXY",
      models: ["claude-*"],
    }],
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`Created ${configPath}`);
}

const command = process.argv[2] ?? "serve";
if (command === "--version" || command === "version") {
  console.log(`1dayapi-direct 0.1.0 (Claude Code profile ${ACTIVE_PROFILE.claudeCodeVersion})`);
  process.exit(0);
}
if (command === "show-profile") {
  console.log(JSON.stringify({ ...ACTIVE_PROFILE, mainPrompt: `<${ACTIVE_PROFILE.mainPrompt.length} chars>` }, null, 2));
  process.exit(0);
}
const configPath = path.resolve(option("--config") ?? process.env.DIRECT_GATEWAY_CONFIG ?? defaultConfigPath());
if (command === "init") {
  init(configPath);
  process.exit(0);
}
if (command !== "serve") {
  console.error("Usage: 1dayapi-direct [serve] [--config PATH] | init [--config PATH] | show-profile | version");
  process.exit(64);
}
if (!(process.versions as Record<string, string>).bun) {
  console.error("1dayapi-direct must run under Bun; direct Node.js serving is forbidden");
  process.exit(70);
}
const config = loadConfig(configPath);
const state = new StateStore(configPath);
const gateway = new DirectGateway(config, state);
await gateway.start();
const server = Bun.serve({ hostname: config.listen.host, port: config.listen.port, fetch: gateway.fetch });
console.log(`[direct] node=${config.nodeName} listen=${config.listen.host}:${server.port} profile=${ACTIVE_PROFILE.claudeCodeVersion}`);
const shutdown = async () => {
  server.stop();
  await gateway.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
