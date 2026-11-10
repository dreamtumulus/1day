// Device identity guard (X-49, 2026-11-10): `.claude.json` userID must stay the platform's deviceId.
// Pre-spawn hard check, drift self-heal (backup restore / userID patch) + ALERT line + heartbeat counter, post-turn
// detection, ownership of everything the node creates in an account dir (history import), root-without-worker-user.
// Pure / unprivileged checks always run (the fake claude runs as the test user; ownership through chown spies);
// blocks under `if (root)` check real kernel ownership with the system user `nobody`.
//   bun apps/provider-node/test/device-identity.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CcWorkerManager, resolveRunAs } from "../dist/cc-worker.js";
import { driftAlertLine, driftReason, findIdentityBackup, healDeviceIdentity, inspectClaudeJson, verifyClaudeJson } from "../dist/device-identity.js";
import { ProxyPool, proxyId } from "../dist/proxy-pool.js";

const root = process.getuid?.() === 0;
const FIXTURE = new URL("./fake-claude.mjs", import.meta.url).pathname;
const PROXY = "http://user:pass@127.0.0.1:9009";
const DEV = "a".repeat(64), OTHER = "b".repeat(64);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "device-identity-"));
const me = { uid: process.getuid(), gid: process.getgid() };
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const ALERT = /^\[cc-worker\] ALERT device identity drift account=(\S+) had=(\S+) want=(\S+) reason=(\S+)( .*)?$/;

const waitFor = async (cond, label, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timeout: ${label}`);
};

function configDir(name, files = {}) {
  const d = path.join(fs.mkdtempSync(path.join(tmp, "cfg-")), name);
  fs.mkdirSync(d, { mode: 0o700 });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });
  }
  return d;
}

// The ownership checks below (uid/gid of `nobody`) need the test dir to be traversable.
fs.chmodSync(tmp, 0o755);

try {
  // ================= pure: what the file looks like =================
  {
    const d = configDir("inspect");
    assert.equal(inspectClaudeJson(d).kind, "missing");
    assert.equal(driftReason(inspectClaudeJson(d), DEV), "missing");
    fs.writeFileSync(path.join(d, ".claude.json"), JSON.stringify({ userID: DEV, x: 1 }), { mode: 0o600 });
    const ok = inspectClaudeJson(d);
    assert.deepEqual([ok.kind, ok.userID, ok.json.x], ["ok", DEV, 1]);
    assert.equal(driftReason(ok, DEV), null);
    assert.equal(driftReason(ok, OTHER), "mismatch");
    fs.writeFileSync(path.join(d, ".claude.json"), JSON.stringify({ firstStartTime: "x" }));
    assert.equal(driftReason(inspectClaudeJson(d), DEV), "no_user_id");
    for (const torn of ['{"userID":"aa', "", "[]", "null", '"str"']) {
      fs.writeFileSync(path.join(d, ".claude.json"), torn);
      assert.equal(driftReason(inspectClaudeJson(d), DEV), "corrupt", JSON.stringify(torn));
    }
    fs.rmSync(path.join(d, ".claude.json"));
    fs.writeFileSync(path.join(d, "elsewhere"), JSON.stringify({ userID: DEV }));
    fs.symlinkSync(path.join(d, "elsewhere"), path.join(d, ".claude.json"));
    assert.equal(inspectClaudeJson(d).kind, "symlink", "a link is never read through, even to a valid file");
    fs.rmSync(path.join(d, ".claude.json"));
    fs.mkdirSync(path.join(d, ".claude.json"));
    assert.equal(inspectClaudeJson(d).kind, "not_regular");
    const line = `[cc-worker] ${driftAlertLine("acct-1", OTHER, DEV, "mismatch", "action=patched")}`;
    assert.equal(line, "[cc-worker] ALERT device identity drift account=acct-1 had=bbbbbbbb want=aaaaaaaa reason=mismatch action=patched");
    assert.match(`[cc-worker] ${driftAlertLine("acct-1", null, DEV, "corrupt")}`, ALERT);
    assert.ok(!driftAlertLine("a", OTHER, DEV, "mismatch").includes(OTHER), "never the whole device id in a log line");
  }

  // ================= pure: pre-spawn check =================
  {
    const d = configDir("verify", { ".claude.json": { userID: DEV } });
    const f = path.join(d, ".claude.json");
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: DEV }), null);
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: null }), null, "no platform id: owner/mode/JSON only");
    assert.match(verifyClaudeJson(d, { uid: me.uid, deviceId: OTHER }), /userID aaaaaaaa is not the platform device id bbbbbbbb/);
    // the X-49 state: the file belongs to another uid than the one Claude Code runs as
    assert.match(verifyClaudeJson(d, { uid: 54321, deviceId: DEV }), new RegExp(`owner uid ${me.uid}, process runs as uid 54321`));
    fs.chmodSync(f, 0o644);
    assert.match(verifyClaudeJson(d, { uid: me.uid, deviceId: DEV }), /mode 0644, expected 0600/);
    fs.chmodSync(f, 0o600);
    fs.writeFileSync(f, "{not json");
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: DEV }), "corrupt");
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: null }), "corrupt");
    fs.writeFileSync(f, JSON.stringify({ projects: {} }));
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: DEV }), "no_user_id");
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: null }), null);
    fs.rmSync(f);
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: DEV }), "missing");
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: null }), null, "no platform id and no file: Claude Code creates its own, as before");
    fs.writeFileSync(path.join(d, "real"), JSON.stringify({ userID: DEV }), { mode: 0o600 });
    fs.symlinkSync(path.join(d, "real"), f);
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: DEV }), "symlink");
  }

  // ================= pure: heal from Claude Code's own backup =================
  {
    const good = { userID: DEV, firstStartTime: "2026-10-01T00:00:00.000Z", projects: { "/w": { hasTrustDialogAccepted: true } }, tipsHistory: { a: 3 } };
    const d = configDir("heal-backup", {
      ".claude.json": { userID: OTHER, firstStartTime: "2026-11-10T04:28:11.000Z", firstStartVersion: "2.1.322" },
      "backups/.claude.json.backup.1762740000000": { ...good, tipsHistory: { a: 1 } }, // older, right id
      "backups/.claude.json.backup.1762750000000": good, // newest with the right id
      "backups/.claude.json.backup.1762760000000": { userID: OTHER }, // newest, already the minted id
      "backups/.claude.json.backup.1762770000000": '{"userID":"aaaa', // torn
      "backups/unrelated.json": { userID: DEV },
      "linktarget.json": { userID: DEV, viaLink: true },
    });
    fs.symlinkSync(path.join(d, "linktarget.json"), path.join(d, "backups", ".claude.json.backup.1762780000000")); // never read through
    assert.equal(findIdentityBackup(d, DEV).name, ".claude.json.backup.1762750000000");
    const state = inspectClaudeJson(d);
    const r = healDeviceIdentity(d, DEV, state, null, Date.UTC(2026, 10, 10, 5, 10, 34, 7));
    assert.deepEqual([r.action, r.reason, r.had, r.backup], ["restored_backup", "mismatch", OTHER, ".claude.json.backup.1762750000000"]);
    assert.deepEqual(readJson(path.join(d, ".claude.json")), good, "whole backup restored");
    assert.equal(fs.statSync(path.join(d, ".claude.json")).mode & 0o777, 0o600);
    assert.equal(r.kept, ".claude.json.drift-20261110T051034007Z");
    assert.equal(readJson(path.join(d, r.kept)).userID, OTHER, "offending file kept next to it");
    assert.equal(fs.statSync(path.join(d, r.kept)).mode & 0o777, 0o600);
    assert.deepEqual([fs.statSync(path.join(d, r.kept)).uid, fs.statSync(path.join(d, ".claude.json")).uid], [me.uid, me.uid]);
    assert.equal(verifyClaudeJson(d, { uid: me.uid, deviceId: DEV }), null);
  }

  // ================= pure: heal by patching only userID; reseed when nothing parses; at most 3 evidence copies =================
  {
    const d = configDir("heal-patch", {
      ".claude.json": { userID: OTHER, oauthAccount: { accountUuid: "u-1" }, projects: { "/w": { hasTrustDialogAccepted: true } }, numStartups: 7 },
      "backups/.claude.json.backup.1762760000000": { userID: OTHER },
    });
    const f = path.join(d, ".claude.json");
    let r = healDeviceIdentity(d, DEV, inspectClaudeJson(d), null, 1_000);
    assert.deepEqual([r.action, r.backup, r.had], ["patched", null, OTHER]);
    assert.deepEqual(readJson(f), { userID: DEV, oauthAccount: { accountUuid: "u-1" }, projects: { "/w": { hasTrustDialogAccepted: true } }, numStartups: 7 }, "only userID changed");
    fs.writeFileSync(f, JSON.stringify({ numStartups: 1 }));
    r = healDeviceIdentity(d, DEV, inspectClaudeJson(d), null, 2_000);
    assert.deepEqual([r.action, r.reason, r.had], ["patched", "no_user_id", null]);
    assert.deepEqual(readJson(f), { numStartups: 1, userID: DEV });
    fs.writeFileSync(f, '{"userID":"bbbb');
    r = healDeviceIdentity(d, DEV, inspectClaudeJson(d), null, 3_000);
    assert.deepEqual([r.action, r.reason], ["reseeded", "corrupt"]);
    assert.deepEqual(Object.keys(readJson(f)), ["userID", "firstStartTime"]);
    assert.equal(readJson(f).userID, DEV);
    assert.equal(fs.readFileSync(path.join(d, r.kept), "utf8"), '{"userID":"bbbb', "torn file kept byte for byte");
    for (let i = 4; i <= 6; i++) {
      fs.writeFileSync(f, JSON.stringify({ userID: OTHER, n: i }));
      healDeviceIdentity(d, DEV, inspectClaudeJson(d), null, i * 1_000);
    }
    const kept = fs.readdirSync(d).filter((n) => n.startsWith(".claude.json.drift-")).sort();
    assert.equal(kept.length, 3, "at most 3 evidence copies");
    assert.deepEqual(kept.map((n) => readJson(path.join(d, n)).n), [4, 5, 6], "the newest three");
    assert.throws(() => healDeviceIdentity(d, DEV, { kind: "symlink" }, null), /cannot heal/);
  }

  // ================= manager level (fake claude, runs as the test user) =================
  const setups = [];
  function setup(opts = {}) {
    const dataDir = fs.mkdtempSync(path.join(tmp, "node-"));
    const pool = new ProxyPool({ data: {}, save() {} }, { autoCheck: false });
    pool.replaceAll([PROXY]);
    const frames = [], logs = [];
    const manager = new CcWorkerManager({
      send: (m) => (frames.push(m), true), identity: () => ({ nodeId: "n1", providerId: "p1" }), isDraining: () => false,
      pool, dataDir, workerRoot: dataDir, runAsUser: null, claudeBin: process.execPath, claudeArgsPrefix: [FIXTURE], log: (m) => logs.push(m), allowRoot: true, ...opts,
    });
    const s = { manager, frames, logs, dataDir, pool, alerts: () => logs.filter((l) => l.includes("ALERT device identity drift")), acct: (id = "acct-1") => path.join(manager.workerRoot, "cc-accounts", id) };
    setups.push(s);
    return s;
  }
  const open = (sessionId, extra = {}) => ({
    type: "cc_worker.open", sessionId, routeMode: "cc_worker", providerId: "p1", nodeId: "n1", credentialBindingId: "acct-1", accountId: "acct-1",
    proxyId: proxyId(PROXY), deviceId: DEV, model: "claude-sonnet-5-5", prompt: "say hi", stream: true,
    cred: { accessToken: "sk-ant-oat-test", refreshToken: "sk-ant-ort-test", expiresAt: 1_900_000_000_000, subscriptionType: "pro" }, deadlineMs: 15_000, ...extra,
  });
  const ended = (s, sid) => s.frames.find((f) => f.sessionId === sid && (f.type === "cc_worker.close" || f.type === "cc_worker.error"));
  const run = async (s, sid, extra) => {
    s.manager.handleOpen(open(sid, extra));
    await waitFor(() => ended(s, sid), `${sid} ended`);
    return ended(s, sid);
  };
  const stdoutOf = (s, sid) => Buffer.concat(s.frames.filter((f) => f.sessionId === sid && f.type === "cc_worker.data").map((f) => Buffer.from(f.payloadBase64, "base64"))).toString("utf8");

  // ---- fresh dir seeded; a healthy account: no alert, counters zero, credentials not rewritten when unchanged ----
  {
    const s = setup();
    assert.equal((await run(s, "s1")).reasonCode, "complete");
    const f = path.join(s.acct(), ".claude.json");
    assert.equal(readJson(f).userID, DEV);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    const credIno = fs.statSync(path.join(s.acct(), ".credentials.json")).ino, idIno = fs.statSync(f).ino;
    assert.equal((await run(s, "s2")).reasonCode, "complete");
    assert.equal(fs.statSync(path.join(s.acct(), ".credentials.json")).ino, credIno, "same credential: file not rewritten");
    assert.equal(fs.statSync(f).ino, idIno, ".claude.json untouched on a healthy open");
    assert.deepEqual(s.alerts(), []);
    assert.deepEqual(s.manager.stats().identityDrift, { healed: 0, failed: 0, detected: 0, lastAt: null });
    assert.deepEqual(fs.readdirSync(s.acct()).filter((n) => n.includes(".tmp-") || n.includes(".drift-")), []);
    // a rotated credential replaces the file (new inode), mode kept
    assert.equal((await run(s, "s3", { cred: { accessToken: "sk-ant-oat-rotated", expiresAt: 1_900_000_000_000 } })).reasonCode, "complete");
    assert.notEqual(fs.statSync(path.join(s.acct(), ".credentials.json")).ino, credIno);
    assert.equal(readJson(path.join(s.acct(), ".credentials.json")).claudeAiOauth.accessToken, "sk-ant-oat-rotated");
    assert.equal(fs.statSync(path.join(s.acct(), ".credentials.json")).mode & 0o777, 0o600);
  }

  // ---- drift on a non-team account: alert line, evidence copy, userID patched back, counter, open proceeds ----
  {
    const s = setup();
    await run(s, "seed");
    const f = path.join(s.acct(), ".claude.json");
    fs.writeFileSync(f, JSON.stringify({ userID: OTHER, firstStartTime: "2026-11-10T04:28:11.000Z", keep: "me" }), { mode: 0o600 });
    assert.equal((await run(s, "after-drift")).reasonCode, "complete", "the open proceeds after the heal");
    assert.deepEqual([readJson(f).userID, readJson(f).keep], [DEV, "me"]);
    assert.equal(s.alerts().length, 1, "one line per drift");
    const m = ALERT.exec(s.alerts()[0]);
    assert.ok(m, s.alerts()[0]);
    assert.deepEqual(m.slice(1, 5), ["acct-1", "bbbbbbbb", "aaaaaaaa", "mismatch"]);
    assert.match(m[5], /action=patched kept=\.claude\.json\.drift-\d{8}T\d{9}Z/);
    const st = s.manager.stats().identityDrift;
    assert.deepEqual([st.healed, st.failed, st.detected], [1, 0, 0]);
    assert.ok(Date.now() - Date.parse(st.lastAt) < 10_000);
    const kept = fs.readdirSync(s.acct()).filter((n) => n.startsWith(".claude.json.drift-"));
    assert.equal(kept.length, 1);
    assert.equal(readJson(path.join(s.acct(), kept[0])).userID, OTHER);
    // healed with Claude Code's own backup when one still carries the platform id
    fs.mkdirSync(path.join(s.acct(), "backups"));
    fs.writeFileSync(path.join(s.acct(), "backups", ".claude.json.backup.1762750000000"), JSON.stringify({ userID: DEV, fromBackup: true }), { mode: 0o600 });
    fs.writeFileSync(f, JSON.stringify({ userID: OTHER }), { mode: 0o600 });
    assert.equal((await run(s, "after-drift-2")).reasonCode, "complete");
    assert.deepEqual(readJson(f), { userID: DEV, fromBackup: true });
    assert.match(s.alerts()[1], /reason=mismatch action=restored_backup backup=\.claude\.json\.backup\.1762750000000 kept=/);
    // the file vanished from an account dir that has backups: restored, loudly; a torn file: restored as well
    fs.rmSync(f);
    assert.equal((await run(s, "after-missing")).reasonCode, "complete");
    assert.equal(readJson(f).fromBackup, true);
    assert.match(s.alerts()[2], /had=none want=aaaaaaaa reason=missing action=restored_backup/);
    fs.rmSync(path.join(s.acct(), "backups"), { recursive: true });
    fs.writeFileSync(f, '{"userID":"aaaa', { mode: 0o600 });
    assert.equal((await run(s, "after-torn")).reasonCode, "complete");
    assert.equal(readJson(f).userID, DEV);
    assert.match(s.alerts()[3], /had=none want=aaaaaaaa reason=corrupt action=reseeded/);
    assert.equal(s.manager.stats().identityDrift.healed, 4);
    assert.ok(fs.readdirSync(s.acct()).filter((n) => n.startsWith(".claude.json.drift-")).length <= 3);
    // the platform learns the healed identity again with the next heartbeat
    assert.equal(s.manager.identityDelta()["acct-1"].deviceId, DEV);
  }

  // ---- team account: drift is healed too (it used to throw "fixed team device identity changed" on every open);
  //      another team's device / account stays a hard failure ----
  {
    const TEAM_A = "11111111-1111-4111-8111-111111111111", TEAM_B = "22222222-2222-4222-8222-222222222222";
    const PB = "http://u:p@127.0.0.1:9010";
    const s = setup();
    s.pool.replaceAll([PROXY, PB], { proxyTeams: { [proxyId(PROXY)]: TEAM_A, [proxyId(PB)]: TEAM_B }, proxyAccounts: { [proxyId(PROXY)]: ["a1"], [proxyId(PB)]: ["b1"] } });
    const team = (teamId, extra) => ({ accountId: "a1", credentialBindingId: "a1", isolation: { teamId, conversationId: "c", generation: 1 }, ...extra });
    assert.equal((await run(s, "t1", team(TEAM_A))).reasonCode, "complete");
    const owners = path.join(s.manager.workerRoot, "team-device-owners.json");
    assert.deepEqual(readJson(owners), { [DEV]: { teamId: TEAM_A, accountId: "a1" } });
    assert.equal(fs.statSync(owners).mode & 0o777, 0o600);
    const ownersIno = fs.statSync(owners).ino;
    const teamDir = fs.readdirSync(path.join(s.manager.workerRoot, "teams"))[0];
    const acct = path.join(s.manager.workerRoot, "teams", teamDir, "cc-accounts", "a1");
    assert.deepEqual(readJson(path.join(acct, "team-account.json")), { teamId: TEAM_A, accountId: "a1" });
    fs.writeFileSync(path.join(acct, ".claude.json"), JSON.stringify({ userID: OTHER }), { mode: 0o600 });
    const end = await run(s, "t2", team(TEAM_A));
    assert.equal(end.reasonCode, "complete", `team drift self-heals: ${JSON.stringify(end)}`);
    assert.equal(readJson(path.join(acct, ".claude.json")).userID, DEV);
    assert.match(s.alerts()[0], /account=a1 had=bbbbbbbb want=aaaaaaaa reason=mismatch action=patched/);
    assert.equal(fs.statSync(owners).ino, ownersIno, "unchanged registry is not rewritten");
    // cross-team reuse of the device, and of the account: refused as before, nothing healed
    const x = await run(s, "t3", team(TEAM_B, { accountId: "b1", credentialBindingId: "b1", proxyId: proxyId(PB) }));
    assert.deepEqual([x.type, x.errorCode], ["cc_worker.error", "worker_spawn_failed"]);
    assert.match(x.errorMessage, /device belongs to another team\/account/);
    assert.deepEqual(readJson(owners), { [DEV]: { teamId: TEAM_A, accountId: "a1" } });
    assert.equal(s.manager.stats().identityDrift.healed, 1);
  }

  // ---- a symlink where .claude.json should be: alert, open refused, nothing written through it ----
  {
    const s = setup();
    await run(s, "seed");
    const f = path.join(s.acct(), ".claude.json");
    const victim = path.join(s.dataDir, "victim.json");
    fs.writeFileSync(victim, JSON.stringify({ userID: OTHER, oauthAccount: { emailAddress: "owner@example.com" } }));
    fs.rmSync(f);
    fs.symlinkSync(victim, f);
    const end = await run(s, "linked");
    assert.deepEqual([end.type, end.errorCode], ["cc_worker.error", "worker_spawn_failed"]);
    assert.equal(stdoutOf(s, "linked"), "", "claude never started");
    assert.equal(readJson(victim).oauthAccount.emailAddress, "owner@example.com", "not healed, not scrubbed through the link");
    assert.match(s.alerts()[0], /reason=symlink action=refused/);
    assert.deepEqual([s.manager.stats().identityDrift.failed, s.manager.stats().identityDrift.healed], [1, 0]);
    // same for a planted credentials link: refused, target untouched
    fs.rmSync(f);
    fs.rmSync(path.join(s.acct(), ".credentials.json"));
    fs.symlinkSync(victim, path.join(s.acct(), ".credentials.json"));
    assert.equal((await run(s, "cred-link")).errorCode, "worker_spawn_failed");
    assert.equal(readJson(victim).userID, OTHER);
  }

  // ---- post-turn check: Claude Code changed the id during the session → ALERT at once, live process retired,
  //      next open heals ----
  {
    const s = setup();
    process.env.FAKE_CLAUDE_MINT_USERID = OTHER;
    let first;
    try {
      first = await (async () => {
        s.manager.handleOpen(open("p1", { persist: true, reuseKey: "conv-1", turnMode: "fresh", expectedTurn: 0, content: [{ type: "text", text: "hi" }] }));
        await waitFor(() => ended(s, "p1"), "p1 ended");
        return ended(s, "p1");
      })();
    } finally {
      delete process.env.FAKE_CLAUDE_MINT_USERID;
    }
    assert.equal(first.reasonCode, "complete");
    assert.equal(s.alerts().length, 1);
    assert.match(s.alerts()[0], /account=acct-1 had=bbbbbbbb want=aaaaaaaa reason=mismatch_after_turn action=heal_on_next_open$/);
    assert.deepEqual([s.manager.stats().identityDrift.detected, s.manager.stats().identityDrift.healed], [1, 0]);
    assert.equal(s.manager.stats().pool.live, 0, "the process that holds the minted id is not kept");
    assert.equal(s.manager.stats().pool.evictions.identity_drift, 1);
    assert.equal(readJson(path.join(s.acct(), ".claude.json")).userID, OTHER, "not rewritten under a running account; the next open does it");
    s.manager.scanIdentities(); // a reconnect rescans every account: the same drift is not reported twice
    assert.equal(s.alerts().length, 1);
    assert.equal((await run(s, "p2")).reasonCode, "complete");
    assert.equal(readJson(path.join(s.acct(), ".claude.json")).userID, DEV);
    assert.match(s.alerts()[1], /reason=mismatch action=patched/);
    assert.deepEqual([s.manager.stats().identityDrift.detected, s.manager.stats().identityDrift.healed], [1, 1]);
  }

  // ---- pre-spawn hard check, legacy and canonical: the file belongs to another uid than the process will run as
  //      (the X-49 state) → no process, worker_spawn_failed, ALERT. Unprivileged: the run-as identity is injected and
  //      the chown calls are recorded instead of made, so the files stay the test user's. ----
  if (!root) {
    const s = setup({ canonical: true });
    const RUN = { user: "cc-t-fixture", uid: 54321, gid: 54322 };
    s.manager.teamRunAs = () => RUN;
    const chowned = [];
    const real = { f: fs.fchownSync, l: fs.lchownSync };
    fs.fchownSync = (fd, uid, gid) => void chowned.push({ path: fs.readlinkSync(`/proc/self/fd/${fd}`), uid, gid });
    fs.lchownSync = (p, uid, gid) => void chowned.push({ path: path.join(fs.realpathSync(path.dirname(p)), path.basename(p)), uid, gid });
    try {
      const NATIVE = "0f0e0d0c-0b0a-4908-8706-050403020100";
      for (const [sid, extra] of [["legacy", {}], ["canonical", { mode: "canonical", nativeSession: { id: NATIVE, action: "start" }, historyImport: [{ type: "user", message: { role: "user", content: "earlier" } }] }]]) {
        const end = await run(s, sid, extra);
        assert.deepEqual([end.type, end.errorCode], ["cc_worker.error", "worker_spawn_failed"], sid);
        assert.match(end.errorMessage, new RegExp(`pre-spawn identity check failed for account acct-1: owner uid ${me.uid}, process runs as uid 54321`));
        assert.equal(stdoutOf(s, sid), "", `${sid}: claude never started`);
      }
      assert.equal(s.alerts().length, 2);
      assert.match(s.alerts()[0], /account=acct-1 had=none want=aaaaaaaa reason=pre_spawn_check_failed detail="owner uid \d+, process runs as uid 54321"/);
      assert.equal(s.manager.stats().identityDrift.failed, 2);
      // everything the node created for the account was handed to the run-as identity — the files Claude Code reads,
      // and (history import) `projects/`, the per-cwd dir and the transcript, not just the innermost dir
      assert.ok(chowned.every((c) => c.uid === RUN.uid && c.gid === RUN.gid));
      const got = new Set(chowned.map((c) => c.path.replace(/\.tmp-\d+-[0-9a-f]+$/, "")));
      const projects = path.join(s.acct(), "projects");
      const proj = path.join(projects, fs.readdirSync(projects)[0]);
      for (const p of [s.acct(), path.join(s.acct(), ".claude.json"), path.join(s.acct(), ".credentials.json"), path.join(s.acct(), "settings.json"), projects, proj, path.join(proj, `${NATIVE}.jsonl`)]) {
        assert.ok(got.has(p), `owner set on ${path.relative(s.manager.workerRoot, p)}`);
      }
      assert.ok([...got].some((p) => p.includes(`${path.sep}cc-sessions${path.sep}cwd${path.sep}`)), "fixed cwd dir");
      assert.ok(!got.has(path.join(s.manager.workerRoot, "cc-accounts")), "the node's own parent dirs stay the node's");
      assert.equal(readJson(path.join(proj, `${NATIVE}.jsonl`).toString()).sessionId, NATIVE);
    } finally {
      fs.fchownSync = real.f;
      fs.lchownSync = real.l;
    }
    // the gate itself, through the same method the three spawn paths share
    const d = configDir("gate", { ".claude.json": { userID: DEV } });
    assert.doesNotThrow(() => s.manager.preSpawnIdentityCheck("acct-9", d, DEV, null));
    assert.doesNotThrow(() => s.manager.preSpawnIdentityCheck("acct-9", d, DEV, me));
    assert.throws(() => s.manager.preSpawnIdentityCheck("acct-9", d, OTHER, me), /pre-spawn identity check failed for account acct-9: userID aaaaaaaa is not the platform device id bbbbbbbb/);
    fs.chmodSync(path.join(d, ".claude.json"), 0o640);
    assert.throws(() => s.manager.preSpawnIdentityCheck("acct-9", d, DEV, me), /mode 0640/);
  }

  // ---- history import, unprivileged end to end: transcript lands under projects/<cwd>/ and the turn resumes it ----
  {
    const s = setup({ canonical: true });
    const NATIVE = "1f1e1d1c-1b1a-4918-8716-151413121110";
    const end = await run(s, "import", { mode: "canonical", nativeSession: { id: NATIVE, action: "start" }, historyImport: [{ type: "user", message: { role: "user", content: "earlier" } }, { type: "assistant", message: { role: "assistant", content: [] } }] });
    assert.equal(end.reasonCode, "complete", JSON.stringify(end));
    assert.ok(stdoutOf(s, "import").includes('"--resume"'));
    const projects = path.join(s.acct(), "projects");
    assert.equal(fs.statSync(projects).mode & 0o777, 0o700);
    const file = path.join(projects, fs.readdirSync(projects)[0], `${NATIVE}.jsonl`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 2);
    // `projects` swapped for a link by the account's own uid: the import is refused, nothing written behind it
    const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
    fs.rmSync(projects, { recursive: true });
    fs.symlinkSync(outside, projects);
    const bad = await run(s, "import-link", { mode: "canonical", nativeSession: { id: NATIVE, action: "start" }, historyImport: [{ type: "user", message: { role: "user", content: "x" } }] });
    assert.equal(bad.errorCode, "worker_spawn_failed");
    assert.deepEqual(fs.readdirSync(outside), []);
  }

  // ---- root node without an unprivileged worker user: self-test fails unless CC_WORKER_ALLOW_ROOT=1 ----
  {
    const realGetuid = process.getuid;
    const prev = process.env.CC_WORKER_ALLOW_ROOT;
    // Unprivileged run: pretend to be root for the constructor only (nothing privileged happens before the check).
    if (!root) process.getuid = () => 0;
    try {
      delete process.env.CC_WORKER_ALLOW_ROOT;
      assert.equal(resolveRunAs("no-such-user-x49"), null);
      const refused = setup({ allowRoot: undefined, runAsUser: "no-such-user-x49", workerRoot: fs.mkdtempSync(path.join(tmp, "wr-")) });
      assert.equal(refused.manager.selfTestError, "self_test_failed: no_unprivileged_user");
      assert.equal(refused.manager.stats().enabled, false);
      assert.ok(refused.logs.some((l) => l.includes("CC_WORKER_ALLOW_ROOT=1")), "the log says what to do");
      refused.manager.handleOpen(open("as-root"));
      assert.deepEqual([refused.frames[0].accepted, refused.frames[0].reasonCode], [false, "self_test_failed: no_unprivileged_user"]);
      process.env.CC_WORKER_ALLOW_ROOT = "1";
      const allowed = setup({ allowRoot: undefined, runAsUser: "no-such-user-x49", workerRoot: fs.mkdtempSync(path.join(tmp, "wr-")) });
      assert.equal(allowed.manager.selfTestError, null, "explicit opt-in keeps the old behaviour");
      delete process.env.CC_WORKER_ALLOW_ROOT;
      assert.equal(setup({ allowRoot: true, runAsUser: null, workerRoot: fs.mkdtempSync(path.join(tmp, "wr-")) }).manager.selfTestError, null);
    } finally {
      process.getuid = realGetuid;
      if (prev === undefined) delete process.env.CC_WORKER_ALLOW_ROOT;
      else process.env.CC_WORKER_ALLOW_ROOT = prev;
    }
    if (!root) assert.equal(setup({ allowRoot: undefined }).manager.selfTestError, null, "a non-root node is not affected");
  }

  // ================= real ownership (root only): workers drop to `nobody` =================
  const nobody = root ? resolveRunAs("nobody") : null;
  if (root && nobody) {
    const fixtureDir = fs.mkdtempSync(path.join(tmp, "exec-"));
    fs.chmodSync(fixtureDir, 0o755);
    const fixture = path.join(fixtureDir, "fake.mjs");
    fs.copyFileSync(FIXTURE, fixture);
    fs.chmodSync(fixture, 0o644);
    const mk = (extra = {}) => {
      const workerRoot = fs.mkdtempSync(path.join(tmp, "wr-"));
      fs.chmodSync(workerRoot, 0o711);
      return setup({ runAsUser: "nobody", claudeArgsPrefix: [fixture], workerRoot, allowRoot: undefined, ...extra });
    };
    const owner = (p) => [fs.lstatSync(p).uid, fs.lstatSync(p).gid];
    const want = [nobody.uid, nobody.gid];
    // `nobody` must be able to run the runtime at all (a bun under /root is out of its reach): otherwise skip, loudly.
    const probe = mk().manager.selfTestError;
    if (probe) console.log(`device-identity: real-ownership blocks SKIPPED, nobody cannot run the fixture: ${probe}`);
    else {

    // every file and directory of a fresh account belongs to the run-as identity
    {
      const s = mk({ canonical: true });
      assert.equal(s.manager.selfTestError, null, s.manager.selfTestError ?? "");
      const NATIVE = "2f2e2d2c-2b2a-4928-8726-252423222120";
      const end = await run(s, "r-import", { mode: "canonical", nativeSession: { id: NATIVE, action: "start" }, historyImport: [{ type: "user", message: { role: "user", content: "earlier" } }] });
      assert.equal(end.reasonCode, "complete", JSON.stringify(end));
      const projects = path.join(s.acct(), "projects");
      const proj = path.join(projects, fs.readdirSync(projects)[0]);
      for (const p of [s.acct(), path.join(s.acct(), ".claude.json"), path.join(s.acct(), ".credentials.json"), path.join(s.acct(), "settings.json"), projects, proj, path.join(proj, `${NATIVE}.jsonl`)]) {
        assert.deepEqual(owner(p), want, `${path.relative(s.manager.workerRoot, p)} owned by the run-as uid`);
      }
      assert.equal(fs.statSync(projects).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(s.manager.workerRoot, "cc-accounts")).uid, 0);
      assert.deepEqual(s.alerts(), []);
    }

    // the X-49 state itself: .claude.json root-owned 0600 with the right id → handed back before the spawn, no drift
    {
      const s = mk();
      await run(s, "seed");
      const f = path.join(s.acct(), ".claude.json");
      fs.chownSync(f, 0, 0);
      assert.equal((await run(s, "x49")).reasonCode, "complete");
      assert.deepEqual(owner(f), want);
      assert.equal(readJson(f).userID, DEV);
      assert.ok(s.logs.some((l) => /\.claude\.json of account acct-1 was owned by 0:0/.test(l)));
      // drift healed as root: the restored file and the evidence copy keep the run-as owner, 0600
      fs.writeFileSync(f, JSON.stringify({ userID: OTHER }));
      assert.equal((await run(s, "heal")).reasonCode, "complete");
      assert.deepEqual([...owner(f), fs.statSync(f).mode & 0o777, readJson(f).userID], [...want, 0o600, DEV]);
      const kept = fs.readdirSync(s.acct()).filter((n) => n.startsWith(".claude.json.drift-"));
      assert.equal(kept.length, 1);
      assert.deepEqual([...owner(path.join(s.acct(), kept[0])), fs.statSync(path.join(s.acct(), kept[0])).mode & 0o777], [...want, 0o600]);
      assert.equal(s.manager.stats().identityDrift.healed, 1);
      // a link planted by the account's uid never makes root chown or write elsewhere
      const victim = path.join(tmp, "root-only");
      fs.writeFileSync(victim, "root", { mode: 0o600 });
      fs.symlinkSync(victim, path.join(s.acct(), "planted"));
      fs.rmSync(path.join(s.acct(), "settings.json"));
      fs.symlinkSync(victim, path.join(s.acct(), "settings.json"));
      assert.equal((await run(s, "links")).reasonCode, "complete");
      assert.deepEqual([fs.statSync(victim).uid, fs.readFileSync(victim, "utf8")], [0, "root"]);
      assert.deepEqual(owner(path.join(s.acct(), "planted")), want, "the link itself is re-owned, not its target");
    }

    // pre-spawn check with a real foreign owner: the gate is the last line when the repair is bypassed
    {
      const s = mk();
      await run(s, "seed");
      const f = path.join(s.acct(), ".claude.json");
      fs.chownSync(f, 0, 0);
      assert.throws(() => s.manager.preSpawnIdentityCheck("acct-1", s.acct(), DEV, nobody), /owner uid 0, process runs as uid/);
      fs.chownSync(f, nobody.uid, nobody.gid);
      assert.doesNotThrow(() => s.manager.preSpawnIdentityCheck("acct-1", s.acct(), DEV, nobody));
    }

    // no unprivileged user, for real
    {
      const prev = process.env.CC_WORKER_ALLOW_ROOT;
      delete process.env.CC_WORKER_ALLOW_ROOT;
      try {
        assert.equal(mk({ runAsUser: null }).manager.selfTestError, "self_test_failed: no_unprivileged_user");
      } finally {
        if (prev !== undefined) process.env.CC_WORKER_ALLOW_ROOT = prev;
      }
    }
    }
  }

  for (const s of setups) {
    s.manager.closeAll();
    s.pool.stopHealthChecks();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`device-identity: ALL PASSED${root ? "" : " (real-ownership blocks skipped: not root)"}`);
