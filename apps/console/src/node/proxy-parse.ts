import { isIP } from "node:net";

// Loose proxy-address parser for operator input (docs/onboarding.md §4.1, 2026-10-28).
// Operators paste proxies in whatever shape their provider hands out; the pool
// stores one canonical URL per proxy so the same box is recognised again.
//
// Accepted shapes (scheme defaults to socks5; socks/socks5/socks5h/http/https kept):
//   socks5://user:pass@host:port      http://host:port
//   user:pass@host:port               host:port
//   host:port:user:pass               user:pass:host:port
//   host port user pass               host:port user:pass   (space / comma / tab / | / ;)
// IPv6 hosts are accepted bracketed ([::1]:1080) or bare in the URL/userinfo forms.

export type ProxyScheme = "socks5" | "socks5h" | "http" | "https";

export interface ParsedProxy {
  scheme: ProxyScheme;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

const SCHEME_ALIASES: Record<string, ProxyScheme> = {
  socks: "socks5",
  socks5: "socks5",
  socks5h: "socks5h",
  http: "http",
  https: "https",
};

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function parsePort(s: string | undefined | null): number | null {
  if (!s || !/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Hostname / IPv4 / IPv6 (brackets stripped). Returns the normalised host or null. */
function parseHost(s: string | undefined | null): string | null {
  if (!s) return null;
  let h = s.trim();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h) return null;
  if (isIP(h)) return h.toLowerCase();
  if (HOSTNAME_RE.test(h)) return h.toLowerCase();
  return null;
}

/** "host:port" / "[v6]:port" / "v6:port" (last colon) → {host, port} or null. */
function parseHostPort(s: string): { host: string; port: number } | null {
  const t = s.trim();
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(t);
  if (m) {
    const host = parseHost(m[1]);
    const port = parsePort(m[2]);
    return host && port ? { host, port } : null;
  }
  const i = t.lastIndexOf(":");
  if (i <= 0) return null;
  const host = parseHost(t.slice(0, i));
  const port = parsePort(t.slice(i + 1));
  return host && port ? { host, port } : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function build(scheme: ProxyScheme, host: string, port: number, username?: string | null, password?: string | null): ParsedProxy {
  return { scheme, host, port, username: username ? username : null, password: password ? password : null };
}

/** A URL with a scheme, through the WHATWG parser (handles encoded userinfo and '@' in passwords). */
function parseUrlForm(scheme: ProxyScheme, s: string): ParsedProxy | null {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = parseHost(u.hostname);
  const port = parsePort(u.port);
  if (!host || !port) return null;
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return null;
  return build(scheme, host, port, safeDecode(u.username), safeDecode(u.password));
}

/** "user:pass@host:port" (last '@' separates credentials, first ':' splits user/pass). */
function parseUserinfoForm(scheme: ProxyScheme, s: string): ParsedProxy | null {
  const at = s.lastIndexOf("@");
  if (at < 0) return null;
  const creds = s.slice(0, at);
  const hp = parseHostPort(s.slice(at + 1));
  if (!hp) return null;
  const c = creds.indexOf(":");
  const user = c < 0 ? creds : creds.slice(0, c);
  const pass = c < 0 ? "" : creds.slice(c + 1);
  return build(scheme, hp.host, hp.port, safeDecode(user), safeDecode(pass));
}

/** Colon-separated fields (no '@'): host:port, host:port:user:pass, user:pass:host:port. */
function parseColonForm(scheme: ProxyScheme, s: string): ParsedProxy | null {
  const bare = parseHostPort(s);
  if (bare) return build(scheme, bare.host, bare.port);
  const parts = s.split(":");
  if (parts.length < 4) return null;
  // host:port:user:pass — the password keeps any further colons.
  const frontHost = parseHost(parts[0]);
  const frontPort = parsePort(parts[1]);
  if (frontHost && frontPort) return build(scheme, frontHost, frontPort, parts[2], parts.slice(3).join(":"));
  // user:pass:host:port — the password keeps any inner colons.
  const n = parts.length;
  const backHost = parseHost(parts[n - 2]);
  const backPort = parsePort(parts[n - 1]);
  if (backHost && backPort) return build(scheme, backHost, backPort, parts[0], parts.slice(1, n - 2).join(":"));
  return null;
}

/** Fields split on whitespace / , ; | : host port [user pass], host:port [user:pass], user pass host port. */
function parseTokenForm(scheme: ProxyScheme, tokens: string[]): ParsedProxy | null {
  const fields = tokens.flatMap((tok) => (tok.includes("@") ? [tok] : tok.split(":")));
  if (fields.some((f) => f.includes("@"))) {
    // "user:pass@host:port extra" is not a shape we know.
    return null;
  }
  if (fields.length === 2) {
    const host = parseHost(fields[0]);
    const port = parsePort(fields[1]);
    return host && port ? build(scheme, host, port) : null;
  }
  if (fields.length === 4) {
    const fh = parseHost(fields[0]);
    const fp = parsePort(fields[1]);
    if (fh && fp) return build(scheme, fh, fp, fields[2], fields[3]);
    const bh = parseHost(fields[2]);
    const bp = parsePort(fields[3]);
    if (bh && bp) return build(scheme, bh, bp, fields[0], fields[1]);
  }
  return null;
}

/** Parse one operator-supplied proxy line; null when no known shape fits. */
export function parseProxyInput(raw: string): ParsedProxy | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!s || s.length > 500) return null;
  let scheme: ProxyScheme = "socks5";
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(s);
  if (m) {
    const alias = SCHEME_ALIASES[m[1].toLowerCase()];
    if (!alias) return null;
    scheme = alias;
    const direct = parseUrlForm(scheme, `${scheme}://${m[2]}`);
    if (direct) return direct;
    s = m[2].replace(/\/+$/, "");
  }
  const tokens = s.split(/[\s,;|]+/).filter(Boolean);
  if (tokens.length === 1) {
    // "user:pass@host:port" first; a password containing '@' in the colon forms
    // ("host:port:user:p@ss") falls through to the colon reading.
    const one = tokens[0];
    return (one.includes("@") ? parseUserinfoForm(scheme, one) : null) ?? parseColonForm(scheme, one);
  }
  return parseTokenForm(scheme, tokens);
}

const USERINFO_SAFE = /^[A-Za-z0-9._~!$&'()*+,;=-]*$/;
function encodeUserinfo(s: string): string {
  return USERINFO_SAFE.test(s) ? s : encodeURIComponent(s);
}

/** Canonical URL for the pool: scheme://user:pass@host:port (userinfo encoded only when needed). */
export function canonicalProxyUrl(p: ParsedProxy): string {
  const host = isIP(p.host) === 6 ? `[${p.host}]` : p.host;
  const auth = p.username || p.password ? `${encodeUserinfo(p.username ?? "")}:${encodeUserinfo(p.password ?? "")}@` : "";
  return `${p.scheme}://${auth}${host}:${p.port}`;
}

/**
 * Identity of a proxy endpoint independent of how it was written: host, port and
 * credentials. The scheme is left out on purpose — one port speaks one protocol,
 * so "the same host:port with the same credentials" is the same proxy, and the
 * URL already in the pool is the one proven to work.
 */
export function proxyFingerprint(p: ParsedProxy): string {
  return `${p.host.toLowerCase()}|${p.port}|${p.username ?? ""}|${p.password ?? ""}`;
}

/** Fingerprint of a URL already stored in the pool (null when it cannot be parsed). */
export function proxyUrlFingerprint(url: string): string | null {
  const p = parseProxyInput(url);
  return p ? proxyFingerprint(p) : null;
}

/** user:***@host:port for messages (never the password). */
export function describeProxy(p: ParsedProxy): string {
  const host = isIP(p.host) === 6 ? `[${p.host}]` : p.host;
  return `${p.scheme}://${p.username ? `${p.username}:***@` : ""}${host}:${p.port}`;
}
