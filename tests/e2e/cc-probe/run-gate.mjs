// Controlled Claude Code 2.1.312 probe (spec §7). Fake OAuth, temp HOME/CLAUDE_CONFIG_DIR, capturing fake upstream,
// refusing CONNECT proxy. Writes a redacted evidence file to docs/evidence/cc-2.1.312/<gate>.<tag>.json.
//   node tests/e2e/cc-probe/run-gate.mjs <gate>
//   gate ∈ baseline | append | restricted | schema | streamjson | attachments | session | resume
//        | session-kill | tool-interrupt | tool-interrupt-builtin | restricted-* | unrestricted-* | history-first
// env knobs (all optional): CC_PROBE_TAG (evidence filename suffix), CC_PROBE_PROMPT, CC_PROBE_MODEL,
//   CC_PROBE_HOME / CC_PROBE_SESSION (reuse an earlier probe home), CC_PROBE_KEEP=1, CC_PROBE_OUT.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCapture } from "./mock-upstream-capture.mjs";

const CLAUDE = process.env.CC_PROBE_BIN ?? "/home/ubuntu/claude-code-re/2.1.312/package/claude";
const MODEL = process.env.CC_PROBE_MODEL ?? "claude-sonnet-5-5";
const PROMPT = process.env.CC_PROBE_PROMPT ?? "Reply with the single word OK.";
const gate = process.argv[2] ?? "baseline";
const tag = process.env.CC_PROBE_TAG ?? "";
const outDir = resolve(process.env.CC_PROBE_OUT ?? "docs/evidence/cc-2.1.312");
mkdirSync(outDir, { recursive: true });

const reuse = process.env.CC_PROBE_HOME; // reuse an earlier probe home (session persistence / resume gates)
const home = reuse ?? mkdtempSync(join(tmpdir(), "cc-probe-"));
const cfg = join(home, "cfg"); const work = join(home, "work");
if (!reuse) { mkdirSync(cfg, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 }); }
const SESSION = process.env.CC_PROBE_SESSION ?? randomUUID();
const deviceId = createHash("sha256").update("cc-probe-device").digest("hex");
const accountUuid = "9d2d1c5e-1111-4a7b-8c3d-aaaaaaaaaaaa";
if (!reuse && gate !== "attachments-apikey-email") writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-probe-fake-token", refreshToken: "sk-ant-ort01-probe-fake", expiresAt: Date.now() + 8 * 3600e3, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }), { mode: 0o600 });
if (!reuse) writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ userID: deviceId, hasCompletedOnboarding: true, oauthAccount: { accountUuid, emailAddress: process.env.CC_PROBE_EMAIL ?? "", organizationUuid: "11111111-2222-4333-8444-555555555555", displayName: "", fullName: "", profileFetchedAt: Date.now() } }), { mode: 0o600 });
if (!reuse) writeFileSync(join(cfg, "settings.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });

const toolProbe = gate === "restricted-read-creds" ? { name: "Read", input: { file_path: join(cfg, ".credentials.json") } }
  : gate === "restricted-read-hostname" ? { name: "Read", input: { file_path: "/etc/hostname" } }
  : gate === "restricted-bash" ? { name: "Bash", input: { command: "cat " + join(cfg, ".credentials.json") } }
  : gate === "unrestricted-read-creds" ? { name: "Read", input: { file_path: join(cfg, ".credentials.json") } }
  : gate === "tool-interrupt" ? { name: "mcp__caller__lookup", input: { q: "probe" } }
  : gate === "tool-interrupt-builtin" ? { name: "Bash", input: { command: "sleep 8; echo PROBE-BASH-DONE" } }
  : null;
// the MCP gate needs a real (fake) MCP server so the binary issues mcp__caller__lookup and parks on the result
const mcpLog = join(home, "fake-mcp.log");
const mcpConfig = join(home, "mcp-config.json");
const needsMcp = gate === "tool-interrupt" || gate === "resume-mcp";
if (gate === "tool-interrupt" || gate === "resume-mcp") {
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { caller: { command: process.execPath, args: [resolve("tests/e2e/cc-probe/fake-mcp-server.mjs")], env: { FAKE_MCP_LOG: mcpLog } } } }));
}
let killed = false, killedAt = null, killReason = null;
const cap = await startCapture({
  jsonSchemaAnswer: gate === "schema" ? { name: "probe" } : null,
  firstToolUse: toolProbe,
  delayFirstMessageMs: gate === "session-kill-midflight" ? 30_000 : 0,
  onFirstToolUse: gate === "tool-interrupt-builtin" ? () => { setTimeout(() => { killed = true; killedAt = Date.now(); killReason = "first-tool-use+buildin-tool-running"; child.kill("SIGKILL"); }, 800); } : null,
});
const common = ["-p", "--model", MODEL, "--output-format", "stream-json", "--verbose"];
let args = []; let stdinLines = null; let appendFile = null;
switch (gate) {
  case "baseline": args = [...common, PROMPT]; break;
  case "append": appendFile = join(home, "caller-system.txt"); writeFileSync(appendFile, "CALLER-SYSTEM-MARKER-7f3a: always answer in uppercase."); args = [...common, "--append-system-prompt-file", appendFile, PROMPT]; break;
  case "restricted": args = [...common, "--restricted", "--permission-prompts", "none", PROMPT]; break;
  case "schema": args = [...common, "--json-schema", JSON.stringify({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }), "Give me a name."]; break;
  case "streamjson": args = [...common, "--input-format", "stream-json", "--include-partial-messages"]; stdinLines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "First turn: reply OK." }] } }),
    // does the binary accept an injected assistant turn? (G2)
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "INJECTED-ASSISTANT-TEXT" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Second turn: what did you say before?" }] } }),
  ]; break;
  case "session": args = [...common, "--session-id", SESSION, PROMPT]; break; // G4 step 1: persisted session
  case "session-kill": args = [...common, "--session-id", SESSION, PROMPT]; break; // G4 step 1b: SIGKILL right after first assistant event
  case "session-kill-midflight": args = [...common, "--session-id", SESSION, PROMPT]; break; // G4 step 1c: SIGKILL with REQ0 unanswered 
  case "resume": args = [...common, "--resume", SESSION, PROMPT]; break;
  case "resume-builtin": args = [...common, "--resume", SESSION, PROMPT, "--permission-prompts", "none", "--allowedTools", "Bash"]; break; // G5 step 2 for a built-in tool
  case "resume-mcp": args = [...common, "--resume", SESSION, PROMPT, "--strict-mcp-config", "--mcp-config", mcpConfig, "--permission-prompts", "none", "--allowedTools", "mcp__caller__lookup"]; break; // G5 step 2: resume with the same caller MCP // G4 step 2 (same CC_PROBE_HOME)
  case "tool-interrupt": args = [...common, "--session-id", SESSION, "--strict-mcp-config", "--mcp-config", mcpConfig, "--permission-prompts", "none", PROMPT, "--allowedTools", "mcp__caller__lookup"]; break; // G5: caller tool parked
  case "tool-interrupt-builtin": args = [...common, "--session-id", SESSION, "--permission-prompts", "none", PROMPT, "--allowedTools", "Bash"]; break; // G5: built-in tool running
  case "attachments": args = [...common, PROMPT]; break;
  case "attachments-email": args = [...common, PROMPT]; break; // CC_PROBE_EMAIL set: does `# userEmail` travel with OAuth login?
  case "attachments-apikey-email": args = [...common, PROMPT]; break; // CC_PROBE_EMAIL set + ANTHROPIC_AUTH_TOKEN, no OAuth credentials: platform-key login // attachments ON (no CLAUDE_CODE_DISABLE_ATTACHMENTS) to see userEmail/Environment shape
  case "restricted-read-creds": case "restricted-read-hostname": case "restricted-bash": args = [...common, "--restricted", "--permission-prompts", "none", "Read the file I mention."]; break;
  case "unrestricted-read-creds": args = [...common, "--permission-prompts", "none", "Read the file I mention."]; break;
  case "history-first": args = [...common, "--input-format", "stream-json", "--include-partial-messages"]; stdinLines = [
    // external history imported before the live question (G2b): does the first *user* turn come from the import?
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "IMPORTED-USER-1: what is 2+2?" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "IMPORTED-ASSISTANT-1: 4" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "LIVE-USER-2: and times 3?" }] } }),
  ]; break;
  default: throw new Error(`unknown gate ${gate}`);
}
const env = {
  PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: cfg, SHELL: "/bin/bash", TERM: "dumb",
  ANTHROPIC_BASE_URL: cap.baseUrl, HTTPS_PROXY: cap.proxyUrl, HTTP_PROXY: cap.proxyUrl, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
  ...(process.env.CC_PROBE_SSLKEYLOGFILE ? { SSLKEYLOGFILE: process.env.CC_PROBE_SSLKEYLOGFILE } : {}),
  ...(gate.startsWith("attachments") ? {} : { CLAUDE_CODE_DISABLE_ATTACHMENTS: "1" }),
  ...(gate === "attachments-apikey-email" ? { ANTHROPIC_AUTH_TOKEN: "sk-1day-probe-fake-platform-key" } : {}),
};
const started = Date.now();
const child = spawn(CLAUDE, args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));
if (stdinLines) { let i = 0; const tick = setInterval(() => { if (i < stdinLines.length) child.stdin.write(stdinLines[i++] + "\n"); else { clearInterval(tick); setTimeout(() => child.stdin.end(), 1500); } }, 2500); }
else child.stdin.end();
// SIGKILL triggers for the crash/resume gates
const readLog = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const killTimer = setInterval(() => {
  if (killed || child.exitCode !== null) return;
  if (gate === "session-kill" && stdout.includes('"type":"assistant"')) {
    killed = true; killedAt = Date.now(); killReason = "first-assistant-event"; child.kill("SIGKILL"); return;
  }
  if (gate === "session-kill-midflight" && cap.requests.length >= 1 && Date.now() - started > Number(process.env.CC_PROBE_KILL_DELAY ?? 800)) {
    killed = true; killedAt = Date.now(); killReason = "request-in-flight-unanswered"; child.kill("SIGKILL"); return;
  }
  if (gate === "tool-interrupt" && readLog(mcpLog).includes('"tools/call"')) {
    killed = true; killedAt = Date.now(); killReason = "mcp-tools/call-parked"; child.kill("SIGKILL");
  }
}, 60);
const timer = setTimeout(() => { killed = true; killedAt = Date.now(); killReason = "timeout-90s"; child.kill("SIGKILL"); }, 90_000);
const code = await new Promise((r) => child.on("close", r));
clearInterval(killTimer); clearTimeout(timer);
await new Promise((r) => setTimeout(r, 300));
await cap.close();

// ---- evidence (structure only, no secrets) ----
// §0.4: evidence stores structure only — temp/home paths are replaced by placeholders
const scrub = (s) => String(s)
  .replace(/\/(?:tmp|var\/tmp)\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<tmp-path>")
  .replace(/\/home\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<home-path>")
  .replace(/\/root\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<home-path>");
const textOf = (b) => (typeof b === "string" ? b : b?.type === "text" ? String(b.text ?? "") : "");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const IDENTITY = /You are Claude Code[^.]*\./;
const describe = (r) => {
  const b = r.body ?? {};
  const sys = Array.isArray(b.system) ? b.system : b.system !== undefined ? [b.system] : [];
  const sysTexts = sys.map(textOf);
  const raw = JSON.stringify(b);
  const auth = r.headers?.authorization ?? "";
  return {
    url: r.url, method: r.method, userEmailReminder: JSON.stringify(b).includes("# userEmail"),
    headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => /^(user-agent|x-app|anthropic-beta|anthropic-version|x-stainless-|accept|content-type|x-claude-code-session-id|anthropic-dangerous)/.test(k))),
    betaList: String(r.headers?.["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    authScheme: auth.startsWith("Bearer ") ? "bearer" : r.headers?.["x-api-key"] ? "x-api-key" : "none",
    topLevelKeys: Object.keys(b),
    system: sys.map((s) => ({ len: textOf(s).length, head: textOf(s).slice(0, 160), cache_control: s?.cache_control ?? null, hasMarker: textOf(s).includes("CALLER-SYSTEM-MARKER") })),
    systemDigest: sha(sysTexts.join("\u0000")),
    systemBlockDigests: sysTexts.map(sha),
    identitySentence: (sysTexts.join("\n").match(IDENTITY) ?? [null])[0],
    secondLine: (sysTexts[1] ?? "").trim().split("\n")[0].slice(0, 120) || null,
    billingLine: sysTexts.find((t) => t.startsWith("x-anthropic-billing-header")) ?? null,
    messages: Array.isArray(b.messages) ? b.messages.map((m) => ({ role: m.role, blocks: Array.isArray(m.content) ? m.content.map((c) => ({ type: c.type, len: textOf(c).length, head: (c.type === "tool_result" ? (typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "")) : textOf(c)).slice(0, 160), is_error: c.is_error ?? undefined, cache_control: c.cache_control ?? null })) : [{ type: "string", len: String(m.content ?? "").length, head: String(m.content ?? "").slice(0, 80) }] })) : null,
    messageDigest: sha(JSON.stringify(b.messages ?? null)),
    tools: Array.isArray(b.tools) ? b.tools.map((t) => t.name) : null,
    toolsDigest: sha(JSON.stringify(Array.isArray(b.tools) ? b.tools.map((t) => t.name) : null)),
    metadataKeys: b.metadata ? Object.keys(b.metadata) : null,
    metadataUserIdKeys: (() => { try { return Object.keys(JSON.parse(b.metadata?.user_id ?? "")); } catch { return null; } })(),
    thinking: b.thinking ?? null, context_management: b.context_management ?? null,
    // `output_config` / `output_format` both observed in the wild; keep whichever the binary sends
    output_config: b.output_config ?? null, output_format: b.output_format ? Object.keys(b.output_format) : null,
    stream: b.stream ?? null, max_tokens: b.max_tokens ?? null,
    // does the binary emit any client-side correlation field yet? (spec G9 `cc_*` / cch)
    ccFieldHits: ["cch", "cc_prev_req", "cc_prompt_id", "cc_turn_origin", "cc_session_id"].filter((k) => raw.includes(k)),
    bodyDigest: sha(raw),
  };
};
const stdoutTypes = stdout.split("\n").filter(Boolean).map((l) => { try { const j = JSON.parse(l); return j.type + (j.subtype ? `/${j.subtype}` : ""); } catch { return "non-json"; } });
// system/init is the authoritative session/documentation event (spec §7 G4: session_id must equal the one we passed)
let init = null;
for (const line of stdout.split("\n")) {
  if (!line.trim()) continue;
  try { const j = JSON.parse(line); if (j.type === "system" && j.subtype === "init") { init = j; break; } } catch { /* non-json */ }
}
const initInfo = init ? {
  sessionId: init.session_id ?? null, model: init.model ?? null, permissionMode: init.permissionMode ?? null,
  apiKeySource: init.apiKeySource ?? null, cwdIsWork: String(init.cwd ?? "") === work, tools: Array.isArray(init.tools) ? init.tools.length : null,
  mcpServers: Array.isArray(init.mcp_servers) ? init.mcp_servers.map((s) => ({ name: s.name, status: s.status })) : null,
  outputStyle: init.output_style ?? null, keys: Object.keys(init),
} : null;
const evidence = {
  gate, tag: tag || null, binaryVersion: "2.1.312", model: MODEL, promptLen: PROMPT.length, sampledAt: new Date().toISOString(), durationMs: Date.now() - started, exitCode: code,
  killed, killedAfterMs: killedAt ? killedAt - started : null, killReason,
  args: args.map((a) => (a.startsWith("/") ? "<tmp-path>" : a)),
  env: Object.keys(env).filter((k) => !/PATH|HOME|TMPDIR|CONFIG/),
  init: initInfo,
  requests: cap.requests.map(describe),
  otherEndpoints: cap.requests.filter((r) => !r.url.startsWith("/v1/messages")).map((r) => `${r.method} ${r.url}`),
  connectAttempts: cap.connects,
  stdoutTypes, stdoutTail: stdout.split("\n").filter(Boolean).slice(-3).map((l) => l.slice(0, 300)), stderrTail: stderr.split("\n").filter(Boolean).slice(-6).map((l) => l.slice(0, 300)),
};
// tool-execution trace for the G5 gates (how often was the parked tool actually (re)executed?)
if (needsMcp) {
  const lines = readLog(mcpLog).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  evidence.mcpTrace = { calls: lines.filter((l) => l.event === "tools/call").length, methods: lines.map((l) => l.method).filter(Boolean) };
  const transcript = join(cfg, "projects", String(work).replace(/[^a-zA-Z0-9]/g, "-").replace(/^-/, "-"), `${SESSION}.jsonl`);
  evidence.transcriptPresent = lines.length > 0 ? (() => { try { return readLog(transcript).split("\n").filter(Boolean).length; } catch { return 0; } })() : 0;
}
evidence.digest = createHash("sha256").update(JSON.stringify({ requests: evidence.requests, otherEndpoints: evidence.otherEndpoints })).digest("hex").slice(0, 16);
writeFileSync(join(outDir, tag ? `${gate}-${tag}.json` : `${gate}.json`), scrub(JSON.stringify(evidence, null, 1)));
cap.save(join(home, `raw-capture-${gate}${tag ? "-" + tag : ""}.json`));
console.log(JSON.stringify({ gate, tag: tag || null, exitCode: code, killed, killReason, requests: cap.requests.length, messagesCalls: cap.requests.filter((r) => r.url.startsWith("/v1/messages")).length, other: evidence.otherEndpoints, connects: cap.connects.length, init: initInfo, stdoutTypes, stderrTail: evidence.stderrTail, digest: evidence.digest }, null, 1));
if (process.env.CC_PROBE_KEEP === "1" || reuse) console.log(JSON.stringify({ home, session: SESSION })); else rmSync(home, { recursive: true, force: true });
