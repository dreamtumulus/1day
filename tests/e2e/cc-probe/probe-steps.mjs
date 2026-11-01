// Tiny helper shared by the second-batch probe drivers (T7–T10): run one `run-gate.mjs` gate with extra env,
// return the evidence file contents plus the temp HOME / session id `run-gate` printed when it keeps the home.
// Local only: no credentials, no real upstream (run-gate always points at the capturing 127.0.0.1 fake upstream).
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const OUT = resolve("docs/evidence/cc-2.1.312");

/** §0.4: evidence stores structure only — never temp/home paths. */
export const scrub = (s) => String(s)
  .replace(/\/(?:tmp|var\/tmp)\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<tmp-path>")
  .replace(/\/home\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<home-path>")
  .replace(/\/root\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<home-path>");

/** Run a gate; returns { code, out, err, home, session, evidence, evidenceFile }. */
export function runGate(gate, env = {}) {
  const tag = env.CC_PROBE_TAG ?? "";
  const file = join(OUT, tag ? `${gate}-${tag}.json` : `${gate}.json`);
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  return new Promise((r) => {
    const p = spawn(process.execPath, ["tests/e2e/cc-probe/run-gate.mjs", gate], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      let home = null, session = null;
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try { const j = JSON.parse(line); if (j.home) { home = j.home; session = j.session; } } catch { /* summary line */ }
      }
      let evidence = null;
      try { evidence = JSON.parse(readFileSync(file, "utf8")); } catch { evidence = null; }
      const stale = before !== null && evidence === null;
      r({ code, out, err, home, session, evidence, evidenceFile: file, stale });
    });
  });
}

/** Structural view of one captured /v1/messages request (already redacted by run-gate/shape). */
export function messageShape(req) {
  return {
    roles: (req?.messages ?? []).map((m) => `${m.role}:${m.blocks.map((b) => b.type).join("+")}`),
    messages: (req?.messages ?? []).map((m) => ({ role: m.role, blocks: m.blocks.map((b) => ({ type: b.type, len: b.len, head: b.head, is_error: b.is_error ?? null })) })),
    systemLens: (req?.system ?? []).map((s) => s.len),
    markerCounts: (req?.system ?? []).map((s) => s.markerCount ?? 0),
    markerTotal: req?.markerTotal ?? null,
    hasSyntheticNoResponse: JSON.stringify(req?.messages ?? []).includes("No response requested."),
  };
}

/** Keep only protocol/structure fields we are allowed to store (§0.4): lengths, heads, digests, key names. */
export function transcriptShape(lines) {
  return lines.map((l) => ({
    type: l.type, role: l.message?.role ?? null,
    parentUuid: l.parentUuid ?? null, uuid: l.uuid ?? null,
    blocks: Array.isArray(l.message?.content) ? l.message.content.map((c) => c.type) : ["string"],
    head: String(typeof l.message?.content === "string" ? l.message.content : (l.message?.content ?? []).map((c) => c.text ?? c.name ?? c.tool_use_id ?? c.type).join("|")).slice(0, 120),
    toolUse: (l.message?.content ?? []).filter?.((c) => c.type === "tool_use").map((c) => c.id) ?? [],
    toolResult: (l.message?.content ?? []).filter?.((c) => c.type === "tool_result").map((c) => c.tool_use_id) ?? [],
  }));
}
