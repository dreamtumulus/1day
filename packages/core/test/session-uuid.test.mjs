// Deterministic UUIDv4-shaped session id + canonical metadata.user_id order (docs/claude-code-compat.md §5/§10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionUuidFromHash, sessionMetadataUserId } from "../dist/fingerprint.js";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("sessionUuidFromHash is a valid UUIDv4 and deterministic", () => {
  // 64-hex sha256-like inputs, including ones whose raw slice would break v4.
  for (const h of ["0".repeat(64), "f".repeat(64), "deadbeef".repeat(8), "7".repeat(64), "c".repeat(64)]) {
    const u = sessionUuidFromHash(h);
    assert.match(u, V4, `not a v4: ${u}`);
    assert.equal(u, sessionUuidFromHash(h), "same input -> same id");
  }
  assert.notEqual(sessionUuidFromHash("a".repeat(64)), sessionUuidFromHash("b".repeat(64)));
});

test("sessionMetadataUserId field order is device_id, account_uuid, session_id", () => {
  assert.equal(sessionMetadataUserId("sid-1"), JSON.stringify({ device_id: "", account_uuid: "", session_id: "sid-1" }));
  assert.equal(Object.keys(JSON.parse(sessionMetadataUserId("x"))).join(","), "device_id,account_uuid,session_id");
});
