import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CubeIcon, KeyIcon, RocketIcon } from "../components/Icon";
import { useT } from "../i18n";

// 上号员站点（/onboard，docs/onboarding.md §10 / §10.1）：独立于控制台登录体系，凭 1dk_onb_… 令牌上号。
// 2026-10-29 起按「组织 → 邮箱域名 → 节点 · IP 分组 → 凭据」四步走：组织 UUID 由服务端按方案带入，
// 域名与路线都要在方案允许的范围内，代理在所选分组内自动分配，账号邮箱不在所选域名下会被拒绝。
// 令牌还没有组织方案时退回老流程（选节点、选代理）。

const TOKEN_KEY = "onboarder-token";
const NODE_KEY = "onboarder-node";
const ORG_KEY = "onboarder-org";

interface NodeInfo {
  nodeId: string;
  name?: string | null;
  online: boolean;
  capacity: number;
  used: number;
  freeProxies?: number;
}

interface ProxyItem {
  id: string;
  label: string | null;
  group?: string | null;
  host: string | null;
  port: number | null;
  status: string;
}

interface OrgRoute {
  nodeId: string;
  group: string | null;
  nodeName: string | null;
  nodeOnline: boolean;
  nodeExists: boolean;
  capacity: number;
  used: number;
  assignable: number;
  groupExists: boolean;
}

interface OrgInfo {
  id: string;
  name: string;
  note: string | null;
  domains: string[];
  routes: OrgRoute[];
}

interface Job {
  nodeId?: string;
  method?: string;
  jobId: string;
  status: "pending_callback" | "working" | "done" | "failed";
  accountId?: string;
  accountName?: string;
  accountEmail?: string;
  orgName?: string;
  domain?: string;
  reused?: boolean;
  cooldownUntil?: string;
  error?: string;
  authorizeUrl?: string;
}

// ---------- sessionKey 行解析（单条与批量共用） ----------

type RowState = "invalid" | "queued" | "submitting" | "working" | "done" | "reused" | "failed";

interface BatchRow {
  id: number;
  line: string;
  sessionKey: string | null;
  orgUuid: string | null;
  state: RowState;
  jobId?: string;
  email?: string;
  name?: string;
  error?: string;
}

const SK_RE = /sk-ant-[A-Za-z0-9_-]{20,}/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function parseBatchLines(text: string): BatchRow[] {
  const seen = new Set<string>();
  const rows: BatchRow[] = [];
  let id = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sk = SK_RE.exec(line)?.[0] ?? null;
    const uuid = UUID_RE.exec(line)?.[0]?.toLowerCase() ?? null;
    id++;
    if (!sk) {
      rows.push({ id, line, sessionKey: null, orgUuid: uuid, state: "invalid", error: "no sessionKey" });
      continue;
    }
    if (seen.has(sk)) {
      rows.push({ id, line, sessionKey: sk, orgUuid: uuid, state: "invalid", error: "duplicate" });
      continue;
    }
    seen.add(sk);
    rows.push({ id, line, sessionKey: sk, orgUuid: uuid, state: "queued" });
  }
  return rows;
}

function authFetch<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  return fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const j = (await r.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } };
    if (!r.ok) throw new Error(j.error?.message ?? j.error?.code ?? `HTTP ${r.status}`);
    return j.data as T;
  });
}

/** Operator-facing explanation for the common failure texts (the codes come from the server). */
function friendlyError(t: (k: string, v?: Record<string, string | number>) => string, msg: string | undefined): string {
  if (!msg) return "";
  if (/HTTP 404|not a member of organization/.test(msg)) return `${t("onboardSite.errOrgNotFound")} (${msg})`;
  if (/domain_mismatch/.test(msg)) return `${t("onboardSite.errDomain")} (${msg})`;
  if (/proxy_pool_empty|No compatible verified proxy/.test(msg)) return `${t("onboardSite.errProxy")} (${msg})`;
  return msg;
}

// ---------- 批量执行器 ----------

function BatchRunner({ token, params, rows: initialRows, minSec, maxSec, onJobsChanged, onActiveChange, onClose }: {
  token: string;
  params: Record<string, unknown>;
  rows: BatchRow[];
  minSec: number;
  maxSec: number;
  onJobsChanged: () => void;
  onActiveChange: (active: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [rows, setRows] = useState<BatchRow[]>(initialRows);
  const [running, setRunning] = useState(true);
  const [notice, setNotice] = useState("");
  const rowsRef = useRef<BatchRow[]>(rows);
  rowsRef.current = rows;
  const runningRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { onActiveChange(running || rows.some((r) => r.state === "working" || r.state === "submitting")); }, [running, rows, onActiveChange]);

  const patch = useCallback((id: number, p: Partial<BatchRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }, []);

  const submitNext = useCallback(async () => {
    if (!runningRef.current) return;
    const next = rowsRef.current.find((r) => r.state === "queued");
    if (!next || !next.sessionKey) {
      runningRef.current = false;
      setRunning(false);
      return;
    }
    patch(next.id, { state: "submitting", error: undefined });
    try {
      const j = await authFetch<Job>(token, "/api/onboard/jobs", "POST", { method: "session_key", sessionKey: next.sessionKey, ...params });
      patch(next.id, { state: "working", jobId: j.jobId });
    } catch (e) {
      const msg = (e as Error).message;
      // 令牌失效 / 组内没空闲代理 / 节点满：停下来，这一行留在队列里
      const stop = /401|403|token|proxy|capacity|node|org_|route_|domain_invalid/i.test(msg);
      patch(next.id, { state: stop ? "queued" : "failed", error: friendlyError(t, msg) });
      if (stop) {
        runningRef.current = false;
        setRunning(false);
        setNotice(friendlyError(t, msg));
        return;
      }
    }
    const lo = Math.max(1, Math.min(minSec, maxSec));
    const hi = Math.max(lo, maxSec);
    timerRef.current = setTimeout(() => void submitNext(), (lo + Math.random() * (hi - lo)) * 1000);
  }, [token, params, minSec, maxSec, patch, t]);

  useEffect(() => {
    void submitNext();
    return () => {
      runningRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const working = rows.filter((r) => r.state === "working" && r.jobId);
    if (working.length === 0) return;
    const id = setInterval(() => {
      for (const r of working) {
        authFetch<Job>(token, `/api/onboard/jobs/${r.jobId}`)
          .then((j) => {
            if (j.status === "done") {
              patch(r.id, { state: j.reused ? "reused" : "done", email: j.accountEmail, name: j.accountName });
              onJobsChanged();
            } else if (j.status === "failed") {
              patch(r.id, { state: "failed", error: friendlyError(t, j.error ?? "failed") });
              onJobsChanged();
            }
          })
          .catch(() => {});
      }
    }, 3000);
    return () => clearInterval(id);
  }, [rows, token, patch, onJobsChanged, t]);

  function pause() {
    runningRef.current = false;
    setRunning(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  }
  function resume() {
    if (runningRef.current) return;
    setNotice("");
    runningRef.current = true;
    setRunning(true);
    void submitNext();
  }
  const count = (st: RowState) => rows.filter((r) => r.state === st).length;
  const queued = count("queued");
  const inFlight = count("submitting") + count("working");
  const finished = !running && inFlight === 0;
  const stateColor: Record<RowState, string> = {
    invalid: "var(--on-surface-faint)", queued: "var(--on-surface-variant)", submitting: "var(--warning)", working: "var(--warning)",
    done: "var(--success)", reused: "var(--warning)", failed: "var(--error)",
  };

  return (
    <div className="card mt-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[18px] font-bold text-on-surface">{t("onboardSite.batchTitle")}</h2>
        <span className="font-mono text-[12px] text-on-surface-variant">
          {t("onboardSite.batchSummary", { total: rows.length, queued, inFlight, done: count("done"), reused: count("reused"), failed: count("failed") + count("invalid") })}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {running ? (
          <button type="button" className="wk-btn wk-btn-md wk-btn-primary" onClick={pause}>{t("onboardSite.batchPause")}</button>
        ) : queued > 0 ? (
          <button type="button" className="wk-btn wk-btn-md wk-btn-primary" onClick={resume}>{t("onboardSite.batchStart", { n: queued })}</button>
        ) : null}
        <button type="button" className="wk-btn wk-btn-md wk-btn-ghost" disabled={count("failed") + count("invalid") === 0}
          onClick={() => void navigator.clipboard.writeText(rows.filter((r) => r.state === "failed" || r.state === "invalid").map((r) => r.line).join("\n"))}>
          {t("onboardSite.batchCopyFailed")}
        </button>
        {finished && <button type="button" className="wk-btn wk-btn-md wk-btn-ghost" onClick={onClose}>{t("onboardSite.batchClear")}</button>}
      </div>
      {notice && <p className="mt-2 text-[13px]" style={{ color: "var(--error)" }}>{t("onboardSite.batchStopped")}: {notice}</p>}
      <div className="mt-4 overflow-x-auto">
        <table className="wk-table">
          <thead>
            <tr>
              <th className="ta-l">#</th>
              <th className="ta-l">sessionKey</th>
              <th className="ta-l">{t("onboardSite.colStatus")}</th>
              <th className="ta-l">{t("onboardSite.colAccount")}</th>
              <th className="ta-l">{t("onboardSite.colError")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="ta-l font-mono text-[12px]">{r.id}</td>
                <td className="ta-l font-mono text-[12px]">{r.sessionKey ? `${r.sessionKey.slice(0, 18)}…${r.sessionKey.slice(-4)}` : "—"}</td>
                <td className="ta-l"><span className="font-mono text-[11px] font-bold" style={{ color: stateColor[r.state] }}>{t(`onboardSite.batchState.${r.state}`)}</span></td>
                <td className="ta-l text-[12px]">{r.email ?? r.name ?? "—"}</td>
                <td className="ta-l max-w-[320px] truncate text-[12px] text-on-surface-variant" title={r.error}>{r.error ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- 页面 ----------

function Step({ n, title, done, children, summary, onChange, changeLabel }: { n: number; title: string; done: boolean; children: ReactNode; summary?: ReactNode; onChange?: () => void; changeLabel: string }) {
  return (
    <div className="card mt-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2.5 font-display text-[17px] font-bold text-on-surface">
          <span className="grid h-6 w-6 place-items-center rounded-full text-[12px] font-semibold" style={done ? { background: "var(--success)", color: "#fff" } : { background: "var(--primary-container)", color: "var(--primary)" }}>
            {done ? "✓" : n}
          </span>
          {title}
          {done && summary && <span className="ml-1 text-[13px] font-normal text-on-surface-variant">· {summary}</span>}
        </h2>
        {done && onChange && <button type="button" className="wk-btn wk-btn-sm wk-btn-ghost" onClick={onChange}>{changeLabel}</button>}
      </div>
      {!done && <div className="mt-3">{children}</div>}
    </div>
  );
}

function Chip({ active, onClick, children, title, disabled }: { active: boolean; onClick: () => void; children: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border px-3 py-2 text-left text-[13px] transition-colors disabled:opacity-50"
      style={active ? { background: "var(--primary)", color: "var(--on-primary)", borderColor: "var(--primary)" } : { borderColor: "var(--outline-variant)" }}
    >
      {children}
    </button>
  );
}

export function OnboardSite() {
  const { t } = useT();
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [label, setLabel] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [orgs, setOrgs] = useState<OrgInfo[]>([]);
  const [ready, setReady] = useState(false);
  const [authErr, setAuthErr] = useState("");
  const [input, setInput] = useState("");

  // selections
  const [orgId, setOrgId] = useState(() => localStorage.getItem(ORG_KEY) ?? "");
  const [domain, setDomain] = useState("");
  const [routeKey, setRouteKey] = useState("");
  const [method, setMethod] = useState<"sk" | "link">("sk");
  const [skText, setSkText] = useState("");
  const [name, setName] = useState("");
  const [minSec, setMinSec] = useState(5);
  const [maxSec, setMaxSec] = useState(7);
  // legacy (no organization profiles): node + proxy picked directly
  const [legacyNodeId, setLegacyNodeId] = useState(() => localStorage.getItem(NODE_KEY) ?? "");
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [proxyId, setProxyId] = useState("auto");

  const [job, setJob] = useState<Job | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [batch, setBatch] = useState<{ rows: BatchRow[]; params: Record<string, unknown> } | null>(null);
  const [batchActive, setBatchActive] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadJobs = useCallback((tk: string) => authFetch<Job[]>(tk, "/api/onboard/jobs").then(setJobs).catch(() => {}), []);
  const loadMe = useCallback(
    (tk: string) =>
      authFetch<{ label: string; node: NodeInfo; nodes?: NodeInfo[]; orgs?: OrgInfo[] }>(tk, "/api/onboard/me").then((d) => {
        setLabel(d.label);
        const list = d.nodes && d.nodes.length ? d.nodes : [d.node];
        setNodes(list);
        setOrgs(d.orgs ?? []);
        setLegacyNodeId((cur) => (list.some((n) => n.nodeId === cur) ? cur : d.node.nodeId));
        setReady(true);
      }),
    [],
  );

  // 令牌校验 + 节点 / 组织方案
  useEffect(() => {
    if (!token) return;
    loadMe(token)
      .then(() => loadJobs(token))
      .catch((e: Error) => {
        setAuthErr(e.message);
        setLabel(null);
        setReady(false);
        localStorage.removeItem(TOKEN_KEY);
        setToken("");
      });
  }, [token, loadMe, loadJobs]);

  // 方案里的实时数字（可分配 / 在线）每 30 s 刷新一次
  useEffect(() => {
    if (!token || !ready) return;
    const id = setInterval(() => void loadMe(token).catch(() => {}), 30_000);
    return () => clearInterval(id);
  }, [token, ready, loadMe]);

  const legacy = ready && orgs.length === 0;
  const org = useMemo(() => orgs.find((o) => o.id === orgId) ?? null, [orgs, orgId]);
  const domains = org?.domains ?? [];
  const routes = org?.routes ?? [];
  const route = useMemo(() => routes.find((r) => `${r.nodeId}|${r.group ?? ""}` === routeKey) ?? null, [routes, routeKey]);
  const legacyNode = useMemo(() => nodes.find((n) => n.nodeId === legacyNodeId) ?? null, [nodes, legacyNodeId]);
  const targetNodeId = legacy ? legacyNode?.nodeId : routes.length ? route?.nodeId : legacyNode?.nodeId;
  const targetNode = nodes.find((n) => n.nodeId === targetNodeId) ?? null;

  useEffect(() => { if (orgId) localStorage.setItem(ORG_KEY, orgId); }, [orgId]);
  useEffect(() => { if (legacyNodeId) localStorage.setItem(NODE_KEY, legacyNodeId); }, [legacyNodeId]);
  // keep single-choice steps pre-filled
  useEffect(() => { if (org && domains.length === 1) setDomain(domains[0]); }, [org, domains]);
  useEffect(() => {
    if (!org) return;
    if (routes.length === 1) setRouteKey(`${routes[0].nodeId}|${routes[0].group ?? ""}`);
    else if (routeKey && !routes.some((r) => `${r.nodeId}|${r.group ?? ""}` === routeKey)) setRouteKey("");
  }, [org, routes, routeKey]);

  // legacy: proxies of the picked node
  useEffect(() => {
    if (!token || !legacy || !legacyNode) return;
    setProxyId("auto");
    authFetch<ProxyItem[]>(token, `/api/onboard/proxies?nodeId=${encodeURIComponent(legacyNode.nodeId)}`).then(setProxies).catch(() => setProxies([]));
  }, [token, legacy, legacyNode?.nodeId]);

  // 进行中作业轮询
  useEffect(() => {
    if (!job || (job.status !== "pending_callback" && job.status !== "working")) return;
    pollRef.current = setInterval(() => {
      authFetch<Job>(token, `/api/onboard/jobs/${job.jobId}`)
        .then((j) => {
          setJob(j);
          if (j.status === "done" || j.status === "failed") void loadJobs(token);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [job?.jobId, job?.status, token, loadJobs]);

  const parsed = useMemo(() => (method === "sk" ? parseBatchLines(skText) : []), [method, skText]);
  const validRows = parsed.filter((r) => r.state === "queued");
  const invalidCount = parsed.length - validRows.length;
  const isBatch = validRows.length >= 2;

  const stepOrgDone = legacy || !!org;
  const stepDomainDone = legacy || (!!org && (domains.length === 0 || !!domain));
  const stepRouteDone = legacy ? !!legacyNode : !!org && (routes.length === 0 ? !!legacyNode : !!route);
  const nodeOk = !!targetNode && targetNode.online && targetNode.used < targetNode.capacity;
  const canStart = stepOrgDone && stepDomainDone && stepRouteDone && nodeOk && (method === "link" || validRows.length >= 1) && !batchActive && !busy;

  function params(): Record<string, unknown> {
    const p: Record<string, unknown> = { nodeId: targetNodeId };
    if (legacy) p.proxyId = proxyId;
    else {
      p.orgId = org!.id;
      if (domain) p.domain = domain;
      if (route?.group) p.proxyGroup = route.group;
      p.proxyId = "auto";
    }
    if (name.trim()) p.name = name.trim();
    return p;
  }

  function login(e: React.FormEvent) {
    e.preventDefault();
    const tk = input.trim();
    if (!tk) return;
    localStorage.setItem(TOKEN_KEY, tk);
    setAuthErr("");
    setToken(tk);
  }
  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setLabel(null);
    setReady(false);
    setNodes([]);
    setOrgs([]);
    setJob(null);
    setJobs([]);
  }

  async function start() {
    setErr("");
    if (method === "sk" && isBatch) {
      setBatch({ rows: validRows, params: params() });
      setSkText("");
      return;
    }
    setBusy(true);
    try {
      const j = await authFetch<Job>(token, "/api/onboard/jobs", "POST", method === "sk" ? { method: "session_key", sessionKey: validRows[0].sessionKey, ...params() } : { method: "auth_url", ...params() });
      setJob(j);
      setCallbackUrl("");
      if (method === "sk") setSkText("");
    } catch (e) {
      setErr(friendlyError(t, (e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function submitCallback() {
    if (!job || !callbackUrl.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const j = await authFetch<Job>(token, "/api/onboard/jobs", "POST", { method: "auth_url", jobId: job.jobId, callbackUrl: callbackUrl.trim() });
      setJob({ ...job, status: j.status });
    } catch (e) {
      setErr(friendlyError(t, (e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const routeLabel = (r: OrgRoute) => `${r.nodeName ?? r.nodeId.slice(0, 14)} · ${r.group ?? t("onboardSite.anyGroup")}`;

  /* ---------- 令牌门禁 ---------- */
  if (!token || !ready) {
    return (
      <div className="container-x flex justify-center py-16 sm:py-24">
        <div className="card w-full max-w-md p-6 sm:p-8">
          <div className="kicker">
            <KeyIcon width={14} height={14} className="leading-none text-primary" />
            {t("onboardSite.kicker")}
          </div>
          <h1 className="mt-4 font-display text-[26px] font-bold tracking-[-0.02em] text-on-surface">{t("onboardSite.loginTitle")}</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-on-surface-variant">{t("onboardSite.loginSub")}</p>
          <form onSubmit={login} className="mt-5 flex flex-col gap-3">
            <input className="input font-mono" type="password" placeholder="1dk_onb_…" value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
            {authErr && <p className="text-[13px]" style={{ color: "var(--error)" }}>{authErr}</p>}
            <button type="submit" className="wk-btn wk-btn-md wk-btn-primary">{t("onboardSite.loginBtn")}</button>
          </form>
        </div>
      </div>
    );
  }

  const inFlight = !!job && (job.status === "pending_callback" || job.status === "working");

  /* ---------- 上号工作台 ---------- */
  return (
    <div className="container-x py-10 sm:py-14">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="kicker">
            <RocketIcon width={14} height={14} className="leading-none text-primary" />
            {t("onboardSite.kicker")}
          </div>
          <h1 className="mt-3 font-display text-[28px] font-bold tracking-[-0.02em] text-on-surface">{label}</h1>
        </div>
        <button type="button" onClick={logout} className="wk-btn wk-btn-sm wk-btn-ghost">{t("onboardSite.logout")}</button>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {legacy ? (
            <Step n={1} title={t("onboardSite.node")} done={false} changeLabel={t("onboardSite.change")}>
              <p className="text-[13px] text-on-surface-variant">{t("onboardSite.noOrgs")}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[12.5px] text-on-surface-variant">{t("onboardSite.node")}</span>
                  <select className="input font-mono text-[13px]" value={legacyNodeId} onChange={(e) => setLegacyNodeId(e.target.value)} disabled={batchActive || inFlight}>
                    {nodes.map((n) => (
                      <option key={n.nodeId} value={n.nodeId}>
                        {n.name ? `${n.name} · ` : ""}{n.nodeId.slice(0, 16)}… · {n.online ? t("onboardSite.nodeOnline") : t("onboardSite.nodeOffline")} · {n.used}/{n.capacity} · {t("onboardSite.freeProxies")} {n.freeProxies ?? "?"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12.5px] text-on-surface-variant">{t("onboardSite.proxy")}</span>
                  <select className="input" value={proxyId} onChange={(e) => setProxyId(e.target.value)}>
                    <option value="auto">{t("onboardSite.proxyAuto")}</option>
                    {proxies.map((p) => (
                      <option key={p.id} value={p.id}>{p.group ? `[${p.group}] ` : ""}{p.label ?? `${p.host ?? "?"}:${p.port ?? ""}`} ({p.id})</option>
                    ))}
                  </select>
                </label>
              </div>
            </Step>
          ) : (
            <>
              {/* ① 组织 */}
              <Step n={1} title={t("onboardSite.stepOrg")} done={!!org} summary={org?.name} onChange={() => { setOrgId(""); setDomain(""); setRouteKey(""); }} changeLabel={t("onboardSite.change")}>
                <p className="text-[13px] text-on-surface-variant">{t("onboardSite.orgHint")}</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {orgs.map((o) => (
                    <Chip key={o.id} active={o.id === orgId} onClick={() => { setOrgId(o.id); setDomain(""); setRouteKey(""); }} disabled={batchActive || inFlight}>
                      <div className="font-semibold">{o.name}</div>
                      <div className="mt-0.5 text-[12px] opacity-80">
                        {o.domains.length ? o.domains.map((d) => `@${d}`).join(" · ") : t("onboardSite.noDomains")} · {o.routes.length} {t("onboardSite.stepRoute")}
                      </div>
                      {o.note && <div className="mt-0.5 text-[12px] opacity-70">{o.note}</div>}
                    </Chip>
                  ))}
                </div>
              </Step>

              {/* ② 域名 */}
              {org && domains.length > 0 && (
                <Step n={2} title={t("onboardSite.stepDomain")} done={!!domain} summary={domain ? `@${domain}` : undefined} onChange={() => setDomain("")} changeLabel={t("onboardSite.change")}>
                  <p className="text-[13px] text-on-surface-variant">{t("onboardSite.domainHint")}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {domains.map((d) => (
                      <Chip key={d} active={d === domain} onClick={() => setDomain(d)} disabled={batchActive || inFlight}><span className="font-mono">@{d}</span></Chip>
                    ))}
                  </div>
                </Step>
              )}

              {/* ③ 节点 · IP 分组 */}
              {org && stepDomainDone && (
                <Step n={domains.length ? 3 : 2} title={t("onboardSite.stepRoute")} done={stepRouteDone} summary={route ? routeLabel(route) : legacyNode ? (legacyNode.name ?? legacyNode.nodeId.slice(0, 14)) : undefined} onChange={() => setRouteKey("")} changeLabel={t("onboardSite.change")}>
                  <p className="text-[13px] text-on-surface-variant">{t("onboardSite.routeHint")}</p>
                  {routes.length === 0 ? (
                    <div className="mt-3">
                      <p className="text-[13px]" style={{ color: "var(--warning)" }}>{t("onboardSite.noRoutes")}</p>
                      <select className="input mt-2 font-mono text-[13px]" value={legacyNodeId} onChange={(e) => setLegacyNodeId(e.target.value)}>
                        {nodes.map((n) => (
                          <option key={n.nodeId} value={n.nodeId}>{n.name ? `${n.name} · ` : ""}{n.nodeId.slice(0, 16)}… · {n.online ? t("onboardSite.nodeOnline") : t("onboardSite.nodeOffline")}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {routes.map((r) => {
                        const k = `${r.nodeId}|${r.group ?? ""}`;
                        const bad = !r.nodeOnline || r.assignable === 0 || !r.groupExists;
                        return (
                          <Chip key={k} active={k === routeKey} onClick={() => setRouteKey(k)} disabled={batchActive || inFlight}>
                            <div className="flex items-center gap-2 font-semibold">
                              <span className="h-[8px] w-[8px] rounded-full" style={{ background: r.nodeOnline ? "var(--success)" : "var(--error)" }} />
                              <CubeIcon width={14} height={14} />
                              {routeLabel(r)}
                            </div>
                            <div className="mt-0.5 text-[12px]" style={bad ? { color: k === routeKey ? "inherit" : "var(--error)" } : { opacity: 0.8 }}>
                              {r.nodeOnline ? `${t("onboardSite.capacity")} ${r.used}/${r.capacity} · ${t("onboardSite.freeProxies")} ${r.assignable}` : t("onboardSite.routeOffline")}
                            </div>
                          </Chip>
                        );
                      })}
                    </div>
                  )}
                </Step>
              )}
            </>
          )}

          {/* ④ 凭据 */}
          {stepRouteDone && !inFlight && !batch && (
            <Step n={legacy ? 2 : domains.length ? 4 : 3} title={t("onboardSite.stepCred")} done={false} changeLabel={t("onboardSite.change")}>
              <div className="inline-flex rounded-md p-0.5" style={{ background: "var(--surface-variant)" }}>
                {(["sk", "link"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMethod(m)} className="rounded-sm px-3 py-1.5 text-[13px] font-medium" style={method === m ? { background: "var(--surface)", boxShadow: "0 1px 2px rgba(0,0,0,.08)" } : { color: "var(--on-surface-variant)" }}>
                    {m === "sk" ? t("onboardSite.methodSk") : t("onboardSite.methodLink")}
                  </button>
                ))}
              </div>
              {method === "sk" ? (
                <div className="mt-3">
                  <textarea className="input min-h-[96px] w-full font-mono text-[12.5px]" placeholder={"sk-ant-sid01-…\nsk-ant-sid01-…"} value={skText} onChange={(e) => setSkText(e.target.value)} spellCheck={false} />
                  <p className="mt-1.5 text-[12.5px] text-on-surface-variant">
                    {t("onboardSite.skHint")}
                    {invalidCount > 0 && <span style={{ color: "var(--error)" }}> · {t("onboardSite.skInvalid", { n: invalidCount })}</span>}
                    {isBatch && <span> · {t("onboardSite.skBatch", { n: validRows.length })}</span>}
                  </p>
                  {isBatch && (
                    <label className="mt-2 flex items-center gap-2 text-[12.5px] text-on-surface-variant">
                      {t("onboardSite.batchInterval")}
                      <input className="input w-[64px]" type="number" min={1} max={120} value={minSec} onChange={(e) => setMinSec(Number(e.target.value) || 1)} />
                      <span>–</span>
                      <input className="input w-[64px]" type="number" min={1} max={120} value={maxSec} onChange={(e) => setMaxSec(Number(e.target.value) || 1)} />
                      <span>s</span>
                    </label>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-on-surface-variant">{t("onboardSite.step1")}</p>
              )}
              <label className="mt-3 flex flex-col gap-1 sm:max-w-xs">
                <span className="text-[12.5px] text-on-surface-variant">{t("onboardSite.name")}</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              </label>
            </Step>
          )}

          {/* 授权链接流程 */}
          {inFlight && job && (
            <div className="card mt-4 p-5">
              {job.status === "pending_callback" ? (
                <div className="flex flex-col gap-4">
                  <div>
                    <div className="text-[12.5px] font-semibold text-on-surface">{t("onboardSite.step1")}</div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <a href={job.authorizeUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate rounded-md px-3 py-2 font-mono text-[12px] text-primary hover:underline" style={{ background: "var(--surface-variant)" }}>{job.authorizeUrl}</a>
                      <button type="button" className="wk-btn wk-btn-sm wk-btn-ghost shrink-0" onClick={() => void navigator.clipboard.writeText(job.authorizeUrl ?? "")}>{t("onboardSite.copy")}</button>
                    </div>
                  </div>
                  <div>
                    <div className="text-[12.5px] font-semibold text-on-surface">{t("onboardSite.step2")}</div>
                    <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                      <input className="input flex-1 font-mono text-[12.5px]" placeholder={t("onboardSite.callbackPlaceholder")} value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} />
                      <button type="button" onClick={submitCallback} disabled={busy || !callbackUrl.trim()} className="wk-btn wk-btn-md wk-btn-primary shrink-0">{t("onboardSite.submit")}</button>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="font-mono text-[13px] text-on-surface-variant">{t("onboardSite.status")}: {t("onboardSite.working")}</p>
              )}
              {err && <p className="mt-2 text-[13px]" style={{ color: "var(--error)" }}>{err}</p>}
              <div className="mt-3">
                <button type="button" disabled={busy} className="wk-btn wk-btn-sm wk-btn-ghost" onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await authFetch<Job>(token, `/api/onboard/jobs/${job.jobId}/cancel`, "POST", {});
                    setJob(result.status === "done" ? result : null);
                    void loadJobs(token);
                  } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
                }}>{t("onboardSite.cancel")}</button>
              </div>
            </div>
          )}

          {/* 单条结果 */}
          {job && (job.status === "done" || job.status === "failed") && (
            <div className="card mt-4 p-5">
              {job.status === "done" ? (
                <p className="text-[13.5px] font-semibold" style={{ color: "var(--success)" }}>
                  {job.reused ? t("onboardSite.batchState.reused") : t("onboardSite.done")} {job.accountEmail ? <span className="font-mono text-[12.5px]">{job.accountEmail}</span> : null}
                </p>
              ) : (
                <p className="text-[13.5px]" style={{ color: "var(--error)" }}>{t("onboardSite.failed")}: {friendlyError(t, job.error)}</p>
              )}
              <button type="button" className="wk-btn wk-btn-sm wk-btn-ghost mt-3" onClick={() => { setJob(null); setErr(""); }}>{t("onboardSite.newTitle")}</button>
            </div>
          )}

          {/* 批量执行 */}
          {batch && (
            <BatchRunner token={token} params={batch.params} rows={batch.rows} minSec={minSec} maxSec={maxSec} onJobsChanged={() => void loadJobs(token)} onActiveChange={setBatchActive} onClose={() => setBatch(null)} />
          )}

          {/* 最近作业 */}
          <div className="card mt-4 p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-[18px] font-bold text-on-surface">{t("onboardSite.recent")}</h2>
              <button type="button" onClick={() => loadJobs(token)} className="wk-btn wk-btn-sm wk-btn-ghost">{t("onboardSite.refresh")}</button>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="wk-table">
                <thead>
                  <tr>
                    <th className="ta-l">{t("onboardSite.colJob")}</th>
                    <th className="ta-l">{t("onboardSite.colStatus")}</th>
                    <th className="ta-l">{t("onboardSite.colOrg")}</th>
                    <th className="ta-l">{t("onboardSite.colAccount")}</th>
                    <th className="ta-l">{t("onboardSite.colError")}</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.jobId}>
                      <td className="ta-l font-mono text-[12px]">{j.jobId.slice(0, 8)}…</td>
                      <td className="ta-l">
                        <span className="font-mono text-[11px] font-bold" style={{ color: j.status === "done" ? "var(--success)" : j.status === "failed" ? "var(--error)" : "var(--warning)" }}>{j.status}</span>
                        {(j.status === "pending_callback" || j.status === "working") && (
                          <button type="button" disabled={batchActive || busy} className="wk-btn wk-btn-sm wk-btn-ghost ml-2" onClick={() => { setJob(j); setCallbackUrl(""); setErr(""); }}>{t("onboardSite.change")}</button>
                        )}
                      </td>
                      <td className="ta-l text-[12px]">{j.orgName ?? "—"}{j.domain ? <span className="font-mono text-on-surface-faint"> @{j.domain}</span> : null}</td>
                      <td className="ta-l text-[12px]">
                        {j.accountEmail ?? j.accountName ?? (j.accountId ? `${j.accountId.slice(0, 8)}…` : "—")}
                        {j.reused && <span className="ml-1 font-mono text-[11px]" style={{ color: "var(--warning)" }}>({t("onboardSite.batchState.reused")})</span>}
                        {j.cooldownUntil && new Date(j.cooldownUntil).getTime() > Date.now() && (
                          <span className="ml-1 font-mono text-[11px] text-on-surface-variant">({t("onboardSite.cooldownUntil", { time: new Date(j.cooldownUntil).toLocaleTimeString() })})</span>
                        )}
                      </td>
                      <td className="ta-l max-w-[280px] truncate text-[12px] text-on-surface-variant" title={j.error}>{friendlyError(t, j.error) || "—"}</td>
                    </tr>
                  ))}
                  {jobs.length === 0 && (
                    <tr><td colSpan={5} className="py-10 text-center text-on-surface-faint">{t("onboardSite.empty")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* 摘要 + 开始 */}
        <aside className="card mt-4 p-5 lg:sticky lg:top-6">
          <h2 className="font-display text-[16px] font-bold text-on-surface">{t("onboardSite.summary")}</h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[13px]">
            {!legacy && (<><dt className="text-on-surface-faint">{t("onboardSite.sumOrg")}</dt><dd className="min-w-0 break-words">{org?.name ?? "—"}</dd></>)}
            {!legacy && domains.length > 0 && (<><dt className="text-on-surface-faint">{t("onboardSite.sumDomain")}</dt><dd className="font-mono">{domain ? `@${domain}` : "—"}</dd></>)}
            <dt className="text-on-surface-faint">{t("onboardSite.sumRoute")}</dt>
            <dd className="min-w-0 break-words">{route ? routeLabel(route) : targetNode ? (targetNode.name ?? targetNode.nodeId.slice(0, 14)) : "—"}</dd>
            <dt className="text-on-surface-faint">{t("onboardSite.sumKeys")}</dt>
            <dd className="font-mono text-[12.5px]">{method === "link" ? t("onboardSite.methodLink") : validRows.length === 0 ? "—" : validRows.length === 1 ? `${validRows[0].sessionKey!.slice(0, 14)}…` : t("onboardSite.skBatch", { n: validRows.length })}</dd>
          </dl>
          {targetNode && !nodeOk && <p className="mt-3 text-[12.5px]" style={{ color: "var(--error)" }}>{targetNode.online ? `${t("onboardSite.capacity")} ${targetNode.used}/${targetNode.capacity}` : t("onboardSite.nodeOffline")}</p>}
          {err && !inFlight && <p className="mt-3 text-[12.5px]" style={{ color: "var(--error)" }}>{err}</p>}
          <button type="button" onClick={() => void start()} disabled={!canStart || inFlight || !!batch} className="wk-btn wk-btn-md wk-btn-primary mt-4 w-full justify-center" title={canStart ? undefined : t("onboardSite.pickFirst")}>
            {method === "sk" && isBatch ? t("onboardSite.startBatch", { n: validRows.length }) : t("onboardSite.start")}
          </button>
        </aside>
      </div>
    </div>
  );
}
