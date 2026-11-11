/**
 * Universe Unlimited — Community chat ("our own Telegram").
 * Routes: /community/*  (kept in this one module so other proxy work is untouched).
 *
 * Storage: Render Postgres (free plan) when COMMUNITY_DATABASE_URL (or DATABASE_URL) is set,
 * otherwise a local JSON file (ephemeral on the free web plan).
 * Auth: display name + random device token (only its SHA-256 is stored).
 * Admin: COMMUNITY_ADMIN_CODE env only (compared as hashes, never logged).
 * Real time: Server-Sent Events, with /community/updates polling as fallback.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ALLOWED, readBody } from "./http.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.COMMUNITY_DATA_DIR || path.join(ROOT, "..", "data");
const FILE_PATH = path.join(DATA_DIR, "community-store.json");
const IMG_DIR = path.join(DATA_DIR, "community-img");
const DB_URL = String(process.env.COMMUNITY_DATABASE_URL || process.env.DATABASE_URL || "").trim();

const VAPID_PUBLIC = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || "mailto:michaeldankin92@gmail.com").trim();

export const RISK_LINE = "Education only · not financial advice · not a buy or sell call · trading carries risk of loss.";

export const CHANNELS = [
  { id: "announcements", name: "Announcements", adminOnly: true, desc: "Official updates from Michael and the Universe Unlimited team." },
  { id: "signals", name: "Signals & Study Notes", adminOnly: true, desc: "Chart breakdowns and study notes from Michael. For learning only — not a buy or sell call." },
  { id: "qa", name: "Q&A", adminOnly: false, desc: "Ask about the app, ACCM setup, risk, and lot size. Be kind, be specific." },
  { id: "wins", name: "Wins & Lessons", adminOnly: false, desc: "Share journal lessons in pips and R. No money screenshots or income claims." },
  { id: "general", name: "General", adminOnly: false, desc: "Say hi and talk about your trading journey. Keep it respectful." },
];
const CH = new Map(CHANNELS.map((c) => [c.id, c]));
export const REACTIONS = ["👍", "❤️", "🔥", "🙏", "💡", "😂"];
const PALETTE = ["#8A5A14", "#1F6F5C", "#2E5E9E", "#8B3A62", "#6B4FA0", "#9A4B1E", "#2F7D32", "#7A6420", "#1D6E8C", "#A0442F"];
const MEM_PER_CH = 600;

/* ---------------- moderation ---------------- */
const PROFANITY = [
  "putang ?ina", "puta", "tang ?ina", "tangina", "gago", "gaga", "ulol", "tarantado", "punyeta", "leche", "pakyu", "kupal", "bobo", "tanga",
  "fuck\\w*", "f\\*ck", "shit\\w*", "bitch\\w*", "asshole", "cunt", "motherfucker", "bastard", "dickhead",
];
const PROF_RE = new RegExp("\\b(" + PROFANITY.join("|") + ")\\b", "gi");
const TLD = "com|net|org|io|co|me|ph|xyz|app|sh|global|info|biz|live|link|ly|gg|ai|site|online|top|vip|club|pro|trade|finance|money|market|cc|tk|ru|uk|sg|asia|page|dev|ws|cn|win|icu|fun|store|shop|tv|be|gl|to";
const URL_RE = new RegExp("\\b((?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)+(?:" + TLD + "))(?::\\d+)?(?:\\/[^\\s]*)?", "gi");
const ALLOWED_HOSTS = ["accm.global", "universe-unlimited-app.surge.sh", "pde-gold-academy.surge.sh", "tradingview.com", "forexfactory.com"];
const BROKERS = "exness|xm|xmglobal|octa|octafx|fbs|hfm|hotforex|ic ?markets|pepperstone|vantage|fxtm|tickmill|xtb|avatrade|fxpro|roboforex|deriv|binary\\.com|olymp ?trade|iq ?option|quotex|pocket ?option|headway|fxprimus|justmarkets|just2trade|instaforex|alpari|libertex|plus500|etoro|weltrade|axi|axitrader|fp ?markets|tmgm|ultima|puprime|startrader|doo prime|taurex|mtrading|amarkets";
const BROKER_PROMO_RE = new RegExp("\\b(" + BROKERS + ")\\b[^\\n]{0,40}\\b(code|link|register|sign ?up|referral|ref|ib|join|open (an )?account|bonus|rebate)\\b|\\b(code|link|register|sign ?up|referral|join|bonus|rebate)\\b[^\\n]{0,40}\\b(" + BROKERS + ")\\b", "i");
const CONTACT_SPAM_RE = /\b(t\.me|telegram\.me|wa\.me|chat\.whatsapp\.com|bit\.ly|tinyurl\.com|linktr\.ee)\b|\b(dm|pm|inbox|message|chat|whatsapp|telegram|viber)\s+(me|ako|mo ako|us)\b[^\n]{0,40}\b(signal|account|profit|invest|earn|kita|income|join|vip|recover|manage|withdraw)/i;
const INCOME_RES = [
  /\b(earn|earning|earned|kita|kumita|kikita|make|making|made|profit|income|sahod|sweldo)\w*\b[^\n]{0,30}(\$|₱|php|usd|peso|\b\d{3,}|\b\d+\s?k\b)[^\n]{0,20}\b(daily|a day|per day|every day|weekly|a week|per week|monthly|a month|per month|araw[- ]?araw|kada araw|isang araw|sa isang araw|linggo|buwan)\b/i,
  /\b(guarantee[ds]?|guaranteed (profit|income|return)|sure ?profit|siguradong (kita|panalo|profit)|walang talo|no ?loss|risk[- ]?free|100\s?%\s?(win|profit|sure|accurate|legit)|double (your|ang) (money|capital|pera|puhunan)|passive income|account management|manage (your|ang) account|invest (with|sa) (me|amin|akin)|recovery expert|withdrawal proof|fund ?manager|get rich|yumaman)\b/i,
  /\b\d{1,4}\s?%\s?(daily|per day|a day|weekly|per week|a week|monthly|per month|roi|return)\b/i,
  /\b(x\s?\d{1,3}|\d{1,3}\s?x)\s+(your|ang)\s+(account|money|capital|pera|puhunan)\b/i,
];
const CALL_WORD = /\b(buy|sell|long|short|bili|bumili|benta|magbenta|ibenta)\b/i;
const CALL_LEVELS = /\b(tp\s?\d?|sl|entry|target|stop ?loss|take ?profit)\b|\b\d{4}(?:\.\d{1,2})?\b/i;
const CALL_URGENT = /\b(now|na|asap|ngayon|agad|go go|tara)\b/i;

function hostAllowed(h) {
  h = h.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/:?#]/)[0];
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith("." + a));
}

/** Returns { ok, text, reason?, flag? } */
export function checkText(raw, { admin = false } = {}) {
  let text = String(raw || "").replace(/\r\n?/g, "\n").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > 1500) return { ok: false, reason: "too_long", message: "Message is too long (1,500 characters max)." };
  if (admin) return { ok: true, text };
  const flat = text.toLowerCase().replace(/\s+/g, " ");
  if (CONTACT_SPAM_RE.test(flat)) return { ok: false, reason: "contact_spam", message: "Invite links and 'DM me' offers are not allowed here." };
  if (BROKER_PROMO_RE.test(flat)) return { ok: false, reason: "broker_promo", message: "Only ACCM links and codes are allowed in this community." };
  const urls = text.match(URL_RE) || [];
  for (const u of urls) {
    if (!hostAllowed(u)) return { ok: false, reason: "link", message: "Links are limited to ACCM and Universe Unlimited pages." };
  }
  for (const re of INCOME_RES) if (re.test(flat)) return { ok: false, reason: "income_claim", message: "Income or profit claims are not allowed. Share lessons in pips and R instead." };
  text = text.replace(PROF_RE, (w) => w[0] + "*".repeat(Math.max(2, w.length - 1)));
  let flag = null;
  const isQuestion = /\?\s*$/.test(text) || /^(pwede|paano|ano|should|can|is|what|how|why|when)\b/i.test(text);
  if (!isQuestion && CALL_WORD.test(text) && (CALL_LEVELS.test(text) || CALL_URGENT.test(text))) flag = "trade_call";
  return { ok: true, text, flag };
}

export function checkName(raw) {
  const name = String(raw || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 24) return { ok: false, message: "Name must be 2–24 characters." };
  if (!/^[\p{L}\p{N} ._'-]+$/u.test(name)) return { ok: false, message: "Use letters, numbers, spaces, dot, dash or underscore." };
  PROF_RE.lastIndex = 0;
  if (PROF_RE.test(name)) { PROF_RE.lastIndex = 0; return { ok: false, message: "Please choose a respectful name." }; }
  PROF_RE.lastIndex = 0;
  const reserved = /(michael|dankin|admin|moderator|\bmod\b|official|universe ?unlimited|\buu\b|support|mentor|accm|coach lady)/i.test(name);
  return { ok: true, name, reserved };
}

/* ---------------- store ---------------- */
const S = {
  kind: "file",
  users: new Map(), tokens: new Map(), msgs: [], byId: new Map(), subs: new Map(), reports: new Map(),
  seq: 0, rev: 0,
};
let pool = null;
let writeChain = Promise.resolve();
let fileTimer = null;

function sha(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function now() { return Date.now(); }

async function pgInit() {
  const mod = await import("pg");
  const pg = mod.default || mod;
  const needSsl = /\.render\.com|sslmode=require/.test(DB_URL);
  pool = new pg.Pool({ connectionString: DB_URL, ssl: needSsl ? { rejectUnauthorized: false } : false, max: 4, idleTimeoutMillis: 30000 });
  pool.on("error", (e) => console.error("community pg pool", (e && e.message || "").slice(0, 120)));
  await pool.query(`create table if not exists uu_community_docs (
    kind text not null, id text not null, data jsonb not null,
    updated_at timestamptz not null default now(), primary key (kind, id))`);
  await pool.query(`create index if not exists uu_community_docs_kind_upd on uu_community_docs (kind, updated_at desc)`);
  const q = (k, lim) => pool.query("select data from uu_community_docs where kind=$1 order by updated_at desc limit $2", [k, lim]).then((r) => r.rows.map((x) => x.data));
  const [users, msgs, subs, reports] = await Promise.all([q("user", 20000), q("msg", CHANNELS.length * MEM_PER_CH), q("sub", 5000), q("report", 500)]);
  return { users, msgs, subs, reports };
}
function fileLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
    return { users: j.users || [], msgs: j.msgs || [], subs: j.subs || [], reports: j.reports || [] };
  } catch { return { users: [], msgs: [], subs: [], reports: [] }; }
}
function fileSaveSoon() {
  if (fileTimer) return;
  fileTimer = setTimeout(() => {
    fileTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ users: [...S.users.values()], msgs: S.msgs, subs: [...S.subs.values()], reports: [...S.reports.values()] }), { mode: 0o600 });
      fs.renameSync(tmp, FILE_PATH);
    } catch (e) { console.error("community file save", e && e.message); }
  }, 400);
}
function put(kind, id, data) {
  if (S.kind === "pg") {
    writeChain = writeChain.then(() => pool.query(
      "insert into uu_community_docs(kind,id,data,updated_at) values($1,$2,$3,now()) on conflict (kind,id) do update set data=excluded.data, updated_at=now()",
      [kind, String(id), JSON.stringify(data)]
    )).catch((e) => console.error("community pg write", kind, (e && e.message || "").slice(0, 120)));
  } else fileSaveSoon();
}
function del(kind, id) {
  if (S.kind === "pg") {
    writeChain = writeChain.then(() => pool.query("delete from uu_community_docs where kind=$1 and id=$2", [kind, String(id)]))
      .catch((e) => console.error("community pg delete", (e && e.message || "").slice(0, 120)));
  } else fileSaveSoon();
}
async function putImg(id, mime, b64) {
  if (S.kind === "pg") {
    await pool.query("insert into uu_community_docs(kind,id,data) values('img',$1,$2) on conflict (kind,id) do update set data=excluded.data", [id, JSON.stringify({ mime, b64 })]);
  } else {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMG_DIR, id + ".json"), JSON.stringify({ mime, b64 }));
  }
}
async function getImg(id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  if (S.kind === "pg") {
    const r = await pool.query("select data from uu_community_docs where kind='img' and id=$1", [id]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  try { return JSON.parse(fs.readFileSync(path.join(IMG_DIR, id + ".json"), "utf8")); } catch { return null; }
}
async function dropImg(id) {
  if (!id) return;
  if (S.kind === "pg") del("img", id);
  else { try { fs.unlinkSync(path.join(IMG_DIR, id + ".json")); } catch {} }
}

function hydrate({ users, msgs, subs, reports }) {
  for (const u of users) { if (!u || !u.id) continue; S.users.set(u.id, u); if (u.tokenHash) S.tokens.set(u.tokenHash, u.id); }
  msgs = msgs.filter((m) => m && m.id).sort((a, b) => a.id - b.id);
  const perCh = {};
  for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; perCh[m.ch] = (perCh[m.ch] || 0) + 1; if (perCh[m.ch] <= MEM_PER_CH) S.byId.set(m.id, m); }
  S.msgs = msgs.filter((m) => S.byId.has(m.id));
  for (const m of S.msgs) { S.seq = Math.max(S.seq, m.id); S.rev = Math.max(S.rev, m.rev || 0); }
  for (const s of subs) if (s && s.id) S.subs.set(s.id, s);
  for (const r of reports) if (r && r.id) S.reports.set(r.id, r);
}

const ready = (async () => {
  if (DB_URL) {
    try {
      const d = await pgInit();
      S.kind = "pg";
      hydrate(d);
      console.log("uu-community store=pg users=" + S.users.size + " msgs=" + S.msgs.length);
      return;
    } catch (e) {
      console.error("uu-community pg unavailable, using file store:", (e && e.message || "").slice(0, 120));
      pool = null;
    }
  }
  hydrate(fileLoad());
  console.log("uu-community store=file users=" + S.users.size + " msgs=" + S.msgs.length);
})();

/* ---------------- helpers ---------------- */
function corsHeaders(origin) {
  const allow = origin && [...ALLOWED].some((o) => origin === o || origin === o.replace(/\/$/, ""));
  return {
    "Access-Control-Allow-Origin": allow ? origin : "https://universe-unlimited-app.surge.sh",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function send(res, status, obj, origin) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
function ipOf(req) { return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim(); }

const buckets = new Map();
function allow(key, max, windowMs) {
  const t = now();
  const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(t); buckets.set(key, arr); return true;
}
setInterval(() => { const t = now(); for (const [k, v] of buckets) if (!v.length || t - v[v.length - 1] > 3600000) buckets.delete(k); }, 600000).unref();

function authUser(req, url) {
  const h = String(req.headers.authorization || "");
  const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : String(url.searchParams.get("token") || "").trim();
  if (!tok || tok.length < 20) return null;
  const id = S.tokens.get(sha(tok));
  return id ? S.users.get(id) || null : null;
}
function isAdmin(u) { return !!u && u.role === "admin"; }
function adminCodeOk(code) {
  const env = String(process.env.COMMUNITY_ADMIN_CODE || "");
  if (!env || !code) return false;
  const a = Buffer.from(sha(env), "hex"), b = Buffer.from(sha(String(code).trim()), "hex");
  return crypto.timingSafeEqual(a, b);
}
function colorFor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
function pubUser(u) { return u ? { id: u.id, name: u.name, color: u.color, role: u.role || "member" } : { id: "x", name: "Deleted", color: "#888", role: "member" }; }
function pubMsg(m) {
  const u = S.users.get(m.uid);
  let reply = null;
  if (m.replyTo) {
    const r = S.byId.get(m.replyTo);
    reply = r ? { id: r.id, name: pubUser(S.users.get(r.uid)).name, text: r.deleted || r.hidden ? "Message removed" : (r.text || (r.img ? "Photo" : "")).slice(0, 120) } : { id: m.replyTo, name: "", text: "Earlier message" };
  }
  const gone = m.deleted || m.hidden;
  return {
    id: m.id, ch: m.ch, rev: m.rev, at: m.at, user: pubUser(u),
    text: gone ? "" : m.text, img: gone ? null : (m.img ? { id: m.img, w: m.imgW || 0, h: m.imgH || 0 } : null),
    deleted: !!m.deleted, hidden: !!m.hidden && !m.deleted, pinned: !!m.pinned && !gone, flag: gone ? null : (m.flag || null),
    reply, reactions: gone ? {} : (m.reactions || {}), edited: !!m.edited,
  };
}
function bump(m) { S.rev += 1; m.rev = S.rev; put("msg", m.id, m); broadcast("msg", pubMsg(m)); }

/* ---------------- realtime ---------------- */
const streams = new Set();
function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of streams) { try { s.res.write(line); } catch {} }
}
function onlineCount() { return new Set([...streams].map((s) => s.uid)).size; }
let lastOnline = -1;
function presence() { const n = onlineCount(); if (n !== lastOnline) { lastOnline = n; broadcast("presence", { online: n }); } }
setInterval(() => { for (const s of streams) { try { s.res.write(": ping\n\n"); } catch {} } }, 20000).unref();

/* ---------------- push ---------------- */
let webpush = null;
async function pushAnnouncement(m) {
  if (!(VAPID_PUBLIC.length >= 80 && VAPID_PRIVATE.length >= 40)) return { sent: 0, skipped: "vapid" };
  if (!webpush) { const mod = await import("web-push"); webpush = mod.default || mod; }
  const u = S.users.get(m.uid);
  const body = JSON.stringify({
    title: m.ch === "announcements" ? "📣 Universe Unlimited" : "📈 New study note",
    body: ((u ? u.name + ": " : "") + (m.text || "Sent a photo")).slice(0, 160),
    tag: "uu-community-" + m.ch,
    data: { type: "community", go: "community", ch: m.ch, id: m.id },
  });
  const details = { vapidDetails: { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE }, TTL: 6 * 3600 };
  let sent = 0, failed = 0;
  for (const s of [...S.subs.values()]) {
    if (!(s.chans || ["announcements"]).includes(m.ch)) continue;
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, details); sent += 1; }
    catch (e) {
      const st = e.statusCode || 0;
      if (st === 404 || st === 410) { S.subs.delete(s.id); del("sub", s.id); } else failed += 1;
    }
  }
  console.log("uu-community push", m.ch, "sent", sent, "failed", failed);
  return { sent, failed };
}

/* ---------------- handlers ---------------- */
function channelsView(read) {
  return CHANNELS.map((c) => {
    const list = S.msgs.filter((m) => m.ch === c.id && !m.deleted && !m.hidden);
    const last = list[list.length - 1];
    const lr = Number(read[c.id] || 0);
    return {
      ...c,
      count: list.length,
      unread: lr ? list.filter((m) => m.id > lr).length : Math.min(list.length, 99),
      lastId: last ? last.id : 0,
      last: last ? { at: last.at, name: pubUser(S.users.get(last.uid)).name, text: (last.text || (last.img ? "📷 Photo" : "")).slice(0, 90) } : null,
      pinned: list.filter((m) => m.pinned).slice(-3).map(pubMsg),
    };
  });
}

async function route(req, res, url, origin) {
  const p = url.pathname.replace(/^\/api/, "").replace(/\/$/, "");
  const ip = ipOf(req);
  const method = req.method;

  if (method === "GET" && p === "/community") {
    return send(res, 200, { ok: true, store: S.kind, channels: CHANNELS.map((c) => c.id), risk: RISK_LINE, online: onlineCount(), adminConfigured: !!process.env.COMMUNITY_ADMIN_CODE, push: VAPID_PUBLIC.length >= 80 }, origin);
  }

  if (method === "GET" && p.startsWith("/community/img/")) {
    const im = await getImg(p.split("/").pop());
    if (!im) return send(res, 404, { error: "not_found" }, origin);
    res.statusCode = 200;
    for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v);
    res.setHeader("Content-Type", im.mime);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    return res.end(Buffer.from(im.b64, "base64"));
  }

  if (method === "POST" && p === "/community/join") {
    if (!allow("join:" + ip, 20, 10 * 60000)) return send(res, 429, { error: "rate_limit", message: "Too many sign-ins. Try again in a few minutes." }, origin);
    let b; try { b = await readBody(req, 4000); } catch { return send(res, 400, { error: "bad_json" }, origin); }
    const n = checkName(b.name);
    if (!n.ok) return send(res, 400, { error: "bad_name", message: n.message }, origin);
    let admin = false;
    if (b.adminCode) {
      if (!allow("admin:" + ip, 8, 3600000)) return send(res, 429, { error: "rate_limit", message: "Too many admin attempts. Try again later." }, origin);
      admin = adminCodeOk(b.adminCode);
      if (!admin) return send(res, 403, { error: "bad_code", message: "That admin code is not right." }, origin);
    }
    if (n.reserved && !admin) return send(res, 400, { error: "reserved_name", message: "That name is reserved for the team. Please pick another." }, origin);
    const taken = [...S.users.values()].some((u) => u.name.toLowerCase() === n.name.toLowerCase());
    if (taken) return send(res, 409, { error: "name_taken", message: "That name is already used. Add an initial or number." }, origin);
    const id = crypto.randomBytes(8).toString("hex");
    const token = crypto.randomBytes(24).toString("base64url");
    const u = { id, name: n.name, color: colorFor(id), tokenHash: sha(token), role: admin ? "admin" : "member", createdAt: now(), mutedUntil: 0, strikes: [] };
    S.users.set(id, u); S.tokens.set(u.tokenHash, id); put("user", id, u);
    return send(res, 200, { ok: true, token, user: pubUser(u) }, origin);
  }

  if (method === "GET" && p === "/community/stream") {
    const u = authUser(req, url);
    if (!u) return send(res, 401, { error: "auth" }, origin);
    if ([...streams].filter((s) => s.uid === u.id).length >= 4) return send(res, 429, { error: "too_many_streams" }, origin);
    res.writeHead(200, { ...corsHeaders(origin), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 4000\n\n");
    const since = Number(url.searchParams.get("since") || 0);
    const s = { res, uid: u.id };
    streams.add(s);
    res.write(`event: hello\ndata: ${JSON.stringify({ rev: S.rev, online: onlineCount(), user: pubUser(u) })}\n\n`);
    if (since && since < S.rev) {
      for (const m of S.msgs.filter((x) => x.rev > since).slice(-200)) res.write(`event: msg\ndata: ${JSON.stringify(pubMsg(m))}\n\n`);
    }
    presence();
    req.on("close", () => { streams.delete(s); presence(); });
    return;
  }

  const u = authUser(req, url);
  if (!u) return send(res, 401, { error: "auth", message: "Please join the community first." }, origin);
  u.lastSeen = now();

  if (method === "GET" && p === "/community/me") {
    return send(res, 200, { ok: true, user: pubUser(u), mutedUntil: u.mutedUntil || 0, rev: S.rev, risk: RISK_LINE, reactions: REACTIONS, online: onlineCount() }, origin);
  }

  if (method === "GET" && p === "/community/channels") {
    const read = {};
    for (const part of String(url.searchParams.get("read") || "").split(",")) { const [k, v] = part.split(":"); if (CH.has(k)) read[k] = Number(v) || 0; }
    return send(res, 200, { ok: true, channels: channelsView(read), rev: S.rev, risk: RISK_LINE, online: onlineCount() }, origin);
  }

  if (method === "GET" && p === "/community/messages") {
    const ch = url.searchParams.get("ch");
    if (!CH.has(ch)) return send(res, 400, { error: "bad_channel" }, origin);
    const before = Number(url.searchParams.get("before") || 0);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 60)));
    let list = S.msgs.filter((m) => m.ch === ch && (!before || m.id < before));
    list = list.slice(-limit);
    return send(res, 200, { ok: true, messages: list.map(pubMsg), rev: S.rev, more: S.msgs.some((m) => m.ch === ch && list[0] && m.id < list[0].id) }, origin);
  }

  if (method === "GET" && p === "/community/updates") {
    const since = Number(url.searchParams.get("since") || 0);
    const list = S.msgs.filter((m) => m.rev > since).slice(-200);
    return send(res, 200, { ok: true, messages: list.map(pubMsg), rev: S.rev, online: onlineCount() }, origin);
  }

  if (method !== "POST") return send(res, 404, { error: "not_found" }, origin);
  if (!allow("w:" + ip, 240, 60000)) return send(res, 429, { error: "rate_limit", message: "Slow down a little." }, origin);
  let b; try { b = await readBody(req, 700000); } catch { return send(res, 400, { error: "bad_json" }, origin); }

  if (p === "/community/admin") {
    if (!allow("admin:" + ip, 8, 3600000)) return send(res, 429, { error: "rate_limit", message: "Too many admin attempts. Try again later." }, origin);
    if (!process.env.COMMUNITY_ADMIN_CODE) return send(res, 503, { error: "admin_not_configured" }, origin);
    if (!adminCodeOk(b.code)) return send(res, 403, { error: "bad_code", message: "That admin code is not right." }, origin);
    u.role = "admin"; put("user", u.id, u);
    return send(res, 200, { ok: true, user: pubUser(u) }, origin);
  }

  if (p === "/community/me") {
    const n = checkName(b.name);
    if (!n.ok) return send(res, 400, { error: "bad_name", message: n.message }, origin);
    if (n.reserved && !isAdmin(u)) return send(res, 400, { error: "reserved_name", message: "That name is reserved for the team." }, origin);
    if ([...S.users.values()].some((x) => x.id !== u.id && x.name.toLowerCase() === n.name.toLowerCase())) return send(res, 409, { error: "name_taken", message: "That name is already used." }, origin);
    u.name = n.name; put("user", u.id, u);
    return send(res, 200, { ok: true, user: pubUser(u) }, origin);
  }

  if (p === "/community/messages") {
    const ch = String(b.ch || "");
    const c = CH.get(ch);
    if (!c) return send(res, 400, { error: "bad_channel" }, origin);
    if (c.adminOnly && !isAdmin(u)) return send(res, 403, { error: "admin_only", message: "Only Michael and the team post here." }, origin);
    if (!isAdmin(u) && (u.mutedUntil || 0) > now()) return send(res, 403, { error: "muted", message: "You are muted for now. Please review the community rules.", until: u.mutedUntil }, origin);
    if (!isAdmin(u)) {
      if (!allow("gap:" + u.id, 1, 1500)) return send(res, 429, { error: "rate_limit", message: "Slow down a little." }, origin);
      if (!allow("min:" + u.id, 8, 60000)) return send(res, 429, { error: "rate_limit", message: "You are sending too fast. Wait a minute." }, origin);
    }
    const chk = checkText(b.text, { admin: isAdmin(u) });
    let img = null;
    if (b.image) {
      const mm = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image));
      if (!mm || mm[2].length > 620000) return send(res, 400, { error: "bad_image", message: "Photo must be a JPEG, PNG or WebP under 450 KB." }, origin);
      if (!isAdmin(u) && !allow("img:" + u.id, 3, 10 * 60000)) return send(res, 429, { error: "rate_limit", message: "Only 3 photos per 10 minutes." }, origin);
      img = { mime: mm[1], b64: mm[2], w: Math.min(4000, Number(b.imageW) || 0), h: Math.min(4000, Number(b.imageH) || 0) };
    }
    if (!chk.ok) {
      if (!isAdmin(u)) {
        u.strikes = (u.strikes || []).filter((t) => now() - t < 15 * 60000).concat([now()]);
        if (["link", "income_claim", "broker_promo", "contact_spam"].includes(chk.reason) && u.strikes.length >= 3) { u.mutedUntil = now() + 30 * 60000; u.strikes = []; }
        put("user", u.id, u);
      }
      return send(res, 422, { error: "blocked", reason: chk.reason, message: chk.message, mutedUntil: u.mutedUntil || 0 }, origin);
    }
    if (!chk.text && !img) return send(res, 400, { error: "empty" }, origin);
    if (!isAdmin(u) && chk.text) {
      const dupe = S.msgs.slice(-200).some((m) => m.uid === u.id && m.text === chk.text && now() - m.at < 120000);
      if (dupe) return send(res, 429, { error: "duplicate", message: "You already sent that." }, origin);
    }
    const replyTo = Number(b.replyTo || 0);
    const m = { id: ++S.seq, ch, uid: u.id, text: chk.text, at: now(), replyTo: replyTo && S.byId.has(replyTo) ? replyTo : 0, reactions: {}, pinned: false, deleted: false, flag: chk.flag || null, img: null };
    if (img) { const iid = crypto.randomBytes(12).toString("hex"); await putImg(iid, img.mime, img.b64); m.img = iid; m.imgW = img.w; m.imgH = img.h; }
    S.msgs.push(m); S.byId.set(m.id, m);
    const inCh = S.msgs.filter((x) => x.ch === ch);
    if (inCh.length > MEM_PER_CH) { const old = inCh[0]; S.byId.delete(old.id); S.msgs = S.msgs.filter((x) => x !== old); }
    if (m.flag) {
      const r = { id: "m" + m.id, msgId: m.id, ch, auto: true, reasons: ["trade_call"], by: [], at: now(), open: true };
      S.reports.set(r.id, r); put("report", r.id, r);
    }
    bump(m);
    let push = null;
    if (ch === "announcements" || (ch === "signals" && b.push === true)) push = await pushAnnouncement(m).catch((e) => ({ error: String(e && e.message || e).slice(0, 80) }));
    return send(res, 200, { ok: true, message: pubMsg(m), push }, origin);
  }

  const id = Number(b.id || 0);
  const m = S.byId.get(id);

  if (p === "/community/react") {
    if (!m || m.deleted || m.hidden) return send(res, 404, { error: "not_found" }, origin);
    if (!REACTIONS.includes(b.emoji)) return send(res, 400, { error: "bad_emoji" }, origin);
    if (!allow("react:" + u.id, 40, 60000)) return send(res, 429, { error: "rate_limit" }, origin);
    const arr = m.reactions[b.emoji] || [];
    m.reactions[b.emoji] = arr.includes(u.id) ? arr.filter((x) => x !== u.id) : arr.concat([u.id]);
    if (!m.reactions[b.emoji].length) delete m.reactions[b.emoji];
    bump(m);
    return send(res, 200, { ok: true, message: pubMsg(m) }, origin);
  }

  if (p === "/community/delete") {
    if (!m) return send(res, 404, { error: "not_found" }, origin);
    if (m.uid !== u.id && !isAdmin(u)) return send(res, 403, { error: "forbidden" }, origin);
    m.deleted = true; m.text = ""; m.reactions = {}; m.pinned = false;
    const im = m.img; m.img = null; await dropImg(im);
    for (const r of S.reports.values()) if (r.msgId === m.id && r.open) { r.open = false; r.resolved = "deleted"; put("report", r.id, r); }
    bump(m);
    return send(res, 200, { ok: true }, origin);
  }

  if (p === "/community/report") {
    if (!m || m.deleted) return send(res, 404, { error: "not_found" }, origin);
    if (!allow("report:" + u.id, 10, 3600000)) return send(res, 429, { error: "rate_limit" }, origin);
    const rid = "m" + m.id;
    const r = S.reports.get(rid) || { id: rid, msgId: m.id, ch: m.ch, auto: false, reasons: [], by: [], at: now(), open: true };
    if (!r.by.includes(u.id)) { r.by.push(u.id); r.reasons.push(String(b.reason || "other").slice(0, 40)); }
    r.open = true; S.reports.set(rid, r); put("report", rid, r);
    const owner = S.users.get(m.uid);
    if (r.by.length >= 3 && !isAdmin(owner) && !m.hidden) { m.hidden = true; bump(m); }
    return send(res, 200, { ok: true, message: "Thanks. Michael's team will review it." }, origin);
  }

  /* ---- admin ---- */
  if (!isAdmin(u)) return send(res, 403, { error: "admin_only" }, origin);

  if (p === "/community/pin") {
    if (!m || m.deleted) return send(res, 404, { error: "not_found" }, origin);
    m.pinned = b.pinned === undefined ? !m.pinned : !!b.pinned;
    bump(m);
    return send(res, 200, { ok: true, message: pubMsg(m) }, origin);
  }
  if (p === "/community/mute") {
    const target = S.users.get(String(b.uid || "")) || (m ? S.users.get(m.uid) : null);
    if (!target || isAdmin(target)) return send(res, 400, { error: "bad_user" }, origin);
    const mins = Math.max(0, Math.min(60 * 24 * 365, Number(b.minutes || 0)));
    target.mutedUntil = mins ? now() + mins * 60000 : 0; put("user", target.id, target);
    return send(res, 200, { ok: true, user: pubUser(target), mutedUntil: target.mutedUntil }, origin);
  }
  if (p === "/community/admin/reports") {
    const list = [...S.reports.values()].filter((r) => r.open).sort((a, c) => c.at - a.at).slice(0, 100)
      .map((r) => { const mm = S.byId.get(r.msgId); return { id: r.id, auto: r.auto, reasons: r.reasons, count: r.by.length, at: r.at, message: mm ? { ...pubMsg(mm), text: mm.text } : null }; });
    return send(res, 200, { ok: true, reports: list }, origin);
  }
  if (p === "/community/admin/resolve") {
    const r = S.reports.get(String(b.reportId || ""));
    if (!r) return send(res, 404, { error: "not_found" }, origin);
    r.open = false; r.resolved = b.action === "delete" ? "deleted" : "dismissed"; put("report", r.id, r);
    const mm = S.byId.get(r.msgId);
    if (mm) {
      if (b.action === "delete") { mm.deleted = true; mm.text = ""; mm.reactions = {}; const im = mm.img; mm.img = null; await dropImg(im); bump(mm); }
      else if (mm.hidden || mm.flag) { mm.hidden = false; if (b.clearFlag) mm.flag = null; bump(mm); }
    }
    return send(res, 200, { ok: true }, origin);
  }
  return send(res, 404, { error: "not_found" }, origin);
}

/* Push subscription for Announcements (separate from /subscribe so the main push store is untouched). */
async function pushRoute(req, res, url, origin) {
  const u = authUser(req, url);
  if (!u) return send(res, 401, { error: "auth" }, origin);
  let b; try { b = await readBody(req, 20000); } catch { return send(res, 400, { error: "bad_json" }, origin); }
  const sub = b.subscription || {};
  if (!(typeof sub.endpoint === "string" && sub.endpoint.startsWith("https://") && sub.keys && sub.keys.p256dh && sub.keys.auth)) return send(res, 400, { error: "bad_subscription" }, origin);
  const id = sha(sub.endpoint).slice(0, 32);
  if (b.on === false) { S.subs.delete(id); del("sub", id); return send(res, 200, { ok: true, on: false }, origin); }
  const chans = ["announcements"].concat(b.signals ? ["signals"] : []);
  const rec = { id, uid: u.id, endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, chans, at: now() };
  S.subs.set(id, rec); put("sub", id, rec);
  return send(res, 200, { ok: true, on: true, chans }, origin);
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v);
    return res.end();
  }
  await ready;
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "POST" && /^\/(api\/)?community\/push\/?$/.test(url.pathname)) return await pushRoute(req, res, url, origin);
    return await route(req, res, url, origin);
  } catch (e) {
    console.error("uu-community error", (e && e.message || "").slice(0, 160));
    if (!res.headersSent) send(res, 500, { error: "server" }, origin);
  }
}
