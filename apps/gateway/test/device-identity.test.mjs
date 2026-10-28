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

test("unknown account_uuid keeps the client's; no metadata -> body unchanged", () => {
  const body = { metadata: { user_id: JSON.stringify({ device_id: "d".repeat(64), account_uuid: "client-uuid", session_id: "s1" }) } };
  const out = pinDeviceIdentity(body, { ...acct, account_uuid: null });
  const j = JSON.parse(out.metadata.user_id);
  assert.equal(j.device_id, acct.device_id);
  assert.equal(j.account_uuid, "client-uuid");
  const plain = { model: "m", messages: [] };
  assert.equal(pinDeviceIdentity(plain, acct), plain);
});
