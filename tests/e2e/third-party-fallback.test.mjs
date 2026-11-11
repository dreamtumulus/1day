import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createTeamFixture } from "./team-fixture.mjs";

const seed = readFileSync(process.argv[2], "utf8");
const pick = (label) => seed.split("\n").find((l) => l.startsWith(label)).split(":")[1].trim().split(" ")[0];
const C = `http://127.0.0.1:${process.env.E2E_CONSOLE_PORT ?? 18401}`;
const G = `http://127.0.0.1:${process.env.E2E_GATEWAY_PORT ?? 18400}`;
let fails = 0;
const check = (name, condition, evidence = "") => { console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : " " + JSON.stringify(evidence).slice(0, 700)}`); if (!condition) fails++; };

async function session(key) {
  const r = await fetch(C + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(C + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}

const admin = await session(pick("admin    login key"));
const provider = await session(pick("provider login key"));
const consumer = await session(pick("consumer login key"));
const putSettings = async (values) => {
  const current = (await admin("GET", "/api/admin/settings")).data;
  return admin("PUT", "/api/admin/settings", { ...values, _revision: current._revision });
};

process.env.FAKE_NODE_CANONICAL = "1";
const fixture = await createTeamFixture({ admin, provider, consoleBase: C, upstreamBase: `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 19101}` });
try {
  const nodes = await provider("GET", "/api/provider/nodes");
  const nodeId = nodes.data[0].nodeId;
  const grp = await admin("POST", "/api/admin/groups", { name: "third-party-fallback" });
  await fixture.createAccount({ name: "canonical-third-party", platform: "anthropic", type: "oauth", protocol: "anthropic", accessToken: "worker-ok", executor: "ccr_worker", nodeId, groupIds: [grp.data.id] });
  const key = (await consumer("POST", "/api/user/keys", { name: "third-party-fallback", groupId: grp.data.id })).data.key;
  let r = await putSettings({ worker_mode_default: "canonical", worker_canonical: "1", ccr_worker_persistent: "1", canonical_third_party_fallback: "0" });
  check("canonical enabled, third-party fallback keeps the old default off", r.status === 200 && r.data.worker_mode_default === "canonical" && r.data.worker_canonical === "1" && r.data.canonical_third_party_fallback === "0", r);

  const post = async (system, stream = false) => {
    const res = await fetch(G + "/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "opencode/1.2.3" },
      body: JSON.stringify({
        model: "claude-sonnet-5", stream, system, max_tokens: 64,
        metadata: { user_id: JSON.stringify({ device_id: "f".repeat(64), account_uuid: "", session_id: randomUUID() }) },
        messages: [{ role: "user", content: `request ${randomUUID()}` }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, text: await res.text() };
  };
  const system = (marker, variant = "", suffix = "") => `You are OpenCode, the best coding agent on the planet.\n${marker}\n${variant}\n${"x".repeat(2100)}${suffix}`;
  const logTail = (at) => fixture.log().slice(at);

  let at = fixture.log().length;
  let out = await post(system("fixture-third-party-refusal"));
  check("switch off: canonical refusal reaches the client and does not fall back", out.status === 400 && out.text.includes("Third-party apps") && !logTail(at).includes("mode=legacy"), out);

  r = await putSettings({ canonical_third_party_fallback: "1", _revision: (await admin("GET", "/api/admin/settings")).data._revision });
  check("enable third-party fallback", r.status === 200 && r.data.canonical_third_party_fallback === "1", r);

  at = fixture.log().length;
  out = await post(system("fixture-third-party-refusal"));
  const immediateLog = logTail(at);
  check("non-stream: unanswered TUI refusal retries once on legacy and succeeds", out.status === 200 && out.text.includes("Hello from fake claude.") && immediateLog.includes("mode=canonical") && immediateLog.includes("mode=legacy"), { out, immediateLog });

  at = fixture.log().length;
  out = await post(system("fixture-third-party-refusal", "", " different conversation"));
  const rememberedLog = logTail(at);
  check("same 2048-char agent prefix: next conversation starts on legacy without another refusal", out.status === 200 && !rememberedLog.includes("mode=canonical") && rememberedLog.includes("mode=legacy"), { out, rememberedLog });

  at = fixture.log().length;
  out = await post("You are a careful reviewer.");
  const otherLog = logTail(at);
  check("an unrelated system prompt stays canonical", out.status === 200 && otherLog.includes("mode=canonical") && !otherLog.includes("mode=legacy"), { out, otherLog });

  at = fixture.log().length;
  out = await post(system("fixture-third-party-refusal", " stream"), true);
  const streamLog = logTail(at);
  check("stream: error-only first chunk retries on legacy with no upstream refusal leaked", out.status === 200 && out.text.includes("Hello from fake claude.") && !out.text.includes("Third-party apps") && streamLog.includes("mode=canonical") && streamLog.includes("mode=legacy"), { out, streamLog });

  at = fixture.log().length;
  out = await post(system("fixture-third-party-partial"));
  const partialLog = logTail(at);
  check("partial output: current non-stream request is not replayed", out.status === 400 && out.text.includes("Third-party apps") && !partialLog.includes("mode=legacy"), { out, partialLog });
  at = fixture.log().length;
  out = await post(system("fixture-third-party-partial"));
  check("partial output: the next request starts on legacy", out.status === 200 && !logTail(at).includes("mode=canonical") && logTail(at).includes("mode=legacy"), out);

  at = fixture.log().length;
  out = await post(system("fixture-third-party-partial", " stream"), true);
  const partialStreamLog = logTail(at);
  check("partial stream: emitted content is preserved and the turn is not replayed", out.status === 200 && out.text.includes("partial answer") && out.text.includes("Third-party apps") && !partialStreamLog.includes("mode=legacy"), { out, partialStreamLog });
  at = fixture.log().length;
  out = await post(system("fixture-third-party-partial", " stream"), true);
  check("partial stream: the next request starts on legacy", out.status === 200 && out.text.includes("Hello from fake claude.") && !logTail(at).includes("mode=canonical") && logTail(at).includes("mode=legacy"), out);
} finally {
  delete process.env.FAKE_NODE_CANONICAL;
  await fixture.stop();
}

console.log(fails ? `THIRD-PARTY FALLBACK: ${fails} FAILED` : "THIRD-PARTY FALLBACK: ALL PASSED");
process.exit(fails ? 1 : 0);
