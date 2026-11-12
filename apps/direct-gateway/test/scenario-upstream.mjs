import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.SCENARIO_PORT ?? 19100);
const output = process.env.SCENARIO_OUTPUT;
let seq = 0;

function eventsFor(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const history = JSON.stringify(messages);
  const hasResult = history.includes('"tool_result"');
  const hasDeferredCall = history.includes('"deferred_echo"');
  const usage = { input_tokens: 10, output_tokens: 1 };
  const events = [{ type: "message_start", message: { id: `msg_scenario_${seq}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }];
  if (hasDeferredCall) {
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DEFERRED_OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    );
  } else {
    const tool = hasResult ? "deferred_echo" : "ToolSearch";
    const input = hasResult ? { text: "hello from deferred MCP" } : { query: "select:deferred_echo" };
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_scenario_${seq}`, name: tool, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
    );
  }
  events.push({ type: "message_stop" });
  return events;
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
    console.log(`[scenario] #${seq} ${req.method} ${req.url} model=${body.model} tools=${(body.tools ?? []).length}`);
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 42 }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const event of eventsFor(body)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
server.listen(port, "127.0.0.1", () => console.log(`scenario-upstream on 127.0.0.1:${port}`));
