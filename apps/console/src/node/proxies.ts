import { isIP } from "node:net";
import { all, claimProxyResource, decryptString, encryptString, ensureUpstreamTeam, getSetting, isoIn, liftQuarantine, normalizeTeamId, nowIso, one, quarantineActive, quarantineResource, recordProxyTeamEvent, run, tx } from "@1dayapi/core";
import { expireJobReservations, liveReservationSql } from "../onboard/reservations.js";
import { proxyIdFromUrl } from "./registry.js";

// Node proxy pool ledger (protocol v2). Plaintext proxy URLs only exist in
// the PUT request body and the one-time WS proxies.set push; the DB stores
// AES-256-GCM ciphertext (url_enc).

export interface ProxyInput {
  url: string;
  label?: string;
}

const PROXY_URL_RE = /^(https?|socks5h?):\/\/\S+$/;

export function validateProxies(input: unknown): ProxyInput[] {
  if (!Array.isArray(input)) throw new ProxyInputError("proxies must be an array");
  if (input.length > 500) throw new ProxyInputError("at most 500 proxies per node");
  const out: ProxyInput[] = [];
  for (const p of input) {
    if (!p || typeof p !== "object") throw new ProxyInputError("each proxy must be an object {url, label?}");
    const url = (p as Record<string, unknown>).url;
    const label = (p as Record<string, unknown>).label;
    if (typeof url !== "string" || !PROXY_URL_RE.test(url.trim()) || url.length > 500) {
      throw new ProxyInputError("proxy url must be http(s):// or socks5(h):// URL");
    }
    if (label !== undefined && (typeof label !== "string" || label.length > 120)) {
      throw new ProxyInputError("proxy label must be a string of at most 120 chars");
    }
    out.push({ url: url.trim(), label: typeof label === "string" && label.trim() ? label.trim() : undefined });
  }
  return out;
}

export class ProxyInputError extends Error {}

export interface ProxySkips {
  /** Same URL appeared earlier in this batch (first occurrence wins). */
  duplicateInBatch: number;
  /** URL is already in this node's pool (row untouched: label/credential not updated). */
  alreadyInPool: number;
  /** URL is in another node's pool (proxy ids are global: one URL = one node). */
  onOtherNode: number;
}

export interface AddProxiesResult {
  added: number;
  skipped: ProxySkips;
  /** Masked URLs of every skipped line, in input order (for the operator's result message). */
  skippedUrls: string[];
}

const noSkips = (): ProxySkips => ({ duplicateInBatch: 0, alreadyInPool: 0, onOtherNode: 0 });
const totalSkipped = (s: ProxySkips): number => s.duplicateInBatch + s.alreadyInPool + s.onOtherNode;

/**
 * Partition a batch into rows to write and rows to drop (user rule 2026-10-20:
 * duplicates are removed silently, the rest is added, the result is reported).
 * `acceptInPool` = true keeps lines already in this node's pool (replace mode
 * re-saves them); false drops them (append mode leaves existing rows alone).
 */
function dedupeBatch(nodeId: string, proxies: ProxyInput[], acceptInPool: boolean): { keep: ProxyInput[]; skipped: ProxySkips; skippedUrls: string[] } {
  const seen = new Set<string>();
  const keep: ProxyInput[] = [];
  const skipped = noSkips();
  const skippedUrls: string[] = [];
  for (const p of proxies) {
    const id = proxyIdFromUrl(p.url);
    if (seen.has(id)) {
      skipped.duplicateInBatch++;
      skippedUrls.push(maskProxyUrl(p.url));
      continue;
    }
    seen.add(id);
    const owner = one<{ node_id: string }>("SELECT node_id FROM node_proxies WHERE id = ?", id);
    if (owner && owner.node_id !== nodeId) {
      skipped.onOtherNode++;
      skippedUrls.push(maskProxyUrl(p.url));
      continue;
    }
    if (owner && !acceptInPool) {
      skipped.alreadyInPool++;
      skippedUrls.push(maskProxyUrl(p.url));
      continue;
    }
    keep.push(p);
  }
  return { keep, skipped, skippedUrls };
}

/**
 * Add proxies to a node's pool without touching existing rows (bound proxies
 * stay). Duplicates (within the batch, already in the pool, on another node)
 * are dropped and counted; the remaining lines are inserted.
 */
export function addNodeProxies(nodeId: string, proxies: ProxyInput[]): AddProxiesResult {
  const existing = one<{ n: number }>("SELECT COUNT(*) AS n FROM node_proxies WHERE node_id = ?", nodeId)?.n ?? 0;
  const { keep, skipped, skippedUrls } = dedupeBatch(nodeId, proxies, false);
  if (existing + keep.length > 500) throw new ProxyInputError(`at most 500 proxies per node (has ${existing}, adding ${keep.length})`);
  for (const p of keep) {
    run(
      "INSERT INTO node_proxies (id, node_id, url_enc, label, status,isolation_version) VALUES (?, ?, ?, ?, 'unknown',1)",
      proxyIdFromUrl(p.url),
      nodeId,
      encryptString(p.url),
      p.label ?? null,
    );
  }
  if (totalSkipped(skipped) > 0) {
    console.info(`[proxies] node ${nodeId}: added ${keep.length}, skipped ${totalSkipped(skipped)} (batch dup ${skipped.duplicateInBatch}, in pool ${skipped.alreadyInPool}, other node ${skipped.onOtherNode})`);
  }
  return { added: keep.length, skipped, skippedUrls };
}

export interface ReplaceProxiesResult {
  /** Plaintext URLs of the new pool, for the WS push. */
  urls: string[];
  skipped: ProxySkips;
  skippedUrls: string[];
}

/**
 * Replace a node's whole proxy pool (encrypted at rest). Lines repeated in the
 * batch or living in another node's pool are dropped and counted.
 */
export function replaceNodeProxies(nodeId: string, proxies: ProxyInput[]): ReplaceProxiesResult {
  const { keep: unique, skipped, skippedUrls } = dedupeBatch(nodeId, proxies, true);
  // Rows that stay in the pool keep their health and their account binding;
  // a proxy that still carries an account cannot be removed (one account =
  // one proxy for life, docs/onboarding.md §1): delete the account first.
  const keep = new Set(unique.map((p) => proxyIdFromUrl(p.url)));
  const bound = all<{ id: string; bound_account_id: string }>(
    `SELECT p.id,p.bound_account_id FROM node_proxies p WHERE p.node_id = ? AND
      (p.bound_account_id IS NOT NULL OR EXISTS(SELECT 1 FROM accounts a WHERE a.bound_proxy_id=p.id)
       OR EXISTS(SELECT 1 FROM onboarding_jobs j WHERE j.proxy_id=p.id AND ${liveReservationSql()}))`,
    nodeId,
  ).filter((r) => !keep.has(r.id));
  if (bound.length) {
    throw new ProxyInputError(
      `${bound.length} proxy(ies) still bound to accounts cannot be removed from the pool (ids: ${bound.map((r) => r.id).join(", ")}); delete those accounts first`,
    );
  }
  const placeholders = keep.size ? [...keep].map(() => "?").join(",") : "''";
  run(`DELETE FROM node_proxies WHERE node_id = ? AND id NOT IN (${placeholders})`, nodeId, ...keep);
  for (const p of unique) {
    const id = proxyIdFromUrl(p.url);
    if (one("SELECT 1 FROM node_proxies WHERE id = ? AND node_id = ?", id, nodeId)) {
      run("UPDATE node_proxies SET url_enc = ?, label = ? WHERE id = ? AND node_id = ?", encryptString(p.url), p.label ?? null, id, nodeId);
    } else {
      run(
        "INSERT INTO node_proxies (id, node_id, url_enc, label, status,isolation_version) VALUES (?, ?, ?, ?, 'unknown',1)",
        id,
        nodeId,
        encryptString(p.url),
        p.label ?? null,
      );
    }
  }
  if (totalSkipped(skipped) > 0) {
    console.info(`[proxies] node ${nodeId}: replaced pool with ${unique.length}, skipped ${totalSkipped(skipped)} (batch dup ${skipped.duplicateInBatch}, other node ${skipped.onOtherNode})`);
  }
  return { urls: unique.map((p) => p.url), skipped, skippedUrls };
}

/**
 * Remove proxies from a node's pool by id (operator decision, 2026-10-28: a provider's
 * revoked list). Rows that still carry an account or a live onboarding reservation are
 * left in place and reported (delete the account first, docs/onboarding.md §1 原则 3);
 * everything else is deleted. Quarantine / claim / event history is append-only and stays.
 */
export interface RemoveProxiesResult {
  removed: string[];
  bound: string[];
  reserved: string[];
  notFound: string[];
}
export function removeNodeProxies(nodeId: string, proxyIds: string[], actorId: string | null): RemoveProxiesResult {
  const out: RemoveProxiesResult = { removed: [], bound: [], reserved: [], notFound: [] };
  for (const raw of proxyIds) {
    const id = String(raw).slice(0, 40);
    const p = one<{ id: string; bound_account_id: string | null; resource_key: string | null; team_id: string | null }>(
      "SELECT id, bound_account_id, resource_key, team_id FROM node_proxies WHERE id = ? AND node_id = ?", id, nodeId);
    if (!p) { out.notFound.push(id); continue; }
    if (p.bound_account_id || one("SELECT 1 FROM accounts WHERE bound_proxy_id = ?", id)) { out.bound.push(id); continue; }
    if (proxyReserved(id)) { out.reserved.push(id); continue; }
    run("DELETE FROM node_proxy_assignments WHERE node_id = ? AND proxy_id = ?", nodeId, id);
    run("DELETE FROM node_proxies WHERE id = ? AND node_id = ?", id, nodeId);
    recordProxyTeamEvent({ resourceKey: p.resource_key ?? `proxy:${id}`, proxyId: id, nodeId, teamId: p.team_id, actorId, event: "proxy_removed",
      reason: "removed from the pool by an operator" });
    out.removed.push(id);
  }
  return out;
}

/**
 * ONE-OFF maintenance helper (2026-10-28, ops/maintenance/2026-10-28-rebind-revoked-proxies.mjs),
 * deliberately NOT exposed as an API or UI: one account = one proxy for life is the rule
 * (docs/onboarding.md §1 原则 1); the user allowed exactly one rebinding when a provider
 * revoked 202 proxies. Move an account to another proxy on its node. Isolated (team) accounts get a proxy the scheduler would accept —
 * verified exit, same-organization exit preferred, capacity 2 normal / 3 max — and the
 * claim + `account_bound` event that openTunnel / boundProxyDown check; the old exit keeps
 * its organization claim (history is append-only). Legacy accounts (no team) get any live,
 * unbound proxy of the node. Returns the old and new proxy ids.
 */
export function rebindAccountProxy(accountId: string, actorId: string | null, opts: { proxyId?: string; excludeProxyIds?: string[] } = {}): { oldProxyId: string | null; newProxyId: string; exitIp: string | null } {
  const a = one<{ id: string; node_id: string | null; route: string; team_id: string | null; bound_proxy_id: string | null; status: string }>(
    "SELECT id, node_id, route, team_id, bound_proxy_id, status FROM accounts WHERE id = ?", accountId);
  if (!a) throw new ProxyInputError("account_not_found");
  if (!a.node_id) throw new ProxyInputError("account_has_no_node");
  const exclude = new Set([...(opts.excludeProxyIds ?? []), ...(a.bound_proxy_id ? [a.bound_proxy_id] : [])]);
  let next: IsolatedProxy;
  if (a.team_id) {
    // Never share an exit with an account of another organization (or a legacy one).
    for (const r of all<{ id: string }>(`SELECT p.id FROM node_proxies p WHERE p.node_id = ? AND (p.bound_account_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM accounts x WHERE x.bound_proxy_id = p.id AND (x.team_id IS NULL OR x.team_id <> ?)))`, a.node_id, a.team_id)) exclude.add(r.id);
    next = resolveTeamProxy(a.node_id, a.team_id, opts.proxyId ?? "auto", "", exclude);
    ensureUpstreamTeam(a.team_id);
    claimProxyResource(`proxy:${next.id}`, a.team_id);
    claimProxyResource(next.resource_key!, a.team_id);
    run("UPDATE node_proxies SET team_id = ? WHERE id = ? AND isolation_version = 1", a.team_id, next.id);
  } else {
    type Free = IsolatedProxy & { bound_account_id: string | null };
    const row = opts.proxyId && opts.proxyId !== "auto"
      ? one<Free>("SELECT * FROM node_proxies WHERE id = ? AND node_id = ?", opts.proxyId, a.node_id)
      : all<Free>(`SELECT p.* FROM node_proxies p WHERE p.node_id = ? AND p.status = 'live' AND p.bound_account_id IS NULL
           AND p.team_id IS NULL AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.bound_proxy_id = p.id)
           AND p.id NOT IN (${RESERVED_PROXY_SQL}) ORDER BY p.last_check_at ASC, p.id`, a.node_id).find((p) => !exclude.has(p.id));
    if (!row || row.status !== "live" || exclude.has(row.id)) throw new ProxyInputError("No free live proxy on this node");
    if (row.bound_account_id || one("SELECT 1 FROM accounts WHERE bound_proxy_id = ?", row.id)) throw new ProxyInputError("proxy_bound");
    next = row;
  }
  const old = a.bound_proxy_id;
  run("UPDATE accounts SET bound_proxy_id = ?, updated_at = ? WHERE id = ?", next.id, nowIso(), accountId);
  if (old) run("UPDATE node_proxies SET bound_account_id = NULL WHERE id = ? AND bound_account_id = ?", old, accountId);
  if (!a.team_id) run("UPDATE node_proxies SET bound_account_id = ? WHERE id = ?", accountId, next.id);
  run("DELETE FROM node_proxy_assignments WHERE account_id = ?", accountId);
  const oldRow = old ? one<{ resource_key: string | null; node_id: string }>("SELECT resource_key, node_id FROM node_proxies WHERE id = ?", old) : null;
  if (old) recordProxyTeamEvent({ resourceKey: oldRow?.resource_key ?? `proxy:${old}`, proxyId: old, nodeId: oldRow?.node_id ?? a.node_id, teamId: a.team_id,
    accountId, actorId, event: "account_released", reason: "rebound to another proxy by an operator; organization ownership retained" });
  recordProxyTeamEvent({ resourceKey: next.resource_key ?? `proxy:${next.id}`, proxyId: next.id, nodeId: a.node_id, teamId: a.team_id, accountId, actorId,
    event: "account_bound", reason: a.team_id ? "rebound by an operator (verified exit, same organization)" : "rebound by an operator (legacy account)" });
  return { oldProxyId: old, newProxyId: next.id, exitIp: next.exit_ip ?? null };
}

/** Proxies an in-flight onboarding job has already picked (not yet bound: the bot is still running). */
export const RESERVED_PROXY_SQL = `SELECT proxy_id FROM onboarding_jobs j WHERE proxy_id IS NOT NULL AND ${liveReservationSql()}`;

/** SQL predicate (one `?` = now ISO): the proxy is not in a release cooldown. */
const NOT_COOLING_SQL = "(cooldown_until IS NULL OR cooldown_until <= ?)";

export interface IsolatedProxy {
  id: string; node_id: string; team_id: string | null; isolation_version: number;
  status: string; exit_ip: string | null; resource_key: string | null;
  cooldown_until: string | null; last_check_at: string | null;
}

export function canonicalProxyResourceKey(ip: string): string | null {
  if (isIP(ip) === 4) return `ip:${ip}`;
  if (isIP(ip) === 6) return `ip:${new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase()}`;
  return null;
}

/** Runtime observations apply only to newly enrolled proxies, never legacy backfill. */
export function recordNodeProxyExit(nodeId:string,proxyId:string,ip:string):boolean {
  const observed=one<IsolatedProxy>("SELECT * FROM node_proxies WHERE id=? AND node_id=? AND isolation_version=1",proxyId,nodeId);
  const observedKey=canonicalProxyResourceKey(ip);
  // Heartbeats repeat the same observation. Do not take a writer lock merely
  // to rewrite an unchanged identity; claims/quarantine remain checked live.
  if(observed && observedKey && observed.resource_key===observedKey && observed.exit_ip===observedKey.slice(3) &&
    !quarantineActive(observedKey,`proxy:${proxyId}`) &&
    (!observed.team_id || one("SELECT 1 FROM proxy_team_claims WHERE resource_key=? AND team_id=?",observedKey,observed.team_id)) &&
    proxyOccupancy(observedKey).total<=3)return true;
  return tx(()=>{
    const p=one<IsolatedProxy>("SELECT * FROM node_proxies WHERE id=? AND node_id=? AND isolation_version=1",proxyId,nodeId);
    if(!p)return false;
    if(quarantineActive(`proxy:${p.id}`)){
      run("UPDATE node_proxies SET status='dead',last_error='exit resource quarantined' WHERE id=?",proxyId);return false;
    }
    const key=canonicalProxyResourceKey(ip);
    if(!key){run("UPDATE node_proxies SET status='dead',last_error='exit identity unavailable' WHERE id=?",proxyId);return false;}
    const owner=one<{team_id:string}>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?",key);
    const reservedByOther=!!p.team_id && one(`SELECT 1 FROM onboarding_jobs WHERE proxy_resource_key=?
      AND ${liveReservationSql('onboarding_jobs')} AND (team_id IS NULL OR team_id<>?)`,key,p.team_id);
    const conflict=!!p.team_id && (!!owner && owner.team_id!==p.team_id || !!reservedByOther || !!quarantineActive(key));
    if(conflict){
      quarantineResource(`proxy:${p.id}`,"observed exit organization conflict");
      recordProxyTeamEvent({resourceKey:key,proxyId:p.id,nodeId,teamId:p.team_id,event:"exit_conflict",reason:"observed IP belongs to another organization"});
      run("UPDATE node_proxies SET status='dead',last_error='exit identity conflict' WHERE id=?",proxyId);return false;
    }
    if(p.team_id)claimProxyResource(key,p.team_id);
    run("UPDATE node_proxies SET exit_ip=?,resource_key=? WHERE id=?",key.slice(3),key,proxyId);
    if(proxyOccupancy(key).total>3){
      quarantineResource(`proxy:${p.id}`,"exit capacity exceeded after observation");
      run("UPDATE node_proxies SET status='dead',last_error='exit capacity exceeded' WHERE id=?",proxyId);return false;
    }
    if(p.resource_key!==key)recordProxyTeamEvent({resourceKey:key,proxyId:p.id,nodeId,teamId:p.team_id,event:"exit_observed",reason:p.resource_key?"provider exit changed":"first measured exit"});
    return true;
  });
}

export function proxyOccupancy(resourceKey: string, excludeJobId = ""): { bound: number; reserved: number; total: number } {
  const bound = one<{ n: number }>(`SELECT COUNT(*) n FROM accounts a JOIN node_proxies p ON p.id=a.bound_proxy_id
    WHERE p.resource_key=?`, resourceKey)?.n ?? 0;
  const reserved = one<{ n: number }>(`SELECT COUNT(*) n FROM onboarding_jobs j
    WHERE j.proxy_resource_key=? AND j.isolation_version=1 AND j.id<>? AND ${liveReservationSql()}
      AND (j.reservation_account_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM accounts a JOIN node_proxies p ON p.id=a.bound_proxy_id
        WHERE a.id=j.reservation_account_id AND p.resource_key=j.proxy_resource_key))`, resourceKey, excludeJobId)?.n ?? 0;
  return { bound, reserved, total: bound + reserved };
}

function teamCompatible(p: IsolatedProxy, teamId: string | null): boolean {
  if (p.isolation_version !== 1 || p.status !== "live" || !p.exit_ip || !p.resource_key ||
      canonicalProxyResourceKey(p.exit_ip) !== p.resource_key || (p.cooldown_until && p.cooldown_until > nowIso())) return false;
  for (const key of [p.resource_key, `proxy:${p.id}`]) {
    if (quarantineActive(key)) return false;
    const claim = one<{ team_id: string }>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?", key);
    if (claim && claim.team_id !== teamId) return false;
    if (!teamId && claim) return false;
  }
  if (p.team_id && p.team_id !== teamId) return false;
  // An unidentified account must discover its organization on a virgin,
  // exclusive resource; it may not borrow another organization's exit.
  if (!teamId && proxyOccupancy(p.resource_key).total !== 0) return false;
  const pending = all<{ team_id: string | null;proxy_resource_key:string|null }>(`SELECT team_id,proxy_resource_key FROM onboarding_jobs
    WHERE (proxy_resource_key=? OR proxy_id=?) AND ${liveReservationSql('onboarding_jobs')}`, p.resource_key,p.id);
  return pending.every((j) => !!teamId && j.team_id === teamId && j.proxy_resource_key===p.resource_key);
}

/** Caller reserves the returned resource inside the same BEGIN IMMEDIATE. */
export function resolveTeamProxy(nodeId: string, teamIdInput?: string | null, requested?: string, excludeJobId="", excludeProxyIds?: Set<string>): IsolatedProxy {
  expireJobReservations();
  const teamId = normalizeTeamId(teamIdInput);
  if (teamIdInput && !teamId) throw new ProxyInputError("team_identity_invalid");
  const candidates = all<IsolatedProxy>("SELECT * FROM node_proxies WHERE node_id=? ORDER BY last_check_at,id", nodeId)
    .filter((p) => !excludeProxyIds?.has(p.id) && teamCompatible(p, teamId))
    .map((p) => ({ p, ...proxyOccupancy(p.resource_key!,excludeJobId),count:proxyOccupancy(p.resource_key!,excludeJobId).total }))
    .filter((x) => x.count < 3);
  const normal = candidates.filter((x) => x.count < 2);
  const allowed = normal.length ? normal : candidates;
  const selected = requested && requested !== "auto" ? allowed.find((x) => x.p.id === requested) :
    allowed.sort((a, b) => Number(b.bound===1) - Number(a.bound===1) ||
      Number(b.p.team_id === teamId && !!teamId) - Number(a.p.team_id === teamId && !!teamId) || a.count - b.count)[0];
  if (!selected) throw new ProxyInputError("No compatible verified proxy capacity (normal 2, maximum 3)");
  return selected.p;
}

export function claimDiscoveredProxy(proxyId:string,teamId:string,jobId:string):void {
  const p=one<IsolatedProxy>("SELECT * FROM node_proxies WHERE id=?",proxyId);
  const job=one<{proxy_resource_key:string|null}>("SELECT proxy_resource_key FROM onboarding_jobs WHERE id=?",jobId);
  if(!p?.resource_key || p.resource_key!==job?.proxy_resource_key || p.isolation_version!==1 || !p.exit_ip ||
    canonicalProxyResourceKey(p.exit_ip)!==p.resource_key || (p.team_id && p.team_id!==teamId))throw new Error("proxy_identity_changed");
  ensureUpstreamTeam(teamId);claimProxyResource(`proxy:${p.id}`,teamId);claimProxyResource(p.resource_key,teamId);
  run("UPDATE node_proxies SET team_id=? WHERE id=?",teamId,p.id);
  recordProxyTeamEvent({resourceKey:p.resource_key,proxyId:p.id,nodeId:p.node_id,teamId,jobId,event:"organization_discovered",
    reason:"discovery exit permanently assigned; final account slot selected separately"});
}

export function claimTeamProxy(proxyId: string, teamId: string, accountId: string, jobId: string): void {
  const p = one<IsolatedProxy>("SELECT * FROM node_proxies WHERE id=?", proxyId);
  const job = one<{ proxy_resource_key: string | null;requester_id:string|null }>("SELECT proxy_resource_key,requester_id FROM onboarding_jobs WHERE id=?", jobId);
  if (!p || p.isolation_version !== 1 || !p.resource_key || p.resource_key !== job?.proxy_resource_key ||
      !p.exit_ip || canonicalProxyResourceKey(p.exit_ip) !== p.resource_key || p.status !== "live" ||
      (p.team_id && p.team_id !== teamId)) throw new Error("proxy_identity_changed");
  if (proxyOccupancy(p.resource_key, jobId).total >= 3) throw new Error("proxy_capacity_reached");
  ensureUpstreamTeam(teamId);
  claimProxyResource(`proxy:${p.id}`, teamId);
  claimProxyResource(p.resource_key, teamId);
  run("UPDATE node_proxies SET team_id=? WHERE id=? AND isolation_version=1", teamId, p.id);
  recordProxyTeamEvent({ resourceKey: p.resource_key, proxyId:p.id,nodeId:p.node_id,teamId,accountId,jobId,event:"account_bound",
    actorId:job.requester_id,reason:proxyOccupancy(p.resource_key,jobId).total>=2?"third slot: no normal capacity":"normal account slot" });
}

/** Unknown or mismatched egress cannot be made virgin by failing the job. */
export function quarantineJobProxy(jobId: string, reason: string): void {
  const j = one<{ proxy_id:string|null;node_id:string;team_id:string|null;proxy_resource_key:string|null;egress_started_at:string|null }>(
    "SELECT proxy_id,node_id,team_id,proxy_resource_key,egress_started_at FROM onboarding_jobs WHERE id=? AND isolation_version=1", jobId);
  if (!j?.proxy_id || !j.egress_started_at || !j.proxy_resource_key) return;
  for (const key of [j.proxy_resource_key, `proxy:${j.proxy_id}`])
    quarantineResource(key, reason);
  recordProxyTeamEvent({resourceKey:j.proxy_resource_key,proxyId:j.proxy_id,nodeId:j.node_id,teamId:j.team_id,jobId,event:"quarantined"});
}

/**
 * Release the proxies bound to an account that is being deleted (docs/onboarding.md
 * §1 原则 3). If the account had been rejected upstream (`status = 'error'`: 401
 * revoked, on hold, …) the proxy is tainted: it sits out `proxy_release_cooldown_sec`
 * (default 24 h) before it can be bound to a new account (user rule 2026-10-20).
 * A clean release clears any previous cooldown. Returns the number of proxies released.
 */
export function releaseAccountProxies(accountId: string, account: { status: string; error_message?: string | null; owner_id?: string | null } | undefined): number {
  const isolated = one<{team_id:string;bound_proxy_id:string;node_id:string|null;resource_key:string|null}>(
    `SELECT a.team_id,a.bound_proxy_id,a.node_id,p.resource_key FROM accounts a JOIN node_proxies p ON p.id=a.bound_proxy_id
     WHERE a.id=? AND a.team_id IS NOT NULL`,accountId);
  if (isolated?.resource_key) {
    recordProxyTeamEvent({resourceKey:isolated.resource_key,proxyId:isolated.bound_proxy_id,
      nodeId:isolated.node_id,teamId:isolated.team_id,accountId,event:"account_released",reason:"account removed; organization ownership retained"});
    return 1;
  }
  const sec = Math.max(0, Number(getSetting("proxy_release_cooldown_sec")) || 0);
  // Provider-owned accounts (user rule 2026-10-26): their proxies never enter the release cooldown.
  const providerOwned = !!account?.owner_id && one<{ role: string }>("SELECT role FROM users WHERE id = ?", account.owner_id)?.role === "provider";
  const tainted = account?.status === "error" && sec > 0 && !providerOwned;
  const reason = tainted ? `account deleted in error state: ${(account?.error_message ?? "").slice(0, 160)}`.trim() : null;
  const r = run(
    "UPDATE node_proxies SET bound_account_id = NULL, cooldown_until = ?, cooldown_reason = ? WHERE bound_account_id = ?",
    tainted ? isoIn(sec * 1000) : null,
    reason,
    accountId,
  );
  if (tainted && r.changes > 0) console.info(`[proxies] account ${accountId} deleted in error state: ${r.changes} proxy(ies) released into a ${sec}s cooldown`);
  return r.changes;
}

/** Is the proxy in a release cooldown right now? Returns the end time or null. */
export function proxyCoolingUntil(proxyId: string): string | null {
  const row = one<{ cooldown_until: string | null }>("SELECT cooldown_until FROM node_proxies WHERE id = ?", proxyId);
  return row?.cooldown_until && row.cooldown_until > nowIso() ? row.cooldown_until : null;
}

/**
 * Release everything a node owns before it is removed (admin or provider
 * path): accounts bound to its proxies are unbound and disabled (their proxy
 * is gone, so they must not be scheduled), proxy rows and assignments are
 * deleted, in-flight onboarding jobs on it fail. Caller wraps in tx().
 */
export function releaseNodeResources(nodeId: string, reason: string): void {
  for (const p of all<IsolatedProxy>("SELECT * FROM node_proxies WHERE node_id=? AND isolation_version=1",nodeId))
    if (p.resource_key) recordProxyTeamEvent({resourceKey:p.resource_key,proxyId:p.id,nodeId,teamId:p.team_id,event:"node_removed",reason});
  run(
    `UPDATE accounts SET bound_proxy_id = NULL, node_id = NULL, status = 'disabled', error_message = ?, updated_at = ?
     WHERE node_id = ? OR bound_proxy_id IN (SELECT id FROM node_proxies WHERE node_id = ?)`,
    reason,
    nowIso(),
    nodeId,
    nodeId,
  );
  run("UPDATE node_proxies SET bound_account_id = NULL WHERE node_id = ?", nodeId);
  run("DELETE FROM node_proxies WHERE node_id = ?", nodeId);
  run("DELETE FROM node_proxy_assignments WHERE node_id = ?", nodeId);
  run(
    "UPDATE onboarding_jobs SET status = 'failed', error = ?, payload_enc = NULL, updated_at = ? WHERE node_id = ? AND status IN ('working', 'pending_callback')",
    reason,
    nowIso(),
    nodeId,
  );
}

/** Mask the userinfo password: http://user:secret@h:1 -> http://user:***@h:1 */
export function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/\/\/([^@/]*)@/, "//***@");
  }
}

/** Quarantine state of a proxy: its own key or its measured exit resource (docs/onboarding.md §12.1). */
export function proxyQuarantine(proxyId: string, resourceKey: string | null): { quarantined: boolean; reason: string | null } {
  const row = quarantineActive(`proxy:${proxyId}`, resourceKey ?? `proxy:${proxyId}`);
  return { quarantined: !!row, reason: row?.reason ?? null };
}

/**
 * Operator decision to lift a quarantine (admin only): records a lift for the proxy's own
 * key and its exit resource (the verdict rows stay, migration 21 keeps them append-only),
 * puts the row back to `unknown` so the next heartbeat re-verifies the exit, and keeps the
 * decision in the event history. Returns false when nothing was active.
 */
export function unquarantineProxy(nodeId: string, proxyId: string, actorId: string | null): boolean {
  const p = one<{ id: string; resource_key: string | null; team_id: string | null }>(
    "SELECT id, resource_key, team_id FROM node_proxies WHERE id=? AND node_id=?", proxyId, nodeId,
  );
  if (!p) throw new ProxyInputError("proxy_not_found");
  const keys = [`proxy:${p.id}`, ...(p.resource_key ? [p.resource_key] : [])];
  return tx(() => {
    const cleared = liftQuarantine(keys, actorId, "operator lifted the quarantine");
    if (!cleared) return false;
    run("UPDATE node_proxies SET status='unknown', last_error=NULL WHERE id=?", p.id);
    recordProxyTeamEvent({ resourceKey: p.resource_key ?? `proxy:${p.id}`, proxyId: p.id, nodeId, teamId: p.team_id, actorId,
      event: "unquarantined", reason: "operator lifted the quarantine; exit re-verified on the next heartbeat" });
    return true;
  });
}

export function listNodeProxies(nodeId: string) {
  const rows = all<{
    id: string;
    url_enc: string;
    label: string | null;
    status: string;
    last_check_at: string | null;
    last_error: string | null;
    created_at: string;
    team_id: string|null; exit_ip:string|null; resource_key:string|null;
    assigned: number;
    cooldown_until: string | null;
    cooldown_reason: string | null;
  }>(
    `SELECT p.id, p.url_enc, p.label, p.status, p.last_check_at, p.last_error, p.created_at, p.cooldown_until, p.cooldown_reason,p.team_id,p.exit_ip,p.resource_key,
            (SELECT COUNT(*) FROM node_proxy_assignments a WHERE a.node_id = p.node_id AND a.proxy_id = p.id) AS assigned
     FROM node_proxies p WHERE p.node_id = ? ORDER BY p.created_at, p.id`,
    nodeId,
  );
  const now = nowIso();
  return rows.map((r) => {
    let masked: string | null = null;
    try {
      masked = maskProxyUrl(decryptString(r.url_enc));
    } catch {
      masked = null; // ciphertext not readable with the current master key
    }
    return {
      id: r.id,
      quarantined: proxyQuarantine(r.id, r.resource_key).quarantined,
      quarantineReason: proxyQuarantine(r.id, r.resource_key).reason,
      url: masked,
      label: r.label,
      status: r.status,
      lastCheckAt: r.last_check_at,
      lastError: r.last_error,
      assignedAccounts: r.resource_key?proxyOccupancy(r.resource_key).bound:r.assigned,
      boundAccounts:r.resource_key?proxyOccupancy(r.resource_key).bound:0,
      reservedAccounts:r.resource_key?proxyOccupancy(r.resource_key).reserved:0,
      normalSlots:Math.max(0,2-(r.resource_key?proxyOccupancy(r.resource_key).total:3)),
      overflowSlots:Math.max(0,3-(r.resource_key?proxyOccupancy(r.resource_key).total:3)),
      teamId:r.team_id,teamName:r.team_id?one<{name:string|null}>("SELECT name FROM upstream_teams WHERE id=?",r.team_id)?.name??null:null,
      exitIp:r.exit_ip,resourceKey:r.resource_key,
      cooldownUntil: r.cooldown_until && r.cooldown_until > now ? r.cooldown_until : null,
      cooldownReason: r.cooldown_until && r.cooldown_until > now ? r.cooldown_reason : null,
      createdAt: r.created_at,
    };
  });
}

/** Plaintext URLs of a node's pool (for the WS push after deploy). */
export function nodeProxyUrls(nodeId: string): string[] {
  const rows = all<{ url_enc: string }>("SELECT url_enc FROM node_proxies WHERE node_id = ?", nodeId);
  const out: string[] = [];
  for (const r of rows) {
    try {
      out.push(decryptString(r.url_enc));
    } catch {
      // skip unreadable rows
    }
  }
  return out;
}

/** Protocol metadata is reconstructed from authoritative bindings and live reservations. */
export function nodeProxyConfig(nodeId: string): {
  proxies: string[]; proxyTeams: Record<string,string>; proxyAccounts: Record<string,string[]>;
} {
  const proxyTeams: Record<string,string> = {};
  const proxyAccounts: Record<string,string[]> = {};
  for (const p of all<IsolatedProxy>("SELECT * FROM node_proxies WHERE node_id=? AND isolation_version=1",nodeId)) {
    proxyTeams[p.id]=p.team_id??`unassigned:${p.id}`;
    proxyAccounts[p.id]=[];
    if(!p.resource_key || quarantineActive(p.resource_key,`proxy:${p.id}`))continue;
    const jobs = all<{id:string;team_id:string|null}>(`SELECT id,team_id FROM onboarding_jobs WHERE proxy_id=?
      AND proxy_resource_key=? AND ${liveReservationSql('onboarding_jobs')}`,p.id,p.resource_key);
    const team = p.team_id ?? jobs[0]?.team_id ?? (jobs[0] ? `pending:${jobs[0].id}` : null);
    if (!team) continue;
    const owner=one<{team_id:string}>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?",p.resource_key);
    if(owner && owner.team_id!==team)continue;
    proxyTeams[p.id] = team;
    const accountIds = all<{id:string}>("SELECT id FROM accounts WHERE bound_proxy_id=? AND team_id=?",p.id,team).map((a)=>a.id);
    proxyAccounts[p.id] = [...accountIds,...jobs.filter((j)=>(j.team_id ?? `pending:${j.id}`)===team).map((j)=>`onboard_${j.id}`)];
  }
  return {proxies:nodeProxyUrls(nodeId),proxyTeams,proxyAccounts};
}

/**
 * Credential-free proxy picker view (docs/onboarding.md §4): id/label/host/port/
 * status only — userinfo never leaves this layer. freeOnly keeps live unbound
 * proxies, oldest successful probe first (the auto-assignment order, §6.1).
 */
export function listProxiesForPicker(nodeId: string, freeOnly: boolean) {
  return all<IsolatedProxy & {url_enc:string;label:string|null}>("SELECT * FROM node_proxies WHERE node_id=? ORDER BY last_check_at,id",nodeId)
    .map((p)=>{
      const slots=p.resource_key ? proxyOccupancy(p.resource_key) : {bound:0,reserved:0,total:0};
      let host:string|null=null;let port:number|null=null;
      try { const u=new URL(decryptString(p.url_enc));host=u.hostname;port=u.port?Number(u.port):null; } catch {}
      const q=proxyQuarantine(p.id,p.resource_key);
      return {id:p.id,label:p.label,host,port,status:p.status,bound:slots.bound>0,quarantined:q.quarantined,quarantineReason:q.reason,
        boundAccounts:slots.bound,reservedAccounts:slots.reserved,
        normalSlots:Math.max(0,2-slots.total),overflowSlots:Math.max(0,3-slots.total),
        exitIp:p.exit_ip,resourceKey:p.resource_key,
        usable:p.isolation_version===1 && p.status==='live' && !!p.resource_key &&
          !quarantineActive(p.resource_key,`proxy:${p.id}`) &&
          (!p.cooldown_until || p.cooldown_until<=nowIso()) && slots.total<3};
    }).filter((p)=>!freeOnly || p.usable).map(({usable,...p})=>p);
}

/** Compatibility wrapper; unidentified jobs require a virgin measured resource. */
export function pickFreeProxy(nodeId: string, teamId?:string|null): {id:string}|undefined {
  try {return {id:resolveTeamProxy(nodeId,teamId).id};} catch{return undefined;}
}

/** Is this proxy already picked by an onboarding job that has not finished? */
export function proxyReserved(proxyId: string): boolean {
  return !!one(`SELECT 1 FROM (${RESERVED_PROXY_SQL}) WHERE proxy_id = ?`, proxyId);
}

export function nodeExists(nodeId: string): boolean {
  return !!one("SELECT 1 FROM nodes WHERE node_id = ?", nodeId);
}
