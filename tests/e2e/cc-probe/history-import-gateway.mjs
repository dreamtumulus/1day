// T9 (task book §6) — real-machine validation of the gateway's own history importer.
// Uses `buildNativeTranscript` from apps/gateway/dist/ccr/native-session.js (read-only import, dist is not modified)
// to turn a customer Messages history (text / tool_use / tool_result / thinking / redacted_thinking / image) into
// Claude Code transcript lines, writes them into a fresh probe HOME, then `--resume <id>` + one stdin stream-json turn
// (the node canonical continuation shape, see T7). Checks: tool pair + order fidelity, thinking never imported.
//   node tests/e2e/cc-probe/history-import-gateway.mjs
// Local only: fake OAuth, fake HOME, capturing 127.0.0.1 fake upstream, refusing CONNECT proxy.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNativeTranscript, countStrippedThinking } from "../../../apps/gateway/dist/ccr/native-session.js";
import { OUT, runGate, scrub, transcriptShape, messageShape } from "./probe-steps.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ---- the customer history we would import (mixed shapes, including what must be dropped) ----
const CUSTOMER_MESSAGES = [
  { role: "user", content: "CUST-USER-1: what is the weather in Tokyo?" },
  { role: "assistant", content: [{ type: "thinking", thinking: "CUST-THINKING-EARLY: should I call the tool", signature: "ZmFrZQ==" }, { type: "text", text: "CUST-ASSISTANT-1: let me look that up" }, { type: "tool_use", id: "toolu_cust_01", name: "mcp__caller__lookup", input: { q: "tokyo weather" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cust_01", content: "CUST-TOOL-RESULT-1: 18C cloudy" }] },
  { role: "assistant", content: [{ type: "redacted_thinking", data: "ZmFrZS1yZWRhY3RlZA==" }, { type: "text", text: "CUST-ASSISTANT-2: 18C and cloudy" }] },
  { role: "user", content: [{ type: "text", text: "CUST-USER-2: and tomorrow?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
  { role: "assistant", content: [{ type: "text", text: "CUST-ASSISTANT-3: rain" }, { type: "tool_use", id: "toolu_cust_02", name: "mcp__caller__lookup", input: { q: "tokyo tomorrow" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cust_02", content: "CUST-TOOL-RESULT-2: 12C rain", is_error: false }] },
  { role: "assistant", content: [{ type: "text", text: "CUST-ASSISTANT-4: bring an umbrella" }] },
];

const session = randomUUID();
const home = mkdtempSync(join(tmpdir(), "cc-hi-gw-"));
const cfg = join(home, "cfg"), work = join(home, "work");
mkdirSync(cfg, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-probe-fake-token", refreshToken: "sk-ant-ort01-probe-fake", expiresAt: Date.now() + 8 * 3600e3, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }), { mode: 0o600 });
writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ userID: sha("cc-probe-device").repeat(2), hasCompletedOnboarding: true, oauthAccount: { accountUuid: "9d2d1c5e-1111-4a7b-8c3d-aaaaaaaaaaaa", emailAddress: "", organizationUuid: "11111111-2222-4333-8444-555555555555", displayName: "", fullName: "", profileFetchedAt: Date.now() } }), { mode: 0o600 });
writeFileSync(join(cfg, "settings.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });

const lines = buildNativeTranscript(CUSTOMER_MESSAGES, session, { cwd: work, model: "claude-sonnet-5-5" });
const dir = join(cfg, "projects", work.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const res = await runGate("resume-streamjson", {
  CC_PROBE_HOME: home, CC_PROBE_SESSION: session, CC_PROBE_TAG: "t9",
  CC_PROBE_STDIN_TEXT: "T9-LIVE: summarize the tool results above.",
});
const ev = res.evidence;
const shape = (ev?.requests ?? []).map(messageShape);
const text = JSON.stringify(shape);
const blockOrder = (shape[0]?.messages ?? []).map((m) => `${m.role}:${m.blocks.map((b) => b.type).join("+")}`);

// tool_use ids and their tool_result partners must survive in order, each exactly once
const raw = (() => { try { return JSON.parse(readFileSync(join(home, "raw-capture-resume-streamjson-t9.json"), "utf8")); } catch { return null; } })();
const idPairs = [];
for (const m of raw?.requests?.[0]?.body?.messages ?? []) {
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c.type === "tool_use") idPairs.push({ kind: "use", id: c.id });
    if (c.type === "tool_result") idPairs.push({ kind: "result", id: c.tool_use_id });
    if (c.type === "thinking" || c.type === "redacted_thinking") idPairs.push({ kind: c.type, id: null });
  }
}
const out = {
  gate: "history-import-gateway", task: "T9", sampledAt: new Date().toISOString(),
  importer: "apps/gateway/dist/ccr/native-session.js#buildNativeTranscript",
  customerMessages: CUSTOMER_MESSAGES.length,
  strippedThinking: countStrippedThinking(CUSTOMER_MESSAGES),
  transcript: { file: `resume-streamjson-t9.json`, lines: lines.length, shape: transcriptShape(lines), digest: sha(lines.map((l) => JSON.stringify({ t: l.type, r: l.message?.role, b: (Array.isArray(l.message?.content) ? l.message.content : []).map((c) => c.type + (c.id ? ":" + c.id : "") + (c.tool_use_id ? ":" + c.tool_use_id : "")) })).join("\n")) },
  resumed: {
    file: "resume-streamjson-t9.json", exitCode: ev?.exitCode ?? null, initSessionId: ev?.init?.sessionId ?? null,
    sessionIdMatches: ev?.init?.sessionId === session, requests: ev?.requests?.length ?? 0,
    blockOrder, upstreamToolPairs: idPairs, stderrTail: ev?.stderrTail ?? null,
  },
  checks: {
    requestSent: (ev?.requests?.length ?? 0) > 0,
    allCustomerTurnsPresent: ["CUST-USER-1", "CUST-ASSISTANT-1", "CUST-TOOL-RESULT-1", "CUST-ASSISTANT-2", "CUST-USER-2", "CUST-ASSISTANT-3", "CUST-TOOL-RESULT-2", "CUST-ASSISTANT-4"].every((k) => text.includes(k)),
    liveTurnPresent: text.includes("T9-LIVE"),
    toolPairsInOrder: idPairs.map((p) => p.kind).join(",") === "use,result,use,result",
    toolIdsPaired: idPairs.filter((p) => p.kind === "use").map((p) => p.id).join(",") === idPairs.filter((p) => p.kind === "result").map((p) => p.id).join(","),
    noThinkingUpstream: !idPairs.some((p) => p.kind === "thinking" || p.kind === "redacted_thinking") && !text.includes("CUST-THINKING"),
    noDuplicateHistory: (text.match(/CUST-USER-1/g) ?? []).length === 1,
    noSyntheticNoResponse: !text.includes("No response requested."),
    sessionIdMatch: ev?.init?.sessionId === session,
  },
};
out.checks.pass = Object.values(out.checks).every(Boolean);
out.digest = ev?.digest ?? null;
writeFileSync(join(OUT, "history-import-gateway.json"), scrub(JSON.stringify(out, null, 1)));
console.log(JSON.stringify({ task: "T9", pass: out.checks.pass, checks: out.checks, blockOrder, upstreamToolPairs: idPairs, transcriptLines: lines.length, strippedThinking: out.strippedThinking, exitCode: ev?.exitCode ?? null, stderrTail: ev?.stderrTail ?? null }, null, 1));
if (!out.checks.pass) process.exitCode = 1;
