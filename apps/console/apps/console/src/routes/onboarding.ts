import type { FastifyInstance, FastifyRequest } from "fastify";
import { one } from "@1dayapi/core";
import { bad, body, notFound, num, oneOf, query, str } from "../http.js";
import { listProxiesForPicker, pickFreeProxy } from "../node/proxies.js";
import { requireAdmin, requireProvider } from "../session.js";
import { botAvailable } from "../onboard/bot-runner.js";
import {
  continueAuthUrlJob,
  getJob,
  jobOut,
  parseCallbackUrl,
  startAuthUrlJob,
  startSessionKeyJob,
  type OnboardParams,
  type OnboardScope,
} from "../onboard/jobs.js";
import { decryptJson } from "@1dayapi/core";

// Account onboarding API (docs/onboarding.md §4). Registered for both scopes:
// admins onboard into the platform pool (approved immediately, optional
// groupId); providers onboard into their own name (review_status=pending,
// only their own nodes/proxies selectable).

interface NodeRow {
  provider_id: string;
  role: string | null;
  online: number;
}

function loadNodeForScope(nodeId: string, scope: OnboardScope, requesterId: string): NodeRow {
  const node = one<NodeRow>(
    "SELECT n.provider_id, u.role, n.online FROM nodes n LEFT JOIN users u ON u.id = n.provider_id WHERE n.node_id = ?",
    nodeId,
  );
  if (!node) notFound("node");
  if (scope === "provider" && node.provider_id !== requesterId) notFound("node"); // no cross-provider enumeration
  if (node.online !== 1) bad("node_offline", "Target node is not online");
  return node;
}

/** Resolve proxyId ("auto" or explicit) to a concrete free live proxy on the node. */
function resolveProxy(nodeId: string, proxyIdInput: string | undefined): string {
  if (!proxyIdInput || proxyIdInput === "auto") {
    const pick = pickFreeProxy(nodeId);
    if (!pick) bad("proxy_pool_empty", "No free healthy proxy on this node");
    return pick.id;
  }
  const row = one<{ bound_account_id: string | null; status: string }>(
    "SELECT bound_account_id, status FROM node_proxies WHERE id = ? AND node_id = ?",
    proxyIdInput,
    nodeId,
  );
  if (row?.bound_account_id) bad("proxy_bound", "This proxy is already bound to an account");
  if (!row || row.status !== "live") bad("proxy_pool_empty", "Proxy not found on this node or not healthy");
  return proxyIdInput;
}

function parseParams(req: FastifyRequest, scope: OnboardScope): OnboardParams {
  const b = body(req);
  const out: OnboardParams = {};
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

async function onboard(req: FastifyRequest, scope: OnboardScope) {
  const b = body(req);
  const method = oneOf(b, "method", ["session_key", "auth_url"] as const, true)!;
  const requesterId = req.user!.id;

  // auth_url step 2: paste the callback URL back into a pending job.
  if (method === "auth_url" && typeof b.jobId === "string" && b.jobId) {
    const job = getJob(b.jobId);
    if (!job || (scope === "provider" && (job.scope !== "provider" || job.requester_id !== requesterId))) notFound("onboarding_job");
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

  const nodeId = str(b, "nodeId", { required: true, max: 120 })!;
  loadNodeForScope(nodeId, scope, requesterId);
  const proxyId = resolveProxy(nodeId, str(b, "proxyId", { max: 60 }));
  const params = parseParams(req, scope);

  if (method === "session_key") {
    if (!botAvailable()) bad("onboard_bot_unavailable", "The authorize bot is not deployed on this server", 503);
    const sessionKey = str(b, "sessionKey", { required: true, max: 8000 })!;
    const jobId = startSessionKeyJob(scope, requesterId, nodeId, proxyId, sessionKey, params);
    return { data: { jobId, status: "working" } };
  }

  const { jobId, authorizeUrl } = startAuthUrlJob(scope, requesterId, nodeId, proxyId, params);
  return { data: { jobId, status: "pending_callback", authorizeUrl } };
}

async function jobStatus(req: FastifyRequest, scope: OnboardScope) {
  const { jobId } = req.params as { jobId: string };
  const job = getJob(jobId);
  if (!job || (scope === "provider" && (job.scope !== "provider" || job.requester_id !== req.user!.id))) {
    notFound("onboarding_job");
  }
  return { data: jobOut(job) };
}

export function registerOnboardingRoutes(app: FastifyInstance): void {
  const preAdmin = { preHandler: requireAdmin };
  const preProvider = { preHandler: requireProvider };

  app.post("/api/admin/accounts/onboard", preAdmin, (req) => onboard(req, "admin"));
  app.post("/api/provider/accounts/onboard", preProvider, (req) => onboard(req, "provider"));
  app.get("/api/admin/accounts/onboard/:jobId", preAdmin, (req) => jobStatus(req, "admin"));
  app.get("/api/provider/accounts/onboard/:jobId", preProvider, (req) => jobStatus(req, "provider"));

  // Provider-side proxy picker (docs/onboarding.md §4): own nodes only,
  // credential-free shape; free=1 keeps live unbound proxies.
  app.get("/api/provider/nodes/:id/proxies", preProvider, async (req) => {
    const { id } = req.params as { id: string };
    const node = one<{ provider_id: string }>("SELECT provider_id FROM nodes WHERE node_id = ?", id);
    if (!node || node.provider_id !== req.user!.id) notFound("node");
    return { data: listProxiesForPicker(id, query(req).free === "1") };
  });
}
