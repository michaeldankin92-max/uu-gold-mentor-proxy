/**
 * Web Push for Universe Unlimited.
 * VAPID private key is read only from env (VAPID_PRIVATE_KEY). Never log it,
 * never put it in the PWA or git. Subscriptions are stored on this instance
 * (memory + local JSON) and are ephemeral on the free Render plan.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors, json, rateLimit, readBody } from "./http.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = process.env.PUSH_STORE_PATH || path.join(ROOT, "..", "data", "push-store.json");
const VERIFY_PATH = process.env.VERIFY_STORE_PATH || path.join(ROOT, "..", "data", "verify-store.json");

const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const privateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const subject = String(process.env.VAPID_SUBJECT || "mailto:michaeldankin92@gmail.com").trim();

let webpush = null;
async function getWebPush() {
  if (webpush) return webpush;
  const mod = await import("web-push");
  webpush = mod.default || mod;
  return webpush;
}

export function vapidConfigured() {
  return publicKey.length >= 80 && privateKey.length >= 40;
}

// Log only lengths — never the private key.
console.log(
  "uu-push vapid_configured=" + (vapidConfigured() ? "1" : "0"),
  "public_len=" + publicKey.length,
  "private_len=" + privateKey.length
);

function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return { subs: Array.isArray(j.subs) ? j.subs : [], sent: j.sent && typeof j.sent === "object" ? j.sent : {} };
  } catch {
    return { subs: [], sent: {} };
  }
}

function saveStore(store) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = STORE_PATH + ".tmp";
    const slim = { subs: (store.subs || []).slice(-500), sent: pruneSent(store.sent || {}) };
    fs.writeFileSync(tmp, JSON.stringify(slim), { mode: 0o600 });
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("push store write failed", e && e.message);
  }
}

function pruneSent(sent) {
  const cut = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const out = {};
  for (const [k, v] of Object.entries(sent)) {
    const t = typeof v === "number" ? v : Date.parse(v) || 0;
    if (t >= cut) out[k] = v;
  }
  return out;
}

function deviceVerified(deviceId) {
  if (!deviceId) return false;
  try {
    const j = JSON.parse(fs.readFileSync(VERIFY_PATH, "utf8"));
    const uid = j.devices && j.devices[deviceId];
    if (!uid) return false;
    const bound = j.uids && j.uids[uid] === deviceId;
    return !!bound;
  } catch {
    return false;
  }
}

function validSub(s) {
  return s && typeof s.endpoint === "string" && s.endpoint.startsWith("https://") &&
    s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";
}

export function alreadySent(key) {
  const store = loadStore();
  return !!store.sent[key];
}

export function markSent(key) {
  const store = loadStore();
  store.sent[key] = Date.now();
  saveStore(store);
}

/**
 * type: "session" | "analyst" | "signal" | "news"
 * Signal alerts go only to subscriptions whose device passed Access verification.
 */
export async function notifyAll(type, payload) {
  if (!vapidConfigured()) return { sent: 0, skipped: "vapid_not_configured" };
  const wp = await getWebPush();
  const store = loadStore();
  const body = JSON.stringify({
    title: payload.title || "Universe Unlimited",
    body: payload.body || "",
    tag: payload.tag || type,
    data: payload.data || { type },
  });
  const details = { vapidDetails: { subject, publicKey, privateKey } };
  let sent = 0;
  const keep = [];
  for (const sub of store.subs) {
    const alerts = sub.alerts || {};
    const want =
      (type === "session" && alerts.session !== false) ||
      (type === "analyst" && alerts.analyst !== false) ||
      (type === "news" && alerts.news !== false) ||
      (type === "signal" && alerts.signal === true && (sub.signalOk || deviceVerified(sub.deviceId)));
    if (!want) { keep.push(sub); continue; }
    try {
      await wp.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, details);
      sent += 1;
      keep.push(sub);
    } catch (e) {
      const st = e.statusCode || e.status || 0;
      if (st === 404 || st === 410) {
        // drop expired subscription; do not log the endpoint
        console.error("push dropped stale subscription", st);
      } else {
        console.error("push send failed", st || (e.message || "").slice(0, 80));
        keep.push(sub);
      }
    }
  }
  store.subs = keep;
  saveStore(store);
  console.log("push type", type, "sent", sent);
  return { sent };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    const headers = cors(origin);
    res.statusCode = 204;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return res.end();
  }
  const url = new URL(req.url || "/", "http://localhost");
  const pathName = url.pathname;

  if (req.method === "GET" && (pathName === "/push/public-key" || pathName === "/api/push/public-key" || pathName === "/push/status")) {
    return json(res, 200, {
      configured: vapidConfigured(),
      publicKey: vapidConfigured() ? publicKey : "",
      ephemeralStore: !process.env.UU_PUSH_STORE,
      note: "Subscriptions are stored on this free instance and may be cleared on sleep or deploy unless a private persistent store token is added.",
    }, origin);
  }

  if (req.method !== "POST") return json(res, 404, { error: "POST /subscribe" }, origin);
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!rateLimit(ip)) return json(res, 429, { error: "rate_limit" }, origin);

  if (!vapidConfigured()) {
    return json(res, 503, { error: "push_not_configured", message: "Notifications are not configured on the host yet." }, origin);
  }

  let body;
  try { body = await readBody(req, 20000); }
  catch { return json(res, 400, { error: "invalid json" }, origin); }

  if (body.unsubscribe && body.subscription && body.subscription.endpoint) {
    const store = loadStore();
    store.subs = store.subs.filter((s) => s.endpoint !== body.subscription.endpoint);
    saveStore(store);
    return json(res, 200, { ok: true, unsubscribed: true }, origin);
  }

  const sub = body.subscription || body;
  if (!validSub(sub)) return json(res, 400, { error: "bad_subscription" }, origin);
  const alerts = {
    session: body.alerts?.session !== false,
    analyst: body.alerts?.analyst !== false,
    news: body.alerts?.news !== false,
    signal: body.alerts?.signal === true,
  };
  const deviceId = String(body.deviceId || "").trim();
  const signalOk = alerts.signal && deviceVerified(deviceId);
  const store = loadStore();
  const rec = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    alerts,
    deviceId: deviceId || null,
    signalOk,
    at: new Date().toISOString(),
  };
  store.subs = store.subs.filter((s) => s.endpoint !== rec.endpoint).concat([rec]).slice(-500);
  saveStore(store);
  return json(res, 200, { ok: true, signalOk, configured: true }, origin);
}
