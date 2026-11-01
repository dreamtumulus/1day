import { useEffect, useState } from "react";
import { api, type Group, type Settings } from "../../api";
import { useCT } from "../../i18n";
import {
  Async,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  fmtPct,
  useAsync,
  useToast,
} from "../../ui";

export function AdminSettings() {
  const { t } = useCT();
  const state = useAsync(
    () => Promise.all([api.get<Settings>("/api/admin/settings"), api.get<Group[]>("/api/admin/groups")]),
    [],
  );

  return (
    <>
      <PageHeader title={t("admin.settings.title")} desc={t("admin.settings.desc")} />
      <Async state={state} rows={6}>
        {([settings, groups]) => <SettingsForm initial={settings} groups={groups} onSaved={state.reload} />}
      </Async>
    </>
  );
}

function SettingsForm({ initial, groups, onSaved }: { initial: Settings; groups: Group[]; onSaved: () => void }) {
  const { t } = useCT();
  const toast = useToast();
  const [s, setS] = useState<Settings>(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setS(initial), [initial]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));
  const rate = Number(s.provider_default_payout_rate);
  const rateValid = Number.isFinite(rate) && rate >= 0 && rate <= 1;
  const maxKeys = Number(s.max_keys_per_user);
  const maxValid = Number.isInteger(maxKeys) && maxKeys >= 1;
  const threshold = Number(s.anthropic_window_threshold_percent);
  const thresholdValid = Number.isInteger(threshold) && threshold >= 1 && threshold <= 100;
  const pollSec = Number(s.window_poll_interval_sec);
  const pollValid = Number.isInteger(pollSec) && pollSec >= 30;
  const stickySec = Number(s.sticky_session_ttl_sec);
  const stickyValid = Number.isInteger(stickySec) && stickySec >= 0;
  const devPool = Number(s.device_affinity_pool_size ?? "3");
  const devTtl = Number(s.device_affinity_ttl_sec ?? "7200");
  const deviceValid = Number.isInteger(devPool) && devPool >= 0 && devPool <= 20 && Number.isInteger(devTtl) && devTtl >= 60;
  const blW = Number(s.ccr_cache_baseline_worker ?? "0");
  const blC = Number(s.ccr_cache_baseline_cloud ?? "0");
  const baselineValid = Number.isInteger(blW) && blW >= 0 && Number.isInteger(blC) && blC >= 0;
  const obConc = Number(s.onboard_default_concurrency ?? "0");
  const obRpm = Number(s.onboard_default_rpm_limit ?? "0");
  const onboardLimitsValid = Number.isInteger(obConc) && obConc >= 0 && Number.isInteger(obRpm) && obRpm >= 0;
  const cdMin = Number(s.onboard_cooldown_min_sec ?? "3720");
  const cdMax = Number(s.onboard_cooldown_max_sec ?? "4200");
  const cooldownValid = Number.isInteger(cdMin) && cdMin >= 0 && Number.isInteger(cdMax) && cdMax >= cdMin && cdMax <= 86400;
  const pinValid = (s.direct_cc_version_pin ?? "") === "" || /^\d+\.\d+\.\d+$/.test(s.direct_cc_version_pin ?? "");
  const prc = Number(s.proxy_release_cooldown_sec ?? "86400");
  const proxyCooldownValid = Number.isInteger(prc) && prc >= 0 && prc <= 30 * 86400;
  const passiveAge = Number(s.window_passive_max_age_sec ?? "21600");
  const passiveValid = Number.isInteger(passiveAge) && passiveAge >= 600;
  const crPct = Number(s.cache_refund_percent ?? "80");
  const crInt = Number(s.cache_refund_interval_sec ?? "86400");
  const cacheRefundValid = Number.isInteger(crPct) && crPct >= 0 && crPct <= 100 && Number.isInteger(crInt) && crInt >= 3600 && crInt <= 30 * 86400;
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <Card
        className="xl:col-span-2"
        title={t("admin.settings.general")}
        actions={
          <Button
            variant="primary"
            loading={busy}
            disabled={!dirty || !rateValid || !maxValid || !thresholdValid || !pollValid || !stickyValid || !baselineValid || !passiveValid || !onboardLimitsValid || !cooldownValid || !proxyCooldownValid || !pinValid || !deviceValid || !cacheRefundValid}
            onClick={async () => {
              setBusy(true);
              try {
                await api.put<Settings>("/api/admin/settings", s);
                toast.success(t("admin.settings.saved"));
                onSaved();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("common.save")}
          </Button>
        }
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label={t("admin.settings.defaultGroup")} hint={t("admin.settings.defaultGroupHint")}>
              <Select
                value={s.default_group_id}
                onChange={(e) => set("default_group_id", e.target.value)}
                options={groups
                  .filter((g) => g.status === "active" || g.id === s.default_group_id)
                  .map((g) => ({ value: g.id, label: `${g.name} · ×${g.rateMultiplier}` }))}
              />
            </Field>
            <Field
              label={t("admin.settings.payoutRate")}
              hint={t("admin.settings.payoutRateHint", { v: rateValid ? fmtPct(rate) : "—" })}
              error={rateValid ? undefined : "0 – 1"}
            >
              <Input
                type="number"
                min={0}
                max={1}
                step="0.05"
                value={s.provider_default_payout_rate}
                onChange={(e) => set("provider_default_payout_rate", e.target.value)}
              />
            </Field>
            <Field label={t("admin.settings.apiBase")} hint={t("admin.settings.apiBaseHint")}>
              <Input value={s.api_base_url} onChange={(e) => set("api_base_url", e.target.value)} placeholder="https://api.example.com" />
            </Field>
            <Field label={t("admin.settings.maxKeys")} error={maxValid ? undefined : "≥ 1"}>
              <Input type="number" min={1} step="1" value={s.max_keys_per_user} onChange={(e) => set("max_keys_per_user", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.windowThreshold")} hint={t("admin.settings.windowThresholdHint")} error={thresholdValid ? undefined : "1–100"}>
              <Input type="number" min={1} max={100} step="1" value={s.anthropic_window_threshold_percent} onChange={(e) => set("anthropic_window_threshold_percent", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.windowPoll")} hint={t("admin.settings.windowPollHint")} error={pollValid ? undefined : "≥ 30"}>
              <Input type="number" min={30} step="1" value={s.window_poll_interval_sec} onChange={(e) => set("window_poll_interval_sec", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.passiveMaxAge")} hint={t("admin.settings.passiveMaxAgeHint")} error={passiveValid ? undefined : "≥ 600"}>
              <Input type="number" min={600} step="600" value={s.window_passive_max_age_sec ?? "21600"} onChange={(e) => set("window_passive_max_age_sec", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.stickyTtl")} hint={t("admin.settings.stickyTtlHint")} error={stickyValid ? undefined : "≥ 0"}>
              <Input type="number" min={0} step="1" value={s.sticky_session_ttl_sec} onChange={(e) => set("sticky_session_ttl_sec", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.devicePool")} hint={t("admin.settings.devicePoolHint")} error={deviceValid ? undefined : "0–20 / ≥ 60"}>
              <div className="grid grid-cols-2 gap-2">
                <Input type="number" min={0} max={20} step="1" value={s.device_affinity_pool_size ?? "3"} onChange={(e) => set("device_affinity_pool_size", e.target.value)} />
                <Input type="number" min={60} step="60" value={s.device_affinity_ttl_sec ?? "7200"} onChange={(e) => set("device_affinity_ttl_sec", e.target.value)} />
              </div>
            </Field>
            <Field label={t("admin.settings.onboardExecutor")} hint={t("admin.settings.onboardExecutorHint")}>
              <Select
                value={s.onboard_default_executor ?? "ccr_worker"}
                onChange={(e) => set("onboard_default_executor", e.target.value as Settings["onboard_default_executor"])}
                options={[
                  { value: "ccr_worker", label: t("admin.settings.onboardExecutorWorker") },
                  { value: "ccr", label: t("admin.settings.onboardExecutorCloud") },
                ]}
              />
            </Field>
            <Field label={t("admin.settings.onboardConcurrency")} hint={t("admin.settings.onboardLimitsHint")} error={onboardLimitsValid ? undefined : "≥ 0"}>
              <Input type="number" min={0} step="1" value={s.onboard_default_concurrency ?? "0"} onChange={(e) => set("onboard_default_concurrency", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.onboardRpm")} hint={t("admin.settings.onboardLimitsHint")} error={onboardLimitsValid ? undefined : "≥ 0"}>
              <Input type="number" min={0} step="10" value={s.onboard_default_rpm_limit ?? "0"} onChange={(e) => set("onboard_default_rpm_limit", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.onboardCooldownMin")} hint={t("admin.settings.onboardCooldownHint")} error={cooldownValid ? undefined : "0 ≤ min ≤ max ≤ 86400"}>
              <Input type="number" min={0} step="60" value={s.onboard_cooldown_min_sec ?? "3720"} onChange={(e) => set("onboard_cooldown_min_sec", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.onboardCooldownMax")} hint={t("admin.settings.onboardCooldownHint")} error={cooldownValid ? undefined : "0 ≤ min ≤ max ≤ 86400"}>
              <Input type="number" min={0} step="60" value={s.onboard_cooldown_max_sec ?? "4200"} onChange={(e) => set("onboard_cooldown_max_sec", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.proxyReleaseCooldown")} hint={t("admin.settings.proxyReleaseCooldownHint")} error={proxyCooldownValid ? undefined : "0 ≤ n ≤ 2592000"}>
              <Input type="number" min={0} step="3600" value={s.proxy_release_cooldown_sec ?? "86400"} onChange={(e) => set("proxy_release_cooldown_sec", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.exitCap")} hint={t("admin.settings.exitCapHint")}>
              <Input type="number" min={1} max={10} step="1" value={s.proxy_exit_max_accounts ?? "3"} onChange={(e) => set("proxy_exit_max_accounts", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.claimReleaseDays")} hint={t("admin.settings.claimReleaseDaysHint")}>
              <Input type="number" min={0} max={365} step="1" value={s.team_claim_release_min_days ?? "7"} onChange={(e) => set("team_claim_release_min_days", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.directCcEntrypoint")} hint={t("admin.settings.directCcEntrypointHint")}>
              <Select
                value={s.direct_cc_entrypoint_normalize ?? "1"}
                onChange={(e) => set("direct_cc_entrypoint_normalize", e.target.value)}
                options={[
                  { value: "1", label: t("common.enabled") },
                  { value: "0", label: t("common.disabled") },
                ]}
              />
            </Field>
            <Field label={t("admin.settings.directCcVersionPin")} hint={t("admin.settings.directCcVersionPinHint")} error={pinValid ? undefined : "x.y.z"}>
              <Input value={s.direct_cc_version_pin ?? ""} placeholder="2.1.303" onChange={(e) => set("direct_cc_version_pin", e.target.value.trim())} />
            </Field>
            <Field label={t("admin.settings.ccShapePolicy")} hint={t("admin.settings.ccShapePolicyHint")}>
              <Select
                value={s.cc_shape_policy ?? "observe"}
                onChange={(e) => set("cc_shape_policy", e.target.value as Settings["cc_shape_policy"])}
                options={[
                  { value: "observe", label: t("admin.settings.ccShapeObserve") },
                  { value: "downgrade", label: t("admin.settings.ccShapeDowngrade") },
                  { value: "reject", label: t("admin.settings.ccShapeReject") },
                ]}
              />
            </Field>
            <Field label={t("admin.settings.cacheBaselineWorker")} hint={t("admin.settings.cacheBaselineHint")} error={baselineValid ? undefined : "≥ 0"}>
              <Input type="number" min={0} step="100" value={s.ccr_cache_baseline_worker ?? "0"} onChange={(e) => set("ccr_cache_baseline_worker", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.cacheBaselineCloud")} hint={t("admin.settings.cacheBaselineHint")} error={baselineValid ? undefined : "≥ 0"}>
              <Input type="number" min={0} step="100" value={s.ccr_cache_baseline_cloud ?? "0"} onChange={(e) => set("ccr_cache_baseline_cloud", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.cacheWriteAsInput")} hint={t("admin.settings.cacheWriteAsInputHint")}>
              <Select
                value={s.ccr_cache_write_as_input ?? "1"}
                onChange={(e) => set("ccr_cache_write_as_input", e.target.value)}
                options={[
                  { value: "1", label: t("admin.settings.cacheWriteAsInputOn") },
                  { value: "0", label: t("admin.settings.cacheWriteAsInputOff") },
                ]}
              />
            </Field>
            <Field label={t("admin.settings.cacheRefundEnabled")} hint={t("admin.settings.cacheRefundEnabledHint")}>
              <Select
                value={s.cache_refund_enabled ?? "1"}
                onChange={(e) => set("cache_refund_enabled", e.target.value)}
                options={[
                  { value: "1", label: t("common.enabled") },
                  { value: "0", label: t("common.disabled") },
                ]}
              />
            </Field>
            <Field label={t("admin.settings.cacheRefundPercent")} hint={t("admin.settings.cacheRefundPercentHint")} error={cacheRefundValid ? undefined : "0–100"}>
              <Input type="number" min={0} max={100} step="1" value={s.cache_refund_percent ?? "80"} onChange={(e) => set("cache_refund_percent", e.target.value)} />
            </Field>
            <Field label={t("admin.settings.cacheRefundInterval")} hint={t("admin.settings.cacheRefundIntervalHint")} error={cacheRefundValid ? undefined : "≥ 3600"}>
              <Input type="number" min={3600} step="3600" value={s.cache_refund_interval_sec ?? "86400"} onChange={(e) => set("cache_refund_interval_sec", e.target.value)} />
            </Field>
          </div>
          <Field label={t("admin.settings.announcement")} hint={t("admin.settings.announcementHint")}>
            <Textarea
              rows={4}
              className="!font-sans !text-sm"
              value={s.announcement}
              onChange={(e) => set("announcement", e.target.value)}
              maxLength={4000}
            />
          </Field>
        </div>
      </Card>
      <Card title={t("admin.settings.opsTitle")}>
        <ul className="space-y-3 text-[13.5px] leading-relaxed text-on-surface-variant">
          {(["ops1", "ops2", "ops3"] as const).map((k) => (
            <li key={k} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>{t(`admin.settings.${k}`)}</span>
            </li>
          ))}
          <li>
            <code className="block break-all rounded-sm px-3 py-2 font-mono text-[12px]" style={{ background: "var(--code-bg)", color: "var(--code-fg)" }}>
              {t("admin.settings.ops4")}
            </code>
          </li>
        </ul>
      </Card>
    </div>
  );
}
