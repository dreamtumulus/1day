// Operator proxy-address parser (docs/onboarding.md §4.1, 2026-10-28): every common
// shape becomes one canonical socks5 URL; the same endpoint written differently has one fingerprint.
import assert from "node:assert/strict";
import { test } from "node:test";

const { parseProxyInput, canonicalProxyUrl, proxyFingerprint, describeProxy } = await import("../dist/node/proxy-parse.js");

const same = (a, b) => assert.equal(proxyFingerprint(parseProxyInput(a)), proxyFingerprint(parseProxyInput(b)), `${a} vs ${b}`);

test("url forms keep their scheme and decode userinfo", () => {
  assert.deepEqual(parseProxyInput("socks5://alice:s3cret@140.188.37.27:1080"), { scheme: "socks5", host: "140.188.37.27", port: 1080, username: "alice", password: "s3cret" });
  assert.equal(parseProxyInput("socks5h://a:b@proxy.example.com:9000").scheme, "socks5h");
  assert.equal(parseProxyInput("socks://a:b@proxy.example.com:9000").scheme, "socks5");
  assert.equal(parseProxyInput("http://198.51.100.9:8080").scheme, "http");
  assert.equal(parseProxyInput("http://198.51.100.9:8080").username, null);
  assert.equal(parseProxyInput("socks5://u:p%40ss@1.2.3.4:1080").password, "p@ss");
  assert.equal(parseProxyInput("socks5://u:p@ss@1.2.3.4:1080").password, "p@ss");
  assert.equal(parseProxyInput("SOCKS5://U:P@Host.Example.COM:1080").host, "host.example.com");
});

test("plain forms default to socks5", () => {
  assert.deepEqual(parseProxyInput("140.188.37.27:1080"), { scheme: "socks5", host: "140.188.37.27", port: 1080, username: null, password: null });
  assert.deepEqual(parseProxyInput("140.188.37.27:1080:alice:s3cret"), { scheme: "socks5", host: "140.188.37.27", port: 1080, username: "alice", password: "s3cret" });
  assert.deepEqual(parseProxyInput("alice:s3cret:140.188.37.27:1080"), { scheme: "socks5", host: "140.188.37.27", port: 1080, username: "alice", password: "s3cret" });
  assert.deepEqual(parseProxyInput("alice:s3cret@140.188.37.27:1080"), { scheme: "socks5", host: "140.188.37.27", port: 1080, username: "alice", password: "s3cret" });
  assert.deepEqual(parseProxyInput("  'alice:s3cret@140.188.37.27:1080'  "), { scheme: "socks5", host: "140.188.37.27", port: 1080, username: "alice", password: "s3cret" });
  // separators: space / tab / comma / pipe / semicolon
  assert.equal(describeProxy(parseProxyInput("140.188.37.27 1080 alice s3cret")), "socks5://alice:***@140.188.37.27:1080");
  assert.equal(describeProxy(parseProxyInput("140.188.37.27\t1080\talice\ts3cret")), "socks5://alice:***@140.188.37.27:1080");
  assert.equal(describeProxy(parseProxyInput("140.188.37.27,1080,alice,s3cret")), "socks5://alice:***@140.188.37.27:1080");
  assert.equal(describeProxy(parseProxyInput("140.188.37.27:1080|alice:s3cret")), "socks5://alice:***@140.188.37.27:1080");
  assert.equal(describeProxy(parseProxyInput("alice s3cret 140.188.37.27 1080")), "socks5://alice:***@140.188.37.27:1080");
  assert.equal(describeProxy(parseProxyInput("proxy.example.com 1080")), "socks5://proxy.example.com:1080");
  // password with colons survives the colon forms
  assert.equal(parseProxyInput("140.188.37.27:1080:alice:a:b:c").password, "a:b:c");
  assert.equal(parseProxyInput("alice:a:b:c:140.188.37.27:1080").password, "a:b:c");
  // IPv6
  assert.deepEqual(parseProxyInput("[2001:db8::1]:1080"), { scheme: "socks5", host: "2001:db8::1", port: 1080, username: null, password: null });
  assert.equal(parseProxyInput("u:p@[2001:db8::1]:1080").host, "2001:db8::1");
  assert.equal(canonicalProxyUrl(parseProxyInput("u:p@[2001:db8::1]:1080")), "socks5://u:p@[2001:db8::1]:1080");
});

test("one canonical url / fingerprint per endpoint, whatever the spelling", () => {
  const forms = ["socks5://alice:s3cret@140.188.37.27:1080", "140.188.37.27:1080:alice:s3cret", "alice:s3cret:140.188.37.27:1080",
    "alice:s3cret@140.188.37.27:1080", "140.188.37.27 1080 alice s3cret", "socks5h://alice:s3cret@140.188.37.27:1080", "http://alice:s3cret@140.188.37.27:1080"];
  for (const f of forms) same(forms[0], f);
  assert.equal(canonicalProxyUrl(parseProxyInput("140.188.37.27:1080:alice:s3cret")), "socks5://alice:s3cret@140.188.37.27:1080");
  assert.equal(canonicalProxyUrl(parseProxyInput("140.188.37.27:1080:alice:p@ss/w#rd")), "socks5://alice:p%40ss%2Fw%23rd@140.188.37.27:1080");
  // the canonical url round-trips
  const p = parseProxyInput("140.188.37.27:1080:alice:p@ss/w#rd");
  assert.deepEqual(parseProxyInput(canonicalProxyUrl(p)), p);
  // different credentials or port = different proxy
  assert.notEqual(proxyFingerprint(parseProxyInput("140.188.37.27:1080:alice:x")), proxyFingerprint(parseProxyInput("140.188.37.27:1080:alice:y")));
  assert.notEqual(proxyFingerprint(parseProxyInput("140.188.37.27:1080")), proxyFingerprint(parseProxyInput("140.188.37.27:1081")));
});

test("garbage is rejected", () => {
  for (const bad of ["", "   ", "hello", "140.188.37.27", "140.188.37.27:0", "140.188.37.27:70000", "ftp://a:b@1.2.3.4:21",
    "socks5://1.2.3.4:1080/path", "a:b:c", "1.2.3.4:1080:user", "sk-ant-sid01-abc", "http://", "1.2.3.4:1080 extra words here"]) {
    assert.equal(parseProxyInput(bad), null, JSON.stringify(bad));
  }
});

test("validateProxies: a scheme typed in front of the bare colon form is parsed, not kept verbatim (2026-11-08)", async () => {
  const { validateProxies } = await import("../dist/node/proxies.js");
  const [p] = validateProxies([{ url: "http://51.146.42.93:48465:alice:s3cret", group: "英国住宅02" }]);
  assert.equal(p.url, "http://alice:s3cret@51.146.42.93:48465");
  assert.equal(p.group, "英国住宅02");
  // a real URL is still kept as written
  assert.equal(validateProxies([{ url: "socks5h://u:p@proxy.example.com:9000" }])[0].url, "socks5h://u:p@proxy.example.com:9000");
  // and a scheme with garbage after it is refused, not stored
  assert.throws(() => validateProxies([{ url: "http://not a proxy" }]));
});
