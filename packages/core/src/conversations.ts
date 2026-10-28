import { randomUUID } from "node:crypto";
import { one, run, tx } from "./db.js";
import { nowIso } from "./time.js";

/** Durable routing ownership. A lease fences every request, including blue/green gateways. */
export interface ConversationRow {
  id: string;
  api_key_id: string;
  external_key: string;
  generation: number;
  team_id: string | null;
  reset_anchor: string | null;
  reset_prefix: string | null;
  reset_active: number;
  state: string;
  lease_token: string | null;
  lease_until: number;
  created_at: string;
  updated_at: string;
}

export function getConversation(id: string): ConversationRow | undefined {
  return one<ConversationRow>("SELECT * FROM conversations WHERE id = ?", id);
}

export function getConversationByExternalKey(apiKeyId: string, externalKey: string): ConversationRow | undefined {
  return one<ConversationRow>("SELECT * FROM conversations WHERE api_key_id = ? AND external_key = ?", apiKeyId, externalKey);
}

export interface ConversationBoundary {
  conversation_id: string;
  generation: number;
  branch_key: string;
  anchor: string | null;
  prefix: string | null;
  nonce: string;
}

export function getConversationBoundary(id: string, generation: number, branch: string): ConversationBoundary | undefined {
  return one<ConversationBoundary>("SELECT * FROM conversation_boundaries WHERE conversation_id = ? AND generation = ? AND branch_key = ?", id, generation, branch);
}

export function saveBranchBoundary(id: string, token: string, generation: number, branch: string, anchor: string | null, prefix: string | null): ConversationBoundary {
  return tx(() => {
    locked(id, token, generation);
    const now = nowIso();
    run(`INSERT INTO conversation_boundaries (conversation_id,generation,branch_key,anchor,prefix,nonce,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id,generation,branch_key) DO UPDATE SET anchor=excluded.anchor,prefix=excluded.prefix,nonce=excluded.nonce,updated_at=excluded.updated_at`, id, generation, branch, anchor, prefix, randomUUID(), now, now);
    return getConversationBoundary(id, generation, branch)!;
  });
}

export function isConversationGenerationActive(id: string, teamId: string, generation: number): boolean {
  return !!one("SELECT 1 FROM conversations WHERE id = ? AND team_id = ? AND generation = ? AND state = 'active'", id, teamId, generation);
}

export function acquireConversationLease(apiKeyId: string, externalKey: string, token: string, now = Date.now(), leaseMs = 120_000): ConversationRow | null {
  return tx(() => {
    const time = nowIso();
    run(`INSERT INTO conversations (id, api_key_id, external_key, generation, state, lease_until, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'active', 0, ?, ?) ON CONFLICT(api_key_id, external_key) DO NOTHING`, randomUUID(), apiKeyId, externalKey, time, time);
    const row = one<ConversationRow>("SELECT * FROM conversations WHERE api_key_id = ? AND external_key = ?", apiKeyId, externalKey)!;
    if (row.lease_token && row.lease_token !== token && row.lease_until > now) return null;
    run("UPDATE conversations SET lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?", token, now + leaseMs, time, row.id);
    return getConversation(row.id)!;
  });
}

export function renewConversationLease(id: string, token: string, now = Date.now(), leaseMs = 120_000): boolean {
  return run("UPDATE conversations SET lease_until = ? WHERE id = ? AND lease_token = ? AND lease_until > ?", now + leaseMs, id, token, now).changes === 1;
}

export function releaseConversationLease(id: string, token: string): void {
  run("UPDATE conversations SET lease_token = NULL, lease_until = 0 WHERE id = ? AND lease_token = ?", id, token);
}

export function conversationLeaseHeld(id: string, token: string, generation: number): boolean {
  return !!one("SELECT 1 FROM conversations WHERE id = ? AND lease_token = ? AND lease_until > ? AND generation = ? AND state = 'active'", id, token, Date.now(), generation);
}

function locked(id: string, token: string, generation: number): ConversationRow {
  const row = getConversation(id);
  if (!row || row.lease_token !== token || row.lease_until <= Date.now() || row.generation !== generation || row.state !== "active") throw new Error("conversation lease lost");
  return row;
}

export function bindConversationTeam(id: string, token: string, generation: number, teamId: string): ConversationRow {
  return tx(() => {
    const row = locked(id, token, generation);
    if (row.team_id && row.team_id !== teamId) throw new Error("conversation team already fixed");
    const now = nowIso();
    run("UPDATE conversations SET team_id = ?, updated_at = ? WHERE id = ?", teamId, now, id);
    run(`INSERT INTO conversation_generations (conversation_id, generation, team_id, reset_reason, created_at)
      VALUES (?, ?, ?, NULL, ?) ON CONFLICT(conversation_id, generation) DO NOTHING`, id, generation, teamId, now);
    return getConversation(id)!;
  });
}

/** Boundary fingerprints are written even on a fresh generation with an uncertain client id. */
export function saveConversationBoundary(id: string, token: string, generation: number, anchor: string | null, prefix: string | null): ConversationRow {
  return tx(() => {
    locked(id, token, generation);
    run("UPDATE conversations SET reset_active = 1, reset_anchor = ?, reset_prefix = ?, updated_at = ? WHERE id = ?", anchor, prefix, nowIso(), id);
    return getConversation(id)!;
  });
}

/** The caller commits the new generation before opening any new-team transport. */
export function resetConversationGeneration(id: string, token: string, generation: number, teamId: string, anchor: string | null, prefix: string | null, reason: string): ConversationRow {
  return tx(() => {
    locked(id, token, generation);
    const now = nowIso();
    run("UPDATE conversations SET generation = generation + 1, team_id = ?, reset_active = 1, reset_anchor = ?, reset_prefix = ?, updated_at = ? WHERE id = ?", teamId, anchor, prefix, now, id);
    run("INSERT INTO conversation_generations (conversation_id, generation, team_id, reset_reason, created_at) VALUES (?, ?, ?, ?, ?)", id, generation + 1, teamId, reason, now);
    return getConversation(id)!;
  });
}
