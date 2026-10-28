import { useCallback, useEffect, useRef, useState } from "react";
import { CubeIcon, KeyIcon, RocketIcon } from "../components/Icon";
import { useT } from "../i18n";

// 上号员站点（/onboard）：独立于控制台登录体系，凭 1dk_onb_… 令牌上号。
// 令牌绑定目标节点（管理员签发时指定），账号落入平台池。

const TOKEN_KEY = "onboarder-token";
const NODE_KEY = "onboarder-node";

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
  host: string | null;
  port: number | null;
  status: string;
}

interface Job {
  nodeId?: string;
  method?: string;
  jobId: string;
  status: "pending_callback" | "working" | "done" | "failed";
  accountId?: string;
  accountName?: string;
  accountEmail?: string;
  reused?: boolean;
  cooldownUntil?: string;
  error?: string;
  authorizeUrl?: string;
}

// ---------- 批量 sessionKey 上号 ----------
//
// 每行一个 sessionKey；组织由服务端授权验证，不在上号员界面显示。

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

function BatchOnboard({ token, nodeId, nodeOnline, onJobsChanged, onActiveChange }: { token: string; nodeId: string; nodeOnline: boolean; onJobsChanged: () => void; onActiveChange: (active: boolean) => void }) {
  const { t } = useT();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [minSec, setMinSec] = useState(5);
  const [maxSec, setMaxSec] = useState(7);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const rowsRef = useRef<BatchRow[]>([]);
  rowsRef.current = rows;
  const runningRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { onActiveChange(running || rows.some((r) => r.state === "working" || r.state === "submitting")); }, [running, rows, onActiveChange]);

  const patch = useCallback((id: number, p: Partial<BatchRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }, []);

  // 逐条提交：取第一条 queued，POST，然后按随机间隔排下一条
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
      const j = await authFetch<Job>(token, "/api/onboard/jobs", "POST", {
        method: "session_key",
        nodeId,
        sessionKey: next.sessionKey,
        ...(next.orgUuid ? { orgUuid: next.orgUuid } : {}),
        proxyId: "auto",
      });
      patch(next.id, { state: "working", jobId: j.jobId });
    } catch (e) {
      const msg = (e as Error).message;
      // 令牌失效 / 节点没空闲代理：停下来，这一行留在队列里
      const stop = /401|403|token|proxy|capacity|node/i.test(msg);
      patch(next.id, { state: stop ? "queued" : "failed", error: msg });
      if (stop) {
        runningRef.current = false;
        setRunning(false);
        setNotice(msg);
        return;
      }
    }
    const lo = Math.max(1, Math.min(minSec, maxSec));
    const hi = Math.max(lo, maxSec);
    const delay = (lo + Math.random() * (hi - lo)) * 1000;
    timerRef.current = setTimeout(() => void submitNext(), delay);
  }, [token, nodeId, minSec, maxSec, patch]);

  // 进行中作业轮询（所有 working 行，3 秒一轮）
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
              patch(r.id, { state: "failed", error: j.error ?? "failed" });
              onJobsChanged();
            }
          })
          .catch(() => {});
      }
    }, 3000);
    return () => clearInterval(id);
  }, [rows, token, patch, onJobsChanged]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  function parse() {
    setRows(parseBatchLines(text));
    setNotice("");
  }
  function start() {
    if (runningRef.current) return;
    setNotice("");
    runningRef.current = true;
    setRunning(true);
    void submitNext();
  }
  function pause() {
    runningRef.current = false;
    setRunning(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  }
  function clear() {
    pause();
    setRows([]);
    setText("");
    setNotice("");
  }
  function copyFailed() {
    const failed = rows.filter((r) => r.state === "failed" || r.state === "invalid").map((r) => r.line);
    void navigator.clipboard.writeText(failed.join("\n"));
  }

  const count = (st: RowState) => rows.filter((r) => r.state === st).length;
  const queued = count("queued");
  const inFlight = count("submitting") + count("working");
  const stateColor: Record<RowState, string> = {
    invalid: "var(--on-surface-faint)",
    queued: "var(--on-surface-variant)",
    submitting: "var(--warning)",
    working: "var(--warning)",
    done: "var(--success)",
    reused: "var(--warning)",
    failed: "var(--error)",
  };

  return (
    <div className="card mt-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[18px] font-bold text-on-surface">{t("onboardSite.batchTitle")}</h2>
        {rows.length > 0 && (
          <span className="font-mono text-[12px] text-on-surface-variant">
            {t("onboardSite.batchSummary", { total: rows.length, queued, inFlight, done: count("done"), reused: count("reused"), failed: count("failed") + count("invalid") })}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-on-surface-variant">{t("onboardSite.batchHint")}</p>
      <textarea
        className="input mt-3 min-h-[120px] w-full font-mono text-[12.5px]"
        placeholder={"sk-ant-sid01-…\nsk-ant-sid01-…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={running}
        spellCheck={false}
      />
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] text-on-surface-variant">{t("onboardSite.batchInterval")}</span>
          <div className="flex items-center gap-1.5">
            <input className="input w-[72px]" type="number" min={1} max={120} value={minSec} onChange={(e) => setMinSec(Number(e.target.value) || 1)} disabled={running} />
            <span className="text-on-surface-faint">–</span>
            <input className="input w-[72px]" type="number" min={1} max={120} value={maxSec} onChange={(e) => setMaxSec(Number(e.target.value) || 1)} disabled={running} />
            <span className="text-[12.5px] text-on-surface-faint">s</span>
          </div>
        </label>
        <button type="button" className="wk-btn wk-btn-md" onClick={parse} disabled={running || !text.trim()}>
          {t("onboardSite.batchParse")}
        </button>
        {!running ? (
          <button type="button" className="wk-btn wk-btn-md wk-btn-primary" onClick={start} disabled={!nodeOnline || queued === 0}>
            {t("onboardSite.batchStart", { n: queued })}
          </button>
        ) : (
          <button type="button" className="wk-btn wk-btn-md wk-btn-primary" onClick={pause}>
            {t("onboardSite.batchPause")}
          </button>
        )}
        <button type="button" className="wk-btn wk-btn-md wk-btn-ghost" onClick={copyFailed} disabled={count("failed") + count("invalid") === 0}>
          {t("onboardSite.batchCopyFailed")}
        </button>
        <button type="button" className="wk-btn wk-btn-md wk-btn-ghost" onClick={clear} disabled={rows.length === 0 && !text}>
          {t("onboardSite.batchClear")}
        </button>
      </div>
      {notice && (
        <p className="mt-2 text-[13px]" style={{ color: "var(--error)" }}>
          {t("onboardSite.batchStopped")}: {notice}
        </p>
      )}
      {rows.length > 0 && (
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
                  <td className="ta-l">
                    <span className="font-mono text-[11px] font-bold" style={{ color: stateColor[r.state] }}>
                      {t(`onboardSite.batchState.${r.state}`)}
                    </span>
                  </td>
                  <td className="ta-l text-[12px]">{r.email ?? r.name ?? "—"}</td>
                  <td className="ta-l max-w-[320px] truncate text-[12px] text-on-surface-variant" title={r.error}>
                    {r.error ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function authFetch<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  return fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    const j = (await r.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
    if (!r.ok) throw new Error(j.error?.message ?? `${r.status}`);
    return j.data as T;
  });
}

export function OnboardSite() {
  const { t } = useT();
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [label, setLabel] = useState<string | null>(null);
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [batchActive, setBatchActive] = useState(false);
  const [authErr, setAuthErr] = useState("");
  const [input, setInput] = useState("");

  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [proxyId, setProxyId] = useState("auto");
  const [name, setName] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadJobs = useCallback(
    (tk: string) => authFetch<Job[]>(tk, "/api/onboard/jobs").then(setJobs).catch(() => {}),
    [],
  );

  // 令牌校验 + 节点信息
  useEffect(() => {
    if (!token) return;
    authFetch<{ label: string; node: NodeInfo; nodes?: NodeInfo[] }>(token, "/api/onboard/me")
      .then((d) => {
        setLabel(d.label);
        const list = d.nodes && d.nodes.length ? d.nodes : [d.node];
        setNodes(list);
        // keep the operator's pick across refreshes when it is still allowed; else the server default
        const keep = list.find((n) => n.nodeId === localStorage.getItem(NODE_KEY));
        setNode(keep ?? d.node);
      })
      .then(() => loadJobs(token))
      .catch((e: Error) => {
        setAuthErr(e.message);
        setLabel(null);
        setNode(null);
        localStorage.removeItem(TOKEN_KEY);
        setToken("");
      });
  }, [token, loadJobs]);

  // 选中节点变化 → 重新拉该节点的空闲代理
  useEffect(() => {
    if (!token || !node) return;
    localStorage.setItem(NODE_KEY, node.nodeId);
    setProxyId("auto");
    authFetch<ProxyItem[]>(token, `/api/onboard/proxies?nodeId=${encodeURIComponent(node.nodeId)}`).then(setProxies).catch(() => setProxies([]));
  }, [token, node?.nodeId]);

  // 进行中作业的轮询
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
    setNode(null);
    setNodes([]);
    setJob(null);
    setJobs([]);
  }

  async function startJob() {
    setBusy(true);
    setErr("");
    try {
      const j = await authFetch<Job>(token, "/api/onboard/jobs", "POST", {
        method: "auth_url",
        nodeId: node?.nodeId,
        proxyId,
        name: name.trim() || undefined,
      });
      setJob(j);
      setCallbackUrl("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCallback() {
    if (!job || !callbackUrl.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const j = await authFetch<Job>(token, "/api/onboard/jobs", "POST", {
        method: "auth_url",
        jobId: job.jobId,
        callbackUrl: callbackUrl.trim(),
      });
      setJob({ ...job, status: j.status });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /* ---------- 令牌门禁 ---------- */
  if (!token || !node) {
    return (
      <div className="container-x flex justify-center py-16 sm:py-24">
        <div className="card w-full max-w-md p-6 sm:p-8">
          <div className="kicker">
            <KeyIcon width={14} height={14} className="leading-none text-primary" />
            {t("onboardSite.kicker")}
          </div>
          <h1 className="mt-4 font-display text-[26px] font-bold tracking-[-0.02em] text-on-surface">
            {t("onboardSite.loginTitle")}
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-on-surface-variant">{t("onboardSite.loginSub")}</p>
          <form onSubmit={login} className="mt-5 flex flex-col gap-3">
            <input
              className="input font-mono"
              type="password"
              placeholder="1dk_onb_…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
            />
            {authErr && <p className="text-[13px]" style={{ color: "var(--error)" }}>{authErr}</p>}
            <button type="submit" className="wk-btn wk-btn-md wk-btn-primary">
              {t("onboardSite.loginBtn")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  /* ---------- 上号工作台 ---------- */
  return (
    <div className="container-x py-10 sm:py-14">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="kicker">
            <RocketIcon width={14} height={14} className="leading-none text-primary" />
            {t("onboardSite.kicker")}
          </div>
          <h1 className="mt-3 font-display text-[28px] font-bold tracking-[-0.02em] text-on-surface">
            {label}
          </h1>
        </div>
        <button type="button" onClick={logout} className="wk-btn wk-btn-sm wk-btn-ghost">
          {t("onboardSite.logout")}
        </button>
      </div>

      {/* 目标节点（令牌绑定多个节点时可选） */}
      <div className="card mt-6 p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-on-surface">
            <span
              className="h-[8px] w-[8px] rounded-full"
              style={{ background: node.online ? "var(--success)" : "var(--error)" }}
            />
            <CubeIcon width={16} height={16} className="text-primary" />
            {t("onboardSite.node")}:
          </span>
          {nodes.length > 1 ? (
            <select
              className="input w-auto min-w-[260px] font-mono text-[13px]"
              value={node.nodeId}
              onChange={(e) => setNode(nodes.find((n) => n.nodeId === e.target.value) ?? node)}
              disabled={batchActive || (!!job && (job.status === "pending_callback" || job.status === "working"))}
            >
              {nodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {n.name ? `${n.name} · ` : ""}
                  {n.nodeId.slice(0, 16)}… · {n.online ? t("onboardSite.nodeOnline") : t("onboardSite.nodeOffline")} · {n.used}/{n.capacity} · {t("onboardSite.freeProxies")} {n.freeProxies ?? "?"}
                </option>
              ))}
            </select>
          ) : (
            <code className="font-mono text-[13px]">
              {node.name ? `${node.name} · ` : ""}
              {node.nodeId.slice(0, 16)}…
            </code>
          )}
          <span className="font-mono text-[12px] text-on-surface-faint">
            {t("onboardSite.capacity")}: {node.used}/{node.capacity} · {t("onboardSite.freeProxies")}: {proxies.length}
          </span>
        </div>
      </div>

      {/* 新建上号 */}
      <div className="card mt-4 p-5">
        <h2 className="font-display text-[18px] font-bold text-on-surface">{t("onboardSite.newTitle")}</h2>
        {!job || job.status === "done" || job.status === "failed" ? (
          <div className="mt-4 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-[12.5px] text-on-surface-variant">{t("onboardSite.proxy")}</span>
                <select className="input" value={proxyId} onChange={(e) => setProxyId(e.target.value)}>
                  <option value="auto">{t("onboardSite.proxyAuto")}</option>
                  {proxies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label ?? `${p.host ?? "?"}:${p.port ?? ""}`} ({p.id})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[12.5px] text-on-surface-variant">{t("onboardSite.name")}</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              </label>
            </div>
            {job?.status === "done" && (
              <p className="text-[13.5px] font-semibold" style={{ color: "var(--success)" }}>
                {t("onboardSite.done")}
              </p>
            )}
            {job?.status === "failed" && (
              <p className="text-[13.5px]" style={{ color: "var(--error)" }}>
                {t("onboardSite.failed")}: {job.error}
              </p>
            )}
            {err && <p className="text-[13px]" style={{ color: "var(--error)" }}>{err}</p>}
            <div>
              <button
                type="button"
                onClick={startJob}
                disabled={busy || !node.online || node.used >= node.capacity}
                className="wk-btn wk-btn-md wk-btn-primary"
              >
                {t("onboardSite.start")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <div>
              <div className="text-[12.5px] font-semibold text-on-surface">{t("onboardSite.step1")}</div>
              <div className="mt-1.5 flex items-center gap-2">
                <a
                  href={job.authorizeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate rounded-md px-3 py-2 font-mono text-[12px] text-primary hover:underline"
                  style={{ background: "var(--surface-variant)" }}
                >
                  {job.authorizeUrl}
                </a>
                <button
                  type="button"
                  className="wk-btn wk-btn-sm wk-btn-ghost shrink-0"
                  onClick={() => void navigator.clipboard.writeText(job.authorizeUrl ?? "")}
                >
                  {t("onboardSite.copy")}
                </button>
              </div>
            </div>
            <div>
              <div className="text-[12.5px] font-semibold text-on-surface">{t("onboardSite.step2")}</div>
              <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                <input
                  className="input flex-1 font-mono text-[12.5px]"
                  placeholder={t("onboardSite.callbackPlaceholder")}
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                />
                <button
                  type="button"
                  onClick={submitCallback}
                  disabled={busy || !callbackUrl.trim() || job.status !== "pending_callback"}
                  className="wk-btn wk-btn-md wk-btn-primary shrink-0"
                >
                  {t("onboardSite.submit")}
                </button>
              </div>
            </div>
            <p className="font-mono text-[12px] text-on-surface-variant">
              {t("onboardSite.status")}: {job.status === "pending_callback" ? t("onboardSite.waitingCallback") : t("onboardSite.working")}
            </p>
            {err && <p className="text-[13px]" style={{ color: "var(--error)" }}>{err}</p>}
            <div>
              <button type="button" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  const result = await authFetch<Job>(token, `/api/onboard/jobs/${job.jobId}/cancel`, "POST", {});
                  setJob(result.status === "done" ? result : null);
                  void loadJobs(token);
                } catch (e) { setErr((e as Error).message); }
                finally { setBusy(false); }
              }} className="wk-btn wk-btn-sm wk-btn-ghost">
                {t("onboardSite.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 批量 sessionKey 上号 */}
      <BatchOnboard token={token} nodeId={node.nodeId} nodeOnline={node.online} onJobsChanged={() => void loadJobs(token)} onActiveChange={setBatchActive} />

      {/* 最近作业 */}
      <div className="card mt-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[18px] font-bold text-on-surface">{t("onboardSite.recent")}</h2>
          <button type="button" onClick={() => loadJobs(token)} className="wk-btn wk-btn-sm wk-btn-ghost">
            {t("onboardSite.refresh")}
          </button>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="wk-table">
            <thead>
              <tr>
                <th className="ta-l">{t("onboardSite.colJob")}</th>
                <th className="ta-l">{t("onboardSite.colStatus")}</th>
                <th className="ta-l">{t("onboardSite.colAccount")}</th>
                <th className="ta-l">{t("onboardSite.colError")}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.jobId}>
                  <td className="ta-l font-mono text-[12px]">{j.jobId.slice(0, 8)}…</td>
                  <td className="ta-l">
                    <span
                      className="font-mono text-[11px] font-bold"
                      style={{
                        color:
                          j.status === "done"
                            ? "var(--success)"
                            : j.status === "failed"
                              ? "var(--error)"
                              : "var(--warning)",
                      }}
                    >
                      {j.status}
                    </span>
                    {(j.status === "pending_callback" || j.status === "working") && <button type="button" disabled={batchActive || busy} className="wk-btn wk-btn-sm wk-btn-ghost ml-2" onClick={() => {
                      if (j.nodeId) setNode(nodes.find((n) => n.nodeId === j.nodeId) ?? node);
                      setJob(j); setCallbackUrl(""); setErr("");
                    }}>继续</button>}
                  </td>
                  <td className="ta-l text-[12px]">
                    {j.accountEmail ?? j.accountName ?? (j.accountId ? `${j.accountId.slice(0, 8)}…` : "—")}
                    {j.reused && <span className="ml-1 font-mono text-[11px]" style={{ color: "var(--warning)" }}>({t("onboardSite.batchState.reused")})</span>}
                    {j.cooldownUntil && new Date(j.cooldownUntil).getTime() > Date.now() && (
                      <span className="ml-1 font-mono text-[11px] text-on-surface-variant">({t("onboardSite.cooldownUntil", { time: new Date(j.cooldownUntil).toLocaleTimeString() })})</span>
                    )}
                  </td>
                  <td className="ta-l max-w-[280px] truncate text-[12px] text-on-surface-variant">{j.error ?? "—"}</td>
                </tr>
              ))}
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-on-surface-faint">
                    {t("onboardSite.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
