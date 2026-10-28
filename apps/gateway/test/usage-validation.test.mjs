import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageAccumulator } from "../dist/usage.js";

test("invalid wire usage falls back to a bounded estimate instead of corrupting billing", () => {
  for (const value of [-1, Infinity, NaN, "12", 1.5, 1_000_000_001]) {
    for (const protocol of ["anthropic", "chat", "responses"]) {
      const acc = new UsageAccumulator();
      if (protocol === "anthropic") acc.addAnthropic({ input_tokens: value, output_tokens: 3 });
      if (protocol === "chat") acc.addOpenaiChat({ prompt_tokens: value, completion_tokens: 3 });
      if (protocol === "responses") acc.addResponses({ input_tokens: value, output_tokens: 3 });
      acc.addText("answer");
      const { usage, estimated } = acc.finalize({ messages: [{ role: "user", content: "hello" }] });
      assert.equal(estimated, true, `${protocol} ${value}`);
      for (const n of Object.values(usage)) assert.ok(Number.isSafeInteger(n) && n >= 0 && n < 100);
    }
  }
});
test("reported zero is valid; malformed cache subsets cannot become negative input", () => {
  const acc = new UsageAccumulator();
  acc.addAnthropic({ input_tokens: 0, output_tokens: 0 });
  assert.equal(acc.finalize({ content: "some text" }).estimated, false);
  const other = new UsageAccumulator();
  other.addOpenaiChat({ prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } });
  assert.equal(other.finalize({}).estimated, true);
});
