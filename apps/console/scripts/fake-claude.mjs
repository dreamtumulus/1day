#!/usr/bin/env node
// Fake `claude` binary for the worker-mode e2e (docs/ccr-supply.md §8.1).
// Emits the stream-json line family on stdout, then exits 0.
//   node scripts/fake-claude.mjs -p "<prompt>" --model <m> --output-format stream-json --verbose
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.300 (Claude Code) [fake]");
  process.exit(0);
}
const prompt = args[args.indexOf("-p") + 1] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const usage = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 33725, cache_creation_input_tokens: 1200 };
const modelUsage = { "claude-sonnet-5-5": { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 33725, cacheCreationInputTokens: 1200, thinkingTokens: 0, costUSD: 0.0051, costBasis: "api", contextWindow: 200000, maxOutputTokens: 64000 } };
// Mirror the mock session API's tool simulation: the folded prompt's [tools]
// section carries the ```tool_call fence protocol.
const toolMatch = prompt.includes("fenced block tagged tool_call") ? /"name":"([^"]+)"/.exec(prompt) : null;
const safeguards = prompt.includes("fixture-safeguards-refusal");
const text = safeguards
  ? "Opus 5.5's safeguards flagged this session (https://www.anthropic.com/legal/aup). Details: [fixture]"
  : toolMatch
    ? `Calling it.\n\n\`\`\`tool_call\n{"name":"${toolMatch[1]}","input":{"city":"Paris"}}\n\`\`\``
    : "Hello from fake claude.";
line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
line({ type: "env_manager_log", level: "info", message: "sandbox provisioned" });
line({ type: "active_goal", goal: null });
line({ type: "autocompact_state", enabled: false });
const ev = (event) => line({ type: "stream_event", event });
ev({ type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { ...usage, output_tokens: 1 } } });
ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
await sleep(10);
ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
ev({ type: "content_block_stop", index: 0 });
ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
await sleep(10);
line({ type: "assistant", message: { id: "msg_fake", role: "assistant", content: [{ type: "text", text }], usage } });
line({ type: "result", subtype: "success", terminal_reason: "completed", is_error: safeguards, stop_reason: "end_turn", result: text, modelUsage, duration_ms: 50, duration_api_ms: 40, num_turns: 1 });
process.exit(0);
