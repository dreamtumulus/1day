/**
 * Claude Code request profiles (docs/canonical-implementation-spec-2026-11-01.md §6.1, WP1).
 *
 * A profile is the complete request shape one Claude Code build produces through one entrypoint. The direct
 * path (lane A) may only normalise *within* a profile — transport, device, machine, customer-made entrypoint —
 * never across versions; the canonical worker (lane B) runs the node's own binary and therefore always sends a
 * real profile. Only versions whose billing-suffix algorithm is known (`ccBuildSuffix`) can be edited at all.
 *
 * Data source: docs/evidence/cc-2.1.312/*.json (controlled probes, 2026-11-01) and docs/claude-code-compat.md
 * §11 (interactive `cli` captures, 2026-10-28). 2.1.312 entries are the G9 sampling (`docs/evidence/cc-2.1.312/profiles.json`,
 * 12 samples per profile, grade `sampled`); 2.1.300 entries are `interim` (single captures). Beta sets differ by model
 * family (haiku-4-5: 8 betas, different order, `thinking.enabled` + budget), hence `betaPolicy.byModel`. Probe T10
 * (2026-11-01): `mid-conversation-tool-changes-2026-07-01` is sent only with attachments enabled (4/4 vs 0/3), not
 * by entrypoint or MCP — hence `betaPolicy.byFeature.attachments`; the canonical worker runs with attachments off.
 */

import { CC_RUNTIME_VERSION, CC_SDK_VERSION, CC_VERSION } from "./fingerprint.js";

export const CC_PROFILE_ENTRYPOINTS = ["cli", "sdk-cli", "restricted"] as const;
export type CcProfileEntrypoint = (typeof CC_PROFILE_ENTRYPOINTS)[number];

export interface CcProfileEvidence {
  /** Evidence file (repo path) or capture note. */
  source: string;
  sampledAt: string;
  /** Digest of the request structure the evidence file records (its `digest` field). */
  digest: string;
  /** `interim` = placeholder until the ≥12-sample G9 run replaces it. */
  grade?: "interim" | "sampled";
}

export interface CcProfile {
  /** "cc-2.1.312-cli" | "cc-2.1.312-sdk-cli" | "cc-2.1.312-restricted" */
  profileId: string;
  ccVersion: string;
  sdkVersion: string;
  runtimeVersion: string;
  entrypoint: CcProfileEntrypoint;
  /** Ordered beta sets: `base` is what every main request carries; `byModel` / `byFeature` add to it. */
  betaPolicy: { base: string[]; byModel: Record<string, string[]>; byFeature: Record<string, string> };
  /** Accepted identity sentences (system[1]); the SDK entrypoint has an `--append-system-prompt` variant. */
  identityBlocks: string[];
  /** Observed main-prompt (system[2]) lengths; "" digest until sampled. */
  mainPromptLengths: number[];
  mainPromptDigest: string;
  toolsDigest: string;
  /** Tool names in wire order (G9 sample; the set varies with the model/features, the digest is of this list). */
  tools?: string[];
  /** Top-level body keys in wire order. */
  topLevelKeys: string[];
  /** The only billing algorithm this gateway can recompute (fingerprint.ts `ccBuildSuffix`); `cch` signing is not open. */
  billingAlgo: "suffix-v1";
  minVersionByModel: Record<string, string>;
  evidence: CcProfileEvidence[];
}

/**
 * Minimum Claude Code version Anthropic accepts per model (from its own 400s, `claude_code_version_too_old`):
 * opus-5-5 → 2.1.280 (2026-10-19), fable-5-1 → 2.1.251 (2026-10-19). Prefix match covers dated snapshots.
 */
export const CC_MIN_VERSION_BY_MODEL: Record<string, string> = {
  "claude-opus-5-5": "2.1.280",
  "claude-fable-5-1": "2.1.251",
};

const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const SDK_APPEND_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";

const SDK_CLI_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "per-turn-control-2026-07-01",
  "thinking-token-count-2026-05-13",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "thinking-display-updates-2026-08-18",
  "extended-cache-ttl-2025-04-11",
];
const TOP_LEVEL_KEYS = ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream"];

// 2.1.300 (docs/claude-code-compat.md §11, 2026-10-28 captures): same suffix algorithm (`ccBuildSuffix(…, "2.1.300")`
// reproduces the captured `.f23`), Bun 1.4.3 runtime, prompt-caching-scope still sent.
const SDK_CLI_BETAS_300 = ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "per-turn-control-2026-07-01", "effort-2025-11-24", "dangerous-tool-use-2026-09-03", "thinking-display-updates-2026-08-18", "afk-mode-2026-01-31", "extended-cache-ttl-2025-04-11"];
const CLI_BETAS_300 = ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14", "thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "per-turn-control-2026-07-01", "mid-conversation-tool-changes-2026-07-01", "effort-2025-11-24", "dangerous-tool-use-2026-09-03", "thinking-display-updates-2026-08-18", "afk-mode-2026-01-31", "extended-cache-ttl-2025-04-11"];
const EVIDENCE_300: CcProfileEvidence = { source: "docs/claude-code-compat.md §11 (2.1.300 captures 2026-10-28)", sampledAt: "2026-10-28T00:00:00Z", digest: "", grade: "interim" };

function profile(entrypoint: CcProfileEntrypoint, p: Partial<CcProfile>, version = CC_VERSION): CcProfile {
  return {
    profileId: ccProfileId(version, entrypoint),
    ccVersion: version,
    sdkVersion: CC_SDK_VERSION,
    runtimeVersion: CC_RUNTIME_VERSION,
    entrypoint,
    betaPolicy: { base: SDK_CLI_BETAS, byModel: {}, byFeature: { "--json-schema": "structured-outputs-2025-12-15" } },
    identityBlocks: [SDK_IDENTITY, SDK_APPEND_IDENTITY],
    mainPromptLengths: [],
    mainPromptDigest: "",
    toolsDigest: "",
    topLevelKeys: TOP_LEVEL_KEYS,
    billingAlgo: "suffix-v1",
    minVersionByModel: CC_MIN_VERSION_BY_MODEL,
    evidence: [],
    ...p,
  };
}

/** Known profiles, keyed by profileId. Only versions whose billing algorithm is asserted (`ccBuildSuffix`) belong here. */
export const CC_PROFILES: Readonly<Record<string, CcProfile>> = Object.freeze({
  [ccProfileId("2.1.300", "cli")]: profile("cli", { runtimeVersion: "v26.3.0", betaPolicy: { base: CLI_BETAS_300, byModel: {}, byFeature: {} }, identityBlocks: [CLI_IDENTITY], evidence: [EVIDENCE_300] }, "2.1.300"),
  [ccProfileId("2.1.300", "sdk-cli")]: profile("sdk-cli", { runtimeVersion: "v26.3.0", betaPolicy: { base: SDK_CLI_BETAS_300, byModel: {}, byFeature: {} }, evidence: [EVIDENCE_300] }, "2.1.300"),
  [ccProfileId(CC_VERSION, "cli")]: profile("cli", {
    // docs/evidence/cc-2.1.312/profiles.json (G9, 12 samples = 4 prompts × sonnet-5-5 / opus-5-5 / haiku-4-5, 2026-11-01)
    betaPolicy: { base: ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "per-turn-control-2026-07-01", "thinking-token-count-2026-05-13", "advanced-tool-use-2025-11-20", "effort-2025-11-24", "dangerous-tool-use-2026-09-03", "thinking-display-updates-2026-08-18", "afk-mode-2026-01-31", "extended-cache-ttl-2025-04-11"], byModel: {"claude-haiku-4-5": ["oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "claude-code-20250219", "thinking-token-count-2026-05-13", "advanced-tool-use-2025-11-20", "thinking-display-updates-2026-08-18", "extended-cache-ttl-2025-04-11"]}, byFeature: {"title-generation": "structured-outputs-2025-12-15", "attachments": "mid-conversation-tool-changes-2026-07-01"} },
    identityBlocks: ["You are Claude Code, Anthropic's official CLI for Claude."],
    mainPromptLengths: [5854, 27282],
    mainPromptDigest: "f2265d048e328235",
    toolsDigest: "51d4b5a2143407cb",
    tools: ["Agent", "AskUserQuestion", "Bash", "Edit", "ListAgents", "Read", "ReportFindings", "ScheduleWakeup", "Skill", "ToolSearch", "Workflow", "DeferredToolPlaceholder", "Write"],
    topLevelKeys: ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "safeguards", "output_config", "stream"],
    evidence: [{"source": "docs/evidence/cc-2.1.312/profile-cli-cli-01.json", "sampledAt": "2026-11-01T13:41:04.583Z", "digest": "65c409405762e04d", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-02.json", "sampledAt": "2026-11-01T13:41:29.511Z", "digest": "2c1555b2387c4fae", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-03.json", "sampledAt": "2026-11-01T13:41:54.430Z", "digest": "3a5228618e821c00", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-04.json", "sampledAt": "2026-11-01T13:42:19.490Z", "digest": "688dbe83aef360ad", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-05.json", "sampledAt": "2026-11-01T13:42:44.563Z", "digest": "e25ae128396557f1", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-06.json", "sampledAt": "2026-11-01T13:43:09.404Z", "digest": "9f54b73ed4402228", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-07.json", "sampledAt": "2026-11-01T13:43:34.492Z", "digest": "8743d67b98fbb9e6", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-08.json", "sampledAt": "2026-11-01T13:43:59.444Z", "digest": "de1fed8368329f57", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-09.json", "sampledAt": "2026-11-01T13:44:24.391Z", "digest": "9a5485a50e740948", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-10.json", "sampledAt": "2026-11-01T13:44:49.251Z", "digest": "b9e7693f86d706c1", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-11.json", "sampledAt": "2026-11-01T13:45:14.222Z", "digest": "754b03f81594f606", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/profile-cli-cli-12.json", "sampledAt": "2026-11-01T13:45:39.264Z", "digest": "b85989d543e3f1ec", "grade": "sampled"}],
  }),
  [ccProfileId(CC_VERSION, "sdk-cli")]: profile("sdk-cli", {
    // docs/evidence/cc-2.1.312/profiles.json (G9, 12 samples = 4 prompts × sonnet-5-5 / opus-5-5 / haiku-4-5, 2026-11-01)
    betaPolicy: { base: ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "per-turn-control-2026-07-01", "thinking-token-count-2026-05-13", "advanced-tool-use-2025-11-20", "effort-2025-11-24", "thinking-display-updates-2026-08-18", "extended-cache-ttl-2025-04-11"], byModel: {"claude-haiku-4-5": ["oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "claude-code-20250219", "thinking-token-count-2026-05-13", "advanced-tool-use-2025-11-20", "thinking-display-updates-2026-08-18", "extended-cache-ttl-2025-04-11"]}, byFeature: {"--json-schema": "structured-outputs-2025-12-15", "attachments": "mid-conversation-tool-changes-2026-07-01"} },
    identityBlocks: ["You are a Claude agent, built on Anthropic's Claude Agent SDK.", "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."],
    mainPromptLengths: [5599, 26946],
    mainPromptDigest: "c033f0aeb97f2b54",
    toolsDigest: "2106a37964466cf3",
    tools: ["Agent", "Bash", "Edit", "ListAgents", "Read", "ReportFindings", "ScheduleWakeup", "Skill", "ToolSearch", "Workflow", "DeferredToolPlaceholder", "Write"],
    topLevelKeys: ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream"],
    evidence: [{"source": "docs/evidence/cc-2.1.312/baseline-sdk-01.json", "sampledAt": "2026-11-01T13:38:17.125Z", "digest": "a7ee6bfee5066e70", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-02.json", "sampledAt": "2026-11-01T13:38:18.936Z", "digest": "027fc1bb4e9451cd", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-03.json", "sampledAt": "2026-11-01T13:38:20.714Z", "digest": "82e22136465d2620", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-04.json", "sampledAt": "2026-11-01T13:38:22.495Z", "digest": "cdfb451c1e95b072", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-05.json", "sampledAt": "2026-11-01T13:38:24.321Z", "digest": "af4a555a1912208a", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-06.json", "sampledAt": "2026-11-01T13:38:26.077Z", "digest": "33d781cb0595bd84", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-07.json", "sampledAt": "2026-11-01T13:38:27.852Z", "digest": "691b4fe8f522f3f9", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-08.json", "sampledAt": "2026-11-01T13:38:29.624Z", "digest": "c22d7363ee523c28", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-09.json", "sampledAt": "2026-11-01T13:38:31.385Z", "digest": "50eae3decde32f09", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-10.json", "sampledAt": "2026-11-01T13:38:33.186Z", "digest": "d66b0c50726e1d87", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-11.json", "sampledAt": "2026-11-01T13:38:35.048Z", "digest": "f03bf0397738fb09", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/baseline-sdk-12.json", "sampledAt": "2026-11-01T13:38:36.822Z", "digest": "f0c5bffaed206b2f", "grade": "sampled"}],
  }),
  [ccProfileId(CC_VERSION, "restricted")]: profile("restricted", {
    // docs/evidence/cc-2.1.312/profiles.json (G9, 12 samples = 4 prompts × sonnet-5-5 / opus-5-5 / haiku-4-5, 2026-11-01)
    betaPolicy: { base: ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "per-turn-control-2026-07-01", "thinking-token-count-2026-05-13", "advanced-tool-use-2025-11-20", "effort-2025-11-24", "thinking-display-updates-2026-08-18", "extended-cache-ttl-2025-04-11"], byModel: {"claude-haiku-4-5": ["oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "claude-code-20250219", "thinking-token-count-2026-05-13", "advanced-tool-use-2025-11-20", "thinking-display-updates-2026-08-18", "extended-cache-ttl-2025-04-11"]}, byFeature: {"--json-schema": "structured-outputs-2025-12-15", "attachments": "mid-conversation-tool-changes-2026-07-01"} },
    identityBlocks: ["You are a Claude agent, built on Anthropic's Claude Agent SDK."],
    mainPromptLengths: [3513, 14138],
    mainPromptDigest: "635d9d17f2409f3f",
    toolsDigest: "60c5d5dd0a586e3a",
    tools: ["Agent", "Edit", "Glob", "Grep", "ListAgents", "Read", "ReportFindings", "ScheduleWakeup", "Skill", "ToolSearch", "DeferredToolPlaceholder", "Write"],
    topLevelKeys: ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream"],
    evidence: [{"source": "docs/evidence/cc-2.1.312/restricted-res-01.json", "sampledAt": "2026-11-01T13:39:10.672Z", "digest": "fba2c9c95a2a3d60", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-02.json", "sampledAt": "2026-11-01T13:39:12.433Z", "digest": "17d6c42bd2b9a094", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-03.json", "sampledAt": "2026-11-01T13:39:14.219Z", "digest": "36582a265099d6a9", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-04.json", "sampledAt": "2026-11-01T13:39:15.954Z", "digest": "4bd772471036b61a", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-05.json", "sampledAt": "2026-11-01T13:39:17.704Z", "digest": "656c26b7643652b4", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-06.json", "sampledAt": "2026-11-01T13:39:20.002Z", "digest": "b8e198b69a6c95c3", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-07.json", "sampledAt": "2026-11-01T13:39:21.742Z", "digest": "9a6ebbfd313c7899", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-08.json", "sampledAt": "2026-11-01T13:39:23.524Z", "digest": "77af9f837a4e8a44", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-09.json", "sampledAt": "2026-11-01T13:39:25.332Z", "digest": "612882e73a6709e1", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-10.json", "sampledAt": "2026-11-01T13:39:27.104Z", "digest": "de66f9984b6d5879", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-11.json", "sampledAt": "2026-11-01T13:39:28.871Z", "digest": "bdbd130a0c43678f", "grade": "sampled"}, {"source": "docs/evidence/cc-2.1.312/restricted-res-12.json", "sampledAt": "2026-11-01T13:39:30.667Z", "digest": "4f23f024b1406243", "grade": "sampled"}],
  }),
});

export function ccProfileId(version: string, entrypoint: CcProfileEntrypoint): string {
  return `cc-${version}-${entrypoint}`;
}

/** Versions with at least one known profile (and therefore a known billing algorithm). */
export const CC_KNOWN_VERSIONS: readonly string[] = Object.freeze([...new Set(Object.values(CC_PROFILES).map((p) => p.ccVersion))]);

export function knownCcProfile(version: string, entrypoint: string): CcProfile | null {
  return CC_PROFILES[`cc-${version}-${entrypoint}`] ?? null;
}

/**
 * Which wire profile a request belongs to, from its UA entrypoint and identity sentence. A customer-made
 * entrypoint ("mirasim") carries whichever body its embedding produced, so the identity sentence decides;
 * official SDK entrypoints other than cli / sdk-cli (sdk-ts, sdk-py, IDE plugins) have no sampled profile → null.
 */
export function ccProfileFor(version: string, uaEntrypoint: string, identityBlock: string): CcProfile | null {
  if (uaEntrypoint === "cli" || uaEntrypoint === "sdk-cli") return knownCcProfile(version, uaEntrypoint);
  if (/^(sdk-ts|sdk-py|claude-vscode|claude-jetbrains|claude-desktop|claude-desktop-3p|local-agent)$/.test(uaEntrypoint)) return null;
  if (identityBlock === CLI_IDENTITY) return knownCcProfile(version, "cli");
  if (identityBlock === SDK_IDENTITY || identityBlock === SDK_APPEND_IDENTITY) return knownCcProfile(version, "sdk-cli");
  return null;
}

/** Transport constants a given Claude Code build sends (runtime = embedded Bun's Node ABI string, SDK package version). */
export function ccTransportFor(version: string): { runtimeVersion: string; sdkVersion: string } | null {
  const p = knownCcProfile(version, "cli") ?? knownCcProfile(version, "sdk-cli");
  return p ? { runtimeVersion: p.runtimeVersion, sdkVersion: p.sdkVersion } : null;
}

/** Same build, same entrypoint family: the only normalisation the direct path may perform (no cross-version pin). */
export function sameCcProfile(a: CcProfile | null, b: CcProfile | null): boolean {
  return !!a && !!b && a.profileId === b.profileId;
}
