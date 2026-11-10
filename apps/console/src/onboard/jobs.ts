import {
  all,
  accountTeamId,
  CCR,
  decryptJson,
  encryptJson,
  getSetting,
  isoIn,
  newId,
  nowIso,
  normalizeTeamId,
  ensureUpstreamTeam,
  recordProxyTeamEvent,
  one,
  readCredential,
  run,
  tx,
  type AccountRow,
  type Credential,
} from "@1dayapi/core";
import { authorizeWithSessionKey, exchangeCallbackCode, newPkce, OnboardError, verifyAccessToken, type AuthResult, fetchProfileViaEgress } from "./direct-oauth.js";
import { enrichAccountProfile } from "../ccr/profile.js";
import { claimDiscoveredProxy, claimTeamProxy, nodeProxyUrls, orgBindingEnforced, proxyOccupancy, quarantineJobProxy, resolveTeamProxy, type IsolatedProxy, exitCap, poolRow } from "../node/proxies.js";
import { pushProxies } from "../node/registry.js";
import { HttpError } from "../http.js";
import { assertNodeCapacity } from "../node/capacity.js";
import { requireTrustedExecutionNode } from "../node/trust.js";
import { CONSOLE_RESTART_CODE, endReservation, expireJobReservations, reservationDeadline } from "./reservations.js";
import { oncePer } from "../log-limit.js";
export { PENDING_CALLBACK_TTL_MS, WORKING_JOB_TTL_MS } from "./reservations.js";

// Onboarding job engine (docs/onboarding.md §2/§5). Jobs are async: the POST
// endpoint persists the job and the OAuth exchange continues in-process
// (through the target node's proxy, direct-oauth.ts); clients poll
// GET .../accounts/onboard/:jobId. Secret material (sessionKey, PKCE
// verifier/state) lives only in payload_enc and is cleared on done/failed.
//
// ONBOARD_MOCK=1 skips the upstream exchange and returns a canned token pair
// (e2e / dev); ONBOARD_MOCK_DELAY_MS keeps the job in flight that long.

export type OnboardMethod = "session_key" | "auth_url" | "credential";
export type OnboardScope = "admin" | "provider" | "onboarder";

export interface OnboardParams {
  /** Internal manual-token import: preserve its immediate scheduling and explicit limits. */
  credentialImport?:boolean;
  expectedTeamId?: string;
  teamName?: string;
  /**
   * Organization profile rule (docs/onboarding.md §10.1): the account's email must be under this
   * domain, checked from the OAuth profile before the row is written; mismatch fails the job.
   */
  expectedDomain?: string;
  /** Saved organization (onboard_orgs.id) the operator picked, for reporting. */
  orgProfileId?: string;
  /** Resolved at job start from the target node; null = platform-owned. */
  ownerId?: string | null;
  concurrencyLimit?: number;
  rpmLimit?: number;
  name?: string;
  note?: string;
  /** admin scope only: group to place the approved account in. */
  groupId?: string;
  /**
   * Re-authorization (docs/onboarding.md §11): the job must end in this existing
   * account row — credential replaced in place, nothing inserted. The exchanged
   * identity (OAuth accountUuid / email) has to match the row or the job fails.
   */
  reauthAccountId?: string;
  /** Set by the engine when the job ended by re-authorizing an existing row (either path). */
  reauthorized?: boolean;
}

export interface JobRow {
  id: string;
  requester_id: string | null;
  scope: OnboardScope;
  method: OnboardMethod;
  node_id: string;
  proxy_id: string | null;
  team_id:string|null;
  isolation_version:number;
  proxy_resource_key:string|null;
  egress_started_at:string|null;
  reservation_account_id:string|null;
  expires_at:string|null;
  params_json: string | null;
  payload_enc: string | null;
  authorize_url: string | null;
  status: "pending_callback" | "working" | "done" | "failed";
  account_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const jobControllers=new Map<string,AbortController>();
function jobSignal(id:string):AbortSignal {
  let controller=jobControllers.get(id);
  if(!controller){controller=new AbortController();jobControllers.set(id,controller);}
  return controller.signal;
}

export function getJob(id: string): JobRow | undefined {
  return one<JobRow>("SELECT * FROM onboarding_jobs WHERE id = ?", id);
}

export function jobOut(j: JobRow, admin = false) {
  const acc = j.account_id
    ? one<{ created_at: string; name: string; account_email: string | null; temp_unschedulable_until: string | null }>(
        "SELECT created_at, name, account_email, temp_unschedulable_until FROM accounts WHERE id = ?",
        j.account_id,
      )
    : undefined;
  // A done job whose account predates the job re-authorized an existing account
  // in place (docs/onboarding.md §11: revoked row + same Claude account, or an
  // explicit re-auth): the onboarder must see that nothing new was added.
  let flagged = false;
  let p: OnboardParams = {};
  try {
    p = j.params_json ? (JSON.parse(j.params_json) as OnboardParams) : {};
    flagged = p.reauthorized === true;
  } catch {
    flagged = false;
  }
  const reused = flagged || (!!acc && acc.created_at < j.created_at);
  const cooldownUntil = acc?.temp_unschedulable_until && acc.temp_unschedulable_until > nowIso() ? acc.temp_unschedulable_until : undefined;
  return {
    jobId: j.id,
    method:j.method,
    nodeId:j.node_id,
    expiresAt:j.expires_at??undefined,
    status: j.status,
    accountId: j.account_id ?? undefined,
    accountName: acc?.name,
    accountEmail: acc?.account_email ?? undefined,
    ...(p.teamName ? { orgName: p.teamName } : {}),
    ...(p.expectedDomain ? { domain: p.expectedDomain } : {}),
    ...(reused ? { reused: true } : {}),
    ...(cooldownUntil ? { cooldownUntil } : {}),
    error: j.error ? (admin ? j.error : `${j.error.match(/^([a-z][a-z0-9_]{0,63}):/)?.[1]??"authorization_failed"}: account authorization could not be completed`) : undefined,
    authorizeUrl: j.authorize_url ?? undefined,
  };
}

function insertJob(
  scope: OnboardScope,
  requesterId: string,
  method: OnboardMethod,
  nodeId: string,
  proxyId: string,
  params: OnboardParams,
  payload: unknown,
  status: "working" | "pending_callback",
  authorizeUrl: string | null,
): string {
  requireTrustedExecutionNode(nodeId);
  expireJobReservations();
  assertNodeCapacity(nodeId, params.reauthAccountId);
  if(params.reauthAccountId && one("SELECT 1 FROM onboarding_jobs j WHERE reservation_account_id=? AND j.isolation_version=1 AND j.status IN ('working','pending_callback')",params.reauthAccountId))
    throw new HttpError(409,"reauth_in_progress","This account already has an active authorization job");
  const id = newId();
  const now = nowIso();
  // Home row or a row shared into this node (cross-node sharing, 2026-11-08).
  const p=poolRow(nodeId,proxyId);
  if(!p || p.isolation_version!==1 || !p.resource_key)throw new OnboardError("proxy_unverified","A measured isolated proxy is required");
  const expected=params.expectedTeamId??null;
  if(orgBindingEnforced() && p.team_id && p.team_id!==expected)throw new OnboardError("proxy_team_mismatch","Proxy organization mismatch");
  const alreadyBound=params.reauthAccountId && one("SELECT 1 FROM accounts WHERE id=? AND bound_proxy_id=?",params.reauthAccountId,proxyId);
  if(!alreadyBound && proxyOccupancy(p.resource_key).total>=exitCap())throw new OnboardError("proxy_capacity_reached","Proxy account capacity reached");
  run(
    `INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, proxy_id, params_json, payload_enc, authorize_url, status, created_at, updated_at,
      team_id,isolation_version,proxy_resource_key,reservation_account_id,expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,1,?,?,?)`,
    id,
    requesterId,
    scope,
    method,
    nodeId,
    proxyId,
    JSON.stringify(params),
    encryptJson(payload),
    authorizeUrl,
    status,
    now,
    now,
    expected,p.resource_key,params.reauthAccountId??null,reservationDeadline(status),
  );
  recordProxyTeamEvent({resourceKey:p.resource_key,proxyId,nodeId,teamId:expected,jobId:id,actorId:requesterId,
    event:"slot_reserved",reason:alreadyBound?"reauthorize existing fixed binding":proxyOccupancy(p.resource_key,id).total>=2?"third slot: no normal capacity":"normal slot (up to two accounts)"});
  pushProxies(nodeId,nodeProxyUrls(nodeId));
  return id;
}

// ---------- PKCE / authorize URL (docs/onboarding.md §2, method=auth_url) ----------

export function buildAuthorizeUrl(): { authorizeUrl: string; codeVerifier: string; state: string } {
  const { codeVerifier, codeChallenge, state } = newPkce();
  const a = CCR.authorize;
  const authorizeUrl = a.urlTemplate
    .replace("{client_id}", encodeURIComponent(a.clientId))
    .replace("{redirect_uri}", encodeURIComponent(a.redirectUri))
    .replace("{scope}", encodeURIComponent(a.scopes))
    .replace("{code_challenge}", encodeURIComponent(codeChallenge))
    .replace("{state}", encodeURIComponent(state));
  return { authorizeUrl, codeVerifier, state };
}

/** Parse the pasted callback: accepts full URL, `code#state`（官方回调页展示格式）, or bare code（state 以 job 内为准）. */
export function parseCallbackUrl(callbackUrl: string, expectedState: string): { code: string } | null {
  const s = callbackUrl.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    if (!code || state !== expectedState) return null;
    return { code };
  }
  const hash = s.indexOf("#");
  if (hash > 0) {
    const code = s.slice(0, hash);
    const state = s.slice(hash + 1);
    return code && state === expectedState ? { code } : null;
  }
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return { code: s };
  return null;
}

// ---------- job creation ----------

export function startSessionKeyJob(
  scope: OnboardScope,
  requesterId: string,
  nodeId: string,
  proxyId: string,
  sessionKey: string,
  params: OnboardParams,
  /** Optional 组织 UUID from the form: skips the claude.ai organizations lookup (docs/onboarding.md §2.1). */
  orgUuid?: string,
): string {
  const id = insertJob(scope, requesterId, "session_key", nodeId, proxyId, params, { sessionKey, orgUuid }, "working", null);
  void runSessionKeyJob(id);
  return id;
}

/** A manual OAuth import is verified over the reserved node exit, not trusted from JSON. */
export async function importOAuthCredential(scope:OnboardScope,requesterId:string,nodeId:string,credential:Credential,params:OnboardParams):Promise<string> {
  if(!credential.accessToken)throw new OnboardError("validate_failed","An OAuth access token is required");
  if(params.expectedTeamId){
    const team=normalizeTeamId(params.expectedTeamId);
    if(!team)throw new HttpError(400,"team_identity_invalid","Organization UUID must be valid");
    params={...params,expectedTeamId:team};
  }
  params={...params,credentialImport:true};
  const id=tx(()=>{
    const p=resolveTeamProxy(nodeId,params.expectedTeamId);
    return insertJob(scope,requesterId,"credential",nodeId,p.id,params,credential,"working",null);
  });
  try{
    const job=getJob(id)!;
    const mock=await mockAuth();
    const identity=mock??await verifyAccessToken(egressTarget(job),credential.accessToken);
    const res:AuthResult={accessToken:credential.accessToken,refreshToken:credential.refreshToken??"",
      expiresAt:credential.expiresAt??isoIn(3600_000),orgUuid:identity.orgUuid,accountUuid:identity.accountUuid};
    await finishVerifiedJob(job,res);
  }catch(e){failFromError(id,e);}
  const done=getJob(id)!;
  if(done.status!=="done" || !done.account_id)throw new HttpError(400,"oauth_verification_failed",scope==='admin'?(done.error??"Credential verification failed"):"Account authorization could not be completed");
  return done.account_id;
}

export function startAuthUrlJob(
  scope: OnboardScope,
  requesterId: string,
  nodeId: string,
  proxyId: string,
  params: OnboardParams,
): { jobId: string; authorizeUrl: string } {
  const { authorizeUrl, codeVerifier, state } = buildAuthorizeUrl();
  const id = insertJob(
    scope,
    requesterId,
    "auth_url",
    nodeId,
    proxyId,
    params,
    { codeVerifier, state },
    "pending_callback",
    authorizeUrl,
  );
  return { jobId: id, authorizeUrl };
}

/** Step 2 of method=auth_url: state already validated by the route. */
export function continueAuthUrlJob(jobId: string, callbackUrl: string): void {
  expireJobReservations();
  const changed=run("UPDATE onboarding_jobs SET status = 'working', updated_at = ?, expires_at=? WHERE id = ? AND isolation_version=1 AND status='pending_callback'", nowIso(), reservationDeadline("working"), jobId).changes;
  if (!changed) throw new HttpError(400,"job_expired","Authorization reservation is no longer active");
  void runAuthUrlJob(jobId, callbackUrl);
}

/**
 * Jobs cannot outlive the process that runs them: after a console restart
 * every 'working' job is dead, and a callback nobody pasted within 30 minutes
 * is stale (its PKCE verifier should not linger). Called at boot and on every
 * upkeep tick.
 */
export function sweepStaleJobs(now = Date.now()): number {
  const before=one<{n:number}>("SELECT COUNT(*) n FROM onboarding_jobs WHERE isolation_version=1 AND status IN ('working','pending_callback')")!.n;
  for (const nodeId of expireJobReservations(now)) pushProxies(nodeId,nodeProxyUrls(nodeId));
  for (const [id,controller] of jobControllers) if(getJob(id)?.status!=="working") {controller.abort();jobControllers.delete(id);}
  return before-one<{n:number}>("SELECT COUNT(*) n FROM onboarding_jobs WHERE isolation_version=1 AND status IN ('working','pending_callback')")!.n;
}

/**
 * Boot only (review fix 2026-11-10): a `working` job is a promise running inside the console process, so after a
 * restart nobody is running it. Before, such a job kept its reservation until the 3-minute deadline and then failed as
 * `job_expired`, which quarantined an exit that had gone out with no organization known. Now every `working` job
 * fails at once with `console_restarted`: the slot is released and the exit is NOT quarantined (the failure says
 * nothing about the exit). `pending_callback` jobs wait for the operator's paste and survive a restart. Call before
 * any job can start in this process. Returns the number of jobs failed.
 */
export function failInterruptedJobs(): number {
  const rows = all<{ id: string; isolation_version: number }>("SELECT id, isolation_version FROM onboarding_jobs WHERE status='working'");
  let n = 0;
  for (const j of rows) {
    if (jobControllers.has(j.id)) continue; // started by this process: not interrupted
    const ended = j.isolation_version === 1
      ? endReservation(j.id, CONSOLE_RESTART_CODE, "The console restarted while this authorization was running; start it again")
      : run("UPDATE onboarding_jobs SET status='failed', error=?, payload_enc=NULL, updated_at=? WHERE id=? AND status='working'",
          `${CONSOLE_RESTART_CODE}: The console restarted while this authorization was running; start it again`, nowIso(), j.id).changes > 0;
    if (ended) n++;
  }
  return n;
}

/** Runs separately from slow token refresh/probe work and also when probing is disabled. */
export function startOnboardingMaintenance(): () => void {
  sweepStaleJobs();
  const timer=setInterval(()=>{try{sweepStaleJobs();}catch(error){console.error("[onboard] reservation expiry failed",error);}},15_000);
  timer.unref();
  return ()=>clearInterval(timer);
}

export function cancelJob(jobId:string): void {
  failJob(jobId,"job_cancelled","Authorization cancelled by the operator");
}

// ---------- runners ----------

function failJob(jobId: string, code: string, message: string): void {
  const j=getJob(jobId);
  if(endReservation(jobId,code,message) && j)pushProxies(j.node_id,nodeProxyUrls(j.node_id));
  jobControllers.get(jobId)?.abort();
  jobControllers.delete(jobId);
}

function failFromError(jobId: string, err: unknown): void {
  if (err instanceof OnboardError) failJob(jobId, err.code, err.message);
  else failJob(jobId, "authorize_failed", (err as Error).message);
}

/** The job's egress: its node + the proxy reserved for the account-to-be (docs/onboarding.md §1 一号一代理). */
function egressTarget(job: JobRow): { nodeId: string; proxyId: string; bindingId: string;teamId:string; signal:AbortSignal } {
  expireJobReservations();
  if (getJob(job.id)?.status !== "working") throw new OnboardError("job_expired", "Authorization reservation is no longer active");
  if (!one("SELECT 1 FROM node_proxies WHERE id = ?", job.proxy_id)) throw new OnboardError("node_offline", "the reserved proxy row is gone");
  run("UPDATE onboarding_jobs SET egress_started_at=COALESCE(egress_started_at,?) WHERE id=?",nowIso(),job.id);
  return { nodeId: job.node_id, proxyId: job.proxy_id!, bindingId: `onboard_${job.id}`,teamId:job.team_id??`pending:${job.id}`,signal:jobSignal(job.id) };
}

async function mockAuth(): Promise<AuthResult | null> {
  if (process.env.ONBOARD_MOCK !== "1") return null;
  const delay = Number(process.env.ONBOARD_MOCK_DELAY_MS) || 0;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  return {
    accessToken: `sk-ant-oat-mock-${newId().slice(0, 8)}`,
    refreshToken: "sk-ant-ort-mock",
    expiresAt: isoIn(8 * 3_600_000),
    orgUuid: process.env.ONBOARD_MOCK_ORG_UUID || "11111111-1111-4111-8111-111111111111",
    // ONBOARD_MOCK_ACCOUNT_UUID pins the underlying account (duplicate-onboarding tests).
    accountUuid: process.env.ONBOARD_MOCK_ACCOUNT_UUID || `acct_mock_${newId().slice(0, 8)}`,
    email: "mock@example.com",
  };
}

async function runSessionKeyJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.proxy_id || !job.payload_enc) return;
  try {
    const { sessionKey, orgUuid } = decryptJson<{ sessionKey: string; orgUuid?: string }>(job.payload_enc);
    const res = (await mockAuth()) ?? (await authorizeWithSessionKey(egressTarget(job), sessionKey, orgUuid));
    await finishVerifiedJob(job, res);
  } catch (err) {
    failFromError(jobId, err);
  }
}

async function runAuthUrlJob(jobId: string, callbackUrl: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.proxy_id || !job.payload_enc) return;
  try {
    const payload = decryptJson<{ codeVerifier: string; state: string }>(job.payload_enc);
    const parsed = parseCallbackUrl(callbackUrl, payload.state);
    if (!parsed) throw new OnboardError("authorize_failed", "callback_invalid: callback URL cannot be parsed or its state does not match");
    const res = (await mockAuth()) ?? (await exchangeCallbackCode(egressTarget(job), parsed.code, payload.codeVerifier, payload.state));
    await finishVerifiedJob(job, res);
  } catch (err) {
    failFromError(jobId, err);
  }
}

async function finishVerifiedJob(job:JobRow,res:AuthResult):Promise<void> {
  expireJobReservations();
  const current=getJob(job.id);
  if(!current)return;
  job=current;
  const actual=normalizeTeamId(res.orgUuid);
  if(!actual || (job.team_id && job.team_id!==actual)){
    if(job.proxy_resource_key)recordProxyTeamEvent({resourceKey:job.proxy_resource_key,proxyId:job.proxy_id,nodeId:job.node_id,
      teamId:actual,jobId:job.id,actorId:job.requester_id,event:"organization_mismatch",reason:"validated organization differs from reservation; exit quarantined"});
    throw new OnboardError("team_mismatch","Verified organization mismatch");
  }
  if(current.status!=='working')return;
  if(!job.team_id){
    tx(()=>{
      const params:OnboardParams=job.params_json?JSON.parse(job.params_json):{};
      ensureUpstreamTeam(actual,params.teamName);
      claimDiscoveredProxy(job.proxy_id!,actual,job.id);
      run("UPDATE onboarding_jobs SET team_id=? WHERE id=?",actual,job.id);
      // Spread-first policy (2026-10-29): the discovery exit (virgin, so the least loaded) is kept unless a
      // strictly less-loaded same-organization exit exists in the same proxy group — which cannot happen
      // for a virgin exit, so the account normally stays where it authorized.
      const reservedGroup=one<{group_name:string|null}>("SELECT group_name FROM node_proxies WHERE id=?",job.proxy_id!);
      const final=resolveTeamProxy(job.node_id,actual,undefined,job.id,undefined,reservedGroup?(reservedGroup.group_name??null):undefined);
      if(final.id!==job.proxy_id && proxyOccupancy(final.resource_key!,job.id).total<proxyOccupancy(job.proxy_resource_key!,job.id).total){
        recordProxyTeamEvent({resourceKey:job.proxy_resource_key!,proxyId:job.proxy_id,nodeId:job.node_id,teamId:actual,
          jobId:job.id,event:"discovery_slot_released",reason:"final account uses a less-loaded same-organization exit"});
        run("UPDATE onboarding_jobs SET proxy_id=?,proxy_resource_key=? WHERE id=?",final.id,final.resource_key,job.id);
        recordProxyTeamEvent({resourceKey:final.resource_key!,proxyId:final.id,nodeId:job.node_id,teamId:actual,jobId:job.id,
          actorId:job.requester_id,event:"slot_reserved",reason:proxyOccupancy(final.resource_key!,job.id).total>=2?
            "third slot: every exit carries two":"discovery complete: least-loaded exit"});
      }
    });
    pushProxies(job.node_id,nodeProxyUrls(job.node_id));
    job=getJob(job.id)!;
    if(process.env.ONBOARD_MOCK!=="1"){
      const v=await verifyAccessToken(egressTarget(job),res.accessToken);
      if(normalizeTeamId(v.orgUuid)!==actual || (v.accountUuid && res.accountUuid && v.accountUuid!==res.accountUuid))
        throw new OnboardError("team_mismatch","Final exit token identity mismatch");
    }
  }
  await finishJob(job,res);
}

/** Find the platform row for an underlying Claude account uuid (prefer active, then newest). */
function findByAccountUuid(uuid: string): AccountRow | undefined {
  const rows = all<AccountRow>("SELECT * FROM accounts WHERE platform = 'anthropic' AND type = 'oauth' AND team_id IS NOT NULL ORDER BY updated_at DESC");
  let fallback: AccountRow | undefined;
  for (const r of rows) {
    try {
      if (readCredential(r).accountId === uuid) {
        if (r.status === "active") return r;
        fallback ??= r;
      }
    } catch (err) {
      // Unreadable credential: the row cannot be matched, so a duplicate of this very account could be onboarded
      // unnoticed. Said once per account per hour (id only, never the ciphertext).
      if (oncePer(`cred-unreadable:${r.id}`, 3_600_000))
        console.error(`[onboard] account ${r.id} has an unreadable credential and is skipped by the duplicate-account lookup: ${(err as Error)?.name ?? "Error"}`);
    }
  }
  return fallback;
}

/** Turn a token pair into the account row + proxy binding (single transaction). */
async function finishJob(job: JobRow, res: AuthResult): Promise<void> {
  const params: OnboardParams = job.params_json ? JSON.parse(job.params_json) : {};
  const now = nowIso();
  const teamId=normalizeTeamId(res.orgUuid);
  if(!teamId || (job.team_id && job.team_id!==teamId)){
    failJob(job.id,"team_mismatch","The verified upstream organization differs from the reserved organization");return;
  }
  // Organization profile domain rule (§10.1): learn the email now (profile through the job's
  // own egress) and refuse an account from another domain before anything is written.
  if (params.expectedDomain) {
    if (!res.email) {
      const target = egressTarget(job);
      const profile = (await fetchProfileViaEgress(target, res.accessToken)) ?? (await fetchProfileViaEgress(target, res.accessToken));
      if (profile?.email) res.email = profile.email;
      else console.warn(`[onboard] job ${job.id}: profile unavailable before insert; domain rule ${params.expectedDomain} not checked up front`);
    }
    const domain = res.email?.split("@")[1]?.toLowerCase();
    if (domain && domain !== params.expectedDomain.toLowerCase()) {
      failJob(job.id, "domain_mismatch", `账号邮箱 ${res.email} 不属于所选域名 ${params.expectedDomain}，已拒绝，未新增账号 / account ${res.email} is not under the selected domain ${params.expectedDomain}`);
      return;
    }
  }
  // Owner was resolved at job start from the node (provider node → that
  // provider, platform node → platform); legacy rows fall back to the scope rule.
  const ownerId = params.ownerId !== undefined ? params.ownerId : job.scope === "provider" ? job.requester_id : null;
  const credential = encryptJson({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    expiresAt: res.expiresAt,
    orgUuid: res.orgUuid,
    accountId: res.accountUuid,
  });
  // One Claude account = one row (一号一IP). Since 2026-10-20 (user decision) a
  // second onboarding of the same underlying account (OAuth accountUuid, email as
  // fallback) is REFUSED while that row is healthy: the existing row keeps its
  // credential, proxy binding and state untouched, the job fails with
  // account_exists and the freshly exchanged token pair is discarded.
  // Since 2026-10-22 (docs/onboarding.md §11) a row in `error` state (401 revoked,
  // on hold, …) owned by the same party is instead re-authorized IN PLACE: new
  // credential, state cleared, groups / priority / limits / proxy binding kept.
  const existing = res.accountUuid
    ? findByAccountUuid(res.accountUuid)
    : res.email
      ? one<AccountRow>("SELECT * FROM accounts WHERE platform = 'anthropic' AND type = 'oauth' AND team_id IS NOT NULL AND account_email = ?", res.email)
      : undefined;
  if (params.reauthAccountId) {
    const target = one<AccountRow>("SELECT * FROM accounts WHERE id = ?", params.reauthAccountId);
    if (!target) {
      failJob(job.id, "account_not_found", `要补授权的账号 ${params.reauthAccountId.slice(0, 8)} 已不存在`);
      return;
    }
    const mismatch = existing ? existing.id !== target.id : !identityMatches(target, res);
    if (mismatch) {
      const got = res.email ?? res.accountUuid ?? "unknown";
      console.warn(`[onboard] job ${job.id}: re-auth identity mismatch for ${target.id} (${target.account_email ?? target.name}); authorized ${got}`);
      failJob(job.id, "account_mismatch", `授权的是另一个账号（${got}），与要补授权的账号（${target.account_email ?? target.name}）不一致，已拒绝，账号未改动`);
      return;
    }
    await reauthorizeInPlace(job, target, credential, res);
    return;
  }
  if (existing) {
    if(accountTeamId(existing)!==teamId){failJob(job.id,"team_conflict","This upstream account already belongs to a different managed organization");return;}
    const label = existing.account_email ?? res.email ?? existing.name;
    if (existing.status === "error" && (existing.owner_id ?? null) === (ownerId ?? null)) {
      console.info(`[onboard] job ${job.id}: account ${existing.id} (${label}) is in error state; re-authorizing in place`);
      await reauthorizeInPlace(job, existing, credential, res);
      return;
    }
    console.warn(`[onboard] job ${job.id}: account already exists (${existing.id} ${label}, status=${existing.status}); refused, existing row NOT replaced`);
    failJob(job.id, "account_exists", `账号已存在（${label}，id ${existing.id.slice(0, 8)}，状态 ${existing.status}），不允许重复上号，已有账号未替换`);
    return;
  }
  // 新号冷静期 (user rule 2026-10-20): the account sits out of scheduling for a
  // random 15–20 min after the authorization completes (settings
  // onboard_cooldown_min/max_sec; both 0 = off). The usage-baseline probe and the
  // profile fetch still run — a real Claude Code client does those right after login.
  // Provider self-onboarding (user rule 2026-10-26): no cooldown, no review — the
  // account is schedulable the moment the authorization lands.
  const cooldown = job.scope === "provider" || params.credentialImport ? null : onboardCooldown();
  let finalAccountId: string | null = null;
  try {
    tx(() => {
      expireJobReservations();
    if(getJob(job.id)?.status!=='working')throw new Error("job_expired");
      assertNodeCapacity(job.node_id, "", job.id);
      const accountId = newId();
      finalAccountId = accountId;
      ensureUpstreamTeam(teamId,params.teamName);
      claimTeamProxy(job.proxy_id!,teamId,accountId,job.id);
      run(
          `INSERT INTO accounts (id, name, platform, type, executor, protocol, base_url, credential_enc,
                                 owner_id, route, node_id, review_status, review_note, payout_rate, priority,
                                 concurrency, rpm_limit, bound_proxy_id, account_email, temp_unschedulable_until, error_message, created_at, updated_at,team_id)
           VALUES (?, ?, 'anthropic', 'oauth', ?, 'anthropic', 'https://api.anthropic.com', ?,
                   ?, 'node', ?, ?, ?, ?, 50, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          accountId,
          params.name ?? res.email ?? `claude-${accountId.slice(0, 8)}`,
          onboardExecutor(),
          credential,
          ownerId,
          job.node_id,
          "approved",
          params.note ?? null,
          // Provider-owned accounts earn the default payout (what admin review used to set); platform ones none.
          ownerId ? Number(getSetting("provider_default_payout_rate")) || 0 : 0,
          params.credentialImport?(params.concurrencyLimit??0):params.concurrencyLimit || onboardDefault("onboard_default_concurrency"),
          params.credentialImport?(params.rpmLimit??0):params.rpmLimit || onboardDefault("onboard_default_rpm_limit"),
          job.proxy_id,
          res.email ?? null,
          cooldown?.until ?? null,
          cooldown ? `${ONBOARD_COOLDOWN_TAG}: 新账号冷静期，授权后 ${Math.round(cooldown.ms / 60_000)} 分钟内不参与调度` : null,
          now,
          now,
          teamId,
      );
      if (cooldown) console.info(`[onboard] job ${job.id}: account ${accountId} in onboarding cooldown until ${cooldown.until} (${Math.round(cooldown.ms / 1000)}s)`);
      // Claim the proxy atomically: a concurrent job may have bound it meanwhile.
      // Group follows the owner, not the requester (docs/onboarding.md §1 原则 5, 2026-10-29): a
      // provider-owned account (provider onboarding, or anyone onboarding onto that provider's node)
      // lands in the provider's users.onboard_group_id — its self-use pool — so an admin cannot
      // accidentally feed a provider's node into the public pool. Platform-owned accounts take the
      // requested group or the default one.
      const ownerGroup = ownerId
        ? one<{ onboard_group_id: string | null }>("SELECT onboard_group_id FROM users WHERE id = ?", ownerId)?.onboard_group_id ?? null
        : null;
      const groupId = ownerGroup ?? params.groupId ?? getSetting("default_group_id");
      if (!one("SELECT 1 FROM groups WHERE id = ?", groupId)) throw new Error(`group_not_found: ${groupId}`);
      if (!one("SELECT 1 FROM account_groups WHERE account_id = ? AND group_id = ?", accountId, groupId)) {
        run("INSERT INTO account_groups (account_id, group_id, priority) VALUES (?, ?, 50)", accountId, groupId);
      }
      run(
        "UPDATE onboarding_jobs SET status = 'done', account_id = ?, payload_enc = NULL, updated_at = ? WHERE id = ?",
        accountId,
        now,
        job.id,
      );
    });
  } catch (err) {
    const msg = (err as Error).message;
    // Platform-side bookkeeping failures keep their own (non-tainting) code: on 2026-11-06 a proxy_team_mismatch thrown
    // here was filed as authorize_failed, which quarantined and killed two healthy exits (reservations.ts EXIT_TAINTING_CODES).
    const own = /^(proxy_bound|group_not_found|proxy_team_mismatch|proxy_identity_changed|proxy_capacity_reached|proxy_quarantined)/.exec(msg);
    failJob(job.id, own ? own[1] : "authorize_failed", msg);
    return;
  }
  jobControllers.delete(job.id);
  pushProxies(job.node_id,nodeProxyUrls(job.node_id));
  if (finalAccountId) await fetchProfileBestEffort(finalAccountId);
}

/**
 * Email + plan from the OAuth profile, through the account's bound proxy. Best effort:
 * the account is already live; a failure only leaves the fields empty (admin can
 * retry with POST /api/admin/accounts/:id/profile).
 */
async function fetchProfileBestEffort(accountId: string): Promise<void> {
  if (process.env.ONBOARD_PROFILE_FETCH === "0") return;
  const row = one<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId);
  if (!row) return;
  try {
    const p = await enrichAccountProfile(row);
    console.info(`[onboard] profile for ${row.id}: ${p.email ?? "no email"} / ${p.subscriptionType ?? "plan unknown"}`);
  } catch (err) {
    console.warn(`[onboard] profile fetch failed for ${row.id}: ${(err as Error).message}`);
  }
}

/** Does the exchanged identity belong to this row? Unknown on both sides counts as a match (nothing to compare). */
function identityMatches(row: AccountRow, res: AuthResult): boolean {
  let storedUuid: string | undefined;
  try {
    storedUuid = readCredential(row).accountId;
  } catch {
    storedUuid = undefined;
  }
  if (storedUuid && res.accountUuid) return storedUuid === res.accountUuid;
  if (row.account_email && res.email) return row.account_email.toLowerCase() === res.email.toLowerCase();
  return true;
}

/**
 * Re-authorize an existing row in place (docs/onboarding.md §11): replace the
 * credential, clear error + cooldowns (window measurements kept), keep groups,
 * priority, limits, owner and review state. The proxy binding is kept when the
 * bound proxy is still live; otherwise the account moves to the proxy the job
 * reserved (old proxy released, tainted cooldown as on delete). No onboarding
 * cooldown: this is a re-login of a known account, not a new one.
 */
async function reauthorizeInPlace(job: JobRow, row: AccountRow, credential: string, res: AuthResult): Promise<void> {
  const teamId=accountTeamId(row);
  const bound=row.bound_proxy_id?one<IsolatedProxy>("SELECT * FROM node_proxies WHERE id=?",row.bound_proxy_id):undefined;
  if(!teamId || teamId!==normalizeTeamId(res.orgUuid) || job.team_id!==teamId){
    failJob(job.id,"team_mismatch","Organization cannot change during re-authorization");return;
  }
  if(!bound || bound.status!=="live" || (orgBindingEnforced() && bound.team_id!==teamId) || bound.id!==job.proxy_id || bound.resource_key!==job.proxy_resource_key){
    failJob(job.id,"fixed_proxy_unavailable","The fixed proxy is unavailable; automatic rebinding is disabled");return;
  }
  const now=nowIso();
  tx(()=>{
    expireJobReservations();
    if(getJob(job.id)?.status!=='working')throw new Error("job_expired");
    run(`UPDATE accounts SET credential_enc=?,status='active',error_message=NULL,rate_limited_until=NULL,
      overload_until=NULL,temp_unschedulable_until=NULL,window_exhausted_until=NULL,window_reason=NULL,
      model_cooldowns=NULL,account_email=COALESCE(?,account_email),updated_at=? WHERE id=? AND team_id=?`,
      credential,res.email??null,now,row.id,teamId);
    const params:OnboardParams=job.params_json?JSON.parse(job.params_json):{};
    run("UPDATE onboarding_jobs SET status='done',account_id=?,params_json=?,payload_enc=NULL,updated_at=? WHERE id=?",
      row.id,JSON.stringify({...params,reauthorized:true}),now,job.id);
    recordProxyTeamEvent({resourceKey:bound.resource_key!,proxyId:bound.id,nodeId:job.node_id,teamId,
      accountId:row.id,jobId:job.id,event:"account_reauthorized",actorId:job.requester_id,reason:"fixed proxy retained"});
  });
  jobControllers.delete(job.id);
  pushProxies(job.node_id,nodeProxyUrls(job.node_id));
  await fetchProfileBestEffort(row.id);
}

/** Platform default for a limit the onboarding form left empty / 0 (settings `onboard_default_concurrency` / `_rpm_limit`). */
function onboardDefault(key: "onboard_default_concurrency" | "onboard_default_rpm_limit"): number {
  const n = Number(getSetting(key));
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** error_message prefix that marks the onboarding cooldown (the account list shows it as 新号冷静期, not as an error). */
export const ONBOARD_COOLDOWN_TAG = "onboard_cooldown";

/** Random pause for a freshly onboarded account (settings `onboard_cooldown_min_sec`..`_max_sec`); null = disabled. */
function onboardCooldown(now = Date.now()): { ms: number; until: string } | null {
  const lo = Math.max(0, Number(getSetting("onboard_cooldown_min_sec")) || 0);
  const hi = Math.max(lo, Number(getSetting("onboard_cooldown_max_sec")) || 0);
  if (hi <= 0) return null;
  const ms = Math.round((lo + Math.random() * (hi - lo)) * 1000);
  return { ms, until: new Date(now + ms).toISOString().replace(/\.\d{3}Z$/, "Z") };
}

/** Default executor for onboarded subscription accounts (settings `onboard_default_executor`). */
function onboardExecutor(): "ccr" | "ccr_worker" {
  return getSetting("onboard_default_executor") === "ccr" ? "ccr" : "ccr_worker";
}
