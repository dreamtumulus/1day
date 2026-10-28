import type { FastifyInstance, FastifyRequest } from "fastify";
import { all, one, tx, type AccountRow } from "@1dayapi/core";
import { bad, body, notFound, num, oneOf, query, str, uuid } from "../http.js";
import { listProxiesForPicker, resolveTeamProxy, ProxyInputError } from "../node/proxies.js";
import { requireAdmin, requireOps, requireProvider } from "../session.js";
import {
  continueAuthUrlJob,
  cancelJob,
  sweepStaleJobs,
  getJob,
  jobOut,
  parseCallbackUrl,
  startAuthUrlJob,
  startSessionKeyJob,
  type OnboardParams,
  type JobRow,
  type OnboardScope,
} from "../onboard/jobs.js";
import { decryptJson } from "@1dayapi/core";

// Account onboarding API (docs/onboarding.md §4). Registered for both scopes:
// admins onboard into the platform pool (approved immediately, optional
// groupId); providers onboard into their own name (review_status=pending,
// only their own nodes/proxies selectable).

interface NodeRow {
  capacity: number;
  provider_id: string;
  role: string | null;
  online: number;
}

function loadNodeForScope(nodeId: string, scope: OnboardScope, requesterId: string): NodeRow {
  const node = one<NodeRow>(
    "SELECT n.provider_id, u.role, n.online, n.capacity FROM nodes n LEFT JOIN users u ON u.id = n.provider_id WHERE n.node_id = ?",
    nodeId,
  );
  if (!node) notFound("node");
  if (scope === "provider" && node.provider_id !== requesterId) notFound("node"); // no cross-provider enumeration
  if (node.online !== 1) bad("node_offline", "Target node is not online");

  return node;
}

/**
 * Who owns an account onboarded on this node (same rule as the admin account
 * routes): a provider's node → that provider; a platform (admin-deployed)
 * node → the platform (owner NULL).
 */
function ownerForNode(node: NodeRow, scope: OnboardScope, requesterId: string): string | null {
  if (scope === "provider") return requesterId;
  return node.role === "provider" ? node.provider_id : null;
}

/** Resolve proxyId ("auto" or explicit) to a concrete free live proxy on the node. */
function resolveProxy(nodeId:string,proxyIdInput:string|undefined,teamId?:string):string {
  try{return resolveTeamProxy(nodeId,teamId,proxyIdInput).id;}
  catch(e){if(e instanceof ProxyInputError)bad("proxy_pool_empty",e.message);throw e;}
}

function parseParams(req: FastifyRequest, scope: OnboardScope): OnboardParams {
  const b = body(req);
  const out: OnboardParams = {};
  out.expectedTeamId=uuid(b,"orgUuid");
  if(req.user!.role==='admin')out.teamName=str(b,"teamName",{max:200});
  else if('teamName' in b)bad("role_not_permitted","Only administrators may name an organization",403);
  out.concurrencyLimit = num(b, "concurrencyLimit", { int: true, min: 0, max: 100000 }) ?? 0;
  out.rpmLimit = num(b, "rpmLimit", { int: true, min: 0, max: 100000 }) ?? 0;
  out.name = str(b, "name", { max: 80 });
  out.note = str(b, "note", { max: 500 });
  if (scope === "admin") {
    const groupId = str(b, "groupId", { max: 80 });
    if (groupId) {
      if (!one("SELECT 1 FROM groups WHERE id = ?", groupId)) bad("group_not_found", `Group '${groupId}' not found`);
      out.groupId = groupId;
    }
  }
  return out;
}

/** auth_url step 2: paste the callback URL back into a pending job. */
function continueCallback(req: FastifyRequest, scope: OnboardScope, jobId: string, reauthAccountId?: string) {
  const b = body(req);
  sweepStaleJobs();
  const job = getJob(jobId);
  if (!job || (scope === "provider" && (job.scope !== "provider" || job.requester_id !== req.user!.id))) notFound("onboarding_job");
  if (req.user!.role === "ops" && !reauthAccountId) bad("role_not_permitted", "Account ops may only re-authorize existing accounts",403);
  if (reauthAccountId) {
    const params = job.params_json ? (JSON.parse(job.params_json) as OnboardParams) : {};
    if (params.reauthAccountId !== reauthAccountId) notFound("onboarding_job");
  }
  if (job.method !== "auth_url" || job.status !== "pending_callback" || !job.payload_enc) {
    bad("invalid_request", "Job is not waiting for a callback URL");
  }
  const callbackUrl = str(b, "callbackUrl", { required: true, max: 4000 })!;
  const { state } = decryptJson<{ codeVerifier: string; state: string }>(job.payload_enc);
  if (!parseCallbackUrl(callbackUrl, state)) {
    bad("callback_invalid", "Callback URL cannot be parsed or its state does not match this job");
  }
  continueAuthUrlJob(job.id, callbackUrl);
  return { data: { jobId: job.id, status: "working" } };
}

async function onboard(req: FastifyRequest, scope: OnboardScope) {
  const b = body(req);
  const method = oneOf(b, "method", ["session_key", "auth_url"] as const, true)!;
  const requesterId = req.user!.id;

  if (method === "auth_url" && typeof b.jobId === "string" && b.jobId) return continueCallback(req, scope, b.jobId);

  const nodeId = str(b, "nodeId", { required: true, max: 120 })!;
  const node = loadNodeForScope(nodeId, scope, requesterId);
  const params = parseParams(req, scope);
  params.ownerId = ownerForNode(node, scope, requesterId);
  const proxyIdInput = str(b, "proxyId", { max: 60 });

  if (method === "session_key") {
    const sessionKey = str(b, "sessionKey", { required: true, max: 8000 })!;
    const orgUuid = uuid(b, "orgUuid");
    // Pick + reserve in one transaction: two concurrent jobs must never leave
    // with the same proxy (the loser would only find out after a real consent).
    const jobId = tx(() => startSessionKeyJob(scope, requesterId, nodeId, resolveProxy(nodeId, proxyIdInput,params.expectedTeamId), sessionKey, params, orgUuid));
    return { data: { jobId, status: "working" } };
  }

  const { jobId, authorizeUrl } = tx(() => startAuthUrlJob(scope, requesterId, nodeId, resolveProxy(nodeId, proxyIdInput,params.expectedTeamId), params));
  return { data: { jobId, status: "pending_callback", authorizeUrl } };
}

/**
 * Re-authorize an existing Anthropic subscription account in place
 * (docs/onboarding.md §11): same two methods as onboarding, but the job is
 * pinned to the account's own node and bound proxy (so consent and traffic
 * share one egress) and ends by replacing the row's credential. Only for
 * accounts that are not active (error / disabled): a fresh grant must not race
 * sessions that still use the current token.
 */
async function reauth(req: FastifyRequest) {
  const { id } = req.params as { id: string };
  const a = one<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
  if (!a) notFound("account");
  if (a.platform !== "anthropic" || a.type !== "oauth") bad("invalid_request", "Re-authorization applies to Anthropic subscription (OAuth) accounts");
  if (a.status === "active") bad("account_active", "Account is active; disable it first if you really want to re-authorize it");
  const b = body(req);
  const method = oneOf(b, "method", ["session_key", "auth_url"] as const, true)!;
  if (method === "auth_url" && typeof b.jobId === "string" && b.jobId) return continueCallback(req, "admin", b.jobId, id);

  if (a.route !== "node" || !a.node_id) bad("invalid_request", "Account is not bound to a node; edit it and pin a node first");
  const node = one<{ online: number }>("SELECT online FROM nodes WHERE node_id = ?", a.node_id);
  if (!node) notFound("node");
  if (node.online !== 1) bad("node_offline", "The account's node is not online");
  if(!a.team_id || !a.bound_proxy_id)bad("legacy_account_unmanaged","Legacy accounts are not changed by the isolation rollout");
  const bound=one<{status:string;team_id:string|null}>("SELECT status,team_id FROM node_proxies WHERE id=?",a.bound_proxy_id);
  if(!bound || bound.status!=="live" || bound.team_id!==a.team_id)bad("fixed_proxy_unavailable","The fixed proxy is unavailable; automatic rebinding is disabled");
  const expected=uuid(b,"orgUuid");
  if(expected && expected!==a.team_id)bad("team_mismatch","Organization cannot change during re-authorization");
  const params:OnboardParams={ownerId:a.owner_id,reauthAccountId:a.id,name:a.name,expectedTeamId:a.team_id};
  const requesterId = req.user!.id;
  const nodeId = a.node_id;

  if (method === "session_key") {
    const sessionKey = str(b, "sessionKey", { required: true, max: 8000 })!;
    const orgUuid = uuid(b, "orgUuid");
    const jobId = tx(() => startSessionKeyJob("admin", requesterId, nodeId, a.bound_proxy_id!, sessionKey, params, orgUuid));
    return { data: { jobId, status: "working" } };
  }
  const { jobId, authorizeUrl } = tx(() => startAuthUrlJob("admin", requesterId, nodeId, a.bound_proxy_id!, params));
  return { data: { jobId, status: "pending_callback", authorizeUrl } };
}

async function jobStatus(req: FastifyRequest, scope: OnboardScope) {
  const { jobId } = req.params as { jobId: string };
  sweepStaleJobs();
  const job = getJob(jobId);
  if (!job || (scope === "provider" && (job.scope !== "provider" || job.requester_id !== req.user!.id))) {
    notFound("onboarding_job");
  }
  return { data: jobOut(job,req.user?.role==='admin') };
}

export function registerOnboardingRoutes(app: FastifyInstance): void {
  // Admin endpoints here are shared with the ops role (docs/auth.md §2).
  const preAdmin = { preHandler: requireOps };
  const preProvider = { preHandler: requireProvider };

  app.post("/api/admin/accounts/onboard", { preHandler: requireAdmin }, (req) => onboard(req, "admin"));
  app.post("/api/provider/accounts/onboard", preProvider, (req) => onboard(req, "provider"));
  app.post("/api/admin/accounts/:id/reauth", preAdmin, (req) => reauth(req));
  app.get("/api/admin/accounts/onboard/:jobId", preAdmin, (req) => jobStatus(req, "admin"));
  app.get("/api/provider/accounts/onboard/:jobId", preProvider, (req) => jobStatus(req, "provider"));

  for (const scope of ["admin", "provider"] as const) {
    app.get(`/api/${scope}/accounts/onboard`, scope === "admin" ? preAdmin : preProvider, async (req) => {
      sweepStaleJobs();
      const jobs=scope==='provider' ? all<JobRow>("SELECT * FROM onboarding_jobs WHERE isolation_version=1 AND scope='provider' AND requester_id=? ORDER BY created_at DESC LIMIT 30",req.user!.id) :
        all<JobRow>("SELECT * FROM onboarding_jobs WHERE isolation_version=1 ORDER BY created_at DESC LIMIT 30");
      return {data:jobs.filter(j=>req.user!.role!=='ops' || (j.params_json && (JSON.parse(j.params_json) as OnboardParams).reauthAccountId)).map(j=>jobOut(j,req.user!.role==='admin'))};
    });
    app.post(`/api/${scope}/accounts/onboard/:jobId/cancel`, scope === "admin" ? preAdmin : preProvider, async (req) => {
      const {jobId}=req.params as {jobId:string};
      const job=getJob(jobId);
      if(!job || job.isolation_version!==1 || (scope==='provider' && (job.scope!=='provider' || job.requester_id!==req.user!.id)))notFound("onboarding_job");
      const params:OnboardParams=job.params_json?JSON.parse(job.params_json):{};
      if(req.user!.role==='ops' && !params.reauthAccountId)bad("role_not_permitted","Account ops may only cancel re-authorization jobs",403);
      cancelJob(jobId);
      return {data:jobOut(getJob(jobId)!,req.user!.role==='admin')};
    });
  }

  // Provider-side proxy picker (docs/onboarding.md §4): own nodes only,
  // credential-free shape; free=1 keeps live unbound proxies.
  app.get("/api/provider/nodes/:id/proxies", preProvider, async (req) => {
    const { id } = req.params as { id: string };
    const node = one<{ provider_id: string }>("SELECT provider_id FROM nodes WHERE node_id = ?", id);
    if (!node || node.provider_id !== req.user!.id) notFound("node");
    return { data: listProxiesForPicker(id, query(req).free === "1") };
  });
}
