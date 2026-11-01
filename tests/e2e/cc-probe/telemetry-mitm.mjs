// G10-B / T5 (spec §7) — controlled TLS man-in-the-middle on the *telemetry* channel only.
// Question: does the Bun-bundled CC 2.1.312 binary (a) honour NODE_EXTRA_CA_CERTS and (b) honour SSLKEYLOGFILE,
// so we can read the structure of its native telemetry requests (/api/event_logging/v2/batch, bootstrap …)?
// Method: local CONNECT proxy → local HTTPS server holding a self-signed cert for api.anthropic.com (SAN),
// CA passed via NODE_EXTRA_CA_CERTS, keylog file via SSLKEYLOGFILE. /v1/messages never leaves the box
// (ANTHROPIC_BASE_URL = local plain-HTTP fake upstream, NO_PROXY covers 127.0.0.1). Nothing talks to the real
// Anthropic: every CONNECT either terminates here or is refused.
//   node tests/e2e/cc-probe/telemetry-mitm.mjs
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCapture } from "./mock-upstream-capture.mjs";

const CLAUDE = process.env.CC_PROBE_BIN ?? "/home/ubuntu/claude-code-re/2.1.312/package/claude";
const OUT = resolve("docs/evidence/cc-2.1.312");
const dir = mkdtempSync(join(tmpdir(), "cc-mitm-"));
const home = join(dir, "home");
const cfg = join(home, "cfg"); const work = join(home, "work");
mkdirSync(cfg, { recursive: true, mode: 0o700 }); mkdirSync(work, { recursive: true, mode: 0o700 });
const keylog = join(dir, "sslkeylog.txt");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ---- self-signed CA + leaf for api.anthropic.com ----
const ossl = (...a) => execFileSync("openssl", a, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=cc-probe-ca");
ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=api.anthropic.com");
writeFileSync(join(dir, "leaf.ext"), "subjectAltName=DNS:api.anthropic.com,DNS:*.anthropic.com,DNS:downloads.claude.ai,DNS:github.com,DNS:raw.githubusercontent.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
ossl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "leaf.ext");

// ---- fake OAuth / config (fake values only) ----
writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-probe-fake-token", refreshToken: "sk-ant-ort01-probe-fake", expiresAt: Date.now() + 8 * 3600e3, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } }), { mode: 0o600 });
writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ userID: sha("cc-probe-device").repeat(2), hasCompletedOnboarding: true, oauthAccount: { accountUuid: "9d2d1c5e-1111-4a7b-8c3d-aaaaaaaaaaaa", emailAddress: "", organizationUuid: "11111111-2222-4333-8444-555555555555", displayName: "", fullName: "", profileFetchedAt: Date.now() } }), { mode: 0o600 });
writeFileSync(join(cfg, "settings.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });

// ---- TLS endpoint that pretends to be api.anthropic.com ----
const tlsHits = [];
const httpsServer = https.createServer({ key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.pem")) }, (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    let parsed = null; try { parsed = JSON.parse(raw.toString("utf8")); } catch { /* may be gzip or empty */ }
    const redact = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, /auth|token|cookie|key/i.test(k) ? "<redacted>" : String(v).slice(0, 120)]));
    tlsHits.push({
      at: new Date().toISOString(), method: req.method, url: req.url,
      host: String(req.headers.host ?? ""), headers: redact(req.headers),
      bodyLen: raw.length, bodyDigest: sha(raw.toString("utf8")), contentType: String(req.headers["content-type"] ?? ""),
      bodyTopLevelKeys: parsed && typeof parsed === "object" ? Object.keys(parsed) : null,
      bodyItemKeys: parsed?.events?.[0] ? Object.keys(parsed.events[0]) : parsed?.data?.[0] ? Object.keys(parsed.data[0]) : null,
      bodyPreviewKeys: parsed ? (Array.isArray(parsed) ? ["<array>"] : Object.keys(parsed)) : null,
      // event_logging schema (names only — never payload values)
      eventCount: Array.isArray(parsed?.events) ? parsed.events.length : null,
      eventTypes: Array.isArray(parsed?.events) ? [...new Set(parsed.events.map((e) => String(e.event_type ?? "")))].slice(0, 40) : null,
      eventDataKeys: Array.isArray(parsed?.events) ? [...new Set(parsed.events.flatMap((e) => Object.keys(e.event_data ?? {})))].slice(0, 40) : null,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => httpsServer.listen(0, "127.0.0.1", r));
const tlsPort = httpsServer.address().port;

// ---- CONNECT proxy: terminate api.anthropic.com locally, refuse everything else ----
const connects = [];
const proxy = http.createServer((req, res) => { connects.push({ url: req.url, host: req.headers.host }); res.writeHead(502); res.end(); });
proxy.on("connect", (req, socket) => {
  const [host, port] = String(req.url).split(":");
  connects.push({ at: new Date().toISOString(), target: req.url });
  const terminate = /anthropic\.com$/.test(host) && port === "443";
  if (!terminate) { socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
  socket.on("error", () => {});
  const back = net.connect(tlsPort, "127.0.0.1", () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    back.pipe(socket); socket.pipe(back);
  });
  back.on("error", () => socket.destroy());
});
proxy.on("connection", (s) => s.on("error", () => {}));
proxy.on("clientError", (_e, s) => s.destroy());
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const cap = await startCapture({ answerText: "OK" });
const env = {
  PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: cfg, SHELL: "/bin/bash", TERM: "dumb",
  ANTHROPIC_BASE_URL: cap.baseUrl, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_NO_MODEL_FALLBACK: "1", CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
  NODE_EXTRA_CA_CERTS: join(dir, "ca.pem"), SSLKEYLOGFILE: keylog,
};
const child = spawn(CLAUDE, ["-p", "--model", "claude-sonnet-5-5", "--output-format", "stream-json", "--verbose", "Reply with the single word OK."], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));
child.stdin.end();
const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
const code = await new Promise((r) => child.on("close", r));
clearTimeout(timer);
await new Promise((r) => setTimeout(r, 500));
await cap.close();
httpsServer.closeAllConnections?.();
proxy.closeAllConnections?.();
await Promise.race([new Promise((r) => httpsServer.close(r)), new Promise((r) => setTimeout(r, 2000))]);
await Promise.race([new Promise((r) => proxy.close(r)), new Promise((r) => setTimeout(r, 2000))]);

// ---- keylog analysis (structure only: no key material is written to evidence) ----
let keylogInfo = { fileExists: existsSync(keylog), lines: 0, labels: [], clientRandomPrefixes: [] };
if (keylogInfo.fileExists) {
  const lines = readFileSync(keylog, "utf8").split("\n").filter(Boolean);
  keylogInfo.lines = lines.length;
  keylogInfo.labels = [...new Set(lines.map((l) => l.split(" ")[0]))];
  keylogInfo.clientRandomPrefixes = lines.map((l) => l.split(" ")[1]?.slice(0, 8)).slice(0, 5);
}
const evidence = {
  gate: "telemetry-structure", binaryVersion: "2.1.312", sampledAt: new Date().toISOString(), exitCode: code,
  method: {
    mitm: "local CONNECT proxy terminates TLS for *.anthropic.com:443 with a self-signed CA passed via NODE_EXTRA_CA_CERTS",
    keylog: "SSLKEYLOGFILE pointed at a temp file; contents summarised by label/count only",
    note: "all other hosts refused; ANTHROPIC_BASE_URL stays on a local plain-HTTP fake upstream",
  },
  tls: {
    handshakeCompleted: tlsHits.length > 0,
    requests: tlsHits.length,
    sslkeylog: keylogInfo,
    verdict: tlsHits.length > 0
      ? (keylogInfo.lines > 0 ? "NODE_EXTRA_CA_CERTS 可用 + SSLKEYLOGFILE 可用" : "NODE_EXTRA_CA_CERTS 可用（无需 keylog 即可读明文）；SSLKEYLOGFILE 未产生内容")
      : (keylogInfo.lines > 0 ? "握手失败但写了 keylog（需外部抓包解密）" : "既未完成握手也无 keylog"),
  },
  endpoints: tlsHits.map((h) => `${h.method} ${h.url}`),
  requests: tlsHits,
  connectAttempts: connects,
  refusedHosts: [...new Set(connects.filter((c) => c.target && !/anthropic\.com:443$/.test(c.target)).map((c) => c.target))],
  localUpstreamCalls: cap.requests.map((r) => `${r.method} ${r.url}`),
  stderrTail: stderr.split("\n").filter(Boolean).slice(-8).map((l) => l.slice(0, 300)),
};
evidence.digest = sha(JSON.stringify(evidence.requests));
writeFileSync(join(OUT, "telemetry-structure.json"), JSON.stringify(evidence, null, 1));
console.log(JSON.stringify({ exitCode: code, tlsRequests: tlsHits.length, endpoints: evidence.endpoints, keylog: keylogInfo, refused: evidence.refusedHosts, verdict: evidence.tls.verdict }, null, 1));
