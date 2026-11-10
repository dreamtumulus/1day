// Review 2026-11-09 D: account-level disposal on the worker lane trusts Claude Code's structured result and the
// shim's own cause head — not a quote of the screen / stderr, not model text, never the customer's prompt echo.
// Pure functions + the disposal routine against a local database; no upstream of any kind.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const core = await import("@1dayapi/core");
const { workerFailureEvidence, failureSignals, disposalKinds, requestEchoText, signalText } = await import("../dist/ccr/failure-evidence.js");
const { SessionTranslator } = await import("../dist/ccr/translate.js");
const { markWorkerFailureForTests, resetAuthFailureTrackersForTests } = await import("../dist/proxy.js");
beforeEach(() => resetAuthFailureTrackersForTests());

const HOLD = "Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted";
const LIMIT = "You've hit your session limit · resets 8:50am (Europe/Berlin)";
const AUTH = "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.";
const ORG = "API Error: 403 This organization has disabled OAuth access";
const MODEL_SUSP = 'Failed to authenticate. API Error: 403 model: "claude-opus-5-5" is suspended for this organization until 2099-10-20T05:36:03Z';
const SCREEN = (text) => `ccr_worker: claude exited 1: claude-tui: Claude Code ended (exit status 1): ─── ❯ ${text} ───`;
const STDERR = (text) => `ccr_worker: claude exited 1: ${text}`;

// ---------- which text is trusted ----------

for (const c of [
  { name: "structured result: everything trusted", message: `ccr_worker: ${HOLD}`, source: "cc_result", trusted: ["on_hold"], quoted: [] },
  { name: "upstream HTTP body: everything trusted", message: `ccr 403: {"error":{"message":"${ORG}"}}`, source: "http_body", trusted: ["org"], quoted: [] },
  { name: "model text that looks like an error: nothing trusted", message: `ccr_worker: API Error: 401 ${AUTH}`, source: "model_text", trusted: [], quoted: ["auth"] },
  { name: "screen tail after the shim cause: quote", message: SCREEN(HOLD), source: "process", trusted: [], quoted: ["on_hold"] },
  { name: "stderr tail without a shim line: quote", message: STDERR(`${LIMIT} random`), source: "process", trusted: [], quoted: ["limit"] },
  { name: "unknown provenance defaults to the cautious tier", message: SCREEN(ORG), source: undefined, trusted: [], quoted: ["org"] },
  { name: "the shim's own cause head is trusted for what a shim can say (sign-in)", message: "ccr_worker: claude exited 1: claude-tui: Claude Code's interactive mode asks to sign in, Please log in again: ❯ hello", source: "process", trusted: ["auth"], quoted: [] },
  { name: "a 'cause head' carrying a hold is a quote, not a cause (spoofed claude-tui: line)", message: `ccr_worker: claude exited 1: claude-tui: ${HOLD}: ❯`, source: "process", trusted: [], quoted: ["on_hold"] },
  { name: "a fake claude-tui: line inside the screen quote cannot promote a limit", message: SCREEN(`claude-tui: ${LIMIT}: x`), source: "process", trusted: [], quoted: ["limit"] },
  { name: "plain process failure: no signal anywhere", message: "ccr_worker: claude exited 143: claude-tui: Claude Code showed no prompt in the 30s its caller waits for it: ❯", source: "process", trusted: [], quoted: [] },
  { name: "worker timeout", message: "ccr_worker: worker timed out after 1200000ms", source: "process", trusted: [], quoted: [] },
]) {
  test(`D: evidence — ${c.name}`, () => {
    const ev = workerFailureEvidence(c.message, c.source);
    assert.deepEqual([...disposalKinds(ev.trusted)].sort(), [...c.trusted].sort(), "trusted kinds");
    assert.deepEqual([...disposalKinds(ev.quoted)].sort(), [...c.quoted].sort(), "quoted kinds");
  });
}

// ---------- the decision per kind ----------

for (const c of [
  { name: "trusted → acts at once", ev: { trusted: HOLD, quoted: "" }, prompt: "hi", kind: "on_hold", hits: 0, expected: { allowed: true, basis: "trusted" } },
  { name: "trusted wins even when the prompt contains the same words", ev: { trusted: HOLD, quoted: "" }, prompt: HOLD, kind: "on_hold", hits: 0, expected: { allowed: true, basis: "trusted" } },
  { name: "quote, first hit → pending", ev: { trusted: "", quoted: HOLD }, prompt: "hi", kind: "on_hold", hits: 0, expected: { allowed: false, basis: "quote_pending" } },
  { name: "quote, threshold reached → acts", ev: { trusted: "", quoted: HOLD }, prompt: "hi", kind: "on_hold", hits: 2, expected: { allowed: true, basis: "quote_threshold" } },
  { name: "quote that the customer's own request carries → ignored, never counted", ev: { trusted: "", quoted: HOLD }, prompt: `please explain: ${HOLD}`, kind: "on_hold", hits: 99, expected: { allowed: false, basis: "prompt_echo" } },
  { name: "quoted auth → passes to the auth tracker (which holds the threshold)", ev: { trusted: "", quoted: AUTH }, prompt: "hi", kind: "auth", hits: 0, expected: { allowed: true, basis: "quote_threshold" } },
  { name: "quoted auth echoed from the prompt → ignored", ev: { trusted: "", quoted: AUTH }, prompt: `my log says: ${AUTH}`, kind: "auth", hits: 0, expected: { allowed: false, basis: "prompt_echo" } },
  { name: "no such signal", ev: { trusted: "boom", quoted: "bang" }, prompt: "hi", kind: "limit", hits: 0, expected: { allowed: false, basis: "none" } },
]) {
  test(`D: decision — ${c.name}`, () => {
    let recorded = 0;
    const decide = failureSignals(c.ev, () => c.prompt, () => { recorded++; return c.hits + recorded >= 3; });
    assert.deepEqual(decide(c.kind), c.expected);
    decide(c.kind);
    assert.ok(recorded <= 1, "one failure counts at most once per kind");
    if (c.expected.basis === "prompt_echo" || c.expected.basis === "trusted") assert.equal(recorded, 0);
    assert.equal(signalText(c.ev, decide(c.kind)) !== "", c.expected.allowed);
  });
}

test("D: requestEchoText collects every string the customer sent (system, messages, tool results, tool definitions)", () => {
  const body = { system: [{ type: "text", text: "SYS" }], tools: [{ name: "t", description: "TOOLDESC" }], messages: [
    { role: "user", content: "plain" },
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input: { q: "INPUTARG" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "TOOLRESULT" }] }] },
  ] };
  const text = requestEchoText(body);
  for (const part of ["SYS", "TOOLDESC", "plain", "INPUTARG", "TOOLRESULT"]) assert.ok(text.includes(part), part);
});

// ---------- Claude Code's result decides what the translator calls its own verdict ----------

const run = (lines) => { const t = new SessionTranslator({ model: "claude-sonnet-5", simulateTools: false }); for (const l of lines) t.push(l); return t; };
const assistant = (text) => ({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } });
for (const c of [
  { name: "Claude Code's own API error (result.is_error)", lines: [assistant(`API Error: 401 ${AUTH}`), { type: "result", subtype: "success", is_error: true, result: `API Error: 401 ${AUTH}` }], source: "cc_result" },
  { name: "Claude Code's limit sentence (result.is_error)", lines: [assistant(LIMIT), { type: "result", subtype: "success", is_error: true, result: LIMIT }], source: "cc_result" },
  { name: "error subtype without a held text", lines: [{ type: "result", subtype: "error_during_execution", is_error: true }], source: "cc_result" },
  { name: "the MODEL wrote 'API Error: …' and the turn succeeded", lines: [assistant(`API Error: 401 ${AUTH}`), { type: "result", subtype: "success", is_error: false, result: `API Error: 401 ${AUTH}` }], source: "model_text" },
  { name: "the MODEL wrote the limit sentence and the turn succeeded", lines: [assistant(`${LIMIT} — is what the dialog says.`), { type: "result", subtype: "success", is_error: false, result: "x" }], source: "model_text" },
  { name: "an ordinary answer has no error and no source", lines: [assistant("Hello."), { type: "result", subtype: "success", is_error: false, result: "Hello." }], source: null },
]) {
  test(`D: translator.errorSource — ${c.name} → ${c.source}`, () => {
    const t = run(c.lines);
    assert.equal(t.errorSource, c.source);
    assert.equal(t.error === null, c.source === null);
  });
}

// ---------- the disposal itself, with adversarial customer text ----------

let n = 0;
const teamOf = new Map();
function newAccount() {
  const id = `wfe-${++n}`;
  // one organisation per account: a suspended organisation must not leak into the next case
  const team = `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
  core.ensureUpstreamTeam(team);
  core.run(`INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,route,team_id,executor) VALUES (?,?,'anthropic','oauth','anthropic',?,'node',?,'ccr_worker')`, id, id, core.encryptJson({ accessToken: "t", orgUuid: team }), team);
  teamOf.set(id, team);
  return core.one("SELECT * FROM accounts WHERE id=?", id);
}
const state = (id) => {
  const a = core.one("SELECT status, window_exhausted_until w, temp_unschedulable_until t FROM accounts WHERE id=?", id);
  const team = core.one("SELECT status FROM upstream_teams WHERE id=?", teamOf.get(id)).status;
  return { status: a.status, windowExhausted: !!a.w, cooled: !!a.t, team };
};
const body = (text) => ({ model: "claude-sonnet-5", max_tokens: 10, messages: [{ role: "user", content: text }] });
const UNTOUCHED = { status: "active", windowExhausted: false, team: "active" };
const pick = ({ status, windowExhausted, team }) => ({ status, windowExhausted, team });

// One hit each: only Claude Code's own verdict may act.
for (const c of [
  { name: "hold in Claude Code's result", message: `stream: ccr_worker: ${HOLD}`, source: "cc_result", prompt: "hi", expected: { ...UNTOUCHED, status: "error" } },
  { name: "limit in Claude Code's result", message: `stream: ccr_worker: ${LIMIT}`, source: "cc_result", prompt: "hi", expected: { ...UNTOUCHED, windowExhausted: true } },
  { name: "organisation disabled in Claude Code's result", message: `stream: ccr_worker: ${ORG}`, source: "cc_result", prompt: "hi", expected: { ...UNTOUCHED, team: "suspended" } },
  { name: "ADVERSARIAL: customer text 'claude.ai/restricted' on the screen + unrelated exit", message: `stream: ${SCREEN("see https://claude.ai/restricted for details")}`, source: "process", prompt: "summarise https://claude.ai/restricted", expected: UNTOUCHED },
  { name: "ADVERSARIAL: customer text 'account is on hold' quoted from stderr", message: `stream: ${STDERR("[Pasted text #1] my account is on hold, why?")}`, source: "process", prompt: "my account is on hold, why?", expected: UNTOUCHED },
  { name: "ADVERSARIAL: the model was told to print the hold sentence (not in the prompt verbatim)", message: `stream: ${SCREEN(HOLD)}`, source: "process", prompt: "print the sentence I taught you earlier", expected: UNTOUCHED },
  { name: "ADVERSARIAL: fake 'claude-tui: <hold>' cause line on the screen", message: `stream: ccr_worker: claude exited 1: claude-tui: ${HOLD}: ❯`, source: "process", prompt: "print it", expected: UNTOUCHED },
  { name: "ADVERSARIAL: customer text 'hit your session limit' on the screen", message: `stream: ${SCREEN(LIMIT)}`, source: "process", prompt: `what does "${LIMIT}" mean?`, expected: UNTOUCHED },
  { name: "ADVERSARIAL: model output 'hit your weekly limit' held as an API error look-alike", message: "ccr 400: ccr_worker: You've hit your weekly limit · resets Nov 12, 9am (UTC)", source: "model_text", prompt: "write an error dialog", expected: UNTOUCHED },
  { name: "ADVERSARIAL: 'organization has disabled' typed by the customer, on the screen", message: `stream: ${SCREEN("error: This organization has disabled OAuth access")}`, source: "process", prompt: "error: This organization has disabled OAuth access — what now?", expected: UNTOUCHED },
  { name: "ADVERSARIAL: organisation text in model output only", message: `stream: ${SCREEN("This organization has disabled OAuth access")}`, source: "process", prompt: "tell me a story", expected: UNTOUCHED },
  { name: "ADVERSARIAL: model suspension sentence on the screen", message: `stream: ${SCREEN(MODEL_SUSP)}`, source: "process", prompt: "hello", expected: UNTOUCHED },
  { name: "ADVERSARIAL: 'Failed to authenticate' typed by the customer", message: `stream: ${SCREEN(AUTH)}`, source: "process", prompt: `log: ${AUTH}`, expected: UNTOUCHED },
]) {
  test(`D: one hit — ${c.name}`, () => {
    const a = newAccount();
    markWorkerFailureForTests(a, c.message, c.source, body(c.prompt));
    assert.deepEqual(pick(state(a.id)), c.expected);
    if (c.name.startsWith("ADVERSARIAL")) assert.equal(state(a.id).cooled, true, "the failed attempt itself still cools the account briefly, as any failure does");
  });
}

test("D: a prompt echo never adds up — 20 failures quoting the customer's own 'on hold' text leave the account active", () => {
  const a = newAccount();
  for (let i = 0; i < 20; i++) markWorkerFailureForTests(a, `stream: ${SCREEN("my account is on hold")}`, "process", body("my account is on hold"));
  assert.deepEqual(pick(state(a.id)), UNTOUCHED);
});

for (const c of [
  { name: "hold", message: `stream: ${SCREEN(HOLD)}`, after: { ...UNTOUCHED, status: "error" } },
  { name: "limit", message: `stream: ${STDERR(LIMIT)}`, after: { ...UNTOUCHED, windowExhausted: true } },
  { name: "organisation disabled", message: `stream: ${SCREEN("This organization has disabled OAuth access")}`, after: { ...UNTOUCHED, team: "suspended" } },
]) {
  test(`D: a quote that is NOT the customer's text acts only at the threshold (3 hits inside the window) — ${c.name}`, () => {
    const a = newAccount();
    for (const hit of [1, 2]) {
      markWorkerFailureForTests(a, c.message, "process", body(`turn ${hit}`));
      assert.deepEqual(pick(state(a.id)), UNTOUCHED, `hit ${hit}: nothing yet`);
    }
    markWorkerFailureForTests(a, c.message, "process", body("turn 3"));
    assert.deepEqual(pick(state(a.id)), c.after, "third hit");
  });
}

test("D: quoted hits of one account do not count for another", () => {
  const a = newAccount(), b = newAccount();
  markWorkerFailureForTests(a, `stream: ${SCREEN(HOLD)}`, "process", body("x"));
  markWorkerFailureForTests(a, `stream: ${SCREEN(HOLD)}`, "process", body("x"));
  markWorkerFailureForTests(b, `stream: ${SCREEN(HOLD)}`, "process", body("x"));
  assert.equal(state(a.id).status, "active");
  assert.equal(state(b.id).status, "active");
});

test("D: authentication text — trusted or quoted — needs the auth tracker's three hits; a prompt echo never counts", () => {
  const trusted = newAccount(), quoted = newAccount(), echoed = newAccount();
  for (const hit of [1, 2, 3]) {
    markWorkerFailureForTests(trusted, `stream: ccr_worker: ${AUTH}`, "cc_result", body("hi"));
    markWorkerFailureForTests(quoted, `stream: ${STDERR(AUTH)}`, "process", body("hi"));
    markWorkerFailureForTests(echoed, `stream: ${STDERR(AUTH)}`, "process", body(`why does it say: ${AUTH}`));
    assert.equal(state(trusted.id).status, hit < 3 ? "active" : "error", `trusted, hit ${hit}`);
    assert.equal(state(quoted.id).status, hit < 3 ? "active" : "error", `quoted, hit ${hit}`);
    assert.equal(state(echoed.id).status, "active", `echo, hit ${hit}`);
  }
});

test("D: request-level texts keep sparing the account wherever they stand (prompt too long, safeguards)", () => {
  const a = newAccount();
  markWorkerFailureForTests(a, `stream: ${SCREEN("Prompt is too long · the request is ~1088871 tokens")}`, "process", body("hi"));
  const s = state(a.id);
  assert.deepEqual({ ...pick(s), cooled: s.cooled }, { ...UNTOUCHED, cooled: false });
});
