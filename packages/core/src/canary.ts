// 灰度（canary）开关 —— 铁律 2（2026-11-01，CLAUDE.md）：任何上游可见的改动都放在开关后面，默认 = 老行为；
// 先只对「灰度测试」账号组开启、观察够时长，再全量。开关值：
//   "0"      关（老行为）
//   "canary" 只对灰度组开：请求的 Key 属于灰度组，或被选中的账号属于灰度组
//   "1"      全量开
// 灰度组 = settings.canary_group_id 指向的 groups 行（控制台「设置」里选）。
import { one } from "./db.js";
import { getSetting, type SettingKey } from "./settings.js";

export type FeatureValue = "0" | "1" | "canary";

export function canaryGroupId(): string | null {
  const v = getSetting("canary_group_id").trim();
  return v || null;
}

export function isCanaryGroup(groupId?: string | null): boolean {
  const c = canaryGroupId();
  return !!c && !!groupId && groupId === c;
}

export function isCanaryAccount(accountId?: string | null): boolean {
  const c = canaryGroupId();
  if (!c || !accountId) return false;
  return !!one("SELECT 1 FROM account_groups WHERE account_id = ? AND group_id = ?", accountId, c);
}

export function parseFeatureValue(v: string | null | undefined): FeatureValue {
  return v === "1" || v === "canary" ? v : "0";
}

/** Is the feature behind `key` on for this request (by its key's group) / this account? */
export function featureFor(key: SettingKey, ctx: { groupId?: string | null; accountId?: string | null } = {}): boolean {
  const v = parseFeatureValue(getSetting(key));
  if (v === "1") return true;
  if (v === "0") return false;
  return isCanaryGroup(ctx.groupId) || isCanaryAccount(ctx.accountId);
}
