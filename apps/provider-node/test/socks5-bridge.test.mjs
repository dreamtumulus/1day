// SOCKS5 bridge: run under Bun (uses Bun.fetch's `proxy` option).
//   bun apps/provider-node/test/socks5-bridge.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Socks5Bridge, parseSocks5Url, socks5Connect } from "../dist/socks5-bridge.js";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// Target: plain HTTP server.
const target = http.createServer((req, res) => {
  res.setHeader("content-type", "text/plain");
  res.end(`ok ${req.method} ${req.url} host=${req.headers.host}`);
});
const targetPort = await listen(target);

// Minimal SOCKS5 server with username/password auth (RFC 1928 + 1929).
const seen = [];
const socks = net.createServer((c) => {
  let stage = 0;
  c.on("data", (d) => {
    if (stage === 0) {
      assert.equal(d[0], 5);
      const methods = [...d.subarray(2, 2 + d[1])];
      if (!methods.includes(2)) { c.end(Buffer.from([5, 0xff])); return; }
      c.write(Buffer.from([5, 2]));
      stage = 1;
    } else if (stage === 1) {
      const ulen = d[1]; const user = d.subarray(2, 2 + ulen).toString(); const plen = d[2 + ulen];
      const pass = d.subarray(3 + ulen, 3 + ulen + plen).toString();
      const ok = user === "u1" && pass === "p@ss";
      c.write(Buffer.from([1, ok ? 0 : 1]));
      if (!ok) c.end();
      stage = 2;
    } else if (stage === 2) {
      assert.equal(d[1], 1); // CONNECT
      let host, port, off;
      if (d[3] === 1) { host = [...d.subarray(4, 8)].join("."); off = 8; }
      else if (d[3] === 3) { const n = d[4]; host = d.subarray(5, 5 + n).toString(); off = 5 + n; }
      else { c.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      port = d.readUInt16BE(off);
      seen.push(`${host}:${port}`);
      if (port === 9) { c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); return; } // refused
      const up = net.connect(port, host === "target.test" ? "127.0.0.1" : host, () => {
        c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        c.pipe(up); up.pipe(c);
      });
      up.on("error", () => c.destroy());
      stage = 3;
    }
  });
  c.on("error", () => {});
});
const socksPort = await listen(socks);
const socksUrl = `socks5://u1:p%40ss@127.0.0.1:${socksPort}`;

assert.deepEqual(parseSocks5Url(socksUrl), { host: "127.0.0.1", port: socksPort, username: "u1", password: "p@ss" });
assert.equal(parseSocks5Url("http://x"), null);

const bridge = new Socks5Bridge();
const local = await bridge.localProxyFor(socksUrl);
assert.equal(local, await bridge.localProxyFor(socksUrl), "bridge is reused per upstream");

// 1) absolute-URI form (Bun.fetch with an http:// target through an http proxy)
let r = await fetch(`http://target.test:${targetPort}/abs?x=1`, { proxy: local, signal: AbortSignal.timeout(5000) });
assert.equal(r.status, 200);
assert.equal(await r.text(), `ok GET /abs?x=1 host=target.test:${targetPort}`);
assert.ok(seen.includes(`target.test:${targetPort}`), "hostname passed to SOCKS server unresolved (remote DNS)");

// 2) CONNECT form (what Bun sends for https targets) — drive it by hand over TCP.
const connectThrough = (hostPort, payload) => new Promise((resolve, reject) => {
  const u = new URL(local);
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
  const s = net.connect(Number(u.port), u.hostname, () => s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`));
  let buf = "";
  s.on("data", (d) => { buf += d.toString("latin1"); if (payload && buf.startsWith("HTTP/1.1 200") && !s.sent) { s.sent = true; s.write(payload); } });
  s.on("close", () => resolve(buf));
  s.on("error", reject);
  setTimeout(() => s.destroy(), 3000);
});
let out = await connectThrough(`127.0.0.1:${targetPort}`, `GET /tunnel HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`);
assert.ok(out.startsWith("HTTP/1.1 200 Connection Established"), out.slice(0, 80));
assert.ok(out.includes("ok GET /tunnel host=t"), out);
out = await connectThrough("127.0.0.1:9", null);
assert.ok(out.startsWith("HTTP/1.1 502") && out.includes("connection refused by destination"), out.slice(0, 200));
assert.match(bridge.consumeError(socksUrl) ?? "", /connection refused by destination/);
assert.equal(bridge.consumeError(socksUrl), null);

// 3) bad credentials -> clear error
await assert.rejects(socks5Connect({ host: "127.0.0.1", port: socksPort, username: "u1", password: "nope" }, "target.test", targetPort), /authentication failed/);
// 4) non-SOCKS endpoint
await assert.rejects(socks5Connect({ host: "127.0.0.1", port: targetPort }, "x", 1), /not a SOCKS5 server|closed during handshake/);
// 5) unreachable proxy
await assert.rejects(socks5Connect({ host: "127.0.0.1", port: 1 }, "x", 1), /cannot reach proxy/);

bridge.close();
socks.close();
target.close();
console.log("socks5-bridge: ALL PASSED");
