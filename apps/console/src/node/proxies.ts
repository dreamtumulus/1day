import { isIP } from "node:net";
import { all, claimProxyResource, decryptString, encryptString, ensureUpstreamTeam, getSetting, isoIn, liftQuarantine, normalizeTeamId, nowIso, one, quarantineActive, quarantineResource, recordProxyTeamEvent, run, tx, freezeAccountsOnProxy } from "@1dayapi/core";
import { expireJobReservations, liveReservationSql } from "../onboard/reservations.js";
import { proxyIdFromUrl } from "./registry.js";
import { canonicalProxyUrl, describeProxy, parseProxyInput, proxyFingerprint, proxyUrlFingerprint } from "./proxy-parse.js";

// Node proxy pool ledger (protocol v2). Plaintext proxy URLs only exist in
// the PUT request body and the one-time WS proxies.set push; the DB stores
// AES-256-GCM ciphertext (url_enc).

export interface ProxyInput {
  url: string;
  label?: string;
  /** Operator group (provider / batch / purpose); undefined = leave as is, null = ungroup. */
  group?: string | null;
}

/** Group names are short free text; empty → null (ungrouped). */
export function normalizeProxyGroup(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new ProxyInputError("group must be a string");
  const g = v.trim().replace(/\s+/g, " ");
  if (g.length > 60) throw new ProxyInputError("group must be at most 60 chars");
  return g || null;
}

const PROXY_URL_RE = /^(https?|socks5h?):\/\/\S+$/;

export function validateProxies(input: unknown, defaultGroup?: unknown): ProxyInput[] {
  if (!Array.isArray(input)) throw new ProxyInputError("proxies must be an array");
  const batchGroup = defaultGroup === undefined ? undefined : normalizeProxyGroup(defaultGroup);
  if (input.length > 500) throw new ProxyInputError("at most 500 proxies per node");
  const out: ProxyInput[] = [];
  for (const p of input) {
    if (!p || typeof p !== "object") throw new ProxyInputError("each proxy must be an object {url, label?}");
    const url = (p as Record<string, unknown>).url;
    const label = (p as Record<string, unknown>).label;
    if (typeof url !== "string" || url.length > 500) throw new ProxyInputError("proxy url must be a string of at most 500 chars");
    // A bare "host:port[:user:pass]" / "user:pass@host:port" line is a socks5 proxy by default;
    // an explicit scheme (http(s)://, socks5(h)://) is kept as written.
    let normalized = url.trim();
    if (!PROXY_URL_RE.test(normalized)) {
      const parsedLoose = parseProxyInput(normalized);
      if (!parsedLoose) throw new ProxyInputError("proxy url must be host:port[:user:pass], user:pass@host:port or an http(s):// / socks5(h):// URL");
      normalized = canonicalProxyUrl(parsedLoose);
    }
    if (label !== undefined && (typeof label !== "string" || label.length > 120)) {
      throw new ProxyInputError("proxy label must be a string of at most 120 chars");
    }
    const group = (p as Record<string, unknown>).group;
    const item: ProxyInput = { url: normalized, label: typeof label === "string" && label.trim() ? label.trim() : undefined };
    if (group !== undefined) item.group = normalizeProxyGroup(group);
    else if (batchGroup !== undefined) item.group = batchGroup;
    out.push(item);
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
  /** Rows already in this node's pool that the batch moved into its group (user rule 2026-10-29). */
  regrouped: number;
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
function dedupeBatch(nodeId: string, proxies: ProxyInput[], acceptInPool: boolean): { keep: ProxyInput[]; inPool: ProxyInput[]; skipped: ProxySkips; skippedUrls: string[] } {
  const seen = new Set<string>();
  const keep: ProxyInput[] = [];
  const inPool: ProxyInput[] = [];
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
      // Already here: with a group in the batch the row is filed into that group instead
      // of being dropped (pasting a provider's list under a group moves known lines too).
      if (p.group !== undefined) inPool.push(p);
      else {
        skipped.alreadyInPool++;
        skippedUrls.push(maskProxyUrl(p.url));
      }
      continue;
    }
    keep.push(p);
  }
  return { keep, inPool, skipped, skippedUrls };
}

/**
 * Add proxies to a node's pool without touching existing rows (bound proxies
 * stay). Duplicates (within the batch, already in the pool, on another node)
 * are dropped and counted; the remaining lines are inserted.
 */
export function addNodeProxies(nodeId: string, proxies: ProxyInput[]): AddProxiesResult {
  const existing = one<{ n: number }>("SELECT COUNT(*) AS n FROM node_proxies WHERE node_id = ?", nodeId)?.n ?? 0;
  const { keep, inPool, skipped, skippedUrls } = dedupeBatch(nodeId, proxies, false);
  if (existing + keep.length > 500) throw new ProxyInputError(`at most 500 proxies per node (has ${existing}, adding ${keep.length})`);
  for (const p of keep) {
    run(
      "INSERT INTO node_proxies (id, node_id, url_enc, label, status,isolation_version, group_name) VALUES (?, ?, ?, ?, 'unknown',1, ?)",
      proxyIdFromUrl(p.url),
      nodeId,
      encryptString(p.url),
      p.label ?? null,
      p.group ?? null,
    );
  }
  let regrouped = 0;
  for (const p of inPool) {
    regrouped += run("UPDATE node_proxies SET group_name = ? WHERE id = ? AND node_id = ? AND group_name IS NOT ?", p.group ?? null, proxyIdFromUrl(p.url), nodeId, p.group ?? null).changes;
  }
  if (totalSkipped(skipped) > 0 || regrouped > 0) {
    console.info(`[proxies] node ${nodeId}: added ${keep.length}, regrouped ${regrouped}, skipped ${totalSkipped(skipped)} (batch dup ${skipped.duplicateInBatch}, in pool ${skipped.alreadyInPool}, other node ${skipped.onOtherNode})`);
  }
  return { added: keep.length, regrouped, skipped, skippedUrls };
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
      if (p.group !== undefined) run("UPDATE node_proxies SET group_name = ? WHERE id = ? AND node_id = ?", p.group, id, nodeId);
    } else {
      run(
        "INSERT INTO node_proxies (id, node_id, url_enc, label, status,isolation_version, group_name) VALUES (?, ?, ?, ?, 'unknown',1, ?)",
        id,
        nodeId,
        encryptString(p.url),
        p.label ?? null,
        p.group ?? null,
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
 * ONE-OFF maintenance helper (2026-10-28, apps/console/scripts/rebind-revoked-proxies-2026-10-28.mjs),
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
  // A direct-route account pinned to a node proxy (WORK-CCR supply) has no node_id of its own:
  // stay on the node that hosts its current proxy.
  if (!a.node_id && a.bound_proxy_id) a.node_id = one<{ node_id: string }>("SELECT node_id FROM node_proxies WHERE id = ?", a.bound_proxy_id)?.node_id ?? null;
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

/** Accounts one measured exit IP may carry (settings `proxy_exit_max_accounts`, 1–10, default 3; 2026-11-01). */
export function exitCap(): number {
  const n = Number(getSetting("proxy_exit_max_accounts"));
  return Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 3;
}

/** SQL predicate (one `?` = now ISO): the proxy is not in a release cooldown. */
const NOT_COOLING_SQL = "(cooldown_until IS NULL OR cooldown_until <= ?)";

export interface IsolatedProxy {
  id: string; node_id: string; team_id: string | null; isolation_version: number;
  status: string; exit_ip: string | null; resource_key: string | null;
  cooldown_until: string | null; last_check_at: string | null;
  exit_country?: string | null; last_error?: string | null; group_name?: string | null;
}

/** Move pool rows into a group (null = ungroup). Ids not on this node are ignored; returns the count changed. */
export function setNodeProxyGroup(nodeId: string, proxyIds: string[], group: string | null): number {
  let n = 0;
  for (const raw of new Set(proxyIds)) {
    const id = raw.slice(0, 40);
    n += run("UPDATE node_proxies SET group_name = ? WHERE id = ? AND node_id = ? AND group_name IS NOT ?", group, id, nodeId, group).changes;
  }
  return n;
}

export interface ProxyGroupSummary {
  /** null = ungrouped rows. */
  group: string | null;
  total: number;
  live: number;
  dead: number;
  /** Rows carrying at least one bound account. */
  bound: number;
  /** Live, verified, unquarantined rows with a free slot (what "auto within this group" can draw from). */
  assignable: number;
}

/** Per-group tallies of a node's pool, ungrouped last. */
export function listNodeProxyGroups(nodeId: string): ProxyGroupSummary[] {
  const rows = all<IsolatedProxy & { group_name: string | null }>("SELECT * FROM node_proxies WHERE node_id=?", nodeId);
  const by = new Map<string | null, ProxyGroupSummary>();
  const now = nowIso();
  for (const p of rows) {
    const g = by.get(p.group_name ?? null) ?? { group: p.group_name ?? null, total: 0, live: 0, dead: 0, bound: 0, assignable: 0 };
    g.total += 1;
    if (p.status === "live") g.live += 1;
    if (p.status === "dead") g.dead += 1;
    const occ = p.resource_key ? proxyOccupancy(p.resource_key) : { bound: 0, reserved: 0, total: 0 };
    if (occ.bound > 0 || one("SELECT 1 FROM accounts WHERE bound_proxy_id=?", p.id)) g.bound += 1;
    if (p.isolation_version === 1 && p.status === "live" && p.resource_key && !quarantineActive(p.resource_key, `proxy:${p.id}`) &&
        (!p.cooldown_until || p.cooldown_until <= now) && occ.total < exitCap()) g.assignable += 1;
    by.set(p.group_name ?? null, g);
  }
  return [...by.values()].sort((a, b) => (a.group === null ? 1 : b.group === null ? -1 : a.group.localeCompare(b.group)));
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
    proxyOccupancy(observedKey).total<=exitCap())return true;
  return tx(()=>{
    const p=one<IsolatedProxy>("SELECT * FROM node_proxies WHERE id=? AND node_id=? AND isolation_version=1",proxyId,nodeId);
    if(!p)return false;
    const freeze=(why:string)=>{const f=freezeAccountsOnProxy(proxyId,why);if(f.length)console.warn(`[proxies] ${proxyId} ${why} → ${f.length} account(s) frozen (proxy_down)`);};
    if(quarantineActive(`proxy:${p.id}`)){
      run("UPDATE node_proxies SET status='dead',last_error='exit resource quarantined' WHERE id=?",proxyId);freeze("exit resource quarantined");return false;
    }
    const key=canonicalProxyResourceKey(ip);
    if(!key){run("UPDATE node_proxies SET status='dead',last_error='exit identity unavailable' WHERE id=?",proxyId);if(p.exit_ip)freeze("exit identity unavailable (the proxy stopped reporting a measurable exit IP)");return false;}
    const owner=one<{team_id:string}>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?",key);
    const reservedByOther=!!p.team_id && one(`SELECT 1 FROM onboarding_jobs WHERE proxy_resource_key=?
      AND ${liveReservationSql('onboarding_jobs')} AND (team_id IS NULL OR team_id<>?)`,key,p.team_id);
    const conflict=!!p.team_id && (!!owner && owner.team_id!==p.team_id || !!reservedByOther || !!quarantineActive(key));
    if(conflict){
      quarantineResource(`proxy:${p.id}`,"observed exit organization conflict");
      recordProxyTeamEvent({resourceKey:key,proxyId:p.id,nodeId,teamId:p.team_id,event:"exit_conflict",reason:"observed IP belongs to another organization"});
      run("UPDATE node_proxies SET status='dead',last_error='exit identity conflict' WHERE id=?",proxyId);freeze(`exit identity conflict (observed ${key.slice(3)} belongs to another organization)`);return false;
    }
    if(p.team_id)claimProxyResource(key,p.team_id);
    run("UPDATE node_proxies SET exit_ip=?,resource_key=? WHERE id=?",key.slice(3),key,proxyId);
    if(proxyOccupancy(key).total>exitCap()){
      quarantineResource(`proxy:${p.id}`,"exit capacity exceeded after observation");
      run("UPDATE node_proxies SET status='dead',last_error='exit capacity exceeded' WHERE id=?",proxyId);freeze("exit capacity exceeded after observation");return false;
    }
    if(p.resource_key!==key){
      recordProxyTeamEvent({resourceKey:key,proxyId:p.id,nodeId,teamId:p.team_id,event:"exit_observed",reason:p.resource_key?"provider exit changed":"first measured exit"});
      // Operator rule 2026-11-01: a provider that moved the exit changed the account's IP. The new exit is recorded
      // (so a release can accept it), but the accounts stop until an operator says so.
      if(p.resource_key)freeze(`exit IP changed ${p.exit_ip??"?"} → ${key.slice(3)} (release to accept the new exit, or rebind)`);
    }
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

/**
 * Why a proxy cannot carry an account of `teamId` right now (null = it can, capacity
 * aside). Codes are stable: the onboarding form shows them for an operator-picked proxy.
 *   legacy · dead · unprobed · exit_unverified · cooldown · quarantined ·
 *   other_organization · needs_virgin_exit · reserved_by_other
 */
export type ProxyIncompatibility = "legacy" | "dead" | "unprobed" | "exit_unverified" | "cooldown" | "quarantined" |
  "other_organization" | "needs_virgin_exit" | "reserved_by_other";

export function teamIncompatibleReason(p: IsolatedProxy, teamId: string | null): ProxyIncompatibility | null {
  if (p.isolation_version !== 1) return "legacy";
  if (p.status === "dead") return "dead";
  if (p.status !== "live") return "unprobed";
  if (!p.exit_ip || !p.resource_key || canonicalProxyResourceKey(p.exit_ip) !== p.resource_key) return "exit_unverified";
  if (p.cooldown_until && p.cooldown_until > nowIso()) return "cooldown";
  for (const key of [p.resource_key, `proxy:${p.id}`]) {
    if (quarantineActive(key)) return "quarantined";
    const claim = one<{ team_id: string }>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?", key);
    if (claim && claim.team_id !== teamId) return "other_organization";
    if (!teamId && claim) return "needs_virgin_exit";
  }
  if (p.team_id && p.team_id !== teamId) return "other_organization";
  // An unidentified account must discover its organization on a virgin,
  // exclusive resource; it may not borrow another organization's exit.
  if (!teamId && proxyOccupancy(p.resource_key).total !== 0) return "needs_virgin_exit";
  const pending = all<{ team_id: string | null;proxy_resource_key:string|null }>(`SELECT team_id,proxy_resource_key FROM onboarding_jobs
    WHERE (proxy_resource_key=? OR proxy_id=?) AND ${liveReservationSql('onboarding_jobs')}`, p.resource_key,p.id);
  return pending.every((j) => !!teamId && j.team_id === teamId && j.proxy_resource_key===p.resource_key) ? null : "reserved_by_other";
}

function teamCompatible(p: IsolatedProxy, teamId: string | null): boolean {
  return teamIncompatibleReason(p, teamId) === null;
}

/**
 * Caller reserves the returned resource inside the same BEGIN IMMEDIATE.
 * Automatic picks spread first (operator decision 2026-10-29; before, an exit was filled to two
 * before the next one opened, which put consecutive accounts on one IP): the least-loaded
 * compatible exit wins, so every exit in scope carries one account before any carries two, and
 * the third slot is used only when every exit already carries two. Ties keep the probe order
 * (oldest-checked first). An explicitly requested proxy (operator's pick or a self-supplied one)
 * is accepted as long as the hard limit of 3 holds (2026-10-28).
 */
export function resolveTeamProxy(nodeId: string, teamIdInput?: string | null, requested?: string, excludeJobId="", excludeProxyIds?: Set<string>, groupName?: string | null): IsolatedProxy {
  expireJobReservations();
  const teamId = normalizeTeamId(teamIdInput);
  if (teamIdInput && !teamId) throw new ProxyInputError("team_identity_invalid");
  if (requested && requested !== "auto") {
    const p = one<IsolatedProxy>("SELECT * FROM node_proxies WHERE node_id=? AND id=?", nodeId, requested);
    if (!p || excludeProxyIds?.has(p.id)) throw new ProxyInputError(`proxy_not_found: proxy ${requested} is not in this node's pool`);
    const reason = teamIncompatibleReason(p, teamId);
    if (reason) throw new ProxyInputError(`proxy_unassignable: ${reason}`);
    const occ = proxyOccupancy(p.resource_key!, excludeJobId);
    if (occ.total >= exitCap()) throw new ProxyInputError(`proxy_full: exit already carries ${occ.total} accounts (maximum ${exitCap()})`);
    return p;
  }
  // "auto within a group" (2026-10-29): only rows of that group are candidates.
  const group = groupName === undefined ? undefined : normalizeProxyGroup(groupName);
  const candidates = all<IsolatedProxy>("SELECT * FROM node_proxies WHERE node_id=? ORDER BY last_check_at,id", nodeId)
    .filter((p) => (group === undefined || (p.group_name ?? null) === group) && !excludeProxyIds?.has(p.id) && teamCompatible(p, teamId))
    .map((p) => ({ p, count: proxyOccupancy(p.resource_key!, excludeJobId).total }))
    .filter((x) => x.count < exitCap());
  // Stable sort: equal loads keep the probe order, so the pick walks the pool instead of camping on one exit.
  const selected = candidates.sort((a, b) => a.count - b.count)[0];
  if (!selected) throw new ProxyInputError(group !== undefined ? `No compatible verified proxy capacity in group ${group ?? "(ungrouped)"} (maximum ${exitCap()} per exit)` : `No compatible verified proxy capacity (maximum ${exitCap()} per exit)`);
  return selected.p;
}

export interface SuppliedProxyResult {
  /** Pool row id (sha256 of the stored URL); null on a dry run when the proxy is not in any pool yet. */
  proxyId: string | null;
  /** Node whose pool holds the row (may differ from the requested node when the proxy already lived elsewhere). */
  nodeId: string | null;
  /** How the input was understood, without the password. */
  parsed: { scheme: string; host: string; port: number; username: string | null; display: string };
  /** The row existed before this call (matched by stored URL or by host/port/credentials). */
  existed: boolean;
  /** A row was inserted by this call. */
  added: boolean;
  /** The pool was pushed to the node (false: node offline or nothing inserted). */
  pushed: boolean;
  status: string | null;
  lastError: string | null;
  exitIp: string | null;
  country: string | null;
  quarantined: boolean;
  quarantineReason: string | null;
  boundAccounts: number;
  reservedAccounts: number;
  /** null = assignable to `teamId` right now (capacity included); otherwise the reason. */
  blocked: ProxyIncompatibility | "full" | "not_in_pool" | null;
  /**
   * The row existed but nobody used it (no bound account, no live reservation) and something
   * blocked it (quarantine, cooldown, dead verdict, another organization's claim): it is treated
   * as a new proxy — dry run: would be reset on submit; real call: was reset and re-verifies now.
   */
  reset: boolean;
}

/**
 * Operator-supplied proxy for one onboarding (docs/onboarding.md §4.1): parse any of the
 * accepted shapes, reuse the pool row when the same endpoint is already known anywhere
 * (never a failure), otherwise append it to `nodeId`'s pool and push the pool so the node
 * probes it. `allowedNodes` restricts which pools may be matched/used (providers: own
 * nodes); a hit on another allowed node is returned with that node's id so the caller can
 * onboard there. `dryRun` only parses and looks up.
 */
export function resolveSuppliedProxy(nodeId: string, raw: string, opts: {
  teamId?: string | null; label?: string; group?: string | null; dryRun?: boolean; allowedNodes?: Set<string> | null;
  push?: (nodeId: string) => boolean;
}): SuppliedProxyResult {
  const parsed = parseProxyInput(raw);
  if (!parsed) throw new ProxyInputError("proxy_unparseable: expected host:port, host:port:user:pass, user:pass@host:port or a socks5:// / http:// URL");
  const canonical = canonicalProxyUrl(parsed);
  const fingerprint = proxyFingerprint(parsed);
  const allowed = (id: string) => !opts.allowedNodes || opts.allowedNodes.has(id);
  type Row = { id: string; node_id: string; url_enc: string };
  // 1) exact stored URL (canonical form or the input verbatim when it already was a URL).
  const direct = [canonical, raw.trim()].map((u) => proxyIdFromUrl(u));
  let hit = one<Row>(`SELECT id, node_id, url_enc FROM node_proxies WHERE id IN (?, ?) ORDER BY (node_id = ?) DESC LIMIT 1`, direct[0], direct[1], nodeId);
  // 2) same host/port/credentials written differently (this node first, then any other pool).
  if (!hit) {
    for (const r of all<Row>("SELECT id, node_id, url_enc FROM node_proxies ORDER BY (node_id = ?) DESC, created_at", nodeId)) {
      let url: string;
      try { url = decryptString(r.url_enc); } catch { continue; }
      if (proxyUrlFingerprint(url) === fingerprint) { hit = r; break; }
    }
  }
  if (hit && !allowed(hit.node_id)) throw new ProxyInputError(`proxy_on_other_node: this proxy is already in another node's pool`);
  const teamId = normalizeTeamId(opts.teamId ?? null);
  // An existing row nobody uses is the operator's to reuse as if new (user rule 2026-10-29):
  // a stale quarantine, cooldown, dead verdict or an old organization claim must not turn a
  // supplied proxy into a failure when no account or reservation depends on that exit.
  // "Treated as new" means exactly that: the stale row is dropped and the operator's canonical
  // URL (socks5 unless they wrote another scheme) is added to the node they chose, so the
  // result follows their selection instead of wherever/however the old row was recorded.
  let reset = false;
  if (hit) {
    const p = one<IsolatedProxy>("SELECT * FROM node_proxies WHERE id=?", hit.id)!;
    const occ = p.resource_key ? proxyOccupancy(p.resource_key) : { bound: 0, reserved: 0, total: 0 };
    const unused = occ.total === 0 && !one("SELECT 1 FROM accounts WHERE bound_proxy_id=?", p.id) && !proxyReserved(p.id);
    const reason = teamIncompatibleReason(p, teamId);
    const stuck = reason !== null && reason !== "unprobed" && reason !== "exit_unverified";
    // Organization claims on the exit IP are append-only by design (an exit that carried
    // organization A never becomes virgin again): those stay in force. Everything else that
    // blocks an unused row (quarantine, cooldown, dead verdict, stale row-level team tag) is cleared.
    const exitClaim = p.resource_key ? one<{ team_id: string }>("SELECT team_id FROM proxy_team_claims WHERE resource_key=?", p.resource_key) : undefined;
    const claimBlocks = !!exitClaim && exitClaim.team_id !== teamId;
    if (unused && stuck && !claimBlocks) {
      reset = true;
      if (!opts.dryRun) {
        const keys = [`proxy:${p.id}`, ...(p.resource_key ? [p.resource_key] : [])];
        liftQuarantine(keys, null, "re-supplied by an operator while unused");
        recordProxyTeamEvent({ resourceKey: p.resource_key ?? `proxy:${p.id}`, proxyId: p.id, nodeId: p.node_id, teamId: p.team_id,
          event: "resupplied", reason: `operator supplied this unused proxy again (was: ${reason}); old row dropped, re-added as new on node ${nodeId}` });
        run("DELETE FROM node_proxy_assignments WHERE proxy_id = ?", p.id);
        run("DELETE FROM node_proxies WHERE id = ?", p.id);
        if (p.node_id !== nodeId) opts.push?.(p.node_id);
        hit = undefined; // fall through to the insert below
      }
    }
  }
  const display = describeProxy(parsed);
  const base = { parsed: { scheme: parsed.scheme, host: parsed.host, port: parsed.port, username: parsed.username, display } };
  const snapshot = (id: string, owner: string, existed: boolean, added: boolean, pushed: boolean): SuppliedProxyResult => {
    const p = one<IsolatedProxy>("SELECT * FROM node_proxies WHERE id=? AND node_id=?", id, owner)!;
    const q = proxyQuarantine(p.id, p.resource_key);
    const occ = p.resource_key ? proxyOccupancy(p.resource_key) : { bound: 0, reserved: 0, total: 0 };
    const reason = teamIncompatibleReason(p, teamId);
    // Show the URL the pool actually holds (an existing row may be spelt differently from the input).
    let shown = base.parsed;
    try {
      const stored = parseProxyInput(decryptString(one<{ url_enc: string }>("SELECT url_enc FROM node_proxies WHERE id=?", p.id)!.url_enc));
      if (stored) shown = { scheme: stored.scheme, host: stored.host, port: stored.port, username: stored.username, display: describeProxy(stored) };
    } catch { /* unreadable ciphertext: keep the input's reading */ }
    return { ...base, parsed: shown, proxyId: p.id, nodeId: owner, existed, added, pushed, reset, status: p.status, lastError: p.last_error ?? null,
      exitIp: p.exit_ip, country: (p as IsolatedProxy & { exit_country?: string | null }).exit_country ?? null,
      quarantined: q.quarantined, quarantineReason: q.reason, boundAccounts: occ.bound, reservedAccounts: occ.reserved,
      blocked: reason ?? (occ.total >= exitCap() ? "full" : null) };
  };
  if (hit) return snapshot(hit.id, hit.node_id, true, false, false);
  if (opts.dryRun) {
    return { ...base, proxyId: null, nodeId: null, existed: false, added: false, pushed: false, reset: false, status: null, lastError: null, exitIp: null,
      country: null, quarantined: false, quarantineReason: null, boundAccounts: 0, reservedAccounts: 0, blocked: "not_in_pool" };
  }
  const res = addNodeProxies(nodeId, [{ url: canonical, label: opts.label ?? "supplied", group: opts.group ?? "supplied" }]);
  const id = proxyIdFromUrl(canonical);
  const pushed = res.added > 0 && !!opts.push?.(nodeId);
  return snapshot(id, nodeId, res.added === 0, res.added > 0, pushed);
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
  if (proxyOccupancy(p.resource_key, jobId).total >= exitCap()) throw new Error("proxy_capacity_reached");
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
    team_id: string|null; exit_ip:string|null; resource_key:string|null; exit_country: string | null; group_name: string | null;
    assigned: number;
    cooldown_until: string | null;
    cooldown_reason: string | null;
  }>(
    `SELECT p.id, p.url_enc, p.label, p.status, p.last_check_at, p.last_error, p.created_at, p.cooldown_until, p.cooldown_reason,p.team_id,p.exit_ip,p.resource_key,p.exit_country,p.group_name,
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
      group: r.group_name,
      country: r.exit_country,
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
      return {id:p.id,label:p.label,group:p.group_name??null,host,port,status:p.status,bound:slots.bound>0,quarantined:q.quarantined,quarantineReason:q.reason,
        boundAccounts:slots.bound,reservedAccounts:slots.reserved,
        normalSlots:Math.max(0,2-slots.total),overflowSlots:Math.max(0,3-slots.total),
        exitIp:p.exit_ip,resourceKey:p.resource_key,country:p.exit_country??null,
        usable:p.isolation_version===1 && p.status==='live' && !!p.resource_key &&
          !quarantineActive(p.resource_key,`proxy:${p.id}`) &&
          (!p.cooldown_until || p.cooldown_until<=nowIso()) && slots.total<exitCap()};
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
