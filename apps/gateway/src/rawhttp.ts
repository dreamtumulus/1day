import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { createGunzip, createBrotliDecompress, createInflate } from "node:zlib";

/**
 * 原生 http/https POST，返回 fetch 兼容的 Response。
 * 不用全局 fetch：undici fetch 会强加 `accept-language: *` 和 `sec-fetch-mode: cors`，
 * 官方 Claude Code（Bun）不发这两个头（docs/claude-code-compat.md §3/§7）。
 */

const agentHttp = new http.Agent({ keepAlive: true });
const agentHttps = new https.Agent({ keepAlive: true });

export function postRaw(
  url: URL,
  headers: Record<string, string>,
  body: string,
  headerTimeoutMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request(
      url,
      {
        method: "POST",
        agent: isHttps ? agentHttps : agentHttp,
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let stream: Readable = res;
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const dec = enc === "gzip" ? createGunzip() : enc === "br" ? createBrotliDecompress() : enc === "deflate" ? createInflate() : null;
        if (dec) {
          // pipe() does not forward source errors: a mid-body socket reset would
          // otherwise leave the decoder (and the reader waiting on it) open forever.
          res.on("error", (err) => dec.destroy(err));
          stream = res.pipe(dec);
        }
        const headersOut: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v !== "string") continue;
          if (k === "content-encoding" || k === "content-length") continue;
          headersOut[k] = v;
        }
        resolve(
          new Response(Readable.toWeb(stream) as ReadableStream, {
            status: res.statusCode ?? 502,
            headers: headersOut,
          }),
        );
      },
    );
    // 只约束响应头等待时间；流式 body 开始后不再掐断。
    const timer = setTimeout(() => {
      req.destroy(new Error("upstream header timeout"));
    }, headerTimeoutMs);
    req.on("response", () => clearTimeout(timer));
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}
