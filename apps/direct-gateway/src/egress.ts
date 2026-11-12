import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate, createZstdDecompress } from "node:zlib";
import { Socks5Bridge, isSocks5Url } from "./socks5-bridge.js";
import type { RuntimeAccount } from "./types.js";

export type BunFetchInit = RequestInit & { proxy?: string; decompress?: boolean };
const bunFetch = fetch as unknown as (url: string, init?: BunFetchInit) => Promise<Response>;

export class EgressError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function decompressBody(body: ReadableStream<Uint8Array>, encoding: string | null): ReadableStream<Uint8Array> {
  const enc = (encoding ?? "").trim().toLowerCase();
  const decoder = enc === "gzip" || enc === "x-gzip" ? createGunzip() : enc === "br" ? createBrotliDecompress() : enc === "deflate" ? createInflate() : enc === "zstd" ? createZstdDecompress() : null;
  if (!decoder) return body;
  const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  source.on("error", (error) => decoder.destroy(error));
  return Readable.toWeb(source.pipe(decoder)) as ReadableStream<Uint8Array>;
}

export function decodedResponse(response: Response): Response {
  const encoding = response.headers.get("content-encoding");
  if (!encoding || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Response(decompressBody(response.body, encoding), { status: response.status, statusText: response.statusText, headers });
}

export class Egress {
  private readonly socks = new Socks5Bridge();

  async proxyFor(account: RuntimeAccount): Promise<string> {
    if (!account.proxy) throw new EgressError("no_proxy_available", `Account ${account.id} has no bound proxy`);
    try {
      return isSocks5Url(account.proxy) ? await this.socks.localProxyFor(account.proxy) : account.proxy;
    } catch (error) {
      throw new EgressError("no_proxy_available", (error as Error).message);
    }
  }

  async request(account: RuntimeAccount, url: string, init: RequestInit = {}): Promise<Response> {
    const proxy = await this.proxyFor(account);
    try {
      const response = await bunFetch(url, { ...init, proxy, decompress: false, redirect: "manual" });
      return decodedResponse(response);
    } catch (error) {
      throw new EgressError("upstream_connect_failed", (error as Error).message);
    }
  }

  close(): void {
    this.socks.close();
  }
}
