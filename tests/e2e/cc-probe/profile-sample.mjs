// G9 (spec §7) — profile sampling for the `sdk-cli` and `restricted` profiles of CC 2.1.312.
// Runs run-gate.mjs ≥12 times per profile (4 prompts × 3 models), then folds the per-run evidence into
// docs/evidence/cc-2.1.312/profiles.json (the data source for packages/core/src/cc-profile.ts).
//   node tests/e2e/cc-probe/profile-sample.mjs sdk-cli|restricted
// Structure only: lengths, digests, names, key order — no prompt text, no token.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { summarizeBilling } from "./billing.mjs";

const OUT = resolve(process.env.CC_PROBE_OUT ?? "docs/evidence/cc-2.1.312");
const VERSION = process.env.CC_PROBE_VERSION ?? "2.1.312"; // overridable per batch; default keeps 2.1.312
export const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"];
export const PROMPTS = [
  "Reply with the single word OK.",
  "Summarize in one sentence what a reverse proxy does, then stop.",
  ("x".repeat(40) + " ").repeat(15).trim() + " — reply with the word LONG.",
  "第一轮：用一句中文回答“网关是什么”。\n第二轮（同一请求内）：只回复 OK。",
];
const PROFILE_GATE = { "sdk-cli": "baseline", "restricted": "restricted" };

export async function sample(profile) {
  const gate = PROFILE_GATE[profile];
  const tagBase = profile === "restricted" ? "res" : "sdk";
  const files = [];
  let i = 0;
  for (const model of MODELS) {
    for (const prompt of PROMPTS) {
      i += 1;
      const tag = `${tagBase}-${String(i).padStart(2, "0")}`;
      const file = join(OUT, `${gate}-${tag}.json`);
      if (!existsSync(file)) {
        await new Promise((r) => {
          const p = spawn(process.execPath, ["tests/e2e/cc-probe/run-gate.mjs", gate], {
            env: { ...process.env, CC_PROBE_VERSION: VERSION, CC_PROBE_OUT: OUT, CC_PROBE_MODEL: model, CC_PROBE_PROMPT: prompt, CC_PROBE_TAG: tag },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let err = ""; p.stderr.on("data", (d) => (err += d.toString()));
          p.on("close", (code) => { if (code !== 0) console.error(tag, "exit", code, err.slice(-400)); r(); });
        });
      }
      files.push({ file: `${gate}-${tag}.json`, model });
    }
  }
  return fold(profile, files);
}

export function fold(profile, files) {
  const betaSets = new Set(), betaByModel = {}, ident = new Set(), promptLens = [], promptDigests = new Set(), toolsDigests = new Set();
  let topLevelKeys = null, ccFields = new Set(), blockCounts = new Set(), sampleCount = 0, toolNames = null;
  const evidence = [], thinking = new Set(), outputConfig = new Set(), systemBlockLens = new Set(), byModel = {};
  const billings = [];
  const shapes = new Map();
  for (const { file, model } of files) {
    const d = JSON.parse(readFileSync(join(OUT, file), "utf8"));
    const all = d.requests ?? [];
    // the `cli` profile sends auxiliary calls first (no system block, and a title request with
    // output_config.format) — the *main* turn is the one carrying system blocks
    const withSystem = all.filter((r) => (r.system?.length ?? 0) > 0);
    for (const r of all) {
      const fmt = r.output_config?.format ?? r.output_format ?? null;
      const kind = (r.system?.length ?? 0) === 0 ? "no-system" : fmt ? "structured-output" : "main";
      const key = JSON.stringify({ kind, betaList: r.betaList, topLevelKeys: r.topLevelKeys, maxTokens: r.max_tokens ?? null, systemBlockLens: (r.system ?? []).map((s) => s.len), toolsCount: r.tools?.length ?? 0, outputConfig: r.output_config ?? r.output_format ?? null });
      if (!shapes.has(key)) shapes.set(key, { kind, occurrences: 0, betaList: r.betaList, topLevelKeys: r.topLevelKeys, maxTokens: r.max_tokens ?? null, systemBlockLens: (r.system ?? []).map((s) => s.len), toolsCount: r.tools?.length ?? 0, outputConfig: r.output_config ?? r.output_format ?? null, authScheme: r.authScheme ?? null, files: [] });
      const sh = shapes.get(key); sh.occurrences += 1; if (sh.files.length < 4) sh.files.push(file);
    }
    // main turn = not the structured title request, longest system prompt
    const sum = (r) => (r.system ?? []).reduce((n, b) => n + b.len, 0);
    const mains = withSystem.filter((r) => !(r.output_config?.format ?? r.output_format));
    const main = (mains.length ? mains : withSystem).slice().sort((a, b) => sum(b) - sum(a))[0];
    if (!main) continue;
    sampleCount += 1;
    betaSets.add(JSON.stringify(main.betaList));
    betaByModel[model] = main.betaList;
    // identity line = the first short system block that is not the billing header (62 B in sdk-cli)
    const idBlock = (main.system ?? []).find((b) => b.len < 200 && !b.head.startsWith("x-anthropic-billing-header"));
    if (idBlock) ident.add(idBlock.head);
    const sys = main.system ?? [];
    systemBlockLens.add(JSON.stringify(sys.map((s) => s.len)));
    // "main prompt" = the longest system block (the canonical CC prompt); identity/billing are short
    const longest = sys.reduce((a, b) => (b.len > (a?.len ?? -1) ? b : a), null);
    if (longest) { promptLens.push(longest.len); promptDigests.add(main.systemBlockDigests[sys.indexOf(longest)]); }
    const bm = (byModel[model] ??= { samples: 0 });
    bm.samples += 1; bm.mainPromptLen = longest?.len ?? null; bm.thinking = main.thinking ?? null;
    bm.outputConfig = main.output_config ?? main.output_format ?? null; bm.maxTokens = main.max_tokens ?? null;
    bm.toolsDigest = main.toolsDigest ?? null; bm.toolsCount = main.tools?.length ?? null;
    bm.systemBlockLens = sys.map((s) => s.len); bm.betaList = main.betaList;
    toolsDigests.add(main.toolsDigest ?? null);
    if (!toolNames) toolNames = main.tools ?? null;
    blockCounts.add(sys.length);
    if (!topLevelKeys) topLevelKeys = main.topLevelKeys;
    for (const f of main.ccFieldHits ?? []) ccFields.add(f);
    thinking.add(JSON.stringify(main.thinking));
    outputConfig.add(JSON.stringify(main.output_config ?? main.output_format ?? null));
    if (main.billing) billings.push(main.billing);
    evidence.push({ file, model, sampledAt: d.sampledAt, digest: d.digest, toolsCount: main.tools?.length ?? null, systemBlockLens: sys.map((s) => s.len), allRequestURLs: (d.requests ?? []).length, billing: main.billing ?? null });
  }
  return {
    profile,
    samples: sampleCount,
    betaSets: [...betaSets].map((s) => JSON.parse(s)),
    betaByModel,
    byModel,
    identityBlock: [...ident][0] ?? null,
    identityVariants: [...ident],
    mainPromptLen: [...new Set(promptLens)],
    mainPromptDigests: [...promptDigests],
    systemBlockCount: [...blockCounts],
    systemBlockLens: [...systemBlockLens].map((s) => JSON.parse(s)),
    toolsDigest: [...toolsDigests][0] ?? null,
    tools: toolNames,
    toolsDigests: [...toolsDigests],
    topLevelKeys: topLevelKeys ?? [],
    thinking: [...thinking].map((s) => JSON.parse(s)),
    outputConfig: [...outputConfig].map((s) => JSON.parse(s)),
    ccFields: [...ccFields],
    billingSuffix: summarizeBilling(billings, VERSION),
    requestShapes: [...shapes.values()],
    evidence,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const profile = process.argv[2];
  if (!PROFILE_GATE[profile]) { console.error("usage: profile-sample.mjs sdk-cli|restricted"); process.exit(2); }
  const result = await sample(profile);
  const f = join(OUT, `profile-${profile}.json`);
  writeFileSync(f, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ profile, samples: result.samples, identityBlock: result.identityBlock, mainPromptLen: result.mainPromptLen, systemBlockLens: result.systemBlockLens, betaSets: result.betaSets, byModel: result.byModel, toolsDigests: result.toolsDigests.length, ccFields: result.ccFields, topLevelKeys: result.topLevelKeys }, null, 1));
}
