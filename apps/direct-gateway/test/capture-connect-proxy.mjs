import http from "node:http";

const port = Number(process.env.CAPTURE_PROXY_PORT ?? 19102);
const server = http.createServer((req, res) => {
  console.log(`[capture-http] ${req.method} ${req.url}`);
  res.writeHead(502);
  res.end();
});
server.on("connect", (req, client, head) => {
  console.log(`[capture-connect] ${req.url}`);
  client.on("error", () => {});
  client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  if (head.length) client.unshift(head);
  client.end();
});
server.on("clientError", (_error, socket) => socket.destroy());
server.listen(port, "127.0.0.1", () => console.log(`capture-proxy on 127.0.0.1:${port}`));
