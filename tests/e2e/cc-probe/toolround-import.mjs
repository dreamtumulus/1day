// toolround-import (canonical WP3 extension, 2026-11-05) — can a canonical session that the gateway IMPORTS from a client
// history continue a TOOL ROUND (the request's live turn is the client's tool_result)?
// Fake OAuth, fake HOME, capturing 127.0.0.1 fake upstream (run-gate.mjs resume-streamjson), real 2.1.312 binary.
//   CC_PROBE_BIN=/opt/cc-probe-bin/claude-2.1.312 node tests/e2e/cc-probe/toolround-import.mjs
// Variants:
//   A   transcript ends with the assistant tool_use (dangling); stdin turn = user [tool_result]
//   A2  A with two parallel tool_use / two tool_result
//   B   transcript holds the whole round (assistant tool_use + user tool_result); stdin turn = user [text]
//   B2  B with two parallel tool_use / two tool_result
// Checks on the first captured upstream request (REQ0) and on the transcript the binary leaves after the resume.
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNativeTranscript } from "../../../apps/gateway/dist/ccr/native-session.js";
import { OUT, runGate, makeProbeHome, scrub } from "./probe-steps.mjs";

const PREFIX = [
  { role: "user", content: "TR-USER-1: list the files then read README" },
  { role: "assistant", content: [{ type: "text", text: "TR-ASSISTANT-1: listing" }, { type: "tool_use", id: "toolu_tr_01", name: "mcp__caller__Bash", input: { command: "ls" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_tr_01", content: "TR-RESULT-1: README.md src" }] },
];
const aSingle = { role: "assistant", content: [{ type: "text", text: "TR-ASSISTANT-2: reading" }, { type: "tool_use", id: "toolu_tr_02", name: "mcp__caller__Read", input: { file_path: "README.md" } }] };
const rSingle = [{ type: "tool_result", tool_use_id: "toolu_tr_02", content: "TR-RESULT-2-LIVE: # Project readme" }];
const aPar = { role: "assistant", content: [{ type: "text", text: "TR-ASSISTANT-2: reading both" }, { type: "tool_use", id: "toolu_tr_02a", name: "mcp__caller__Read", input: { file_path: "a" } }, { type: "tool_use", id: "toolu_tr_02b", name: "mcp__caller__Read", input: { file_path: "b" } }] };
const rPar = [{ type: "tool_result", tool_use_id: "toolu_tr_02a", content: "TR-RESULT-2A-LIVE" }, { type: "tool_result", tool_use_id: "toolu_tr_02b", content: "TR-RESULT-2B-LIVE" }];
const TEXT_TURN = [{ type: "text", text: "TR-CONTINUE" }];

const VARIANTS = [
  { name: "A", importMsgs: [...PREFIX, aSingle], stdin: rSingle, liveIds: ["toolu_tr_02"], liveMarks: ["TR-RESULT-2-LIVE"] },
  { name: "A2", importMsgs: [...PREFIX, aPar], stdin: rPar, liveIds: ["toolu_tr_02a", "toolu_tr_02b"], liveMarks: ["TR-RESULT-2A-LIVE", "TR-RESULT-2B-LIVE"] },
  { name: "B", importMsgs: [...PREFIX, aSingle, { role: "user", content: rSingle }], stdin: TEXT_TURN, liveIds: ["toolu_tr_02"], liveMarks: ["TR-RESULT-2-LIVE", "TR-CONTINUE"] },
  { name: "B2", importMsgs: [...PREFIX, aPar, { role: "user", content: rPar }], stdin: TEXT_TURN, liveIds: ["toolu_tr_02a", "toolu_tr_02b"], liveMarks: ["TR-RESULT-2A-LIVE", "TR-RESULT-2B-LIVE", "TR-CONTINUE"] },
];

const contentHead = (c) => (typeof c === "string" ? c : JSON.stringify(c ?? "")).slice(0, 100);

/** Anthropic Messages tool-pairing rule: every assistant tool_use is answered, in the very next user message, by exactly one tool_result. */
function validatePairing(messages) {
  const problems = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i > 0 && messages[i - 1].role === m.role) problems.push(`consecutive ${m.role} at ${i - 1},${i}`);
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const uses = m.content.filter((c) => c.type === "tool_use").map((c) => c.id);
    if (!uses.length) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "user" || !Array.isArray(next.content)) { problems.push(`tool_use ${uses.join(",")} at ${i} not followed by a user tool_result message`); continue; }
    const results = next.content.filter((c) => c.type === "tool_result").map((c) => c.tool_use_id);
    for (const u of uses) {
      const n = results.filter((r) => r === u).length;
      if (n !== 1) problems.push(`tool_use ${u}: ${n} tool_result(s) in the next message`);
    }
    for (const r of results) if (!uses.includes(r)) problems.push(`orphan tool_result ${r} at ${i + 1}`);
  }
  return problems;
}

const report = [];
for (const v of VARIANTS) {
  const { home, work, projectDir } = makeProbeHome(`cc-tr-${v.name}-`);
  const session = randomUUID();
  const lines = buildNativeTranscript(v.importMsgs, session, { cwd: work, model: "claude-sonnet-5-5" });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(projectDir, { recursive: true });
  const tfile = join(projectDir, `${session}.jsonl`);
  writeFileSync(tfile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const tag = `tr-${v.name}`;
  const res = await runGate("resume-streamjson", { CC_PROBE_HOME: home, CC_PROBE_SESSION: session, CC_PROBE_TAG: tag, CC_PROBE_STDIN_JSON: JSON.stringify(v.stdin) });
  let raw = null;
  try { raw = JSON.parse(readFileSync(join(home, `raw-capture-resume-streamjson-${tag}.json`), "utf8")); } catch { raw = null; }
  const reqs = raw?.requests ?? [];
  const msgs = reqs[0]?.body?.messages ?? [];
  const flat = [];
  for (const [i, m] of msgs.entries()) for (const c of Array.isArray(m.content) ? m.content : [{ type: "string", text: String(m.content ?? "") }]) {
    flat.push({ i, role: m.role, type: c.type, id: c.id ?? c.tool_use_id ?? null, is_error: c.is_error ?? null, head: c.type === "tool_result" ? contentHead(c.content) : String(c.text ?? c.name ?? "").slice(0, 80) });
  }
  const body = JSON.stringify(msgs);
  const perLive = v.liveIds.map((id) => {
    const rs = flat.filter((f) => f.type === "tool_result" && f.id === id);
    return { id, results: rs.length, interrupted: rs.filter((r) => /interrupt/i.test(r.head) || r.is_error === true).length, heads: rs.map((r) => r.head) };
  });
  // what did the binary persist after the resume?
  let after = [];
  try {
    after = readFileSync(tfile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((l) => ({
      type: l.type, role: l.message?.role ?? null,
      blocks: Array.isArray(l.message?.content) ? l.message.content.map((c) => c.type + (c.id ? ":" + c.id : "") + (c.tool_use_id ? ":" + c.tool_use_id : "") + (c.is_error ? ":ERR" : "") + (c.type === "tool_result" ? "=" + contentHead(c.content).slice(0, 50) : "")) : [typeof l.message?.content === "string" ? "string" : String(l.type)],
    }));
  } catch { after = []; }
  const problems = validatePairing(msgs);
  const out = {
    variant: v.name, importedLines: lines.length, exitCode: res.evidence?.exitCode ?? res.code, requests: reqs.length,
    roleSeq: msgs.map((m) => `${m.role}:${(Array.isArray(m.content) ? m.content : [{ type: "string" }]).map((c) => c.type).join("+")}`),
    toolBlocks: flat.filter((f) => f.type === "tool_use" || f.type === "tool_result"),
    perLive, liveMarksPresent: v.liveMarks.map((k) => ({ k, n: (body.match(new RegExp(k, "g")) ?? []).length })),
    pairingProblems: problems, apiValid: problems.length === 0,
    noSyntheticNoResponse: !body.includes("No response requested."),
    transcriptAfter: after, stderrTail: res.evidence?.stderrTail ?? (res.err || "").slice(-400),
  };
  out.pass = out.requests > 0 && out.apiValid && out.noSyntheticNoResponse && perLive.every((p) => p.results === 1 && p.interrupted === 0) && out.liveMarksPresent.every((m) => m.n === 1);
  report.push(out);
}
writeFileSync(join(OUT, "toolround-import.json"), scrub(JSON.stringify({ gate: "toolround-import", sampledAt: new Date().toISOString(), variants: report }, null, 1)));
for (const r of report) {
  console.log(`\n===== ${r.variant}  pass=${r.pass}  exit=${r.exitCode} requests=${r.requests} apiValid=${r.apiValid}`);
  console.log(" roleSeq:", r.roleSeq.join(" | "));
  console.log(" toolBlocks:", JSON.stringify(r.toolBlocks));
  console.log(" perLive:", JSON.stringify(r.perLive));
  console.log(" liveMarks:", JSON.stringify(r.liveMarksPresent), " noNoResponse:", r.noSyntheticNoResponse);
  if (r.pairingProblems.length) console.log(" PROBLEMS:", r.pairingProblems.join("; "));
  console.log(" transcriptAfter:", JSON.stringify(r.transcriptAfter));
  if (!r.requests) console.log(" stderr:", r.stderrTail);
}
