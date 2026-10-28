// Local capture server for Claude Code sampling (docs/claude-code-compat.md §1/§11):
// records every request (method, url, headers, body) as one JSON line and answers 401.
//   node capsrv.mjs /path/to/out.ndjson   (listens on 127.0.0.1:18999; point ANTHROPIC_BASE_URL at it)
import http from "node:http";
import fs from "node:fs";
const out = process.argv[2];
http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    fs.appendFileSync(out, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: body.slice(0, 4_000_000) }) + "\n");
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "capture" } }));
  });
}).listen(18999, "127.0.0.1");
