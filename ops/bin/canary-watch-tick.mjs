// One watchdog tick: print canary account status + last-interval stats.
// exit 3 = no canary account is *serving* (status != active, or window_exhausted_until / temp_unschedulable_until / overload_until in
// the future) -> the watchdog reverts the users' keys; exit 4 = serving again while recorded keys sit in their old group -> cycle them in.
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2] ?? "/opt/1dayapi/data/1dayapi.db", { readOnly: true });
const interval = Number(process.argv[3] ?? 300);
const g = db.prepare("SELECT value FROM settings WHERE key='canary_group_id'").get()?.value?.trim();
const accts = db.prepare("SELECT a.id, a.name, a.status, a.error_message, a.window_exhausted_until, a.temp_unschedulable_until, a.overload_until, a.window_reason FROM account_groups ag JOIN accounts a ON a.id=ag.account_id WHERE ag.group_id=?").all(g);
const nowIso = new Date().toISOString();
const serving = (a) => a.status === "active" && [a.window_exhausted_until, a.temp_unschedulable_until, a.overload_until].every((t) => !t || t <= nowIso);
const state = (a) => a.status !== "active" ? a.status : !serving(a) ? `active/paused(${a.window_exhausted_until && a.window_exhausted_until > nowIso ? "window until " + a.window_exhausted_until : a.temp_unschedulable_until && a.temp_unschedulable_until > nowIso ? "unschedulable until " + a.temp_unschedulable_until : "overload until " + a.overload_until})` : "serving";
const since = new Date(Date.now() - interval * 1000).toISOString().slice(0, 19);
const ids = accts.map((a) => a.id);
const ph = ids.map(() => "?").join(",") || "NULL";
const hasRetries = db.prepare("PRAGMA table_info(usage_logs)").all().some((c) => c.name === "upstream_retries"); // migration 39
const s = db.prepare(`SELECT COUNT(*) n, SUM(status_code=200) ok, SUM(cc_shape='genuine') cc, SUM(cc_shape='suspect') suspect, SUM(status_code>=500) s5, SUM(status_code>=400 AND status_code<500) s4, COUNT(DISTINCT api_key_id) keys, SUM(stream) streams, SUM(mode='passthrough-anthropic') direct, SUM(mode LIKE 'ccr-%') worker, ${hasRetries ? "SUM(COALESCE(upstream_retries,0))" : "0"} retries FROM usage_logs WHERE account_id IN (${ph}) AND created_at>=?`).get(...ids, since);
const errs = db.prepare(`SELECT error_code, COUNT(*) n FROM usage_logs WHERE account_id IN (${ph}) AND created_at>=? AND status_code<>200 GROUP BY 1 ORDER BY n DESC LIMIT 5`).all(...ids, since).map((e) => `${e.error_code}:${e.n}`).join(",");
const bad = accts.filter((a) => !serving(a));
console.log(`${new Date().toISOString()} accounts=${accts.map((a) => a.id.slice(0, 8) + "=" + state(a)).join(",")} n=${s.n} ok=${s.ok ?? 0} cc_genuine=${s.cc ?? 0} suspect=${s.suspect ?? 0} direct=${s.direct ?? 0} worker=${s.worker ?? 0} retries=${s.retries ?? 0} stream=${s.streams ?? 0} 4xx=${s.s4 ?? 0} 5xx=${s.s5 ?? 0} keys=${s.keys} errs=[${errs}]`);
const recFile = process.env.MOVED_FILE ?? "/root/monitor/canary-moved-keys.json";
const rec = existsSync(recFile) ? JSON.parse(readFileSync(recFile, "utf8")) : [];
const inCanary = rec.filter((r) => !r.reverted_at && !r.retired).length, parked = rec.filter((r) => r.reverted_at && !r.retired).length;
if (bad.length === accts.length && accts.length) {
  if (inCanary) { console.log("REVERT " + bad.map((a) => `${a.id.slice(0, 8)} ${state(a)} ${a.error_message ?? ""}`).join(" | ")); process.exitCode = 3; }
} else if (parked && !inCanary) { console.log(`CYCLE-IN ${parked} parked key(s): canary account serving again`); process.exitCode = 4; }
