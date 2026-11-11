/**
 * Multi-source economic calendar for Universe Unlimited.
 * Primary: Forex Factory JSON, cached (serve stale on 429). Official cross-check:
 * BLS Public API (CPI/PPI/NFP), Federal Reserve FOMC calendar page, BEA news
 * schedule when reachable, Gemini grounded search to confirm actuals.
 * Never invent numbers. Investing.com is not used.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alreadySent, markSent, notifyAll } from "./push.js";

const FF_URLS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
];
const BLS_API = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const BEA_SCHED = "https://www.bea.gov/news/schedule";
const CFTC_DISAGG = "https://www.cftc.gov/dea/newcot/f_disagg.txt";
const DXY_YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1d&range=10d";

const FF_TTL = 5 * 60 * 1000;
const FF_STALE_MAX = 12 * 60 * 60 * 1000;
const OFFICIAL_TTL = 6 * 60 * 60 * 1000;
const UA = "UU-Gold-Analyst/1.0 (education; universe-unlimited-app.surge.sh)";
const DISK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "calendar-cache.json");
const STALE_NOTE = "Updated from a saved calendar. The live feed is temporarily busy.";

function readDiskCal() {
  try {
    const j = JSON.parse(fs.readFileSync(DISK, "utf8"));
    if (j && j.pack && j.at && Date.now() - j.at < FF_STALE_MAX) return j;
  } catch {}
  return null;
}
function writeDiskCal(pack) {
  try {
    fs.mkdirSync(path.dirname(DISK), { recursive: true });
    fs.writeFileSync(DISK, JSON.stringify({ at: Date.now(), pack }), { mode: 0o600 });
  } catch (e) { console.error("calendar cache write", e.message || e); }
}


const cache = {
  ff: null, ffAt: 0, ffFail: null,
  official: null, officialAt: 0,
  cot: null, cotAt: 0,
  dxy: null, dxyAt: 0,
};

function manilaLabel(d) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  return fmt.format(d) + " Asia/Manila (UTC+8)";
}

async function fetchText(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ac.signal, headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchJson(url, timeoutMs = 8000, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      cache: "no-store",
      signal: ac.signal,
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
      method: opts.method || "GET",
      body: opts.body,
    });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

export function impactOf(ev) {
  const raw = String(ev.impact || ev.Impact || ev.volatility || ev.title || "").toLowerCase();
  if (/holiday/.test(raw)) return "low";
  if (/high|red|3/.test(raw)) return "high";
  if (/medium|orange|2/.test(raw)) return "medium";
  const n = Number(ev.impact);
  if (n >= 3) return "high";
  if (n === 2) return "medium";
  return "low";
}

export function isUsd(ev) {
  const c = String(ev.country || ev.Country || ev.currency || ev.Currency || ev.zone || "").toUpperCase();
  return c === "USD" || c === "US" || c === "UNITED STATES";
}

export function isGoldUsdRelevant(ev) {
  if (isUsd(ev)) return true;
  const t = String(ev.title || ev.event || "");
  return /gold|xau|dxy|dollar|yield|fomc|cpi|nfp|pce|payroll|non-?farm|gdp|ppi|unemployment|fed /i.test(t);
}

export function eventFamily(title) {
  const t = String(title || "").toLowerCase();
  if (/fomc|fed interest|federal funds|rate decision|fed chair/.test(t)) return "FOMC";
  if (/\bcpi\b|consumer price/.test(t)) return "CPI";
  if (/\bppi\b|producer price/.test(t)) return "PPI";
  if (/non-?farm|nfp|payroll/.test(t)) return "NFP";
  if (/\bpce\b|personal consumption/.test(t)) return "PCE";
  if (/gdp|gross domestic/.test(t)) return "GDP";
  if (/unemployment/.test(t)) return "Unemployment";
  return null;
}

export function isPlaybookEvent(title) {
  return !!eventFamily(title);
}

function displayOrUnavailable(v) {
  const s = v == null ? "" : String(v).trim();
  if (!s || /^n\/?a$|^-$|^—$|^pending$|^tbd$/i.test(s)) return null;
  return s;
}

function parseWhen(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

function eventId(title, whenMs, country) {
  const key = [String(title || "").toLowerCase(), whenMs || "", String(country || "").toUpperCase()].join("|");
  return "ev_" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

function normalizeFf(ev) {
  const title = ev.title || ev.Title || ev.event || "Event";
  const when = parseWhen(ev.date || ev.Date || ev.datetime || ev.time || "");
  const country = ev.country || ev.Country || ev.currency || "";
  const forecast = displayOrUnavailable(ev.forecast || ev.Forecast || ev.fforecast);
  const previous = displayOrUnavailable(ev.previous || ev.Previous || ev.prev);
  const actual = displayOrUnavailable(ev.actual || ev.Actual);
  return {
    id: eventId(title, when ? when.getTime() : 0, country),
    title,
    country,
    impact: impactOf(ev),
    whenMs: when ? when.getTime() : null,
    whenIso: when ? when.toISOString() : null,
    whenManila: when ? manilaLabel(when) : null,
    forecast,
    previous,
    actual,
    family: eventFamily(title),
    relevant: isGoldUsdRelevant(ev),
    sources: [{ name: "Forex Factory calendar", url: FF_URLS[0] }],
    verification: "unconfirmed",
    verificationNote: "Listed on Forex Factory. Official actual not confirmed yet.",
  };
}

async function fetchFf() {
  const now = Date.now();
  if (cache.ff && now - cache.ffAt < FF_TTL) return cache.ff;
  let lastErr = null;
  for (const url of FF_URLS) {
    try {
      const rows = await fetchJson(url, 8000);
      const list = Array.isArray(rows) ? rows : (rows.events || []);
      const events = list.map(normalizeFf).filter((e) => e.relevant);
      const pack = { events, source: url, at: manilaLabel(new Date()), atMs: now, ok: true, stale: false };
      cache.ff = pack;
      cache.ffAt = now;
      cache.ffFail = null;
      writeDiskCal(pack);
      return pack;
    } catch (e) {
      lastErr = e;
    }
  }
  if (cache.ff && now - cache.ffAt < FF_STALE_MAX) {
    return { ...cache.ff, stale: true, warning: STALE_NOTE, error: null };
  }
  const disk = readDiskCal();
  if (disk && disk.pack) {
    cache.ff = disk.pack;
    cache.ffAt = disk.at;
    return { ...disk.pack, stale: true, warning: STALE_NOTE, error: null };
  }
  cache.ffFail = "Economic calendar data unavailable right now.";
  return { events: [], source: FF_URLS[0], at: manilaLabel(new Date()), ok: false, stale: false, error: null, warning: "Calendar temporarily unavailable." };
}

async function fetchBls() {
  const body = JSON.stringify({
    seriesid: ["CUSR0000SA0", "CUUR0000SA0", "CES0000000001", "LNS14000000", "WPSFD4"],
    startyear: String(new Date().getUTCFullYear() - 1),
    endyear: String(new Date().getUTCFullYear()),
  });
  const j = await fetchJson(BLS_API, 10000, { method: "POST", body, headers: { "Content-Type": "application/json", "User-Agent": UA } });
  if (j.status !== "REQUEST_SUCCEEDED") throw new Error("bls " + (j.status || "fail"));
  const out = {};
  const map = {
    CUSR0000SA0: "CPI",
    CUUR0000SA0: "CPI_NSA",
    CES0000000001: "NFP",
    LNS14000000: "Unemployment",
    WPSFD4: "PPI",
  };
  for (const s of (j.Results && j.Results.series) || []) {
    const fam = map[s.seriesID];
    const d = (s.data || [])[0];
    if (!fam || !d || d.value == null || d.value === "") continue;
    out[fam] = {
      family: fam,
      value: String(d.value),
      period: (d.periodName || d.period || "") + " " + (d.year || ""),
      preliminary: Array.isArray(d.footnotes) && d.footnotes.some((f) => f && f.code === "P"),
      source: "U.S. Bureau of Labor Statistics Public Data API",
      url: "https://www.bls.gov/developers/",
      seriesId: s.seriesID,
    };
  }
  return out;
}

async function fetchFomc() {
  const html = await fetchText(FOMC_URL, 10000);
  const meetings = [];
  // Official page lists meeting dates; capture year sections and month+day patterns near "Meeting"
  const yearBlocks = html.split(/<h[34][^>]*>/i);
  for (const block of yearBlocks) {
    const y = (block.match(/\b(202[4-9]|203\d)\b/) || [])[1];
    if (!y) continue;
    const re = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/g;
    let m;
    while ((m = re.exec(block)) && meetings.length < 16) {
      const month = m[1];
      const day = m[2];
      const isoGuess = Date.parse(`${month} ${day}, ${y} 14:00 UTC`);
      if (!Number.isFinite(isoGuess)) continue;
      meetings.push({
        title: "FOMC meeting (Federal Reserve calendar)",
        whenMs: isoGuess,
        whenIso: new Date(isoGuess).toISOString(),
        whenManila: manilaLabel(new Date(isoGuess)),
        source: "Board of Governors of the Federal Reserve System",
        url: FOMC_URL,
        year: y,
        label: `${month} ${day}${m[3] ? "–" + m[3] : ""}, ${y}`,
      });
    }
  }
  // de-dupe by date
  const seen = new Set();
  return meetings.filter((x) => {
    const k = (x.label || "") + x.year;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 12);
}

async function fetchBeaSchedule() {
  try {
    const html = await fetchText(BEA_SCHED, 10000);
    const items = [];
    // Pull visible release names and dates when present; do not invent figures.
    const re = /(Gross Domestic Product|Personal Income and Outlays|PCE|GDP)[^<]{0,80}?(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}/gi;
    let m;
    while ((m = re.exec(html)) && items.length < 8) {
      items.push({ title: m[0].replace(/\s+/g, " ").trim(), source: "U.S. Bureau of Economic Analysis news schedule", url: BEA_SCHED });
    }
    return items;
  } catch {
    return [];
  }
}

async function officialPack() {
  const now = Date.now();
  if (cache.official && now - cache.officialAt < OFFICIAL_TTL) return cache.official;
  const failures = [];
  let bls = {}, fomc = [], bea = [];
  try { bls = await fetchBls(); } catch (e) { failures.push("BLS API unavailable: " + (e.message || e)); }
  try { fomc = await fetchFomc(); } catch (e) { failures.push("Fed FOMC calendar unavailable: " + (e.message || e)); }
  try { bea = await fetchBeaSchedule(); } catch (e) { failures.push("BEA schedule unavailable: " + (e.message || e)); }
  const pack = { bls, fomc, bea, failures, at: manilaLabel(new Date()), sourceNotes: [
    { name: "BLS Public Data API", url: "https://www.bls.gov/developers/" },
    { name: "Federal Reserve FOMC calendars", url: FOMC_URL },
    { name: "BEA news schedule", url: BEA_SCHED },
  ] };
  cache.official = pack;
  cache.officialAt = now;
  return pack;
}

function numbersClose(a, b) {
  const na = Number(String(a).replace(/[,%]/g, ""));
  const nb = Number(String(b).replace(/[,%]/g, ""));
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    return String(a).replace(/\s/g, "") === String(b).replace(/\s/g, "");
  }
  const scale = Math.max(1, Math.abs(nb));
  return Math.abs(na - nb) / scale < 0.02 || Math.abs(na - nb) < 0.05;
}

function attachOfficial(ev, official) {
  const sources = ev.sources.slice();
  let verification = ev.verification;
  let verificationNote = ev.verificationNote;
  let actual = ev.actual;
  const fam = ev.family;
  const bls = official.bls || {};
  const officialHit = isUsd(ev) && ((fam && bls[fam]) || (fam === "CPI" && bls.CPI) || (fam === "Unemployment" && bls.Unemployment));
  if (officialHit && ev.whenMs && Date.now() >= ev.whenMs) {
    sources.push({ name: officialHit.source, url: officialHit.url, period: officialHit.period, seriesId: officialHit.seriesId });
    if (!actual) {
      // Official has a latest print, but it may be a prior month. Tag carefully.
      verification = "unconfirmed";
      verificationNote = `BLS latest published ${officialHit.family} is ${officialHit.value} (${officialHit.period}${officialHit.preliminary ? ", preliminary" : ""}). This may be the prior print — not assumed to be today's release.`;
    } else if (numbersClose(actual, officialHit.value)) {
      verification = "verified";
      verificationNote = `Actual matches BLS ${officialHit.family} ${officialHit.value} (${officialHit.period}${officialHit.preliminary ? ", preliminary" : ""}).`;
      actual = officialHit.value;
    } else {
      verification = "unconfirmed";
      verificationNote = `Forex Factory actual (${actual}) does not clearly match the latest BLS ${officialHit.family} figure ${officialHit.value} (${officialHit.period}). Both are shown; neither is invented.`;
    }
  }
  if (fam === "FOMC" && isUsd(ev)) {
    sources.push({ name: "Federal Reserve FOMC calendars", url: FOMC_URL });
    const near = (official.fomc || []).find((m) => ev.whenMs && Math.abs(m.whenMs - ev.whenMs) < 3 * 24 * 3600 * 1000);
    if (near) {
      verification = ev.actual ? ev.verification : "unconfirmed";
      verificationNote = (verificationNote || "") + ` Fed calendar lists ${near.label}.`;
    }
  }
  if (isUsd(ev) && (fam === "GDP" || fam === "PCE")) {
    sources.push({ name: "BEA news schedule", url: BEA_SCHED });
  }
  return { ...ev, actual, sources, verification, verificationNote };
}

const MODELS = ["gemini-3-flash-preview", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-latest"];

function extractText(j) {
  const cand = ((j && j.candidates) || [])[0] || {};
  return (((cand.content || {}).parts) || []).map((p) => p.text || "").join("\n").trim();
}
function parseJson(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("json");
  return JSON.parse(raw.slice(a, b + 1));
}

async function geminiConfirm(ev) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !ev.whenMs || Date.now() < ev.whenMs) return null;
  const prompt = `Confirm the official released figure for this U.S. economic event, using official sources if possible (BLS, BEA, Federal Reserve).
Event: ${ev.title}. Scheduled time: ${ev.whenIso} (${ev.whenManila}).
Forex Factory forecast: ${ev.forecast || "unavailable"}. Previous: ${ev.previous || "unavailable"}. Listed actual: ${ev.actual || "not listed"}.
Return JSON only: {"actual": string or null, "sourceName": string or null, "sourceUrl": string or null, "confirmed": boolean, "note": string}.
If you cannot find an official number, set actual to null and confirmed to false. NEVER invent a number.`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 800, responseMimeType: "application/json" },
  };
  for (const model of MODELS) {
    try {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) continue;
      const p = parseJson(extractText(j));
      if (p && p.actual && p.confirmed) return p;
      return p;
    } catch (_) { /* try next model */ }
  }
  return null;
}

export async function getCalendar() {
  const ff = await fetchFf();
  const official = await officialPack();
  const events = (ff.events || []).map((e) => attachOfficial(e, official));
  return {
    ok: ff.ok || !!(events.length),
    stale: !!ff.stale,
    error: ff.error || null,
    warning: ff.warning || null,
    source: ff.source,
    official,
    at: ff.at,
    events,
    risk: "Education only — not a buy or sell call, and profits are not guaranteed. Figures are shown only when a source provides them. Missing values are marked data unavailable.",
  };
}

export async function confirmHighImpactActuals(events) {
  const now = Date.now();
  const out = [];
  for (const ev of events) {
    if (ev.impact !== "high" || !ev.whenMs || now < ev.whenMs) { out.push(ev); continue; }
    if (ev.verification === "verified") { out.push(ev); continue; }
    if (!isPlaybookEvent(ev.title)) { out.push(ev); continue; }
    try {
      const g = await geminiConfirm(ev);
      if (g && g.actual && g.confirmed) {
        const sources = ev.sources.slice();
        if (g.sourceName) sources.push({ name: g.sourceName, url: g.sourceUrl || "" });
        const match = ev.actual ? numbersClose(ev.actual, g.actual) : true;
        out.push({
          ...ev,
          actual: ev.actual && !match ? ev.actual : String(g.actual),
          sources,
          verification: match || !ev.actual ? "verified" : "unconfirmed",
          verificationNote: match || !ev.actual
            ? `Confirmed via grounded search: ${g.sourceName || "cited source"}. ${g.note || ""}`
            : `Grounded search found ${g.actual} (${g.sourceName || "cited source"}) which does not clearly match Forex Factory (${ev.actual}). Both shown; neither invented.`,
        });
        continue;
      }
    } catch (_) { /* leave unconfirmed */ }
    out.push(ev);
  }
  return out;
}

export async function getDxy() {
  const now = Date.now();
  if (cache.dxy && now - cache.dxyAt < 15 * 60 * 1000) return cache.dxy;
  try {
    const j = await fetchJson(DXY_YAHOO, 8000);
    const res = ((j.chart && j.chart.result) || [])[0];
    const ts = res.timestamp || [];
    const q = ((res.indicators && res.indicators.quote) || [])[0] || {};
    const closes = ts.map((t, i) => ({ t, c: +q.close?.[i] })).filter((x) => Number.isFinite(x.c));
    if (closes.length < 2) throw new Error("short");
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const change = last.c - prev.c;
    const pack = {
      ok: true,
      last: +last.c.toFixed(3),
      prev: +prev.c.toFixed(3),
      change: +change.toFixed(3),
      direction: change > 0.02 ? "up" : change < -0.02 ? "down" : "flat",
      source: "Yahoo Finance DX-Y.NYB (U.S. Dollar Index)",
      url: "https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB",
      at: manilaLabel(new Date()),
    };
    cache.dxy = pack; cache.dxyAt = now;
    return pack;
  } catch (e) {
    return { ok: false, error: "DXY data unavailable. " + (e.message || e) };
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export async function getCotGold() {
  const now = Date.now();
  if (cache.cot && now - cache.cotAt < 12 * 60 * 60 * 1000) return cache.cot;
  try {
    const text = await fetchText(CFTC_DISAGG, 12000);
    const line = text.split(/\r?\n/).find((ln) => /^"?GOLD - COMMODITY EXCHANGE INC\./i.test(ln));
    if (!line) throw new Error("gold row missing");
    const cols = parseCsvLine(line);
    const reportDate = cols[2];
    const oi = Number(String(cols[7]).replace(/,/g, ""));
    const mmLong = Number(String(cols[13]).replace(/,/g, ""));
    const mmShort = Number(String(cols[14]).replace(/,/g, ""));
    if (![oi, mmLong, mmShort].every(Number.isFinite)) throw new Error("columns");
    const net = mmLong - mmShort;
    const pack = {
      ok: true,
      market: "GOLD - COMMODITY EXCHANGE INC.",
      reportDate,
      openInterest: oi,
      managedMoneyLong: mmLong,
      managedMoneyShort: mmShort,
      managedMoneyNet: net,
      source: "CFTC Disaggregated Commitments of Traders (Futures only)",
      url: CFTC_DISAGG,
      note: "Weekly, lagged official positioning. Not a trade signal.",
    };
    cache.cot = pack; cache.cotAt = now;
    return pack;
  } catch (e) {
    return { ok: false, error: "CFTC COT positioning data unavailable. " + (e.message || e) };
  }
}

export async function newsPushTick() {
  const cal = await getCalendar();
  const now = Date.now();
  const highs = (cal.events || []).filter((e) => e.impact === "high" && e.whenMs);
  for (const ev of highs) {
    const mins = (ev.whenMs - now) / 60000;
    async function fire(kind, body) {
      const key = kind + ":" + ev.id;
      if (alreadySent(key)) return;
      markSent(key);
      try {
        await notifyAll("news", {
          title: "UU News Radar",
          body,
          tag: key,
          data: { type: "news", go: "markets", panel: "radar", id: ev.id },
        });
      } catch (e) {
        console.error("news push failed", e.message || e);
      }
    }
    if (mins <= 30 && mins > 5) {
      await fire("30m", `High-impact ${ev.title} in about 30 minutes (${ev.whenManila}). Forecast ${ev.forecast || "unavailable"}, previous ${ev.previous || "unavailable"}. Education only — not a buy or sell call.`);
    } else if (mins <= 5 && mins > -1) {
      await fire("5m", `High-impact ${ev.title} in about 5 minutes (${ev.whenManila}). Spreads can widen. Education only — not a buy or sell call.`);
    } else if (mins <= 0 && ev.actual) {
      await fire("actual", `${ev.title} actual is listed as ${ev.actual} (${ev.verification}). Forecast was ${ev.forecast || "unavailable"}. Education only — not a buy or sell call, and profits are not guaranteed.`);
    }
  }
}

export { FOMC_URL, BLS_API, BEA_SCHED, CFTC_DISAGG, DXY_YAHOO, manilaLabel };
