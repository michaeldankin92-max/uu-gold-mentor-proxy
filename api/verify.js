/**
 * Universe Unlimited — AI Access Verifier (POST /verify).
 * Gemini vision checks ACCM screenshots. Images are held in memory only for the
 * check, then discarded. The store keeps hashes, device↔UID bindings, and a
 * short manual-review queue — never the photos themselves.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors, json, rateLimit, readBody } from "./http.js";

const IB_CODE = "z6hgt5";
const IB_SHARE = "a5d4a2206f644ad3b";
const MIN_USD = 50;
const MIN_USC = 5000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_BODY = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

const MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
];

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = process.env.VERIFY_STORE_PATH || path.join(ROOT, "..", "data", "verify-store.json");

const SYSTEM = `You are an access-verification assistant for Universe Unlimited, a gold-trading education app.
You inspect screenshots of an ACCM brokerage account. Return ONLY valid JSON, no markdown.

The student must show ALL of the following when possible:
1) The account was registered under Michael M. Dankin's IB / referral / agent / invite code "${IB_CODE}" (also accept the share/invite id ${IB_SHARE}). Look at referral, IB, agent, introducer, or invite fields. If no referral/IB/agent information is visible, set needReferralScreenshot=true.
2) The account is KYC VERIFIED (a Verified badge, verified KYC, or equivalent "verified" account status — not pending, not rejected, not unverified).
3) A deposit or account balance of at least ${MIN_USD} USD, or at least ${MIN_USC} USC (cent-account units). Convert carefully: 100 USC = $1, so ${MIN_USC} USC = $${MIN_USD}. Use the most relevant balance or last deposit shown.

Also extract, if visible: the account UID, the account holder name, and any on-screen date/time.
Flag consistency problems (UID that does not match the submitted UID, different names or UIDs across shots, dates that are implausible — far in the future, many years old, or that disagree with each other).
Score edited-image suspicion from 0 to 100 based only on signs of tampering: mismatched fonts on a single field, cloned or cut-and-paste edges, inconsistent lighting or scale, obvious retouching, overlaid digits, or a "EDITED"/"PASTED" watermark. Do not raise the score just because the UI is a simple or generic account portal, or because it is a study/mock layout with clearly readable account fields. A clean screen capture of readable UID, IB code, KYC status, and balance should score low (under 30) unless those tampering signs are present.

Be conservative about the three required checks. If a required item is not clearly visible, set that field to null and explain in missing[]. Never invent a UID, balance, or code that you cannot see.`;

function emptyStore() {
  return { hashes: {}, devices: {}, uids: {}, queue: [] };
}

function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      hashes: j.hashes && typeof j.hashes === "object" ? j.hashes : {},
      devices: j.devices && typeof j.devices === "object" ? j.devices : {},
      uids: j.uids && typeof j.uids === "object" ? j.uids : {},
      queue: Array.isArray(j.queue) ? j.queue.slice(-200) : [],
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
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STORE_PATH);
    try { fs.chmodSync(STORE_PATH, 0o600); } catch { /* ignore */ }
  } catch (e) {
    console.error("verify store write failed", e && e.message);
  }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function shortId() {
  return "rev_" + crypto.randomBytes(6).toString("hex");
}

function manilaIso(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} Asia/Manila (UTC+8)`;
}

function normalizeUid(u) {
  return String(u || "").trim();
}

function normalizeCode(c) {
  return String(c || "").trim().toLowerCase().replace(/\s+/g, "");
}

function decodeImage(im) {
  const mime = String((im && (im.mime || im.mimeType || im.type)) || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime) && mime !== "image/jpg") {
    throw new Error("bad_mime");
  }
  const b64 = String((im && (im.data || im.dataBase64 || im.base64)) || "").replace(/^data:[^;]+;base64,/, "");
  if (!b64) throw new Error("empty_image");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error("bad_image_size");
  const safeMime = mime === "image/jpg" ? "image/jpeg" : mime;
  return { mime: safeMime, buf, data: buf.toString("base64"), bytes: buf.length };
}

function parseVisionJson(text) {
  const raw = String(text || "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("vision_json");
  return JSON.parse(unfenced.slice(start, end + 1));
}

function extractText(j) {
  const cand = ((j && j.candidates) || [])[0] || {};
  const parts = (((cand.content || {}).parts) || []);
  return parts.map((p) => p.text || "").join("\n").trim();
}

async function callVision(model, parts, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error("GEMINI_API_KEY is not set");
    err.status = 500;
    throw err;
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
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
      const safe = msg.replace(/key[=:]\s*\S+/ig, "key=[redacted]").slice(0, 220);
      console.error("verify gemini", model, "status", r.status, safe);
      const err = new Error("upstream " + r.status);
      err.status = r.status;
      throw err;
    }
    const reply = extractText(j);
    if (!reply) {
      const err = new Error("empty reply");
      err.status = 502;
      throw err;
    }
    return { parsed: parseVisionJson(reply), model };
  } finally {
    clearTimeout(t);
  }
}

async function runVision(uid, images) {
  const text = `Submitted ACCM UID: ${uid}
Today's date for plausibility checks: ${manilaIso()}
Expected IB / referral / agent code: ${IB_CODE} (or share id ${IB_SHARE}).
Minimum funds: $${MIN_USD} USD or ${MIN_USC} USC.

Inspect every attached screenshot and return JSON with exactly these keys:
{
  "ibCodeVisible": boolean,
  "ibCodeValue": string or null,
  "ibCodeMatches": boolean or null,
  "needReferralScreenshot": boolean,
  "kycVerified": boolean or null,
  "kycEvidence": string,
  "balanceUsd": number or null,
  "balanceRaw": string or null,
  "balanceUnit": "USD" or "USC" or "other" or null,
  "depositOrBalanceMeetsMinimum": boolean or null,
  "uidVisible": boolean,
  "uidValue": string or null,
  "uidMatchesSubmitted": boolean or null,
  "nameVisible": boolean,
  "nameValue": string or null,
  "dateVisible": boolean,
  "dateValue": string or null,
  "datePlausible": boolean or null,
  "namesConsistent": boolean or null,
  "uidsConsistent": boolean or null,
  "editedSuspicionScore": number,
  "editedSuspicionReasons": string[],
  "summary": string,
  "missing": string[]
}`;
  const parts = [{ text }].concat(images.map((im) => ({ inlineData: { mimeType: im.mime, data: im.data } })));
  let last = null;
  for (const model of MODELS) {
    const timeoutMs = model.includes("pro") ? 28000 : 22000;
    try {
      return await callVision(model, parts, timeoutMs);
    } catch (e) {
      last = e;
      const st = e.status || 0;
      const aborted = e.name === "AbortError" || /aborted/i.test(String(e.message || ""));
      console.error("verify model fail", model, aborted ? "timeout" : ("status " + st));
      if (aborted || st === 404 || st === 429 || st === 503 || st === 400) continue;
      if (st >= 500) continue;
    }
  }
  throw last || new Error("all models failed");
}

function fundsOk(v) {
  if (v.depositOrBalanceMeetsMinimum === true) return true;
  if (v.depositOrBalanceMeetsMinimum === false) return false;
  const unit = String(v.balanceUnit || "").toUpperCase();
  const n = Number(v.balanceUsd);
  if (unit === "USC" && Number.isFinite(Number(v.balanceRaw))) {
    return Number(String(v.balanceRaw).replace(/[^\d.-]/g, "")) >= MIN_USC;
  }
  if (Number.isFinite(n)) return n >= MIN_USD;
  return null;
}

function codeMatches(v) {
  if (v.ibCodeMatches === true) return true;
  const c = normalizeCode(v.ibCodeValue);
  if (!c) return v.ibCodeVisible ? false : null;
  return c === IB_CODE || c.includes(IB_CODE) || c.includes(IB_SHARE);
}

function decide(v, fraud) {
  const reasons = [];
  const checks = {
    ibCode: "unknown",
    verified: "unknown",
    balance: "unknown",
    consistency: "unknown",
    duplicate: fraud.duplicate ? "fail" : "pass",
    deviceUid: fraud.deviceConflict ? "fail" : (fraud.uidNewDevice ? "review" : "pass"),
    suspicion: Number(v.editedSuspicionScore) || 0,
  };

  if (fraud.duplicate) {
    reasons.push("This screenshot was already used. Upload a fresh, original ACCM screenshot.");
    return { status: "fail", checks, reasons, need: null };
  }
  if (fraud.deviceConflict) {
    reasons.push("This device is already tied to a different ACCM UID. One UID per device.");
    return { status: "fail", checks, reasons, need: null };
  }

  const ibOk = codeMatches(v);
  const ibVisible = v.ibCodeVisible === true || !!normalizeCode(v.ibCodeValue);
  if (ibOk === true) checks.ibCode = "pass";
  else if (!ibVisible || v.needReferralScreenshot) checks.ibCode = "need_more";
  else checks.ibCode = "fail";

  if (v.kycVerified === true) checks.verified = "pass";
  else if (v.kycVerified === false) checks.verified = "fail";
  else checks.verified = "unknown";

  const money = fundsOk(v);
  if (money === true) checks.balance = "pass";
  else if (money === false) checks.balance = "fail";
  else checks.balance = "unknown";

  const mismatches = [];
  if (v.uidMatchesSubmitted === false) mismatches.push("The UID in the screenshot does not match the UID you entered.");
  if (v.uidsConsistent === false) mismatches.push("The UID is not consistent across the screenshots.");
  if (v.namesConsistent === false) mismatches.push("The name is not consistent across the screenshots.");
  if (v.datePlausible === false) mismatches.push("The date on the screenshot looks implausible or inconsistent.");
  checks.consistency = mismatches.length ? "fail" : "pass";

  const suspicion = Math.max(0, Math.min(100, Number(v.editedSuspicionScore) || 0));
  checks.suspicion = suspicion;

  if (checks.ibCode === "fail") reasons.push("The IB / referral code in the screenshot is not Michael's code z6hgt5.");
  if (checks.verified === "fail") reasons.push("The account does not look KYC verified.");
  if (checks.balance === "fail") reasons.push("The deposit or balance is below $50 (or 5,000 USC).");
  reasons.push(...mismatches);
  if (suspicion >= 40 && (v.editedSuspicionReasons || []).length) {
    reasons.push("Edited-image checks: " + v.editedSuspicionReasons.slice(0, 3).join("; "));
  } else if (suspicion >= 60) {
    reasons.push("The screenshots look possibly edited.");
  }

  const hardFail = checks.ibCode === "fail" || checks.verified === "fail" || checks.balance === "fail" || (v.uidMatchesSubmitted === false);
  const needMore = checks.ibCode === "need_more";
  const uncertain = checks.verified === "unknown" || checks.balance === "unknown" || checks.consistency === "fail" || v.datePlausible === false || v.namesConsistent === false;
  const borderline = suspicion >= 40 || fraud.uidNewDevice || uncertain;
  const allClear = checks.ibCode === "pass" && checks.verified === "pass" && checks.balance === "pass" && checks.consistency === "pass" && suspicion < 40 && !fraud.uidNewDevice;

  if (needMore && !hardFail) {
    return {
      status: "need_more",
      checks,
      reasons: reasons.concat(["The IB / referral / agent code is not visible."]),
      need: "Please add a screenshot of your ACCM profile or referral screen that clearly shows Michael's IB / referral code z6hgt5.",
    };
  }
  if (hardFail) {
    return { status: "fail", checks, reasons, need: null };
  }
  if (allClear) {
    return { status: "pass", checks, reasons: [], need: null };
  }
  return { status: "review", checks, reasons: reasons.length ? reasons : ["This result is borderline and will be checked by Michael or a coach."], need: null };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    const headers = cors(origin);
    res.statusCode = 204;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return res.end();
  }
  if (req.method !== "POST") return json(res, 404, { error: "POST /verify only" }, origin);

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!rateLimit(ip)) {
    return json(res, 429, { error: "rate_limit", status: "fail", message: "Please wait a few minutes and try again." }, origin);
  }

  let body;
  try { body = await readBody(req, MAX_BODY); }
  catch (e) {
    const code = /too_large/i.test(String(e && e.message)) ? 413 : 400;
    return json(res, code, { error: code === 413 ? "too_large" : "invalid json" }, origin);
  }

  const uid = normalizeUid(body.uid);
  const deviceId = String(body.deviceId || "").trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(uid)) {
    return json(res, 400, { error: "bad_uid", message: "Enter a valid ACCM UID." }, origin);
  }
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(deviceId)) {
    return json(res, 400, { error: "bad_device", message: "Missing device id." }, origin);
  }
  const rawImages = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (!rawImages.length) {
    return json(res, 400, { error: "no_images", message: "Upload at least one ACCM screenshot." }, origin);
  }

  let images;
  try {
    images = rawImages.map(decodeImage);
  } catch (e) {
    return json(res, 400, { error: "bad_image", message: "Use a JPEG, PNG, or WebP screenshot under 4 MB." }, origin);
  }

  const hashes = images.map((im) => sha256(im.buf));
  const store = loadStore();
  const deviceBound = store.devices[deviceId];
  const uidBound = store.uids[uid];
  const fraud = { duplicate: false, deviceConflict: false, uidNewDevice: false, priorHashes: [] };

  if (deviceBound && deviceBound !== uid) fraud.deviceConflict = true;
  if (uidBound && uidBound !== deviceId) fraud.uidNewDevice = true;

  for (const h of hashes) {
    const prior = store.hashes[h];
    if (!prior) continue;
    fraud.priorHashes.push(h);
    const sameOwner = prior.uid === uid && prior.deviceId === deviceId;
    if (!sameOwner) fraud.duplicate = true;
  }

  let vision = { parsed: {}, model: null };
  if (!fraud.duplicate && !fraud.deviceConflict) {
    try {
      vision = await runVision(uid, images);
    } catch (e) {
      images.forEach((im) => { im.data = null; im.buf = null; });
      const status = e.status === 429 ? 429 : 502;
      console.error("verify upstream", status, e.message || "");
      return json(res, status, { error: "upstream", status: "fail", message: "The verifier is busy or waking up. Please try again in a minute." }, origin);
    }
  } else {
    vision.parsed = {
      ibCodeVisible: false,
      kycVerified: null,
      depositOrBalanceMeetsMinimum: null,
      editedSuspicionScore: 0,
      editedSuspicionReasons: [],
      summary: fraud.duplicate ? "Duplicate screenshot blocked." : "Device already tied to another UID.",
      missing: [],
    };
  }

  const v = vision.parsed || {};
  const decision = decide(v, fraud);
  const at = manilaIso();
  const reviewId = decision.status === "review" ? shortId() : null;

  for (const h of hashes) {
    store.hashes[h] = { uid, deviceId, at, status: decision.status };
  }
  const uidMatched = v.uidMatchesSubmitted === true;
  if (decision.status === "pass") {
    store.devices[deviceId] = uid;
    store.uids[uid] = deviceId;
  } else if (uidMatched && !store.devices[deviceId] && !fraud.deviceConflict) {
    // Lock this device to the UID shown in the screenshots (typos are not locked).
    store.devices[deviceId] = uid;
  }

  if (decision.status === "review") {
    store.queue.push({
      id: reviewId,
      at,
      uid,
      deviceId,
      status: "review",
      reasons: decision.reasons,
      checks: decision.checks,
      suspicion: decision.checks.suspicion,
      imageHashes: hashes,
      summary: v.summary || "",
      model: vision.model || null,
    });
    if (store.queue.length > 200) store.queue = store.queue.slice(-200);
  }
  saveStore(store);

  images.forEach((im) => { im.data = null; im.buf = null; });

  console.log("verify", decision.status, "suspicion", decision.checks.suspicion, "model", vision.model || "-", "images", hashes.length, "uid_len", uid.length);

  return json(res, 200, {
    status: decision.status,
    checks: decision.checks,
    reasons: decision.reasons,
    need: decision.need,
    reviewId,
    summary: v.summary || "",
    model: vision.model || null,
    at,
    message:
      decision.status === "pass" ? "Access verified. The signals area is unlocked on this device."
        : decision.status === "need_more" ? decision.need
        : decision.status === "review" ? "This result is being sent to Michael or a coach for a manual review. You will not be charged, and your screenshots are not kept."
        : (decision.reasons[0] || "Access could not be verified."),
  }, origin);
}
