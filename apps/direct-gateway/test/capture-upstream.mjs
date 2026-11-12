import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.CAPTURE_PORT ?? 19100);
const output = process.env.CAPTURE_OUTPUT;
let seq = 0;

function sseReply(res, model) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const msg = {
    id: `msg_capture_${seq}`,
    type: "message",
    role: "assistant",
    model: model || "claude-sonnet-4-5-20250929",
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  ev("message_start", { type: "message_start", message: msg });
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev("ping", { type: "ping" });
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } });
  ev("content_block_stop", { type: "content_block_stop", index: 0 });
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
  ev("message_stop", { type: "message_stop" });
  res.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const record = { seq: ++seq, ts: new Date().toISOString(), method: req.method, url: req.url, httpVersion: req.httpVersion, headers: req.rawHeaders, body };
    if (output) fs.appendFileSync(output, JSON.stringify(record) + "\n");
    console.log(`[capture] #${seq} ${req.method} ${req.url} (${body.length}B)`);
    let model;
    try { model = JSON.parse(body).model; } catch {}
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 42 }));
      return;
    }
    if (req.url?.includes("/v1/messages")) return sseReply(res, model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});

server.listen(port, "127.0.0.1", () => console.log(`capture-upstream on 127.0.0.1:${port}`));
