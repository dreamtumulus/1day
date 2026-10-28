import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { all, decryptJson, newId, nowIso, one, randomHex, run, sha256Hex, tx } from "@1dayapi/core";
import { bad, body, notFound, num, sendError, str, uuid } from "../http.js";
import { listProxiesForPicker, resolveTeamProxy, ProxyInputError } from "../node/proxies.js";
import {
  continueAuthUrlJob,
  getJob,
  jobOut,
  parseCallbackUrl,
  startAuthUrlJob,
  startSessionKeyJob,
  type JobRow,
  type OnboardParams,
} from "../onboard/jobs.js";
import { requireAdmin } from "../session.js";

// 上号员站点（/onboard）的独立鉴权与上号 API。管理员在控制台签发 1dk_onb_…
// 令牌并绑定目标节点；上号员持令牌在该节点执行上号，账号落入平台池
//（scope=onboarder：立即可调度、owner NULL、进默认分组）。与控制台登录
// 体系完全隔离：无 cookie 会话，令牌走 Authorization: Bearer。

interface OnboardToken {
  id: string;
  label: string;
  token_preview: string;
  node_id: string;
  status: string;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
}

declare module "fastify" {
  interface FastifyRequest {
    onboardToken?: OnboardToken;
  }
}

function tokenFromHeader(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t.startsWith("1dk_onb_") ? t : null;
}

/** preHandler: Bearer 1dk_onb_… → 有效且 active 的 onboard_tokens 行。 */
async function requireOnboarder(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const plaintext = tokenFromHeader(req);
  const row = plaintext
    ? one<OnboardToken>("SELECT * FROM onboard_tokens WHERE token_hash = ?", sha256Hex(plaintext))
    : undefined;
  if (!row || row.status !== "active") {
    sendError(reply, 401, "invalid_onboard_token", "Invalid or revoked onboarder token");
    return;
  }
  run("UPDATE onboard_tokens SET last_used_at = ? WHERE id = ?", nowIso(), row.id);
  req.onboardToken = row;
}

// ---------- 管理员：令牌签发与吊销 ----------

/** node_id = "*": the token may onboard onto any node; the operator picks one per job (2026-10-20). */
export const ANY_NODE = "*";

interface NodeRowLite {
  node_id: string;
  online: number;
  capacity: number;
  name: string | null;
}

function nodeRows(nodeId?: string): NodeRowLite[] {
  const sql = `SELECT node_id, online, capacity, json_extract(deploy_meta, '$.name') AS name FROM nodes${nodeId ? " WHERE node_id = ?" : ""} ORDER BY online DESC, created_at`;
  return nodeId ? all<NodeRowLite>(sql, nodeId) : all<NodeRowLite>(sql);
}

/** Nodes this token may use: every node for "*", else exactly the bound one. */
function allowedNodes(token: OnboardToken): NodeRowLite[] {
  return token.node_id === ANY_NODE ? nodeRows() : nodeRows(token.node_id);
}

/** Resolve the node a request targets: must be allowed; defaults to the bound node or the first online one. */
function pickNode(token: OnboardToken, requested: string | undefined): NodeRowLite {
  const allowed = allowedNodes(token);
  if (requested) {
    const hit = allowed.find((n) => n.node_id === requested);
    if (!hit) bad("node_not_allowed", "This token cannot onboard onto that node");
    return hit;
  }
  const dflt = token.node_id === ANY_NODE ? (allowed.find((n) => n.online === 1) ?? allowed[0]) : allowed[0];
  if (!dflt) bad("node_gone", "The node bound to this token no longer exists");
  return dflt;
}

function tokenOut(t: OnboardToken) {
  const nodeOnline = t.node_id === ANY_NODE ? nodeRows().some((n) => n.online === 1) : nodeRows(t.node_id)[0]?.online === 1;
  return {
    id: t.id,
    label: t.label,
    preview: t.token_preview,
    nodeId: t.node_id,
    nodeOnline,
    status: t.status,
    lastUsedAt: t.last_used_at,
    createdAt: t.created_at,
  };
}

function generateOnboardToken(): { plaintext: string; hash: string; preview: string } {
  const plaintext = `1dk_onb_${randomHex(24)}`;
  return { plaintext, hash: sha256Hex(plaintext), preview: `${plaintext.slice(0, 12)}…${plaintext.slice(-4)}` };
}

// ---------- 上号员：节点视图与上号作业 ----------

function nodeView(n: NodeRowLite) {
  const used = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM accounts WHERE route = 'node' AND node_id = ? AND status = 'active'",
    n.node_id,
  )!.n;
  const freeProxies = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM node_proxies WHERE node_id = ? AND isolation_version=1 AND status='live' AND resource_key IS NOT NULL",
    n.node_id,
  )!.n;
  return { nodeId: n.node_id, name: n.name, online: n.online === 1, capacity: n.capacity, used, freeProxies };
}

function onboarderNode(token: OnboardToken, requested?: string) {
  return nodeView(pickNode(token, requested));
}

function resolveProxyForToken(nodeId:string,proxyIdInput:string|undefined,teamId?:string):string {
  try{return resolveTeamProxy(nodeId,teamId,proxyIdInput).id;}
  catch(e){if(e instanceof ProxyInputError)bad("proxy_pool_empty",e.message);throw e;}
}

async function onboardAsToken(req: FastifyRequest) {
  const token = req.onboardToken!;
  const requesterId = `onb:${token.id}`;
  const b = body(req);
  const method = str(b, "method", { required: true })!;
  if (method !== "auth_url" && method !== "session_key") bad("invalid_request", "method must be auth_url or session_key");

  // auth_url 第二步：回填回调 URL。
  if (method === "auth_url" && typeof b.jobId === "string" && b.jobId) {
    const job = getJob(b.jobId);
    if (!job || job.scope !== "onboarder" || job.requester_id !== requesterId) notFound("onboarding_job");
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

  const node = onboarderNode(token, str(b, "nodeId", { max: 120 }));
  if (!node.online) bad("node_offline", "Target node is not online");
  if (node.used >= node.capacity) bad("node_at_capacity", `Node capacity reached (${node.used}/${node.capacity})`);

  const params: OnboardParams = {
    ownerId: null, // 上号员上的号归平台池
    expectedTeamId:uuid(b,"orgUuid"),
    concurrencyLimit: num(b, "concurrencyLimit", { int: true, min: 0, max: 100000 }) ?? 0,
    rpmLimit: num(b, "rpmLimit", { int: true, min: 0, max: 100000 }) ?? 0,
    name: str(b, "name", { max: 80 }),
    note: str(b, "note", { max: 500 }),
  };


  if (method === "session_key") {
    const sessionKey = str(b, "sessionKey", { required: true, max: 8000 })!;
    const orgUuid = uuid(b, "orgUuid");
    const jobId = tx(() => startSessionKeyJob("onboarder", requesterId, node.nodeId, resolveProxyForToken(node.nodeId,str(b,"proxyId",{max:60}),params.expectedTeamId), sessionKey, params, orgUuid));
    return { data: { jobId, status: "working" } };
  }
  const { jobId, authorizeUrl } = tx(() => startAuthUrlJob("onboarder", requesterId, node.nodeId, resolveProxyForToken(node.nodeId,str(b,"proxyId",{max:60}),params.expectedTeamId), params));
  return { data: { jobId, status: "pending_callback", authorizeUrl } };
}

export function registerOnboarderRoutes(app: FastifyInstance): void {
  const preAdmin = { preHandler: requireAdmin };
  const preOnb = { preHandler: requireOnboarder };

  // 管理员
  app.get("/api/admin/onboard-tokens", preAdmin, async () => ({
    data: all<OnboardToken>("SELECT * FROM onboard_tokens ORDER BY created_at DESC").map(tokenOut),
  }));
  app.post("/api/admin/onboard-tokens", preAdmin, async (req) => {
    const b = body(req);
    const label = str(b, "label", { required: true, max: 80 })!;
    const nodeId = str(b, "nodeId", { required: true, max: 120 })!;
    if (nodeId !== ANY_NODE && !one("SELECT 1 FROM nodes WHERE node_id = ?", nodeId)) bad("node_not_found", `Node '${nodeId}' not found`);
    const k = generateOnboardToken();
    const id = newId();
    run(
      "INSERT INTO onboard_tokens (id, label, token_hash, token_preview, node_id, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      label,
      k.hash,
      k.preview,
      nodeId,
      req.user!.id,
    );
    // 明文仅此一次返回
    return { data: { ...tokenOut(one<OnboardToken>("SELECT * FROM onboard_tokens WHERE id = ?", id)!), token: k.plaintext } };
  });
  app.patch("/api/admin/onboard-tokens/:id", preAdmin, async (req) => {
    const { id } = req.params as { id: string };
    const t = one<OnboardToken>("SELECT * FROM onboard_tokens WHERE id = ?", id);
    if (!t) notFound("onboard_token");
    const status = str(body(req), "status", { required: true })!;
    if (status !== "active" && status !== "revoked") bad("invalid_request", "status must be active or revoked");
    run("UPDATE onboard_tokens SET status = ? WHERE id = ?", status, id);
    return { data: tokenOut(one<OnboardToken>("SELECT * FROM onboard_tokens WHERE id = ?", id)!) };
  });

  // 上号员
  app.get("/api/onboard/me", preOnb, async (req) => {
    const t = req.onboardToken!;
    const nodes = allowedNodes(t).map(nodeView);
    // `node` stays for older site bundles; `nodes` is the selectable list (one entry for a bound token).
    return { data: { label: t.label, node: onboarderNode(t), nodes, anyNode: t.node_id === ANY_NODE } };
  });
  app.get("/api/onboard/proxies", preOnb, async (req) => {
    const q = req.query as { nodeId?: string };
    const node = pickNode(req.onboardToken!, typeof q.nodeId === "string" && q.nodeId ? q.nodeId : undefined);
    return { data: listProxiesForPicker(node.node_id, true) };
  });
  app.post("/api/onboard/jobs", preOnb, (req) => onboardAsToken(req));
  app.get("/api/onboard/jobs", preOnb, async (req) => ({
    data: all<JobRow>(
      "SELECT * FROM onboarding_jobs WHERE scope = 'onboarder' AND requester_id = ? ORDER BY created_at DESC LIMIT 20",
      `onb:${req.onboardToken!.id}`,
    ).map((j)=>jobOut(j)),
  }));
  app.get("/api/onboard/jobs/:jobId", preOnb, async (req) => {
    const { jobId } = req.params as { jobId: string };
    const job = getJob(jobId);
    if (!job || job.scope !== "onboarder" || job.requester_id !== `onb:${req.onboardToken!.id}`) {
      notFound("onboarding_job");
    }
    return { data: jobOut(job) };
  });
}
