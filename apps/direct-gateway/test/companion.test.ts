import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DirectGateway } from "../src/app.ts";
import { StateStore } from "../src/state.ts";
import type { GatewayConfig } from "../src/types.ts";

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for companion");
    await Bun.sleep(25);
  }
}

describe("worker-0 companion", () => {
  it("starts an idle official-client process with isolated identity and the account proxy, then restarts it after credential rotation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-test-"));
    const fakeBin = path.join(dir, "fake-claude");
    fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const credentials = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".credentials.json"), "utf8"));
fs.appendFileSync(path.join(process.cwd(), "invocations.ndjson"), JSON.stringify({ argv: process.argv.slice(2), proxy: process.env.HTTPS_PROXY, baseUrl: process.env.ANTHROPIC_BASE_URL, accessToken: credentials.claudeAiOauth.accessToken }) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    fs.chmodSync(fakeBin, 0o755);
    const config: GatewayConfig = {
      nodeName: "worker-0",
      listen: { host: "127.0.0.1", port: 0 },
      clientApiKeys: ["client-test"],
      companion: { enabled: true, claudeBin: fakeBin, restartDelayMs: 10, startupStaggerMs: 0 },
      accounts: [{
        id: "account-0",
        baseUrl: "http://upstream.test",
        accessToken: "access-old",
        refreshToken: "refresh-old",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        proxy: "http://127.0.0.1:19101",
        models: ["claude-*"],
      }],
    };
    const state = new StateStore(path.join(dir, "config.json"));
    const gateway = new DirectGateway(config, state);
    try {
      await gateway.start();
      const accountDir = path.join(dir, "companions", "account-0");
      const invocations = path.join(accountDir, "invocations.ndjson");
      await waitFor(() => fs.existsSync(invocations));
      expect(gateway.companion.stats()).toEqual({ enabled: true, running: 1, startingOrFailed: 0 });
      const first = JSON.parse(fs.readFileSync(invocations, "utf8").trim());
      expect(first.argv).toContain("--input-format");
      expect(first.argv).toContain("stream-json");
      expect(first.argv).not.toContain("Use the Bash tool");
      expect(first.proxy).toBe("http://127.0.0.1:19101");
      expect(first.baseUrl).toBe("http://upstream.test");
      expect(first.accessToken).toBe("access-old");
      const claudeJson = JSON.parse(fs.readFileSync(path.join(accountDir, ".claude.json"), "utf8"));
      const account = state.account(config.accounts[0], "worker-0");
      expect(claudeJson.userID).toBe(account.deviceId);
      const rotated = { ...account, accessToken: "access-new", refreshToken: "refresh-new", expiresAt: new Date(Date.now() + 7_200_000).toISOString() };
      await gateway.companion.sync(rotated);
      await waitFor(() => fs.readFileSync(invocations, "utf8").trim().split("\n").length === 2);
      const second = JSON.parse(fs.readFileSync(invocations, "utf8").trim().split("\n")[1]);
      expect(second.accessToken).toBe("access-new");
      const health = await gateway.fetch(new Request("http://gateway.test/health"));
      expect((await health.json() as Record<string, any>).companion.running).toBe(1);
    } finally {
      await gateway.close();
      await Bun.sleep(25);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(gateway.companion.stats().running).toBe(0);
  });
});
