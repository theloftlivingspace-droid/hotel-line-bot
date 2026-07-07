// slip-push.js — Web Push notifications for the Billing Console PWA (public/index.html)
//
// Unlike push-badge.js (which polls the-loft-admin counts every 5 min), this is
// event-driven: bot.js calls notifyNewSlip(payment) the moment a tenant uploads
// a payment slip via LINE, and a push fires immediately to every subscribed
// admin device with the Billing Console installed to Home Screen.

const webpush = require("web-push");
const fetch = require("node-fetch");

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL  || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || "mailto:admin@theloftlivingspace.com";

let vapidReady = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidReady = true;
  } catch (e) {
    console.error("[slip-push] Invalid VAPID config, push disabled (bot continues normally):", e.message);
  }
} else {
  console.warn("[slip-push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push disabled.");
}

// ─── Redis helpers (Upstash REST) ──────────────────────────────────────────
async function redisGet(key) {
  if (!REDIS_URL) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch { return null; }
}
async function redisSet(key, value) {
  if (!REDIS_URL) return false;
  try {
    const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json();
    return data.result === "OK";
  } catch (e) { console.error("[slip-push] Redis SET error:", e.message); return false; }
}

const SUBS_KEY = "billing_push_subscriptions";

async function getSubscriptions() {
  return (await redisGet(SUBS_KEY)) || [];
}
async function saveSubscriptions(subs) {
  await redisSet(SUBS_KEY, subs);
}

// ─── Push sending ──────────────────────────────────────────────────────────
async function sendToAll(payload) {
  if (!vapidReady) return;
  const subs = await getSubscriptions();
  if (!subs.length) return;
  const alive = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        );
        alive.push(s);
      } catch (err) {
        if (err.statusCode !== 410 && err.statusCode !== 404) {
          alive.push(s); // keep on transient errors, drop only on Gone/NotFound
          console.error("[slip-push] send error:", err.statusCode, err.message);
        }
      }
    })
  );
  if (alive.length !== subs.length) await saveSubscriptions(alive);
}

async function sendToOne(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (err) {
    console.error("[slip-push] sendToOne error:", err.statusCode, err.message);
    return false;
  }
}

// ─── Called from bot.js the moment a slip is received ──────────────────────
async function notifyNewSlip(payment) {
  if (!vapidReady) return;
  const amount = payment.expectedAmount ? `${Number(payment.expectedAmount).toLocaleString()} บาท` : "";
  const body = [
    `ห้อง ${payment.roomNumber || "-"}`,
    payment.tenantName || null,
    amount || null,
  ].filter(Boolean).join(" · ");

  await sendToAll({
    title: "💰 สลิปใหม่เข้า",
    body,
    tag: `slip-${payment.id}`,
    url: "/", // Billing Console root; tenant will land on Payments tab (already default)
    count: null,
  });
  console.log(`[slip-push] pushed new slip id=${payment.id} room=${payment.roomNumber}`);
}

// ─── Express routes ─────────────────────────────────────────────────────────
function registerSlipPushRoutes(app, adminAuth) {
  app.use("/billing/push", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/billing/push/vapid-public-key", (_req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
  });

  app.post("/billing/push/subscribe", adminAuth, async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ ok: false, error: "invalid subscription" });
    }
    const subs = await getSubscriptions();
    const filtered = subs.filter((s) => s.endpoint !== endpoint);
    const sub = { endpoint, p256dh: keys.p256dh, auth: keys.auth };
    filtered.push(sub);
    await saveSubscriptions(filtered);

    if (vapidReady) {
      await sendToOne(sub, { title: "🔔 เปิดแจ้งเตือนแล้ว", body: "จะแจ้งเตือนทันทีเมื่อมีสลิปใหม่เข้ามา", tag: "billing-push-enabled", url: "/" });
    }
    res.json({ ok: true });
  });

  app.post("/billing/push/unsubscribe", adminAuth, async (req, res) => {
    const { endpoint } = req.body || {};
    const subs = await getSubscriptions();
    await saveSubscriptions(subs.filter((s) => s.endpoint !== endpoint));
    res.json({ ok: true });
  });

  app.get("/billing/push/status", adminAuth, async (_req, res) => {
    const subs = await getSubscriptions();
    res.json({ vapidReady, subscriberCount: subs.length });
  });
}

module.exports = { registerSlipPushRoutes, notifyNewSlip };
