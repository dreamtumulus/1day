import { useEffect, useState } from "react";
import { TerminalIcon } from "../../../components/Icon";
import { api, type NodeRow } from "../../api";
import { useCT } from "../../i18n";
import { NodeCard } from "../shared/NodeCard";
import { Async, Button, Card, CodeBlock, ConfirmButton, EmptyState, PageHeader, SecretBox, useAsync, useToast } from "../../ui";

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ms = Math.max(0, new Date(until).getTime() - now);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return <span className="font-mono tabular-nums">{ms === 0 ? "00:00" : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`}</span>;
}

export function ProviderNodes() {
  const { t } = useCT();
  const toast = useToast();
  const nodes = useAsync(() => api.get<NodeRow[]>("/api/provider/nodes"), []);
  const reload = nodes.reload;
  const [bind, setBind] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Poll while a bind code is outstanding so the new node shows up by itself.
  useEffect(() => {
    if (!bind) return;
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [bind, reload]);

  async function generate() {
    setBusy(true);
    try {
      setBind(await api.post<{ code: string; expiresAt: string }>("/api/provider/bind-codes"));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const expired = bind ? new Date(bind.expiresAt).getTime() <= Date.now() : false;

  return (
    <>
      <PageHeader
        title={t("nav.nodes")}
        desc={t("provider.nodes.desc")}
        actions={
          <Button variant="primary" loading={busy} onClick={() => void generate()}>
            <TerminalIcon width={15} height={15} />
            {t("provider.nodes.generate")}
          </Button>
        }
      />
      <div className="space-y-6">
        {bind && (
          <Card
            title={t("provider.nodes.bindTitle")}
            desc={
              <>
                {t("provider.nodes.expiresIn")} <Countdown until={bind.expiresAt} />
                {expired && <span className="ml-2 text-error">{t("provider.nodes.expired")}</span>}
              </>
            }
            actions={<Button onClick={() => setBind(null)}>{t("common.close")}</Button>}
          >
            <div className="space-y-4">
              <SecretBox value={bind.code} note={t("provider.nodes.codeNote")} />
              <div>
                <div className="label">{t("provider.nodes.step1")}</div>
                <CodeBlock code="curl -fsSL https://releases.1dayapi.com/provider-node/install.sh | bash" />
              </div>
              <div>
                <div className="label">{t("provider.nodes.step2")}</div>
                <CodeBlock code={`1dayapi-node bind --value ${bind.code}`} />
              </div>
              <div>
                <div className="label">{t("provider.nodes.step3")}</div>
                <CodeBlock code="1dayapi-node install-service && 1dayapi-node restart" />
              </div>
            </div>
          </Card>
        )}
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-[16px] font-semibold tracking-[-0.01em]">{t("provider.nodes.list")}</h2>
          <Button onClick={nodes.reload}>{t("common.refresh")}</Button>
        </div>
        <Async state={nodes} rows={4}>
          {(list) =>
            list.length === 0 ? (
              <Card>
                <EmptyState title={t("provider.nodes.emptyTitle")} desc={t("provider.nodes.emptyDesc")} />
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                {list.map((n) => (
                  <NodeCard
                    key={n.nodeId}
                    node={n}
                    showPool={false}
                    actions={
                      <ConfirmButton
                        variant="danger"
                        title={t("provider.nodes.unbindTitle", { id: n.nodeId })}
                        message={t("provider.nodes.unbindMsg")}
                        confirmLabel={t("provider.nodes.unbind")}
                        onConfirm={async () => {
                          // 409 node_has_dependents (2026-11-10): the node still carries accounts; removing it disables
                          // them, so it needs a second confirmation. node_shared_with_other_nodes cannot be forced here.
                          try {
                            await api.del(`/api/provider/nodes/${encodeURIComponent(n.nodeId)}`);
                          } catch (err) {
                            const e = err as { status?: number; code?: string; message?: string };
                            if (e.status !== 409 || e.code !== "node_has_dependents") throw err;
                            if (!window.confirm(`${e.message}\n\n${t("provider.nodes.unbindForce")}`)) return;
                            await api.del(`/api/provider/nodes/${encodeURIComponent(n.nodeId)}?force=1`);
                          }
                          toast.success(t("provider.nodes.unbound"));
                          nodes.reload();
                        }}
                      >
                        {t("provider.nodes.unbind")}
                      </ConfirmButton>
                    }
                  />
                ))}
              </div>
            )
          }
        </Async>
      </div>
    </>
  );
}
