// T7 (task book §6) — `--resume <id> --input-format stream-json`: the node canonical continuation shape.
// Step 1 lays down a real transcript with `session` (positional prompt), step 2 resumes it and feeds exactly one
// `{"type":"user",…}` line on stdin. Pass: REQ0 messages == history (user + assistant OK) + the new user turn,
// no duplicates, no synthetic `"No response requested."` filler.
//   node tests/e2e/cc-probe/resume-streamjson.mjs
// Local only: fake OAuth, fake HOME, capturing 127.0.0.1 fake upstream, refusing CONNECT proxy.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, runGate, messageShape, scrub } from "./probe-steps.mjs";

const out = { gate: "resume-streamjson", task: "T7", sampledAt: new Date().toISOString() };
const step1 = await runGate("session", { CC_PROBE_KEEP: "1", CC_PROBE_TAG: "t7" });
if (!step1.home) { console.error("step1 failed", step1.code, step1.err.slice(-800)); process.exit(1); }
out.firstTurn = { file: "session-t7.json", sessionId: step1.session, requests: step1.evidence?.requests?.length ?? 0, shapes: (step1.evidence?.requests ?? []).map(messageShape) };

// step 2: resume + stream-json stdin (same HOME so the transcript is the one CC itself wrote)
const step2 = await runGate("resume-streamjson", {
  CC_PROBE_HOME: step1.home, CC_PROBE_SESSION: step1.session, CC_PROBE_TAG: "t7",
  CC_PROBE_PROMPT: "T7-TURN2: what did I ask before?",
});
const ev = step2.evidence;
out.resume = {
  file: "resume-streamjson-t7.json", exitCode: ev?.exitCode ?? null, args: ev?.args ?? null,
  initSessionId: ev?.init?.sessionId ?? null, sessionIdMatches: ev?.init?.sessionId === step1.session,
  requests: ev?.requests?.length ?? 0, stderrTail: ev?.stderrTail ?? null, stdoutTypes: ev?.stdoutTypes ?? null,
  shapes: (ev?.requests ?? []).map(messageShape),
};

// assertions on REQ0 (the request that carries the imported history + the new stdin turn)
const req0 = out.resume.shapes[0];
const roles = req0?.roles ?? [];
const texts = JSON.stringify(req0?.messages ?? []);
const checks = {
  requestSent: (out.resume.requests ?? 0) > 0,
  historyUserPresent: texts.includes("Reply with the single word OK."),
  historyAssistantPresent: texts.includes('"OK"') || roles.some((r) => r === "assistant:text"),
  newTurnPresent: texts.includes("T7-TURN2"),
  noDuplicateHistoryUser: (texts.match(/Reply with the single word OK\./g) ?? []).length === 1,
  noSyntheticNoResponse: !texts.includes("No response requested."),
  linearRoles: roles.join(" > "),
  sessionIdMatch: out.resume.sessionIdMatches,
};
checks.pass = checks.requestSent && checks.historyUserPresent && checks.historyAssistantPresent && checks.newTurnPresent
  && checks.noDuplicateHistoryUser && checks.noSyntheticNoResponse && checks.sessionIdMatch;
out.checks = checks;

// cross-check against the positional-prompt resume we already captured (T1), if present
try {
  const t1 = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(OUT, "resume.json"), "utf8")));
  out.crossCheckPositionalResume = { file: "resume.json", roles: messageShape(t1.requests?.[0]).roles, digest: t1.digest };
} catch { out.crossCheckPositionalResume = null; }

out.digest = ev?.digest ?? null;
writeFileSync(join(OUT, "resume-streamjson.json"), scrub(JSON.stringify(out, null, 1)));
console.log(JSON.stringify({ task: "T7", pass: checks.pass, roles: checks.linearRoles, checks, requests: out.resume.requests, exitCode: out.resume.exitCode, stderrTail: out.resume.stderrTail }, null, 1));
if (!checks.pass) process.exitCode = 1;
