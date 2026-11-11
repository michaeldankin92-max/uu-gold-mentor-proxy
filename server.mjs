import http from "node:http";
import handler from "./api/chat.js";

const keyLen = (process.env.GEMINI_API_KEY || "").length;
console.log("uu-mentor env key_len=" + keyLen);

const port = Number(process.env.PORT) || 3000;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health" || (req.method === "GET" && url.pathname === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "uu-mentor" }));
      return;
    }
    if (url.pathname === "/chat" || url.pathname === "/api/chat") {
      await handler(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST /chat only" }));
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server" }));
    }
  }
});
server.listen(port, () => {
  console.log("uu-mentor listening on " + port);
});
