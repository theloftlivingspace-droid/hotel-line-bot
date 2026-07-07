// push-badge.js — Web Push badge updates for the-loft-admin PWA (iOS home-screen icon badge)
//
// Flow: cron polls booking/invoice (GAS) + low-stock (Supabase) counts every 5 min.
// If total changed since last run, sends a Web Push to all subscribed devices.
// The service worker (public/sw.js in the-loft-admin) receives the push and calls
// self.registration.setAppBadge(count).

const webpush = require("web-push");
const fetch = require("node-fetch");

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL  || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || "mailto:admin@theloftlivingspace.com";

const GAS_TODO_URL = "https://script.google.com/macros/s/AKfycbxHuLVbrYnMS2aMEFUppdpKfwfby6Kn4lqD8MDHFwMf7BFIaUlv6NywAzTB-tH-IXs/exec";

const SUPABASE_URL = "https://vshrmwfyanwwocftnccu.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzaHJtd2Z5YW53d29jZnRuY2N1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTgyMTksImV4cCI6MjA5MzUzNDIxOX0.H8zKjDtCnRxzLcV2k-NsSIqJe0k_JkS-_zTtBaHCaGo";

let vapidReady = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidReady = true;
  } catch (e) {
    console.error("[push-badge] Invalid VAPID config, push disabled (bot continues normally):", e.message);
  }
} else {
  console.warn("[push-badge] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push disabled.");
}

// ─── Redis helpers (Upstash REST, same pattern as bot.js) ─────────────────
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
  } catch (e) { console.error("[push-badge] Redis SET error:", e.message); return false; }
}

const SUBS_KEY = "push_subscriptions";
const LAST_COUNT_KEY = "push_badge_last_count";

async function getSubscriptions() {
  return (await redisGet(SUBS_KEY)) || [];
}
async function saveSubscriptions(subs) {
  await redisSet(SUBS_KEY, subs);
}

// ─── Data sources ──────────────────────────────────────────────────────────
async function getBookingInvoiceCounts() {
  try {
    const res = await fetch(`${GAS_TODO_URL}?action=getData`, { redirect: "follow" });
    const j = await res.json();
    const d = j.data ?? j;
    const booking = d.booking ?? d.bookings ?? [];
    const invoice = d.invoice ?? d.ledger ?? [];
    const bookingCount = Array.isArray(booking) ? booking.filter((x) => !x.done).length : 0;
    const invoiceCount = Array.isArray(invoice) ? invoice.filter((x) => !x.done).length : 0;
    return { bookingCount, invoiceCount };
  } catch (e) {
    console.error("[push-badge] booking/invoice fetch error:", e.message);
    return { bookingCount: 0, invoiceCount: 0 };
  }
}

async function getLowStockCount() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.stock_data&select=value`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await res.json();
    const raw = rows?.[0]?.value;
    if (!raw) return 0;
    const stock = JSON.parse(raw);
    if (!Array.isArray(stock)) return 0;
    return stock.filter((r) => r.minQty !== undefined && r.qty < r.minQty).length;
  } catch (e) {
    console.error("[push-badge] stock fetch error:", e.message);
    return 0;
  }
}

async function computeCurrentBadge() {
  const [{ bookingCount, invoiceCount }, lowStockCount] = await Promise.all([
    getBookingInvoiceCounts(),
    getLowStockCount(),
  ]);
  const total = bookingCount + invoiceCount + lowStockCount;
  const parts = [];
  if (bookingCount) parts.push(`${bookingCount} booking`);
  if (invoiceCount) parts.push(`${invoiceCount} invoice`);
  if (lowStockCount) parts.push(`${lowStockCount} stock out`);
  return { total, bookingCount, invoiceCount, lowStockCount, body: parts.length ? parts.join(" · ") : "ไม่มีรายการค้าง" };
}

// ─── Push sending ──────────────────────────────────────────────────────────
async function sendToAll(payload) {
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
          console.error("[push-badge] send error:", err.statusCode, err.message);
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
    console.error("[push-badge] sendToOne error:", err.statusCode, err.message);
    return false;
  }
}

// ─── Main check, called by cron ────────────────────────────────────────────
async function runBadgeCheck() {
  if (!vapidReady) return;
  const { total, body } = await computeCurrentBadge();
  const lastCount = await redisGet(LAST_COUNT_KEY);

  if (lastCount !== null && lastCount === total) return; // no change, skip push

  await redisSet(LAST_COUNT_KEY, total);
  await sendToAll({ count: total, title: "Loft Admin", body });
  console.log(`[push-badge] pushed total=${total} (${body})`);
}

// ─── Express routes ─────────────────────────────────────────────────────────
function registerPushRoutes(app) {
  // the-loft-admin (Vercel) calls these routes cross-origin — allow it.
  app.use("/push", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/push/vapid-public-key", (_req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
  });

  app.post("/push/subscribe", async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ ok: false, error: "invalid subscription" });
    }
    const subs = await getSubscriptions();
    const filtered = subs.filter((s) => s.endpoint !== endpoint);
    const sub = { endpoint, p256dh: keys.p256dh, auth: keys.auth };
    filtered.push(sub);
    await saveSubscriptions(filtered);

    // Immediately sync this device's badge instead of waiting for the next
    // 5-min cron / next count change (fixes: new subscriber missing pushes
    // that happened before it subscribed).
    if (vapidReady) {
      const { total, body } = await computeCurrentBadge();
      await sendToOne(sub, { count: total, title: "Loft Admin", body });
    }
    res.json({ ok: true });
  });

  app.post("/push/unsubscribe", async (req, res) => {
    const { endpoint } = req.body || {};
    const subs = await getSubscriptions();
    await saveSubscriptions(subs.filter((s) => s.endpoint !== endpoint));
    res.json({ ok: true });
  });

  // Manual trigger for testing. ?force=1 bypasses the "no change" skip.
  app.post("/push/badge-check-now", async (req, res) => {
    if (req.query.force === "1") {
      await redisSet(LAST_COUNT_KEY, null);
    }
    await runBadgeCheck();
    res.json({ ok: true });
  });

  // Diagnostics: is VAPID configured, how many devices subscribed, last count sent.
  app.get("/push/status", async (_req, res) => {
    const subs = await getSubscriptions();
    const lastCount = await redisGet(LAST_COUNT_KEY);
    const current = vapidReady ? await computeCurrentBadge() : null;
    res.json({
      vapidReady,
      subscriberCount: subs.length,
      lastCountSent: lastCount,
      currentBadge: current,
    });
  });
}

module.exports = { registerPushRoutes, runBadgeCheck };
