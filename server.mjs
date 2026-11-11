import http from "node:http";
import handler from "./api/chat.js";

const raw = process.env.GEMINI_API_KEY || "";
const b64 = process.env.GEMINI_API_KEY_B64 || "";
if ((!raw || raw.length < 20) && b64) {
  try { process.env.GEMINI_API_KEY = Buffer.from(b64, "base64").toString("utf8"); }
  catch { /* leave unset */ }
}
console.log("uu-mentor env key_len=" + (process.env.GEMINI_API_KEY || "").length + " b64_len=" + b64.length);

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
