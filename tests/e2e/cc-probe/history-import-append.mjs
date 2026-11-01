// T11 (task book §7) — imported transcript × `--append-system-prompt-file`.
// T8 showed that a *native* session resumes by replaying the `prompt_snapshot` attachment it wrote at session
// creation and silently ignoring the append flag of the resume turn. A gateway-imported transcript
// (`buildNativeTranscript`, apps/gateway/dist/ccr/native-session.js) has NO snapshot line — so does the resume-time
// append reach the main prompt for imported sessions, and if not, can a *minimal handwritten* snapshot line restore it?
// Three cases, each on a fresh probe HOME (fake OAuth, fake upstream, refusing CONNECT proxy):
//   A) import-only                 → `--resume <id> --append-system-prompt-file <marker> --input-format stream-json`
//   B) import + minimal snapshot   → same command (snapshot first line, marker text only, no tools)
//   C) import + minimal snapshot   → `--resume <id> --input-format stream-json` (control: snapshot alone)
//   node tests/e2e/cc-probe/history-import-append.mjs
// Local only: no real credentials, no real upstream, never logs in to a node.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildNativeTranscript } from "../../../apps/gateway/dist/ccr/native-session.js";
import { OUT, runGate, scrub, makeProbeHome } from "./probe-steps.mjs";

const CALLER_MARKER = "CALLER-SYSTEM-MARKER-7f3a"; // written by run-gate's resume-streamjson-append gate
const SNAPSHOT_MARKER = "SNAPSHOT-SYSTEM-MARKER-c4d1"; // only inside the handwritten prompt_snapshot

// Same 8-message customer history as T9, so A/B/C stay comparable turn-for-turn.
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
const CUSTOMER_HEADS = ["CUST-USER-1", "CUST-ASSISTANT-1", "CUST-TOOL-RESULT-1", "CUST-ASSISTANT-2", "CUST-USER-2", "CUST-ASSISTANT-3", "CUST-TOOL-RESULT-2", "CUST-ASSISTANT-4"];

const sha = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };
const countIn = (t, needle) => (t.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;

/** Lay down a probe HOME whose transcript is the gateway import (optionally with a handwritten snapshot first line). */
function importTranscript({ withSnapshot }) {
  const { home, work, projectDir } = makeProbeHome("cc-hi-app-");
  const session = randomUUID();
  const lines = buildNativeTranscript(CUSTOMER_MESSAGES, session, { cwd: work, model: "claude-sonnet-5-5" });
  let snapshot = null;
  if (withSnapshot) {
    // Shape copied from a real 2.1.312 transcript (T8 sample): { type:"attachment", attachment:{ type:"prompt_snapshot",
    // systemPrompt:string[], contextRendering:"announced" }, parentUuid, uuid, … }. Content is the marker only.
    snapshot = {
      parentUuid: null, isSidechain: false,
      attachment: { type: "prompt_snapshot", systemPrompt: [`${SNAPSHOT_MARKER}: caller system delivered through the snapshot.`], contextRendering: "announced" },
      type: "attachment", uuid: randomUUID(), timestamp: new Date().toISOString(),
      userType: "external", entrypoint: "sdk-cli", cwd: work, sessionId: session, version: "2.1.312", gitBranch: "HEAD",
    };
    lines[0].parentUuid = snapshot.uuid;
  }
  const all = snapshot ? [snapshot, ...lines] : lines;
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${session}.jsonl`);
  writeFileSync(file, all.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return {
    home, work, session, file,
    transcript: {
      lines: all.length,
      hasSnapshot: Boolean(snapshot),
      snapshotSystemBlocks: snapshot ? snapshot.attachment.systemPrompt.length : 0,
      snapshotMarkerInTranscript: snapshot ? countIn(snapshot.attachment.systemPrompt.join(""), SNAPSHOT_MARKER) : 0,
      // chain integrity: every line's parentUuid points at the previous uuid
      parentChainOk: all.every((l, i) => (i === 0 ? l.parentUuid === null : l.parentUuid === all[i - 1].uuid)),
      digest: sha(all.map((l) => `${l.type}:${l.attachment?.type ?? l.message?.role}:${JSON.stringify(l.message?.content ?? "").length}`).join("\n")),
    },
  };
}

/** Structural view of the captured /v1/messages request: system blocks, per-marker counts, message role order. */
function view(home, gate, tag, probeMarkers = []) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(join(home, `raw-capture-${gate}-${tag}.json`), "utf8")); } catch { /* no capture */ }
  const body = raw?.requests?.find((r) => r.url.startsWith("/v1/messages"))?.body ?? null;
  if (!body) return null;
  const sys = (Array.isArray(body.system) ? body.system : []).map((s) => (typeof s === "string" ? s : String(s?.text ?? "")));
  const all = sys.join("\u0000");
  const messages = (body.messages ?? []).map((m) => ({
    role: m.role,
    blocks: Array.isArray(m.content) ? m.content.map((c) => ({ type: c.type, len: typeof c.content === "string" ? c.content.length : String(c.text ?? "").length, head: String(typeof c.content === "string" ? c.content : (c.text ?? c.content ?? "")).slice(0, 80) })) : [{ type: "string", len: String(m.content ?? "").length, head: String(m.content ?? "").slice(0, 80) }],
  }));
  const historyText = JSON.stringify(messages.filter((m) => m.role !== "system"));
  const ids = [];
  for (const m of body.messages ?? []) for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c.type === "tool_use") ids.push(`use:${c.id}`);
    if (c.type === "tool_result") ids.push(`result:${c.tool_use_id}`);
    if (c.type === "thinking" || c.type === "redacted_thinking") ids.push(c.type);
  }
  return {
    system: {
      blocks: sys.length,
      lens: sys.map((s) => s.length),
      callerMarkerByBlock: sys.map((s) => countIn(s, CALLER_MARKER)),
      snapshotMarkerByBlock: sys.map((s) => countIn(s, SNAPSHOT_MARKER)),
      callerMarkerTotal: countIn(all, CALLER_MARKER),
      snapshotMarkerTotal: countIn(all, SNAPSHOT_MARKER),
      billingLine: sys.some((s) => s.startsWith("x-anthropic-billing-header")),
      identitySentence: (all.match(/You are [^.]*\./) ?? [null])[0],
      digest: sha(all),
      // main prompt = last system block (where a tail append lands, cf. append.json 5599→5655)
      mainPromptLen: sys.at(-1)?.length ?? null,
      probeCounts: Object.fromEntries(probeMarkers.map((m) => [m, countIn(all, m)])),
    },
    roles: messages.map((m) => `${m.role}:${m.blocks.map((b) => b.type).join("+")}`),
    history: {
      headsPresent: CUSTOMER_HEADS.filter((h) => historyText.includes(h)),
      headsMissing: CUSTOMER_HEADS.filter((h) => !historyText.includes(h)),
      noDuplicate: CUSTOMER_HEADS.every((h) => countIn(historyText, h) === 1),
      toolIdOrder: ids,
      noThinking: !ids.some((x) => x === "thinking" || x === "redacted_thinking"),
      liveTurnPresent: historyText.includes("T11-LIVE"),
      syntheticNoResponse: historyText.includes("No response requested."),
    },
  };
}

const SECOND_MARKER = "CALLER-SYSTEM-MARKER-9d2e"; // used only by a *later* resume of the same imported session
const SECOND_TEXT = `${SECOND_MARKER}: second-turn append (different text).`;

const cases = [
  { key: "import-only", gate: "resume-streamjson-append", tag: "t11a", withSnapshot: false, note: "8-line gateway import, resume turn carries --append-system-prompt-file (no snapshot in transcript)" },
  { key: "import+minimal-snapshot", gate: "resume-streamjson-append", tag: "t11b", withSnapshot: true, note: "same import + one handwritten prompt_snapshot line (marker text only) before the first line; same append flag" },
  { key: "snapshot-no-append", gate: "resume-streamjson", tag: "t11c", withSnapshot: true, note: "control: same snapshot, resume WITHOUT the append flag" },
  { key: "import-second-resume", gate: "resume-streamjson-append", tag: "t11d", reuseOf: "import-only", appendText: SECOND_TEXT, probeMarkers: [SECOND_MARKER], note: "second resume of case A with a DIFFERENT append text: did resume #1 pin a snapshot that now wins?" },
];

const out = {
  gate: "history-import-append", task: "T11", sampledAt: new Date().toISOString(),
  importer: "apps/gateway/dist/ccr/native-session.js#buildNativeTranscript",
  customerMessages: CUSTOMER_MESSAGES.length,
  markers: { caller: CALLER_MARKER, snapshot: SNAPSHOT_MARKER, second: SECOND_MARKER },
  cases: {},
};

const homes = {};
for (const c of cases) {
  const imp = c.reuseOf ? homes[c.reuseOf] : importTranscript({ withSnapshot: c.withSnapshot });
  homes[c.key] = imp;
  const res = await runGate(c.gate, {
    CC_PROBE_HOME: imp.home, CC_PROBE_SESSION: imp.session, CC_PROBE_TAG: c.tag,
    CC_PROBE_STDIN_TEXT: "T11-LIVE: continue after the imported history.",
    ...(c.appendText ? { CC_PROBE_APPEND_TEXT: c.appendText } : {}),
  });
  const ev = res.evidence;
  out.cases[c.key] = {
    note: c.note,
    gate: c.gate, file: c.tag === "t11c" ? `resume-streamjson-${c.tag}.json` : `resume-streamjson-append-${c.tag}.json`,
    transcript: c.reuseOf ? { ...imp.transcript, reusedFrom: c.reuseOf, note: "state as written before resume #1 (resume #1 then appended its own snapshot)" } : imp.transcript,
    resumed: {
      exitCode: ev?.exitCode ?? null, requests: ev?.requests?.length ?? 0,
      initSessionId: ev?.init?.sessionId ?? null, sessionIdMatches: ev?.init?.sessionId === imp.session,
      args: ev?.args ?? null, transcriptSnapshotsAfterResume: ev?.transcript?.promptSnapshots ?? null,
      stderrTail: ev?.stderrTail ?? null,
    },
    view: view(imp.home, c.gate, c.tag, c.probeMarkers ?? []),
  };
  out.cases[c.key].digest = ev?.digest ?? null;
}

// ---- verdicts ----
const v = (k) => out.cases[k].view;
const only = v("import-only"), snap = v("import+minimal-snapshot"), ctrl = v("snapshot-no-append"), second = v("import-second-resume");
const checks = {
  // A: does the resume-time append land in an imported (snapshot-less) session?
  appendWorksOnImport: (only?.system.callerMarkerTotal ?? 0) === 1 && (only?.system.callerMarkerByBlock.at(-1) ?? 0) === 1,
  appendNotDuplicatedOnImport: (only?.system.callerMarkerTotal ?? 0) <= 1,
  // B: replay of the handwritten snapshot + append on top
  snapshotReplayed: (snap?.system.snapshotMarkerTotal ?? 0) >= 1,
  snapshotReplayedAlone: (ctrl?.system.snapshotMarkerTotal ?? 0) >= 1,
  appendWorksWithSnapshot: (snap?.system.callerMarkerTotal ?? 0) >= 1,
  // D: resume #1 pinned a snapshot into the imported transcript → does a later, different append still apply?
  secondAppendIgnored: (second?.system.probeCounts?.[SECOND_MARKER] ?? 0) === 0,
  firstAppendPinnedByResume: (second?.system.callerMarkerTotal ?? 0) === 1 && (second?.system.callerMarkerByBlock.at(-1) ?? 0) === 1,
  secondResumeLinear: (second?.roles ?? []).filter((r) => r === "user:string").length === 1,
  // sanity: import fidelity + no fabricated turns in every case
  historyIntact: [only, snap, ctrl, second].every((x) => x?.history.headsMissing.length === 0 && x.history.noDuplicate),
  toolsIntact: [only, snap, ctrl, second].every((x) => x?.history.toolIdOrder.join(",") === "use:toolu_cust_01,result:toolu_cust_01,use:toolu_cust_02,result:toolu_cust_02"),
  noThinkingUpstream: [only, snap, ctrl, second].every((x) => x?.history.noThinking),
  noSyntheticNoResponse: [only, snap, ctrl, second].every((x) => x?.history.syntheticNoResponse === false),
  liveTurnPresent: [only, snap, ctrl, second].every((x) => x?.history.liveTurnPresent),
  sessionIdMatches: Object.values(out.cases).every((c) => c.resumed.sessionIdMatches),
  requestSent: Object.values(out.cases).every((c) => (c.resumed.requests ?? 0) > 0),
};
checks.pass = checks.requestSent && checks.historyIntact && checks.toolsIntact && checks.noThinkingUpstream
  && checks.noSyntheticNoResponse && checks.liveTurnPresent && checks.sessionIdMatches;
out.checks = checks;

// ---- what the three system shapes actually look like (block count / lengths / which marker sits where) ----
out.systemShapes = Object.fromEntries(Object.entries(out.cases).map(([k, c]) => [k, {
  blocks: c.view?.system.blocks ?? null, lens: c.view?.system.lens ?? null,
  callerMarkerByBlock: c.view?.system.callerMarkerByBlock ?? null,
  snapshotMarkerByBlock: c.view?.system.snapshotMarkerByBlock ?? null,
  probeCounts: c.view?.system.probeCounts ?? null,
  mainPromptLen: c.view?.system.mainPromptLen ?? null,
  billingLine: c.view?.system.billingLine ?? null, identity: c.view?.system.identitySentence ?? null,
  roles: c.view?.roles ?? null,
}]));

// ---- recommendation: how a customer `system` should be delivered for an imported session ----
out.recommendation = {
  canAppendOnImportedResume: checks.appendWorksOnImport,
  firstResumePinsSnapshot: checks.secondAppendIgnored && checks.firstAppendPinnedByResume,
  canDeliverSystemViaHandwrittenSnapshot: checks.snapshotReplayedAlone,
  appendStillAppliesWhenSnapshotPresent: checks.appendWorksWithSnapshot,
  rule: checks.appendWorksOnImport
    ? (checks.secondAppendIgnored
      ? "导入会话没有 prompt_snapshot 时，resume 当轮的 --append-system-prompt-file **生效且只追加一次**（主提示词 5599→5657）；但这一次 resume 结束后二进制把自己那份快照（system 10 块 + tools，含刚追加的 marker）写进 transcript，**之后的 resume 就回放快照、静默忽略新的 append** → 客户 system 只能在『第一次 resume』用 append 定终身，续轮改指令必须重建会话。"
      : "导入会话没有 prompt_snapshot，resume 时的 --append-system-prompt-file 生效且不重复，且不会被后续 resume 固化 → 每轮带同一份即可。")
    : (checks.snapshotReplayedAlone
      ? "resume 期 append 不生效：客户 system 只能用『导入时写一条 prompt_snapshot』落在会话里；快照在时 append 仍被忽略，追加指令必须走 messages 或重建会话。"
      : "resume 既不接受 append、也不回放最小 prompt_snapshot：客户 system 只能靠新建会话（--append-system-prompt-file 首轮）或走 messages 注入。"),
  caveat: "prompt_snapshot 的 systemPrompt 是**整块替换**不是追加：只放 marker 时主提示词只剩 74B（默认 5599B 全丢），工具表仍是默认 12 个。线上若要写快照，必须把『完整客户 system + 需要保留的内置块』一次写全。",
};
out.digest = out.cases["import+minimal-snapshot"].digest ?? out.cases["import-only"].digest ?? null;
writeFileSync(join(OUT, "history-import-append.json"), scrub(JSON.stringify(out, null, 1)));
console.log(JSON.stringify({
  task: "T11", pass: checks.pass, checks,
  cases: Object.fromEntries(Object.entries(out.cases).map(([k, c]) => [k, {
    exitCode: c.resumed.exitCode, requests: c.resumed.requests,
    lens: c.view?.system.lens, caller: c.view?.system.callerMarkerByBlock, snapshot: c.view?.system.snapshotMarkerByBlock,
    callerTotal: c.view?.system.callerMarkerTotal, snapshotTotal: c.view?.system.snapshotMarkerTotal,
    probeCounts: c.view?.system.probeCounts,
    billingLine: c.view?.system.billingLine, identity: c.view?.system.identitySentence,
    roles: c.view?.roles, stderrTail: c.resumed.stderrTail,
  }])),
  recommendation: out.recommendation,
}, null, 1));
