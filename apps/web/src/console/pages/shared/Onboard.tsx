import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../../lib/auth";
import { ArrowRightIcon, CheckIcon, PlugIcon, RefreshIcon } from "../../../components/Icon";
import {
  api,
  nodeProxies,
  onboardJob,
  onboardCancel,
  onboardOrgCreate,
  onboardOrgDelete,
  onboardOrgUpdate,
  onboardOrgs,
  onboardPrecheck,
  onboardStart,
  onboardSupplyProxy,
  type Group,
  type NodeRow,
  type OnboardJob,
  type OnboardOrg,
  type OnboardScope,
  type OnboardSuppliedProxy,
  type ProxyPickerItem,
} from "../../api";
import { useCT } from "../../i18n";
import { AccountTabs } from "../admin/Accounts";
import {
  Async,
  Badge,
  Button,
  Card,
  ConfirmButton,
  CopyButton,
  Field,
  Input,
  KV,
  Modal,
  PageHeader,
  Segmented,
  Select,
  Spinner,
  Textarea,
  errMessage,
  useAsync,
  useToast,
  type Tone,
} from "../../ui";

// Account onboarding ("上号") for both consoles (docs/onboarding.md §2/§4/§7).
// Same page for admins (platform pool, optional group) and providers (own
// nodes only, review_status=pending); only the API prefix and the group
// picker differ. Claude subscriptions only — other platforms are hidden
// site-wide for now.
//
// Admins additionally get (§3 常用组织 / §7):
//  - a saved-organization picker (record name + organization UUID once; pick,
//    edit or delete it later instead of pasting the UUID every time);
//  - a batch mode for the sessionKey method: paste many keys, one organization,
//    each line is format-checked and de-duplicated client-side, then the keys
//    are submitted one by one with a random 5–7 s pause (configurable).

type Method = "session_key" | "auth_url";
type ProxyMode = "auto" | "pool" | "own";

const POLL_MS = 1500;

/** Same shape the server enforces (routes/onboarding.ts): sk-ant-sid01-<base64url>. */
const SESSION_KEY_RE = /^sk-ant-sid\d{2}-[A-Za-z0-9_-]{40,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_MANUAL = "manual";
/** Proxy picker value for an operator-supplied address (docs/onboarding.md §4.1). */
const PROXY_OWN = "own";
/** How long the form waits for the node to verify a freshly added proxy. */
const OWN_PROXY_WAIT_MS = 90_000;

/** Operator-facing hint for a failed job's error text (docs/onboarding.md §7). */
function errorHintKey(err: string | null | undefined): string | null {
  if (!err) return null;
  if (/session_key_format/.test(err)) return "onboard.hint.format";
  if (/session_key_invalid/.test(err)) return /HTTP 403/.test(err) ? "onboard.hint.sk403" : "onboard.hint.skInvalid";
  if (/session_stale_relogin/.test(err)) return "onboard.hint.stale";
  if (/cloudflare_challenge/.test(err)) return "onboard.hint.cloudflare";
  if (/account_exists/.test(err)) return "onboard.hint.exists";
  if (/team_mismatch|organization_mismatch|team_identity_invalid/.test(err)) return "onboard.hint.teamMismatch";
  if (/node_offline|no_proxy_available/.test(err) && !/proxy_pool_empty/.test(err)) return "onboard.hint.nodeOffline";
  if (/authorize_failed: authorize: HTTP 404|not a member of organization/.test(err)) return "onboard.hint.orgNotFound";
  if (/proxy_pool_empty|No compatible verified proxy/.test(err)) return "onboard.hint.noProxy";
  if (/proxy_unassignable|proxy_full|proxy_not_found/.test(err)) return "onboard.hint.proxyPick";
  if (/job_expired|callback_expired/.test(err)) return "onboard.hint.expired";
  return null;
}

function maskKey(sk: string): string {
  return sk.length > 24 ? `${sk.slice(0, 13)}…${sk.slice(-6)}` : sk;
}

interface ParsedLine {
  line: number;
  key: string;
  kind: "valid" | "invalid" | "dup";
}

/** Split pasted text into candidate keys; mark malformed lines and repeats. */
function parseBatch(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    for (const piece of raw.split(/[\s,;]+/)) {
      const key = piece.trim().replace(/^["']+|["']+$/g, "");
      if (!key) continue;
      let kind: ParsedLine["kind"] = SESSION_KEY_RE.test(key) ? "valid" : "invalid";
      if (kind === "valid" && seen.has(key)) kind = "dup";
      if (kind === "valid") seen.add(key);
      out.push({ line: i + 1, key, kind });
    }
  });
  return out;
}

type BatchStatus = "queued" | "working" | "done" | "failed" | "skipped";
interface BatchItem {
  idx: number;
  key: string;
  status: BatchStatus;
  job?: OnboardJob;
  error?: string;
}
interface BatchState {
  items: BatchItem[];
  running: boolean;
  stopped: boolean;
  finished: boolean;
  /** Epoch ms when the next key will be submitted (countdown display). */
  nextAt: number | null;
}

/** Numbered step card: the form reads top to bottom as ① credential → ② egress → ③ ownership. */
function StepCard({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2.5">
          <span className="grid h-6 w-6 place-items-center rounded-full text-[12px] font-semibold" style={{ background: "var(--primary-container)", color: "var(--primary)" }}>
            {n}
          </span>
          {title}
        </span>
      }
      bodyClassName="space-y-4 p-5"
    >
      {children}
    </Card>
  );
}

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
  const recentJobs = useAsync(() => api.get<OnboardJob[]>(`/api/${scope}/accounts/onboard`), [scope]);
  const orgs = useAsync(() => (canSeeTeam ? onboardOrgs() : Promise.resolve([] as OnboardOrg[])), [canSeeTeam]);

  const [method, setMethod] = useState<Method>("session_key");
  const [sessionKey, setSessionKey] = useState("");
  const [intervalMin, setIntervalMin] = useState("5");
  const [intervalMax, setIntervalMax] = useState("7");
  // Organization: "" = not specified, ORG_MANUAL = type it in, otherwise a saved org id.
  const [orgChoice, setOrgChoice] = useState("");
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
  // Operator-supplied proxy (§4.1): the address, its live preview and the probe countdown.
  const [ownProxy, setOwnProxy] = useState("");
  const [ownPreview, setOwnPreview] = useState<OnboardSuppliedProxy | null>(null);
  const [ownPreviewErr, setOwnPreviewErr] = useState<string | null>(null);
  const [ownProbeSec, setOwnProbeSec] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<OnboardJob | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Saved-organization manager (modal).
  const [orgModal, setOrgModal] = useState(false);
  const [orgForm, setOrgForm] = useState<{ id?: string; name: string; orgUuid: string; note: string } | null>(null);
  const [orgErr, setOrgErr] = useState<string | null>(null);
  const [orgBusy, setOrgBusy] = useState(false);

  // Batch run.
  const [batch, setBatch] = useState<BatchState | null>(null);
  const stopRef = useRef(false);
  const [, setTick] = useState(0);

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
    setProxyId((p) => (p === PROXY_OWN ? p : "auto")); // a supplied address survives a node switch
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

  // Batch: poll every in-flight job and tick the countdown.
  const batchWorking = (batch?.items ?? []).filter((it) => it.status === "working").map((it) => it.job?.jobId).join(",");
  useEffect(() => {
    if (!batch || (!batchWorking && !batch.running)) return;
    const id = setInterval(() => {
      setTick((n) => n + 1);
      const ids = batchWorking ? batchWorking.split(",") : [];
      for (const jobId of ids) {
        onboardJob(scope, jobId)
          .then((j) => {
            if (j.status === "working") return;
            setBatch((b) =>
              b
                ? {
                    ...b,
                    items: b.items.map((it) =>
                      it.job?.jobId === jobId
                        ? { ...it, job: j, status: j.status === "done" ? "done" : "failed", error: j.error }
                        : it,
                    ),
                  }
                : b,
            );
          })
          .catch(() => {});
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [scope, batch?.running, batchWorking]);

  // ---------- organization ----------

  const selectedOrg = useMemo(
    () => (orgChoice && orgChoice !== ORG_MANUAL ? (orgs.data ?? []).find((o) => o.id === orgChoice) ?? null : null),
    [orgChoice, orgs.data],
  );

  const effOrgUuid = canSeeTeam ? (selectedOrg ? selectedOrg.orgUuid : orgChoice === ORG_MANUAL ? orgUuid.trim() : "") : "";
  const effTeamName = canSeeTeam ? (selectedOrg ? selectedOrg.name : orgChoice === ORG_MANUAL ? teamName.trim() : "") : "";
  const orgUuidBad = orgChoice === ORG_MANUAL && !!orgUuid.trim() && !UUID_RE.test(orgUuid.trim());

  const orgOptions = useMemo(
    () => [
      { value: "", label: t("onboard.orgNone") },
      ...(orgs.data ?? []).map((o) => ({ value: o.id, label: `${o.name} · ${o.orgUuid.slice(0, 8)}…` })),
      { value: ORG_MANUAL, label: t("onboard.orgManual") },
    ],
    [orgs.data, t],
  );

  function openOrgForm(o?: OnboardOrg, prefill?: { name: string; orgUuid: string }) {
    setOrgErr(null);
    setOrgForm(
      o
        ? { id: o.id, name: o.name, orgUuid: o.orgUuid, note: o.note ?? "" }
        : { name: prefill?.name ?? "", orgUuid: prefill?.orgUuid ?? "", note: "" },
    );
    setOrgModal(true);
  }

  async function saveOrg() {
    if (!orgForm) return;
    const nm = orgForm.name.trim();
    const uu = orgForm.orgUuid.trim();
    if (!nm) {
      setOrgErr(t("common.name"));
      return;
    }
    if (!UUID_RE.test(uu)) {
      setOrgErr(t("onboard.errOrgUuidFormat"));
      return;
    }
    setOrgBusy(true);
    setOrgErr(null);
    try {
      const saved = orgForm.id
        ? await onboardOrgUpdate(orgForm.id, { name: nm, orgUuid: uu, note: orgForm.note.trim() || null })
        : await onboardOrgCreate({ name: nm, orgUuid: uu, ...(orgForm.note.trim() ? { note: orgForm.note.trim() } : {}) });
      toast.success(t("onboard.orgSaved"));
      setOrgForm(null);
      await orgs.reload();
      setOrgChoice(saved.id);
    } catch (e) {
      setOrgErr(errMessage(e));
    } finally {
      setOrgBusy(false);
    }
  }

  async function deleteOrg(id: string) {
    await onboardOrgDelete(id);
    toast.success(t("onboard.orgDeleted"));
    if (orgChoice === id) setOrgChoice("");
    await orgs.reload();
  }

  // ---------- single job ----------

  function reset() {
    setJob(null);
    setErr(null);
    setSessionKey("");
    setCallbackUrl("");
  }

  // Live preview of a supplied address (dry run: parse + pool lookup, nothing written).
  useEffect(() => {
    setOwnPreview(null);
    setOwnPreviewErr(null);
    const raw = ownProxy.trim();
    if (proxyId !== PROXY_OWN || !raw || !nodeId) return;
    let alive = true;
    const timer = setTimeout(() => {
      onboardSupplyProxy(scope, { nodeId, proxy: raw, dryRun: true, ...(effOrgUuid ? { orgUuid: effOrgUuid } : {}) })
        .then((r) => alive && setOwnPreview(r))
        .catch((e) => alive && setOwnPreviewErr(errMessage(e)));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scope, nodeId, proxyId, ownProxy, effOrgUuid]);

  const ownProxyHint = (() => {
    if (ownProbeSec !== null) return t("onboard.proxyOwnProbing", { s: ownProbeSec });
    if (ownPreviewErr) return ownPreviewErr;
    if (!ownProxy.trim()) return t("onboard.proxyOwnHint");
    if (!ownPreview) return t("onboard.proxyOwnHint");
    const parsed = t("onboard.proxyOwnParsed", { url: ownPreview.parsed.display });
    if (!ownPreview.existed) return `${parsed} · ${t("onboard.proxyOwnNew")}`;
    const known = t("onboard.proxyOwnKnown", { node: ownPreview.nodeId ?? "?", status: t(`status.${ownPreview.status ?? "unknown"}`), n: ownPreview.boundAccounts + ownPreview.reservedAccounts });
    if (ownPreview.reset) return `${parsed} · ${known} · ${t("onboard.proxyOwnReset")}`;
    const blocked = ownPreview.blocked && ownPreview.blocked !== "unprobed" && ownPreview.blocked !== "exit_unverified"
      ? ` · ${t(`onboard.proxyBlocked.${ownPreview.blocked}`, { err: ownPreview.lastError ?? ownPreview.quarantineReason ?? "-" })}` : "";
    return `${parsed} · ${known}${blocked}`;
  })();

  /**
   * Turn the supplied address into a pool proxy id: register (or reuse) it, follow the
   * pool's node when the proxy already lives elsewhere, then wait for the node to verify
   * it. Throws a user-facing message when it cannot be assigned.
   */
  async function resolveOwnProxy(): Promise<{ nodeId: string; proxyId: string }> {
    const raw = ownProxy.trim();
    if (!raw) throw new Error(t("onboard.proxyOwnEmpty"));
    const org = effOrgUuid ? { orgUuid: effOrgUuid } : {};
    let useNode = nodeId;
    let cur = await onboardSupplyProxy(scope, { nodeId: useNode, proxy: raw, ...org });
    if (cur.nodeId && cur.nodeId !== useNode) {
      useNode = cur.nodeId;
      setNodeId(useNode);
      toast.success(t("onboard.proxyOwnSwitched", { node: useNode }));
    }
    const started = Date.now();
    try {
      while (cur.blocked === "unprobed" || cur.blocked === "exit_unverified") {
        const elapsed = Math.round((Date.now() - started) / 1000);
        if (Date.now() - started > OWN_PROXY_WAIT_MS) {
          throw new Error(t("onboard.proxyOwnTimeout", { s: Math.round(OWN_PROXY_WAIT_MS / 1000), err: cur.lastError ?? "-" }));
        }
        setOwnProbeSec(elapsed);
        await sleep(3000);
        cur = await onboardSupplyProxy(scope, { nodeId: useNode, proxy: raw, ...org });
      }
    } finally {
      setOwnProbeSec(null);
    }
    setOwnPreview(cur);
    if (cur.blocked || !cur.proxyId) {
      throw new Error(t(`onboard.proxyBlocked.${cur.blocked ?? "not_in_pool"}`, { err: cur.lastError ?? cur.quarantineReason ?? "-" }));
    }
    return { nodeId: useNode, proxyId: cur.proxyId };
  }

  function commonParams(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      nodeId,
      proxyId: proxyId === "auto" || proxyId === PROXY_OWN ? "auto" : proxyId,
      concurrencyLimit: Number(concurrency) || 0,
      rpmLimit: Number(rpm) || 0,
    };
    if (name.trim()) body.name = name.trim();
    if (note.trim()) body.note = note.trim();
    if (isAdmin && groupId) body.groupId = groupId;
    if (effTeamName) body.teamName = effTeamName;
    if (effOrgUuid) body.orgUuid = effOrgUuid;
    return body;
  }

  // One textarea for one or many keys: a single line is onboarded directly, two or more
  // lines run as a batch (format check + de-duplication client-side, docs/onboarding.md §7).
  const parsed = useMemo(() => parseBatch(sessionKey), [sessionKey]);
  const isBatch = method === "session_key" && parsed.length >= 2;
  const singleKey = parsed.length === 1 && parsed[0].kind === "valid" ? parsed[0].key : "";
  const singleKeyBad = parsed.length === 1 && parsed[0].kind !== "valid";

  // Duplicate detection before submitting (precheck reads the account uuid embedded in the
  // key; no upstream call): a key already in the pool would only burn a reservation.
  const [singleExisting, setSingleExisting] = useState<{ email: string | null; status: string } | null>(null);
  useEffect(() => {
    setSingleExisting(null);
    if (!singleKey || singleKeyBad) return;
    let alive = true;
    const timer = setTimeout(() => {
      onboardPrecheck(scope, [singleKey])
        .then((r) => alive && setSingleExisting(r[0]?.existing ? { email: r[0].existing.email, status: r[0].existing.status } : null))
        .catch(() => {});
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scope, singleKey, singleKeyBad]);

  async function cancel() {
    if (!job) return;
    setBusy(true);
    try {
      const cancelled = await onboardCancel(scope, job.jobId);
      if (cancelled.status === "done") setJob(cancelled);
      else reset();
    } catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!nodeId) {
      setErr(t("onboard.errNode"));
      return;
    }
    if (orgUuidBad) {
      setErr(t("onboard.errOrgUuidFormat"));
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      if (method === "session_key") {
        if (!singleKey) {
          setErr(t("onboard.errSessionKey"));
          return;
        }
        if (singleKeyBad) {
          setErr(t("onboard.errSessionKeyFormat"));
          return;
        }
        const own = proxyId === PROXY_OWN ? await resolveOwnProxy() : {};
        setJob(await onboardStart(scope, { method, sessionKey: singleKey, ...commonParams(), ...own }));
      } else {
        // Step 1: platform generates the authorize URL; user completes consent
        // in their own browser, then pastes the callback URL back (step 2).
        const own = proxyId === PROXY_OWN ? await resolveOwnProxy() : {};
        const j = await onboardStart(scope, { method, ...commonParams(), ...own });
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

  // ---------- batch ----------

  const parsedValid = parsed.filter((p) => p.kind === "valid");
  const parsedInvalid = parsed.filter((p) => p.kind === "invalid").length;
  const parsedDup = parsed.filter((p) => p.kind === "dup").length;
  const intervalBad = (() => {
    const a = Number(intervalMin);
    const b = Number(intervalMax);
    return !(Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a && b <= 600);
  })();

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  async function startBatch() {
    if (!nodeId) {
      setErr(t("onboard.errNode"));
      return;
    }
    if (orgUuidBad) {
      setErr(t("onboard.errOrgUuidFormat"));
      return;
    }
    if (!parsedValid.length || intervalBad) return;
    setErr(null);
    const params = commonParams();
    if (proxyId === PROXY_OWN) {
      // One supplied proxy for the whole batch: the exit's own limit (3) ends it after three.
      try {
        Object.assign(params, await resolveOwnProxy());
      } catch (e) {
        setErr(errMessage(e));
        return;
      }
    }
    const lo = Math.max(0, Number(intervalMin)) * 1000;
    const hi = Math.max(lo, Number(intervalMax) * 1000);
    const items: BatchItem[] = parsedValid.map((p, i) => ({ idx: i + 1, key: p.key, status: "queued" }));
    // Pre-flight: keys whose account is already in the pool are skipped, not submitted.
    try {
      const pre = await onboardPrecheck(scope, items.map((it) => it.key));
      for (const r of pre) {
        const it = items[r.index];
        if (it && r.existing) {
          it.status = "skipped";
          it.error = t("onboard.batchExists", { email: r.existing.email ?? r.existing.id.slice(0, 8) });
        }
      }
    } catch {
      toast.error(t("onboard.precheckFailed"));
    }
    stopRef.current = false;
    setBatch({ items, running: true, stopped: false, finished: false, nextAt: null });
    for (let i = 0; i < items.length; i++) {
      if (items[i].status === "skipped") continue;
      if (stopRef.current) {
        setBatch((b) =>
          b ? { ...b, items: b.items.map((it) => (it.status === "queued" ? { ...it, status: "skipped" } : it)), stopped: true } : b,
        );
        break;
      }
      const it = items[i];
      try {
        const j = await onboardStart(scope, { method: "session_key", sessionKey: it.key, ...params });
        setBatch((b) =>
          b
            ? {
                ...b,
                items: b.items.map((x) =>
                  x.idx === it.idx ? { ...x, job: j, status: j.status === "working" ? "working" : j.status === "done" ? "done" : "failed", error: j.error } : x,
                ),
              }
            : b,
        );
      } catch (e) {
        const msg = errMessage(e);
        setBatch((b) => (b ? { ...b, items: b.items.map((x) => (x.idx === it.idx ? { ...x, status: "failed", error: msg } : x)) } : b));
      }
      if (i < items.length - 1 && !stopRef.current) {
        const wait = lo + Math.random() * (hi - lo);
        setBatch((b) => (b ? { ...b, nextAt: Date.now() + wait } : b));
        await sleep(wait);
        setBatch((b) => (b ? { ...b, nextAt: null } : b));
      }
    }
    setBatch((b) => (b ? { ...b, running: false, nextAt: null } : b));
  }

  const batchCounts = useMemo(() => {
    const c = { done: 0, failed: 0, working: 0, queued: 0, skipped: 0 };
    for (const it of batch?.items ?? []) c[it.status] += 1;
    return c;
  }, [batch?.items]);
  const batchFinished = !!batch && !batch.running && batchCounts.working === 0;
  const batchNextIn = batch?.nextAt ? Math.max(0, Math.ceil((batch.nextAt - Date.now()) / 1000)) : null;

  // Proxy choice as three modes: automatic, a pool pick, or an operator-supplied address.
  const proxyMode: ProxyMode = proxyId === "auto" ? "auto" : proxyId === PROXY_OWN ? "own" : "pool";
  const poolOptions = useMemo(
    () =>
      (proxies ?? []).map((p) => {
        const host = p.host ? `${p.host}${p.port ? `:${p.port}` : ""}` : p.id.slice(0, 12);
        return {
          value: p.id,
          label: `${p.country ? `${p.country} · ` : ""}${p.label ? `${p.label} · ` : ""}${host} · ${t("team.proxyOccupied", { n: (p.boundAccounts ?? 0) + (p.reservedAccounts ?? 0) })}`,
        };
      }),
    [proxies, t],
  );
  function setProxyMode(m: ProxyMode) {
    if (m === "auto") setProxyId("auto");
    else if (m === "own") setProxyId(PROXY_OWN);
    else setProxyId(poolOptions[0]?.value ?? "");
  }
  const selectedNodeLabel = nodeOptions.find((o) => o.value === nodeId)?.label ?? "—";
  const pendingJobs = (recentJobs.data ?? []).filter((j) => j.status === "pending_callback" || j.status === "working");

  const accountsPath = isAdmin ? "/console/admin/accounts" : "/console/accounts";

  const batchTone = (s: BatchStatus): Tone => (s === "done" ? "success" : s === "failed" ? "error" : s === "working" ? "info" : "neutral");
  const batchLabel = (s: BatchStatus) =>
    s === "done" ? t("onboard.done") : s === "failed" ? t("onboard.failed") : s === "working" ? t("onboard.working") : s === "skipped" ? t("onboard.batchSkipped") : t("onboard.batchQueued");

  const orgField = canSeeTeam && (
    <div className="space-y-3">
      <Field label={`${t("onboard.org")} (${t("common.optional")})`} hint={selectedOrg ? undefined : t("onboard.orgUuidPick")}>
        <div className="flex items-start gap-2">
          <Select className="min-w-0 flex-1" value={orgChoice} onChange={(e) => setOrgChoice(e.target.value)} options={orgOptions} />
          <Button size="md" onClick={() => { setOrgForm(null); setOrgModal(true); }}>
            {t("onboard.orgManage")}
          </Button>
        </div>
      </Field>
      {selectedOrg && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-on-surface-variant">
          <span className="font-mono">{selectedOrg.orgUuid}</span>
          <CopyButton text={selectedOrg.orgUuid} />
          <Button onClick={() => openOrgForm(selectedOrg)}>{t("common.edit")}</Button>
        </div>
      )}
      {orgChoice === ORG_MANUAL && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("onboard.orgUuid")} hint={t("onboard.orgUuidHint")} error={orgUuidBad ? t("onboard.errOrgUuidFormat") : undefined}>
            <Input
              value={orgUuid}
              maxLength={64}
              autoComplete="off"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              onChange={(e) => setOrgUuid(e.target.value)}
            />
          </Field>
          <Field label={`${t("team.name")} (${t("common.optional")})`} hint={t("team.verifiedHint")}>
            <Input value={teamName} maxLength={120} onChange={(e) => setTeamName(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button disabled={!orgUuid.trim() || orgUuidBad} onClick={() => openOrgForm(undefined, { name: teamName.trim(), orgUuid: orgUuid.trim() })}>
              {t("onboard.orgSave")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  // Per-key feedback under the textarea (one key: shape + duplicate; many: batch tallies).
  const keyFeedback = (() => {
    if (method !== "session_key" || parsed.length === 0) return <span className="text-on-surface-faint">{t("onboard.sessionKeyHint")}</span>;
    if (parsed.length === 1) {
      if (singleKeyBad) return <span className="text-error">{t("onboard.errSessionKeyFormat")}</span>;
      if (singleExisting) return <span className="text-warning">{t("onboard.preExists", { email: singleExisting.email ?? "?", status: singleExisting.status })}</span>;
      return <span className="text-success">{t("onboard.keyOk")}</span>;
    }
    const bad = parsed.filter((p) => p.kind !== "valid");
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={parsedValid.length ? "success" : "neutral"}>{t("onboard.batchSummary", { valid: parsedValid.length, invalid: parsedInvalid, dup: parsedDup })}</Badge>
          <span className="text-on-surface-faint">{t("onboard.keysBatchNote", { n: parsedValid.length, min: intervalMin, max: intervalMax })}</span>
        </div>
        {bad.length > 0 && (
          <ul className="space-y-0.5">
            {bad.map((p, i) => (
              <li key={i} className={p.kind === "invalid" ? "text-error" : "text-on-surface-variant"}>
                {t("onboard.batchLine", { n: p.line })} · {p.kind === "invalid" ? t("onboard.invalidLine") : t("onboard.duplicateLine")} · <span className="font-mono">{maskKey(p.key)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  })();

  const ownTone: Tone = ownProbeSec !== null ? "info" : ownPreviewErr ? "error" : !ownPreview ? "neutral" : ownPreview.reset ? "info" : ownPreview.blocked && ownPreview.blocked !== "not_in_pool" && ownPreview.blocked !== "unprobed" && ownPreview.blocked !== "exit_unverified" ? "error" : ownPreview.existed ? "success" : "info";

  const canSubmit =
    !!nodeId &&
    !orgUuidBad &&
    (method === "auth_url" || (isBatch ? parsedValid.length > 0 && !intervalBad : !!singleKey && !singleKeyBad)) &&
    (proxyMode !== "pool" || !!proxyId) &&
    (proxyMode !== "own" || !!ownProxy.trim());

  const summaryProxy =
    proxyMode === "auto" ? t("onboard.proxyAuto") : proxyMode === "own" ? (ownPreview?.parsed.display ?? ownProxy.trim() ?? "—") || "—" : (poolOptions.find((o) => o.value === proxyId)?.label ?? "—");
  const summaryKeys =
    method === "auth_url" ? t("onboard.methodAuthUrl") : parsed.length === 0 ? t("onboard.sumNoKey") : parsed.length === 1 ? maskKey(parsed[0].key) : t("onboard.sumKeysN", { n: parsedValid.length });

  return (
    <div>
      <PageHeader title={t("onboard.title")} desc={t("onboard.desc")} />
      {scope === "admin" && <AccountTabs />}
      <div className="max-w-5xl space-y-6">
        {/* batch progress */}
        {batch && (
          <Card title={t("onboard.batchTitle")} bodyClassName="space-y-3 p-5">
            <div className="flex flex-wrap items-center gap-3 text-[13px] text-on-surface-variant">
              {batch.running && <Spinner />}
              <span>
                {t("onboard.batchProgress", {
                  done: batchCounts.done,
                  failed: batchCounts.failed,
                  working: batchCounts.working,
                  queued: batchCounts.queued,
                })}
              </span>
              {batch.running && batchNextIn !== null && <Badge tone="info">{t("onboard.batchNext", { s: batchNextIn })}</Badge>}
              {batch.stopped && <Badge tone="warning">{t("onboard.batchStopped")}</Badge>}
              {batchFinished && !batch.stopped && <Badge tone="success">{t("onboard.batchFinished")}</Badge>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <tbody>
                  {batch.items.map((it) => (
                    <tr key={it.idx} className="border-t" style={{ borderColor: "var(--outline-variant)" }}>
                      <td className="py-1.5 pr-3 text-on-surface-faint">{it.idx}</td>
                      <td className="py-1.5 pr-3 font-mono text-[12.5px]">{maskKey(it.key)}</td>
                      <td className="py-1.5 pr-3">
                        <Badge tone={batchTone(it.status)}>{batchLabel(it.status)}</Badge>
                      </td>
                      <td className="min-w-0 break-all py-1.5 font-mono text-[12px]">
                        {it.status === "done" ? (
                          <span className="text-success">{it.job?.accountEmail ?? it.job?.accountName ?? it.job?.accountId ?? ""}{it.job?.reused ? ` · ${t("onboard.reusedTitle")}` : ""}</span>
                        ) : it.status === "failed" ? (
                          <>
                            <span className="text-error">{it.error ?? it.job?.error ?? "—"}</span>
                            {errorHintKey(it.error ?? it.job?.error) && (
                              <span className="mt-0.5 block font-sans text-[12px] text-on-surface-variant">{t(errorHintKey(it.error ?? it.job?.error)!)}</span>
                            )}
                          </>
                        ) : it.status === "skipped" && it.error ? (
                          <span className="text-on-surface-variant">{it.error}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              {batch.running && !batch.stopped && (
                <Button onClick={() => { stopRef.current = true; setBatch((b) => (b ? { ...b, stopped: true } : b)); }}>
                  {t("onboard.batchStop")}
                </Button>
              )}
              {batchFinished && (
                <>
                  <Link to={accountsPath} className="wk-btn wk-btn-sm wk-btn-primary">
                    {t("onboard.viewAccounts")}
                    <ArrowRightIcon width={14} height={14} />
                  </Link>
                  <Button onClick={() => { setBatch(null); setSessionKey(""); void recentJobs.reload(); }}>{t("onboard.batchNewBatch")}</Button>
                </>
              )}
            </div>
          </Card>
        )}

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
            {errorHintKey(job.error) && (
              <p className="mt-2 rounded-md p-3 text-[13px] leading-relaxed" style={{ background: "var(--surface-variant)" }}>
                <span className="font-medium">{t("onboard.hintTitle")}：</span>
                {t(errorHintKey(job.error)!)}
              </p>
            )}
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
              <Button onClick={() => void cancel()} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" loading={busy} disabled={!callbackUrl.trim()} onClick={() => void submitCallback()}>
                {t("onboard.submitCallback")}
              </Button>
            </div>
          </Card>
        )}

        {/* form (hidden once a job or a batch is in flight): three steps + a sticky summary */}
        {!job && !batch && (
          <Async state={nodes} rows={4}>
            {() => (
              <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
                <div className="min-w-0 space-y-5">
                  {pendingJobs.length > 0 && (
                    <Card title={t("onboard.resumeTitle")} bodyClassName="space-y-2 p-5">
                      {pendingJobs.map((j) => (
                        <div key={j.jobId} className="flex items-center justify-between gap-3">
                          <span className="truncate text-[13px]">
                            {j.accountName ?? j.jobId.slice(0, 12)} · {j.status === "working" ? t("onboard.working") : t("onboard.resumeWaiting")}
                          </span>
                          <Button size="sm" onClick={() => { setJob(j); setCallbackUrl(""); if (j.nodeId) setNodeId(j.nodeId); }}>{t("onboard.resume")}</Button>
                        </div>
                      ))}
                    </Card>
                  )}

                  {/* ① credential */}
                  <StepCard n={1} title={t("onboard.stepCredential")}>
                    <Segmented<Method>
                      value={method}
                      onChange={setMethod}
                      options={[
                        { value: "session_key", label: t("onboard.methodSessionKey") },
                        { value: "auth_url", label: t("onboard.methodAuthUrl") },
                      ]}
                    />
                    {method === "session_key" ? (
                      <div>
                        <Textarea
                          value={sessionKey}
                          onChange={(e) => setSessionKey(e.target.value)}
                          rows={isBatch ? 7 : 3}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={t("onboard.keysPlaceholder")}
                        />
                        <div className="mt-1.5 text-[12.5px] leading-relaxed">{keyFeedback}</div>
                      </div>
                    ) : (
                      <p className="text-[13px] leading-relaxed text-on-surface-variant">{t("onboard.authUrlIntro")}</p>
                    )}
                  </StepCard>

                  {/* ② egress */}
                  <StepCard n={2} title={t("onboard.stepEgress")}>
                    {onlineNodes.length === 0 && (
                      <p className="rounded-md p-3 text-[13px]" style={{ background: "var(--warning-container)", color: "var(--warning)" }}>
                        {t("onboard.nodeEmpty")}
                      </p>
                    )}
                    <Field label={t("onboard.node")} hint={t("onboard.nodeHint")}>
                      <Select value={nodeId} onChange={(e) => setNodeId(e.target.value)} options={nodeOptions} />
                    </Field>
                    <div>
                      <span className="label">{t("onboard.proxy")}</span>
                      <Segmented<ProxyMode>
                        value={proxyMode}
                        onChange={setProxyMode}
                        options={[
                          { value: "auto", label: t("onboard.proxyModeAuto") },
                          { value: "pool", label: t("onboard.proxyModePool", { n: proxies ? proxies.length : "…" }) },
                          { value: "own", label: t("onboard.proxyModeOwn") },
                        ]}
                      />
                      {proxyMode === "auto" && <p className="mt-2 text-[12.5px] leading-relaxed text-on-surface-faint">{proxiesErr ?? t("onboard.proxyHint")}</p>}
                      {proxyMode === "pool" && (
                        <div className="mt-3">
                          {poolOptions.length ? (
                            <Select value={proxyId} onChange={(e) => setProxyId(e.target.value)} options={poolOptions} />
                          ) : (
                            <p className="text-[12.5px] text-warning">{proxiesErr ?? t("onboard.proxyPoolEmpty")}</p>
                          )}
                          <p className="mt-1.5 text-[12.5px] leading-relaxed text-on-surface-faint">{t("onboard.proxyHint")}</p>
                        </div>
                      )}
                      {proxyMode === "own" && (
                        <div className="mt-3">
                          <Input
                            value={ownProxy}
                            maxLength={500}
                            placeholder="host:port:user:pass · user:pass@host:port · socks5://…"
                            spellCheck={false}
                            autoComplete="off"
                            onChange={(e) => setOwnProxy(e.target.value)}
                          />
                          <p className={`mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-relaxed ${ownTone === "error" ? "text-error" : ownTone === "success" ? "text-success" : "text-on-surface-faint"}`}>
                            {ownProbeSec !== null && <Spinner size={12} />}
                            <span>{ownProxyHint}</span>
                          </p>
                        </div>
                      )}
                    </div>
                  </StepCard>

                  {/* ③ ownership & limits */}
                  <StepCard n={3} title={t("onboard.stepOwner")}>
                    {orgField}
                    {isAdmin && (
                      <Field label={t("common.group")}>
                        <Select
                          value={groupId}
                          onChange={(e) => setGroupId(e.target.value)}
                          options={[{ value: "", label: t("onboard.groupDefault") }, ...(groups.data ?? []).map((g) => ({ value: g.id, label: g.name }))]}
                        />
                      </Field>
                    )}
                    <details className="rounded-md" style={{ border: "1px solid var(--outline-variant)" }}>
                      <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-medium text-on-surface-variant">
                        {t("onboard.advanced")} <span className="font-normal text-on-surface-faint">· {t("onboard.advancedHint")}</span>
                      </summary>
                      <div className="grid gap-4 px-4 pb-4 pt-1 sm:grid-cols-2">
                        <Field label={`${t("common.name")} (${t("common.optional")})`}>
                          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                        </Field>
                        <Field label={`${t("onboard.note")} (${t("common.optional")})`}>
                          <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
                        </Field>
                        <Field label={t("onboard.concurrency")} hint={t("onboard.concurrencyHint")}>
                          <Input type="number" min={0} value={concurrency} placeholder={t("onboard.platformDefault")} onChange={(e) => setConcurrency(e.target.value)} />
                        </Field>
                        <Field label={t("onboard.rpm")} hint={t("onboard.rpmHint")}>
                          <Input type="number" min={0} value={rpm} placeholder={t("onboard.platformDefault")} onChange={(e) => setRpm(e.target.value)} />
                        </Field>
                        <Field label={t("onboard.batchInterval")} hint={t("onboard.batchIntervalHint")} error={intervalBad ? "5 – 7" : undefined} className="sm:col-span-2">
                          <div className="flex items-center gap-2">
                            <Input type="number" min={0} max={600} className="w-24" value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} />
                            <span className="text-on-surface-faint">–</span>
                            <Input type="number" min={0} max={600} className="w-24" value={intervalMax} onChange={(e) => setIntervalMax(e.target.value)} />
                            <span className="text-[12.5px] text-on-surface-faint">s</span>
                          </div>
                        </Field>
                      </div>
                    </details>
                  </StepCard>
                </div>

                {/* summary + action */}
                <aside className="space-y-4 lg:sticky lg:top-6">
                  <Card title={t("onboard.summary")} bodyClassName="space-y-4 p-5">
                    <KV
                      items={[
                        [t("onboard.sumMethod"), method === "session_key" ? t("onboard.methodSessionKey") : t("onboard.methodAuthUrl")],
                        [t("onboard.sumKeys"), <span className="font-mono text-[12.5px]">{summaryKeys}</span>],
                        [t("onboard.sumNode"), selectedNodeLabel],
                        [t("onboard.sumProxy"), <span className="break-all">{summaryProxy}</span>],
                        ...(canSeeTeam ? [[t("onboard.sumOrg"), effTeamName || (effOrgUuid ? `${effOrgUuid.slice(0, 8)}…` : t("onboard.orgNone"))] as [string, string]] : []),
                        ...(isAdmin ? [[t("onboard.sumGroup"), (groups.data ?? []).find((g) => g.id === groupId)?.name ?? t("onboard.groupDefault")] as [string, string]] : []),
                      ]}
                    />
                    {err && <p className="text-[13px] text-error">{err}</p>}
                    <Button
                      variant="primary"
                      size="md"
                      className="w-full justify-center"
                      loading={busy}
                      disabled={!canSubmit}
                      onClick={() => void (isBatch ? startBatch() : submit())}
                    >
                      <PlugIcon width={15} height={15} />
                      {method === "auth_url" ? t("onboard.generateLink") : isBatch ? t("onboard.batchStart", { n: parsedValid.length }) : t("onboard.submit")}
                    </Button>
                    <p className="text-[12px] leading-relaxed text-on-surface-faint">{t("onboard.summaryHint")}</p>
                  </Card>
                </aside>
              </div>
            )}
          </Async>
        )}
      </div>

      {/* saved organizations manager */}
      {canSeeTeam && (
        <Modal
          open={orgModal}
          title={orgForm ? (orgForm.id ? t("onboard.orgEditTitle") : t("onboard.orgAdd")) : t("onboard.orgManage")}
          onClose={() => { setOrgModal(false); setOrgForm(null); setOrgErr(null); }}
          size="md"
          footer={
            orgForm ? (
              <div className="flex justify-end gap-2">
                <Button onClick={() => { setOrgForm(null); setOrgErr(null); }}>{t("common.cancel")}</Button>
                <Button variant="primary" loading={orgBusy} onClick={() => void saveOrg()}>{t("common.save")}</Button>
              </div>
            ) : (
              <div className="flex justify-between gap-2">
                <Button variant="primary" onClick={() => openOrgForm()}>{t("onboard.orgAdd")}</Button>
                <Button onClick={() => setOrgModal(false)}>{t("common.close")}</Button>
              </div>
            )
          }
        >
          {orgForm ? (
            <div className="space-y-4">
              <Field label={t("common.name")} hint={t("onboard.orgNameHint")}>
                <Input value={orgForm.name} maxLength={120} autoFocus onChange={(e) => setOrgForm({ ...orgForm, name: e.target.value })} />
              </Field>
              <Field
                label={t("onboard.orgUuid")}
                hint={t("onboard.orgUuidHint")}
                error={orgForm.orgUuid.trim() && !UUID_RE.test(orgForm.orgUuid.trim()) ? t("onboard.errOrgUuidFormat") : undefined}
              >
                <Input
                  value={orgForm.orgUuid}
                  maxLength={64}
                  autoComplete="off"
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  onChange={(e) => setOrgForm({ ...orgForm, orgUuid: e.target.value })}
                />
              </Field>
              <Field label={`${t("onboard.note")} (${t("common.optional")})`}>
                <Input value={orgForm.note} maxLength={500} onChange={(e) => setOrgForm({ ...orgForm, note: e.target.value })} />
              </Field>
              {orgErr && <p className="text-[13px] text-error">{orgErr}</p>}
            </div>
          ) : (orgs.data ?? []).length === 0 ? (
            <p className="text-[13px] text-on-surface-variant">{t("onboard.orgEmpty")}</p>
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--outline-variant)" }}>
              {(orgs.data ?? []).map((o) => (
                <li key={o.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium">{o.name}</div>
                    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[12px] text-on-surface-variant">
                      <span className="break-all">{o.orgUuid}</span>
                      <CopyButton text={o.orgUuid} />
                    </div>
                    {o.note && <div className="mt-0.5 text-[12.5px] text-on-surface-faint">{o.note}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button onClick={() => { setOrgChoice(o.id); setOrgModal(false); }}>{t("common.confirm")}</Button>
                    <Button onClick={() => openOrgForm(o)}>{t("common.edit")}</Button>
                    <ConfirmButton variant="danger" message={`${t("common.delete")} ${o.name}?`} onConfirm={() => deleteOrg(o.id)}>
                      {t("common.delete")}
                    </ConfirmButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </div>
  );
}
