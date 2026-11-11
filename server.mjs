import http from "node:http";
import chat from "./api/chat.js";
import mentor from "./api/mentor.js";
import verify from "./api/verify.js";
import analyst, { sessionTick } from "./api/analyst.js";
import news from "./api/news.js";
import { newsPushTick } from "./api/calendar.js";
import push, { vapidConfigured } from "./api/push.js";
import community from "./api/community.js";
import { cors } from "./api/http.js";

const keyLen = (process.env.GEMINI_API_KEY || "").length;
console.log("uu-mentor env key_len=" + keyLen, "vapid=" + (vapidConfigured() ? "1" : "0"));

const port = Number(process.env.PORT) || 3000;

function route(urlPath) {
  const p = urlPath.replace(/\/$/, "") || "/";
  if (p === "/chat" || p === "/api/chat") return chat;
  if (p === "/mentor" || p === "/api/mentor") return mentor;
  if (p === "/verify" || p === "/api/verify") return verify;
  if (p === "/analyst" || p === "/api/analyst") return analyst;
  if (p === "/news" || p === "/api/news" || p === "/radar" || p === "/api/radar") return news;
  if (p === "/community" || p.startsWith("/community/") || p.startsWith("/api/community")) return community;
  if (p === "/subscribe" || p === "/api/subscribe" || p.startsWith("/push/") || p.startsWith("/api/push/")) return push;
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health" || url.pathname === "/health/" || (req.method === "GET" && url.pathname === "/")) {
      const origin = req.headers.origin || "";
      const headers = Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors(origin));
      if (!origin) headers["Access-Control-Allow-Origin"] = "*";
      if (req.method === "OPTIONS") {
        res.writeHead(204, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, service: "uu-mentor", routes: ["/chat", "/mentor", "/verify", "/analyst", "/news", "/subscribe", "/community"] }));
      return;
    }
    const handler = route(url.pathname);
    if (handler) {
      await handler(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
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

function tick() {
  sessionTick().catch((e) => console.error("session tick", e.message || e));
  newsPushTick().catch((e) => console.error("news tick", e.message || e));
}
setTimeout(tick, 8000);
setInterval(tick, 60 * 1000);
