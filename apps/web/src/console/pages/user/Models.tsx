import { useMemo, useState } from "react";
import { apiFetch, listData, type PricingEntry } from "../../../lib/api";
import { api, platformLabel, type Group } from "../../api";
import { useCT } from "../../i18n";
import {
  Async,
  Badge,
  Card,
  CopyIconButton,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  fmtUsd,
  useAsync,
  type Column,
} from "../../ui";
import { allowedBy } from "./shared";

function perM(p: PricingEntry, meter: string): number | null {
  const sku = p.pricing_skus.find((s) => s.meter === meter);
  return sku ? (Number(sku.price_usd) * 1_000_000) / sku.quantity : null;
}

interface Row {
  id: string;
  name: string;
  platform: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
}

export function UserModels() {
  const { t } = useCT();
  const groups = useAsync(() => api.get<Group[]>("/api/user/groups"), []);
  const pricing = useAsync(async () => listData<PricingEntry>(await apiFetch<unknown>("/api/models/pricing")), []);
  const [groupId, setGroupId] = useState("");
  const [q, setQ] = useState("");

  const groupList = groups.data ?? [];
  const group = groupList.find((g) => g.id === groupId) ?? groupList.find((g) => g.isDefault) ?? groupList[0];
  const rate = group?.rateMultiplier ?? 1;

  const rows = useMemo<Row[]>(() => {
    const list = pricing.data ?? [];
    const needle = q.trim().toLowerCase();
    return list
      // Claude-only for now: hide other platforms' models (registry untouched).
      .filter((p) => p.owned_by === "anthropic")
      .filter((p) => allowedBy(group?.modelAllowlist ?? null, p.id))
      .filter((p) => !needle || p.id.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))
      .map((p) => {
        const mul = (v: number | null) => (v == null ? null : v * rate);
        return {
          id: p.id,
          name: p.name,
          platform: p.owned_by,
          input: mul(perM(p, "input_tokens")),
          output: mul(perM(p, "output_tokens")),
          cacheRead: mul(perM(p, "cache_read_tokens")),
        };
      });
  }, [pricing.data, group, rate, q]);

  const columns: Column<Row>[] = [
    {
      key: "model",
      header: t("common.model"),
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <div>
            <div className="font-mono text-[13px] text-on-surface">{r.id}</div>
            <div className="text-[12px] text-on-surface-faint">{r.name}</div>
          </div>
          <CopyIconButton text={r.id} />
        </div>
      ),
    },
    { key: "platform", header: t("common.platform"), render: (r) => <Badge>{platformLabel(r.platform)}</Badge> },
    { key: "in", header: t("user.models.inputPerM"), align: "right", render: (r) => <span className="font-mono tabular-nums">{r.input == null ? "—" : fmtUsd(r.input, 4)}</span> },
    { key: "out", header: t("user.models.outputPerM"), align: "right", render: (r) => <span className="font-mono tabular-nums">{r.output == null ? "—" : fmtUsd(r.output, 4)}</span> },
    { key: "cache", header: t("user.models.cacheReadPerM"), align: "right", render: (r) => <span className="font-mono tabular-nums text-on-surface-variant">{r.cacheRead == null ? "—" : fmtUsd(r.cacheRead, 4)}</span> },
  ];

  return (
    <>
      <PageHeader title={t("nav.models")} desc={t("user.models.desc")} />
      <Card bodyClassName="">
        <div className="flex flex-wrap items-end gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--outline-variant)" }}>
          <Field label={t("common.group")}>
            <Select
              value={group?.id ?? ""}
              onChange={(e) => setGroupId(e.target.value)}
              options={groupList.map((g) => ({ value: g.id, label: `${g.name} · ×${g.rateMultiplier}` }))}
            />
          </Field>
          <Field label={t("common.search")} className="min-w-[200px] flex-1">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="claude, gpt, …" />
          </Field>
          {group && (
            <div className="pb-2 text-[13px] text-on-surface-variant">
              {t("user.models.rateNote", { rate })}
              {group.modelAllowlist?.enabled && <span className="ml-2 text-primary">{t("user.models.restricted")}</span>}
            </div>
          )}
        </div>
        <Async state={pricing} rows={8}>
          {() => (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              minWidth={760}
              empty={<EmptyState title={t("user.models.empty")} />}
            />
          )}
        </Async>
      </Card>
    </>
  );
}
