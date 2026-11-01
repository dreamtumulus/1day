import { loadStickyBinding, saveStickyBinding, sha256Hex, type Candidate } from "@1dayapi/core";
import { requestMessages } from "./conversation.js";
import type { ClientFormat } from "./upstream.js";

type Json = Record<string, any>;
const MAX_TURNS = 1024;
const MAX_PROBES = 64;
const MAX_BINDINGS_PER_SUCCESS = 32;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Json)
      .filter(([key]) => key !== "cache_control")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

export interface MerklePrefixes {
  values: string[];
  firstEligible: number;
}

/** Rolling hashes of every prefix; a later turn extends rather than changes earlier identities. */
export function merklePrefixes(body: Json, format: ClientFormat): MerklePrefixes | null {
  const messages = requestMessages(body, format).slice(0, MAX_TURNS);
  const turns: Json[] = [];
  if (body.system !== undefined) turns.push({ role: "system", content: body.system });
  if (body.instructions !== undefined) turns.push({ role: "system", content: body.instructions });
  turns.push(...messages.map((message) => ({
    role: message?.role ?? message?.type ?? "unknown",
    content: message?.content,
    ...(message?.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
    ...(message?.type !== undefined ? { type: message.type } : {}),
  })));
  const firstTurn = turns.findIndex((turn) => !["system", "developer"].includes(String(turn.role)));
  if (firstTurn < 0) return null;
  const values: string[] = [];
  let rolling = "1dayapi-merkle-prefix-v1";
  for (const turn of turns) {
    rolling = sha256Hex(`${rolling}:${sha256Hex(JSON.stringify(stable(turn)))}`);
    values.push(rolling);
  }
  return { values, firstEligible: firstTurn + 1 };
}

function key(namespace: string, prefix: string): string {
  return `merkle:${namespace}:${prefix}`;
}

export function orderByMerklePrefix(candidates: Candidate[], namespace: string | null, body: Json, format: ClientFormat, now = Date.now()): Candidate[] {
  if (!namespace) return candidates;
  const prepared = merklePrefixes(body, format);
  if (!prepared) return candidates;
  const start = Math.max(prepared.firstEligible - 1, prepared.values.length - MAX_PROBES);
  for (let i = prepared.values.length - 1; i >= start; i--) {
    const hit = loadStickyBinding(key(namespace, prepared.values[i]), now);
    if (!hit) continue;
    const index = candidates.findIndex((candidate) => candidate.id === hit.accountId);
    if (index > 0) return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
    if (index === 0) return candidates;
  }
  return candidates;
}

export function rememberMerklePrefix(namespace: string | null, body: Json, format: ClientFormat, accountId: string, expiresAt: number): void {
  if (!namespace) return;
  const prepared = merklePrefixes(body, format);
  if (!prepared) return;
  const start = Math.max(prepared.firstEligible - 1, prepared.values.length - MAX_BINDINGS_PER_SUCCESS);
  for (let i = start; i < prepared.values.length; i++) saveStickyBinding(key(namespace, prepared.values[i]), accountId, expiresAt);
}
