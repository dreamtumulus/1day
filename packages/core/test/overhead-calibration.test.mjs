// X-54: learned platform prompt overhead of the CCR lanes — window / percentile, fallback chain, pins, calibration
// off, persistence shared by two gateway instances (two module instances over one temp database), database errors.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "1dayapi-overhead-"));
process.env.DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const c = await import("../dist/index.js");
// A second instance of the module (its own class, its own in-memory state) over the same database: the other gateway.
const other = await import("../dist/overhead-calibration.js?instance=green");

const key = (o = {}) => ({ lane: "tui", tools: "none", model: "claude-opus-5-5", version: "2.1.322", ...o });
const opts = (o = {}) => ({ baseline: 700, calibration: true, pins: [], ...o });
let clock = 1_800_000_000_000;
const now = () => clock;
const calibrator = (o = {}) => new c.OverheadCalibrator({ now, flushMs: 0, ...o });
beforeEach(() => { c.resetOverheadCalibration(); clock += 3_600_000; });

test("migration 43 created the table on a fresh database", () => {
  const cols = c.all("PRAGMA table_info(ccr_overhead_calibration)").map((r) => r.name);
  assert.deepEqual(cols, ["key", "samples", "n", "value", "updated_at"]);
});

test("percentile: p10 by nearest rank, the minimum below 11 samples", () => {
  assert.equal(c.overheadPercentile([]), null);
  assert.equal(c.overheadPercentile([5, 3, 9]), 3);
  assert.equal(c.overheadPercentile(Array.from({ length: 10 }, (_, i) => 100 + i)), 100);
  assert.equal(c.overheadPercentile(Array.from({ length: 11 }, (_, i) => 100 + i)), 101);
  assert.equal(c.overheadPercentile(Array.from({ length: 64 }, (_, i) => 100 + i)), 106);
});

test("a key is trusted only from 8 samples; the value is the low percentile, not the mean", () => {
  const cal = calibrator();
  for (let i = 0; i < 7; i++) cal.record(key(), 29700 + i * 50);
  assert.equal(cal.resolve(key(), opts()).source, "default", "7 samples: still the shipped default");
  assert.equal(cal.resolve(key(), opts()).perCall, 29600);
  cal.record(key(), 31000);
  const r = cal.resolve(key(), opts());
  assert.deepEqual({ perCall: r.perCall, source: r.source, samples: r.samples }, { perCall: 29700, source: "learned", samples: 8 });
});

test("window: only the last 64 samples count, so the value follows a changed prefix", () => {
  const cal = calibrator();
  for (let i = 0; i < 64; i++) { clock += 1000; cal.record(key(), 29700); }
  assert.equal(cal.resolve(key(), opts()).perCall, 29700);
  for (let i = 0; i < 64; i++) { clock += 1000; cal.record(key(), 31200 + i); }
  const r = cal.resolve(key(), opts());
  assert.equal(r.samples, 64);
  assert.equal(r.perCall, 31206);
  assert.equal(cal.rows()[0].n, 128, "n counts every accepted sample");
});

test("one freak low sample does not rule a full window; samples out of range are refused", () => {
  const cal = calibrator();
  for (let i = 0; i < 40; i++) { clock += 1000; cal.record(key(), 29700 + (i % 5) * 10); }
  cal.record(key(), 900);
  assert.equal(cal.resolve(key(), opts()).perCall, 29700);
  for (const bad of [0, -5, NaN, Infinity, 600_000]) assert.deepEqual(cal.record(key(), bad), { accepted: false, reason: "out_of_range" });
});

test("fallback chain: exact key → other version of the model → smallest other model of the lane → default → baseline", () => {
  const cal = calibrator();
  const fill = (k, v) => { for (let i = 0; i < 8; i++) cal.record(k, v); };
  // nothing learned: shipped defaults per model, generic per lane, and the baseline where nothing is known
  assert.deepEqual(pick(cal.resolve(key({ model: "claude-sonnet-5" }), opts())), { perCall: 34600, source: "default", matched: "tui:none:claude-sonnet-5" });
  assert.deepEqual(pick(cal.resolve(key({ model: "claude-new-9" }), opts())), { perCall: 25700, source: "default", matched: "tui:none" });
  assert.deepEqual(pick(cal.resolve(key({ tools: "caller-only" }), opts())), { perCall: 3800, source: "default", matched: "tui:caller-only" });
  assert.deepEqual(pick(cal.resolve(key({ lane: "p", version: "2.1.312" }), opts())), { perCall: 12200, source: "default", matched: "p:none" });
  assert.deepEqual(pick(cal.resolve(key({ lane: "legacy" }), opts())), { perCall: 700, source: "baseline", matched: null });
  assert.deepEqual(pick(cal.resolve(key({ lane: "cloud", version: null }), opts({ baseline: 28000 }))), { perCall: 28000, source: "baseline", matched: null });
  assert.deepEqual(pick(cal.resolve(key({ lane: "p", tools: "caller-only" }), opts())), { perCall: 700, source: "baseline", matched: null }, "-p with only caller tools: unknown, conservative");
  // caller tools beside the built-in ones: the prompt is a superset of the lane without caller tools
  assert.deepEqual(pick(cal.resolve(key({ lane: "p", tools: "caller" }), opts())), { perCall: 12200, source: "inherited", matched: "p:none" });

  fill(key({ version: "2.1.319" }), 29650);
  clock += 1000;
  fill(key({ model: "claude-opus-4-6" }), 25810);
  assert.deepEqual(pick(cal.resolve(key({ version: "2.1.319" }), opts())), { perCall: 29650, source: "learned", matched: "tui|none|claude-opus-5-5|2.1.319" });
  assert.deepEqual(pick(cal.resolve(key(), opts())), { perCall: 29650, source: "learned_version", matched: "tui|none|claude-opus-5-5|2.1.319" }, "a new Claude Code version starts from the previous version's value");
  clock += 1000;
  fill(key({ model: "claude-sonnet-5" }), 34700);
  assert.deepEqual(pick(cal.resolve(key({ model: "claude-new-9" }), opts())), { perCall: 25810, source: "learned_lane", matched: "tui|none|claude-opus-4-6|2.1.322" }, "an unknown model takes the SMALLEST learned value of the lane");
  assert.deepEqual(pick(cal.resolve(key({ tools: "caller" }), opts())), { perCall: 29650, source: "inherited", matched: "tui|none|claude-opus-5-5|2.1.319" });
  // other lanes and tool profiles are never mixed in
  assert.equal(cal.resolve(key({ lane: "p" }), opts()).source, "default");
  assert.equal(cal.resolve(key({ tools: "caller-only" }), opts()).source, "default");
});
const pick = (r) => ({ perCall: r.perCall, source: r.source, matched: r.matched });

test("pins: the most specific entry wins over learned values and defaults; bad entries are reported", () => {
  const { pins, errors } = c.parseOverheadPins("tui=28000, tui:none=29000; tui:none:claude-opus-5-5 = 29900\np:caller-only=3500, nonsense, tui:weird=1, cloud=abc");
  assert.deepEqual(errors, ["nonsense", "tui:weird=1", "cloud=abc"]);
  assert.equal(pins.length, 4);
  const cal = calibrator();
  for (let i = 0; i < 8; i++) cal.record(key(), 29700);
  assert.deepEqual(pick(cal.resolve(key(), opts({ pins }))), { perCall: 29900, source: "pinned", matched: "tui:none:claude-opus-5-5=29900" });
  assert.deepEqual(pick(cal.resolve(key({ model: "claude-sonnet-5" }), opts({ pins }))), { perCall: 29000, source: "pinned", matched: "tui:none=29000" });
  assert.deepEqual(pick(cal.resolve(key({ tools: "caller-only" }), opts({ pins }))), { perCall: 28000, source: "pinned", matched: "tui=28000" });
  assert.deepEqual(pick(cal.resolve(key({ lane: "p", tools: "caller-only" }), opts({ pins }))), { perCall: 3500, source: "pinned", matched: "p:caller-only=3500" });
  assert.equal(cal.resolve(key({ lane: "p" }), opts({ pins })).source, "default", "no pin for this lane / tools");
  assert.deepEqual(c.parseOverheadPins("").pins, []);
});

test("calibration off: learned values are ignored (pins, defaults and the baseline stay)", () => {
  const cal = calibrator();
  for (let i = 0; i < 8; i++) cal.record(key(), 30100);
  for (let i = 0; i < 8; i++) cal.record(key({ lane: "legacy" }), 715);
  assert.equal(cal.resolve(key(), opts()).perCall, 30100);
  assert.deepEqual(pick(cal.resolve(key(), opts({ calibration: false }))), { perCall: 29600, source: "default", matched: "tui:none:claude-opus-5-5" });
  assert.deepEqual(pick(cal.resolve(key({ lane: "legacy" }), opts({ calibration: false }))), { perCall: 700, source: "baseline", matched: null });
  assert.equal(cal.resolve(key(), opts({ calibration: false, pins: c.parseOverheadPins("tui=1").pins })).source, "pinned");
});

test("two gateway instances share one table: samples merge, each sees the other's after its refresh interval", () => {
  const blue = new c.OverheadCalibrator({ now, flushMs: 15_000 });
  const green = new other.OverheadCalibrator({ now, flushMs: 15_000 });
  assert.notEqual(c.OverheadCalibrator, other.OverheadCalibrator, "really two module instances");
  for (let i = 0; i < 5; i++) { clock += 100; blue.record(key(), 29700 + i); }
  for (let i = 0; i < 5; i++) { clock += 100; green.record(key(), 29800 + i); }
  assert.equal(blue.resolve(key(), opts()).source, "default", "5 own samples are not enough");
  // write at most once per interval per key: the first sample of each instance went out at once, the rest is buffered
  assert.equal(c.one("SELECT n FROM ccr_overhead_calibration").n, 2);
  blue.flush();
  green.flush();
  const row = c.one("SELECT key, samples, n, value FROM ccr_overhead_calibration");
  assert.equal(row.key, "tui|none|claude-opus-5-5|2.1.322");
  assert.equal(row.n, 10);
  assert.equal(JSON.parse(row.samples).length, 10);
  assert.equal(row.value, 29700);
  clock += 15_000;
  for (const g of [blue, green]) assert.deepEqual(pick(g.resolve(key(), opts())), { perCall: 29700, source: "learned", matched: "tui|none|claude-opus-5-5|2.1.322" });
  // a restart: a new instance starts from the table
  assert.equal(new other.OverheadCalibrator({ now }).resolve(key(), opts()).perCall, 29700);
  assert.deepEqual(c.overheadCalibrationRows().map((r) => [r.key, r.value, r.samples, r.n, r.min, r.max]), [["tui|none|claude-opus-5-5|2.1.322", 29700, 10, 10, 29700, 29804]]);
});

test("a database error never throws: samples stay in memory, are used by this instance and written once the table is back", () => {
  const errors = [];
  const cal = calibrator({ onDbError: (op) => errors.push(op) });
  c.db.exec("ALTER TABLE ccr_overhead_calibration RENAME TO ccr_overhead_calibration_gone");
  try {
    for (let i = 0; i < 8; i++) assert.deepEqual(cal.record(key(), 29750), { accepted: true });
    assert.equal(cal.resolve(key(), opts()).perCall, 29750, "in-memory samples still count");
    assert.ok(errors.includes("write") && errors.includes("read"));
    assert.deepEqual(new c.OverheadCalibrator({ now, flushMs: 0 }).resolve(key(), opts()).source, "default", "another instance without the table falls back to the default");
  } finally {
    c.db.exec("ALTER TABLE ccr_overhead_calibration_gone RENAME TO ccr_overhead_calibration");
  }
  cal.flush();
  assert.equal(c.one("SELECT n FROM ccr_overhead_calibration").n, 8);
});

test("migration 43 is idempotent and additive", () => {
  c.db.exec("CREATE TABLE IF NOT EXISTS ccr_overhead_calibration (key TEXT PRIMARY KEY, samples TEXT NOT NULL DEFAULT '[]', n INTEGER NOT NULL DEFAULT 0, value INTEGER, updated_at TEXT NOT NULL)");
  assert.equal(c.all("SELECT name FROM sqlite_master WHERE name = 'ccr_overhead_calibration'").length, 1);
  assert.equal(c.SETTING_DEFAULTS.ccr_overhead_calibration, "on");
  assert.equal(c.SETTING_DEFAULTS.ccr_overhead_pins, "");
});
