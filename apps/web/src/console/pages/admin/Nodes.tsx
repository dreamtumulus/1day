import { useMemo, useState } from "react";
import { useAuth } from "../../../lib/auth";
import { api, nodeProxiesRegroup, nodeProxiesRemove, nodeProxyUnquarantine, type AdminUser, type DeployOutcome, type Group, type NodeProxy, type NodeRow, type Paged, type TeamEvent } from "../../api";
import { useCT } from "../../i18n";

/** Nodes · Node monitor share one sidebar entry; this strip links the two. */
export function NodeTabs() {
  const { t } = useCT();
  return (
    <PageTabs
      tabs={[
        { to: "/console/admin/nodes", label: t("nav.nodes") },
        { to: "/console/admin/node-monitor", label: t("nav.nodeMonitor") },
      ]}
    />
  );
}
import { TerminalIcon } from "../../../components/Icon";
import { NodeCard } from "../shared/NodeCard";
import { AccountFormModal } from "./_p2AccountForm";
import {
  Async,
  Button,
  Card,
  ConfirmButton,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Segmented,
  StatCard,
  StatusBadge,
  Textarea,
  fmtDateTime,
  fmtNum,
  useAsync,
  useRelTime,
  useToast,
  PageTabs,
} from "../../ui";

// Protocol v2 node management: list with capacity/proxy counts, SSH + local
// deploy, and per-node proxy pool replacement (docs/provider-protocol.md).

const PROXY_RE = /^(https?|socks5h?|socks):\/\/\S+$/;
/** Scheme-less lines (host:port, host:port:user:pass, user:pass@host:port) are socks5 by default — the server canonicalises them. */
const BARE_PROXY_RE = /^(\[[^\]]+\]|[^\s:@\/]+)(:\d{1,5})(:[^\s]+:[^\s]+)?$|^[^\s@]+@(\[[^\]]+\]|[^\s:@\/]+):\d{1,5}$|^[^\s:@\/]+:[^\s:@\/]+:(\[[^\]]+\]|[^\s:@\/]+):\d{1,5}$/;

interface ProxyLine {
  url: string;
  label?: string;
}

/** One per line: `<url>` or `<url> <label>`. Throws on the first bad line. */
function parseProxyLines(text: string): { proxies: ProxyLine[]; bad: string | null } {
  const out: ProxyLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.search(/\s/);
    const url = sp === -1 ? line : line.slice(0, sp);
    const label = sp === -1 ? undefined : line.slice(sp).trim() || undefined;
    if (!PROXY_RE.test(url) && !BARE_PROXY_RE.test(url)) return { proxies: out, bad: line };
    out.push(label ? { url, label } : { url });
  }
  return { proxies: out, bad: null };
}

export function AdminNodes() {
  const { t } = useCT();
  const toast = useToast();
  const list = useAsync(() => api.get<NodeRow[]>("/api/admin/nodes"), []);
  const [deployOpen, setDeployOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [poolNode, setPoolNode] = useState<NodeRow | null>(null);
  const [capNode, setCapNode] = useState<NodeRow | null>(null);
  const [accountNode, setAccountNode] = useState<NodeRow | null>(null);
  const nodes = list.data ?? [];
  const online = nodes.filter((n) => n.online);
  const sum = (f: (n: NodeRow) => number) => nodes.reduce((a, n) => a + f(n), 0);

  return (
    <>
      <PageHeader
        title={t("admin.nodes.title")}
        desc={t("admin.nodes.desc")}
        actions={
          <>
            <Button onClick={() => setLocalOpen(true)}>{t("admin.nodes.local")}</Button>
            <Button variant="primary" onClick={() => setDeployOpen(true)}>
              {t("admin.nodes.deploy")}
            </Button>
          </>
        }
      />
      <NodeTabs />
      <Async state={list} rows={5}>
        {(rows) =>
          rows.length === 0 ? (
            <Card>
              <EmptyState
                title={t("admin.nodes.empty")}
                action={
                  <Button variant="primary" onClick={() => setDeployOpen(true)}>
                    {t("admin.nodes.deploy")}
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                <StatCard
                  label={t("admin.nodes.sumOnline")}
                  value={`${online.length} / ${rows.length}`}
                  tone={online.length === rows.length ? "success" : online.length === 0 ? "error" : "warning"}
                  icon={<TerminalIcon className="h-4 w-4" />}
                />
                <StatCard label={t("admin.nodes.sumInFlight")} value={fmtNum(sum((n) => n.inFlight))} tone="info" />
                <StatCard
                  label={t("admin.nodes.sumAccounts")}
                  value={`${fmtNum(sum((n) => n.accountCount))} / ${fmtNum(sum((n) => n.capacity))}`}
                  tone={sum((n) => n.capacity) > 0 && sum((n) => n.accountCount) / sum((n) => n.capacity) >= 0.8 ? "warning" : "neutral"}
                />
                <StatCard
                  label={t("admin.nodes.sumProxies")}
                  value={fmtNum(sum((n) => n.proxyCount))}
                  tone={rows.some((n) => n.proxyCount === 0) ? "warning" : "neutral"}
                />
              </div>
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                {rows.map((n) => (
                  <NodeCard
                    key={n.nodeId}
                    node={n}
                    showProvider
                    actions={
                      <>
                        <Button size="sm" onClick={() => setCapNode(n)}>
                          {t("admin.nodes.capacityEdit")}
                        </Button>
                        <Button size="sm" onClick={() => setPoolNode(n)}>
                          {t("admin.nodes.proxies")} · {fmtNum(n.proxyCount)}
                        </Button>
                        <Button size="sm" variant="primary" onClick={() => setAccountNode(n)}>
                          {t("admin.nodes.addAccount")}
                        </Button>
                        <ConfirmButton
                          variant="danger"
                          message={t("admin.nodes.removeMsg")}
                          onConfirm={async () => {
                            await api.del(`/api/admin/nodes/${encodeURIComponent(n.nodeId)}`);
                            toast.success(t("admin.nodes.removed"));
                            list.reload();
                          }}
                        >
                          {t("admin.nodes.remove")}
                        </ConfirmButton>
                      </>
                    }
                  />
                ))}
              </div>
            </div>
          )
        }
      </Async>
      {deployOpen && (
        <DeployModal
          onClose={() => setDeployOpen(false)}
          onDeployed={() => list.reload()}
        />
      )}
      {localOpen && <LocalModal onClose={() => setLocalOpen(false)} onDeployed={() => list.reload()} />}
      {poolNode && (
        <ProxyPoolModal
          node={poolNode}
          onClose={() => {
            setPoolNode(null);
            list.reload();
          }}
        />
      )}
      {capNode && (
        <CapacityModal
          node={capNode}
          onClose={() => setCapNode(null)}
          onSaved={() => list.reload()}
        />
      )}
      {accountNode && list.data && (
        <AddAccountForNode
          node={accountNode}
          nodes={list.data}
          onClose={() => setAccountNode(null)}
          onSaved={() => list.reload()}
        />
      )}
    </>
  );
}

// ---------- add an upstream account pinned to this node ----------

function AddAccountForNode({ node, nodes, onClose, onSaved }: { node: NodeRow; nodes: NodeRow[]; onClose: () => void; onSaved: () => void }) {
  const refs = useAsync(
    () =>
      Promise.all([
        api.get<Group[]>("/api/admin/groups"),
        api.get<Paged<AdminUser>>("/api/admin/users", { role: "provider", pageSize: 100 }),
      ]).then(([groups, providers]) => ({ groups, providers: providers.items })),
    [],
  );
  const preset = useMemo(
    () => ({ nodeId: node.nodeId, ownerId: node.platformNode ? "" : node.providerId }),
    [node.nodeId, node.providerId, node.platformNode],
  );
  if (!refs.data) return null;
  return (
    <AccountFormModal
      open
      account={null}
      groups={refs.data.groups}
      providers={refs.data.providers}
      nodes={nodes}
      preset={preset}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

// ---------- deploy result ----------

function DeployResult({ outcome }: { outcome: DeployOutcome }) {
  const { t } = useCT();
  return (
    <div className="space-y-3 rounded-md p-4" style={{ border: "1px solid var(--outline-variant)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={outcome.ok ? "ok" : "failed"} />
        <StatusBadge status={outcome.online ? "online" : "offline"} />
        <span className="text-sm font-medium">
          {outcome.ok
            ? outcome.online
              ? t("admin.nodes.deployOk")
              : t("admin.nodes.deployOffline")
            : t("admin.nodes.deployFail")}
        </span>
      </div>
      <div className="text-[12.5px] text-on-surface-faint">
        <Mono title={outcome.nodeId}>{outcome.nodeId}</Mono>
      </div>
      {outcome.error && <div className="text-[13px] text-error">{outcome.error}</div>}
      {outcome.log && (
        <div>
          <div className="label">{t("admin.nodes.deployLog")}</div>
          <pre
            className="max-h-56 overflow-auto rounded-md p-3 font-mono text-[12px] leading-relaxed"
            style={{ background: "var(--code-bg)", color: "var(--code-fg)" }}
          >
            {outcome.log}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------- proxy textarea field (shared by deploy/local modals) ----------

function ProxiesField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useCT();
  const { bad } = parseProxyLines(value);
  return (
    <Field
      label={`${t("admin.nodes.proxies")} (${t("common.optional")})`}
      hint={t("admin.nodes.proxiesHint")}
      error={bad ? t("admin.nodes.errProxy", { line: bad }) : undefined}
    >
      <Textarea
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"host:port:user:pass us-east\nuser:pass@host:port\nsocks5://user:pass@host:port"}
        spellCheck={false}
      />
    </Field>
  );
}

// ---------- SSH deploy ----------

function DeployModal({ onClose, onDeployed }: { onClose: () => void; onDeployed: () => void }) {
  const { t } = useCT();
  const toast = useToast();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [auth, setAuth] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [name, setName] = useState("");
  const [proxiesText, setProxiesText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeployOutcome | null>(null);

  const { proxies, bad } = parseProxyLines(proxiesText);
  const secret = auth === "password" ? password : privateKey;
  const valid = host.trim() && username.trim() && secret.trim() && !bad && Number(port) >= 1 && Number(port) <= 65535;

  const close = () => {
    if (busy) return;
    if (result) onDeployed();
    onClose();
  };

  return (
    <Modal
      open
      size="lg"
      title={t("admin.nodes.deployTitle")}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            {result ? t("common.close") : t("common.cancel")}
          </Button>
          {!result && (
            <Button
              variant="primary"
              loading={busy}
              disabled={!valid}
              onClick={async () => {
                setBusy(true);
                try {
                  const outcome = await api.post<DeployOutcome>("/api/admin/nodes/deploy", {
                    host: host.trim(),
                    port: Number(port) || 22,
                    username: username.trim(),
                    ...(auth === "password" ? { password } : { privateKey }),
                    ...(name.trim() ? { name: name.trim() } : {}),
                    ...(proxies.length ? { proxies } : {}),
                  });
                  setResult(outcome);
                  if (outcome.ok) toast.success(t("admin.nodes.deployOk"));
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("admin.nodes.deploy")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-on-surface-variant">{t("admin.nodes.deployDesc")}</p>
        {result ? (
          <DeployResult outcome={result} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_120px]">
              <Field label={t("admin.nodes.host")}>
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.10" autoComplete="off" />
              </Field>
              <Field label={t("admin.nodes.port")}>
                <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t("admin.nodes.username")}>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ubuntu" autoComplete="off" />
              </Field>
              <Field label={`${t("admin.nodes.nodeName")} (${t("common.optional")})`}>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              </Field>
            </div>
            <Field label={t("admin.nodes.authMethod")}>
              <Segmented
                value={auth}
                onChange={setAuth}
                options={[
                  { value: "password", label: t("admin.nodes.authPassword") },
                  { value: "key", label: t("admin.nodes.authKey") },
                ]}
              />
            </Field>
            {auth === "password" ? (
              <Field label={t("admin.nodes.password")} hint={t("admin.nodes.secretNote")}>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </Field>
            ) : (
              <Field label={t("admin.nodes.privateKey")} hint={t("admin.nodes.secretNote")}>
                <Textarea rows={5} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
              </Field>
            )}
            <ProxiesField value={proxiesText} onChange={setProxiesText} />
            {busy && (
              <div className="flex items-center gap-2 text-[13px] text-on-surface-variant">
                {t("admin.nodes.deploying")}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- local node ----------

function LocalModal({ onClose, onDeployed }: { onClose: () => void; onDeployed: () => void }) {
  const { t } = useCT();
  const toast = useToast();
  const [name, setName] = useState("");
  const [proxiesText, setProxiesText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeployOutcome | null>(null);

  const { proxies, bad } = parseProxyLines(proxiesText);

  const close = () => {
    if (busy) return;
    if (result) onDeployed();
    onClose();
  };

  return (
    <Modal
      open
      title={t("admin.nodes.localTitle")}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            {result ? t("common.close") : t("common.cancel")}
          </Button>
          {!result && (
            <Button
              variant="primary"
              loading={busy}
              disabled={!!bad}
              onClick={async () => {
                setBusy(true);
                try {
                  const outcome = await api.post<DeployOutcome>("/api/admin/nodes/local", {
                    ...(name.trim() ? { name: name.trim() } : {}),
                    ...(proxies.length ? { proxies } : {}),
                  });
                  setResult(outcome);
                  if (outcome.ok) toast.success(t("admin.nodes.deployOk"));
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("admin.nodes.local")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-on-surface-variant">{t("admin.nodes.localDesc")}</p>
        {result ? (
          <DeployResult outcome={result} />
        ) : (
          <>
            <Field label={`${t("admin.nodes.nodeName")} (${t("common.optional")})`}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </Field>
            <ProxiesField value={proxiesText} onChange={setProxiesText} />
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- node capacity ----------

function CapacityModal({ node, onClose, onSaved }: { node: NodeRow; onClose: () => void; onSaved: () => void }) {
  const { t } = useCT();
  const toast = useToast();
  const [value, setValue] = useState(String(node.capacity));
  const [busy, setBusy] = useState(false);
  const capacity = Math.floor(Number(value));
  const valid = Number.isFinite(capacity) && capacity >= node.accountCount && capacity >= 1 && capacity <= 10000;

  return (
    <Modal
      open
      title={t("admin.nodes.capacityTitle", { name: node.deployMeta?.name ?? node.nodeId })}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={async () => {
              setBusy(true);
              try {
                await api.put(`/api/admin/nodes/${encodeURIComponent(node.nodeId)}/capacity`, { capacity });
                toast.success(t("admin.nodes.capacitySaved", { capacity }));
                onSaved();
                onClose();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Field label={t("admin.nodes.capacity")} hint={t("admin.nodes.capacityHint", { used: node.accountCount })}>
        <Input type="number" min={Math.max(1, node.accountCount)} max={10000} value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------- proxy pool ----------

function ProxyPoolModal({ node, onClose }: { node: NodeRow; onClose: () => void }) {
  const { t } = useCT();
  const { me } = useAuth();
  const rel = useRelTime();
  const toast = useToast();
  const isAdmin = me?.role === "admin";
  const pool = useAsync(() => api.get<NodeProxy[]>(`/api/admin/nodes/${encodeURIComponent(node.nodeId)}/proxies`), [node.nodeId]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [addGroup, setAddGroup] = useState("");
  const [historyProxy, setHistoryProxy] = useState<NodeProxy | null>(null);
  const [busy, setBusy] = useState(false);
  // Grouping (docs/onboarding.md §4.2): filter chips, a status filter, a selection and bulk actions.
  const ALL = "\u0000all";
  const NONE = "\u0000none";
  const [groupFilter, setGroupFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<"all" | "live" | "dead" | "unknown">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetGroup, setTargetGroup] = useState("");
  const { proxies, bad } = parseProxyLines(text);

  const rows = pool.data ?? [];
  const groups = useMemo(() => {
    const by = new Map<string, { group: string | null; total: number; live: number; dead: number; bound: number; assignable: number }>();
    for (const p of rows) {
      const k = p.group ?? NONE;
      const g = by.get(k) ?? { group: p.group ?? null, total: 0, live: 0, dead: 0, bound: 0, assignable: 0 };
      g.total += 1;
      if (p.status === "live") g.live += 1;
      if (p.status === "dead") g.dead += 1;
      if ((p.boundAccounts ?? p.assignedAccounts) > 0) g.bound += 1;
      if (p.status === "live" && !p.quarantined && !p.cooldownUntil && (p.overflowSlots ?? 0) > 0) g.assignable += 1;
      by.set(k, g);
    }
    return [...by.values()].sort((a, b) => (a.group === null ? 1 : b.group === null ? -1 : a.group.localeCompare(b.group)));
  }, [rows]);
  const groupNames = groups.map((g) => g.group).filter((g): g is string => !!g);
  const shown = rows.filter(
    (p) => (groupFilter === ALL || (groupFilter === NONE ? !p.group : p.group === groupFilter)) && (statusFilter === "all" || p.status === statusFilter),
  );
  const shownSelected = shown.filter((p) => selected.has(p.id)).length;
  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  async function reload() {
    setSelected(new Set());
    await pool.reload();
  }
  const groupLabel = (g: string | null) => g ?? t("admin.nodes.groupNone");

  const chip = (active: boolean, label: string, onClick: () => void, title?: string, tone?: "error") => (
    <button
      key={label}
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[12.5px] transition-colors ${active ? "border-transparent" : "hover:bg-surface-variant"}`}
      style={active ? { background: "var(--primary)", color: "var(--on-primary)", borderColor: "var(--primary)" } : { borderColor: "var(--outline-variant)", color: tone === "error" ? "var(--error)" : undefined }}
    >
      {label}
    </button>
  );

  return (
    <Modal open size="lg" title={t("admin.nodes.poolTitle", { name: node.deployMeta?.name ?? node.nodeId })} onClose={() => !busy && onClose()}>
      <div className="space-y-4">
        {/* group chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {chip(groupFilter === ALL, `${t("admin.nodes.groupAll")} ${rows.length}`, () => setGroupFilter(ALL))}
          {groups.map((g) =>
            chip(
              groupFilter === (g.group ?? NONE),
              `${groupLabel(g.group)} ${g.live}/${g.total}`,
              () => setGroupFilter(g.group ?? NONE),
              t("admin.nodes.groupChipTitle", { live: g.live, dead: g.dead, bound: g.bound, assignable: g.assignable }),
              g.live === 0 && g.total > 0 ? "error" : undefined,
            ),
          )}
          <span className="mx-1 h-5 w-px" style={{ background: "var(--outline-variant)" }} />
          <Segmented
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
            options={[
              { value: "all", label: t("admin.nodes.statusAll") },
              { value: "live", label: t("status.live") },
              { value: "dead", label: t("status.dead") },
              { value: "unknown", label: t("status.unknown") },
            ]}
          />
        </div>

        {/* selection + bulk actions */}
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-[12.5px]" style={{ background: "var(--surface-variant)" }}>
            <span className="font-medium">{t("admin.nodes.selected", { n: selected.size })}</span>
            <Button onClick={() => setSelected(new Set([...selected, ...shown.map((p) => p.id)]))} disabled={shown.length === 0 || shownSelected === shown.length}>
              {t("admin.nodes.selectShown")} ({shown.length})
            </Button>
            {selected.size > 0 && <Button onClick={() => setSelected(new Set())}>{t("admin.nodes.clearSelection")}</Button>}
            <span className="mx-1 h-5 w-px" style={{ background: "var(--outline-variant)" }} />
            <span>{t("admin.nodes.moveToGroup")}</span>
            <Input
              className="w-48"
              list={`pool-groups-${node.nodeId}`}
              value={targetGroup}
              placeholder={t("admin.nodes.moveToGroupPlaceholder")}
              onChange={(e) => setTargetGroup(e.target.value)}
            />
            <datalist id={`pool-groups-${node.nodeId}`}>
              {groupNames.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <Button
              variant="soft"
              disabled={selected.size === 0 || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const g = targetGroup.trim() || null;
                  const res = await nodeProxiesRegroup(node.nodeId, [...selected], g);
                  toast.success(t("admin.nodes.regroupResult", { n: res.changed, group: groupLabel(g) }));
                  await reload();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("admin.nodes.apply")}
            </Button>
            <span className="flex-1" />
            {selected.size === 0 || busy ? (
              <Button variant="danger" disabled>{t("admin.nodes.removeSelected")}</Button>
            ) : (
            <ConfirmButton
              variant="danger"
              message={t("admin.nodes.removeConfirm", { n: selected.size })}
              onConfirm={async () => {
                setBusy(true);
                try {
                  const res = await nodeProxiesRemove(node.nodeId, [...selected]);
                  toast.success(t("admin.nodes.removeResult", { removed: res.removed.length, bound: res.bound.length, reserved: res.reserved.length }));
                  await reload();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("admin.nodes.removeSelected")}
            </ConfirmButton>
            )}
          </div>
        )}

        <Async state={pool} rows={3}>
          {() => (
            <DataTable<NodeProxy>
              minWidth={760}
              rows={shown}
              rowKey={(p) => p.id}
              empty={<EmptyState title={t("admin.nodes.poolEmpty")} />}
              columns={[
                ...(isAdmin
                  ? [{
                      key: "sel",
                      header: (
                        <input
                          type="checkbox"
                          aria-label={t("admin.nodes.selectShown")}
                          checked={shown.length > 0 && shownSelected === shown.length}
                          onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...shown.map((p) => p.id)]) : new Set([...selected].filter((id) => !shown.some((p) => p.id === id))))}
                        />
                      ),
                      render: (p: NodeProxy) => <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={p.id} />,
                    }]
                  : []),
                {
                  key: "url",
                  header: t("admin.nodes.colUrl"),
                  render: (p) =>
                    p.url ? (
                      <Mono title={p.url}>{p.url}</Mono>
                    ) : (
                      <span className="text-[12.5px] text-error">{t("admin.nodes.undecryptable")}</span>
                    ),
                },
                {
                  key: "group",
                  header: t("admin.nodes.colGroup"),
                  render: (p) =>
                    p.group ? (
                      <button type="button" className="rounded px-1.5 py-0.5 text-[11.5px] hover:underline" style={{ background: "var(--surface-variant)" }} onClick={() => setGroupFilter(p.group!)}>
                        {p.group}
                      </button>
                    ) : (
                      <span className="text-on-surface-faint">—</span>
                    ),
                },
                {
                  key: "label",
                  header: t("admin.nodes.colLabel"),
                  render: (p) => (
                    <span className="inline-flex items-center gap-1.5">
                      {p.country && (
                        <span className="rounded px-1.5 py-0.5 font-mono text-[10.5px] font-bold leading-none" style={{ background: "var(--surface-variant)", color: "var(--on-surface-variant)" }} title={t("admin.nodes.colCountry")}>
                          {p.country}
                        </span>
                      )}
                      <span>{p.label ?? "—"}</span>
                    </span>
                  ),
                },
                {
                  key: "status",
                  header: t("common.status"),
                  render: (p) => (
                    <span className="inline-flex items-center gap-1">
                      <StatusBadge status={p.status} title={p.lastError ?? undefined} />
                      {p.cooldownUntil && (
                        <span className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: "var(--warning-container)", color: "var(--warning)" }} title={p.cooldownReason ?? undefined}>
                          {t("admin.nodes.proxyCooling", { until: fmtDateTime(p.cooldownUntil) })}
                        </span>
                      )}
                      {p.quarantined && (
                        <span className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: "var(--error-container)", color: "var(--error)" }} title={t("admin.nodes.proxyQuarantineHint", { reason: p.quarantineReason ?? "" })}>
                          {t("admin.nodes.proxyQuarantined")}
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  key: "error",
                  header: t("admin.nodes.colError"),
                  render: (p) =>
                    p.lastError ? (
                      <span className="block max-w-[220px] truncate text-[12px] text-error" title={p.lastError}>
                        {p.lastError}
                      </span>
                    ) : (
                      "—"
                    ),
                },
                ...(isAdmin ? [{ key: "team", header: t("team.name"), render: (p: NodeProxy) => <div className="max-w-[160px] text-[12px]"><div className="truncate">{p.teamName ?? (p.teamId ? t("team.unnamed") : t("team.unassigned"))}</div>{p.teamId && <div className="truncate font-mono text-[11px] text-on-surface-faint" title={p.teamId}>{p.teamId}</div>}</div> }] : []),
                { key: "assigned", header: t("admin.nodes.colAssigned"), align: "right", render: (p) => <span title={t("team.proxyCapacityHint")}>{fmtNum(p.boundAccounts ?? p.assignedAccounts)} / 3{p.reservedAccounts ? ` (+${p.reservedAccounts})` : ""}</span> },
                {
                  key: "check",
                  header: t("admin.nodes.colLastCheck"),
                  render: (p) => <span title={fmtDateTime(p.lastCheckAt)}>{p.lastCheckAt ? rel(p.lastCheckAt) : t("common.never")}</span>,
                },
                ...(isAdmin
                  ? [{
                      key: "actions",
                      header: "",
                      render: (p: NodeProxy) => (
                        <span className="inline-flex items-center gap-1">
                          <Button onClick={() => setHistoryProxy(p)}>{t("team.history")}</Button>
                          {p.quarantined && (
                            <ConfirmButton
                              variant="danger"
                              message={t("admin.nodes.unquarantineConfirm")}
                              onConfirm={async () => {
                                await nodeProxyUnquarantine(node.nodeId, p.id);
                                toast.success(t("admin.nodes.unquarantined"));
                                pool.reload();
                              }}
                            >
                              {t("admin.nodes.unquarantine")}
                            </ConfirmButton>
                          )}
                        </span>
                      ),
                    }]
                  : []),
              ]}
            />
          )}
        </Async>
        {historyProxy && <ProxyHistoryModal proxy={historyProxy} onClose={() => setHistoryProxy(null)} />}

        {/* add / replace */}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
          <Field
            label={`${t("admin.nodes.proxies")} · ${t("common.edit")}`}
            hint={(mode === "replace" ? t("admin.nodes.replaceHint") : t("admin.nodes.appendHint")) + " " + t("admin.nodes.proxiesHint")}
            error={bad ? t("admin.nodes.errProxy", { line: bad }) : undefined}
          >
            <Textarea
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"host:port:user:pass us-east\nuser:pass@host:port\nsocks5://user:pass@host:port"}
              spellCheck={false}
            />
          </Field>
          <Field label={t("admin.nodes.addGroup")} hint={t("admin.nodes.addGroupHint")}>
            <Input list={`pool-groups-${node.nodeId}`} value={addGroup} maxLength={60} onChange={(e) => setAddGroup(e.target.value)} placeholder={groupNames[0] ?? "acme-2026-10"} />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3">
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as "append" | "replace")}
            options={[
              { value: "append", label: t("admin.nodes.modeAppend") },
              { value: "replace", label: t("admin.nodes.modeReplace") },
            ]}
          />
          <Button
            variant="primary"
            loading={busy}
            disabled={!!bad || proxies.length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                const url = `/api/admin/nodes/${encodeURIComponent(node.nodeId)}/proxies`;
                type Skips = { duplicateInBatch: number; alreadyInPool: number; onOtherNode: number };
                const payload = { proxies, ...(addGroup.trim() ? { group: addGroup.trim() } : {}) };
                const res =
                  mode === "append"
                    ? await api.post<{ pushed: boolean; added: number; regrouped?: number; skipped: Skips; skippedUrls: string[] }>(url, payload)
                    : await api.put<{ pushed: boolean; total: number; skipped: Skips; skippedUrls: string[] }>(url, payload);
                // Duplicates are dropped server-side; tell the operator what happened (user rule 2026-10-20).
                const sk = res.skipped ?? { duplicateInBatch: 0, alreadyInPool: 0, onOtherNode: 0 };
                const skippedTotal = sk.duplicateInBatch + sk.alreadyInPool + sk.onOtherNode;
                const count = "added" in res ? t("admin.nodes.appendResult", { added: res.added }) : t("admin.nodes.replaceResult", { total: res.total });
                const regrouped = "regrouped" in res && res.regrouped ? " " + t("admin.nodes.regroupedResult", { n: res.regrouped }) : "";
                const dropped =
                  skippedTotal > 0
                    ? " " + t("admin.nodes.skippedResult", { skipped: skippedTotal, dup: sk.duplicateInBatch, pool: sk.alreadyInPool, other: sk.onOtherNode })
                    : "";
                toast.success(`${count}${regrouped}${dropped} ${t(res.pushed ? "admin.nodes.poolSavedPushed" : "admin.nodes.poolSavedOffline")}`);
                setText("");
                if (addGroup.trim()) setGroupFilter(addGroup.trim());
                await reload();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ProxyHistoryModal({ proxy, onClose }: { proxy: NodeProxy; onClose: () => void }) {
  const { t } = useCT();
  const history = useAsync(() => api.get<TeamEvent[]>("/api/admin/teams/events", { proxyId: proxy.id }), [proxy.id]);
  return (
    <Modal open size="lg" title={t("team.history")} onClose={onClose}>
      <Async state={history} rows={4}>
        {(result) => <DataTable<TeamEvent>
          rows={result} rowKey={(e) => e.id} minWidth={640}
          empty={<EmptyState title={t("team.historyEmpty")} />}
          columns={[
            { key: "time", header: t("common.time"), render: (e) => fmtDateTime(e.createdAt) },
            { key: "team", header: t("team.name"), render: (e) => <div className="max-w-[200px]"><div className="truncate">{e.teamName ?? t("team.unnamed")}</div><div className="truncate font-mono text-[11px]" title={e.teamId ?? undefined}>{e.teamId ?? "—"}</div></div> },
            { key: "event", header: t("team.event"), render: (e) => e.event },
            { key: "account", header: t("admin.accounts.colAccount"), render: (e) => <span className="font-mono text-[11px]">{e.accountId ?? "—"}</span> },
            { key: "reason", header: t("team.reason"), render: (e) => e.reason ?? "—" },
            { key: "actor", header: t("team.actor"), render: (e) => e.actorId ?? "—" },
          ]}
        />}
      </Async>
    </Modal>
  );
}
