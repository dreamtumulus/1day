// 2026-11-01 audit follow-ups on the direct path and the API surface:
//  A2  gate → normalizeCcSoftware → buildUpstreamRequest for a customer-made entrypoint (one switch, both ends)
//  A4  the customer's `# userEmail` reminder never leaves the platform
//  B3  every platform 429 / 503 carries Retry-After
//  B5  fields a path cannot honour are named in x-1day-ignored-params
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-hygiene-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("@1dayapi/core");
const { buildUpstreamRequest, stripUserEmail } = await import("../dist/upstream.js");
const { sendError } = await import("../dist/http.js");
const { ignoredParams } = await import("../dist/proxy.js");

const SID = "3f2c1a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const account = { id: "acc-x", name: "sub", platform: "anthropic", type: "oauth", protocol: "anthropic", executor: "ccr_worker", base_url: null, models: null, model_mapping: null, route: "node", raw_passthrough: 0, device_id: "d".repeat(64), account_uuid: "11111111-2222-4333-8444-555555555555" };
const messages = [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is customer@example.com. Use it only to identify the user.\n</system-reminder>" }, { type: "text", text: "Reply with the single word OK." }] }];
const mirasimHeaders = {
  "user-agent": "claude-cli/2.1.312 (external, mirasim)",
  "x-app": "cli",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
  "anthropic-version": "2023-06-01",
  accept: "application/json",
  "x-stainless-lang": "js",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.12.1",
  "x-stainless-package-version": "0.128.0",
  "x-claude-code-session-id": SID,
};
const mirasimBody = {
  model: "claude-sonnet-5-5",
  max_tokens: 64,
  stream: true,
  messages,
  system: [
    { type: "text", text: `x-anthropic-billing-header: cc_version=2.1.312.${core.ccBuildSuffix(messages)}; cc_entrypoint=mirasim;` },
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
  ],
  metadata: { user_id: JSON.stringify({ device_id: "c".repeat(64), account_uuid: "", session_id: SID }) },
};

test("A2: with direct_cc_entrypoint_normalize=1 (default) a mirasim-shaped request passes the gate and leaves as (external, cli)", () => {
  const allow = core.getSetting("direct_cc_entrypoint_normalize") === "1";
  assert.equal(allow, true, "settings default");
  const shape = core.classifyCcRequest(mirasimHeaders, mirasimBody, { allowCustomEntrypoint: allow });
  assert.equal(shape.verdict, "genuine", shape.missing.join(","));
  assert.ok(shape.soft.includes("ua_entrypoint_custom"));
  const r = buildUpstreamRequest(account, { accessToken: "tok" }, "passthrough-anthropic", mirasimBody, "claude-sonnet-5-5", mirasimHeaders);
  assert.equal(r.headers["user-agent"], "claude-cli/2.1.312 (external, cli)");
  const sent = JSON.parse(r.body);
  assert.match(sent.system[0].text, /cc_entrypoint=cli;/);
  assert.match(sent.system[0].text, new RegExp(`cc_version=2\\.1\\.312\\.${core.ccBuildSuffix(messages)};`), "suffix unchanged: the forwarded first user text is the same");
  // and with the switch off the gate refuses the same request
  assert.deepEqual(core.classifyCcRequest(mirasimHeaders, mirasimBody).missing, ["ua_entrypoint"]);
});

test("A4: the customer's # userEmail reminder is dropped on the direct path; the prompt, billing suffix and other reminders stay", () => {
  const r = buildUpstreamRequest(account, { accessToken: "tok" }, "passthrough-anthropic", mirasimBody, "claude-sonnet-5-5", mirasimHeaders);
  const sent = JSON.parse(r.body);
  assert.equal(JSON.stringify(sent).includes("customer@example.com"), false);
  assert.deepEqual(sent.messages[0].content.map((b) => b.text), ["Reply with the single word OK."]);
  assert.equal(JSON.stringify(mirasimBody).includes("customer@example.com"), true, "input not mutated");
  // other reminders (CLAUDE.md, gitStatus…) are the customer's task context and stay
  const mixed = { messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nContents of CLAUDE.md:\nbe terse\n</system-reminder>" }, { type: "text", text: "<system-reminder>\n# userEmail\nThe user's email address is a@b.c.\n</system-reminder>" }, { type: "text", text: "hi" }] }] };
  assert.deepEqual(stripUserEmail(mixed).messages[0].content.map((b) => b.text), ["<system-reminder>\nContents of CLAUDE.md:\nbe terse\n</system-reminder>", "hi"]);
  // string content, reminder inline with the prompt
  const inline = { messages: [{ role: "user", content: "<system-reminder>\n# userEmail\nThe user's email address is a@b.c.\n</system-reminder>\nhello" }] };
  assert.equal(stripUserEmail(inline).messages[0].content, "hello");
  // nothing to do → same object
  const plain = { messages: [{ role: "user", content: "hello" }] };
  assert.equal(stripUserEmail(plain), plain);
  // a message that is only the reminder is left alone rather than emptied
  const only = { messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\n# userEmail\nx@y.z\n</system-reminder>" }] }] };
  assert.equal(stripUserEmail(only), only);
});

function fakeReply() {
  const headers = {};
  const r = {
    statusCode: 0,
    body: undefined,
    status(s) { r.statusCode = s; return r; },
    header(k, v) { headers[k.toLowerCase()] = String(v); return r; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    send(b) { r.body = b; return r; },
    headers,
  };
  return r;
}

test("B3: platform 429 / 503 carry Retry-After (10 s / 15 s) unless a branch set one; 4xx do not", () => {
  const a = fakeReply(); sendError(a, "anthropic", 503, "no_available_account", "m", "upstream_error");
  assert.equal(a.headers["retry-after"], "15");
  const b = fakeReply(); sendError(b, "openai-chat", 429, "quota_exhausted", "m", "rate_limit_error");
  assert.equal(b.headers["retry-after"], "10");
  const c = fakeReply(); c.header("retry-after", "30"); sendError(c, "anthropic", 503, "team_capacity_exhausted", "m", "upstream_error");
  assert.equal(c.headers["retry-after"], "30");
  const d = fakeReply(); sendError(d, "anthropic", 400, "bad", "m", "invalid_request_error");
  assert.equal(d.headers["retry-after"], undefined);
  assert.equal(d.body.type, "error");
});

test("B5: x-1day-ignored-params names only the fields present that the path cannot honour", () => {
  const anth = { model: "m", max_tokens: 1, temperature: 0.2, top_k: 5, stop_sequences: ["x"], metadata: { user_id: "u" }, thinking: { type: "enabled", budget_tokens: 100 } };
  assert.deepEqual(ignoredParams(anth, "anthropic", "ccr-anthropic"), ["temperature", "top_k"]);
  assert.deepEqual(ignoredParams(anth, "anthropic", "passthrough-anthropic"), [], "direct path honours everything");
  assert.deepEqual(ignoredParams(anth, "anthropic", "anthropic-via-chat"), ["top_k", "thinking"]);
  const chat = { model: "m", messages: [], n: 2, seed: 7, response_format: { type: "json_object" }, temperature: 0.5, stop: ["x"], tools: [] };
  assert.deepEqual(ignoredParams(chat, "openai-chat", "ccr-chat"), ["temperature", "n", "seed", "response_format"]);
  assert.deepEqual(ignoredParams(chat, "openai-chat", "chat-via-anthropic"), ["n", "seed", "response_format"]);
  assert.deepEqual(ignoredParams({ model: "m", temperature: null }, "anthropic", "ccr-anthropic"), [], "null counts as absent");
});

const { pickTeam } = await import("../dist/proxy.js");
test("A1/A3: a new conversation joins the organization with capacity, teamAffinity reorders by organization size", () => {
  const acc = (id, team, concurrency, windowUsed, extra = {}) => ({ id, team_id: team, concurrency, window_used: windowUsed, ...extra });
  const BIG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SMALL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const inflight = { b1: 4, b2: 4, b3: 4, s1: 0 };
  const teams = [acc("b1", BIG, 5, 0.9), acc("b2", BIG, 5, 0.9), acc("b3", BIG, 5, 0.9), acc("s1", SMALL, 5, 0.1)];
  const f = (id) => inflight[id] ?? 0;
  // capacity: BIG has 3 free slots at 10% headroom (score 3×0.325), SMALL has 5 free at 90% (score 5×0.925) → SMALL
  assert.equal(pickTeam(teams, null, f).teamId, SMALL);
  assert.equal(pickTeam(teams, "spread", f).teamId, BIG, "spread: larger organization first");
  assert.equal(pickTeam(teams, "pack", f).teamId, SMALL, "pack: smaller organization first");
  // cooling accounts offer no slots; an uncapped account counts as 20
  const cooled = [acc("b1", BIG, 5, 0.1, { cooling: true }), acc("s1", SMALL, 0, 0.5)];
  assert.equal(pickTeam(cooled, null, f).teamId, SMALL);
  // equal scores keep the listCandidates order (first team wins)
  const tie = [acc("x1", BIG, 2, 0.5), acc("y1", SMALL, 2, 0.5)];
  assert.equal(pickTeam(tie, null, () => 0).teamId, BIG);
  assert.match(pickTeam(teams, null, f).why, /freeSlots=5/);
});
