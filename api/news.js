/**
 * UU News Radar — gold/USD events, playbooks, and Taglish "Paano sumabay" guides.
 * Education only. Never invent forecast/previous/actual.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors, json, rateLimit } from "./http.js";
import { getCalendar, confirmHighImpactActuals, isPlaybookEvent, eventFamily, newsPushTick } from "./calendar.js";
import { studyLevels } from "./analyst.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.NEWS_STORE_PATH || path.join(ROOT, "..", "data", "news-store.json");
const MODELS = ["gemini-3-flash-preview", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-latest"];
const RISK = "Education only — not a buy or sell call, and profits are not guaranteed. Trading involves risk of loss. Spreads can widen around news; a small lot and waiting for the first candle are study habits, not a system.";

function loadNewsStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, "utf8"));
    return { playbooks: j.playbooks && typeof j.playbooks === "object" ? j.playbooks : {} };
  } catch { return { playbooks: {} }; }
}
function saveNewsStore(s) {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    const tmp = STORE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ playbooks: s.playbooks || {} }), { mode: 0o600 });
    fs.renameSync(tmp, STORE);
  } catch (e) { console.error("news store write failed", e.message || e); }
}

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

async function callGemini(system, user, { search = false, timeoutMs = 20000 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error("no key"), { status: 500 });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1600, responseMimeType: "application/json" },
  };
  if (search) body.tools = [{ google_search: {} }];
  let last = null;
  for (const model of MODELS) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
      const r = await fetch(url, {
        method: "POST", signal: ac.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        last = Object.assign(new Error("upstream " + r.status), { status: r.status });
        if (r.status === 429 || r.status === 400) continue;
        continue;
      }
      return { parsed: parseJson(extractText(j)), model };
    } catch (e) { last = e; }
    finally { clearTimeout(t); }
  }
  throw last || new Error("gemini");
}

const PLAY_SYS = `You are the UU AI Market Analyst writing education-only notes for gold (XAUUSD) students.
Hard rules: no buy/sell-now calls, no entries, no profit promises. Typical gold reactions are historical tendencies, not certainty. Use only supplied numbers. If a figure is missing, say "data unavailable". Return JSON only.`;

function fallbackPlaybook(ev, levels, phase) {
  const fc = ev.forecast || "data unavailable";
  const prev = ev.previous || "data unavailable";
  const act = ev.actual || "data unavailable";
  const poc = levels?.vp ? `POC ${levels.vp.poc}, VAH ${levels.vp.vah}, VAL ${levels.vp.val}` : "prev-day VP unavailable";
  const rng = levels?.range ? `session/study range ${levels.range.low}–${levels.range.high}, EQ ${levels.range.eq}` : "range unavailable";
  const pre = {
    forecastVsPrevious: `Forecast ${fc}; previous ${prev}. If a figure is listed as data unavailable, do not guess it.`,
    typicalReaction: "Historically, a hotter-than-forecast US inflation or jobs print can strengthen the dollar and weigh on gold, and a cooler print can do the opposite — a tendency, not a certainty. Events can also fade quickly.",
    keyLevels: `Key study levels: ${poc}. ${rng}.`,
    riskNotes: "Around the release, spreads can widen and slippage can occur. A common study habit is to wait for the first candle to complete and to keep size small. This is not a trade call.",
  };
  const post = {
    whatItMeans: `Listed actual is ${act} (verification: ${ev.verification || "unconfirmed"}). Compare it only to the sourced forecast (${fc}) and previous (${prev}). If any of these is unavailable, say so — do not invent a print.`,
    firstCandle: "After the number, wait for the first candle and for spreads to settle before judging the reaction. Education only.",
    spread: "Spreads and slippage can spike at the print. Small lot is a risk habit, not a promise of safety.",
  };
  const paano = phase === "after"
    ? `Pagkatapos ng ${ev.title}: ang listed actual ay ${act} (forecast ${fc}, previous ${prev}). Huwag mag-invent ng number kung unavailable. Hintayin muna ang first candle, bantayan ang spread, at manatili sa maliit na lot. Education only — hindi buy/sell call, at hindi guaranteed ang kita.`
    : `Bago ang ${ev.title} (${ev.whenManila || "time unavailable"}): forecast ${fc}, previous ${prev}. Typical reaction ng ginto kung hotter o cooler kaysa forecast ay tendency lang, hindi kasiguraduhan. Tandaan ang levels: ${poc}. Palawak ang spread sa news — hintayin ang first candle, maliit na lot. Hindi ito signal.`;
  return { pre, post, paanoSumabay: paano, model: null, phase };
}

async function writePlaybook(ev, levels, phase) {
  const ctx = `Event: ${ev.title} (${eventFamily(ev.title) || "macro"}).
When: ${ev.whenManila || ev.whenIso || "unavailable"} (${ev.whenIso || ""}).
Impact: ${ev.impact}. Verification: ${ev.verification}. Note: ${ev.verificationNote || ""}.
Forecast: ${ev.forecast || "data unavailable"}. Previous: ${ev.previous || "data unavailable"}. Actual: ${ev.actual || "data unavailable"}.
Sources: ${(ev.sources || []).map((s) => s.name).join("; ")}.
Study levels: ${levels?.vp ? `prev-day VP POC ${levels.vp.poc}, VAH ${levels.vp.vah}, VAL ${levels.vp.val} (${levels.vp.volumeNote || ""})` : "prev-day VP unavailable"}.
Range: ${levels?.range ? `${levels.range.low}–${levels.range.high}, EQ ${levels.range.eq}, protected high ${levels.range.protectedHigh}, protected low ${levels.range.protectedLow}` : "unavailable"}.
Last study price: ${levels?.last?.close ?? "unavailable"} from ${levels?.source || "unavailable"}.
Phase: ${phase}.`;
  const want = phase === "after"
    ? `Return JSON: {"whatItMeans": "...", "firstCandle": "...", "spread": "...", "paanoSumabay": "Taglish paragraph: ano ang ibig sabihin ng actual, hintayin ang first candle, bantayan ang spread, maliit na lot. Education only."}`
    : `Return JSON: {"forecastVsPrevious": "...", "typicalReaction": "hotter vs cooler than forecast as historical tendency, not certainty", "keyLevels": "use only supplied POC/VAH/VAL and range", "riskNotes": "spread widening, slippage, wait for the first candle, small lot", "paanoSumabay": "Taglish paragraph covering forecast, typical reaction, key levels, spread, first candle, small lot. Education only."}`;
  const out = await callGemini(PLAY_SYS, ctx + "\n" + want, { search: phase === "after" && !!ev.actual, timeoutMs: 22000 });
  const p = out.parsed || {};
  if (phase === "after") {
    return {
      pre: null,
      post: {
        whatItMeans: String(p.whatItMeans || "").slice(0, 1200),
        firstCandle: String(p.firstCandle || "").slice(0, 600),
        spread: String(p.spread || "").slice(0, 600),
      },
      paanoSumabay: String(p.paanoSumabay || "").slice(0, 1200),
      model: out.model,
      phase,
    };
  }
  return {
    pre: {
      forecastVsPrevious: String(p.forecastVsPrevious || "").slice(0, 800),
      typicalReaction: String(p.typicalReaction || "").slice(0, 1000),
      keyLevels: String(p.keyLevels || "").slice(0, 800),
      riskNotes: String(p.riskNotes || "").slice(0, 800),
    },
    post: null,
    paanoSumabay: String(p.paanoSumabay || "").slice(0, 1200),
    model: out.model,
    phase,
  };
}

async function ensurePlaybook(ev, levels) {
  const phase = ev.actual && ev.whenMs && Date.now() >= ev.whenMs ? "after" : "before";
  const key = ev.id + ":" + phase + ":" + (ev.actual || "na");
  const store = loadNewsStore();
  if (store.playbooks[key]) return store.playbooks[key];
  let pb;
  try { pb = await writePlaybook(ev, levels, phase); }
  catch (e) {
    console.error("playbook fallback", ev.title, e.message || e);
    pb = fallbackPlaybook(ev, levels, phase);
  }
  pb.eventId = ev.id;
  pb.title = ev.title;
  pb.at = new Date().toISOString();
  store.playbooks[key] = pb;
  // cap
  const keys = Object.keys(store.playbooks);
  if (keys.length > 80) keys.slice(0, keys.length - 80).forEach((k) => delete store.playbooks[k]);
  saveNewsStore(store);
  return pb;
}

export { newsPushTick };

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    const headers = cors(origin);
    res.statusCode = 204;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return res.end();
  }
  if (req.method !== "GET") return json(res, 404, { error: "GET /news" }, origin);
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!rateLimit(ip)) return json(res, 429, { error: "rate_limit" }, origin);

  try {
    let cal = await getCalendar();
    try {
      cal = { ...cal, events: await confirmHighImpactActuals(cal.events || []) };
    } catch (e) {
      console.error("confirm actuals skipped", e.message || e);
    }
    let levels = null;
    try { levels = await studyLevels(); } catch (e) { console.error("news levels", e.message || e); }

    const now = Date.now();
    const events = (cal.events || []).slice().sort((a, b) => (a.whenMs || 0) - (b.whenMs || 0));
    const playbooks = {};
    for (const ev of events) {
      if (ev.impact !== "high" || !isPlaybookEvent(ev.title)) continue;
      if (ev.whenMs && ev.whenMs > now + 36 * 3600 * 1000) continue; // only near-term playbooks
      if (ev.whenMs && ev.whenMs < now - 36 * 3600 * 1000 && !ev.actual) continue;
      try { playbooks[ev.id] = await ensurePlaybook(ev, levels); }
      catch (e) { playbooks[ev.id] = fallbackPlaybook(ev, levels, ev.actual ? "after" : "before"); }
    }

    return json(res, 200, {
      ok: cal.ok,
      stale: !!cal.stale,
      error: cal.error || null,
      warning: cal.warning || null,
      at: cal.at,
      source: cal.source,
      official: cal.official ? { failures: cal.official.failures, sourceNotes: cal.official.sourceNotes, at: cal.official.at } : null,
      levels: levels && {
        last: levels.last, range: levels.range, vp: levels.vp,
        session: levels.session, source: levels.source, builtAt: levels.builtAt,
      },
      events,
      playbooks,
      risk: RISK,
    }, origin);
  } catch (e) {
    console.error("news error", e.message || e);
    return json(res, 502, { error: "news", message: "News Radar data unavailable right now.", risk: RISK }, origin);
  }
}
