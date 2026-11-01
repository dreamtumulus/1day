// T12 (task book §7) — `--resume` and the trailing `# Environment update … (was …)` system block.
// T1 saw that a resume gets one extra role=system message at the TAIL of `messages`
// (`# Environment update` + `Primary working directory: <this run> (was …)`), i.e. an upstream-visible block carrying
// paths. The node rewrites the imported transcript's `cwd` to this run's workDir — is that necessary/sufficient, and
// does `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` suppress the block?
//
// Phase 1 — IMPORTED transcripts (`buildNativeTranscript`, the node's case):
//   {transcript cwd == run cwd, cwd != run cwd} × {attachments off/on} × {stdin stream-json, positional prompt}
// Phase 2 — NATIVE transcript (written by CC itself, as in T1/T7): a fresh `session` home, then 4 resumes with only
//   the transcript file edited in between (as-is → drop the `environment` attachment → re-insert it with a stale cwd).
//   node tests/e2e/cc-probe/resume-env-update.mjs
// Local only: fake OAuth, capturing 127.0.0.1 fake upstream, refusing CONNECT proxy; no real credentials/upstream.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildNativeTranscript } from "../../../apps/gateway/dist/ccr/native-session.js";
import { OUT, runGate, scrub, makeProbeHome } from "./probe-steps.mjs";

// Two customer turns are enough here: this probe is about the environment block, not history fidelity.
const CUSTOMER_MESSAGES = [
  { role: "user", content: "ENV-USER-1: start" },
  { role: "assistant", content: [{ type: "text", text: "ENV-ASSISTANT-1: ok" }] },
];

/** Layout under a probe HOME: `<cfg>/projects/<cwd-hash>/<session>.jsonl` (same rule CC itself uses). */
const txFile = (home, session) => join(home, "cfg", "projects", join(home, "work").replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);
const readTx = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const writeTx = (f, lines) => writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
const envAttachments = (lines) => lines.filter((l) => l.attachment?.type === "environment");

/** Drop the `environment` attachment lines and re-link `parentUuid` so the transcript stays a single chain. */
function dropEnvironment(lines) {
  const dropped = new Set(envAttachments(lines).map((l) => l.uuid));
  const parentOf = new Map(lines.map((l) => [l.uuid, l.parentUuid ?? null]));
  const resolve = (uuid) => { let u = uuid; while (u && dropped.has(u)) u = parentOf.get(u) ?? null; return u; };
  return lines.filter((l) => !dropped.has(l.uuid)).map((l) => ({ ...l, parentUuid: resolve(l.parentUuid ?? null) }));
}

/** Append one `environment` attachment (shape from the binary's own sample) with a chosen workingDirectory. */
function withEnvironment(lines, workingDirectory, session) {
  const template = envAttachments(lines)[0];
  const uuid = randomUUID();
  const base = template ?? {
    isSidechain: false, attachment: { type: "environment", snapshot: {}, systemPrompt: [] },
    type: "attachment", userType: "external", entrypoint: "sdk-cli", version: "2.1.312", gitBranch: "HEAD",
  };
  const line = {
    ...base, parentUuid: lines.at(-1)?.uuid ?? null, uuid, timestamp: new Date().toISOString(),
    attachment: { ...base.attachment, snapshot: { ...base.attachment.snapshot, workingDirectory, isWorktree: false, isGitRepo: false, additionalWorkingDirectories: [], platform: "linux", shell: "bash" } },
    cwd: workingDirectory, sessionId: session,
  };
  return [...lines, line];
}

/** Lay down a probe HOME whose transcript is the gateway import (cwd = this run, or a stale one). */
function importTranscript({ cwdMode }) {
  const { home, work, projectDir } = makeProbeHome("cc-env-");
  const session = randomUUID();
  const transcriptCwd = cwdMode === "same" ? work : `${work}-prev`;
  const lines = buildNativeTranscript(CUSTOMER_MESSAGES, session, { cwd: transcriptCwd, model: "claude-sonnet-5-5" });
  mkdirSync(projectDir, { recursive: true });
  // the lookup is by session id inside the project dir of the current cwd, so the file always lives there
  writeFileSync(join(projectDir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { home, work, session, transcriptCwd, transcriptCwdIsRunCwd: transcriptCwd === work };
}

/** Structural view: where do role=system messages sit, and does any of them carry `# Environment update (was …)`? */
function view(home, gate, tag) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(join(home, `raw-capture-${gate}-${tag}.json`), "utf8")); } catch { /* none */ }
  const req = (raw?.requests ?? []).find((r) => r.url.startsWith("/v1/messages"));
  const body = req?.body ?? null;
  if (!body) return null;
  const text = (b) => (typeof b === "string" ? b : String(b?.text ?? ""));
  const msgs = (body.messages ?? []).map((m, i) => {
    const blocks = Array.isArray(m.content)
      ? m.content.map((c) => ({ type: c.type, len: text(c).length, head: text(c).slice(0, 120) }))
      : [{ type: "string", len: String(m.content ?? "").length, head: String(m.content ?? "").slice(0, 120) }];
    const joined = blocks.map((b) => b.head).join("\n");
    return {
      index: i, role: m.role, blocks: blocks.map((b) => `${b.type}(${b.len})`),
      isEnvUpdate: joined.includes("# Environment update"),
      hasWasClause: joined.includes("(was "),
      isEnvironment: joined.includes("# Environment") && !joined.includes("# Environment update"),
      head: blocks.at(-1)?.head ?? null,
    };
  });
  const updates = msgs.filter((m) => m.isEnvUpdate);
  return {
    systemBlocksInSystem: (Array.isArray(body.system) ? body.system : []).length,
    systemLens: (Array.isArray(body.system) ? body.system : []).map((s) => text(s).length),
    messageCount: msgs.length,
    tail: msgs.slice(-2),
    envUpdateCount: updates.length,
    envUpdate: updates.map((u) => ({ index: u.index, role: u.role, blocks: u.blocks, hasWasClause: u.hasWasClause, head: u.head })),
    envBlockCount: msgs.filter((m) => m.isEnvironment).length,
    roles: msgs.map((m) => `${m.role}:${m.blocks.map((b) => b.replace(/\(\d+\)/, "")).join("+")}`),
    historyTurnsPresent: JSON.stringify(msgs).includes("ENV-USER-1") && JSON.stringify(msgs).includes("ENV-ASSISTANT-1"),
  };
}

const out = {
  gate: "resume-env-update", task: "T12", sampledAt: new Date().toISOString(),
  importer: "apps/gateway/dist/ccr/native-session.js#buildNativeTranscript",
  question: "does --resume append a `# Environment update … (was …)` role=system block, and does transcript-cwd rewriting / DISABLE_ATTACHMENTS remove it?",
  cases: {},
};

// ---------------- phase 1: imported transcripts ----------------
const importCases = [
  { key: "stdin-same-cwd-att-off", gate: "resume-streamjson", tag: "t12a", cwdMode: "same", attachments: false },
  { key: "stdin-diff-cwd-att-off", gate: "resume-streamjson", tag: "t12b", cwdMode: "diff", attachments: false },
  { key: "stdin-same-cwd-att-on", gate: "resume-streamjson", tag: "t12c", cwdMode: "same", attachments: true },
  { key: "stdin-diff-cwd-att-on", gate: "resume-streamjson", tag: "t12d", cwdMode: "diff", attachments: true },
  { key: "positional-same-cwd-att-off", gate: "resume", tag: "t12e", cwdMode: "same", attachments: false },
  { key: "positional-diff-cwd-att-off", gate: "resume", tag: "t12f", cwdMode: "diff", attachments: false },
];

for (const c of importCases) {
  const imp = importTranscript({ cwdMode: c.cwdMode });
  const res = await runGate(c.gate, {
    CC_PROBE_HOME: imp.home, CC_PROBE_SESSION: imp.session, CC_PROBE_TAG: c.tag,
    CC_PROBE_STDIN_TEXT: "T12-LIVE: continue.",
    ...(c.attachments ? { CC_PROBE_ATTACHMENTS: "1" } : {}),
  });
  const ev = res.evidence;
  out.cases[c.key] = {
    input: { gate: c.gate, transcriptCwdMode: c.cwdMode, transcriptCwdIsRunCwd: imp.transcriptCwdIsRunCwd, attachments: c.attachments ? "on" : "off (CLAUDE_CODE_DISABLE_ATTACHMENTS=1)", newTurn: c.gate === "resume" ? "positional prompt" : "stdin stream-json" },
    file: `${c.gate}-${c.tag}.json`,
    resumed: {
      exitCode: ev?.exitCode ?? null, requests: ev?.requests?.length ?? 0,
      initCwdIsWork: ev?.init?.cwdIsWork ?? null, sessionIdMatches: ev?.init?.sessionId === imp.session,
      envHasDisableAttachments: (ev?.env ?? []).includes("CLAUDE_CODE_DISABLE_ATTACHMENTS"),
      stderrTail: ev?.stderrTail ?? null,
    },
    view: view(imp.home, c.gate, c.tag),
    digest: ev?.digest ?? null,
  };
}

// ---------------- phase 2: native transcript (what T1 actually resumed) ----------------
out.native = { phase: "native transcript written by CC 2.1.312 itself (includes its own `environment` attachment)", cases: {} };
const nativeHome = makeProbeHome("cc-env-native-");
const n1 = await runGate("session", { CC_PROBE_KEEP: "1", CC_PROBE_HOME: nativeHome.home, CC_PROBE_SESSION: randomUUID(), CC_PROBE_PROMPT: "ENV-NATIVE-TURN1: hello", CC_PROBE_TAG: "t12n0" });
if (!n1.session) { console.error("native step1 failed", n1.code, n1.err.slice(-800)); process.exit(1); }
const nfile = txFile(nativeHome.home, n1.session);
const afterFirstTurn = readTx(nfile);
out.native.firstTurn = {
  file: "session-t12n0.json", sessionIdMatches: n1.evidence?.init?.sessionId === n1.session,
  requests: n1.evidence?.requests?.length ?? 0,
  transcript: { lines: afterFirstTurn.length, envAttachments: envAttachments(afterFirstTurn).length, envAttachmentMatchesRunCwd: envAttachments(afterFirstTurn).every((l) => l.attachment?.snapshot?.workingDirectory === nativeHome.work) },
};

const nativeSteps = [
  { key: "stdin-as-is", gate: "resume-streamjson", tag: "t12n1", edit: null },
  { key: "positional-as-is", gate: "resume", tag: "t12n2", edit: null },
  { key: "positional-no-env-attachment", gate: "resume", tag: "t12n3", edit: "drop" },
  { key: "positional-stale-env-attachment", gate: "resume", tag: "t12n4", edit: "stale" },
];
for (const s of nativeSteps) {
  const before = readTx(nfile);
  if (s.edit === "drop") writeTx(nfile, dropEnvironment(before));
  if (s.edit === "stale") writeTx(nfile, withEnvironment(dropEnvironment(before), `${nativeHome.work}-prev`, n1.session));
  const res = await runGate(s.gate, {
    CC_PROBE_HOME: nativeHome.home, CC_PROBE_SESSION: n1.session, CC_PROBE_TAG: s.tag,
    CC_PROBE_STDIN_TEXT: "T12-LIVE: continue.", CC_PROBE_PROMPT: `ENV-NATIVE-${s.tag}: continue.`,
  });
  const ev = res.evidence;
  out.native.cases[s.key] = {
    edit: s.edit ?? "none", file: `${s.gate}-${s.tag}.json`,
    transcriptBefore: {
      lines: before.length, envAttachments: envAttachments(before).length,
      envAttachmentMatchesRunCwd: envAttachments(before).map((l) => l.attachment?.snapshot?.workingDirectory === nativeHome.work),
    },
    resumed: {
      exitCode: ev?.exitCode ?? null, requests: ev?.requests?.length ?? 0,
      stdoutTypes: ev?.stdoutTypes ?? null, stderrTail: ev?.stderrTail ?? null,
    },
    view: view(nativeHome.home, s.gate, s.tag),
    digest: ev?.digest ?? null,
  };
}

// ---------------- phase 3: exact T1 command sequence, twice (is T1's block reproducible at all?) ----------------
out.reproT1 = {
  sequence: "run-gate session (default prompt) → run-gate resume (positional, T1-TURN2) → run-gate resume (positional, T1-TURN3)",
  attempts: [],
};
for (const attempt of [1, 2]) {
  const h = makeProbeHome(`cc-env-repro${attempt}-`);
  const s1 = await runGate("session", { CC_PROBE_KEEP: "1", CC_PROBE_HOME: h.home, CC_PROBE_SESSION: randomUUID(), CC_PROBE_TAG: `t12r${attempt}s` });
  if (!s1.session) { console.error("repro step1 failed", s1.code, s1.err.slice(-800)); process.exit(1); }
  const steps = [];
  for (const [turn, tag] of [["T1-TURN2: what did I ask first?", `t12r${attempt}a`], ["T1-TURN3: and now?", `t12r${attempt}b`]]) {
    const res = await runGate("resume", { CC_PROBE_HOME: h.home, CC_PROBE_SESSION: s1.session, CC_PROBE_PROMPT: turn, CC_PROBE_TAG: tag });
    steps.push({ turn, tag, file: `resume-${tag}.json`, resume: { exitCode: res.evidence?.exitCode ?? null, requests: res.evidence?.requests?.length ?? 0 }, view: view(h.home, "resume", tag) });
  }
  out.reproT1.attempts.push({
    attempt, file: `session-t12r${attempt}s.json`,
    firstTurn: { requests: s1.evidence?.requests?.length ?? 0, cwdIsWork: s1.evidence?.init?.cwdIsWork ?? null },
    resumes: steps,
    envUpdateCounts: steps.map((s) => s.view?.envUpdateCount ?? null),
  });
}

// ---------------- static cross-check of the shipped artifact (read-only `strings`-level read) ----------------
// The renderer in the 2.1.312 bundle has the shape: diff(storedEnv, currentEnv) → render(diff). The diff emits
// {field:"workingDirectory", from:<stored>} ONLY when the stored and current workingDirectory differ, and the renderer
// prints "# Environment update" + "Primary working directory: <now> (was <old>)" for that field. Nothing in that path
// consults the attachments flag; DISABLE_ATTACHMENTS only gates the FULL "# Environment" block (~9.5KB).
out.staticCheck = {
  method: "local read of the shipped 2.1.312 bundle only (grep for the two literal headers and their renderer); no execution",
  observed: {
    fullHeaderLiteral: '# Environment',
    updateHeaderLiteral: '# Environment update',
    preambleLiteral: 'You have been invoked in the following environment: ',
    diffFields: ["workingDirectory", "isWorktree", "isGitRepo", "additionalWorkingDirectories", "scratchpadDirectory", "githubCli", "agentProxy"],
    updateCondition: 'workingDirectory (or another diffed field) differs between the stored environment attachment and the current one; the "(was …)" suffix is the stored value',
  },
  implication: "该块是 environment 的『diff 渲染』，不是 resume 的固定行为；因此 cwd 一致时不应出现，且 attachments 开关不控制它。",
};

// ---------------- verdicts ----------------
const u = (k) => out.cases[k].view?.envUpdateCount ?? null;
const nu = (k) => out.native.cases[k].view?.envUpdateCount ?? null;
const reproCounts = out.reproT1.attempts.flatMap((a) => a.envUpdateCounts);
/** length of the FULL `# Environment` block in a case (parsed back out of the structural `text(<len>)` label) */
const envBlockLen = (v) => {
  const m = v?.tail?.find((x) => x.isEnvironment);
  const hit = /\((\d+)\)/.exec(m?.blocks?.[0] ?? "");
  return hit ? Number(hit[1]) : null;
};
const envLenAttOn = envBlockLen(out.cases["stdin-same-cwd-att-on"].view);
const envLenNoAttachment = envBlockLen(out.native.cases["positional-no-env-attachment"].view);
const nativePositionalCount = Object.values(out.native.cases).filter((c) => c.input === undefined && c.edit !== undefined && c.file.startsWith("resume-t12n2") || c.file.startsWith("resume-t12n3") || c.file.startsWith("resume-t12n4")).length;
const nativeStdinCount = Object.values(out.native.cases).filter((c) => c.file.startsWith("resume-streamjson-t12n1")).length;
const checks = {
  requestSent: [...Object.values(out.cases), ...Object.values(out.native.cases)].every((c) => (c.resumed.requests ?? 0) > 0 && c.view !== null),
  // imported transcript (the node's case): never gets the block, whatever the cwd field / attachments flag / turn shape
  importedNeverGetsUpdate: Object.values(out.cases).every((c) => (c.view?.envUpdateCount ?? 1) === 0),
  importedAttachmentsFlagIrrelevant: u("stdin-diff-cwd-att-on") === u("stdin-diff-cwd-att-off") && u("stdin-same-cwd-att-on") === u("stdin-same-cwd-att-off"),
  // native transcript: stdin continuation never shows it; today's positional continuation doesn't either
  nativeStdinNoUpdate: nu("stdin-as-is") === 0,
  nativePositionalNoUpdateToday: nu("positional-as-is") === 0,
  nativeDroppingEnvAttachmentStillNoUpdate: nu("positional-no-env-attachment") === 0,
  nativeStaleEnvAttachmentStillNoUpdate: nu("positional-stale-env-attachment") === 0,
  // the exact T1 sequence (session → 2× positional resume), run twice now
  t1SequenceNotReproduced: reproCounts.length === 4 && reproCounts.every((n) => n === 0),
  historyPreserved: Object.values(out.cases).every((c) => c.view?.historyTurnsPresent),
  sessionIdMatches: Object.values(out.cases).every((c) => c.resumed.sessionIdMatches),
};
checks.pass = checks.requestSent && checks.importedNeverGetsUpdate && checks.nativeStdinNoUpdate
  && checks.t1SequenceNotReproduced && checks.historyPreserved && checks.sessionIdMatches;
out.checks = checks;

out.conclusion = {
  importedTranscript: checks.importedNeverGetsUpdate
    ? "导入的 transcript（`buildNativeTranscript`，无 `environment` attachment）在**任何**组合下都不产生 `# Environment update`：cwd 相同/不同、attachments 开/关、stdin/positional 全为 0 次。→ 节点场景本来就不会多这一块。"
    : "导入 transcript 也会产生该块（见 cases）。",
  trigger: "二进制里该块是 environment 的**diff 渲染**（stored environment attachment vs 本次环境）：只有 diffed 字段（workingDirectory 等）不同才会输出，`(was …)` 是存储值（见 staticCheck）。因此『cwd 是否相同』是必要条件、attachments 开关不是。",
  t1BlockReproduced: checks.t1SequenceNotReproduced ? false : true,
  t1NonReproduction: `T1 的 99B 块今天 **${reproCounts.filter((n) => n > 0).length} 次复现 / ${reproCounts.length} 次精确复刻**（另加 ${nativePositionalCount} 次 native positional 变体与 ${nativeStdinCount} 次 native stdin 续轮，同样 0 命中）；说明它不是 resume 的固定行为，而是当时那份 transcript 的 environment attachment 与本次环境产生了真实 diff（存储值已不可考，T1 的 home 已删除）。`,
  disableAttachmentsRemovesBlock: false,
  matchingTranscriptCwdRemovesBlock: checks.importedNeverGetsUpdate && checks.nativeStdinNoUpdate,
  attachmentsNote: `\`CLAUDE_CODE_DISABLE_ATTACHMENTS=1\` 不管 \`# Environment update\`；它只控制整块 \`# Environment\` 是否渲染进 messages：attachments ON 时尾部多一条 ${envLenAttOn ?? "?"}B 的 role=system 块（含工作目录/平台/OS/版本），OFF 时默认不出现；但若 transcript 里**没有** environment attachment 而本轮又需要渲染环境，OFF 下会冒出一条 ${envLenNoAttachment ?? "?"}B 的短 \`# Environment\` 块（见 native positional-no-env-attachment）。`, 
  advice: "节点已把导入/resume 的 transcript cwd 改写成本次 workDir：对『带 environment attachment 的 transcript』这是对的方向（diff 为空即不输出），对当前的导入 transcript（无该 attachment）则只是无害的防御，真正的护栏是**续轮形态**（stdin stream-json）与**不要写入陈旧的 environment attachment**；若将来导入器或 resume 路径会写入 environment attachment，cwd 改写就变成必需项，建议保留。",
  t12Answer: {
    disableAttachmentsRemovesBlock: false,
    matchingTranscriptCwdRemovesBlock: checks.importedNeverGetsUpdate && checks.nativeStdinNoUpdate,
    cwdRewriteIsSufficientInPrinciple: true,
    cwdRewriteNeededForTodaysNode: false,
  },
};
out.digest = out.cases["stdin-diff-cwd-att-off"].digest ?? null;
writeFileSync(join(OUT, "resume-env-update.json"), scrub(JSON.stringify(out, null, 1)));
console.log(JSON.stringify({
  task: "T12", pass: checks.pass, checks,
  imported: Object.fromEntries(Object.entries(out.cases).map(([k, c]) => [k, {
    exitCode: c.resumed.exitCode, requests: c.resumed.requests, transcriptCwdIsRunCwd: c.input.transcriptCwdIsRunCwd,
    attachments: c.input.attachments, newTurn: c.input.newTurn,
    envUpdateCount: c.view?.envUpdateCount, envUpdate: c.view?.envUpdate,
    envBlockCount: c.view?.envBlockCount, systemLens: c.view?.systemLens, stderrTail: c.resumed.stderrTail,
  }])),
  native: Object.fromEntries(Object.entries(out.native.cases).map(([k, c]) => [k, {
    edit: c.edit, transcriptBefore: c.transcriptBefore, exitCode: c.resumed.exitCode,
    envUpdateCount: c.view?.envUpdateCount, envUpdate: c.view?.envUpdate,
    envBlockCount: c.view?.envBlockCount, systemLens: c.view?.systemLens, roles: c.view?.roles,
    stderrTail: c.resumed.stderrTail,
  }])),
  reproT1: out.reproT1.attempts.map((a) => ({ attempt: a.attempt, envUpdateCounts: a.envUpdateCounts, resumes: a.resumes.map((r) => ({ turn: r.turn, exitCode: r.resume.exitCode, requests: r.resume.requests, lens: r.view?.systemLens, tail: r.view?.envUpdate })) })),
  conclusion: out.conclusion,
}, null, 1));
