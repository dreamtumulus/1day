import { createHash, randomBytes } from "node:crypto";
import {
  CCR,
  decryptJson,
  decryptString,
  encryptJson,
  getSetting,
  newId,
  nowIso,
  one,
  run,
  tx,
} from "@1dayapi/core";
import { runBot } from "./bot-runner.js";

// Onboarding job engine (docs/onboarding.md §2/§5). Jobs are async: the POST
// endpoint persists the job and the bot run continues in-process; clients poll
// GET .../accounts/onboard/:jobId. Secret material (sessionKey, PKCE
// verifier/state) lives only in payload_enc and is cleared on done/failed.

export type OnboardMethod = "session_key" | "auth_url";
export type OnboardScope = "admin" | "provider";

export interface OnboardParams {
  concurrencyLimit?: number;
  rpmLimit?: number;
  name?: string;
  note?: string;
  /** admin scope only: group to place the approved account in. */
  groupId?: string;
}

export interface JobRow {
  id: string;
  requester_id: string | null;
  scope: OnboardScope;
  method: OnboardMethod;
  node_id: string;
  proxy_id: string | null;
  params_json: string | null;
  payload_enc: string | null;
  authorize_url: string | null;
  status: "pending_callback" | "working" | "done" | "failed";
  account_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function getJob(id: string): JobRow | undefined {
  return one<JobRow>("SELECT * FROM onboarding_jobs WHERE id = ?", id);
}

export function jobOut(j: JobRow) {
  return {
    jobId: j.id,
    status: j.status,
    accountId: j.account_id ?? undefined,
    error: j.error ?? undefined,
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
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, proxy_id, params_json, payload_enc, authorize_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
  return id;
}

// ---------- PKCE / authorize URL (docs/onboarding.md §2, method=auth_url) ----------

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function buildAuthorizeUrl(): { authorizeUrl: string; codeVerifier: string; state: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = randomBytes(16).toString("hex");
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
): string {
  const id = insertJob(scope, requesterId, "session_key", nodeId, proxyId, params, { sessionKey }, "working", null);
  void runSessionKeyJob(id);
  return id;
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
  run("UPDATE onboarding_jobs SET status = 'working', updated_at = ? WHERE id = ?", nowIso(), jobId);
  void runAuthUrlJob(jobId, callbackUrl);
}

// ---------- runners ----------

function proxyPlaintext(proxyId: string): string {
  const row = one<{ url_enc: string }>("SELECT url_enc FROM node_proxies WHERE id = ?", proxyId);
  if (!row) throw new Error("bound proxy row is gone");
  return decryptString(row.url_enc);
}

function failJob(jobId: string, code: string, message: string): void {
  run("UPDATE onboarding_jobs SET status = 'failed', error = ?, payload_enc = NULL, updated_at = ? WHERE id = ?", `${code}: ${message}`.slice(0, 500), nowIso(), jobId);
}

async function runSessionKeyJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.proxy_id || !job.payload_enc) return;
  try {
    const { sessionKey } = decryptJson<{ sessionKey: string }>(job.payload_enc);
    const res = await runBot(["--sk", sessionKey, "--proxy", proxyPlaintext(job.proxy_id)]);
    await finishJob(job, res);
  } catch (err) {
    failJob(jobId, err instanceof Error && err.name === "BotUnavailableError" ? "onboard_bot_unavailable" : "authorize_failed", (err as Error).message);
  }
}

async function runAuthUrlJob(jobId: string, callbackUrl: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || !job.proxy_id || !job.payload_enc) return;
  try {
    const payload = decryptJson<{ codeVerifier: string; state: string }>(job.payload_enc);
    const res = await runBot([
      "--callback",
      callbackUrl,
      "--job-state",
      JSON.stringify({ codeVerifier: payload.codeVerifier, state: payload.state }),
      "--proxy",
      proxyPlaintext(job.proxy_id),
    ]);
    await finishJob(job, res);
  } catch (err) {
    failJob(jobId, err instanceof Error && err.name === "BotUnavailableError" ? "onboard_bot_unavailable" : "authorize_failed", (err as Error).message);
  }
}

/** Turn a successful bot result into the account row + proxy binding (single transaction). */
async function finishJob(
  job: JobRow,
  res: { accessToken?: string; refreshToken?: string; expiresAt?: string; orgUuid?: string; accountUuid?: string; environmentId?: string; email?: string; error?: string },
): Promise<void> {
  if (res.error || !res.accessToken || !res.refreshToken || !res.orgUuid) {
    failJob(job.id, "authorize_failed", res.error ?? "bot result is missing token fields");
    return;
  }
  const params: OnboardParams = job.params_json ? JSON.parse(job.params_json) : {};
  const accountId = newId();
  const now = nowIso();
  const ownerId = job.scope === "provider" ? job.requester_id : null;
  try {
    tx(() => {
      run(
        `INSERT INTO accounts (id, name, platform, type, executor, protocol, base_url, credential_enc,
                               owner_id, route, node_id, review_status, review_note, payout_rate, priority,
                               concurrency, rpm_limit, bound_proxy_id, account_email, created_at, updated_at)
         VALUES (?, ?, 'anthropic', 'oauth', 'ccr', 'anthropic', 'https://api.anthropic.com', ?,
                 ?, 'node', ?, ?, ?, 0, 50, ?, ?, ?, ?, ?, ?)`,
        accountId,
        params.name ?? res.email ?? `claude-${accountId.slice(0, 8)}`,
        encryptJson({
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
          expiresAt: res.expiresAt,
          orgUuid: res.orgUuid,
          accountId: res.accountUuid,
          environmentId: res.environmentId,
        }),
        ownerId,
        job.node_id,
        job.scope === "provider" ? "pending" : "approved",
        params.note ?? null,
        params.concurrencyLimit ?? 0,
        params.rpmLimit ?? 0,
        job.proxy_id,
        res.email ?? null,
        now,
        now,
      );
      // Claim the proxy atomically: a concurrent job may have bound it meanwhile.
      const claim = run(
        "UPDATE node_proxies SET bound_account_id = ? WHERE id = ? AND bound_account_id IS NULL",
        accountId,
        job.proxy_id,
      );
      if (claim.changes === 0) throw new Error("proxy_bound");
      if (job.scope === "admin") {
        const groupId = params.groupId ?? getSetting("default_group_id");
        if (!one("SELECT 1 FROM groups WHERE id = ?", groupId)) throw new Error(`group_not_found: ${groupId}`);
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
    failJob(job.id, msg.startsWith("proxy_bound") || msg.startsWith("group_not_found") ? msg.split(":")[0] : "authorize_failed", msg);
  }
}
