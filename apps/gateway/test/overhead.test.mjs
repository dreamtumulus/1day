// X-54: the platform's prompt overhead comes off the customer-visible usage on the CCR lanes — application rules
// (per upstream call, minimum visible, small-turn cap, legacy baseline as lower bound), the never-raise-a-bill
// property, the translator's call counting, and the settings / calibration glue. Pure: dist/ + a temp database.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { computeCost, overheadCalibrator, resetOverheadCalibration, setSetting, run } from "@1dayapi/core";
import { applyOverhead, customerPromptEstimate, deduct, isSmallRequest, planOverhead, recordOverheadSample } from "../dist/ccr/overhead.js";
import { SessionTranslator } from "../dist/ccr/translate.js";
import { workerOverheadLane, workerOverheadTools } from "../dist/ccr/worker.js";
import { countersSnapshot, resetCounters } from "../dist/metrics.js";

const raw = (input, read, creation5m = 0, creation1h = 0) => ({ input, read, creation5m, creation1h });
const plan = (o = {}) => ({ perCall: 29600, source: "default", key: { lane: "tui", tools: "none", model: "claude-opus-5-5", version: "2.1.322" }, matched: "tui:none:claude-opus-5-5", baseline: 700, customerEstimate: 12, small: true, calibration: true, ...o });
const visible = (a) => a.input + a.read + a.creation5m + a.creation1h;
const buckets = (a) => ({ input: a.input, read: a.read, creation5m: a.creation5m, creation1h: a.creation1h });

beforeEach(() => {
  resetOverheadCalibration();
  resetCounters();
  run("DELETE FROM settings WHERE key LIKE 'ccr_%'");
});

test("deduction order: cache read, then creation 1h, then 5m, then input", () => {
  assert.deepEqual(deduct(raw(100, 1000, 300, 200), 900), raw(100, 100, 300, 200));
  assert.deepEqual(deduct(raw(100, 1000, 300, 200), 1100), raw(100, 0, 300, 100));
  assert.deepEqual(deduct(raw(100, 1000, 300, 200), 1350), raw(100, 0, 150, 0));
  assert.deepEqual(deduct(raw(100, 1000, 300, 200), 1560), raw(40, 0, 0, 0));
  assert.deepEqual(deduct(raw(100, 1000, 300, 200), 99999), raw(0, 0, 0, 0));
});

test("production shapes of a one-sentence request: the customer sees a few dozen tokens, not ~29,000", () => {
  // TUI node, everything cached (raw = visible-today + the 700 baseline): input 0 / cache_read 29705–30243
  for (const [input, read] of [[2, 29703], [0, 30243], [1791, 27813], [3928, 26300]]) {
    const before = applyOverhead(raw(input, read), 1, null, 700);
    assert.ok(visible(before) >= 28900, "before X-54 the whole Claude Code prefix was visible");
    const after = applyOverhead(raw(input, read), 1, plan());
    assert.ok(visible(after) >= 6 && visible(after) <= 6 * 12 + 64, `visible ${visible(after)}`);
    assert.ok(after.read <= 136 && after.input <= 136, "the prefix left the cache-read bucket first, then input");
  }
  // first use on an account: the prefix is cache creation (1h) — no cache-write bill for the platform's prefix
  const first = applyOverhead(raw(3925, 0, 0, 26100), 1, plan());
  assert.deepEqual([first.creation1h, first.creation5m, first.read], [0, 0, 0]);
  assert.ok(first.input <= 136);
  // -p canonical node: 2 / 12329 and 1064 / 11267
  for (const [input, read] of [[2, 12329], [1064, 11267]]) {
    const a = applyOverhead(raw(input, read), 1, plan({ perCall: 12200, matched: "p:none" }));
    assert.equal(visible(a), 131, "12331 − 12200 = 131 visible tokens");
    assert.deepEqual(buckets(a), input === 2 ? raw(2, 129) : raw(131, 0), "read absorbs the prefix first; what read cannot absorb comes off input");
    assert.equal(a.rule, "overhead");
  }
});

test("minimum visible: over-subtraction never shows a real prompt as 0 (a 2,000-token prompt keeps at least 1,000)", () => {
  // learned overhead larger than this account's real prefix: 31,000 upstream, overhead 33,000, customer estimate 2,000
  const a = applyOverhead(raw(2000, 29000), 1, plan({ perCall: 33000, source: "learned", customerEstimate: 2000, small: false }));
  assert.equal(visible(a), 1000);
  assert.equal(a.rule, "floor");
  assert.deepEqual(buckets(a), raw(1000, 0));
  // no estimate at all: still 1 token
  assert.equal(visible(applyOverhead(raw(5, 100), 1, plan({ perCall: 9999, customerEstimate: null, small: false, baseline: 0 }))), 1);
  // nothing upstream: nothing visible
  assert.equal(visible(applyOverhead(raw(0, 0), 1, plan())), 0);
});

test("small-turn cap: a fresh one-message request is never shown more than 6 × estimate + 64, whatever the key's value", () => {
  // key not calibrated, only the 700 baseline known (e.g. -p with caller tools dropped): 12,331 upstream for a 10-token prompt
  const p = plan({ perCall: 700, source: "baseline", matched: null, customerEstimate: 10 });
  const a = applyOverhead(raw(2, 12329), 1, p);
  assert.equal(visible(a), 124);
  assert.equal(a.rule, "cap");
  // not small (history, tools round, large prompt), several calls, a pin, or calibration off: no cap
  assert.equal(visible(applyOverhead(raw(2, 12329), 1, { ...p, small: false })), 11631);
  assert.equal(visible(applyOverhead(raw(4, 24658), 2, p)), 23962);
  assert.equal(visible(applyOverhead(raw(2, 12329), 1, { ...p, source: "pinned", perCall: 700 })), 11631);
  assert.equal(visible(applyOverhead(raw(2, 12329), 1, { ...p, calibration: false })), 11631);
});

test("several upstream calls in one customer request: the overhead comes off once per call", () => {
  // canonical -p turn with two built-in tool rounds: 3 upstream calls, each re-reads the 12,200-token prefix
  const usage = raw(40, 3 * 12200 + 900);
  assert.equal(visible(applyOverhead(usage, 3, plan({ perCall: 12200, customerEstimate: 300, small: false }))), 940);
  assert.equal(visible(applyOverhead(usage, 1, plan({ perCall: 12200, customerEstimate: 300, small: false }))), 25340, "once per turn would leave two prefixes on the bill");
  // calls not counted (0) are treated as one
  assert.equal(applyOverhead(usage, 0, plan({ perCall: 12200, small: false })).deducted, 12200);
});

test("the legacy baseline is the lower bound of the deduction; plan null is the pre-X-54 logic", () => {
  const legacy = applyOverhead(raw(12, 33725, 1200), 1, null, 16600);
  assert.deepEqual(buckets(legacy), raw(12, 17125, 1200));
  // a learned / pinned value below the baseline setting does not reduce the deduction
  assert.equal(applyOverhead(raw(12, 33725, 1200), 1, plan({ perCall: 5000, source: "pinned", baseline: 16600, small: false })).deducted, 16600);
  assert.equal(applyOverhead(raw(12, 33725, 1200), 1, plan({ perCall: 0, source: "pinned", baseline: 16600, small: false })).rule, "baseline");
  // baseline source with calibration off = exactly the old numbers, floor included (old logic could show 0)
  assert.deepEqual(buckets(applyOverhead(raw(0, 600), 1, plan({ perCall: 700, source: "baseline", calibration: false, customerEstimate: 2000 }))), raw(0, 0));
});

test("property: for the same raw usage the bill never rises against the pre-X-54 logic", () => {
  const models = ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5-5"];
  const cost = (model, b, output, asInput) => computeCost(model, asInput
    ? { input_tokens: b.input + b.creation5m + b.creation1h, output_tokens: output, cache_read_tokens: b.read, cache_write_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0 }
    : { input_tokens: b.input, output_tokens: output, cache_read_tokens: b.read, cache_write_tokens: b.creation5m + b.creation1h, cache_write_5m_tokens: b.creation5m, cache_write_1h_tokens: b.creation1h });
  const grid = [0, 1, 7, 300, 700, 3972, 12331, 29705, 34711, 90000];
  const baselines = [0, 700, 16600, 28000];
  const perCalls = [0, 1, 650, 3800, 12200, 29600, 34600, 200000];
  const estimates = [null, 0, 5, 400, 2000, 50000];
  const sources = ["pinned", "learned", "learned_version", "learned_lane", "inherited", "default", "baseline"];
  let n = 0;
  // a deterministic walk over the grid (full product is ~10^8): every value of every dimension, mixed by a stride
  let seed = 12345;
  const rnd = (list) => list[(seed = (seed * 1103515245 + 12345) & 0x7fffffff) % list.length];
  for (let i = 0; i < 60000; i++) {
    const r = raw(rnd(grid), rnd(grid), rnd(grid), rnd(grid));
    const baseline = rnd(baselines), calls = rnd([0, 1, 2, 5]), output = rnd([0, 5, 900]);
    const p = plan({ perCall: rnd(perCalls), source: rnd(sources), baseline, customerEstimate: rnd(estimates), small: rnd([true, false]), calibration: rnd([true, false]) });
    const before = applyOverhead(r, calls, null, baseline);
    const after = applyOverhead(r, calls, p);
    const P = r.input + r.read + r.creation5m + r.creation1h;
    assert.ok(after.deducted >= before.deducted && after.deducted <= P, "never less deducted than before, never more than there is");
    for (const k of ["input", "read", "creation5m", "creation1h"]) assert.ok(after[k] <= before[k] && after[k] >= 0 && Number.isInteger(after[k]), `${k}: ${after[k]} vs ${before[k]}`);
    assert.equal(visible(after), P - after.deducted);
    const model = rnd(models);
    for (const asInput of [false, true]) {
      const a = cost(model, after, output, asInput), b = cost(model, before, output, asInput);
      assert.ok(a <= b + 1e-12, `cost rose: ${a} > ${b} for ${JSON.stringify({ r, calls, p })}`);
    }
    n++;
  }
  assert.equal(n, 60000);
});

// ---- translator ----

const start = (id, usage) => ({ type: "stream_event", event: { type: "message_start", message: { id, usage } } });
const assistant = (id, usage, content = [{ type: "text", text: "ok" }]) => ({ type: "assistant", message: { id, content, usage } });
const result = (usage) => ({ type: "result", subtype: "success", result: "ok", usage });

test("translator: usage of a turn with three upstream calls loses three prefixes; JSON, message_start and message_delta agree", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false, internalTools: true, cacheBaseline: 700, overhead: plan({ perCall: 12200, matched: "p:none", customerEstimate: 300, small: false }) });
  let sse = "";
  for (const [i, id] of ["msg_a", "msg_b", "msg_c"].entries()) {
    sse += t.push(start(id, { input_tokens: 10 + i, cache_read_input_tokens: 12200 + 300 * i, cache_creation_input_tokens: 0 }));
    sse += t.push(assistant(id, { input_tokens: 10 + i, output_tokens: 5, cache_read_input_tokens: 12200 + 300 * i }));
  }
  assert.equal(t.upstreamCallCount, 3, "a message seen as stream event and as whole row counts once");
  // result.usage: the whole run (sum of the three calls)
  sse += t.push(result({ input_tokens: 33, output_tokens: 15, cache_read_input_tokens: 3 * 12200 + 900, cache_creation_input_tokens: 0 }));
  sse += t.end();
  const u = t.message().usage;
  assert.deepEqual(u, { input_tokens: 33, output_tokens: 15, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
  const events = sse.split("\n\n").filter(Boolean).map((c) => JSON.parse(c.split("\n").find((l) => l.startsWith("data:")).slice(5)));
  const delta = events.find((e) => e.type === "message_delta");
  assert.deepEqual([delta.usage.input_tokens, delta.usage.cache_read_input_tokens, delta.usage.output_tokens], [33, 900, 15]);
  assert.deepEqual(t.rawPrompt, raw(33, 37500), "the raw upstream usage stays available for the platform ledger");
  assert.equal(t.overheadApplied.deducted, 36600);
});

test("translator: whole rows only (no partial messages), a row repeated per content block counts once; a known id adds nothing", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false, knownMessageIds: ["msg_old"], overhead: plan({ perCall: 1000, customerEstimate: 100, small: false, baseline: 0 }) });
  t.push(assistant("msg_old", { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 5000 }));
  t.push(assistant("msg_1", { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1500 }));
  t.push(assistant("msg_1", { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1500 }));
  assert.equal(t.upstreamCallCount, 1);
  assert.equal(t.message().usage.cache_read_input_tokens, 500);
});

test("translator: the overhead plan can be set after construction; the X-51 split and cacheWriteAsInput keep working on what is left", () => {
  const usage = { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 31000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 30000 } };
  const official = new SessionTranslator({ model: "m", simulateTools: false, cacheBaseline: 700 });
  official.setOverhead(plan({ perCall: 29600, customerEstimate: 1500, small: false }));
  official.push(result(usage));
  assert.deepEqual(official.message().usage, { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 1400, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 400 } }, "the prefix leaves the 1-hour bucket first");
  const folded = new SessionTranslator({ model: "m", simulateTools: false, cacheBaseline: 700, cacheWriteAsInput: true, overhead: plan({ perCall: 29600, customerEstimate: 1500, small: false }) });
  folded.push(result(usage));
  assert.deepEqual(folded.message().usage, { input_tokens: 1408, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
});

// ---- glue: key, settings, samples ----

test("key dimensions: lane and tools as the gateway knows them per turn", () => {
  assert.equal(workerOverheadLane(false, true, null), "legacy");
  assert.equal(workerOverheadLane(true, false, [{ type: "text", text: "x" }]), "p");
  assert.equal(workerOverheadLane(true, true, [{ type: "text", text: "x" }]), "tui");
  assert.equal(workerOverheadLane(true, true, [{ type: "text", text: "x" }, { type: "image", source: {} }]), "p", "X-53: media runs as a plain process on a TUI node");
  assert.equal(workerOverheadLane(true, true, [{ type: "document", source: {} }]), "p");
  assert.equal(workerOverheadLane(true, true, [{ type: "text", text: "x" }], "p"), "p", "a conversation that moved to a plain process stays keyed as one");
  assert.equal(workerOverheadLane(true, true, null, "tui"), "tui");
  assert.equal(workerOverheadTools(false, true, "restricted-default"), "none");
  assert.equal(workerOverheadTools(true, true, "restricted-default"), "caller");
  assert.equal(workerOverheadTools(true, true, "tools-disabled-canonical"), "caller-only");
  assert.equal(workerOverheadTools(true, false, null), "caller");
});

test("customer estimate and the small-request rule", () => {
  const body = { model: "claude-opus-5-5", max_tokens: 100, metadata: { user_id: "x".repeat(4000) }, messages: [{ role: "user", content: "Reply with the single word: pong" }] };
  const est = customerPromptEstimate(body);
  assert.ok(est >= 8 && est <= 12, `only system + messages + tools count: ${est}`);
  assert.equal(isSmallRequest(body, est), true);
  assert.equal(isSmallRequest({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }, 3), false, "history");
  assert.equal(isSmallRequest({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }] }, 3), false, "tool result round");
  assert.equal(isSmallRequest({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] }] }, 3), false, "media");
  assert.equal(isSmallRequest(body, 401), false, "estimate above 400");
});

test("planOverhead: defaults, pins and the off switch from settings; the source is counted", () => {
  const key = { lane: "tui", tools: "none", model: "claude-opus-5-5", version: "2.1.322" };
  const body = { messages: [{ role: "user", content: "hi there" }] };
  setSetting("ccr_cache_baseline_worker", "700");
  let p = planOverhead({ key, body, fresh: true, baselineSetting: "ccr_cache_baseline_worker" });
  assert.deepEqual([p.perCall, p.source, p.baseline, p.small, p.calibration], [29600, "default", 700, true, true]);
  assert.equal(planOverhead({ key, body, fresh: false, baselineSetting: "ccr_cache_baseline_worker" }).small, false, "a continuation is never small");
  setSetting("ccr_overhead_pins", "tui:none=30000");
  p = planOverhead({ key, body, fresh: true, baselineSetting: "ccr_cache_baseline_worker" });
  assert.deepEqual([p.perCall, p.source, p.matched], [30000, "pinned", "tui:none=30000"]);
  setSetting("ccr_overhead_pins", "");
  setSetting("ccr_overhead_calibration", "off");
  p = planOverhead({ key: { ...key, lane: "legacy" }, body, fresh: true, baselineSetting: "ccr_cache_baseline_worker" });
  assert.deepEqual([p.perCall, p.source, p.calibration], [700, "baseline", false]);
  setSetting("ccr_cache_baseline_cloud", "28000");
  assert.equal(planOverhead({ key: { lane: "cloud", tools: "none", model: "m", version: null }, body, fresh: true, baselineSetting: "ccr_cache_baseline_cloud" }).baseline, 28000);
  const c = countersSnapshot();
  assert.equal(c["ccr_overhead_source_total{lane=tui,source=default}"], 2);
  assert.equal(c["ccr_overhead_source_total{lane=tui,source=pinned}"], 1);
  assert.equal(c["ccr_overhead_source_total{lane=legacy,source=baseline}"], 1);
});

test("samples: only fresh small single-call turns that ended well; eight of them calibrate the key; counters", () => {
  const key = { lane: "p", tools: "none", model: "claude-opus-5-5", version: "2.1.312" };
  const body = { messages: [{ role: "user", content: "What is the capital of France?" }] };
  setSetting("ccr_cache_baseline_worker", "700");
  const p = planOverhead({ key, body, fresh: true, baselineSetting: "ccr_cache_baseline_worker" });
  assert.equal(p.perCall, 12200);
  const turn = (o = {}) => ({ raw: raw(2, 12329), calls: 1, failed: false, hasUsage: true, ...o });
  recordOverheadSample(p, turn({ calls: 2 }));
  recordOverheadSample(p, turn({ failed: true }));
  recordOverheadSample(p, turn({ hasUsage: false }));
  recordOverheadSample({ ...p, small: false }, turn());
  recordOverheadSample({ ...p, calibration: false }, turn());
  recordOverheadSample(null, turn());
  for (let i = 0; i < 8; i++) recordOverheadSample(p, turn({ raw: raw(2 + i, 12329) }));
  overheadCalibrator.flush();
  const c = countersSnapshot();
  assert.equal(c["ccr_overhead_sample_accepted_total{lane=p}"], 8);
  assert.equal(c["ccr_overhead_sample_rejected_total{reason=multi_call}"], 1);
  assert.equal(c["ccr_overhead_sample_rejected_total{reason=turn_failed}"], 1);
  assert.equal(c["ccr_overhead_sample_rejected_total{reason=no_usage}"], 1);
  assert.equal(c["ccr_overhead_sample_rejected_total{reason=not_small_fresh}"], 1);
  assert.equal(c.ccr_overhead_calibrated_keys, 1);
  const learned = planOverhead({ key, body, fresh: true, baselineSetting: "ccr_cache_baseline_worker" });
  // sample = upstream total − estimate (8): 12331 − 8 = 12323
  assert.deepEqual([learned.perCall, learned.source], [12331 - p.customerEstimate, "learned"]);
  const a = applyOverhead(raw(2, 12329), 1, learned);
  assert.equal(a.input + a.read, p.customerEstimate, "a calibrated key shows the customer about what they sent");
});
