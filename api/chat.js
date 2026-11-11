/**
 * Universe Unlimited — UU Gold Mastery Mentor proxy (Vercel Function).
 * The Gemini key lives only in the host's encrypted env (GEMINI_API_KEY). Never ship it in the PWA.
 */
const ALLOWED = new Set([
  "https://universe-unlimited-app.surge.sh",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
  "http://127.0.0.1:8765/",
]);

const MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
];

const PRICE_SRC = "https://api.gold-api.com/price/XAU";
const FF_SRC = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const NEWS_FEEDS = [
  "https://news.google.com/rss/search?q=gold+OR+XAUUSD+OR+%22Federal+Reserve%22+OR+%22US+dollar%22+when:2d&hl=en-US&gl=US&ceid=US:en",
  "https://www.fxstreet.com/rss/news",
];

const ACCM_URL = "https://accm.global/account/register?shareUserSetId=a5d4a2206f644ad3b";
const ACCM_CODE = "z6hgt5";

const GUIDES = `
MICHAEL'S LESSONS (primary grounding — Universe Unlimited / PDE Gold Academy):
- This app is a free gold (XAUUSD) journal and education PWA. Founder: Michael M. Dankin, ACCM IB (may receive a commission if the student registers with code ${ACCM_CODE}).
- Manual trading only. No copy trading. Education and journaling — not a signal service.
- Gold math used in this app: 1 standard lot = 100 oz. 1 pip = a $0.10 move in price. 1 point = $0.01. So a $1.00 move = 10 pips = 100 points.
- Pip value at 1.00 lot = 100 oz × $0.10 = $10 per pip. At 0.01 lot = $0.10 per pip. At 0.10 lot = $1.00 per pip.
- Lot size from risk (USD account): lot = (balance × risk%) / (SL_pips × $10). Work this out step by step. If the size is below 0.01, tell the student to lower risk, widen the planned stop, or use a smaller plan — do not invent a broker-specific micro lot unless they say their platform allows it.
- Cent accounts: the balance is in cents (100 cents = $1). Convert carefully and label units. Example: 100,000 cents at 1% risk and 50 pips is the same 0.02 lot as $1,000 USD at 1% and 50 pips.
- Trailing-stop calculator in the app shows the result IF the new stop is hit — illustration only, not a guarantee. Fees and spread still apply.
- Sessions in Asia/Manila (UTC+8): Asia 08:00–17:00, London 15:00–00:00, New York 20:00–05:00. London–NY overlap can be more active; activity is not the same as easy profit.
- Journal both wins and losses honestly (entry, SL, TP, trailing, exit, emotion). XP and streaks reward the habit of logging and studying — not profits.
- Danger Zone on Home is a caution when a high-impact USD event is due within 15 minutes — not a signal to enter or exit.
- Guides live in the Learn tab and at https://pde-gold-academy.surge.sh (TP/trailing, scalping, IB registration video, chart setup). Suggest the next lesson when useful.
- App onboarding: Home is the daily desk (pulse, brief, danger zone). Markets has the live chart, calendar, and news. Journal is for trades, stats, XP, and win cards. Learn has this mentor, calculators, and guides. Access has ACCM register, install, backup, and experience toggles.
- ACCM onboarding (only broker to mention): open the Access tab → copy code ${ACCM_CODE} → Register with ACCM at ${ACCM_URL} → complete ACCM's own KYC/account steps on their site → then use Guide 1 (IB link) and the other academy setup guides for MT5, deposit/demo, and chart setup. Installing the PWA (Access → Install, or the header Install button) keeps the journal on-device. "Request Access" in this app means using the Access tab funnel (register + install + backup). Never promise that registering makes anyone profitable.
`.trim();

const SYSTEM = `
You are the UU Gold Mastery Mentor for Universe Unlimited — a "Financial Market Einstein" with a Gold Mastery focus, teaching in the voice of a calm, precise senior mentor. Founder: Michael M. Dankin.

MISSION: Answer ANY serious question the student asks: gold/XAUUSD, other forex, macro, psychology, journaling, risk, ACCM account setup, and how to use this app. Actively ADVISE and GUIDE. Do not be a passive FAQ bot. Build personalized study/trading-process plans, coach risk and lot size, review a described setup or journal and give feedback, suggest the next lesson, and walk people step by step through ACCM registration (code ${ACCM_CODE}) and the app's Access tab / Request Access funnel. Ask clarifying questions (account size and type — USD or cent, experience, which session they can actually sit, typical stop size) so guidance is tailored.

PERSONA DEPTH (teach, don't lecture into a trade):
- XAUUSD session behavior (Asia / London / New York and overlaps, in Manila time).
- Market structure (BOS, CHoCH), liquidity sweeps, supply and demand.
- ATR- and structure-based stop placement (explain the process; never place a live trade).
- Position-sizing math, R:R, psychology, and honest journaling.

RISK MANAGEMENT IS CORE — teach this proactively, especially when planning or reviewing:
1) The 1% risk rule (and when a beginner should use even less).
2) Lot-size calculation for XAUUSD on both USD and cent accounts, with every step shown and units labeled.
3) SL placement using structure and/or ATR — principles, not a tick-by-tick call.
4) Reward-to-risk (R:R) and why poor R:R wrecks a good win rate.
5) Daily and weekly loss limits (for example, stopping after 1–2% on the day or a set weekly cap — treat examples as study frameworks, not laws).
6) A sensible cap on open trades (often one well-planned gold idea is enough for a new journaler).
7) When to stop trading: hit the loss limit, after a revenge urge, around high-impact news if they are not prepared, when they cannot explain the invalidation.
8) Drawdown recovery math (e.g. a 20% drawdown needs a 25% gain to get back — protect the account).

MACRO: DXY, real yields, Fed/FOMC, CPI/NFP, geopolitics, official-sector gold buying, and typical correlations. Explain transmission (for example CPI → inflation expectations → real yields / policy path → USD → gold often inverse to the dollar and real yields). Never invent a print, a yield, or a price.

LIVE DATA RULES:
- A LIVE CONTEXT block may be attached with a timestamped XAUUSD spot, calendar events, and headlines. If it is present, use those figures and state the price and Manila time you used. Cite sources (gold-api.com, Forex Factory calendar, news links, or Google Search grounding).
- NEVER invent numbers. If live price, calendar, or headlines failed, say so clearly and teach with process instead of fake figures.
- For current gold/news/macro questions, prefer grounded live context and search citations over memory.

BOUNDARIES (hard):
- Education and coaching of the DECISION PROCESS only. No personal "buy now" / "sell now" / "enter at this price" calls, no copy-trading instructions, and no income, salary, or "you will be profitable" claims. Trading can lose money. Past results do not promise future results.
- If asked for a call, refuse the call, then teach how to plan risk, invalidation, and journal the idea themselves.
- If asked for a broker, mention only ACCM (link and code above). Do not recommend other brokers.
- Match the student's language (English or Taglish). Be clear, step-by-step, and practical. Use short worked calculations. Close with a useful next step or a clarifying question when it helps.
`.trim();

const cache = { cal: null, calAt: 0, news: null, newsAt: 0 };
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 20;
const CAL_TTL = 5 * 60 * 1000;
const NEWS_TTL = 5 * 60 * 1000;

function cors(origin) {
  const allow = origin && ([...ALLOWED].some((o) => origin === o || origin === o.replace(/\/$/, "")));
  return {
    "Access-Control-Allow-Origin": allow ? origin : "https://universe-unlimited-app.surge.sh",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

function json(res, status, obj, origin) {
  const headers = cors(origin);
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function manilaNow(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return fmt.format(d) + " Asia/Manila (UTC+8)";
}

function rateLimit(ip) {
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

async function fetchJson(url, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ac.signal, headers: { "User-Agent": "UU-Gold-Mentor/1.0" } });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function livePrice() {
  const j = await fetchJson(PRICE_SRC, 4000);
  const price = Number(j && (j.price ?? j.Price ?? j.bid));
  if (!Number.isFinite(price)) throw new Error("no price");
  const updated = j.updatedAt || j.updated || j.timestamp || null;
  return { price, raw: j, updated, source: "https://api.gold-api.com/price/XAU", at: manilaNow() };
}

function impactOf(ev) {
  const raw = String(ev.impact || ev.Impact || ev.volatility || ev.title || "").toLowerCase();
  if (/high|red|3/.test(raw) && !/holiday/.test(raw)) return "high";
  if (/medium|orange|2/.test(raw)) return "medium";
  const n = Number(ev.impact);
  if (n >= 3) return "high";
  if (n === 2) return "medium";
  return "other";
}

function isUsd(ev) {
  const c = String(ev.country || ev.Country || ev.currency || ev.Currency || ev.zone || "").toUpperCase();
  return c === "USD" || c === "US" || c === "UNITED STATES";
}

async function liveCalendar() {
  const now = Date.now();
  if (cache.cal && now - cache.calAt < CAL_TTL) return cache.cal;
  const rows = await fetchJson(FF_SRC, 5000);
  const list = Array.isArray(rows) ? rows : [];
  const items = list
    .filter((ev) => isUsd(ev) && (impactOf(ev) === "high" || impactOf(ev) === "medium"))
    .slice(0, 16)
    .map((ev) => {
      const title = ev.title || ev.Title || ev.event || "Event";
      const when = ev.date || ev.Date || ev.datetime || ev.time || "";
      let manila = String(when);
      try {
        const d = new Date(when);
        if (!Number.isNaN(d.getTime())) manila = manilaNow(d);
      } catch (_) {}
      return {
        title,
        impact: impactOf(ev),
        when: manila,
        forecast: ev.forecast || ev.Forecast || ev.fforecast || "",
        previous: ev.previous || ev.Previous || ev.prev || "",
        actual: ev.actual || ev.Actual || "",
      };
    });
  const out = { items, source: FF_SRC, at: manilaNow(), ok: true };
  cache.cal = out;
  cache.calAt = now;
  return out;
}

async function liveNews() {
  const now = Date.now();
  if (cache.news && now - cache.newsAt < NEWS_TTL) return cache.news;
  const items = [];
  for (const feed of NEWS_FEEDS) {
    if (items.length >= 6) break;
    try {
      const j = await fetchJson("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(feed), 4500);
      const arr = (j && j.items) || [];
      for (const it of arr) {
        if (items.length >= 6) break;
        const title = (it.title || "").trim();
        if (!title) continue;
        items.push({
          title,
          source: (it.author || it.source || (j.feed && j.feed.title) || "News").toString().slice(0, 80),
          url: it.link || it.url || "",
          when: it.pubDate || it.pubdate || "",
        });
      }
    } catch (_) {}
  }
  const out = { items, source: "Google News / FXStreet via api.rss2json.com", at: manilaNow(), ok: items.length > 0 };
  cache.news = out;
  cache.newsAt = now;
  return out;
}

async function gatherLive() {
  const result = { ok: true, price: null, calendar: null, news: null, failures: [], builtAt: manilaNow() };
  const tasks = [
    livePrice().then((p) => { result.price = p; }).catch((e) => { result.failures.push("XAUUSD spot (gold-api.com) unavailable: " + (e.message || e)); }),
    liveCalendar().then((c) => { result.calendar = c; }).catch((e) => { result.failures.push("Economic calendar (Forex Factory JSON) unavailable: " + (e.message || e)); }),
    liveNews().then((n) => { result.news = n; }).catch((e) => { result.failures.push("Headlines unavailable: " + (e.message || e)); }),
  ];
  await Promise.all(tasks);
  return result;
}

function formatLive(live) {
  const lines = [`LIVE CONTEXT — fetched ${live.builtAt}. Use these figures. Do not invent replacements.`];
  if (live.price) {
    lines.push(`XAUUSD spot: $${live.price.price.toFixed(2)} (source: ${live.price.source}, as of ${live.price.at}${live.price.updated ? "; provider stamp " + live.price.updated : ""}).`);
  } else {
    lines.push("XAUUSD spot: UNAVAILABLE. Say you do not have a live print and do not invent a price.");
  }
  if (live.calendar && live.calendar.items && live.calendar.items.length) {
    lines.push("This week's high/medium-impact USD events (Forex Factory calendar, " + live.calendar.source + "):");
    for (const ev of live.calendar.items) {
      lines.push(`- [${ev.impact}] ${ev.title} — ${ev.when}` +
        (ev.forecast ? `; forecast ${ev.forecast}` : "") +
        (ev.previous ? `; previous ${ev.previous}` : "") +
        (ev.actual ? `; actual ${ev.actual}` : ""));
    }
  } else {
    lines.push("USD economic calendar: UNAVAILABLE. Say so if asked about this week's events; do not invent prints.");
  }
  if (live.news && live.news.items && live.news.items.length) {
    lines.push("Latest gold/USD headlines (" + live.news.source + "):");
    for (const n of live.news.items) {
      lines.push(`- ${n.title}${n.source ? " (" + n.source + ")" : ""}${n.url ? " — " + n.url : ""}`);
    }
  } else {
    lines.push("Headlines: UNAVAILABLE. Say so if asked for current news; do not invent headlines.");
  }
  if (live.failures.length) lines.push("Fetch notes: " + live.failures.join(" | "));
  return lines.join("\n");
}

function wantsSearch(q) {
  return /news|price|now|today|tonight|this week|cpi|nfp|fomc|fed|dxy|yield|headline|calendar|geopolit|war|rate cut|rate hike|xau|gold|market|dollar/i.test(q || "");
}

function extractText(j) {
  const cands = (j && j.candidates) || [];
  if (!cands.length) return "";
  const parts = (((cands[0] || {}).content) || {}).parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}

function extractGrounding(j) {
  const g = (((j && j.candidates) || [])[0] || {}).groundingMetadata;
  if (!g) return [];
  const chunks = g.groundingChunks || [];
  const out = [];
  for (const ch of chunks) {
    const w = ch.web || {};
    if (w.uri || w.title) out.push({ title: w.title || "", url: w.uri || "" });
  }
  return out.slice(0, 8);
}

async function callGemini(model, system, contents, useSearch, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error("GEMINI_API_KEY is not set");
    err.status = 500;
    throw err;
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
  };
  if (model.includes("2.5-pro") || model.includes("3-flash-preview") || model.includes("3.5") || model.includes("3-")) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 1024 };
  }
  if (useSearch) body.tools = [{ google_search: {} }];
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = String((j && j.error && (j.error.message || j.error.status)) || r.status);
      const safe = msg.replace(/key[=:]\s*\S+/ig, "key=[redacted]").slice(0, 220);
      console.error("mentor gemini", model, "status", r.status, safe);
      const err = new Error("upstream " + r.status);
      err.status = r.status;
      err.body = j;
      throw err;
    }
    const reply = extractText(j);
    if (!reply) {
      const err = new Error("empty reply");
      err.status = 502;
      throw err;
    }
    return { reply, model, citations: extractGrounding(j) };
  } finally {
    clearTimeout(t);
  }
}

async function generate(system, contents, useSearch) {
  let last = null;
  for (const model of MODELS) {
    const timeoutMs = model.includes("pro") ? 28000 : 18000;
    try {
      return await callGemini(model, system, contents, useSearch, timeoutMs);
    } catch (e) {
      last = e;
      const st = e.status || 0;
      const aborted = e.name === "AbortError" || /aborted/i.test(String(e.message || ""));
      console.error("mentor model fail", model, aborted ? "timeout" : ("status " + st));
      if (aborted || st === 404 || st === 429 || st === 503 || st === 400) continue;
      if (st >= 500) continue;
    }
  }
  const err = last || new Error("all models failed");
  throw err;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    if (typeof req.body === "string") {
      try { return resolve(JSON.parse(req.body || "{}")); } catch (e) { return reject(e); }
    }
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 200000) req.destroy(); });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    const headers = cors(origin);
    res.statusCode = 204;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return res.end();
  }
  if (req.method !== "POST") return json(res, 404, { error: "POST /chat only" }, origin);

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!rateLimit(ip)) return json(res, 429, { error: "rate_limit", reply: "Please wait a few minutes and try again. The mentor is rate-limited so we can stay on the free tier." }, origin);

  let body;
  try { body = await readBody(req); }
  catch { return json(res, 400, { error: "invalid json" }, origin); }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = String((lastUser && lastUser.content) || body.message || "").slice(0, 4000);
  if (!question.trim()) return json(res, 400, { error: "empty" }, origin);

  const live = await gatherLive();
  const liveBlock = formatLive(live);
  const system = SYSTEM + "\n\n" + GUIDES + "\n\n" + liveBlock;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" || m.role === "model" ? "model" : "user",
    parts: [{ text: String(m.content || "").slice(0, 4000) }],
  }));
  if (!contents.length) contents.push({ role: "user", parts: [{ text: question }] });

  let useSearch = wantsSearch(question);
  try {
    let out;
    try {
      out = await generate(system, contents, useSearch);
    } catch (e) {
      if (useSearch) {
        console.error("mentor retry without search", e.status || e.message);
        out = await generate(system, contents, false);
      } else {
        throw e;
      }
    }
    const liveMeta = {
      price: live.price ? live.price.price : null,
      priceTime: live.price ? live.price.at : null,
      priceSource: live.price ? live.price.source : null,
      builtAt: live.builtAt,
      failures: live.failures,
    };
    return json(res, 200, { reply: out.reply, model: out.model, citations: out.citations, live: liveMeta }, origin);
  } catch (e) {
    const status = e.status === 429 ? 429 : 502;
    return json(res, status, { error: "upstream", reply: "" }, origin);
  }
}

export { gatherLive, formatLive };
