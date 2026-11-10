// X-49 (2026-11-10): seeding folder trust replaces .claude.json; the replacement must keep the owner Claude Code runs
// as, with or without machine identity. A root-owned 0600 file reads as a first run and Claude Code mints a new userID.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CcWorkerManager } from "../dist/cc-worker.js";

if (process.getuid?.() === 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-seed-"));
  try {
    const seed = CcWorkerManager.prototype.seedFolderTrust;
    for (const machineRuntime of [null, { launcher: "x", library: "x", directory: "x" }]) {
      const cfg = path.join(dir, machineRuntime ? "mi" : "plain");
      fs.mkdirSync(cfg);
      const file = path.join(cfg, ".claude.json");
      // an account dir that already has an identity, owned by the team uid
      fs.writeFileSync(file, JSON.stringify({ userID: "a".repeat(64), projects: {} }), { mode: 0o600 });
      fs.chownSync(file, 54321, 54322);
      seed.call({ machineRuntime, log: (m) => assert.fail(m) }, cfg, "/work/cwd", { uid: 54321, gid: 54322 });
      const st = fs.statSync(file), j = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(st.uid, 54321, `owner kept (machineRuntime=${!!machineRuntime})`);
      assert.equal(st.gid, 54322);
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(j.userID, "a".repeat(64));
      assert.equal(j.projects["/work/cwd"].hasTrustDialogAccepted, true);
      // a fresh dir (no file yet) gets the run-as identity
      const fresh = path.join(dir, machineRuntime ? "mi-fresh" : "plain-fresh");
      fs.mkdirSync(fresh);
      seed.call({ machineRuntime, log: (m) => assert.fail(m) }, fresh, "/work/cwd", { uid: 54321, gid: 54322 });
      assert.equal(fs.statSync(path.join(fresh, ".claude.json")).uid, 54321);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log("trust-seed: ALL PASSED");
