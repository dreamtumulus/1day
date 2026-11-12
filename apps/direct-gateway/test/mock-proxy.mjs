import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.MOCK_PROXY_PORT ?? 19101);
const output = process.env.MOCK_PROXY_OUTPUT;
let seq = 0;

function eventsFor(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result"));
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const tool = !hasToolResult && tools.find((item) => String(item.name).toLowerCase() === "bash");
  const usage = { input_tokens: 10, output_tokens: 1 };
  const events = [{ type: "message_start", message: { id: `msg_mock_${seq}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }];
  if (tool) {
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_mock_1", name: tool.name, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "pwd" }) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
    );
  } else {
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: hasToolResult ? "TOOL_OK" : "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    );
  }
  events.push({ type: "message_stop" });
  return events;
}

function messageFor(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasToolResult = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result"));
  return {
    id: `msg_mock_${seq}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [{ type: "text", text: hasToolResult ? "TOOL_OK" : "OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = JSON.parse(text); } catch {}
    const record = { seq: ++seq, method: req.method, url: req.url, headers: req.rawHeaders, body: text };
    if (output) fs.appendFileSync(output, JSON.stringify(record) + "\n");
    console.log(`[mock-proxy] #${seq} ${req.method} ${req.url} (${text.length}B)`);
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 42 }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const event of eventsFor(body)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(messageFor(body)));
  });
});
server.on("connect", (req, client) => {
  if (output) fs.appendFileSync(output, JSON.stringify({ connect: req.url }) + "\n");
  console.log(`[mock-proxy] CONNECT ${req.url}`);
  client.on("error", () => {});
  client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  client.end();
});
server.on("clientError", (_error, socket) => socket.destroy());
server.listen(port, "127.0.0.1", () => console.log(`mock-proxy on 127.0.0.1:${port}`));
