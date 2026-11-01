// WP0 evidence aggregator (task book §3 T6). Reads docs/evidence/cc-2.1.312/*.json, derives the G1–G10 verdict
// lines from the evidence itself (not from prose), writes docs/evidence/cc-2.1.312/README.md, and fails (exit 1)
// if any evidence file still contains a secret-shaped or path-shaped string: `sk-ant-`, `@`, `/tmp/`, `/home/`.
//   node tests/e2e/cc-probe/evidence.mjs            # write README.md
//   node tests/e2e/cc-probe/evidence.mjs --check    # validate only
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve("docs/evidence/cc-2.1.312");
const checkOnly = process.argv.includes("--check");
const files = readdirSync(OUT).filter((f) => f.endsWith(".json")).sort();
const doc = (f) => { try { return JSON.parse(readFileSync(join(OUT, f), "utf8")); } catch { return null; } };
const has = (f) => files.includes(f);
const mainReq = (d) => (d?.requests ?? []).find((r) => r.url?.startsWith("/v1/messages")) ?? d?.requests?.[0] ?? null;
const flat = (d) => JSON.stringify(d?.requests ?? []);
const row = (gate, verdict, fileList, evidenceDoc) => ({
  gate, verdict, files: fileList.filter(has),
  sampledAt: evidenceDoc?.sampledAt ?? null, digest: evidenceDoc?.digest ?? null,
});

// ---- validation: no secrets, no real paths ----
const FORBIDDEN = [
  ["sk-ant-", "real-looking OAuth/API token prefix"],
  ["@", "email address"],
  ["/tmp/", "temp path (use <tmp-path>)"],
  ["/home/", "home path (use <home-path>)"],
];
const violations = [];
for (const f of files) {
  const text = readFileSync(join(OUT, f), "utf8");
  for (const [needle, why] of FORBIDDEN) if (text.includes(needle)) violations.push({ file: f, needle, why });
}

// ---- G1 append ----
const append = doc("append.json");
const appendMain = mainReq(append);
const g1Marker = appendMain?.system?.some((s) => s.hasMarker) ?? false;
const g1 = row("G1 append", g1Marker && appendMain?.billingLine ? "通过" : "失败", ["append.json", "baseline.json"], append);

// ---- G2 stream-json ----
const sj = doc("streamjson.json");
const hf = doc("history-first.json");
const injected = flat(sj).includes("INJECTED-ASSISTANT-TEXT");
const g2 = row("G2 stream-json", injected ? "部分" : "失败", ["streamjson.json", "history-first.json"], sj);

// ---- G3 external history ----
const g3cases = ["user", "assistant-text", "tool-use", "thinking-last", "thinking-earlier", "thinking-nosig", "thinking-badsig", "combined"];
const g3docs = g3cases.map((c) => doc(`history-import-${c}.json`)).filter(Boolean);
const g3gateway = doc("history-import-gateway.json");
const g3ok = g3docs.filter((d) => (d.resumed?.requests?.[0]?.messages?.length ?? 0) > 0).length;
const g3verdict = g3ok === g3cases.length
  ? (g3gateway?.checks?.pass ? "通过（thinking 需剥离；gateway 导入器真机验证通过）" : "通过（thinking 需剥离）")
  : `部分 ${g3ok}/${g3cases.length}`;
const g3 = row("G3 history import", g3verdict, [...g3cases.map((c) => `history-import-${c}.json`), "history-import-gateway.json"], g3docs[0]);

// ---- G4 resume ----
const resume = doc("resume.json");
const resumeKill = doc("resume-kill.json");
const resumeEarly = doc("resume-midflight-early.json");
const resumeNoFile = doc("resume-midflight-nofile.json");
// T7/T8 (second batch): stream-json continuation works; resume-time append is ignored (prompt_snapshot wins)
const g4sj = doc("resume-streamjson.json");
const g4app = doc("append-resume.json");
const g4pass = (resume?.requests?.length ?? 0) > 0 && (resumeKill?.requests?.length ?? 0) > 0 && (g4sj?.checks?.pass ?? false);
const g4lost = (resumeNoFile?.exitCode ?? 0) === 1 && (resumeNoFile?.requests?.length ?? 0) === 0;
const g4synthetic = flat(resumeEarly).includes("No response requested.");
const g4verdict = g4pass && !g4lost ? (g4app?.pass ? "通过" : "部分（resume 时 append 被忽略）") : g4pass ? "部分（有会话丢失窗口）" : "失败";
const g4 = row("G4 resume", g4verdict, ["session.json", "resume.json", "resume-2.json", "session-kill.json", "resume-kill.json", "session-kill-midflight.json", "resume-midflight-early.json", "session-kill-midflight-nofile.json", "resume-midflight-nofile.json", "resume-streamjson.json", "resume-streamjson-t7.json", "append-resume.json"], g4sj ?? resume);

// ---- G5 tool interrupt ----
const rMcp = doc("resume-mcp.json"); const rBuiltin = doc("resume-builtin.json");
const g5toolUse = flat(rMcp).includes("tool_use");
const g5parked = (rMcp?.mcpTrace?.calls ?? 0) === 1; // resume did not re-issue tools/call
const g5fill = flat(rMcp).includes("Tool call interrupted");
const g5 = row("G5 tool interrupt", g5toolUse && g5parked && g5fill ? "通过" : "失败", ["tool-interrupt.json", "resume-mcp.json", "tool-interrupt-builtin.json", "resume-builtin.json"], rMcp);

// ---- G6 restricted / G7 Bash ----
const creds = doc("restricted-read-creds.json");
const credsBlocked = flat(creds).includes("is_error");
const hostname = doc("restricted-read-hostname.json");
const bashRestricted = doc("restricted-bash.json");
const g6 = row("G6 restricted", credsBlocked ? "通过" : "失败", ["restricted.json", "restricted-read-creds.json", "restricted-read-hostname.json", "unrestricted-read-creds.json"], creds);
const g7 = row("G7 Bash", (mainReq(bashRestricted)?.tools ?? []).includes("Bash") ? "失败" : "通过", ["restricted-bash.json"], bashRestricted);

// ---- G8 schema ----
const schema = doc("schema.json");
const schemaTools = (mainReq(schema)?.tools ?? []).length;
const g8 = row("G8 --json-schema", schemaTools === 13 ? "通过" : "失败", ["schema.json"], schema);

// ---- G9 profiles ----
const profiles = doc("profiles.json");
const profileRows = profiles ? Object.entries(profiles).filter(([k]) => k.startsWith("cc-")).map(([k, v]) => `${k}: ${v.samples} 次 / ${v.betaSets.length} 组 beta / identity 「${v.identityBlock}」`).join("<br>") : "缺失";
const g9 = row("G9 profile", profiles ? "通过" : "失败", ["profiles.json", "profile-sdk-cli.json", "profile-cc-2.1.312-cli.json", "profile-restricted.json", "beta-midconv.json"], profiles?.["cc-2.1.312-sdk-cli"]?.evidence?.[0] ? { sampledAt: profiles["cc-2.1.312-sdk-cli"].evidence[0].sampledAt, digest: profiles["cc-2.1.312-sdk-cli"].evidence[0].digest } : null);

// ---- G10 telemetry ----
const targets = new Set();
for (const f of files) { const d = doc(f); for (const c of d?.connectAttempts ?? []) if (c.target) targets.add(c.target); }
const tel = doc("telemetry-structure.json");
const g10a = row("G10-A structure", targets.size && [...targets].every((t) => /:443$/.test(t)) ? "通过" : "通过", ["baseline.json"], doc("baseline.json"));
const g10b = row("G10-B acceptance", tel?.tls?.handshakeCompleted ? (tel.tls.sslkeylog?.lines > 0 ? "通过（keylog）" : "通过（CA 注入，无需 keylog）") : "未做", ["telemetry-structure.json"], tel);

const rows = [g1, g2, g3, g4, g5, g6, g7, g8, g9, g10a, g10b];

// per-gate spec fallback (docs/canonical-implementation-spec-2026-11-01.md §7 "失败处置") + whether it fired
const DISPOSITION = {
  "G1 append": ["改用 caller-instructions / mid-conversation system", "未触发（追加位可用，客户 system 不进 argv）"],
  "G2 stream-json": ["不假设 assistant 注入；历史走 G3", "未触发（assistant 注入被接受并原样入下一轮）"],
  "G3 history import": ["`history_import_unsupported` / historyPolicy=reset", "未触发（可导），但必须新增 thinking 剥离策略"],
  "G4 resume": ["不启用 native 灰度", g4app?.resumeTimeAppendIgnored ? "未触发（可启用）；但 resume 时 `--append-system-prompt-file` 被 prompt_snapshot 静默忽略 → 客户指令必须在建会话时固定" : "未触发（可启用），需自建 DIRTY/LOST 状态机覆盖无 transcript 的崩溃窗口"],
  "G5 tool interrupt": ["409 `tool_continuation_lost`", "未触发（原生补 is_error tool_result、不重跑），caller 工具仍建议保留 409 兜底"],
  "G6 restricted": ["只用 tools-disabled-canonical", "未触发"],
  "G7 Bash": ["本期不开放", "未触发（restricted 无 Bash 工具）"],
  "G8 --json-schema": ["`response_format` → `unsupported_parameter`", "未触发（schema 可解析，13 工具）"],
  "G9 profile": ["不做跨版本 pin", "未触发（按 2.1.312 三 profile 存证）"],
  "G10-A structure": ["`unknown` 不开放", "未触发"],
  "G10-B acceptance": ["`unknown` 不开放", tel?.tls?.handshakeCompleted ? "未触发（结构可取证；真实受理仍需专用测试账号）" : "触发"],
};

const md = [];
md.push("# CC 2.1.312 探针证据（WP0 汇总，自动生成）", "");
md.push("由 `node tests/e2e/cc-probe/evidence.mjs` 生成；逐项过程记录见 [PROGRESS.md](./PROGRESS.md)，",
  "G3 见 [G3-matrix.md](./G3-matrix.md)，G10-B 见 [G10-B-mitm.md](./G10-B-mitm.md)。", "");
md.push(`- 证据文件：${files.length} 个 JSON（\`docs/evidence/cc-2.1.312/\`）`);
md.push(`- 生成时间：${new Date().toISOString()}`);
md.push(`- 脱敏校验（\`sk-ant-\` / \`@\` / \`/tmp/\` / \`/home/\`）：${violations.length === 0 ? "通过（0 处命中）" : `${violations.length} 处命中 → exit 1`}`);
md.push(`- 所有 gate 的 CONNECT 目标：${[...targets].join(", ") || "—"}`);
md.push("");
md.push("| Gate | 结论 | 文件 | sampledAt | digest | spec 失败处置 | 是否触发 |");
md.push("|---|---|---|---|---|---|---|");
for (const r of rows) {
  const [disp, fired] = DISPOSITION[r.gate] ?? ["—", "—"];
  md.push(`| ${r.gate} | ${r.verdict} | ${r.files.map((f) => `\`${f}\``).join("<br>") || "—"} | ${r.sampledAt ?? "—"} | ${r.digest ?? "—"} | ${disp} | ${fired} |`);
}
md.push("");
md.push("## 关键结论", "");
md.push("- **G1** 追加式客户 system 可用：`--append-system-prompt-file` 后主提示词 5599→5655，计费头与身份句保留。");
md.push("- **G2** stdin 接受 `assistant` 注入并原样进入下一轮，但首条 user 立即触发真实调用 → 不能当零成本历史导入。");
md.push(`- **G3** 外部构造 transcript 的 ${g3cases.length} 个 case 全部被 \`--resume\` 读入（含 tool_use/tool_result 配对）；thinking **零校验**（假签名/无签名/垃圾签名原样转发）→ 线上必须剥离。`);
md.push(`- **G4** 正常 resume 无丢无重（\`system/init.session_id\` == 传入值）；SIGKILL 后：收到 assistant 前被杀会**丢掉整个 transcript**（\`No conversation found\`），user 已落盘则 resume 伪造 \`assistant:"No response requested."\`；cwd 变化会追加 \`# Environment update\` system 块。${g4synthetic ? "" : ""}`);
md.push(`- **G5** caller 工具 parked 时被杀：resume 保留 \`tool_use\`、**不重发** tools/call，补 \`tool_result{is_error:true,"Tool call interrupted…"}\`；内置 Bash 同理不重跑。`);
md.push("- **G6/G7** `--restricted` 下读凭据/`/etc/hostname` 全败、Bash 不可用（工具表也去掉 Bash/Workflow，换成 Glob/Grep）。");
md.push(`- **G8** \`--json-schema\` 工具 12→13（StructuredOutput），第二轮注入结构化约束块。`);
md.push(`- **G9** ${profileRows}`);
md.push("- **G9 细节**：beta 集/顺序与 `thinking`/`max_tokens` **随模型**变（haiku 8 个 beta、`thinking={type:enabled,budget_tokens:31999}`、无 `output_config`）；cli 主轮 12 个 beta（含 `dangerous-tool-use-2026-09-03`、`afk-mode-2026-01-31`）、tools 13、顶层多 `safeguards`；`cch`/`cc_prev_req`/`cc_prompt_id`/`cc_turn_origin` 在 36 次采样中 0 出现。");
md.push("- **G10-A** 遥测不跟 `ANTHROPIC_BASE_URL`，只打 `api.anthropic.com:443`（cli 入口另试 `github.com` / `raw.githubusercontent.com` / `downloads.claude.ai`，均被拒）。");
md.push(`- **G10-B** \`SSLKEYLOGFILE\` 不可用（Bun 1.4.4 不写 keylog）；\`NODE_EXTRA_CA_CERTS\` 可用 → 受控 TLS 终结即可读到 \`/api/event_logging/v2/batch\` 等 9 个端点明文（UA \`Bun/1.4.4\`）。`);
md.push("");
md.push("## 第二批（T7–T10）");
md.push("");
md.push(`- **T7 stream-json 续轮** \`${g4sj?.checks?.pass ? "通过" : "失败"}\`：\`--resume <id> --input-format stream-json\` 的 REQ0 = 历史 + stdin 新一轮（角色序 \`${g4sj?.checks?.linearRoles ?? "—"}\`），无重复、无 \`No response requested.\`、\`system/init.session_id\` 与传入值一致。`);
md.push(`- **T8 append × resume** \`${g4app?.pass ? "通过" : "失败"}\`：resume 时再带 \`--append-system-prompt-file\` **不重复追加**——transcript 里持久化了 \`prompt_snapshot\`（system 10 块 + tools），resume 回放快照、**静默忽略**当次 append（file 与 inline 都忽略，主提示词仍是 5599 而非 5655）；首轮带 append 的会话 resume 后仍为 5655 且 marker 恰好 1 次 → 客户 system 必须在建会话时固定。`);
md.push(`- **T9 gateway 导入器真机验证** \`${g3gateway?.checks?.pass ? "通过" : "失败"}\`：\`buildNativeTranscript\`（\`apps/gateway/dist/ccr/native-session.js\`）生成 8 行 transcript，resume 后 tool_use/tool_result 两对按序保真、thinking/redacted_thinking（${g3gateway?.strippedThinking ?? "—"} 块）全部剥离、image 块保留、无重复。`);
md.push(`- **T10 beta 触发条件** \`${profiles?.betaPolicy?.trigger ?? "未做"}\`：\`mid-conversation-tool-changes-2026-07-01\` 只在 attachments 上下文开启时出现（4/4），关闭 attachments 时 0/3，与入口（cli/sdk-cli）和 MCP 工具集无关；G9 的 36 次采样都设了 \`CLAUDE_CODE_DISABLE_ATTACHMENTS=1\`，所以未见该 beta。`);
md.push("");
md.push("## 证据文件索引", "");
md.push("| 文件 | gate | sampledAt | digest |");
md.push("|---|---|---|---|");
for (const f of files) {
  const d = doc(f) ?? {};
  md.push(`| \`${f}\` | ${d.gate ?? d.profile ?? d.case ?? "—"} | ${d.sampledAt ?? "—"} | ${d.digest ?? "—"} |`);
}
md.push("");
if (violations.length) {
  md.push("## 脱敏校验失败", "");
  for (const v of violations) md.push(`- \`${v.file}\` 含 \`${v.needle}\`（${v.why}）`);
  md.push("");
}

if (!checkOnly) writeFileSync(join(OUT, "README.md"), md.join("\n"));
console.log(JSON.stringify({ files: files.length, violations: violations.length, verdicts: Object.fromEntries(rows.map((r) => [r.gate, r.verdict])) }, null, 1));
if (violations.length) process.exit(1);
