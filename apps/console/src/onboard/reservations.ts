import { all, claimProxyResource, ensureUpstreamTeam, nowIso, one, quarantineResource, recordProxyTeamEvent, run, getSetting } from "@1dayapi/core";

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

/**
 * Failure classes (docs/onboarding.md §12.1). Only an upstream verdict on an exit that
 * actually went out can taint it: the upstream saw the exit with a credential it rejected,
 * or the organization it answered with differs from the reservation. Platform-side
 * failures (node offline, reservation expired, operator cancel, duplicate account, bad
 * callback, proxy bookkeeping) say nothing about the exit and only release the slot —
 * quarantining them burned four proxies on 2026-10-28 for a heartbeat race.
 */
const EXIT_TAINTING_CODES = new Set([
  "session_key_invalid", "session_stale_relogin", "authorize_failed", "token_exchange_failed",
  "validate_failed", "team_mismatch", "cloudflare_challenge", "organization_mismatch",
  "oauth_verification_failed",
]);
export function failureTaintsExit(code: string): boolean {
  return EXIT_TAINTING_CODES.has(code);
}

/**
 * Jobs interrupted by a console restart (review fix 2026-11-10). The failure is the platform's own and carries no
 * verdict at all, not even "unknown egress": the reservation is released and the exit is never quarantined.
 */
export const CONSOLE_RESTART_CODE = "console_restarted";
const NEVER_QUARANTINE_CODES = new Set([CONSOLE_RESTART_CODE]);

/** Idempotent terminal transition; a late runner cannot overwrite cancel/done. */
export function endReservation(jobId: string, code: string, message: string): boolean {
  const j = one<{ id:string; isolation_version:number; status:string; team_id:string|null; proxy_resource_key:string|null; proxy_id:string|null; node_id:string; requester_id:string|null; egress_started_at:string|null }>("SELECT * FROM onboarding_jobs WHERE id=?", jobId);
  if (!j || j.isolation_version !== 1 || !["working", "pending_callback"].includes(j.status)) return false;
  const claimed = j.proxy_resource_key ? one<{team_id:string}>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?", j.proxy_resource_key) : undefined;
  const wentOut = !!j.egress_started_at && !!j.proxy_resource_key;
  const unclaimedOrForeign = !claimed || claimed.team_id !== j.team_id || code === "team_mismatch";
  // A touched exit never becomes virgin again. Three outcomes:
  //  - upstream verdict (tainting code) or an exit already owned by another organization → quarantine;
  //  - platform-side failure with the organization specified by the operator → the exit is
  //    claimed for that organization (reusable by its own accounts, never by another);
  //  - platform-side failure with no organization known → quarantine (unknown egress).
  let outcome: "quarantined" | "kept_for_team" | "released" = "released";
  // settings proxy_quarantine_on_failure=0 (2026-11-06): a failed authorization never taints the exit; the slot is released.
  const quarantineOn = getSetting("proxy_quarantine_on_failure").trim() !== "0" && !NEVER_QUARANTINE_CODES.has(code);
  if (quarantineOn && wentOut && unclaimedOrForeign) {
    const foreign = !!claimed && claimed.team_id !== j.team_id;
    if (failureTaintsExit(code) || foreign || !j.team_id) outcome = "quarantined";
    else {
      try {
        ensureUpstreamTeam(j.team_id);
        claimProxyResource(j.proxy_resource_key!, j.team_id);
        outcome = "kept_for_team";
      } catch {
        outcome = "quarantined";
      }
    }
  }
  if (outcome === "quarantined") {
    for (const resource of [j.proxy_resource_key!, `proxy:${j.proxy_id}`])
      quarantineResource(resource, code);
    recordProxyTeamEvent({resourceKey:j.proxy_resource_key!,proxyId:j.proxy_id,nodeId:j.node_id,teamId:j.team_id,jobId,event:"quarantined",reason:code});
  } else if (outcome === "kept_for_team") {
    recordProxyTeamEvent({resourceKey:j.proxy_resource_key!,proxyId:j.proxy_id,nodeId:j.node_id,teamId:j.team_id,jobId,event:"exit_kept_for_team",
      reason:`${code}: platform-side failure after egress; exit claimed for the specified organization instead of quarantined`});
  }
  const changed = run("UPDATE onboarding_jobs SET status='failed', error=?, payload_enc=NULL, authorize_url=NULL, updated_at=? WHERE id=? AND isolation_version=1 AND status IN ('working','pending_callback')", `${code}: ${message}`.slice(0,500), nowIso(), jobId).changes;
  if (changed && j.proxy_resource_key) recordProxyTeamEvent({resourceKey:j.proxy_resource_key,proxyId:j.proxy_id,nodeId:j.node_id,teamId:j.team_id,jobId,actorId:j.requester_id,event:"slot_released",
    reason:`${code}; ${outcome === "quarantined" ? "exit quarantined" : outcome === "kept_for_team" ? "exit kept for the specified organization (platform-side failure, not tainted)" : wentOut ? (NEVER_QUARANTINE_CODES.has(code) ? "released (interrupted by a console restart; exit not quarantined)" : "released (quarantine on failure disabled)") : "released before egress"}`});
  return changed > 0;
}

/** Called independently and at admission/commit, even when OAuth maintenance is disabled. */
export function expireJobReservations(now = Date.now()): string[] {
  const stale = all<{id:string;node_id:string;status:string}>(`SELECT j.id,j.node_id,j.status FROM onboarding_jobs j WHERE j.isolation_version=1 AND j.status IN ('working','pending_callback') AND ${reservationDeadlineSql()}<=?`, new Date(now).toISOString().slice(0,19)+"Z");
  const nodes = new Set<string>();
  for (const j of stale) if (endReservation(j.id, j.status === "working" ? "job_expired" : "callback_expired", "Authorization reservation expired")) nodes.add(j.node_id);
  return [...nodes];
}
