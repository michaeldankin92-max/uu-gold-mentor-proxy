/**
 * Shared CORS + rate limit for the UU mentor/verify proxy.
 * 20 requests / 10 minutes per IP. Origins limited to the live PWA and local preview.
 */
export const ALLOWED = new Set([
  "https://universe-unlimited-app.surge.sh",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
  "http://127.0.0.1:8765/",
]);

const hits = new Map();
export const WINDOW_MS = 10 * 60 * 1000;
export const MAX_HITS = 20;

export function cors(origin) {
  const allow = origin && ([...ALLOWED].some((o) => origin === o || origin === o.replace(/\/$/, "")));
  return {
    "Access-Control-Allow-Origin": allow ? origin : "https://universe-unlimited-app.surge.sh",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

export function json(res, status, obj, origin) {
  const headers = cors(origin);
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

export function rateLimit(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_HITS) {
    hits.set(ip, arr);
    return false;
  }
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

export function readBody(req, maxBytes = 200000) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    if (typeof req.body === "string") {
      try { return resolve(JSON.parse(req.body || "{}")); } catch (e) { return reject(e); }
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > maxBytes) {
        req.destroy();
        reject(new Error("too_large"));
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
