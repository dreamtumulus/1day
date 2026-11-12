import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { DirectGateway } from "../src/app.ts";
import { ccBuildSuffix } from "../src/shape.ts";
import { StateStore } from "../src/state.ts";
import type { GatewayConfig, Json } from "../src/types.ts";

interface RecordedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Json;
}

interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  delete process.env.DIRECT_GATEWAY_OAUTH_TOKEN_URL;
  while (cleanups.length) await cleanups.pop()!();
});

function sse(events: Json[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function message(text = "OK"): string {
  return JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}

async function fixture(handler: (record: RecordedRequest) => MockReply = () => ({ body: message() }), accountPatch: Record<string, unknown> = {}) {
  const records: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Json = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      const record = { url: req.url!, headers: req.headers, body };
      records.push(record);
      const reply = handler(record);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-gateway-test-"));
  const config: GatewayConfig = {
    nodeName: "worker-0",
    listen: { host: "127.0.0.1", port: 0 },
    clientApiKeys: ["client-test"],
    accounts: [{
      id: "account-0",
      baseUrl: "http://upstream.test",
      accessToken: "upstream-token",
      proxy: `http://127.0.0.1:${address.port}`,
      models: ["claude-*"],
      ...accountPatch,
    }],
  };
  const state = new StateStore(path.join(dir, "config.json"));
  const gateway = new DirectGateway(config, state);
  cleanups.push(() => gateway.close());
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { gateway, records, config, state, dir };
}

function call(gateway: DirectGateway, route: string, body: Json, headers: Record<string, string> = {}): Promise<Response> {
  return gateway.fetch(new Request(`http://gateway.test${route}`, {
    method: "POST",
    headers: { authorization: "Bearer client-test", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

function chatBody(patch: Json = {}): Json {
  return {
    model: "claude-sonnet-4-5-20250929",
    messages: [{ role: "user", content: "Say OK" }],
    max_tokens: 128,
    ...patch,
  };
}

describe("worker-0 direct gateway", () => {
  it("adapts OpenAI requests to the active Claude Code profile and converts the response", async () => {
    const { gateway, records, config } = await fixture(undefined, { accessToken: undefined, apiKey: "upstream-token" });
    const response = await call(gateway, "/v1/chat/completions", chatBody({
      messages: [{ role: "system", content: "client system" }, { role: "user", content: "Say OK" }],
      tools: [
        { type: "function", function: { name: "Write", description: "write", parameters: { type: "object" } } },
        { type: "function", function: { name: "Bash", description: "bash", parameters: { type: "object" } } },
      ],
    }));
    expect(response.status).toBe(200);
    const output = await response.json() as Json;
    expect(output.choices[0].message.content).toBe("OK");
    expect(output.usage.prompt_tokens).toBe(10);
    expect(records).toHaveLength(1);
    const upstream = records[0];
    expect(upstream.url).toBe("http://upstream.test/v1/messages?beta=true");
    expect(upstream.headers.authorization).toBeUndefined();
    expect(upstream.headers["x-api-key"]).toBe("upstream-token");
    expect(upstream.headers["user-agent"]).toBe("claude-cli/2.1.322 (external, sdk-cli)");
    expect(upstream.headers["anthropic-beta"]).not.toContain("advanced-tool-use-2025-11-20");
    expect(upstream.headers["anthropic-beta"]).not.toContain("oauth-2025-04-20");
    expect(upstream.headers["accept-encoding"]).toBe("gzip, deflate, br, zstd");
    expect(upstream.body.system).toHaveLength(4);
    expect(upstream.body.system[0].text).toContain("cc_version=2.1.322");
    expect(upstream.body.system[1].text).toContain("Claude agent");
    expect(upstream.body.system[2].text.length).toBeGreaterThan(20_000);
    expect(upstream.body.system[2].text).not.toContain("ToolSearch");
    expect(upstream.body.system[3].text).toBe("client system");
    expect(upstream.body.tools.map((tool: Json) => tool.name)).toEqual(["Bash", "Write"]);
    const identity = JSON.parse(upstream.body.metadata.user_id);
    expect(identity.device_id).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.session_id).toBe(upstream.headers["x-claude-code-session-id"]);
    expect(identity.device_id).not.toBe("client-device");
    expect(config.nodeName).toBe("worker-0");
  });

  it("normalizes native Claude Code software while preserving business content and pinning identity", async () => {
    const session = "11111111-2222-4333-8444-555555555555";
    const nativeBody = chatBody({
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.300.f23; cc_entrypoint=cli;" },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
      ],
      tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
      metadata: { user_id: JSON.stringify({ device_id: "a".repeat(64), account_uuid: "client-account", session_id: session, custom: "kept" }) },
      thinking: { type: "enabled", budget_tokens: 127 },
      context_management: { edits: [] },
      stream: true,
    });
    const events = [
      { type: "message_start", message: { id: "msg_native", type: "message", role: "assistant", model: nativeBody.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const { gateway, records } = await fixture(() => ({ headers: { "content-type": "text/event-stream" }, body: sse(events) }));
    const response = await call(gateway, "/v1/messages", nativeBody, {
      "user-agent": "claude-cli/2.1.300 (external, cli)",
      "x-app": "cli",
      "anthropic-beta": "interleaved-thinking-2025-05-14",
      "anthropic-version": "2023-06-01",
      "x-stainless-lang": "js",
      "x-stainless-runtime": "node",
      "x-stainless-package-version": "0.128.0",
      "x-stainless-runtime-version": "v26.3.0",
      accept: "application/json",
      "x-claude-code-session-id": session,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
    const upstream = records[0].body;
    expect(records[0].headers["user-agent"]).toBe("claude-cli/2.1.322 (external, cli)");
    expect(records[0].headers["x-stainless-package-version"]).toBe("0.128.0");
    expect(records[0].headers["x-stainless-runtime-version"]).toBe("v26.12.1");
    expect(records[0].headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(upstream.messages).toEqual(nativeBody.messages);
    expect(upstream.system[0].text).toBe(`x-anthropic-billing-header: cc_version=2.1.322.${ccBuildSuffix(upstream.messages)}; cc_entrypoint=cli;`);
    expect(upstream.system.slice(1)).toEqual(nativeBody.system.slice(1));
    expect(upstream.tools).toEqual(nativeBody.tools);
    expect(upstream.thinking).toEqual(nativeBody.thinking);
    const identity = JSON.parse(upstream.metadata.user_id);
    expect(identity.device_id).not.toBe("a".repeat(64));
    expect(identity.account_uuid).toBe("");
    expect(identity.session_id).toBe(session);
    expect(identity.custom).toBe("kept");
    const repaired = await call(gateway, "/v1/messages", nativeBody, { "user-agent": "claude-cli/2.1.300 (external, cli)" });
    expect(repaired.status).toBe(200);
    expect(await repaired.text()).toContain("message_stop");
    expect(records).toHaveLength(2);
    expect(records[1].body.system[0].text).toContain(`cc_version=2.1.322.${ccBuildSuffix(records[1].body.messages)}`);
    expect(records[1].body.system.length).toBeGreaterThanOrEqual(3);
    expect(records[1].body.metadata.user_id).toContain(session);
  });

  it("converts streamed Anthropic tool calls and usage to OpenAI chunks", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_stream", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const { gateway } = await fixture(() => ({ headers: { "content-type": "text/event-stream" }, body: sse(events) }));
    const response = await call(gateway, "/v1/chat/completions", chatBody({ stream: true, stream_options: { include_usage: true } }));
    const text = await response.text();
    expect(text).toContain('"name":"Bash"');
    const argumentLine = text.split("\n\n").find((line) => line.includes("pwd") && line.startsWith("data: {"));
    const argumentChunk = JSON.parse(argumentLine!.slice(6)) as Json;
    expect(argumentChunk.choices[0].delta.tool_calls[0].function.arguments).toBe('{"command":"pwd"}');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain('"prompt_tokens":7');
    expect(text).toContain("data: [DONE]");
  });

  it("decodes compressed upstream SSE without buffering it into JSON", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_gzip", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const { gateway } = await fixture(() => ({ headers: { "content-type": "text/event-stream", "content-encoding": "gzip" }, body: gzipSync(sse(events)) }));
    const response = await call(gateway, "/v1/chat/completions", chatBody({ stream: true }));
    expect(await response.text()).toContain("streamed");
  });

  it("fails closed when an account has no proxy", async () => {
    const { gateway, records } = await fixture(undefined, { proxy: "" });
    const response = await call(gateway, "/v1/chat/completions", chatBody());
    expect(response.status).toBe(503);
    expect((await response.json() as Json).error.code).toBe("no_proxy_available");
    expect(records).toHaveLength(0);
  });

  it("refreshes OAuth through the same proxy and persists rotated credentials encrypted", async () => {
    process.env.DIRECT_GATEWAY_OAUTH_TOKEN_URL = "http://oauth.test/token";
    const { gateway, records, config, dir } = await fixture((record) => {
      if (record.url === "http://oauth.test/token") return { body: JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }) };
      return { body: message() };
    }, { refreshToken: "old-refresh", expiresAt: new Date(Date.now() - 1000).toISOString() });
    const response = await call(gateway, "/v1/chat/completions", chatBody());
    expect(response.status).toBe(200);
    expect(records.map((r) => r.url)).toEqual(["http://oauth.test/token", "http://upstream.test/v1/messages?beta=true"]);
    expect(records[1].headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(records[1].headers.authorization).toBe("Bearer rotated-access");
    const second = await call(gateway, "/v1/chat/completions", chatBody());
    expect(second.status).toBe(200);
    expect(records).toHaveLength(3);
    expect(records[2].headers.authorization).toBe("Bearer rotated-access");
    const stored = fs.readFileSync(path.join(dir, "state.json"), "utf8");
    expect(stored).toContain("enc:v1:");
    expect(stored).not.toContain("rotated-access");
    expect(stored).not.toContain("rotated-refresh");
    const reloaded = new StateStore(path.join(dir, "config.json")).account(config.accounts[0], "worker-0");
    expect(reloaded.accessToken).toBe("rotated-access");
    expect(reloaded.refreshToken).toBe("rotated-refresh");
  });

  it("derives distinct persistent device identities for separate accounts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-state-test-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new StateStore(path.join(dir, "config.json"));
    const a = store.account({ id: "a", accessToken: "a", proxy: "http://proxy-a" }, "worker-0");
    const b = store.account({ id: "b", accessToken: "b", proxy: "http://proxy-b" }, "worker-0");
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(store.account({ id: "a", accessToken: "a", proxy: "http://proxy-a" }, "worker-0").deviceId).toBe(a.deviceId);
    expect(a.proxy).toBe("http://proxy-a");
    expect(b.proxy).toBe("http://proxy-b");
  });
});
