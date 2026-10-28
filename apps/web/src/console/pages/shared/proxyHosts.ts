import { useEffect, useState } from "react";
import { api } from "../../api";

// Maps account.boundProxyId → a displayable host, by fetching the proxy list of
// each referenced node once (admin gets the masked URL view, providers the
// credential-free picker view; both carry enough to show label/host).

interface ProxyLike {
  id: string;
  label?: string | null;
  url?: string | null;
  host?: string | null;
  port?: number | null;
}

function proxyDisplay(p: ProxyLike): string {
  if (p.label) return p.label;
  if (p.host) return p.port ? `${p.host}:${p.port}` : p.host;
  if (p.url) {
    try {
      return new URL(p.url).host;
    } catch {
      return p.url;
    }
  }
  return p.id.slice(0, 12);
}

export function useProxyHosts(
  scope: "admin" | "provider",
  accounts: Array<{ nodeId: string | null; boundProxyId?: string | null }>,
): Map<string, string> {
  const [hosts, setHosts] = useState<Map<string, string>>(() => new Map());
  const key = accounts.map((a) => `${a.nodeId}:${a.boundProxyId ?? ""}`).join(",");
  useEffect(() => {
    const nodeIds = [...new Set(accounts.filter((a) => a.boundProxyId && a.nodeId).map((a) => a.nodeId!))];
    if (!nodeIds.length) return;
    let alive = true;
    void Promise.all(
      nodeIds.map((id) => api.get<ProxyLike[]>(`/api/${scope}/nodes/${id}/proxies`).catch(() => [] as ProxyLike[])),
    ).then((lists) => {
      if (!alive) return;
      const m = new Map<string, string>();
      for (const list of lists) for (const p of list) m.set(p.id, proxyDisplay(p));
      setHosts(m);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, key]);
  return hosts;
}
