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
// T10: which feature flips `mid-conversation-tool-changes-2026-07-01` (measured, docs/evidence/.../beta-midconv.json)
try {
  const beta = JSON.parse(readFileSync(join(OUT, "beta-midconv.json"), "utf8"));
  out.betaPolicy = {
    beta: beta.beta, trigger: beta.trigger, sampledAt: beta.sampledAt, digest: beta.digest,
    byFeature: beta.betaPolicy?.byFeature ?? null,
    verdicts: beta.verdicts ?? null,
    evidence: { file: "beta-midconv.json", source: "docs/evidence/cc-2.1.312/beta-midconv.json", grade: "sampled" },
    note: "measured: beta follows the attachments context (CLAUDE_CODE_DISABLE_ATTACHMENTS unset), not entrypoint and not MCP; every G9 sample ran with attachments disabled, which is why the 12 cli samples never carried it.",
  };
} catch { /* T10 not sampled yet */ }
writeFileSync(join(OUT, "profiles.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).filter(([k]) => k.startsWith("cc-")).map(([k, v]) => [k, { samples: v.samples, identityBlock: v.identityBlock, mainPromptLen: v.mainPromptLen, tools: v.tools?.length, toolsDigest: v.toolsDigest, betaPaths: v.betaSets.length, topLevelKeys: v.topLevelKeys.length, ccFields: v.ccFields.length }])), null, 1));
