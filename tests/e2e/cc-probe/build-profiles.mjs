// Merges the per-profile samples into docs/evidence/cc-<ver>/profiles.json — the data source for
// packages/core/src/cc-profile.ts (task book §4 T4, batch 4 §要交付 1–3).
//   CC_PROBE_VERSION=2.1.316 CC_PROBE_OUT=docs/evidence/cc-2.1.316 node tests/e2e/cc-probe/build-profiles.mjs
// Defaults keep the 2.1.312 behaviour (docs/evidence/cc-2.1.312).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const VERSION = process.env.CC_PROBE_VERSION ?? "2.1.312";
const OUT = resolve(process.env.CC_PROBE_OUT ?? `docs/evidence/cc-${VERSION}`);
const SRC = [
  [`cc-${VERSION}-cli`, `profile-cc-${VERSION}-cli.json`],
  [`cc-${VERSION}-sdk-cli`, "profile-sdk-cli.json"],
  [`cc-${VERSION}-restricted`, "profile-restricted.json"],
];

// ---- transport constants: authoritative values are the headers the binary itself sent ----
const TRANSPORT_HEADERS = [
  "user-agent", "x-stainless-runtime-version", "x-stainless-package-version", "x-stainless-runtime",
  "x-stainless-os", "x-stainless-arch", "x-stainless-lang", "x-stainless-timeout", "x-app",
  "anthropic-version", "anthropic-dangerous-direct-browser-access", "accept-encoding",
];
const collectTransport = (docs) => {
  const per = {};
  for (const key of TRANSPORT_HEADERS) per[key] = new Set();
  for (const d of docs) for (const r of d.requests ?? []) for (const key of TRANSPORT_HEADERS) {
    const v = r.headers?.[key];
    if (v !== undefined) per[key].add(String(v));
  }
  const out = {};
  for (const key of TRANSPORT_HEADERS) {
    const vals = [...per[key]].sort();
    if (vals.length) out[key] = vals.length === 1 ? vals[0] : vals;
  }
  return out;
};

const out = {};
const transportByProfile = {};
const allBilling = [];
const allTransportDocs = [];
const evidenceDocs = (d) => (d.evidence ?? []).map((e) => { try { return JSON.parse(readFileSync(join(OUT, e.file), "utf8")); } catch { return null; } }).filter(Boolean);
for (const [key, file] of SRC) {
  let d;
  try { d = JSON.parse(readFileSync(join(OUT, file), "utf8")); } catch { continue; } // restricted is optional
  const sampleDocs = evidenceDocs(d);
  transportByProfile[d.profile] = collectTransport(sampleDocs);
  allTransportDocs.push(...sampleDocs);
  for (const b of d.billingSuffix ? [d.billingSuffix] : []) allBilling.push(b);
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
    billingSuffix: d.billingSuffix ?? null,
    // aliases for packages/core/src/cc-profile.ts (it names them identityBlocks / mainPromptLengths / evidence[].source)
    identityBlocks: d.identityVariants,
    mainPromptLengths: d.mainPromptLen,
    evidence: d.evidence.map((e) => ({ file: e.file, source: `docs/evidence/cc-${VERSION}/${e.file}`, sampledAt: e.sampledAt, digest: e.digest, model: e.model, grade: "sampled", billing: e.billing ?? null })),
  };
}
// one transport block for the whole version: scalar where invariant, arrays where it legitimately varies by entrypoint
const transport = collectTransport(allTransportDocs);
const uas = transport["user-agent"];
const uaList = Array.isArray(uas) ? uas : uas ? [uas] : [];
out.transport = {
  ...transport,
  // 主 UA 取 sdk-cli 入口（`-p`，与 2.1.312 文档中的 UA 同型），两个入口的差异见 userAgents/byProfile
  userAgent: uaList.find((u) => u.includes("sdk-cli")) ?? uaList[0] ?? null,
  userAgents: uaList,
  userAgentByProfile: Object.fromEntries(Object.entries(transportByProfile).map(([p, v]) => [p, v["user-agent"] ?? null])),
  byProfile: transportByProfile,
  note: "值取自二进制真实发出的请求头（requests[].headers），不是推断；x-stainless-runtime-version 是打包 Node ABI 串，x-stainless-package-version 是 SDK 版本。",
};
out.billingSuffix = (() => {
  const merged = { checked: 0, matched: 0, mismatched: 0, matchRate: null, headerVersionOk: true, observedSuffixes: new Set(), computedSuffixes: new Set(), mismatches: [] };
  for (const b of allBilling) {
    merged.checked += b.checked; merged.matched += b.matched; merged.mismatched += b.mismatched;
    merged.headerVersionOk = merged.headerVersionOk && b.headerVersionOk;
    for (const s of b.observedSuffixes) merged.observedSuffixes.add(s);
    for (const s of b.computedSuffixes) merged.computedSuffixes.add(s);
    merged.mismatches.push(...(b.mismatches ?? []));
  }
  merged.observedSuffixes = [...merged.observedSuffixes];
  merged.computedSuffixes = [...merged.computedSuffixes];
  merged.matchRate = merged.checked ? `${merged.matched}/${merged.checked}` : null;
  merged.mismatches = merged.mismatches.slice(0, 6);
  return { ...merged, algorithm: `sha256("59cf53e54c78" + firstUserText[4,7,20] + "${VERSION}").slice(0,3)`, source: `CC ${VERSION} client code; equals packages/core/src/fingerprint.ts#ccBuildSuffix(…, "${VERSION}")` };
})();

// T10 (2.1.312 only): which feature flips `mid-conversation-tool-changes-2026-07-01` (measured, beta-midconv.json)
try {
  const beta = JSON.parse(readFileSync(join(OUT, "beta-midconv.json"), "utf8"));
  out.betaPolicy = {
    beta: beta.beta, trigger: beta.trigger, sampledAt: beta.sampledAt, digest: beta.digest,
    byFeature: beta.betaPolicy?.byFeature ?? null,
    verdicts: beta.verdicts ?? null,
    evidence: { file: "beta-midconv.json", source: `docs/evidence/cc-${VERSION}/beta-midconv.json`, grade: "sampled" },
    note: "measured: beta follows the attachments context (CLAUDE_CODE_DISABLE_ATTACHMENTS unset), not entrypoint and not MCP; every G9 sample ran with attachments disabled, which is why the cli samples never carried it.",
  };
} catch { /* beta-midconv not sampled for this version */ }
writeFileSync(join(OUT, "profiles.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify({
  version: VERSION,
  profiles: Object.fromEntries(Object.entries(out).filter(([k]) => k.startsWith("cc-")).map(([k, v]) => [k, { samples: v.samples, identityBlock: v.identityBlock, mainPromptLen: v.mainPromptLen, tools: v.tools?.length, toolsDigest: v.toolsDigest, betaPaths: v.betaSets.length, topLevelKeys: v.topLevelKeys.length, ccFields: v.ccFields.length, billing: v.billingSuffix?.matchRate }])),
  transport: { runtimeVersion: out.transport["x-stainless-runtime-version"], sdkVersion: out.transport["x-stainless-package-version"], userAgent: out.transport.userAgent },
  billing: out.billingSuffix,
}, null, 1));
