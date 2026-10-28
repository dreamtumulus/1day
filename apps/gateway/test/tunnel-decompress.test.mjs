// Tunnel body decoding (provider-node relays /v1 bodies compressed; the gateway decodes, streaming).
import assert from "node:assert/strict";
import { test } from "node:test";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-tunnel-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const { decompressBody } = await import("../dist/tunnel.js");

const text = "event: content_block_delta\ndata: {\"delta\":{\"text\":\"hello\"}}\n\n".repeat(50);
const streamOf = (chunks) => new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close(); } });
const readAll = async (s) => { const r = s.getReader(); const parts = []; for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(Buffer.from(value)); } return Buffer.concat(parts).toString("utf8"); };

test("gzip / br / zstd / deflate bodies are decoded; identity and unknown pass through", async () => {
  const gz = gzipSync(text); const half = Math.floor(gz.length / 2);
  assert.equal(await readAll(decompressBody(streamOf([gz.subarray(0, half), gz.subarray(half)]), "gzip")), text, "gzip, split across chunks");
  assert.equal(await readAll(decompressBody(streamOf([brotliCompressSync(text)]), "br")), text, "brotli");
  assert.equal(await readAll(decompressBody(streamOf([zstdCompressSync(text)]), "zstd")), text, "zstd (Node ≥ 22.15)");
  const plain = Buffer.from(text);
  assert.equal(await readAll(decompressBody(streamOf([plain]), null)), text, "no encoding");
  assert.equal(await readAll(decompressBody(streamOf([plain]), "identity")), text, "identity");
});

test("decoded output streams as compressed input arrives (brotli with flushes)", async () => {
  const { createBrotliCompress, constants } = await import("node:zlib");
  const comp = createBrotliCompress();
  const out = [];
  comp.on("data", (c) => out.push(Buffer.from(c)));
  const pieces = ["first event\n\n", "second event\n\n", "third event\n\n"];
  for (const p of pieces) { comp.write(p); comp.flush(constants.BROTLI_OPERATION_FLUSH); await new Promise((r) => setImmediate(r)); }
  comp.end(); await new Promise((r) => comp.on("end", r));
  assert.ok(out.length >= 3, `encoder produced ${out.length} flushed blocks`);
  // Feed compressed blocks one at a time with a gap; each must decode before the next is fed.
  let feed; const src = new ReadableStream({ start(c) { feed = c; } });
  const dec = decompressBody(src, "br"); const reader = dec.getReader();
  let decoded = "";
  for (let i = 0; i < out.length; i++) {
    feed.enqueue(new Uint8Array(out[i]));
    if (i === 0) { const { value } = await reader.read(); decoded += Buffer.from(value).toString(); assert.ok(decoded.startsWith("first event"), "first block decoded before the rest was fed"); }
  }
  feed.close();
  for (;;) { const { done, value } = await reader.read(); if (done) break; decoded += Buffer.from(value).toString(); }
  assert.equal(decoded, pieces.join(""));
});
