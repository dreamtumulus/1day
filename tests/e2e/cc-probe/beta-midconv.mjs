// T10 (task book §6) — what actually triggers `mid-conversation-tool-changes-2026-07-01`?
// The 12 G9 `cli` samples never carried it, but the earlier `attachments*` gates did. Hypothesis matrix:
// entrypoint (cli pty / sdk-cli -p) × attachments context (on/off) × MCP tool set (fake caller MCP on/off).
// Each case runs the real 2.1.312 binary against the same local capturing fake upstream + refusing CONNECT proxy.
// Result feeds `profiles.json → betaPolicy.byFeature`.
//   node tests/e2e/cc-probe/beta-midconv.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCapture } from "./mock-upstream-capture.mjs";
import { describeMessageRequest } from "./shape.mjs";
import { OUT, runGate, scrub } from "./probe-steps.mjs";

const CLAUDE = process.env.CC_PROBE_BIN ?? "/home/ubuntu/claude-code-re/2.1.312/package/claude";
const BETA = "mid-conversation-tool-changes-2026-07-01";
const PROMPT = "Reply with the single word OK.";
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** one interactive (pty) sample: returns the described /v1/messages requests the binary sent. */
async function ptySample({ attachments, mcp }) {
  const home = mkdtempSync(join(tmpdir(), "cc-beta-"));
  const cfg = join(home, "cfg"), work = join(home, "work");
  mkdirSync(cfg, { recursive: true }); mkdirSync(work, { recursive: true });
  const dump = join(home, "requests.ndjson"); writeFileSync(dump, "");
  const extra = [];
  if (mcp) {
    const mcpConfig = join(home, "mcp-config.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { caller: { command: process.execPath, args: [resolve("tests/e2e/cc-probe/fake-mcp-server.mjs")], env: { FAKE_MCP_LOG: join(home, "fake-mcp.log"), FAKE_MCP_ANSWER: "1" } } } }));
    extra.push("--mcp-config", mcpConfig, "--strict-mcp-config");
  }
  const cap = await startCapture({ answerText: "OK", dumpFile: dump });
  const res = await new Promise((r) => {
    const p = spawn("python3", ["tests/e2e/cc-probe/capture-cli.py", CLAUDE, home, "claude-sonnet-5-5", cap.baseUrl, cap.proxyUrl], {
      env: { ...process.env, CLI_PROMPT: PROMPT, CLI_DUMP: dump, CLI_TAG: `beta-${attachments ? "att" : "noatt"}-${mcp ? "mcp" : "nomcp"}`, CLI_ATTACHMENTS: attachments ? "1" : "0", CLI_EXTRA_ARGS: JSON.stringify(extra) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString())); p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => r({ code, out: out.trim(), err: err.slice(-500) }));
  });
  await cap.close();
  const requests = cap.requests.filter((r) => r.url.startsWith("/v1/messages")).map(describeMessageRequest);
  const mcpLog = (() => { try { return readFileSync(join(home, "fake-mcp.log"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } })();
  if (process.env.CC_PROBE_KEEP !== "1") rmSync(home, { recursive: true, force: true });
  return { driverExit: res.code, driverOut: res.out, driverErr: res.err || null, mcpLogLines: mcpLog, requests, connects: cap.connects.length };
}

const summarize = (requests) => requests.map((r) => {
  const betas = r.betaList ?? String(r.headers?.["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    userAgent: r.headers?.["user-agent"] ?? null, url: r.url,
    betaList: betas, hasBeta: betas.includes(BETA),
    hasSystem: (r.system ?? []).length > 0, systemLens: (r.system ?? []).map((s) => s.len ?? 0), tools: (r.tools ?? []).length,
    toolsDigest: r.toolsDigest ?? null,
  };
});

const out = { gate: "beta-midconv", task: "T10", beta: BETA, sampledAt: new Date().toISOString(), cases: {} };

// --- sdk-cli (-p): attachments on/off × mcp on/off ---
for (const [name, gate] of [["sdk-cli/att-on/mcp-off", "attachments"], ["sdk-cli/att-on/mcp-on", "attachments-mcp"]]) {
  const g = await runGate(gate, { CC_PROBE_TAG: "t10" });
  out.cases[name] = { evidence: `${gate}-t10.json`, summary: summarize(g.evidence?.requests ?? []) };
}
// sdk-cli attachments OFF is already the baseline gate (12 G9 samples all attachments-off, beta absent)
const base = (() => { try { return JSON.parse(readFileSync(join(OUT, "baseline.json"), "utf8")); } catch { return null; } })();
out.cases["sdk-cli/att-off/mcp-off"] = { evidence: "baseline.json", summary: summarize(base?.requests ?? []) };

// --- cli (pty): the 2×2 matrix ---
for (const [name, attachments, mcp] of [
  ["cli/att-off/mcp-off", false, false], ["cli/att-off/mcp-on", false, true],
  ["cli/att-on/mcp-off", true, false], ["cli/att-on/mcp-on", true, true],
]) {
  const s = await ptySample({ attachments, mcp });
  out.cases[name] = { evidence: "beta-midconv.json#cases." + name, ...s, summary: summarize(s.requests) };
}

// --- verdicts ---
const verdict = {};
for (const [name, c] of Object.entries(out.cases)) {
  const main = (c.summary ?? []).find((r) => r.hasSystem) ?? c.summary?.[0] ?? null;
  verdict[name] = {
    entrypoint: (main?.userAgent ?? "").includes("sdk-cli") ? "sdk-cli" : (main?.userAgent ?? "").includes("cli") ? "cli" : null,
    attachments: name.includes("att-on"), mcp: name.includes("mcp-on"),
    betaPresent: Boolean(main?.hasBeta), betaCount: main?.betaList?.length ?? 0,
    betaList: main?.betaList ?? null,
  };
}
out.verdicts = verdict;
// which single factor tracks the beta? (all cases sharing it agree)
const factor = (pred) => {
  const withIt = Object.entries(verdict).filter(([n]) => pred(n));
  return { present: withIt.filter(([, v]) => v.betaPresent).length, of: withIt.length };
};
out.betaPolicy = {
  beta: BETA,
  byFeature: {
    attachmentsOn: factor((n) => n.includes("att-on")),
    attachmentsOff: factor((n) => n.includes("att-off")),
    mcpOn: factor((n) => n.includes("mcp-on")),
    mcpOff: factor((n) => n.includes("mcp-off")),
    cliEntrypoint: factor((n) => n.startsWith("cli/")),
    sdkCliEntrypoint: factor((n) => n.startsWith("sdk-cli/")),
  },
};
const att = out.betaPolicy.byFeature;
out.trigger = att.attachmentsOn.present === att.attachmentsOn.of && att.attachmentsOff.present === 0
  ? "attachments-context (CLAUDE_CODE_DISABLE_ATTACHMENTS unset)"
  : att.mcpOn.present === att.mcpOn.of && att.mcpOff.present === 0 ? "mcp-tool-set" : "unclear (see verdicts)";
out.digest = sha(JSON.stringify(verdict));
writeFileSync(join(OUT, "beta-midconv.json"), scrub(JSON.stringify(out, null, 1)));
console.log(JSON.stringify({ task: "T10", trigger: out.trigger, byFeature: out.betaPolicy.byFeature, verdict }, null, 1));
