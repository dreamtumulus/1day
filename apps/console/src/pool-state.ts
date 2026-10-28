import { all, boundProxyDown, getSetting, one, parseThresholdPercent, windowAllows, type AccountRow } from "@1dayapi/core";
import { isTrustedExecutionNode } from "./node/trust.js";

// Pool state of a subscription account as the public pool page and the admin account list show
// it: one verdict function so both say the same thing, with a stable reason code (2026-10-28).

export interface PoolRow {
  id: string;
  team_id:string|null;
  bound_proxy_id:string|null;
  route:"direct"|"node";
  overload_until:string|null;
  temp_unschedulable_until:string|null;
  window_used:number|null;
  window_reset_at:string|null;
  window_5h_reset_at:string|null;
  window_7d_reset_at:string|null;
  concurrency:number;
  executor:AccountRow["executor"];
  name: string;
  account_email: string | null;
  owner_id: string | null;
  status: string;
  node_id: string | null;
  window_5h_used: number | null;
  window_7d_used: number | null;
  rate_limited_until: string | null;
  window_exhausted_until: string | null;
  last_used_at: string | null;
}

export type PoolStateName = "online" | "cooling" | "error" | "offline" | "unmanaged" | "unavailable" | "busy";
/**
 * State + the first failing gate, in the order the scheduler applies them. The reason is a
 * stable code (never free text) so the pool page and the admin account list can say *why* an
 * account is not serving instead of only "unavailable" (2026-10-28: 16 accounts sat on dead
 * proxies for hours and nobody could tell from the UI).
 */
export function poolVerdict(r: PoolRow, now: string, nodeOnline: Map<string, boolean>): { state: PoolStateName; reason: string | null } {
  if(!r.team_id)return {state:"unmanaged",reason:"legacy_no_team"};
  if(r.status!=="active")return {state:"error",reason:`status_${r.status}`};
  if(!r.node_id)return {state:"offline",reason:"no_node"};
  if(!nodeOnline.get(r.node_id))return {state:"offline",reason:"node_offline"};
  if(!isTrustedExecutionNode(r.node_id))return {state:"offline",reason:"node_untrusted"};
  if(r.route!=="node")return {state:"unavailable",reason:"route_not_node"};
  if(!r.bound_proxy_id)return {state:"unavailable",reason:"no_bound_proxy"};
  if(boundProxyDown(r))return {state:"unavailable",reason:boundProxyReason(r)};
  if(!one("SELECT 1 FROM upstream_teams WHERE id=? AND status='active'",r.team_id))return {state:"unavailable",reason:"team_inactive"};
  if(!one("SELECT 1 FROM account_groups ag JOIN groups g ON g.id=ag.group_id WHERE ag.account_id=? AND g.status='active'",r.id))return {state:"unavailable",reason:"no_active_group"};
  if(r.rate_limited_until && r.rate_limited_until>now)return {state:"cooling",reason:"rate_limited"};
  if(r.window_exhausted_until && r.window_exhausted_until>now)return {state:"cooling",reason:"window_exhausted"};
  if(r.overload_until && r.overload_until>now)return {state:"cooling",reason:"overloaded"};
  if(r.temp_unschedulable_until && r.temp_unschedulable_until>now)return {state:"cooling",reason:"temp_unschedulable"};
  if(!windowAllows(r,now,parseThresholdPercent(getSetting("anthropic_window_threshold_percent"))))return {state:"cooling",reason:"window_threshold"};
  if(r.concurrency>0 && (one<{n:number}>("SELECT COUNT(*) n FROM gateway_account_leases WHERE account_id=? AND expires_at>?",r.id,Date.now())?.n??0)>=r.concurrency)return {state:"busy",reason:"concurrency_full"};
  return {state:"online",reason:null};
}

/** Why boundProxyDown() said no: dead/missing proxy, team mismatch, unverified exit or quarantine. */
export function boundProxyReason(r: PoolRow): string {
  const p = one<{ status: string; team_id: string | null; isolation_version: number; resource_key: string | null; last_error: string | null }>(
    "SELECT status,team_id,isolation_version,resource_key,last_error FROM node_proxies WHERE id=?", r.bound_proxy_id);
  if (!p) return "proxy_missing";
  if (p.status !== "live") return p.last_error === "exit identity unavailable" ? "proxy_exit_unmeasured" : `proxy_${p.status}`;
  if (p.team_id !== r.team_id) return "proxy_team_mismatch";
  if (p.isolation_version !== 1 || !p.resource_key) return "proxy_legacy_unverified";
  if (one("SELECT 1 FROM proxy_quarantine WHERE resource_key IN (?,?)", p.resource_key, `proxy:${r.bound_proxy_id}`)) return "proxy_quarantined";
  return "proxy_down";
}

export function poolBase() {
  const now = new Date().toISOString().slice(0, 19) + "Z";
  const nodeOnline = new Map(
    all<{ node_id: string; online: number;accepting_sessions:number }>("SELECT node_id, online,accepting_sessions FROM nodes").map((n) => [n.node_id, n.online === 1 && n.accepting_sessions===1]),
  );
  return { now, nodeOnline };
}
