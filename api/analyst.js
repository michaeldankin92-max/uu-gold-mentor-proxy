/**
 * Universe Unlimited — UU AI Market Analyst.
 * Builds education-only session-open study posts from real OHLC + calendar.
 * Not a signal service. Profits are not guaranteed. Losses are graded in public.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors, json, rateLimit, readBody } from "./http.js";
import { notifyAll } from "./push.js";
import { getCalendar, getDxy, getCotGold } from "./calendar.js";

const FF_SRC = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const BYBIT = "https://api.bybit.com/v5/market/kline";
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F";
const BIN = 0.5;
const VA_PCT = 0.7;
const MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
];

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = process.env.ANALYST_STORE_PATH || path.join(ROOT, "..", "data", "analyst-store.json");

const SESSIONS = [
  { id: "asia", label: "Asia", openH: 8, closeH: 17 },
  { id: "london", label: "London", openH: 15, closeH: 24 },
  { id: "ny", label: "New York", openH: 20, closeH: 29 }, // 29 = 05:00 next day
];

function emptyStore() {
  return { posts: [], grades: [] };
}

function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      posts: Array.isArray(j.posts) ? j.posts.slice(-60) : [],
      grades: Array.isArray(j.grades) ? j.grades.slice(-90) : [],
    };
  } catch {
    return emptyStore();
  }
}

function saveStore(store) {
  try {
    const dir = path.dirname(STORE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = STORE_PATH + ".tmp";
    const slim = { posts: (store.posts || []).slice(-60), grades: (store.grades || []).slice(-90) };
    fs.writeFileSync(tmp, JSON.stringify(slim), { mode: 0o600 });
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("analyst store write failed", e && e.message);
  }
}

function manilaParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: p.weekday,
    label: `${p.weekday}, ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} Asia/Manila (UTC+8)`,
  };
}

function manilaStamp(d = new Date()) {
  return manilaParts(d).label;
}

function sessionKey(date, id) {
  return date + ":" + id;
}

function currentSession(d = new Date()) {
  const p = manilaParts(d);
  const h = p.hour + p.minute / 60;
  // NY wraps past midnight (20:00 → 05:00 next day)
  if (h < 5) return { ...SESSIONS[2], date: prevDate(p.date), open: true, hour: p.hour };
  const open = [...SESSIONS].reverse().find((s) => h >= s.openH && h < s.closeH);
  if (open) return { ...open, date: p.date, open: true, hour: p.hour };
  // before Asia open
  return { ...SESSIONS[0], date: p.date, open: false, hour: p.hour, nextOpen: "08:00" };
}

function prevDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function sessionWindowUnix(date, sess) {
  // Manila date + openH → UTC unix seconds
  const [y, m, d] = date.split("-").map(Number);
  const open = Date.UTC(y, m - 1, d, sess.openH - 8, 0, 0) / 1000;
  let closeH = sess.closeH;
  let addDays = 0;
  if (closeH >= 24) {
    addDays = Math.floor(closeH / 24);
    closeH = closeH % 24;
  }
  const close = Date.UTC(y, m - 1, d + addDays, closeH - 8, 0, 0) / 1000;
  return { open, close };
}

async function fetchJson(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ac.signal, headers: { "User-Agent": "UU-Gold-Analyst/1.0" } });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function toBars(rows) {
  return rows
    .filter((b) => Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close) && b.high >= b.low)
    .sort((a, b) => a.time - b.time);
}

async function fetchBybit(interval, limit) {
  const j = await fetchJson(`${BYBIT}?category=linear&symbol=XAUUSDT&interval=${interval}&limit=${limit}`, 8000);
  if (j.retCode !== 0) throw new Error("bybit " + (j.retMsg || "error"));
  const list = (j.result && j.result.list) || [];
  return toBars(list.map((row) => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: +row[1],
    high: +row[2],
    low: +row[3],
    close: +row[4],
    volume: +row[5] || 0,
  })));
}

async function fetchYahoo(interval, range) {
  const j = await fetchJson(`${YAHOO}?interval=${interval}&range=${range}`, 8000);
  const res = ((j.chart && j.chart.result) || [])[0];
  if (!res) throw new Error("yahoo empty");
  const ts = res.timestamp || [];
  const q = ((res.indicators && res.indicators.quote) || [])[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = +q.open?.[i], h = +q.high?.[i], l = +q.low?.[i], c = +q.close?.[i], v = +q.volume?.[i];
    if (![o, h, l, c].every(Number.isFinite)) continue;
    bars.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
  }
  return toBars(bars);
}

function aggregate(bars, sec) {
  const out = [];
  for (const b of bars) {
    const bucket = Math.floor(b.time / sec) * sec;
    const last = out[out.length - 1];
    if (!last || last.time !== bucket) {
      out.push({ time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
    } else {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume || 0;
    }
  }
  return out;
}

async function loadOhlc() {
  const failures = [];
  try {
    const [m15, h1, h4] = await Promise.all([
      fetchBybit("15", 500),
      fetchBybit("60", 400),
      fetchBybit("240", 300),
    ]);
    if (m15.length < 40) throw new Error("bybit short");
    return {
      m15, h1, h4,
      source: "Bybit linear XAUUSDT (USD gold perpetual). Study feed only — not the ACCM MT5 quote.",
      sourceUrl: "https://api.bybit.com/v5/market/kline",
      symbol: "XAUUSDT",
      volumeKind: "exchange_volume",
      failures,
    };
  } catch (e) {
    failures.push("Bybit XAUUSDT unavailable: " + (e.message || e));
  }
  try {
    const m15 = await fetchYahoo("15m", "7d");
    let h1 = [];
    try { h1 = await fetchYahoo("60m", "30d"); } catch (_) { h1 = aggregate(m15, 3600); }
    const h4 = aggregate(h1.length ? h1 : m15, 14400);
    if (m15.length < 40) throw new Error("yahoo short");
    const hasVol = m15.some((b) => b.volume > 0);
    return {
      m15, h1: h1.length ? h1 : aggregate(m15, 3600), h4,
      source: "Yahoo Finance COMEX Gold futures (GC=F). Study feed only — not the ACCM MT5 quote.",
      sourceUrl: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F",
      symbol: "GC=F",
      volumeKind: hasVol ? "futures_volume" : "range_proxy",
      failures,
    };
  } catch (e) {
    failures.push("Yahoo GC=F unavailable: " + (e.message || e));
    const err = new Error("ohlc");
    err.failures = failures;
    throw err;
  }
}

function lastCompletedNyDay(now = new Date()) {
  // Last closed CME-style day: 17:00 NY → 17:00 NY
  const nyFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(nyFmt.formatToParts(now).map((x) => [x.type, x.value]));
  let y = Number(p.year), m = Number(p.month), d = Number(p.day), h = Number(p.hour);
  // If before 17:00 NY, last close was yesterday 17:00; window is day-before 17:00 → yesterday 17:00
  const close = new Date(now);
  // Compute NY 17:00 as UTC: use offset via a known formatter trick
  // We'll iterate bars by converting each bar time to NY hour.
  return { afterSeventeen: h >= 17, y, m, d, h };
}

function nyParts(unixSec) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(unixSec * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function sessionDateNY(unixSec) {
  // session_date D covers (D-1) 17:00 NY → D 17:00 NY
  const p = nyParts(unixSec);
  if (p.hour >= 17) {
    const [y, m, d] = p.date.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 1));
    return dt.toISOString().slice(0, 10);
  }
  return p.date;
}

function previousDayProfile(m15, volumeKind) {
  if (!m15.length) return null;
  const lastT = m15[m15.length - 1].time;
  const lastSess = sessionDateNY(lastT);
  // last completed session date: if still inside that session, go back one
  const lastHour = nyParts(lastT).hour;
  let target = lastSess;
  // If the current NY session is not yet closed (before 17:00 on session date), previous = prior date
  // session date D closes at D 17:00 NY. If last bar's sessionDate is D and hour < 17, D is still open → previous is D-1? 
  // Actually sessionDate already maps 17:00+ to next date, so if hour < 17, sessionDate is "today" and it's still open.
  if (lastHour < 17) target = prevDate(lastSess);
  else {
    // at or after 17:00, sessionDate is tomorrow's key; the session that just closed is lastSess (already next calendar?).
    // Bar at 17:00 Nov 10 NY has sessionDate Nov 11. So last completed sessionDate is lastSess when hour>=17? 
    // Wait: 16:59 Nov 10 → sessionDate Nov 10, still open until 17:00 Nov 10.
    // 17:00 Nov 10 → sessionDate Nov 11, session Nov 10 just closed.
    // lastSess at 17:00+ is the NEW open session. Previous completed = prevDate(lastSess).
    target = prevDate(lastSess);
  }
  const bars = m15.filter((b) => sessionDateNY(b.time) === target);
  if (bars.length < 8) return null;

  const lo = Math.min(...bars.map((b) => b.low));
  const hi = Math.max(...bars.map((b) => b.high));
  const start = Math.floor(lo / BIN) * BIN;
  const bins = [];
  for (let p = start; p <= hi + 1e-9; p = +(p + BIN).toFixed(4)) {
    bins.push({ low: p, high: +(p + BIN).toFixed(4), vol: 0, mid: +(p + BIN / 2).toFixed(3) });
  }
  if (!bins.length) return null;
  for (const b of bars) {
    const range = Math.max(b.high - b.low, 1e-6);
    const vol = volumeKind === "range_proxy" || !(b.volume > 0) ? range : b.volume;
    for (const bin of bins) {
      const overlap = Math.max(0, Math.min(b.high, bin.high) - Math.max(b.low, bin.low));
      if (overlap > 0) bin.vol += vol * (overlap / range);
    }
  }
  const total = bins.reduce((s, x) => s + x.vol, 0);
  if (!(total > 0)) return null;
  let poc = bins[0];
  for (const bin of bins) if (bin.vol > poc.vol) poc = bin;
  const pocIdx = bins.indexOf(poc);
  let i = pocIdx, j = pocIdx, acc = poc.vol;
  while (acc / total < VA_PCT && (i > 0 || j < bins.length - 1)) {
    const left = i > 0 ? bins[i - 1].vol : -1;
    const right = j < bins.length - 1 ? bins[j + 1].vol : -1;
    if (right >= left) { j += 1; acc += bins[j].vol; }
    else { i -= 1; acc += bins[i].vol; }
  }
  const usedProxy = volumeKind === "range_proxy" || bars.every((b) => !(b.volume > 0));
  return {
    sessionDate: target,
    poc: poc.mid,
    vah: bins[j].high,
    val: bins[i].low,
    bin: BIN,
    valueArea: "70%",
    volumeNote: usedProxy
      ? "Volume is a range proxy (high−low per M15 bar), same idea as the education backtest — not exchange tick volume."
      : "Volume comes from the OHLC source (not ACCM MT5 volume).",
  };
}

function findSwings(bars, n = 2) {
  const sw = [];
  for (let i = n; i < bars.length - n; i++) {
    let isH = true, isL = true;
    for (let k = i - n; k <= i + n; k++) {
      if (k === i) continue;
      if (bars[k].high >= bars[i].high) isH = false;
      if (bars[k].low <= bars[i].low) isL = false;
    }
    if (isH) sw.push({ time: bars[i].time, price: bars[i].high, type: "high", index: i });
    else if (isL) sw.push({ time: bars[i].time, price: bars[i].low, type: "low", index: i });
  }
  return sw;
}

function labelStructure(swings) {
  const labels = [];
  let lastH = null, lastL = null;
  let trend = "neutral";
  const events = [];
  for (const s of swings) {
    if (s.type === "high") {
      let tag = "H";
      if (lastH != null) tag = s.price > lastH.price ? "HH" : "LH";
      labels.push({ ...s, tag });
      if (lastH && trend === "down" && s.price > lastH.price) {
        events.push({ time: s.time, price: s.price, kind: "CHoCH", note: "Change of character against the down move" });
        trend = "up";
      } else if (lastH && trend === "up" && s.price > lastH.price) {
        events.push({ time: s.time, price: s.price, kind: "BOS", note: "Break of structure with the up move" });
      } else if (lastH && trend === "neutral" && s.price > lastH.price) {
        trend = "up";
        events.push({ time: s.time, price: s.price, kind: "BOS", note: "Break of structure" });
      }
      lastH = s;
    } else {
      let tag = "L";
      if (lastL != null) tag = s.price < lastL.price ? "LL" : "HL";
      labels.push({ ...s, tag });
      if (lastL && trend === "up" && s.price < lastL.price) {
        events.push({ time: s.time, price: s.price, kind: "CHoCH", note: "Change of character against the up move" });
        trend = "down";
      } else if (lastL && trend === "down" && s.price < lastL.price) {
        events.push({ time: s.time, price: s.price, kind: "BOS", note: "Break of structure with the down move" });
      } else if (lastL && trend === "neutral" && s.price < lastL.price) {
        trend = "down";
        events.push({ time: s.time, price: s.price, kind: "BOS", note: "Break of structure" });
      }
      lastL = s;
    }
  }
  const highs = labels.filter((x) => x.type === "high");
  const lows = labels.filter((x) => x.type === "low");
  const lastHigh = highs[highs.length - 1] || null;
  const lastLow = lows[lows.length - 1] || null;
  // Protected: last unviolated swing of the current structure
  const close = null;
  return { labels, events, trend, lastHigh, lastLow, protectedHigh: lastHigh, protectedLow: lastLow };
}

function dealingRange(bars, structure) {
  const slice = bars.slice(-48);
  const high = Math.max(...slice.map((b) => b.high));
  const low = Math.min(...slice.map((b) => b.low));
  const eq = +((high + low) / 2).toFixed(2);
  const ph = structure.protectedHigh ? structure.protectedHigh.price : high;
  const pl = structure.protectedLow ? structure.protectedLow.price : low;
  return { high: +high.toFixed(2), low: +low.toFixed(2), eq, protectedHigh: +ph.toFixed(2), protectedLow: +pl.toFixed(2) };
}

function tfBias(bars) {
  const st = labelStructure(findSwings(bars, 2));
  const last = bars[bars.length - 1];
  const slice = bars.slice(-30);
  const high = Math.max(...slice.map((b) => b.high));
  const low = Math.min(...slice.map((b) => b.low));
  const mid = (high + low) / 2;
  let bias = st.trend === "up" ? "bullish" : st.trend === "down" ? "bearish" : "neutral";
  if (bias === "neutral") bias = last.close >= mid ? "bullish" : "bearish";
  return { bias, trend: st.trend, close: last.close };
}

function alignmentMeter(h4, h1, m15) {
  const a = { h4: tfBias(h4), h1: tfBias(h1), m15: tfBias(m15) };
  const dirs = [a.h4.bias, a.h1.bias, a.m15.bias];
  const bulls = dirs.filter((d) => d === "bullish").length;
  const bears = dirs.filter((d) => d === "bearish").length;
  let summary = "Mixed";
  let score = Math.max(bulls, bears);
  if (bulls === 3) summary = "Aligned bullish (H4/H1/M15)";
  else if (bears === 3) summary = "Aligned bearish (H4/H1/M15)";
  else if (bulls === 2) summary = "Two timeframes bullish, one mixed";
  else if (bears === 2) summary = "Two timeframes bearish, one mixed";
  return { h4: a.h4.bias, h1: a.h1.bias, m15: a.m15.bias, score, of: 3, summary };
}

function scenarioPaths(bars, range, bias, inv) {
  const last = bars[bars.length - 1];
  const step = 15 * 60;
  const times = [0, 1, 2, 3, 4, 5, 6].map((i) => last.time + step * (i + 1));
  const px = last.close;
  const up = range.high;
  const down = range.low;
  function path(end, warp) {
    return times.map((t, i) => {
      const k = (i + 1) / times.length;
      const mid = px + (end - px) * k;
      const wiggle = Math.sin(k * Math.PI) * (end - px) * warp;
      return { time: t, value: +(mid + wiggle).toFixed(2) };
    });
  }
  if (bias === "bearish") {
    return {
      a: { label: "Continuation study path (liquidity toward the range low)", points: path(down, 0.12) },
      b: { label: "Alternate study path (toward invalidation / range high)", points: path(Math.max(inv, up), -0.08) },
    };
  }
  if (bias === "bullish") {
    return {
      a: { label: "Continuation study path (liquidity toward the range high)", points: path(up, 0.12) },
      b: { label: "Alternate study path (toward invalidation / range low)", points: path(Math.min(inv, down), -0.08) },
    };
  }
  return {
    a: { label: "Range study path (toward the high)", points: path(up, 0.1) },
    b: { label: "Range study path (toward the low)", points: path(down, 0.1) },
  };
}

function structureBias(align, range, last) {
  if (align.score === 3) return align.h4;
  if (align.score === 2) return align.h4 === align.h1 ? align.h4 : (last.close >= range.eq ? "bullish" : "bearish");
  return "neutral";
}

function invalidation(bias, range) {
  if (bias === "bullish") return range.protectedLow;
  if (bias === "bearish") return range.protectedHigh;
  return range.eq;
}

function confidenceOf(align, news) {
  let c = 45 + align.score * 12;
  if (news === "high") c -= 10;
  if (align.score === 3) c += 8;
  return Math.max(30, Math.min(78, c));
}

async function loadCalendar() {
  try {
    const raw = await fetchJson(FF_SRC, 5000);
    const rows = Array.isArray(raw) ? raw : (raw.events || []);
    return rows.map((e) => ({
      title: e.title || e.event || "",
      country: e.country || e.currency || "",
      impact: String(e.impact || e.volatility || "").toLowerCase(),
      date: e.date || e.datetime || e.time || "",
    })).filter((e) => /usd|united states|united states/i.test(e.country) || /usd/i.test(e.title));
  } catch (e) {
    return { error: "Economic calendar (Forex Factory JSON) unavailable: " + (e.message || e), events: [] };
  }
}

function eventUnix(e) {
  if (Number.isFinite(e.whenMs)) return e.whenMs / 1000;
  const t = Date.parse(e.date || e.whenIso || "");
  return Number.isFinite(t) ? t / 1000 : NaN;
}

function newsBadge(cal, win) {
  const events = Array.isArray(cal) ? cal : (cal.events || []);
  const nearby = [];
  for (const e of events) {
    const sec = eventUnix(e);
    if (!Number.isFinite(sec)) continue;
    if (sec >= win.open - 3600 && sec <= win.close + 3600) nearby.push(e);
  }
  const high = nearby.filter((e) => /high|red|3/.test(String(e.impact || "")));
  const med = nearby.filter((e) => /medium|orange|2/.test(String(e.impact || "")));
  let level = "quiet";
  if (high.length) level = "high";
  else if (med.length) level = "medium";
  return {
    level,
    label: level === "high" ? "High-impact USD news in this session" : level === "medium" ? "Medium-impact USD news in this session" : "No high-impact USD news flagged in this session window",
    events: nearby.slice(0, 8).map((e) => ({
      title: e.title,
      impact: e.impact,
      date: e.whenManila || e.date || e.whenIso || "",
      forecast: e.forecast || null,
      previous: e.previous || null,
      actual: e.actual || null,
      verification: e.verification || "unconfirmed",
    })),
    calendarNote: (cal && !Array.isArray(cal) && (cal.error || cal.warning)) || null,
  };
}

const PILLAR_LESSONS = {
  technical: { title: "Guide 6 (Part 1): Market Profile basics", href: "https://pde-gold-academy.surge.sh/guides/PDE_Guide6_MarketProfile_P1.mp4" },
  fundamental: { title: "Gold risk guide (para sa OFW)", href: "https://pde-gold-academy.surge.sh/gold-risk-guide-para-sa-ofw.pdf" },
  sentiment: { title: "Guide 8 (Part 1): Chart setup", href: "https://pde-gold-academy.surge.sh/guides/PDE_Guide8_ChartSetup_P1.mp4" },
};

function meter(bias, why, lessonKey, extra) {
  const b = bias === "bullish" || bias === "bearish" ? bias : "neutral";
  return { bias: b, why: String(why || "").slice(0, 420), lesson: PILLAR_LESSONS[lessonKey], ...(extra || {}) };
}

async function buildPillars({ alignment, range, vp, last, news, seedBias }) {
  const [dxy, cot] = await Promise.all([getDxy(), getCotGold()]);
  const techWhy = `${alignment.summary}. H4 ${alignment.h4}, H1 ${alignment.h1}, M15 ${alignment.m15}. Dealing range ${range.low}–${range.high}, EQ ${range.eq}. ` +
    (vp ? `Prev-day VP: POC ${vp.poc}, VAH ${vp.vah}, VAL ${vp.val}. ` : "Prev-day VP unavailable. ") +
    `Structure bias sa pag-aaral: ${seedBias}. Hindi ito buy/sell call.`;
  let fundBias = "neutral";
  let fundWhy;
  if (news.calendarNote && !news.events.length) {
    fundWhy = `Calendar data unavailable muna (${news.calendarNote}). Hindi kami mag-i-invent ng CPI, NFP, o yield numbers.`;
  } else if (news.level === "high") {
    fundBias = "neutral";
    const names = news.events.filter((e) => e.impact === "high").map((e) => e.title).slice(0, 3).join(", ");
    fundWhy = `May high-impact USD event sa session window${names ? ": " + names : ""}. Bago mag-print, study mode muna — typical gold reaction ay tendency lang, hindi certainty. Hindi buy/sell call.`;
  } else if (news.level === "medium") {
    fundWhy = `May medium-impact USD news sa session. Bantayan ang actual vs forecast pagdating, pero huwag i-assume ang direksyon.`;
  } else {
    fundWhy = `Walang high-impact USD event na naka-flag sa session window. Fundamental backdrop ay tahimik sa calendar — hindi ibig sabihin walang risk.`;
  }
  let sentBias = "neutral";
  const bits = [];
  if (dxy.ok) {
    bits.push(`DXY ${dxy.last} (${dxy.direction}, ${dxy.change >= 0 ? "+" : ""}${dxy.change}) mula sa ${dxy.source}.`);
    if (dxy.direction === "up") sentBias = "bearish";
    else if (dxy.direction === "down") sentBias = "bullish";
    bits.push("Mas malakas na dolyar ay historical tendency na headwind sa ginto — hindi katiyakan.");
  } else {
    bits.push("DXY data unavailable — hindi namin i-i-invent ang dollar direction.");
  }
  if (cot.ok) {
    const net = cot.managedMoneyNet;
    bits.push(`CFTC COT (as of ${cot.reportDate}): managed money net ${net >= 0 ? "long" : "short"} ${Math.abs(net).toLocaleString("en-US")} contracts. Weekly at delayed; hindi signal.`);
  } else {
    bits.push("CFTC COT positioning data unavailable — hindi namin i-i-invent ang positioning.");
  }
  const technical = meter(seedBias, techWhy, "technical", { alignment, range, vp: vp || null });
  const fundamental = meter(fundBias, fundWhy, "fundamental", { news });
  const sentiment = meter(sentBias, bits.join(" "), "sentiment", {
    dxy: dxy.ok ? dxy : { ok: false, error: dxy.error || "unavailable" },
    cot: cot.ok ? cot : { ok: false, error: cot.error || "unavailable" },
  });
  return { technical, fundamental, sentiment };
}

export async function studyLevels() {
  const ohlc = await loadOhlc();
  const last = ohlc.m15[ohlc.m15.length - 1];
  const structure = labelStructure(findSwings(ohlc.m15, 2));
  const range = dealingRange(ohlc.m15, structure);
  const vp = previousDayProfile(ohlc.m15, ohlc.volumeKind);
  const sess = currentSession();
  return {
    last: { close: last.close, time: last.time },
    range, vp, session: sess,
    source: ohlc.source, sourceUrl: ohlc.sourceUrl,
    builtAt: manilaStamp(), failures: ohlc.failures || [],
  };
}

function extractText(j) {
  const cand = ((j && j.candidates) || [])[0] || {};
  const parts = (((cand.content || {}).parts) || []);
  return parts.map((p) => p.text || "").join("\n").trim();
}

function parseJson(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("json");
  return JSON.parse(raw.slice(a, b + 1));
}

async function callGemini(model, system, user, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error("no key"), { status: 500 });
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.35, maxOutputTokens: 1600, responseMimeType: "application/json" },
  };
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
      console.error("analyst gemini", model, "status", r.status, msg.replace(/key[=:]\s*\S+/ig, "key=[redacted]").slice(0, 180));
      throw Object.assign(new Error("upstream " + r.status), { status: r.status });
    }
    return { parsed: parseJson(extractText(j)), model };
  } finally {
    clearTimeout(t);
  }
}

const SYSTEM = `You are the UU AI Market Analyst for Universe Unlimited, writing an education-only study post about XAUUSD/gold structure at a session open.
Hard rules:
- Education only. Do not give a personal buy/sell-now call, entry price, or profit/income promise. Trading involves risk of loss.
- Use only the levels, prices, times, and calendar events supplied. Never invent a print, a price, or an event.
- If the calendar failed, say so.
- Bias must be bullish, bearish, or neutral, as a study bias — a way to read the map, not an order.
- Write clearly for students (English). Cite calendar events by name when relevant.
Return ONLY JSON with keys:
headline (short, no hype), bias (bullish|bearish|neutral), confidence (number 30-80), timeframe (string), breakdown (2-5 short paragraphs, may use line breaks), scenarioA (one sentence), scenarioB (one sentence), studyFocus (one sentence of what to watch, not an order).`;

async function writeNarrative(ctx) {
  const user = `Session: ${ctx.session.label} open on ${ctx.session.date} (Asia/Manila). Built at ${ctx.builtAt}.
Spot/study last close: ${ctx.last.close} at unix ${ctx.last.time}.
Source: ${ctx.source} (fetched ${ctx.builtAt}). Failures: ${(ctx.failures || []).join("; ") || "none"}.
Alignment: ${ctx.alignment.summary} (H4 ${ctx.alignment.h4}, H1 ${ctx.alignment.h1}, M15 ${ctx.alignment.m15}).
Dealing range high ${ctx.range.high}, low ${ctx.range.low}, equilibrium ${ctx.range.eq}.
Protected high ${ctx.range.protectedHigh}, protected low ${ctx.range.protectedLow}.
Suggested study invalidation (structure): ${ctx.invalidation}.
Previous-day volume profile (${ctx.vp ? ctx.vp.sessionDate : "n/a"}): POC ${ctx.vp && ctx.vp.poc}, VAH ${ctx.vp && ctx.vp.vah}, VAL ${ctx.vp && ctx.vp.val}. ${ctx.vp && ctx.vp.volumeNote}.
News badge: ${ctx.news.label}. Calendar: ${ctx.news.calendarNote || "ok"}. Events: ${JSON.stringify(ctx.news.events)}.
Computed study bias seed: ${ctx.seedBias} (confidence seed ${ctx.seedConfidence}). You may keep or soften it, but do not flip it without a reason in the data, and do not invent numbers.`;
  let last = null;
  for (const model of MODELS) {
    try {
      return await callGemini(model, SYSTEM, user, 20000);
    } catch (e) {
      last = e;
      const st = e.status || 0;
      const aborted = e.name === "AbortError" || /aborted/i.test(String(e.message || ""));
      console.error("analyst model fail", model, aborted ? "timeout" : ("status " + st));
      if (aborted || st === 404 || st === 429 || st === 503 || st === 400 || st >= 500) continue;
    }
  }
  throw last || new Error("narrative");
}

function chartBars(m15, take = 96) {
  return m15.slice(-take).map((b) => ({
    time: b.time,
    open: +b.open.toFixed(2),
    high: +b.high.toFixed(2),
    low: +b.low.toFixed(2),
    close: +b.close.toFixed(2),
  }));
}

async function buildPost(sess, opts = {}) {
  const builtAt = manilaStamp();
  const ohlc = await loadOhlc();
  const last = ohlc.m15[ohlc.m15.length - 1];
  const swings = findSwings(ohlc.m15, 2);
  const structure = labelStructure(swings);
  const range = dealingRange(ohlc.m15, structure);
  const alignment = alignmentMeter(ohlc.h4, ohlc.h1, ohlc.m15);
  const seedBias = structureBias(alignment, range, last);
  const inv = invalidation(seedBias, range);
  const vp = previousDayProfile(ohlc.m15, ohlc.volumeKind);
  const win = sessionWindowUnix(sess.date, sess);
  let cal = { events: [] };
  try { cal = await getCalendar(); } catch (e) { cal = { events: [], error: String(e.message || e) }; }
  const news = newsBadge(cal, win);
  const seedConfidence = confidenceOf(alignment, news.level);
  const paths = scenarioPaths(ohlc.m15, range, seedBias, inv);
  const labels = structure.labels.slice(-18).map((s) => ({ time: s.time, price: s.price, tag: s.tag }));
  const events = structure.events.slice(-8).map((e) => ({ time: e.time, price: e.price, kind: e.kind, note: e.note }));

  let narrative = {
    headline: `${sess.label} open study — gold around ${last.close.toFixed(1)}`,
    bias: seedBias,
    confidence: seedConfidence,
    timeframe: "M15 structure with H4/H1 alignment",
    breakdown: `This is a study map for the ${sess.label} session, built at ${builtAt}. Last study price is ${last.close.toFixed(2)} from ${ohlc.source}. The dealing range is ${range.low}–${range.high} with equilibrium at ${range.eq}. Protected high ${range.protectedHigh}, protected low ${range.protectedLow}. ${vp ? `Previous-day volume profile (session ${vp.sessionDate}): POC ${vp.poc}, VAH ${vp.vah}, VAL ${vp.val}. ${vp.volumeNote}` : "Previous-day volume profile was not available."} ${news.label}${news.calendarNote ? " Calendar note: " + news.calendarNote : ""}. Alignment: ${alignment.summary}. The written breakdown is structure-only because the language model was not reachable. This is education, not a signal, and profits are not guaranteed.`,
    scenarioA: paths.a.label,
    scenarioB: paths.b.label,
    studyFocus: "Watch whether price respects the previous-day value area and the marked invalidation — then journal what actually happens, win or loss.",
    model: null,
  };
  try {
    const out = await writeNarrative({
      session: sess, builtAt, last, source: ohlc.source, failures: ohlc.failures,
      alignment, range, invalidation: inv, vp, news, seedBias, seedConfidence,
    });
    const p = out.parsed || {};
    const bias = /bullish|bearish|neutral/i.test(p.bias || "") ? String(p.bias).toLowerCase() : seedBias;
    narrative = {
      headline: String(p.headline || narrative.headline).slice(0, 140),
      bias,
      confidence: Math.max(30, Math.min(80, Number(p.confidence) || seedConfidence)),
      timeframe: String(p.timeframe || narrative.timeframe).slice(0, 80),
      breakdown: String(p.breakdown || narrative.breakdown).slice(0, 4000),
      scenarioA: String(p.scenarioA || paths.a.label).slice(0, 400),
      scenarioB: String(p.scenarioB || paths.b.label).slice(0, 400),
      studyFocus: String(p.studyFocus || narrative.studyFocus).slice(0, 400),
      model: out.model,
    };
  } catch (e) {
    console.error("analyst narrative fallback", e.message || e);
  }

  const post = {
    id: sessionKey(sess.date, sess.id),
    session: sess.id,
    sessionLabel: sess.label,
    date: sess.date,
    builtAt,
    source: ohlc.source,
    sourceUrl: ohlc.sourceUrl,
    symbol: ohlc.symbol,
    lastPrice: +last.close.toFixed(2),
    lastTime: last.time,
    headline: narrative.headline,
    bias: narrative.bias,
    confidence: narrative.confidence,
    timeframe: narrative.timeframe,
    breakdown: narrative.breakdown,
    studyFocus: narrative.studyFocus,
    invalidation: +inv.toFixed(2),
    range,
    vp,
    alignment,
    news,
    labels,
    events,
    paths: {
      a: { label: narrative.scenarioA, points: paths.a.points },
      b: { label: narrative.scenarioB, points: paths.b.points },
    },
    bars: chartBars(ohlc.m15),
    model: narrative.model,
    risk: "Education only — not a buy or sell call, and profits are not guaranteed. Trading involves risk of loss. Journal wins and losses honestly.",
    failures: ohlc.failures || [],
    pillars: null,
  };
  try { post.pillars = await buildPillars({ alignment, range, vp, last, news, seedBias: narrative.bias }); }
  catch (e) { console.error("analyst pillars failed", e.message || e); }
  return post;
}

function gradePost(post, m15) {
  if (!post || !m15 || !m15.length) return null;
  const sess = SESSIONS.find((s) => s.id === post.session);
  if (!sess) return null;
  const win = sessionWindowUnix(post.date, sess);
  const now = Date.now() / 1000;
  if (now < win.close) return { status: "open", label: "Session still open — grade due after the close." };
  const inWin = m15.filter((b) => b.time >= win.open && b.time < win.close);
  if (inWin.length < 2) return { status: "incomplete", label: "Not enough session bars to grade." };
  const openPx = inWin[0].open;
  const closePx = inWin[inWin.length - 1].close;
  const high = Math.max(...inWin.map((b) => b.high));
  const low = Math.min(...inWin.map((b) => b.low));
  const inv = post.invalidation;
  const bias = post.bias;
  let invalidated = false;
  if (bias === "bullish" && low <= inv) invalidated = true;
  if (bias === "bearish" && high >= inv) invalidated = true;
  const move = closePx - openPx;
  let status, label;
  if (bias === "neutral") {
    status = "neutral";
    label = `Neutral study. Session close ${closePx.toFixed(2)} vs open ${openPx.toFixed(2)} (${move >= 0 ? "+" : ""}${move.toFixed(2)}).`;
  } else if (invalidated) {
    status = "miss";
    label = `Miss — invalidation ${inv} was reached. Session close ${closePx.toFixed(2)} vs open ${openPx.toFixed(2)}. Losses are shown honestly.`;
  } else if ((bias === "bullish" && move > 0) || (bias === "bearish" && move < 0)) {
    status = "hit";
    label = `Hit — close moved with the study bias (${move >= 0 ? "+" : ""}${move.toFixed(2)} from the session open). This is a study grade, not a profit claim.`;
  } else {
    status = "miss";
    label = `Miss — close moved against the study bias (${move >= 0 ? "+" : ""}${move.toFixed(2)}). Losses and misses are kept public.`;
  }
  return {
    id: post.id,
    date: post.date,
    session: post.session,
    sessionLabel: post.sessionLabel,
    bias: post.bias,
    confidence: post.confidence,
    invalidation: inv,
    open: +openPx.toFixed(2),
    close: +closePx.toFixed(2),
    high: +high.toFixed(2),
    low: +low.toFixed(2),
    status,
    label,
    gradedAt: manilaStamp(),
  };
}

async function refreshGrades(store) {
  let m15 = null;
  const due = (store.posts || []).filter((p) => {
    const already = (store.grades || []).some((g) => g.id === p.id && g.status !== "open");
    if (already) return false;
    const sess = SESSIONS.find((s) => s.id === p.session);
    if (!sess) return false;
    return Date.now() / 1000 >= sessionWindowUnix(p.date, sess).close;
  });
  if (!due.length) return store;
  try { m15 = (await loadOhlc()).m15; } catch { return store; }
  for (const p of due) {
    const g = gradePost(p, m15);
    if (!g || g.status === "open") continue;
    store.grades = (store.grades || []).filter((x) => x.id !== p.id).concat([g]);
  }
  store.grades = store.grades.slice(-90);
  return store;
}

const inflight = new Map();

export async function ensurePost(sess, { force = false, notify = true } = {}) {
  const id = sessionKey(sess.date, sess.id);
  if (inflight.has(id)) return inflight.get(id);
  const run = (async () => {
    let store = loadStore();
    store = await refreshGrades(store);
    const existing = (store.posts || []).find((p) => p.id === id);
    if (existing && !force) {
      saveStore(store);
      return { post: existing, store, created: false };
    }
    const post = await buildPost(sess);
    store.posts = (store.posts || []).filter((p) => p.id !== id).concat([post]).slice(-60);
    saveStore(store);
    if (notify) {
      try {
        await notifyAll("analyst", {
          title: "UU Market Analyst",
          body: `A new ${post.sessionLabel}-session study post is up: ${post.headline}. Education only — not a signal, and profits are not guaranteed.`,
          tag: "analyst-" + post.id,
          data: { type: "analyst", go: "markets", panel: "analyst", id: post.id },
        });
      } catch (e) {
        console.error("analyst notify failed", e.message || e);
      }
    }
    return { post, store, created: true };
  })();
  inflight.set(id, run);
  try { return await run; } finally { inflight.delete(id); }
}

export async function sessionTick() {
  const s = currentSession();
  const p = manilaParts();
  // Notify session open in the first 2 minutes, and ensure a post exists once the session is open.
  if (!s.open) return;
  const justOpened = p.hour === s.openH && p.minute <= 2;
  const store = loadStore();
  const has = (store.posts || []).some((x) => x.id === sessionKey(s.date, s.id));
  if (justOpened) {
    try {
      await notifyAll("session", {
        title: "UU session desk",
        body: `${s.label} session is opening (Manila time). Review the study desk and the calendar. Education only — not a buy or sell call.`,
        tag: "session-" + sessionKey(s.date, s.id),
        data: { type: "session", go: "markets", panel: "analyst" },
      });
    } catch (e) {
      console.error("session notify failed", e.message || e);
    }
  }
  if (!has && (justOpened || s.open)) {
    try { await ensurePost(s, { notify: true }); } catch (e) { console.error("session post failed", e.message || e); }
  } else {
    try { saveStore(await refreshGrades(store)); } catch (_) {}
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    const headers = cors(origin);
    res.statusCode = 204;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 404, { error: "GET /analyst" }, origin);
  }
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!rateLimit(ip)) return json(res, 429, { error: "rate_limit" }, origin);

  const url = new URL(req.url || "/", "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const now = currentSession();
  try {
    let store = loadStore();
    store = await refreshGrades(store);
    let post = (store.posts || []).find((p) => p.id === sessionKey(now.date, now.id));
    let created = false;
    if (now.open && (!post || force)) {
      const out = await ensurePost(now, { force, notify: !post || force });
      post = out.post;
      store = out.store;
      created = out.created;
    } else {
      saveStore(store);
    }
    const recent = (store.posts || []).slice(-6).reverse().map((p) => ({
      id: p.id, date: p.date, session: p.session, sessionLabel: p.sessionLabel,
      headline: p.headline, bias: p.bias, confidence: p.confidence, builtAt: p.builtAt,
    }));
    return json(res, 200, {
      ok: true,
      current: { id: now.id, label: now.label, date: now.date, open: now.open, nextOpen: now.nextOpen || null },
      post: post || null,
      recent,
      grades: (store.grades || []).slice(-30).reverse(),
      created,
      risk: "Education only — not a buy or sell call, and profits are not guaranteed. Trading involves risk of loss. Misses and losses stay on the public grade board.",
    }, origin);
  } catch (e) {
    console.error("analyst error", e.message || e);
    return json(res, 502, { error: "analyst", message: "The study feed could not be built right now. Try again in a minute." }, origin);
  }
}
