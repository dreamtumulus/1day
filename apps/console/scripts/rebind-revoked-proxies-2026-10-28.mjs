// ONE-OFF (2026-10-28): a provider revoked 202 proxies; the user allowed moving the 9 accounts
// bound to them onto other proxies of the same node exactly once (normally an account keeps its
// proxy for life, docs/onboarding.md §1 原则 1). Runs against the live DB from /opt/1dayapi
// (DATA_DIR set), before the console restart that re-pushes the pool policy to the nodes.
//   cd apps/console && DATA_DIR=/opt/1dayapi/data node scripts/rebind-revoked-proxies-2026-10-28.mjs /root/remove-plan.json
import { readFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const core = await import("@1dayapi/core");
const { rebindAccountProxy } = await import("../dist/node/proxies.js");
const exclude = Object.values(plan.byNode).flat();
const out = [];
for (const accountId of plan.boundAccounts) {
  try {
    const r = core.tx(() => rebindAccountProxy(accountId, "one-off-2026-10-28", { excludeProxyIds: exclude }));
    out.push({ accountId: accountId.slice(0, 8), ...r, ok: true });
  } catch (e) {
    out.push({ accountId: accountId.slice(0, 8), ok: false, error: e.message });
  }
}
for (const r of out) console.log(JSON.stringify(r));
console.log(`rebound ${out.filter((r) => r.ok).length}/${out.length}`);
