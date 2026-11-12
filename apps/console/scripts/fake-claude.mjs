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
const system = process.env.FAKE_CLAUDE_SYSTEM ?? "";
const thirdParty = `${system}\n${prompt}`.includes("fixture-third-party-refusal");
const thirdPartyPartial = `${system}\n${prompt}`.includes("fixture-third-party-partial");
if ((thirdParty || thirdPartyPartial) && process.env.FAKE_CLAUDE_MODE === "canonical") {
  const message = "API Error: 400 Third-party apps now draw from extra usage, not plan limits. Ask your workspace admin to add more and keep going.";
  line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
  if (thirdParty) line({ type: "stream_event", event: { type: "ping" } });
  if (thirdPartyPartial) line({ type: "assistant", message: { id: "msg_partial", role: "assistant", content: [{ type: "text", text: "partial answer" }], usage } });
  line({ type: "result", subtype: "error_during_execution", is_error: true, result: message, modelUsage, duration_ms: 50, duration_api_ms: 40, num_turns: 1 });
  process.exit(1);
}
// X-68: Claude Code's own (`<synthetic>`) message for a login that is gone, then an error result — nothing else.
// `fixture-login-expired-once:<nonce>` fails only the first process that sees the nonce (the retry on another account
// answers); `fixture-login-expired-always` fails every time.
const loginOnce = /fixture-login-expired-once:([\w-]+)/.exec(prompt);
let loginGone = prompt.includes("fixture-login-expired-always");
if (loginOnce) {
  const { existsSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const flag = `${tmpdir()}/fake-claude-login-${loginOnce[1]}`;
  if (!existsSync(flag)) { writeFileSync(flag, ""); loginGone = true; }
}
if (loginGone) {
  const message = "Login expired · Please run /login";
  line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
  line({ type: "assistant", message: { id: "msg_synth", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: message }] }, error: "authentication_failed" });
  line({ type: "result", subtype: "error_during_execution", is_error: true, result: message, duration_ms: 50, duration_api_ms: 0, num_turns: 1 });
  process.exit(1);
}
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
