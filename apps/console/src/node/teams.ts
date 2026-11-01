// Organizations as an operations object (2026-11-01, "多小组织 / 一号一组织", docs/team-isolation.md):
// per-organization overview, exit-claim release, node-side cleanup. Organization = upstream_teams row (the real
// Claude organization UUID); claims = proxy_team_claims (exit IP → organization), released through
// proxy_team_claim_releases (append-only history, migration 34).
import { all, getSetting, newId, nowIso, one, recordProxyTeamEvent, run, tx } from "@1dayapi/core";
import { liveReservationSql } from "../onboard/reservations.js";

export interface TeamClaim {
  resourceKey: string;
  exitIp: string | null;
  claimedAt: string;
  proxies: Array<{ id: string; nodeId: string; status: string }>;
  boundAccounts: number;
  reserved: number;
  /** Newest account_bound / account_released / slot_reserved / discovery event on this exit, if any. */
  lastActivityAt: string | null;
  releasable: boolean;
  /** Why it is not releasable right now (null when releasable). */
  blocker: "bound_accounts" | "live_reservation" | "too_recent" | null;
}

/** settings team_claim_release_min_days (0 = no waiting period). */
export function claimReleaseMinDays(): number {
  const n = Number(getSetting("team_claim_release_min_days"));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
}

export function teamClaims(teamId: string): TeamClaim[] {
  const minDays = claimReleaseMinDays();
  const cutoff = new Date(Date.now() - minDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return all<{ resource_key: string; claimed_at: string }>("SELECT resource_key, claimed_at FROM proxy_team_claims WHERE team_id=? ORDER BY claimed_at", teamId).map((c) => {
    const proxies = all<{ id: string; node_id: string; status: string; exit_ip: string | null }>("SELECT id, node_id, status, exit_ip FROM node_proxies WHERE resource_key=?", c.resource_key);
    const ids = proxies.map((p) => p.id);
    const bound = ids.length ? one<{ n: number }>(`SELECT COUNT(*) n FROM accounts WHERE bound_proxy_id IN (${ids.map(() => "?").join(",")})`, ...ids)?.n ?? 0 : 0;
    const reserved = one<{ n: number }>(`SELECT COUNT(*) n FROM onboarding_jobs j WHERE j.proxy_resource_key=? AND ${liveReservationSql()}`, c.resource_key)?.n ?? 0;
    const last = one<{ t: string | null }>(
      // account activity only: exit measurements (exit_observed) happen on every heartbeat change and are not usage
      `SELECT MAX(created_at) t FROM proxy_team_events WHERE resource_key=? AND event IN ('account_bound','account_released','slot_reserved','discovery_slot_released','account_frozen_proxy_down','account_proxy_released')`,
      c.resource_key,
    )?.t ?? null;
    const blocker: TeamClaim["blocker"] = bound > 0 ? "bound_accounts" : reserved > 0 ? "live_reservation" : minDays > 0 && last !== null && last > cutoff ? "too_recent" : null;
    return {
      resourceKey: c.resource_key,
      exitIp: proxies.find((p) => p.exit_ip)?.exit_ip ?? (c.resource_key.startsWith("ip:") ? c.resource_key.slice(3) : null),
      claimedAt: c.claimed_at,
      proxies: proxies.map((p) => ({ id: p.id, nodeId: p.node_id, status: p.status })),
      boundAccounts: bound,
      reserved,
      lastActivityAt: last,
      releasable: blocker === null,
      blocker,
    };
  });
}

export interface ClaimReleaseResult {
  released: string[];
  skipped: Array<{ resourceKey: string; blocker: string }>;
  /** Nodes whose proxy policy changed (the caller pushes the pool to them). */
  nodeIds: string[];
}

/**
 * Operator release of an organization's exit claims. Only claims with no bound account and no live reservation are
 * released; the waiting period (team_claim_release_min_days) can be overridden with `force` (still only when
 * unused). The claim row goes away, the release is recorded (append-only), the row-level team tag on the pool
 * members is cleared so the exit is virgin again for discovery / another organization.
 */
export function releaseTeamClaims(teamId: string, opts: { resourceKeys?: string[]; actorId: string | null; reason?: string | null; force?: boolean }): ClaimReleaseResult {
  const wanted = opts.resourceKeys?.length ? new Set(opts.resourceKeys) : null;
  const result: ClaimReleaseResult = { released: [], skipped: [], nodeIds: [] };
  tx(() => {
    for (const c of teamClaims(teamId)) {
      if (wanted && !wanted.has(c.resourceKey)) continue;
      const blocker = c.blocker === "too_recent" && opts.force ? null : c.blocker;
      if (blocker) { result.skipped.push({ resourceKey: c.resourceKey, blocker }); continue; }
      run("INSERT INTO proxy_team_claim_releases(id,resource_key,team_id,claimed_at,released_at,actor_id,reason) VALUES (?,?,?,?,?,?,?)",
        newId(), c.resourceKey, teamId, c.claimedAt, nowIso(), opts.actorId, (opts.reason ?? (opts.force ? "operator release (waiting period overridden)" : "operator release")).slice(0, 300));
      run("DELETE FROM proxy_team_claims WHERE resource_key=? AND team_id=?", c.resourceKey, teamId);
      run("UPDATE node_proxies SET team_id=NULL WHERE resource_key=? AND team_id=?", c.resourceKey, teamId);
      for (const p of c.proxies) {
        // the per-proxy claim key ("proxy:<id>") follows the exit's claim (release row first: the delete trigger insists)
        const pk = `proxy:${p.id}`;
        const pc = one<{ claimed_at: string }>("SELECT claimed_at FROM proxy_team_claims WHERE resource_key=? AND team_id=?", pk, teamId);
        if (pc) {
          run("INSERT INTO proxy_team_claim_releases(id,resource_key,team_id,claimed_at,released_at,actor_id,reason) VALUES (?,?,?,?,?,?,?)", newId(), pk, teamId, pc.claimed_at, nowIso(), opts.actorId, `follows the release of ${c.resourceKey}`);
          run("DELETE FROM proxy_team_claims WHERE resource_key=? AND team_id=?", pk, teamId);
        }
        if (!result.nodeIds.includes(p.nodeId)) result.nodeIds.push(p.nodeId);
      }
      recordProxyTeamEvent({ resourceKey: c.resourceKey, teamId, actorId: opts.actorId, event: "claim_released", reason: `operator released the organization's claim${opts.force ? " (waiting period overridden)" : ""}${opts.reason ? `: ${opts.reason.slice(0, 200)}` : ""}` });
      result.released.push(c.resourceKey);
    }
  });
  return result;
}

export interface TeamOverviewRow {
  id: string; name: string | null; status: string; createdAt: string;
  accounts: { total: number; active: number; proxyDown: number; error: number; disabled: number; cooling: number; concurrency: number };
  inFlight: number | null;
  windowUsedAvg: number | null;
  exits: { claimed: number; bound: number; releasable: number };
  usage24h: { requests: number; failed: number; costUsd: number };
  lastUsedAt: string | null;
}

export function teamOverview(inFlight: Record<string, number> | null): TeamOverviewRow[] {
  const now = nowIso();
  const since = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return all<{ id: string; name: string | null; status: string; created_at: string }>("SELECT id, name, status, created_at FROM upstream_teams ORDER BY created_at").map((t) => {
    const a = one<Record<string, number | null>>(
      `SELECT COUNT(*) total,
              SUM(status='active') active, SUM(status='proxy_down') proxy_down, SUM(status='error') error, SUM(status='disabled') disabled,
              SUM(status='active' AND (rate_limited_until>? OR overload_until>? OR temp_unschedulable_until>? OR window_exhausted_until>?)) cooling,
              SUM(CASE WHEN status='active' THEN concurrency ELSE 0 END) concurrency,
              AVG(CASE WHEN status='active' THEN window_used END) window_used,
              MAX(last_used_at) last_used
       FROM accounts WHERE team_id=?`, now, now, now, now, t.id,
    );
    const ids = all<{ id: string }>("SELECT id FROM accounts WHERE team_id=?", t.id).map((r) => r.id);
    const u = ids.length ? one<{ n: number; bad: number; cost: number }>(
      `SELECT COUNT(*) n, COALESCE(SUM(status_code<>200),0) bad, COALESCE(SUM(actual_cost),0) cost FROM usage_logs WHERE created_at>=? AND account_id IN (${ids.map(() => "?").join(",")})`, since, ...ids,
    ) : null;
    const claims = teamClaims(t.id);
    const boundExits = one<{ n: number }>("SELECT COUNT(DISTINCT p.resource_key) n FROM accounts a JOIN node_proxies p ON p.id=a.bound_proxy_id WHERE a.team_id=?", t.id)?.n ?? 0;
    return {
      id: t.id, name: t.name, status: t.status, createdAt: t.created_at,
      accounts: { total: a?.total ?? 0, active: a?.active ?? 0, proxyDown: a?.proxy_down ?? 0, error: a?.error ?? 0, disabled: a?.disabled ?? 0, cooling: a?.cooling ?? 0, concurrency: a?.concurrency ?? 0 },
      inFlight: inFlight ? ids.reduce((s, id) => s + (inFlight[id] ?? 0), 0) : null,
      windowUsedAvg: a?.window_used ?? null,
      exits: { claimed: claims.length, bound: boundExits, releasable: claims.filter((c) => c.releasable).length },
      usage24h: { requests: u?.n ?? 0, failed: u?.bad ?? 0, costUsd: u?.cost ?? 0 },
      lastUsedAt: (a?.last_used as unknown as string | null) ?? null,
    };
  });
}
