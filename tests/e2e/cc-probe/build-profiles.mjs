// Merges the three per-profile samples into docs/evidence/cc-2.1.312/profiles.json — the data source for
// packages/core/src/cc-profile.ts (task book §4 T4). Field names follow the task book exactly.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve("docs/evidence/cc-2.1.312");
const SRC = [
  ["cc-2.1.312-cli", "profile-cc-2.1.312-cli.json"],
  ["cc-2.1.312-sdk-cli", "profile-sdk-cli.json"],
  ["cc-2.1.312-restricted", "profile-restricted.json"],
];
const out = {};
for (const [key, file] of SRC) {
  const d = JSON.parse(readFileSync(join(OUT, file), "utf8"));
  out[key] = {
    samples: d.samples,
    betaSets: d.betaSets,
    betaByModel: d.betaByModel,
    identityBlock: d.identityBlock,
    identityVariants: d.identityVariants,
    mainPromptLen: d.mainPromptLen,
    mainPromptDigests: d.mainPromptDigests,
    systemBlockLens: d.systemBlockLens,
    toolsDigest: d.toolsDigest,
    tools: d.tools,
    topLevelKeys: d.topLevelKeys,
    thinking: d.thinking,
    outputConfig: d.outputConfig,
    ccFields: d.ccFields,
    byModel: d.byModel,
    requestShapes: d.requestShapes,
    // aliases for packages/core/src/cc-profile.ts (it names them identityBlocks / mainPromptLengths / evidence[].source)
    identityBlocks: d.identityVariants,
    mainPromptLengths: d.mainPromptLen,
    evidence: d.evidence.map((e) => ({ file: e.file, source: `docs/evidence/cc-2.1.312/${e.file}`, sampledAt: e.sampledAt, digest: e.digest, model: e.model, grade: "sampled" })),
  };
}
writeFileSync(join(OUT, "profiles.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { samples: v.samples, identityBlock: v.identityBlock, mainPromptLen: v.mainPromptLen, tools: v.tools?.length, toolsDigest: v.toolsDigest, betaPaths: v.betaSets.length, topLevelKeys: v.topLevelKeys.length, ccFields: v.ccFields.length }])), null, 1));
