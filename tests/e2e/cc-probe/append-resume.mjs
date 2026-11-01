// T8 (task book §6) — `--append-system-prompt-file` together with `--resume`: is the appended text appended once
// more on every resume (duplication), or is it still a single tail append on the main prompt block?
// Two cases:
//   A) session created WITHOUT the file  → resume WITH the file   (does a resume-time append work at all?)
//   B) session created WITH the file     → resume WITH the same file (double append?)
// Reference: docs/evidence/cc-2.1.312/append.json (single fresh turn, 5599→5655 + marker once).
//   node tests/e2e/cc-probe/append-resume.mjs
// Local only: fake OAuth, fake HOME, capturing 127.0.0.1 fake upstream, refusing CONNECT proxy.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, runGate, messageShape, scrub } from "./probe-steps.mjs";

const read = (f) => { try { return JSON.parse(readFileSync(join(OUT, f), "utf8")); } catch { return null; } };
const sysView = (ev) => (ev?.requests ?? []).map((r) => ({
  url: r.url, lens: r.system.map((s) => s.len), markerCounts: r.system.map((s) => s.markerCount ?? 0),
  markerTotal: r.markerTotal ?? (r.system.reduce((n, s) => n + (s.markerCount ?? 0), 0)),
  hasBillingLine: Boolean(r.billingLine), identity: r.identitySentence,
  tails: r.system.map((s) => s.tailDigest ?? null), systemDigest: r.systemDigest,
}));

const ref = read("append.json");
const out = {
  gate: "append-resume", task: "T8", sampledAt: new Date().toISOString(),
  reference: { file: "append.json", system: sysView(ref), mainPromptLen: ref?.requests?.[0]?.system?.at(-1)?.len ?? null },
  cases: {},
};

// ---- case A: append arrives only on the resume turn ----
const a1 = await runGate("session", { CC_PROBE_KEEP: "1", CC_PROBE_TAG: "t8a" });
if (!a1.home) { console.error("case A step1 failed", a1.code, a1.err.slice(-800)); process.exit(1); }
const a2 = await runGate("resume-append", { CC_PROBE_HOME: a1.home, CC_PROBE_SESSION: a1.session, CC_PROBE_TAG: "t8a" });
out.cases["resume-only"] = {
  firstTurn: { file: "session-t8a.json", systemLens: (a1.evidence?.requests?.[0]?.system ?? []).map((s) => s.len) },
  resume: { file: "resume-append-t8a.json", exitCode: a2.evidence?.exitCode ?? null, system: sysView(a2.evidence), shapes: (a2.evidence?.requests ?? []).map(messageShape) },
};

// ---- case B: append on the first turn AND again on the resume turn ----
const b1 = await runGate("session-append", { CC_PROBE_KEEP: "1", CC_PROBE_TAG: "t8b" });
if (!b1.home) { console.error("case B step1 failed", b1.code, b1.err.slice(-800)); process.exit(1); }
const b2 = await runGate("resume-append", { CC_PROBE_HOME: b1.home, CC_PROBE_SESSION: b1.session, CC_PROBE_TAG: "t8b" });
out.cases["append-both-turns"] = {
  firstTurn: { file: "session-append-t8b.json", systemLens: (b1.evidence?.requests?.[0]?.system ?? []).map((s) => s.len), markerTotal: b1.evidence?.requests?.[0]?.markerTotal ?? null },
  resume: { file: "resume-append-t8b.json", exitCode: b2.evidence?.exitCode ?? null, system: sysView(b2.evidence), shapes: (b2.evidence?.requests ?? []).map(messageShape) },
};

// ---- verdicts: marker must sit once in the LAST (main prompt) block, billing line + identity intact ----
const verdict = (c) => {
  const req = c.resume.system?.[0];
  if (!req) return { ok: false, why: "no request" };
  const last = req.markerCounts?.at(-1) ?? 0;
  const others = (req.markerCounts ?? []).slice(0, -1).reduce((n, x) => n + x, 0);
  return {
    ok: req.markerTotal === 1 && last === 1 && others === 0 && req.hasBillingLine,
    markerTotal: req.markerTotal, mainPromptMarker: last, otherBlocksMarker: others,
    mainPromptLen: req.lens?.at(-1) ?? null, billingLine: req.hasBillingLine, identity: req.identity,
  };
};

// ---- case C (control): the SAME session resumed with the inline flag + a different marker text.
// If the resume-time append path were live, INLINE-SYSTEM-MARKER would show up; it shows up nowhere instead.
const c3 = await runGate("resume-append-inline", { CC_PROBE_HOME: a1.home, CC_PROBE_SESSION: a1.session, CC_PROBE_TAG: "t8c" });
out.cases["resume-inline-control"] = {
  firstTurn: { file: "session-t8a.json", note: "same transcript as resume-only (created without any append)" },
  resume: { file: "resume-append-inline-t8c.json", exitCode: c3.evidence?.exitCode ?? null, system: sysView(c3.evidence), shapes: (c3.evidence?.requests ?? []).map(messageShape) },
};

for (const [k, c] of Object.entries(out.cases)) c.verdict = verdict(c);
out.duplicated = Object.fromEntries(Object.entries(out.cases).map(([k, c]) => [k, (c.verdict.markerTotal ?? 0) > 1]));
// pass = no duplication anywhere; resume-time append is *ignored* (documented, not a failure: caller instructions
// must be pinned at session creation, the transcript's prompt_snapshot wins on resume)
out.pass = Object.values(out.cases).every((c) => (c.verdict.markerTotal ?? 0) <= 1) && out.cases["append-both-turns"].verdict.ok;
out.resumeTimeAppendIgnored = (out.cases["resume-only"].verdict.markerTotal ?? 0) === 0 && (out.cases["resume-inline-control"].verdict.markerTotal ?? 0) === 0;
out.duplicatedAcrossTurns = out.cases["append-both-turns"].verdict.markerTotal;
out.promptSnapshot = {
  firstTurn: a1.evidence?.transcript?.promptSnapshots ?? null,
  resumeTurn: a2.evidence?.transcript?.promptSnapshots ?? null,
  bothTurns: b1.evidence?.transcript?.promptSnapshots ?? null,
  bothTurnsResume: b2.evidence?.transcript?.promptSnapshots ?? null,
};
out.digest = a2.evidence?.digest ?? null;
writeFileSync(join(OUT, "append-resume.json"), scrub(JSON.stringify(out, null, 1)));
console.log(JSON.stringify({ task: "T8", pass: out.pass, resumeTimeAppendIgnored: out.resumeTimeAppendIgnored, duplicatedAcrossTurns: out.duplicatedAcrossTurns, cases: Object.fromEntries(Object.entries(out.cases).map(([k, c]) => [k, { verdict: c.verdict, firstTurnLens: c.firstTurn.systemLens, resumeLens: c.resume.system?.[0]?.lens }])), promptSnapshot: out.promptSnapshot }, null, 1));
if (!out.pass) process.exitCode = 1;
