import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DirectGateway } from "../src/app.ts";
import { StateStore } from "../src/state.ts";
import type { GatewayConfig, Json } from "../src/types.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function listen(handler: (req: http.IncomingMessage, body: string) => { status?: number; body: unknown }) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const reply = handler(req, Buffer.concat(chunks).toString());
      res.writeHead(reply.status ?? 200, { "content-type": typeof reply.body === "string" && reply.body.includes("event:") ? "text/event-stream" : "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

async function fixture(events: Array<{ type: string; [key: string]: unknown }> | null) {
  const calls: Array<{ path: string; body: Json }> = [];
  const controlPort = await listen((req, text) => {
    const body = JSON.parse(text || "{}");
    calls.push({ path: req.url!, body });
    if (req.url === "/internal/worker0/admission") return { body: { data: { requestId: body.requestId, accountIds: ["account-0"], coolingAccountIds: [] } } };
    if (req.url === "/internal/worker0/settle") return { body: { data: { settled: true } } };
    return { body: { data: { recorded: true } } };
  });
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 150000, cache_creation: { ephemeral_5m_input_tokens: 100000, ephemeral_1h_input_tokens: 50000 } };
  const upstreamPort = await listen((req) => {
    if (events) {
      const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return { body, status: 200 };
    }
    return { body: { id: "msg_cp", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage } };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker0-control-test-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config: GatewayConfig = {
    nodeName: "worker-0",
    listen: { host: "127.0.0.1", port: 0 },
    clientApiKeys: ["client-test"],
    controlPlane: { baseUrl: `http://127.0.0.1:${controlPort}`, token: "cp-token" },
    accounts: [{ id: "account-0", baseUrl: `http://127.0.0.1:${upstreamPort}`, accessToken: "upstream-token", proxy: `http://127.0.0.1:${upstreamPort}`, models: ["claude-*"] }],
  };
  const gateway = new DirectGateway(config, new StateStore(path.join(dir, "config.json")));
  cleanups.push(() => gateway.close());
  return { gateway, calls };
}

function chat(stream = false): Request {
  return new Request("http://gateway.test/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer client-test", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-5-20250929", messages: [{ role: "user", content: [{ type: "text", text: "Say OK", cache_control: { type: "ephemeral" } }] }], max_tokens: 128, stream }) });
}

describe("worker-0 control plane", () => {
  it("settles Agent usage after removing profile overhead and reports the upstream window", async () => {
    const { gateway, calls } = await fixture(null);
    const response = await gateway.fetch(chat());
    expect(response.status).toBe(200);
    const admission = calls.find((c) => c.path === "/internal/worker0/admission")!;
    const settlement = calls.find((c) => c.path === "/internal/worker0/settle")!;
    expect(settlement.body.requestId).toBe(admission.body.requestId);
    expect(settlement.body.mode).toBe("worker0-agent");
    expect(settlement.body.usage.input_tokens).toBe(100);
    expect(settlement.body.usage.input_tokens + settlement.body.usage.cache_read_tokens + settlement.body.usage.cache_write_tokens).toBeLessThan(100 + 50 + 150000);
    expect(settlement.body.usage.cache_read_tokens).toBe(0);
    expect(settlement.body.usage.cache_write_tokens).toBeGreaterThan(0);
    expect(settlement.body.usage.cache_write_tokens).toBeLessThan(150000);
    expect(settlement.body.usage.cache_write_5m_tokens + settlement.body.usage.cache_write_1h_tokens).toBe(settlement.body.usage.cache_write_tokens);
    expect(calls.some((c) => c.path === "/internal/worker0/account-event")).toBe(true);
  });

  it("marks a stream without message_stop as a partial settlement", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_partial", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    ];
    const { gateway, calls } = await fixture(events);
    const response = await gateway.fetch(chat(true));
    expect(await response.text()).toContain("partial");
    const settlement = calls.find((c) => c.path === "/internal/worker0/settle")!;
    expect(settlement.body.streamTruncated).toBe(true);
    expect(settlement.body.errorCode).toBe("upstream_stream_error");
  });
});
