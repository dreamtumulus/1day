import { all, nowIso, one, recordProxyTeamEvent, run } from "@1dayapi/core";

export const PENDING_CALLBACK_TTL_MS = 30 * 60_000;
export const WORKING_JOB_TTL_MS = 3 * 60_000;

/** Existing managed jobs can expire without rewriting their historical rows. */
export function reservationDeadlineSql(alias = "j"): string {
  return `COALESCE(${alias}.expires_at, strftime('%Y-%m-%dT%H:%M:%SZ', CASE WHEN ${alias}.status='working' THEN ${alias}.updated_at ELSE ${alias}.created_at END, CASE WHEN ${alias}.status='working' THEN '+180 seconds' ELSE '+1800 seconds' END))`;
}
export function liveReservationSql(alias = "j"): string {
  return `${alias}.isolation_version=1 AND ${alias}.status IN ('working','pending_callback') AND ${reservationDeadlineSql(alias)}>strftime('%Y-%m-%dT%H:%M:%SZ','now')`;
}
export function reservationDeadline(status: "working" | "pending_callback"): string {
  return new Date(Date.now() + (status === "working" ? WORKING_JOB_TTL_MS : PENDING_CALLBACK_TTL_MS)).toISOString().slice(0, 19) + "Z";
}

/** Idempotent terminal transition; a late runner cannot overwrite cancel/done. */
export function endReservation(jobId: string, code: string, message: string): boolean {
  const j = one<{ id:string; isolation_version:number; status:string; team_id:string|null; proxy_resource_key:string|null; proxy_id:string|null; node_id:string; requester_id:string|null; egress_started_at:string|null }>("SELECT * FROM onboarding_jobs WHERE id=?", jobId);
  if (!j || j.isolation_version !== 1 || !["working", "pending_callback"].includes(j.status)) return false;
  const claimed = j.proxy_resource_key ? one<{team_id:string}>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?", j.proxy_resource_key) : undefined;
  if (j.egress_started_at && j.proxy_resource_key && (!claimed || claimed.team_id !== j.team_id || code === "team_mismatch")) {
    for (const resource of [j.proxy_resource_key, `proxy:${j.proxy_id}`])
      run("INSERT OR IGNORE INTO proxy_quarantine(resource_key,reason) VALUES (?,?)", resource, code.slice(0,200));
    recordProxyTeamEvent({resourceKey:j.proxy_resource_key,proxyId:j.proxy_id,nodeId:j.node_id,teamId:j.team_id,jobId,event:"quarantined",reason:code});
  }
  const changed = run("UPDATE onboarding_jobs SET status='failed', error=?, payload_enc=NULL, authorize_url=NULL, updated_at=? WHERE id=? AND isolation_version=1 AND status IN ('working','pending_callback')", `${code}: ${message}`.slice(0,500), nowIso(), jobId).changes;
  if (changed && j.proxy_resource_key) recordProxyTeamEvent({resourceKey:j.proxy_resource_key,proxyId:j.proxy_id,nodeId:j.node_id,teamId:j.team_id,jobId,actorId:j.requester_id,event:"slot_released",reason:code});
  return changed > 0;
}

/** Called independently and at admission/commit, even when OAuth maintenance is disabled. */
export function expireJobReservations(now = Date.now()): string[] {
  const stale = all<{id:string;node_id:string;status:string}>(`SELECT j.id,j.node_id,j.status FROM onboarding_jobs j WHERE j.isolation_version=1 AND j.status IN ('working','pending_callback') AND ${reservationDeadlineSql()}<=?`, new Date(now).toISOString().slice(0,19)+"Z");
  const nodes = new Set<string>();
  for (const j of stale) if (endReservation(j.id, j.status === "working" ? "job_expired" : "callback_expired", "Authorization reservation expired")) nodes.add(j.node_id);
  return [...nodes];
}
