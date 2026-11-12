import crypto from "node:crypto";
import net from "node:net";

/**
 * SOCKS5 → local HTTP proxy bridge.
 *
 * Bun.fetch's `proxy` option only speaks HTTP/HTTPS proxies (socks5:// URLs
 * fail with UnsupportedProxyProtocol). To keep TLS termination inside Bun
 * (the whole point of protocol v2's fingerprint story) we expose every
 * socks5 upstream as a loopback HTTP proxy: Bun sends `CONNECT host:port`
 * (or an absolute-URI request for plain http targets), the bridge performs
 * the SOCKS5 handshake (RFC 1928, username/password auth per RFC 1929,
 * remote DNS — hostnames are passed through as ATYP=domain) and then pipes
 * bytes. Nothing is decrypted here.
 */

export interface Socks5Target {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_HEAD_BYTES = 16 * 1024;

export function isSocks5Url(url: string): boolean {
  return /^socks5h?:\/\//i.test(url);
}

export function parseSocks5Url(url: string): Socks5Target | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "socks5:" && u.protocol !== "socks5h:") return null;
  if (!u.hostname) return null;
  const port = u.port ? Number(u.port) : 1080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return {
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port,
    username: u.username ? dec(u.username) : undefined,
    password: u.password ? dec(u.password) : undefined,
  };
}

const SOCKS_REPLY: Record<number, string> = {
  1: "general SOCKS server failure",
  2: "connection not allowed by ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused by destination",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/** Byte reader over a socket for the handshake phase. */
class SocketReader {
  private buf = Buffer.alloc(0);
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private ended: Error | null = null;
  private readonly onData = (chunk: Buffer) => {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.flush();
  };
  private readonly onEnd = () => {
    this.ended = new Error("socks5: connection closed during handshake");
    this.flush();
  };

  constructor(private readonly sock: net.Socket) {
    sock.on("data", this.onData);
    sock.once("close", this.onEnd);
    sock.once("error", (e) => {
      this.ended = e;
      this.flush();
    });
  }

  private flush(): void {
    const w = this.waiter;
    if (!w) return;
    if (this.buf.length >= w.n) {
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      this.waiter = null;
      w.resolve(out);
    } else if (this.ended) {
      this.waiter = null;
      w.reject(this.ended);
    }
  }

  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.flush();
    });
  }

  /** Stop intercepting; returns bytes read but not consumed. */
  release(): Buffer {
    this.sock.off("data", this.onData);
    this.sock.off("close", this.onEnd);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`socks5: ${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Open a TCP connection to host:port through a SOCKS5 server. Resolves once the tunnel is established. */
export async function socks5Connect(target: Socks5Target, host: string, port: number): Promise<{ socket: net.Socket; leftover: Buffer }> {
  const sock = net.connect({ host: target.host, port: target.port });
  const reader = new SocketReader(sock);
  const run = async () => {
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", (e) => reject(new Error(`socks5: cannot reach proxy ${target.host}:${target.port}: ${e.message}`)));
    });
    const auth = !!(target.username || target.password);
    sock.write(Buffer.from(auth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    const greet = await reader.read(2);
    if (greet[0] !== 0x05) throw new Error("socks5: not a SOCKS5 server");
    if (greet[1] === 0xff) throw new Error("socks5: no acceptable authentication method (proxy requires credentials?)");
    if (greet[1] === 0x02) {
      if (!auth) throw new Error("socks5: proxy requires username/password");
      const u = Buffer.from(target.username ?? "", "utf8");
      const p = Buffer.from(target.password ?? "", "utf8");
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const ar = await reader.read(2);
      if (ar[1] !== 0x00) throw new Error("socks5: authentication failed (bad username/password)");
    } else if (greet[1] !== 0x00) {
      throw new Error(`socks5: unsupported auth method 0x${greet[1].toString(16)}`);
    }
    let addr: Buffer;
    if (net.isIP(host) === 4) {
      addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split(".").map(Number))]);
    } else if (net.isIP(host) === 6) {
      addr = Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)]);
    } else {
      // Domain names are resolved by the proxy: ATYP=3.
      const h = Buffer.from(host, "utf8");
      if (h.length > 255) throw new Error("socks5: hostname too long");
      addr = Buffer.concat([Buffer.from([0x03, h.length]), h]);
    }
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(port);
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));
    const head = await reader.read(4);
    if (head[1] !== 0x00) throw new Error(`socks5: connect to ${host}:${port} rejected: ${SOCKS_REPLY[head[1]] ?? `reply 0x${head[1].toString(16)}`}`);
    if (head[3] === 0x01) await reader.read(4 + 2);
    else if (head[3] === 0x04) await reader.read(16 + 2);
    else if (head[3] === 0x03) {
      const len = (await reader.read(1))[0];
      await reader.read(len + 2);
    } else throw new Error("socks5: malformed reply");
  };
  try {
    await withTimeout(run(), HANDSHAKE_TIMEOUT_MS, "handshake");
  } catch (err) {
    sock.destroy();
    throw err;
  }
  return { socket: sock, leftover: reader.release() };
}

interface BridgeServer {
  server: net.Server;
  url: string;
}

/** 16 raw bytes of an IPv6 literal (ATYP=4). */
function ipv6Bytes(host: string): Buffer {
  let h = host.replace(/^\[|\]$/g, "");
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4) -> two hextets.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    h = h.slice(0, v4.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail = ""] = h.split("::");
  const hs = head ? head.split(":") : [];
  const ts = tail ? tail.split(":") : [];
  const fill = Array(Math.max(0, 8 - hs.length - ts.length)).fill("0");
  const parts = h.includes("::") ? [...hs, ...fill, ...ts] : hs;
  const out = Buffer.alloc(16);
  parts.slice(0, 8).forEach((p, i) => out.writeUInt16BE(parseInt(p || "0", 16) & 0xffff, i * 2));
  return out;
}

export class Socks5Bridge {
  private servers = new Map<string, Promise<BridgeServer>>();
  private lastErrors = new Map<string, string>();
  /** Per-bridge secret: the loopback proxy is otherwise an open relay through the provider's paid upstream. */
  private readonly token = crypto.randomBytes(18).toString("base64url");

  constructor(private readonly log?: (msg: string) => void) {}

  /** Loopback HTTP proxy URL fronting the given socks5(h):// proxy (created on first use). */
  async localProxyFor(socksUrl: string): Promise<string> {
    let p = this.servers.get(socksUrl);
    if (!p) {
      p = this.start(socksUrl);
      this.servers.set(socksUrl, p);
      p.catch(() => this.servers.delete(socksUrl));
    }
    return (await p).url;
  }

  /** Last SOCKS-level failure recorded for this upstream (consumed on read). */
  consumeError(socksUrl: string): string | null {
    const e = this.lastErrors.get(socksUrl) ?? null;
    this.lastErrors.delete(socksUrl);
    return e;
  }

  /** Drop bridges for upstreams no longer in the pool. */
  retain(socksUrls: Set<string>): void {
    for (const [url, p] of this.servers) {
      if (socksUrls.has(url)) continue;
      this.servers.delete(url);
      p.then((b) => b.server.close()).catch(() => {});
    }
  }

  close(): void {
    this.retain(new Set());
  }

  private start(socksUrl: string): Promise<BridgeServer> {
    const target = parseSocks5Url(socksUrl);
    if (!target) return Promise.reject(new Error("socks5: invalid proxy URL"));
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => this.handle(client, socksUrl, target));
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        // Bun.fetch and Claude Code both turn URL userinfo into Proxy-Authorization.
        const url = `http://x:${this.token}@127.0.0.1:${addr.port}`;
        this.log?.(`[socks5-bridge] ${target.host}:${target.port} -> ${url}`);
        resolve({ server, url });
      });
    });
  }

  private handle(client: net.Socket, socksUrl: string, target: Socks5Target): void {
    let buf = Buffer.alloc(0);
    client.on("error", () => {});
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) {
        if (buf.length > MAX_HEAD_BYTES) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const head = buf.subarray(0, idx + 4).toString("latin1");
      const rest = buf.subarray(idx + 4);
      void this.tunnel(client, socksUrl, target, head, rest);
    };
    client.on("data", onData);
  }

  private authorized(head: string): boolean {
    const m = /^proxy-authorization:\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$/im.exec(head);
    if (!m) return false;
    const given = Buffer.from(m[1], "base64").toString("utf8").split(":").slice(1).join(":");
    const want = Buffer.from(this.token);
    const got = Buffer.from(given);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  private async tunnel(client: net.Socket, socksUrl: string, target: Socks5Target, head: string, rest: Buffer): Promise<void> {
    if (!this.authorized(head)) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"1dayapi-node\"\r\nConnection: close\r\n\r\n");
      return;
    }
    const line = head.split("\r\n")[0];
    let host: string;
    let port: number;
    let forward: Buffer | null = null; // bytes to send upstream after connect (absolute-URI form)
    const connect = /^CONNECT\s+(\[[^\]]+\]|[^\s:]+):(\d+)\s+HTTP\/1\.[01]$/i.exec(line);
    if (connect) {
      host = connect[1].replace(/^\[|\]$/g, "");
      port = Number(connect[2]);
    } else {
      const abs = /^([A-Z]+)\s+http:\/\/([^/\s]+)(\/[^\s]*)?\s+(HTTP\/1\.[01])$/i.exec(line);
      if (!abs) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
        return;
      }
      const hp = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(abs[2]);
      host = (hp?.[1] ?? abs[2]).replace(/^\[|\]$/g, "");
      port = hp?.[2] ? Number(hp[2]) : 80;
      const originForm = `${abs[1]} ${abs[3] || "/"} ${abs[4]}`;
      const headers = head
        .split("\r\n")
        .slice(1)
        .filter((h) => h && !/^proxy-connection:/i.test(h) && !/^proxy-authorization:/i.test(h));
      forward = Buffer.concat([Buffer.from(`${originForm}\r\n${headers.join("\r\n")}\r\n\r\n`, "latin1"), rest]);
    }
    let up: net.Socket;
    let leftover: Buffer;
    try {
      ({ socket: up, leftover } = await socks5Connect(target, host, port));
    } catch (err) {
      const msg = (err as Error).message;
      this.lastErrors.set(socksUrl, msg);
      if (!client.destroyed) {
        client.end(`HTTP/1.1 502 Bad Gateway\r\nX-Socks5-Error: ${msg.replace(/[\r\n]/g, " ")}\r\nConnection: close\r\n\r\n`);
      }
      return;
    }
    if (client.destroyed) {
      up.destroy();
      return;
    }
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    up.on("close", () => client.destroy());
    client.on("close", () => up.destroy());
    if (connect) {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) up.write(rest);
    } else if (forward) {
      up.write(forward);
    }
    if (leftover.length) client.write(leftover);
    client.pipe(up);
    up.pipe(client);
    client.resume();
  }
}
