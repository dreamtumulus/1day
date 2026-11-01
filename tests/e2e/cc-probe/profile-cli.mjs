// G9 (spec §7) — `cli` profile sampling (entrypoint=cli). `-p` can only produce sdk-cli, so the binary runs
// under a pseudo-terminal (tests/e2e/cc-probe/capture-cli.py) against the same local fake upstream + refusing
// CONNECT proxy, with a pre-seeded fake HOME. 4 prompts × 3 models = 12 samples; folds into profile-cli.json.
//   node tests/e2e/cc-probe/profile-cli.mjs [n]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { startCapture } from "./mock-upstream-capture.mjs";
import { describeMessageRequest } from "./shape.mjs";
import { MODELS, PROMPTS, fold } from "./profile-sample.mjs";

const OUT = resolve("docs/evidence/cc-2.1.312");
const CLAUDE = process.env.CC_PROBE_BIN ?? "/home/ubuntu/claude-code-re/2.1.312/package/claude";
const perArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const per = Number(perArg ?? 1); // samples per (model,prompt) pair; 1 ⇒ 12 samples

const files = [];
let i = 0;
const foldOnly = process.argv.includes("--fold-only");
for (const model of MODELS) {
  for (const prompt of PROMPTS) {
    for (let k = 0; k < per; k++) {
      i += 1;
      const tag = `cli-${String(i).padStart(2, "0")}`;
      if (foldOnly) { files.push({ file: `profile-cli-${tag}.json`, model }); continue; }
      const home = mkdtempSync(join(tmpdir(), "cc-cli-"));
      const dump = join(home, "requests.ndjson");
      writeFileSync(dump, "");
      const cap = await startCapture({ answerText: "OK", port: 0, dumpFile: dump });
      const res = await new Promise((r) => {
        const p = spawn("python3", ["tests/e2e/cc-probe/capture-cli.py", CLAUDE, home, model, cap.baseUrl, cap.proxyUrl], {
          env: { ...process.env, CLI_PROMPT: prompt, CLI_DUMP: dump, CLI_TAG: tag },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "", err = "";
        p.stdout.on("data", (d) => (out += d.toString()));
        p.stderr.on("data", (d) => (err += d.toString()));
        p.on("close", (code) => r({ code, out: out.trim(), err: err.slice(-800) }));
      });
      await cap.close();
      const described = cap.requests.filter((r) => r.url.startsWith("/v1/messages")).map(describeMessageRequest);
      const ev = {
        gate: "profile-cli", tag, profile: "cli", binaryVersion: "2.1.312", model, promptLen: prompt.length,
        sampledAt: new Date().toISOString(), exitCode: res.code, driverOut: res.out || null, driverErr: res.err || null,
        requests: described,
        otherEndpoints: cap.requests.filter((r) => !r.url.startsWith("/v1/messages")).map((r) => `${r.method} ${r.url}`),
        connectAttempts: cap.connects,
      };
      ev.digest = createHash("sha256").update(JSON.stringify({ requests: described, other: ev.otherEndpoints })).digest("hex").slice(0, 16);
      writeFileSync(join(OUT, `profile-cli-${tag}.json`), JSON.stringify(ev, null, 1).replace(/\/tmp\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<tmp-path>"));
      files.push({ file: `profile-cli-${tag}.json`, model });
      console.log(tag, model, "exit", res.code, "reqs", described.length, "other", ev.otherEndpoints.length, res.out.slice(0, 160));
      if (process.env.CC_PROBE_KEEP !== "1") rmSync(home, { recursive: true, force: true });
    }
  }
}
const folded = fold("cli", files);
writeFileSync(join(OUT, "profile-cc-2.1.312-cli.json"), JSON.stringify(folded, null, 1));
console.log(JSON.stringify({ samples: folded.samples, identityBlock: folded.identityBlock, identityVariants: folded.identityVariants, mainPromptLen: folded.mainPromptLen, systemBlockLens: folded.systemBlockLens, betaSets: folded.betaSets, ccFields: folded.ccFields, topLevelKeys: folded.topLevelKeys }, null, 1));
