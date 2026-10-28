// Fake `claude` binary for cc_worker tests (runs under bun/node as
// `<runtime> fake-claude.mjs ...`). Prints the stream-json line family the
// real binary emits (docs/ccr-supply.md §8.1). Modes via FAKE_CLAUDE_MODE:
//   ok (default) | slow (300ms pause mid-stream) | fail (stderr + exit 1) | hang
// With `--input-format stream-json` it is bidirectional: one user message per
// stdin line, one answer per message, alive until stdin closes (persistent
// sessions, docs/worker-sessions.md).
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.300 (Claude Code) [fake]");
  process.exit(0);
}
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (mode === "fail") {
  console.error("fake: authentication_error: invalid session credentials");
  process.exit(1);
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  // Real `claude -p` takes the prompt as a positional or, when absent, from stdin (what the node does).
  const positional = args[args.indexOf("-p") + 1];
  const streamJsonInput = args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json";
  const line = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const usage = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 33725, cache_creation_input_tokens: 1200 };
  const modelUsage = { "claude-sonnet-5-5": { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 33725, cacheCreationInputTokens: 1200, thinkingTokens: 0, costUSD: 0.0051, costBasis: "api", contextWindow: 200000, maxOutputTokens: 64000 } };
  const ev = (event) => line({ type: "stream_event", event });
  let initDone = false;
  let turns = 0;
  const respond = async (prompt, images) => {
    turns += 1;
    if (!initDone) {
      initDone = true;
      line({
        type: "system",
        subtype: "init",
        model: "claude-sonnet-5-5",
        https_proxy: process.env.HTTPS_PROXY ?? null,
        prompt_chars: prompt.length,
        input_format: streamJsonInput ? "stream-json" : "text",
        images,
        cwd: process.cwd(),
        home: process.env.HOME ?? null,
        argv: args.filter((a) => a.startsWith("--")),
        systemPrompt: args.includes("--system-prompt-file") ? fs.readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8") : null,
      });
      line({ type: "env_manager_log", level: "info", message: "sandbox provisioned" });
      line({ type: "active_goal", goal: null });
      line({ type: "autocompact_state", enabled: false });
    }
    let text = turns === 1 ? "Hello from fake claude." : `Turn ${turns} reply.`;
    const id = `msg_fake_${turns}`;
    // Native tool round trip (docs/worker-sessions.md §3): a prompt "[TOOL]<name> <json>" makes the fake
    // emit a tool_use for mcp__caller__<name>, call the MCP server from --mcp-config, and answer with the result.
    const toolReq = /\[TOOL\](\S+)\s+(\{.*\})/.exec(prompt);
    const mcpIdx = args.indexOf("--mcp-config");
    if (toolReq && mcpIdx >= 0) {
      const cfg = JSON.parse(fs.readFileSync(args[mcpIdx + 1], "utf8"));
      const url = cfg.mcpServers.caller.url;
      const input = JSON.parse(toolReq[2]);
      const toolId = `toolu_fake_${turns}`;
      ev({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { ...usage, output_tokens: 1 } } });
      ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: `mcp__caller__${toolReq[1]}`, input: {} } });
      ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      ev({ type: "content_block_stop", index: 0 });
      ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } });
      line({ type: "assistant", message: { id, role: "assistant", content: [{ type: "tool_use", id: toolId, name: `mcp__caller__${toolReq[1]}`, input }], usage } });
      const rpc = async (method, params, rid) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) })).json();
      await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake", version: "0" } }, 1);
      const list = await rpc("tools/list", {}, 2);
      if (!list.result.tools.some((t) => t.name === toolReq[1])) throw new Error("tool not listed");
      const call = await rpc("tools/call", { name: toolReq[1], arguments: input }, 3); // parks until the client's tool_result arrives
      text = `Tool said: ${call.result.content.map((c) => c.text).join("")}`;
      const id2 = `${id}_b`;
      ev({ type: "message_start", message: { id: id2, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { ...usage, output_tokens: 1 } } });
      ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      ev({ type: "content_block_stop", index: 0 });
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
      line({ type: "assistant", message: { id: id2, role: "assistant", content: [{ type: "text", text }], usage } });
      line({ type: "result", subtype: "success", terminal_reason: "completed", is_error: false, stop_reason: "end_turn", result: text, modelUsage, duration_ms: 50, duration_api_ms: 40, num_turns: turns });
      return;
    }
    ev({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { ...usage, output_tokens: 1 } } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    if (mode === "slow") await new Promise((r) => setTimeout(r, 300));
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
    line({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }], usage } });
    line({ type: "result", subtype: "success", terminal_reason: "completed", is_error: false, stop_reason: "end_turn", result: text, modelUsage, duration_ms: 50, duration_api_ms: 40, num_turns: turns });
  };
  if (streamJsonInput) {
    const rl = (await import("node:readline")).createInterface({ input: process.stdin });
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      let prompt = "";
      let images = 0;
      try {
        const msg = JSON.parse(raw);
        const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : [];
        images = blocks.filter((b) => b?.type === "image").length;
        prompt = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
      } catch {
        prompt = "";
      }
      await respond(prompt, images);
    }
    process.exit(0);
  } else {
    let prompt = positional && !positional.startsWith("-") ? positional : "";
    if (!prompt) {
      try {
        prompt = fs.readFileSync(0, "utf8");
      } catch {
        prompt = "";
      }
    }
    await respond(prompt, 0);
    process.exit(0);
  }
}
