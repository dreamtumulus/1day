// One-off redaction pass over docs/evidence/cc-2.1.312/*.json (§0.4: temp/home paths must not be stored).
// Writers (run-gate.mjs / profile-cli.mjs / shape.mjs) already scrub on write; this fixes files produced before
// that, so `evidence.mjs` can be a strict validator. Idempotent.
//   node tests/e2e/cc-probe/scrub-evidence.mjs [--dry]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve("docs/evidence/cc-2.1.312");
const dry = process.argv.includes("--dry");
const scrub = (s) => s
  .replace(/\/(?:tmp|var\/tmp)\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<tmp-path>")
  .replace(/\/home\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<home-path>")
  .replace(/\/root\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<home-path>");

let changed = 0;
for (const f of readdirSync(OUT).filter((f) => f.endsWith(".json")).sort()) {
  const p = join(OUT, f);
  const before = readFileSync(p, "utf8");
  const after = scrub(before);
  if (after !== before) {
    changed += 1;
    if (!dry) writeFileSync(p, after);
    console.log(`${dry ? "would scrub" : "scrubbed"}: ${f}`);
  }
}
console.log(`${changed} file(s) ${dry ? "need" : "were"} scrubbed`);
