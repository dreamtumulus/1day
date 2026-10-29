// ONE-OFF (2026-10-29): a proxy provider expired (CONNECT to api.anthropic.com refused by ruleset);
// the user allowed moving the accounts stranded on its dead proxies once: worker-02 has no live
// proxy left, so the four P-01 accounts move to worker-01 and are rebound there (same organization
// exits first, verified free exits otherwise); the WORK-CCR supplied-cookie account is rebound
// inside worker-01. Normally an account keeps its node and proxy for life (docs/onboarding.md §1).
//   cd /opt/1dayapi/apps/console && DATA_DIR=/opt/1dayapi/data node scripts/rebind-stranded-2026-10-29.mjs <plan.json>
// plan: { "targetNode": "<node_id>", "accounts": ["<account id>", ...] }
import { readFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const core = await import("@1dayapi/core");
const { rebindAccountProxy } = await import("../dist/node/proxies.js");
const out = [];
for (const accountId of plan.accounts) {
  try {
    const r = core.tx(() => {
      const a = core.one("SELECT id, name, node_id, route FROM accounts WHERE id = ?", accountId);
      if (!a) throw new Error("account_not_found");
      let moved = false;
      if (a.route === "node" && a.node_id !== plan.targetNode) {
        core.run("UPDATE accounts SET node_id = ?, updated_at = ? WHERE id = ?", plan.targetNode, core.nowIso(), accountId);
        moved = true;
      }
      const res = rebindAccountProxy(accountId, "one-off-2026-10-29", {});
      return { name: a.name, movedFrom: moved ? a.node_id : null, ...res };
    });
    out.push({ accountId: accountId.slice(0, 8), ok: true, ...r });
  } catch (e) {
    out.push({ accountId: accountId.slice(0, 8), ok: false, error: e.message });
  }
}
for (const r of out) console.log(JSON.stringify(r));
console.log(`rebound ${out.filter((r) => r.ok).length}/${out.length}`);
