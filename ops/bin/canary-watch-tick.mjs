// One watchdog tick: print canary account status + last-interval stats; exit 3 when a canary account is not active.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2] ?? "/opt/1dayapi/data/1dayapi.db", { readOnly: true });
const interval = Number(process.argv[3] ?? 300);
const g = db.prepare("SELECT value FROM settings WHERE key='canary_group_id'").get()?.value?.trim();
const accts = db.prepare("SELECT a.id, a.name, a.status, a.error_message FROM account_groups ag JOIN accounts a ON a.id=ag.account_id WHERE ag.group_id=?").all(g);
const since = new Date(Date.now() - interval * 1000).toISOString().slice(0, 19);
const ids = accts.map((a) => a.id);
const ph = ids.map(() => "?").join(",") || "NULL";
const s = db.prepare(`SELECT COUNT(*) n, SUM(status_code=200) ok, SUM(cc_shape='genuine') cc, SUM(cc_shape='suspect') suspect, SUM(status_code>=500) s5, SUM(status_code>=400 AND status_code<500) s4, COUNT(DISTINCT api_key_id) keys, SUM(stream) streams FROM usage_logs WHERE account_id IN (${ph}) AND created_at>=?`).get(...ids, since);
const errs = db.prepare(`SELECT error_code, COUNT(*) n FROM usage_logs WHERE account_id IN (${ph}) AND created_at>=? AND status_code<>200 GROUP BY 1 ORDER BY n DESC LIMIT 5`).all(...ids, since).map((e) => `${e.error_code}:${e.n}`).join(",");
const bad = accts.filter((a) => a.status !== "active");
console.log(`${new Date().toISOString()} accounts=${accts.map((a) => a.id.slice(0, 8) + "=" + a.status).join(",")} n=${s.n} ok=${s.ok ?? 0} cc_genuine=${s.cc ?? 0} suspect=${s.suspect ?? 0} stream=${s.streams ?? 0} 4xx=${s.s4 ?? 0} 5xx=${s.s5 ?? 0} keys=${s.keys} errs=[${errs}]`);
if (bad.length) { console.log("REVERT " + bad.map((a) => `${a.id.slice(0, 8)} ${a.status} ${a.error_message ?? ""}`).join(" | ")); process.exitCode = 3; }
