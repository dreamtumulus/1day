// Model id aliases (2026-10-18: 22 × 404 on `claude-opus-5.5`): dotted version → dashed catalog id,
// dated snapshot → catalog alias. Pure helpers; DATA_DIR isolated in case the module opens the DB.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-alias-"));
process.env.DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { dottedVersionAlias, modelIdAliases } = await import("../dist/models.js");

test("dotted Claude versions become dashed; other ids are left alone", () => {
  assert.equal(dottedVersionAlias("claude-opus-5.5"), "claude-opus-5-5");
  assert.equal(dottedVersionAlias("claude-sonnet-4.5-20250929"), "claude-sonnet-4-5-20250929");
  assert.equal(dottedVersionAlias("claude-fable-5.1"), "claude-fable-5-1");
  assert.equal(dottedVersionAlias("claude-opus-5-5"), null);
  assert.equal(dottedVersionAlias("gpt-5.5-mini"), null);
  assert.equal(dottedVersionAlias("claude-3.5-sonnet"), "claude-3-5-sonnet");
});

test("alias order: dotted fix, then dated-snapshot strip, then both", () => {
  assert.deepEqual(modelIdAliases("claude-opus-5.5"), ["claude-opus-5-5"]);
  assert.deepEqual(modelIdAliases("claude-sonnet-4-5-20250929"), ["claude-sonnet-4-5"]);
  assert.deepEqual(modelIdAliases("claude-opus-5.5-20260901"), ["claude-opus-5-5-20260901", "claude-opus-5.5", "claude-opus-5-5"]);
  assert.deepEqual(modelIdAliases("claude-opus-5-5"), []);
  assert.deepEqual(modelIdAliases("gpt-5.5-mini"), []);
});
