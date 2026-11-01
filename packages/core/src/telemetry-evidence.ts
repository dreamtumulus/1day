// Telemetry evidence (docs/canonical-implementation-spec-2026-11-01.md §6.4 / WP6; user decision 2026-11-01: secondary
// evidence allowed). The gateway never constructs, replays or rewrites telemetry: the official Claude Code on the node
// sends its own. What the platform keeps is EVIDENCE that the account's native telemetry is accepted upstream:
//   real       a controlled capture of a real upstream 2xx for this account's telemetry (G10-B; test exit with a CA
//              the operator controls — never a MITM of production traffic)
//   controlled G10-A structural evidence for a PROFILE (binary × entrypoint): endpoints, identity fields, no leaks.
//              Account-less (account_id NULL): it describes the binary, not an account.
//   secondary  derived, not stored: a controlled row for the profile + this account healthy for
//              `telemetry_health_days` consecutive days (no request-level 429 "Error", no organization-level error).
//   unknown    anything else → `native-required` keys do not open new canonical sessions on this account
//              (when settings telemetry_evidence_required is on for them).
// Evidence covers only the account it was measured on; nothing is extrapolated (I10).
import { all, one, run } from "./db.js";
import { nowIso } from "./time.js";
import { getSetting } from "./settings.js";
import { orgLevelErrorCode } from "./org-guard.js";

export type TelemetryEvidenceSource = "real" | "controlled";
export type TelemetryEvidenceLevel = "real" | "secondary" | "unknown";

export interface TelemetryEvidenceRow {
  id: string;
  account_id: string | null;
  profile_id: string;
  node_id: string | null;
  proxy_id: string | null;
  native_session_id: string | null;
  cc_version: string | null;
  endpoint: string | null;
  status: number | null;
  source: TelemetryEvidenceSource;
  observed_at: string;
  digest: string | null;
  expires_at: string | null;
  note: string | null;
}

export interface TelemetryEvidenceInput {
  accountId?: string | null;
  profileId: string;
  nodeId?: string | null;
  proxyId?: string | null;
  nativeSessionId?: string | null;
  ccVersion?: string | null;
  endpoint?: string | null;
  status?: number | null;
  source: TelemetryEvidenceSource;
  observedAt?: string;
  digest?: string | null;
  expiresAt?: string | null;
  note?: string | null;
}

export function recordTelemetryEvidence(e: TelemetryEvidenceInput): string {
  const id = crypto.randomUUID();
  run(
    `INSERT INTO telemetry_evidence (id, account_id, profile_id, node_id, proxy_id, native_session_id, cc_version, endpoint, status, source, observed_at, digest, expires_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, e.accountId ?? null, e.profileId, e.nodeId ?? null, e.proxyId ?? null, e.nativeSessionId ?? null, e.ccVersion ?? null, e.endpoint ?? null, e.status ?? null, e.source, e.observedAt ?? nowIso(), e.digest ?? null, e.expiresAt ?? null, e.note ? e.note.slice(0, 1000) : null,
  );
  return id;
}

export function listTelemetryEvidence(accountId: string | null, profileId?: string, limit = 100): TelemetryEvidenceRow[] {
  return all<TelemetryEvidenceRow>(
    `SELECT * FROM telemetry_evidence WHERE (account_id = ? OR (? IS NULL AND account_id IS NULL)) ${profileId ? "AND profile_id = ?" : ""} ORDER BY observed_at DESC LIMIT ?`,
    ...(profileId ? [accountId, accountId, profileId, limit] : [accountId, accountId, limit]),
  );
}

export function telemetryHealthDays(): number {
  const n = Number(getSetting("telemetry_health_days"));
  return Number.isInteger(n) && n >= 1 ? n : 7;
}

/**
 * Consecutive healthy UTC days ending today or yesterday for the account: each day has ≥1 request and no
 * request-level upstream rejection (429 "Error" → upstream_request_rejected) and no organization-level error text.
 * A day without traffic breaks the streak (no evidence of health). Looks back at most `maxDays` days.
 */
export function accountHealthyDays(accountId: string, maxDays: number, now = Date.now()): { days: number; brokenBy: string | null } {
  const from = new Date(now - (maxDays + 1) * 86_400_000).toISOString();
  const rows = all<{ day: string; n: number; rejected: number; messages: string }>(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n,
            COALESCE(SUM(error_code = 'upstream_request_rejected'), 0) AS rejected,
            COALESCE(GROUP_CONCAT(CASE WHEN status_code >= 400 THEN substr(error_message, 1, 200) END, '\n'), '') AS messages
       FROM usage_logs WHERE account_id = ? AND created_at >= ? AND (mode IS NULL OR mode <> 'probe')
       GROUP BY day ORDER BY day DESC`,
    accountId, from,
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const today = new Date(now).toISOString().slice(0, 10);
  let cursor = byDay.has(today) ? now : now - 86_400_000; // today may still be in progress; a quiet day so far does not break
  let days = 0;
  for (let i = 0; i < maxDays; i++) {
    const day = new Date(cursor - i * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    if (!r || r.n === 0) return { days, brokenBy: `no traffic on ${day}` };
    if (r.rejected > 0) return { days, brokenBy: `request-level 429 "Error" on ${day}` };
    const org = r.messages.split("\n").map(orgLevelErrorCode).find((c) => c);
    if (org) return { days, brokenBy: `${org} on ${day}` };
    days++;
  }
  return { days, brokenBy: null };
}

export interface TelemetryEvidenceVerdict {
  level: TelemetryEvidenceLevel;
  profileId: string;
  healthDays: number;
  needDays: number;
  structural: boolean;
  real: boolean;
  basis: string;
}

/** Evidence level for one account × profile (spec §6.4); `secondary` is computed, never stored. */
export function telemetryEvidenceLevel(accountId: string, profileId: string, now = Date.now()): TelemetryEvidenceVerdict {
  const at = new Date(now).toISOString();
  const real = !!one("SELECT 1 FROM telemetry_evidence WHERE account_id = ? AND profile_id = ? AND source = 'real' AND status BETWEEN 200 AND 299 AND (expires_at IS NULL OR expires_at > ?)", accountId, profileId, at);
  const needDays = telemetryHealthDays();
  if (real) return { level: "real", profileId, healthDays: needDays, needDays, structural: true, real: true, basis: "real upstream 2xx captured for this account" };
  const structural = !!one("SELECT 1 FROM telemetry_evidence WHERE (account_id IS NULL OR account_id = ?) AND profile_id = ? AND source = 'controlled' AND (expires_at IS NULL OR expires_at > ?)", accountId, profileId, at);
  const health = accountHealthyDays(accountId, needDays, now);
  if (structural && health.days >= needDays) return { level: "secondary", profileId, healthDays: health.days, needDays, structural, real: false, basis: `structural evidence for ${profileId} + ${health.days} healthy day(s)` };
  return { level: "unknown", profileId, healthDays: health.days, needDays, structural, real: false, basis: structural ? `healthy ${health.days}/${needDays} day(s)${health.brokenBy ? ` (${health.brokenBy})` : ""}` : `no structural evidence for ${profileId}` };
}
