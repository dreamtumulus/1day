// One account = one device (docs/claude-code-compat.md §8): metadata.user_id rewrite on the direct path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pinDeviceIdentity } from "../dist/upstream.js";

const acct = { id: "acc-1", device_id: "a".repeat(64), account_uuid: "11111111-2222-3333-4444-555555555555" };

test("JSON form: device_id and account_uuid pinned, session_id kept, other fields untouched", () => {
  const sid = "9f0e1d2c-3b4a-5968-7786-95a4b3c2d1e0";
  const body = { model: "m", messages: [], metadata: { user_id: JSON.stringify({ device_id: "b".repeat(64), account_uuid: "", session_id: sid }) } };
  const out = pinDeviceIdentity(body, acct);
  const j = JSON.parse(out.metadata.user_id);
  assert.equal(j.device_id, acct.device_id);
  assert.equal(j.account_uuid, acct.account_uuid);
  assert.equal(j.session_id, sid);
  assert.equal(body.metadata.user_id.includes("b".repeat(64)), true, "input body not mutated");
});

test("legacy form: user_<hex>_account_<uuid>_session_<uuid> rewritten in place", () => {
  const body = { metadata: { user_id: `user_${"c".repeat(64)}_account_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_session_12345678-1234-1234-1234-123456789abc` } };
  const out = pinDeviceIdentity(body, acct);
  assert.equal(out.metadata.user_id, `user_${acct.device_id}_account_${acct.account_uuid}_session_12345678-1234-1234-1234-123456789abc`);
});

test("unknown account_uuid: the client's is cleared to empty, never passed through (JSON + legacy)", () => {
  const body = { metadata: { user_id: JSON.stringify({ device_id: "d".repeat(64), account_uuid: "client-uuid", session_id: "s1" }) } };
  const out = pinDeviceIdentity(body, { ...acct, account_uuid: null });
  const j = JSON.parse(out.metadata.user_id);
  assert.equal(j.device_id, acct.device_id);
  assert.equal(j.account_uuid, "", "client account_uuid must not leak when the account has none");
  assert.equal(j.session_id, "s1");
  const legacy = { metadata: { user_id: `user_${"c".repeat(64)}_account_client-uuid_session_abc` } };
  const outLegacy = pinDeviceIdentity(legacy, { ...acct, account_uuid: null });
  assert.equal(outLegacy.metadata.user_id, `user_${acct.device_id}_account__session_abc`);
});

test("canonical field order device_id, account_uuid, session_id is preserved after pinning", () => {
  const body = { metadata: { user_id: JSON.stringify({ device_id: "", account_uuid: "", session_id: "sx" }) } };
  const out = pinDeviceIdentity(body, acct);
  assert.equal(out.metadata.user_id, JSON.stringify({ device_id: acct.device_id, account_uuid: acct.account_uuid, session_id: "sx" }));
});

test("no metadata -> body returned unchanged", () => {
  const plain = { model: "m", messages: [] };
  assert.equal(pinDeviceIdentity(plain, acct), plain);
});

test("client sent only {session_id} (or keys in another order): output is rebuilt as device_id, account_uuid, session_id, …rest", () => {
  const only = { metadata: { user_id: JSON.stringify({ session_id: "sx" }) } };
  assert.equal(pinDeviceIdentity(only, acct).metadata.user_id, JSON.stringify({ device_id: acct.device_id, account_uuid: acct.account_uuid, session_id: "sx" }));
  const shuffled = { metadata: { user_id: JSON.stringify({ session_id: "sy", extra: 1, account_uuid: "x", device_id: "y" }) } };
  assert.equal(pinDeviceIdentity(shuffled, acct).metadata.user_id, JSON.stringify({ device_id: acct.device_id, account_uuid: acct.account_uuid, session_id: "sy", extra: 1 }));
});
