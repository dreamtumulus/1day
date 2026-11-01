import { one, run } from "./db.js";
import { newId } from "./crypto.js";
import { nowIso } from "./time.js";

/** The upstream organization's UUID, never a billing group or provider id. */
export function normalizeTeamId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
    ? value.trim().toLowerCase() : null;
}

export function ensureUpstreamTeam(id: string, name?: string | null): void {
  if (normalizeTeamId(id) !== id) throw new Error("team_identity_invalid");
  run("INSERT OR IGNORE INTO upstream_teams(id,name) VALUES (?,?)", id, name?.trim().slice(0, 200) || null);
  if (name !== undefined) run("UPDATE upstream_teams SET name = ? WHERE id = ?", name?.trim().slice(0, 200) || null, id);
  if (one<{ status: string }>("SELECT status FROM upstream_teams WHERE id=?", id)?.status !== "active") throw new Error("team_disabled");
}

export function recordProxyTeamEvent(event: {
  resourceKey: string; proxyId?: string | null; nodeId?: string | null;
  teamId?: string | null; accountId?: string | null; jobId?: string | null; event: string;
  actorId?: string | null; reason?: string | null;
}): void {
  run(`INSERT INTO proxy_team_events(id,resource_key,proxy_id,node_id,team_id,account_id,job_id,event,actor_id,reason,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, newId(), event.resourceKey, event.proxyId ?? null,
    event.nodeId ?? null, event.teamId ?? null, event.accountId ?? null, event.jobId ?? null, event.event,
    event.actorId ?? null,event.reason ?? null,nowIso());
}

/**
 * Quarantine is append-only history (migration 21 triggers); an operator lifts it with a
 * row in proxy_quarantine_lifts (migration 25) instead of deleting the verdict. A quarantine
 * is ACTIVE when it has no lift; re-quarantining a lifted key removes the lift again.
 */
export function quarantineActive(...resourceKeys: string[]): { resource_key: string; reason: string } | undefined {
  const keys = resourceKeys.filter((k): k is string => typeof k === "string" && !!k);
  if (!keys.length) return undefined;
  return one<{ resource_key: string; reason: string }>(
    `SELECT q.resource_key, q.reason FROM proxy_quarantine q
      WHERE q.resource_key IN (${keys.map(() => "?").join(",")})
        AND NOT EXISTS (SELECT 1 FROM proxy_quarantine_lifts l WHERE l.resource_key = q.resource_key)
      ORDER BY q.created_at LIMIT 1`,
    ...keys,
  );
}
export function quarantineResource(resourceKey: string, reason: string): void {
  run("INSERT OR IGNORE INTO proxy_quarantine(resource_key,reason) VALUES (?,?)", resourceKey, reason.slice(0, 200));
  run("DELETE FROM proxy_quarantine_lifts WHERE resource_key=?", resourceKey);
}
/** Operator decision: lifts every active quarantine among `resourceKeys`; returns how many were lifted. */
export function liftQuarantine(resourceKeys: string[], actorId: string | null, reason: string | null): number {
  let n = 0;
  for (const key of resourceKeys) {
    if (!quarantineActive(key)) continue;
    run("INSERT OR REPLACE INTO proxy_quarantine_lifts(resource_key,lifted_at,actor_id,reason) VALUES (?,?,?,?)", key, nowIso(), actorId, reason);
    n += 1;
  }
  return n;
}

/**
 * Claim: removing a pool member or account does not make this resource virgin. Since 2026-11-01 an operator
 * can release an unused claim (console `releaseTeamClaims`, history in proxy_team_claim_releases); only then
 * may another organization claim the exit.
 */
export function claimProxyResource(resourceKey: string, teamId: string): void {
  if (quarantineActive(resourceKey)) throw new Error("proxy_quarantined");
  run("INSERT OR IGNORE INTO proxy_team_claims(resource_key,team_id) VALUES (?,?)", resourceKey, teamId);
  if (one<{ team_id: string }>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?", resourceKey)?.team_id !== teamId) {
    throw new Error("proxy_team_mismatch");
  }
}
