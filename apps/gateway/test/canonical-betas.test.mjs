// Direct path, non-Claude-Code client: the gateway injects the canonical 2.1.312 beta set in the
// order a real client sends it (docs/claude-code-compat.md §6 / §11). Clients that bring their
// own betas are passed through; OAuth accounts get oauth-2025-04-20 added if missing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-betas-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const { buildUpstreamRequest } = await import("../dist/upstream.js");

const oauthAccount = { id: "a2", name: "sub", platform: "anthropic", type: "oauth", protocol: "anthropic", executor: "direct", base_url: null, models: null, model_mapping: null, route: "direct", raw_passthrough: 0, device_id: "d".repeat(64), account_uuid: null };
const keyAccount = { ...oauthAccount, id: "a3", type: "apikey" };
const body = { model: "claude-sonnet-5-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };
const nonCc = { "user-agent": "python-requests/2.32", accept: "application/json" };

test("non-CC client on an OAuth account: canonical set, oauth second", () => {
  const r = buildUpstreamRequest(oauthAccount, { accessToken: "tok" }, "chat-via-anthropic", body, "claude-sonnet-5-5", nonCc);
  assert.equal(r.headers["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,thinking-token-count-2026-05-13");
  assert.equal(r.headers["user-agent"], "claude-cli/2.1.312 (external, cli)");
  assert.equal(r.headers["x-stainless-runtime-version"], "v26.12.1");
});

test("non-CC client on an API-key account: canonical set without oauth", () => {
  const r = buildUpstreamRequest(keyAccount, { apiKey: "sk-x" }, "chat-via-anthropic", body, "claude-sonnet-5-5", nonCc);
  assert.equal(r.headers["anthropic-beta"], "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,thinking-token-count-2026-05-13");
});

test("Claude Code client with its own betas: passed through, oauth appended only when missing", () => {
  const cc = { "user-agent": "claude-cli/2.1.312 (external, cli)", "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01" };
  const r = buildUpstreamRequest(oauthAccount, { accessToken: "tok" }, "passthrough-anthropic", body, "claude-sonnet-5-5", cc);
  assert.equal(r.headers["anthropic-beta"], cc["anthropic-beta"]);
  const noOauth = { ...cc, "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14" };
  const r2 = buildUpstreamRequest(oauthAccount, { accessToken: "tok" }, "passthrough-anthropic", body, "claude-sonnet-5-5", noOauth);
  assert.equal(r2.headers["anthropic-beta"], "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20");
});

test("dynamic betas and Anthropic server tools survive direct passthrough", () => {
  const cc = { "user-agent": "claude-cli/2.1.312 (external, cli)", "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,web-search-2025-03-05,per-turn-control-2026-07-01" };
  const withServerTool = { ...body, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }] };
  const r = buildUpstreamRequest(oauthAccount, { accessToken: "tok" }, "passthrough-anthropic", withServerTool, "claude-sonnet-5-5", cc);
  assert.equal(r.headers["anthropic-beta"], cc["anthropic-beta"]);
  assert.deepEqual(JSON.parse(r.body).tools, withServerTool.tools);
});
