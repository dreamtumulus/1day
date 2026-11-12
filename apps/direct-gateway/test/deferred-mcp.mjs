import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "worker0-deferred", version: "1.0.0" } } });
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: [
      { name: "deferred_echo", description: "Echo a message through the local deferred MCP service", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, defer_loading: true },
      { name: "deferred_math", description: "Add two numbers through the local deferred MCP service", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, defer_loading: true },
    ] } });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "deferred_echo") return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `MCP_OK ${args.text ?? ""}` }], isError: false } });
    if (name === "deferred_math") return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `MATH_OK ${Number(args.a) + Number(args.b)}` }], isError: false } });
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool ${name}` } });
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
