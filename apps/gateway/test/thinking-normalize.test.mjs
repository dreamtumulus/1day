// Passthrough `thinking` normalisation (2026-10-19 incident: 10 × 400 "thinking.type.disabled" on
// claude-fable-5 from a Claude Code 2.1.220 client). Rules: claude-api skill shared/error-codes.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeThinking } from "../dist/upstream.js";

const body = (thinking, extra = {}) => ({ model: "m", max_tokens: 100, messages: [], thinking, ...extra });

test("Fable 5 / Opus 5.5: disabled is dropped, enabled+budget becomes adaptive", () => {
  for (const m of ["claude-fable-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-opus-5-5-20260901"]) {
    const off = normalizeThinking(body({ type: "disabled" }), m);
    assert.equal("thinking" in off, false, m);
    const on = normalizeThinking(body({ type: "enabled", budget_tokens: 8000 }), m);
    assert.deepEqual(on.thinking, { type: "adaptive" }, m);
    assert.deepEqual(normalizeThinking(body({ type: "adaptive" }), m).thinking, { type: "adaptive" }, m);
  }
});

test("Sonnet 5.5: disabled becomes between_tools at effort <= high, dropped at xhigh/max", () => {
  assert.deepEqual(normalizeThinking(body({ type: "disabled" }), "claude-sonnet-5-5").thinking, { type: "between_tools" });
  assert.deepEqual(normalizeThinking(body({ type: "disabled" }, { output_config: { effort: "high" } }), "claude-sonnet-5-5").thinking, { type: "between_tools" });
  assert.equal("thinking" in normalizeThinking(body({ type: "disabled" }, { output_config: { effort: "max" } }), "claude-sonnet-5-5"), false);
  assert.deepEqual(normalizeThinking(body({ type: "enabled", budget_tokens: 1024 }), "claude-sonnet-5-5").thinking, { type: "adaptive" });
  // between_tools is Sonnet 5.5 only
  assert.deepEqual(normalizeThinking(body({ type: "between_tools" }), "claude-sonnet-5-5").thinking, { type: "between_tools" });
  assert.equal("thinking" in normalizeThinking(body({ type: "between_tools" }), "claude-opus-5-5"), false);
  assert.equal("thinking" in normalizeThinking(body({ type: "between_tools" }, { effort: "xhigh" }), "claude-sonnet-5-5"), false);
});

test("Opus 5 / Haiku 5.5 / Opus 4.7-4.8: budget rejected, disabled only dropped at xhigh/max", () => {
  for (const m of ["claude-opus-5", "claude-haiku-5-5", "claude-sonnet-5"]) {
    assert.deepEqual(normalizeThinking(body({ type: "disabled" }), m).thinking, { type: "disabled" }, m);
    assert.equal("thinking" in normalizeThinking(body({ type: "disabled" }, { output_config: { effort: "xhigh" } }), m), false, m);
    assert.deepEqual(normalizeThinking(body({ type: "enabled", budget_tokens: 2048 }), m).thinking, { type: "adaptive" }, m);
  }
  for (const m of ["claude-opus-4-7", "claude-opus-4-8"]) {
    assert.deepEqual(normalizeThinking(body({ type: "disabled" }, { output_config: { effort: "max" } }), m).thinking, { type: "disabled" }, m);
    assert.deepEqual(normalizeThinking(body({ type: "enabled", budget_tokens: 2048 }), m).thinking, { type: "adaptive" }, m);
  }
});

test("older lines and non-Claude ids pass through untouched; input body is not mutated", () => {
  const b = body({ type: "enabled", budget_tokens: 4096 });
  for (const m of ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-6", "claude-haiku-4-5", "gpt-5.5-mini", "claude-3-5-sonnet-latest"]) {
    assert.equal(normalizeThinking(b, m), b, m);
  }
  assert.equal(normalizeThinking(body({ type: "disabled" }), "claude-sonnet-4-6").thinking.type, "disabled");
  const src = body({ type: "disabled" });
  normalizeThinking(src, "claude-fable-5");
  assert.deepEqual(src.thinking, { type: "disabled" });
  assert.equal(normalizeThinking({ model: "x", messages: [] }, "claude-fable-5").thinking, undefined);
});

test("normalization removes only rejected budget fields and preserves the remaining thinking contract", () => {
  const adaptive = normalizeThinking(body({ type: "enabled", budget_tokens: 8000, display: "omitted", custom: "keep" }), "claude-opus-5-5");
  assert.deepEqual(adaptive.thinking, { type: "adaptive", display: "omitted", custom: "keep" });
  const between = normalizeThinking(body({ type: "disabled", display: "updates" }), "claude-sonnet-5-5");
  assert.deepEqual(between.thinking, { type: "between_tools", display: "updates" });
});
