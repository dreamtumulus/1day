// Raw passthrough relay accounts (gateway.md §4a, 2026-10-23): the client's request reaches the
// relay verbatim; the normal path keeps its Claude Code normalisation / fingerprint layer.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-raw-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const { buildUpstreamRequest, rawClientHeaders } = await import("../dist/upstream.js");

const account = (raw) => ({
  id: "a1", name: "relay", platform: "anthropic", type: "upstream", protocol: "anthropic", executor: "direct",
  base_url: "https://relay.example/api", models: null, model_mapping: null, route: "direct", raw_passthrough: raw ? 1 : 0,
  device_id: null, account_uuid: null,
});
const cred = { apiKey: "sk-relay" };
const clientHeaders = {
  host: "api.1dayapi.com", "content-length": "123", connection: "keep-alive", "accept-encoding": "gzip",
  authorization: "Bearer sk-customer", "x-api-key": "sk-customer", "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "1.2.3.4", "x-1dayapi-tee-proof-mode": "x",
  "user-agent": "opencode/1.2.3", "anthropic-version": "2023-06-01", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14", "x-stainless-lang": "js", accept: "application/json",
};
const body = { model: "claude-opus-4-7", max_tokens: 100, stream: true, metadata: { user_id: "u-abc" }, thinking: { type: "enabled", budget_tokens: 2048 }, messages: [{ role: "user", content: "hi" }] };

test("rawClientHeaders drops transport, credential and edge headers; keeps the client's own", () => {
  const h = rawClientHeaders(clientHeaders);
  for (const k of ["host", "content-length", "connection", "accept-encoding", "authorization", "x-api-key", "cf-connecting-ip", "x-forwarded-for", "x-1dayapi-tee-proof-mode"]) assert.equal(h[k], undefined, k);
  assert.equal(h["user-agent"], "opencode/1.2.3");
  assert.equal(h["x-stainless-lang"], "js");
  assert.equal(rawClientHeaders({ "X-Multi": ["a", "b"] })["x-multi"], "a, b");
});

test("raw passthrough: verbatim headers/body/query, relay credential, no ?beta=true, no identity pinning", () => {
  const r = buildUpstreamRequest(account(true), cred, "passthrough-anthropic", body, "claude-opus-4-7", clientHeaders, "?beta=true");
  assert.equal(r.url.toString(), "https://relay.example/api/v1/messages?beta=true", "client query kept as-is");
  assert.equal(r.headers["user-agent"], "opencode/1.2.3", "no UA normalisation");
  assert.equal(r.headers["anthropic-beta"], "fine-grained-tool-streaming-2025-05-14", "client betas untouched, nothing injected");
  assert.equal(r.headers["x-api-key"], "sk-relay");
  assert.equal(r.headers.authorization, "Bearer sk-relay");
  assert.equal(r.headers["x-forwarded-for"], undefined);
  assert.deepEqual(JSON.parse(r.body), body, "body byte-for-byte the client's (model unchanged when no mapping)");
  // No query from the client → none upstream.
  assert.equal(buildUpstreamRequest(account(true), cred, "passthrough-anthropic", body, "claude-opus-4-7", clientHeaders).url.search, "");
  // Not even the model is rewritten (2026-10-26): the account's model mapping / canonical id is ignored.
  const mapped = buildUpstreamRequest(account(true), cred, "passthrough-anthropic", body, "claude-opus-4-7-20260101", clientHeaders);
  assert.equal(JSON.parse(mapped.body).model, "claude-opus-4-7", "client model spelling travels as-is");
  // Missing anthropic-version is filled in (the API requires it); a present one is forwarded.
  const noVer = buildUpstreamRequest(account(true), cred, "passthrough-anthropic", body, "claude-opus-4-7", { "user-agent": "x" });
  assert.ok(noVer.headers["anthropic-version"]);
});

test("raw passthrough applies to same-protocol modes only; the normal path still normalises", () => {
  const conv = buildUpstreamRequest(account(true), cred, "chat-via-anthropic", { model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }] }, "claude-opus-4-7", clientHeaders, "?x=1");
  assert.equal(conv.url.search, "?beta=true", "cross-protocol conversion keeps the standard path");
  const normal = buildUpstreamRequest(account(false), cred, "passthrough-anthropic", body, "claude-opus-4-7", clientHeaders, "?beta=true");
  assert.equal(normal.url.search, "?beta=true");
  assert.notEqual(normal.headers["user-agent"], "opencode/1.2.3", "fingerprint layer rewrites the UA on the normal path");
  assert.ok(normal.headers["anthropic-beta"].includes("fine-grained-tool-streaming-2025-05-14"));
  assert.equal(normal.headers["x-api-key"], "sk-relay");
});
