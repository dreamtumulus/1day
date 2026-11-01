import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-merkle-affinity-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const { merklePrefixes, orderByMerklePrefix, rememberMerklePrefix } = await import("../dist/merkle-affinity.js");

const first = { model: "claude-sonnet-5", messages: [{ role: "user", content: "unique root" }, { role: "assistant", content: "answer" }] };
const continued = { ...first, messages: [...first.messages, { role: "user", content: "next turn" }] };
const candidates = [{ id: "account-b" }, { id: "account-a" }];

test("rolling prefixes survive appended turns and select the longest binding", () => {
  const namespace = "team:org:conversation:one:generation:1:model:claude-sonnet-5";
  rememberMerklePrefix(namespace, first, "anthropic", "account-a", Date.now() + 60_000);
  assert.equal(orderByMerklePrefix(candidates, namespace, continued, "anthropic")[0].id, "account-a");
  assert.equal(orderByMerklePrefix(candidates, "team:other", continued, "anthropic")[0].id, "account-b", "no cross-organization match");
  const fork = { ...first, messages: [first.messages[0], { role: "assistant", content: "different answer" }, { role: "user", content: "fork" }] };
  assert.equal(orderByMerklePrefix(candidates, namespace, fork, "anthropic")[0].id, "account-a", "the common root still matches a fork");
});

test("cache markers do not change identity; system-only and empty bodies are not conversations", () => {
  const marked = { ...first, messages: first.messages.map((m, i) => i === 0 ? { ...m, cache_control: { type: "ephemeral" } } : m) };
  assert.deepEqual(merklePrefixes(marked, "anthropic"), merklePrefixes(first, "anthropic"));
  assert.equal(merklePrefixes({ system: "shared instructions", messages: [] }, "anthropic"), null);
  assert.equal(merklePrefixes({ messages: [] }, "anthropic"), null);
});
