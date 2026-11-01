// G3 (spec §7) — can an *externally constructed* Claude Code native transcript be imported by `--resume`?
// Builds a temp HOME with the same fake OAuth/CLAUDE_CONFIG_DIR the other gates use, writes a hand-made
// `projects/<cwd-hash>/<session>.jsonl` (the format CC itself writes; sample taken from this probe's own temp
// HOME, never from a node), then runs run-gate.mjs `resume` against it and reports what reached the fake upstream.
//   node tests/e2e/cc-probe/history-import.mjs [case …]
// Writes docs/evidence/cc-2.1.312/history-import-<case>.json + G3-matrix.md. No network, no real credentials.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve("docs/evidence/cc-2.1.312");
const VERSION = "2.1.312";
const now = () => new Date().toISOString();
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const FAKE_SIGNATURE = "ZmFrZS1zaWduYXR1cmUtZm9yLXByb2JlLW9ubHk="; // base64 of "fake-signature-for-probe-only"

// ---- transcript line builders (shape mirrors what 2.1.312 itself wrote in this probe's temp HOME) ----
function line(session, cwd, uuid, parentUuid, type, message, extra = {}) {
  return { parentUuid, isSidechain: false, type, message, uuid, timestamp: now(), userType: "external", entrypoint: "sdk-cli", cwd, sessionId: session, version: VERSION, gitBranch: "", ...extra };
}
const userText = (s, cwd, u, p, text) => line(s, cwd, u, p, "user", { role: "user", content: text }, { promptId: randomUUID(), permissionMode: "default", promptSource: "sdk", turnOrigin: "sdk" });
const userBlocks = (s, cwd, u, p, content) => line(s, cwd, u, p, "user", { role: "user", content }, { promptId: randomUUID(), permissionMode: "default", promptSource: "sdk", turnOrigin: "sdk" });
const assistant = (s, cwd, u, p, content, stop = "end_turn") => line(s, cwd, u, p, "assistant", { id: `msg_imported_${u.slice(0, 8)}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });

const CASES = {
  // 1) plain user text only
  "user": (s, cwd) => { const a = randomUUID(), b = randomUUID(); return [userText(s, cwd, a, null, "IMPORTED-USER-1: what is 2+2?"), assistant(s, cwd, b, a, [{ type: "text", text: "IMPORTED-ASSISTANT-1: 4" }])]; },
  // 2) assistant text turn in the middle of the history
  "assistant-text": (s, cwd) => { const u = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]; return [userText(s, cwd, u[0], null, "IMPORTED-USER-1: hello"), assistant(s, cwd, u[1], u[0], [{ type: "text", text: "IMPORTED-ASSISTANT-TEXT-7c1: hi there" }]), userText(s, cwd, u[2], u[1], "IMPORTED-USER-2: again"), assistant(s, cwd, u[3], u[2], [{ type: "text", text: "IMPORTED-ASSISTANT-2: ok" }])]; },
  // 3) assistant tool_use + user tool_result pair
  "tool-use": (s, cwd) => {
    const u = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    return [userText(s, cwd, u[0], null, "IMPORTED-USER-1: look it up"), assistant(s, cwd, u[1], u[0], [{ type: "tool_use", id: "toolu_imported_01", name: "mcp__caller__lookup", input: { q: "imported" } }], "tool_use"), userBlocks(s, cwd, u[2], u[1], [{ type: "tool_result", tool_use_id: "toolu_imported_01", content: "IMPORTED-TOOL-RESULT-OK", is_error: false }]), assistant(s, cwd, u[3], u[2], [{ type: "text", text: "IMPORTED-ASSISTANT-2: got it" }])];
  },
  // 4) thinking block with a signature, on the LAST assistant turn
  "thinking-last": (s, cwd) => {
    const u = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    return [userText(s, cwd, u[0], null, "IMPORTED-USER-1: think about it"), assistant(s, cwd, u[1], u[0], [{ type: "thinking", thinking: "IMPORTED-THINKING-LAST: 2+2=4", signature: FAKE_SIGNATURE }, { type: "text", text: "IMPORTED-ASSISTANT-1: 4" }]), userText(s, cwd, u[2], u[1], "IMPORTED-USER-2: and 3+3?"), assistant(s, cwd, u[3], u[2], [{ type: "thinking", thinking: "IMPORTED-THINKING-2: 6", signature: FAKE_SIGNATURE }, { type: "text", text: "IMPORTED-ASSISTANT-2: 6" }])];
  },
  // 5) thinking block on an EARLIER assistant turn (most APIs drop these)
  "thinking-earlier": (s, cwd) => {
    const u = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    return [userText(s, cwd, u[0], null, "IMPORTED-USER-1: think about it"), assistant(s, cwd, u[1], u[0], [{ type: "thinking", thinking: "IMPORTED-THINKING-EARLY: hidden reasoning", signature: FAKE_SIGNATURE }, { type: "text", text: "IMPORTED-ASSISTANT-1: 4" }]), userText(s, cwd, u[2], u[1], "IMPORTED-USER-2: and 3+3?"), assistant(s, cwd, u[3], u[2], [{ type: "text", text: "IMPORTED-ASSISTANT-2: 6" }]), userText(s, cwd, u[4], u[3], "IMPORTED-USER-3: thanks"), assistant(s, cwd, u[5], u[4], [{ type: "text", text: "IMPORTED-ASSISTANT-3: ok" }])];
  },
  // 4b) thinking block with NO signature at all
  "thinking-nosig": (s, cwd) => {
    const u = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    return [userText(s, cwd, u[0], null, "IMPORTED-USER-1: think"), assistant(s, cwd, u[1], u[0], [{ type: "thinking", thinking: "IMPORTED-THINKING-NOSIG: reasoning" }, { type: "text", text: "IMPORTED-ASSISTANT-1: ok" }]), userText(s, cwd, u[2], u[1], "IMPORTED-USER-2: more"), assistant(s, cwd, u[3], u[2], [{ type: "text", text: "IMPORTED-ASSISTANT-2: ok" }])];
  },
  // 4c) thinking block with a garbage (non-base64) signature
  "thinking-badsig": (s, cwd) => {
    const u = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    return [userText(s, cwd, u[0], null, "IMPORTED-USER-1: think"), assistant(s, cwd, u[1], u[0], [{ type: "thinking", thinking: "IMPORTED-THINKING-BADSIG: reasoning", signature: "!!!not-a-signature!!!" }, { type: "text", text: "IMPORTED-ASSISTANT-1: ok" }]), userText(s, cwd, u[2], u[1], "IMPORTED-USER-2: more"), assistant(s, cwd, u[3], u[2], [{ type: "text", text: "IMPORTED-ASSISTANT-2: ok" }])];
  },
  // 6) all five classes in one transcript (the matrix "combined" case)
  "combined": (s, cwd) => {
    const u = Array.from({ length: 8 }, () => randomUUID());
    return [
      userText(s, cwd, u[0], null, "IMPORTED-USER-A: hello"),
      assistant(s, cwd, u[1], u[0], [{ type: "thinking", thinking: "IMPORTED-THINKING-EARLY: reasoning", signature: FAKE_SIGNATURE }, { type: "text", text: "IMPORTED-ASSISTANT-A: hi" }]),
      userText(s, cwd, u[2], u[1], "IMPORTED-USER-B: look it up"),
      assistant(s, cwd, u[3], u[2], [{ type: "tool_use", id: "toolu_imported_02", name: "mcp__caller__lookup", input: { q: "imported-2" } }], "tool_use"),
      userBlocks(s, cwd, u[4], u[3], [{ type: "tool_result", tool_use_id: "toolu_imported_02", content: "IMPORTED-TOOL-RESULT-OK", is_error: false }]),
      assistant(s, cwd, u[5], u[4], [{ type: "text", text: "IMPORTED-ASSISTANT-B: found it" }]),
      userText(s, cwd, u[6], u[5], "IMPORTED-USER-C: one more"),
      assistant(s, cwd, u[7], u[6], [{ type: "thinking", thinking: "IMPORTED-THINKING-LAST: final reasoning", signature: FAKE_SIGNATURE }, { type: "text", text: "IMPORTED-ASSISTANT-C: done" }]),
    ];
  },
};

function makeHome(session, cwd, lines) {
  const home = mkdtempSync(join(tmpdir(), "cc-hi-"));
  const cfg = join(home, "cfg"); const work = join(home, "work");
  mkdirSync(cfg, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
  writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-probe-fake-token", refreshToken: "sk-ant-ort01-probe-fake", expiresAt: Date.now() + 8 * 3600e3, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }), { mode: 0o600 });
  writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ userID: sha("cc-probe-device").repeat(2), hasCompletedOnboarding: true, oauthAccount: { accountUuid: "9d2d1c5e-1111-4a7b-8c3d-aaaaaaaaaaaa", emailAddress: "", organizationUuid: "11111111-2222-4333-8444-555555555555", displayName: "", fullName: "", profileFetchedAt: Date.now() } }), { mode: 0o600 });
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  const dir = join(cfg, "projects", work.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { home, cwd: work, transcript: join(dir, `${session}.jsonl`) };
}

const want = process.argv.slice(2);
const cases = (want.length ? want : Object.keys(CASES));
const results = {};
for (const name of cases) {
  const session = randomUUID();
  const probe = makeHome(session, null, []); // create dirs first
  const cwd = probe.cwd;
  const lines = CASES[name](session, cwd);
  writeFileSync(probe.transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const tag = `g3-${name}`;
  const res = await new Promise((r) => {
    const p = spawn(process.execPath, ["tests/e2e/cc-probe/run-gate.mjs", "resume"], {
      env: { ...process.env, CC_PROBE_HOME: probe.home, CC_PROBE_SESSION: session, CC_PROBE_TAG: tag, CC_PROBE_PROMPT: "LIVE-QUESTION: summarize the history above." },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString())); p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => r({ code, out, err }));
  });
  // run-gate writes <gate>-<tag>.json; keep the task-book name history-import-<case>.json
  const evFile = join(OUT, `resume-${tag}.json`);
  const ev = JSON.parse(readFileSync(evFile, "utf8"));
  writeFileSync(join(OUT, `history-import-${name}.json`), JSON.stringify({ case: name, transcriptLines: lines.length, transcriptBlockTypes: lines.map((l) => (Array.isArray(l.message.content) ? l.message.content.map((c) => c.type).join("+") : "text")), resumed: ev }, null, 1));
  const req = ev.requests?.[0];
  const msgs = (req?.messages ?? []).map((m) => ({ role: m.role, blocks: m.blocks.map((b) => ({ type: b.type, len: b.len, head: b.head, is_error: b.is_error ?? null })) }));
  const flat = JSON.stringify(msgs);
  // the redacted evidence keeps only structure, so fidelity of thinking/thinking_signature is checked on the
  // raw capture inside the probe HOME (also structure-only: lengths + digest + "is it our exact signature")
  const raw = JSON.parse(readFileSync(join(probe.home, `raw-capture-resume-${tag}.json`), "utf8"));
  const thinkingBlocks = [];
  const toolUseIds = [];
  for (const m of raw.requests?.[0]?.body?.messages ?? []) {
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c.type === "thinking") thinkingBlocks.push({ role: m.role, thinkingLen: String(c.thinking ?? "").length, sigLen: String(c.signature ?? "").length, sigIsFake: c.signature === FAKE_SIGNATURE, sigDigest: sha(String(c.signature ?? "")), hasSig: "signature" in c });
      if (c.type === "tool_use") toolUseIds.push(c.id);
      if (c.type === "tool_result") toolUseIds.push(c.tool_use_id);
    }
  }
  results[name] = {
    exitCode: ev.exitCode, transcriptLines: lines.length, initSessionId: ev.init?.sessionId ?? null,
    upstreamMessages: msgs.length,
    imported: {
      userText: flat.includes("IMPORTED-USER"),
      assistantText: flat.includes("IMPORTED-ASSISTANT"),
      toolUse: flat.includes("tool_use"),
      toolResult: flat.includes("tool_result"),
      thinking: flat.includes("thinking"),
      signatureForwarded: thinkingBlocks.some((t) => t.sigIsFake),
      syntheticAssistant: flat.includes("No response requested."),
      interruptedToolResult: flat.includes("Tool call interrupted"),
    },
    roles: msgs.map((m) => m.role + ":" + m.blocks.map((b) => b.type).join("+")),
    thinkingBlocks, toolUseLinks: toolUseIds,
    digest: ev.digest, stderrTail: ev.stderrTail,
  };
  console.log(name, JSON.stringify(results[name]));
}
writeFileSync(join(OUT, "history-import-summary.json"), JSON.stringify(results, null, 1));
