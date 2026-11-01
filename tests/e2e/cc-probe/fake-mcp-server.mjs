// Minimal stdio MCP server used by the cc-probe tool-interrupt gates (spec §7 G5).
// Exposes a single tool `lookup` and, by default, NEVER answers `tools/call` — the caller (Claude Code)
// is then parked awaiting a tool result, which is exactly the state we want to SIGKILL.
// Every inbound JSON-RPC message is appended (one JSON per line) to $FAKE_MCP_LOG so the probe can tell
// whether the tool was executed again after `--resume`. No network, no credentials.
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_MCP_LOG ?? "";
const logIt = (o) => { try { if (log) appendFileSync(log, JSON.stringify(o) + "\n"); } catch {} };
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    logIt({ at: Date.now(), dir: "in", method: m.method ?? null, id: m.id ?? null, tool: m.params?.name ?? null });
    handle(m);
  }
});
function handle(m) {
  const id = m.id;
  if (id === undefined) return; // notification (initialized, cancelled, …)
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "caller", version: "1.0.0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: [{ name: "lookup", description: "probe lookup (fake)", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] } });
  if (m.method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (m.method === "tools/call") {
    logIt({ at: Date.now(), dir: "in", event: "tools/call", tool: m.params?.name ?? null, parked: true });
    if (process.env.FAKE_MCP_ANSWER === "1") return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "FAKE-MCP-RESULT-OK" }], isError: false } });
    return; // park forever: the caller waits for a tool_result that never comes
  }
  return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${m.method}` } });
}
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
