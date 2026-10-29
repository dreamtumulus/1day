// Per-API-key routing policy (docs/gateway.md §2b, 2026-10-29, migration 29: api_keys.policy_json).
//
// historyPolicy — what the gateway does with a request that carries prior turns this platform never
// served (a client switching upstreams mid-conversation, docs/team-isolation.md 对话归属):
//   reset        isolation default: a boundary is saved and only the latest question is forwarded,
//                the response says x-1day-context-reset: 1 (HTTP 200).
//   reject       409 history_unknown so a multi-upstream client can route the turn elsewhere.
//   passthrough  the history is forwarded as-is and the conversation is bound to whichever
//                organization serves it (the operator accepts the cross-org correlation risk).
// directOnly — the key never falls back to the worker path: a request that is not a genuine Claude
//   Code request is refused with 400 direct_only (listing what is missing) instead of being served by a
//   worker whose output differs from the direct path.
// probeIntercept — liveness probes (an identical tiny request repeated within the window, or any request
//   carrying `x-1day-probe: 1`) are answered by the platform from pool state instead of being sent to an
//   account (docs/gateway.md §2c, 2026-10-29: one probing client touched 63 accounts in an hour). Default on.

export const HISTORY_POLICIES = ["reset", "reject", "passthrough"] as const;
export type HistoryPolicy = (typeof HISTORY_POLICIES)[number];

export interface KeyPolicy {
  historyPolicy: HistoryPolicy;
  directOnly: boolean;
  probeIntercept: boolean;
}

export const DEFAULT_KEY_POLICY: KeyPolicy = Object.freeze({ historyPolicy: "reset", directOnly: false, probeIntercept: true });

/** Tolerant parse of `api_keys.policy_json`; unknown or malformed input yields the defaults. */
export function parseKeyPolicy(json: string | null | undefined): KeyPolicy {
  if (!json) return { ...DEFAULT_KEY_POLICY };
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const hp = typeof v.historyPolicy === "string" && (HISTORY_POLICIES as readonly string[]).includes(v.historyPolicy) ? (v.historyPolicy as HistoryPolicy) : "reset";
    return { historyPolicy: hp, directOnly: v.directOnly === true, probeIntercept: v.probeIntercept !== false };
  } catch {
    return { ...DEFAULT_KEY_POLICY };
  }
}
