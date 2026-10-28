import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../../lib/auth";
import { ArrowRightIcon, CheckIcon, PlugIcon, RefreshIcon } from "../../../components/Icon";
import {
  api,
  nodeProxies,
  onboardJob,
  onboardStart,
  type Group,
  type NodeRow,
  type OnboardJob,
  type OnboardScope,
  type ProxyPickerItem,
} from "../../api";
import { useCT } from "../../i18n";
import { AccountTabs } from "../admin/Accounts";
import {
  Async,
  Badge,
  Button,
  Card,
  CopyButton,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  Spinner,
  Textarea,
  errMessage,
  useAsync,
  useToast,
} from "../../ui";

// Account onboarding ("上号") for both consoles (docs/onboarding.md §2/§4/§7).
// Same page for admins (platform pool, optional group) and providers (own
// nodes only, review_status=pending); only the API prefix and the group
// picker differ. Claude subscriptions only — other platforms are hidden
// site-wide for now.

type Method = "session_key" | "auth_url";

const POLL_MS = 1500;

export function OnboardPage({ scope }: { scope: OnboardScope }) {
  const { t } = useCT();
  const toast = useToast();
  const isAdmin = scope === "admin";
  const { me } = useAuth();
  const canSeeTeam = me?.role === "admin";

  const nodes = useAsync(() => api.get<NodeRow[]>(`/api/${scope}/nodes`), [scope]);
  const groups = useAsync(
    () => (isAdmin ? api.get<Group[]>("/api/admin/groups") : Promise.resolve([] as Group[])),
    [isAdmin],
  );

  const [method, setMethod] = useState<Method>("session_key");
  const [sessionKey, setSessionKey] = useState("");
  const [orgUuid, setOrgUuid] = useState("");
  const [teamName, setTeamName] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [proxyId, setProxyId] = useState("auto");
  const [concurrency, setConcurrency] = useState("");
  const [rpm, setRpm] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [groupId, setGroupId] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");

  const [proxies, setProxies] = useState<ProxyPickerItem[] | null>(null);
  const [proxiesErr, setProxiesErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<OnboardJob | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onlineNodes = useMemo(() => (nodes.data ?? []).filter((n) => n.online), [nodes.data]);
  const nodeOptions = useMemo(
    () =>
      (nodes.data ?? []).map((n) => ({
        value: n.nodeId,
        label: `${n.deployMeta?.name ?? n.nodeId.slice(0, 20)} · ${
          n.online ? t("admin.accounts.nodeOnline") : t("admin.accounts.nodeOffline")
        } · ${n.accountCount}/${n.capacity}`,
      })),
    [nodes.data, t],
  );

  // Default to the first online node once nodes load.
  useEffect(() => {
    if (!nodeId && onlineNodes.length) setNodeId(onlineNodes[0].nodeId);
  }, [onlineNodes, nodeId]);

  // The server checks organization membership and reserves a capacity slot.
  useEffect(() => {
    setProxyId("auto");
    setProxies(null);
    setProxiesErr(null);
    if (!nodeId) return;
    let alive = true;
    nodeProxies(scope, nodeId, true)
      .then((list) => alive && setProxies(list))
      .catch((e) => alive && setProxiesErr(errMessage(e)));
    return () => {
      alive = false;
    };
  }, [scope, nodeId]);

  // Poll the job while the server is working; pending_callback is a stable
  // state (waiting for the user to paste the callback URL), done/failed stop.
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!job || job.status !== "working") return;
    timer.current = setInterval(() => {
      onboardJob(scope, job.jobId)
        .then((j) => setJob(j))
        .catch(() => {});
    }, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [scope, job?.jobId, job?.status]);

  function reset() {
    setJob(null);
    setErr(null);
    setSessionKey("");
    setOrgUuid("");
    setTeamName("");
    setCallbackUrl("");
  }

  function commonParams(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      nodeId,
      proxyId: proxyId === "auto" ? "auto" : proxyId,
      concurrencyLimit: Number(concurrency) || 0,
      rpmLimit: Number(rpm) || 0,
    };
    if (name.trim()) body.name = name.trim();
    if (note.trim()) body.note = note.trim();
    if (isAdmin && groupId) body.groupId = groupId;
    if (canSeeTeam && teamName.trim()) body.teamName = teamName.trim();
    return body;
  }

  async function submit() {
    if (!nodeId) {
      setErr(t("onboard.errNode"));
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      if (method === "session_key") {
        if (!sessionKey.trim()) {
          setErr(t("onboard.errSessionKey"));
          return;
        }
        setJob(
          await onboardStart(scope, {
            method,
            sessionKey: sessionKey.trim(),
            ...(canSeeTeam && orgUuid.trim() ? { orgUuid: orgUuid.trim() } : {}),
            ...commonParams(),
          }),
        );
      } else {
        // Step 1: platform generates the authorize URL; user completes consent
        // in their own browser, then pastes the callback URL back (step 2).
        const j = await onboardStart(scope, { method, ...commonParams() });
        setJob(j);
        if (j.authorizeUrl) toast.success(t("onboard.linkReady"));
      }
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCallback() {
    if (!job || !callbackUrl.trim()) return;
    setErr(null);
    setBusy(true);
    try {
      setJob(await onboardStart(scope, { method: "auth_url", jobId: job.jobId, callbackUrl: callbackUrl.trim() }));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const proxyOptions = useMemo(() => {
    const opts = [{ value: "auto", label: t("onboard.proxyAuto") }];
    for (const p of proxies ?? []) {
      const host = p.host ? `${p.host}${p.port ? `:${p.port}` : ""}` : p.id.slice(0, 12);
      opts.push({
        value: p.id,
        label: `${p.label ?? host} · ${host} · ${t(`status.${p.status}`)}${p.boundAccounts !== undefined ? ` · ${t("team.proxyOccupied", { n: p.boundAccounts + (p.reservedAccounts ?? 0) })}` : ""}`,
      });
    }
    return opts;
  }, [proxies, t]);

  const accountsPath = isAdmin ? "/console/admin/accounts" : "/console/accounts";

  return (
    <div>
      <PageHeader title={t("onboard.title")} desc={t("onboard.desc")} />
      {scope === "admin" && <AccountTabs />}
      <div className="max-w-3xl space-y-6">
        {/* terminal states */}
        {job?.status === "done" && (
          <Card bodyClassName="p-5">
            <div className="flex items-start gap-3">
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
                style={job.reused ? { background: "var(--warning-container)", color: "var(--warning)" } : { background: "var(--success-container)", color: "var(--success)" }}
              >
                <CheckIcon width={18} height={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className={`font-semibold ${job.reused ? "text-warning" : "text-success"}`}>{job.reused ? t("onboard.reusedTitle") : t("onboard.done")}</div>
                <p className="mt-1 text-[13px] text-on-surface-variant">
                  {job.reused ? t("onboard.reusedHint") : isAdmin ? t("onboard.doneHintAdmin") : t("onboard.doneHintProvider")}
                  {(job.accountEmail || job.accountName) && <span className="ml-1 font-mono text-[12px]">{job.accountEmail ?? job.accountName}</span>}
                </p>
                {job.cooldownUntil && (
                  <p className="mt-1 text-[13px] text-on-surface-variant">{t("onboard.cooldownHint", { time: new Date(job.cooldownUntil).toLocaleTimeString() })}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link to={accountsPath} className="wk-btn wk-btn-sm wk-btn-primary">
                    {t("onboard.viewAccounts")}
                    <ArrowRightIcon width={14} height={14} />
                  </Link>
                  <Button onClick={reset}>{t("onboard.again")}</Button>
                </div>
              </div>
            </div>
          </Card>
        )}
        {job?.status === "failed" && (
          <Card bodyClassName="p-5">
            <div className="font-semibold text-error">{t("onboard.failed")}</div>
            <p className="mt-1 break-all font-mono text-[12.5px] text-error">{job.error || "—"}</p>
            <div className="mt-3">
              <Button onClick={reset}>
                <RefreshIcon width={14} height={14} />
                {t("onboard.again")}
              </Button>
            </div>
          </Card>
        )}
        {job?.status === "working" && (
          <Card bodyClassName="p-5">
            <div className="flex items-center gap-3">
              <Spinner size={20} />
              <div>
                <div className="font-semibold">{t("onboard.working")}</div>
                <p className="mt-0.5 text-[13px] text-on-surface-faint">{t("onboard.workingHint")}</p>
              </div>
            </div>
          </Card>
        )}

        {/* auth_url step 2: the job waits for the callback URL */}
        {job?.status === "pending_callback" && job.authorizeUrl && (
          <Card title={t("onboard.authorizeTitle")} bodyClassName="space-y-4 p-5">
            <p
              className="rounded-md p-3 text-[13px] font-medium leading-relaxed"
              style={{ background: "var(--warning-container)", color: "var(--warning)" }}
            >
              {t("onboard.authorizeHint")}
            </p>
            <div
              className="flex items-start gap-2 rounded-md p-3"
              style={{ background: "var(--code-bg)", color: "var(--code-fg)", border: "1px solid var(--outline-variant)" }}
            >
              <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] leading-relaxed">{job.authorizeUrl}</code>
              <div className="flex shrink-0 flex-col gap-1.5">
                <CopyButton text={job.authorizeUrl} variant="primary" />
                <a className="wk-btn wk-btn-sm wk-btn-ghost" href={job.authorizeUrl} target="_blank" rel="noreferrer">
                  {t("onboard.openLink")}
                </a>
              </div>
            </div>
            <Field label={t("onboard.callbackUrl")} hint={t("onboard.callbackHint")}>
              <Textarea
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                rows={3}
                placeholder="https://platform.claude.com/oauth/code/callback?code=…&state=…"
              />
            </Field>
            {err && <p className="text-[13px] text-error">{err}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={reset} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" loading={busy} disabled={!callbackUrl.trim()} onClick={() => void submitCallback()}>
                {t("onboard.submitCallback")}
              </Button>
            </div>
          </Card>
        )}

        {/* form (hidden once a job is in flight) */}
        {!job && (
          <Async state={nodes} rows={4}>
            {() => (
              <>
                <Card title={t("onboard.method")} bodyClassName="space-y-4 p-5">
                  <Segmented<Method>
                    value={method}
                    onChange={setMethod}
                    options={[
                      { value: "session_key", label: t("onboard.methodSessionKey") },
                      { value: "auth_url", label: t("onboard.methodAuthUrl") },
                    ]}
                  />
                  {method === "session_key" ? (
                    <>
                      <Field label="sessionKey" hint={t("onboard.sessionKeyHint")}>
                        <Textarea
                          value={sessionKey}
                          onChange={(e) => setSessionKey(e.target.value)}
                          rows={3}
                          autoComplete="off"
                          placeholder="sk-ant-sid01-…"
                        />
                      </Field>
                      {canSeeTeam && <Field label={`${t("team.name")} (${t("common.optional")})`} hint={t("team.verifiedHint")}>
                        <Input value={teamName} maxLength={120} onChange={(e) => setTeamName(e.target.value)} />
                      </Field>}
                      {canSeeTeam && <Field label={`${t("onboard.orgUuid")} (${t("common.optional")})`} hint={t("onboard.orgUuidHint")}>
                        <Input
                          value={orgUuid}
                          maxLength={64}
                          autoComplete="off"
                          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                          onChange={(e) => setOrgUuid(e.target.value)}
                        />
                      </Field>}
                    </>
                  ) : (
                    <p className="text-[13px] leading-relaxed text-on-surface-variant">{t("onboard.authUrlIntro")}</p>
                  )}
                </Card>

                <Card title={t("onboard.params")} bodyClassName="space-y-4 p-5">
                  {onlineNodes.length === 0 && (
                    <p
                      className="rounded-md p-3 text-[13px]"
                      style={{ background: "var(--warning-container)", color: "var(--warning)" }}
                    >
                      {t("onboard.nodeEmpty")}
                    </p>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("onboard.node")} hint={t("onboard.nodeHint")} className="sm:col-span-2">
                      <Select value={nodeId} onChange={(e) => setNodeId(e.target.value)} options={nodeOptions} />
                    </Field>
                    <Field
                      label={t("onboard.proxy")}
                      hint={proxiesErr ?? t("onboard.proxyHint")}
                      className="sm:col-span-2"
                    >
                      <Select
                        value={proxyId}
                        onChange={(e) => setProxyId(e.target.value)}
                        options={proxyOptions}
                        disabled={!nodeId}
                      />
                    </Field>
                    <Field label={t("onboard.concurrency")} hint={t("onboard.concurrencyHint")}>
                      <Input type="number" min={0} value={concurrency} placeholder={t("onboard.platformDefault")} onChange={(e) => setConcurrency(e.target.value)} />
                    </Field>
                    <Field label={t("onboard.rpm")} hint={t("onboard.rpmHint")}>
                      <Input type="number" min={0} value={rpm} placeholder={t("onboard.platformDefault")} onChange={(e) => setRpm(e.target.value)} />
                    </Field>
                    <Field label={`${t("common.name")} (${t("common.optional")})`}>
                      <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                    </Field>
                    {isAdmin && (
                      <Field label={t("common.group")}>
                        <Select
                          value={groupId}
                          onChange={(e) => setGroupId(e.target.value)}
                          options={[
                            { value: "", label: t("onboard.groupDefault") },
                            ...(groups.data ?? []).map((g) => ({ value: g.id, label: g.name })),
                          ]}
                        />
                      </Field>
                    )}
                    <Field label={`${t("onboard.note")} (${t("common.optional")})`} className="sm:col-span-2">
                      <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
                    </Field>
                  </div>
                  {err && <p className="text-[13px] text-error">{err}</p>}
                  <div className="flex items-center justify-between gap-3">
                    <Badge tone="info">Claude</Badge>
                    <Button
                      variant="primary"
                      loading={busy}
                      disabled={!nodeId || (method === "session_key" && !sessionKey.trim())}
                      onClick={() => void submit()}
                    >
                      <PlugIcon width={15} height={15} />
                      {method === "session_key" ? t("onboard.submit") : t("onboard.generateLink")}
                    </Button>
                  </div>
                </Card>
              </>
            )}
          </Async>
        )}
      </div>
    </div>
  );
}
