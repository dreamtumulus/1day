// Capturing fake Anthropic upstream for the cc-probe gates (docs/canonical-implementation-spec-2026-11-01.md §7).
// Records every request (headers + body) that a real Claude Code binary sends to ANTHROPIC_BASE_URL, answers
// /v1/messages with a minimal valid SSE stream, and runs a CONNECT proxy that only LOGS the hosts the binary tries
// to reach outside the base URL (telemetry, bootstrap …) and refuses them — no real network is ever used.
import http from "node:http";
import { writeFileSync, appendFileSync } from "node:fs";

export async function startCapture({ answerText = "OK", jsonSchemaAnswer = null, firstToolUse = null, onFirstToolUse = null, delayFirstMessageMs = 0, port = 0, dumpFile = null } = {}) {
  const requests = [];
  const connects = [];
  const messagesCalls = () => requests.filter((r) => r.url.split("?")[0] === "/v1/messages").length;

  function respondMessages(res, body) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "request-id": `req_mock_${requests.length}` });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: `msg_mock_${requests.length}`, type: "message", role: "assistant", model: body?.model ?? "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } });
    if (firstToolUse && messagesCalls() === 1) {
      // the model "decides" to call a tool: lets the probe observe what the binary does with it
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_probe_01", name: firstToolUse.name, input: {} } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(firstToolUse.input) } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
      ev("message_stop", {});
      res.end();
      // the probe may want to kill the binary while it is executing / awaiting this tool call
      setTimeout(() => onFirstToolUse?.(), 0);
      return;
    }
    const text = jsonSchemaAnswer && body?.output_format ? JSON.stringify(jsonSchemaAnswer) : answerText;
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
    ev("message_stop", {});
    res.end();
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { _unparsed: raw.slice(0, 2000) }; }
      const headers = { ...req.headers };
      if (headers.authorization) headers.authorization = "Bearer <redacted>";
      if (headers["x-api-key"]) headers["x-api-key"] = "<redacted>";
      requests.push({ at: new Date().toISOString(), method: req.method, url: req.url, headers, body });
      if (dumpFile) { try { appendFileSync(dumpFile, JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, headers, body }) + "\n"); } catch { /* best effort */ } }
      const path = req.url.split("?")[0];
      if (req.method === "POST" && path === "/v1/messages") {
        // hold the first response so the probe can SIGKILL with a request in flight (G4 “mid-flight” case)
        if (delayFirstMessageMs > 0 && messagesCalls() === 1) setTimeout(() => respondMessages(res, body), delayFirstMessageMs);
        else respondMessages(res, body);
        return;
      }
      if (req.method === "POST" && path === "/v1/messages/count_tokens") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 12 })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  // CONNECT-logging proxy: records destination host:port, then refuses.
  const proxy = http.createServer((req, res) => { connects.push({ at: new Date().toISOString(), kind: "http", url: req.url, host: req.headers.host }); res.writeHead(502); res.end(); });
  proxy.on("connect", (req, socket) => { socket.on("error", () => {}); connects.push({ at: new Date().toISOString(), kind: "connect", target: req.url }); socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
  proxy.on("clientError", (_e, socket) => socket.destroy());
  server.on("clientError", (_e, socket) => socket.destroy());
  server.on("connection", (socket) => socket.on("error", () => {}));
  proxy.on("connection", (socket) => socket.on("error", () => {}));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    requests, connects,
    save(file) { writeFileSync(file, JSON.stringify({ requests, connects }, null, 1)); },
    async close() { await new Promise((r) => server.close(r)); await new Promise((r) => proxy.close(r)); },
  };
}
