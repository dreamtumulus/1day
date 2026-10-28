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

/** Immutable claim: removing a pool member or account cannot make this resource virgin. */
export function claimProxyResource(resourceKey: string, teamId: string): void {
  if (one("SELECT 1 FROM proxy_quarantine WHERE resource_key=?", resourceKey)) throw new Error("proxy_quarantined");
  run("INSERT OR IGNORE INTO proxy_team_claims(resource_key,team_id) VALUES (?,?)", resourceKey, teamId);
  if (one<{ team_id: string }>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?", resourceKey)?.team_id !== teamId) {
    throw new Error("proxy_team_mismatch");
  }
}
