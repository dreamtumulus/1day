import { useCallback } from "react";
import { useT } from "../../i18n";
import admin from "./admin";
import admin2 from "./admin2";
import common from "./common";
import finance from "./finance";
import onboard from "./onboard";
import provider from "./provider";
import user from "./user";
import team from "./team";

// Console dictionaries: flat "dotted.key" -> string, one file per area so the
// areas can evolve independently. Each file exports { en, zh }.
export type FlatDict = Record<string, string>;
export interface DictPair {
  en: FlatDict;
  zh: FlatDict;
}

const merged = {
  en: { ...common.en, ...user.en, ...provider.en, ...admin.en, ...admin2.en, ...finance.en, ...onboard.en, ...team.en } as FlatDict,
  zh: { ...common.zh, ...user.zh, ...provider.zh, ...admin.zh, ...admin2.zh, ...finance.zh, ...onboard.zh, ...team.zh } as FlatDict,
};

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

/** Console translator: falls back to English, then to the key itself. */
export function useCT() {
  const { lang } = useT();
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) =>
      interpolate(merged[lang][key] ?? merged.en[key] ?? key, vars),
    [lang],
  );
  return { t, lang };
}
