/**
 * 🏨 Hotel Housekeeping LINE Bot
 * ดึงข้อมูลจาก Little Hotelier Dashboard (Web Scraping)
 * ส่งข้อความกลุ่มไลน์แม่บ้านทุกวัน 19:00 น.
 * ใช้ LINE Messaging API (แทน LINE Notify ที่ปิดบริการแล้ว)
 */

require("dotenv").config();
const { chromium } = require("playwright");
const axios = require("axios");
const cron = require("node-cron");
const http = require("http");

const LH_EMAIL         = process.env.LH_EMAIL;
const LH_PASSWORD      = process.env.LH_PASSWORD;
const LINE_CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // จาก LINE Developers
const LINE_GROUP_ID    = process.env.LINE_GROUP_ID;               // จาก get-group-id.js
const CRON_SCHED       = process.env.CRON_SCHEDULE || "0 19 * * *";

// ─────────────────────────────────────────────
// SCRAPER — Login + ดึงข้อมูลจาก Little Hotelier
// ─────────────────────────────────────────────
async function scrapeReservations(targetDate) {
  console.log(`🔍 กำลังดึงข้อมูล Little Hotelier สำหรับวันที่ ${targetDate}...`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    // ── 1. Login ────────────────────────────────
    console.log("🔐 กำลัง Login...");
    await page.goto("https://app.littlehotelier.com/login", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    await page.fill('input[type="email"], input[name="email"]', LH_EMAIL);
    await page.fill('input[type="password"], input[name="password"]', LH_PASSWORD);
    await page.click('button[type="submit"], .login-button, [data-action="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });

    console.log("✅ Login สำเร็จ");

    // ── 2. ไปที่หน้า Reservations / Calendar ───
    const [year, month, day] = targetDate.split("-");

    // ลอง URL calendar ของ Little Hotelier
    await page.goto(
      `https://app.littlehotelier.com/reservations/calendar?date=${targetDate}`,
      { waitUntil: "networkidle", timeout: 30000 }
    );

    // รอข้อมูลโหลด
    await page.waitForTimeout(3000);

    // ── 3. ดึงข้อมูลเช็คอิน/เช็คเอาท์ ──────────
    const reservations = await page.evaluate((date) => {
      const results = { checkIns: [], checkOuts: [] };

      // พยายามหา elements ที่แสดงการจอง
      // Little Hotelier ใช้ class ต่างๆ — ลอง selectors หลายแบบ
      const allReservations = document.querySelectorAll(
        '[class*="reservation"], [class*="booking"], [data-type="reservation"]'
      );

      allReservations.forEach((el) => {
        const text = el.innerText || el.textContent || "";
        const dataArrival = el.getAttribute("data-arrival") || el.getAttribute("data-check-in") || "";
        const dataDeparture = el.getAttribute("data-departure") || el.getAttribute("data-check-out") || "";

        // หาชื่อแขก
        const guestEl = el.querySelector('[class*="guest"], [class*="name"]');
        const guestName = guestEl ? guestEl.innerText.trim() : text.split("\n")[0].trim();

        // หาเลขห้อง
        const roomEl = el.closest('[class*="room"], [class*="unit"]');
        const roomName = roomEl
          ? (roomEl.querySelector('[class*="room-name"], [class*="title"]') || roomEl).innerText.split("\n")[0].trim()
          : "N/A";

        if (dataArrival === date || el.getAttribute("data-date") === date) {
          results.checkIns.push({ room: roomName, guest: guestName });
        }
        if (dataDeparture === date) {
          results.checkOuts.push({ room: roomName, guest: guestName });
        }
      });

      return results;
    }, targetDate);

    // ── 4. ถ้าดึงแบบ DOM ไม่ได้ → ลอง API endpoint ที่ browser เรียก ──
    if (reservations.checkIns.length === 0 && reservations.checkOuts.length === 0) {
      console.log("⚡ ลอง intercept network requests...");
      const apiData = await tryNetworkIntercept(page, targetDate);
      if (apiData) return apiData;
    }

    return reservations;
  } finally {
    await browser.close();
  }
}

// ── วิธีสำรอง: ดักจับ API call ที่ browser ทำ ──
async function tryNetworkIntercept(page, targetDate) {
  return new Promise(async (resolve) => {
    const captured = [];
    let resolved = false;

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("reservation") || url.includes("booking")) {
        try {
          const json = await response.json();
          captured.push(json);
        } catch {}
      }
    });

    // โหลดหน้า reservations list
    await page.goto(
      `https://app.littlehotelier.com/reservations?arrival_date=${targetDate}&departure_date=${targetDate}`,
      { waitUntil: "networkidle", timeout: 20000 }
    );

    await page.waitForTimeout(3000);

    if (captured.length > 0) {
      const flat = captured.flatMap((d) => d.reservations || d.data || d || []);
      resolve(parseApiReservations(flat, targetDate));
    } else {
      resolve(null);
    }
  });
}

function parseApiReservations(data, targetDate) {
  const checkIns = [], checkOuts = [];
  for (const r of data) {
    const arrival   = (r.arrival_date || r.check_in || "").slice(0, 10);
    const departure = (r.departure_date || r.check_out || "").slice(0, 10);
    const room      = r.room?.name || r.room_name || r.unit_name || "N/A";
    const guest     = r.guest
      ? `${r.guest.first_name || ""} ${r.guest.last_name || ""}`.trim()
      : r.guest_name || "ไม่ระบุชื่อ";

    if (arrival === targetDate)   checkIns.push({ room, guest });
    if (departure === targetDate) checkOuts.push({ room, guest });
  }
  return { checkIns, checkOuts };
}

// ─────────────────────────────────────────────
// สร้างข้อความ LINE
// ─────────────────────────────────────────────
function buildMessage(checkIns, checkOuts, targetDate) {
  const displayDate = formatThaiDate(targetDate);
  let msg = `\n🏨 รายการห้องพักวันพรุ่งนี้\n📅 ${displayDate}\n${"─".repeat(26)}\n`;

  if (checkIns.length > 0) {
    msg += `\n✅ เช็คอิน (${checkIns.length} ห้อง)\n`;
    checkIns.forEach(({ room, guest }) => {
      msg += `  🔑 ห้อง ${room}  —  ${guest}\n`;
    });
  } else {
    msg += `\n✅ เช็คอิน : ไม่มี\n`;
  }

  if (checkOuts.length > 0) {
    msg += `\n🚪 เช็คเอาท์ (${checkOuts.length} ห้อง)\n`;
    checkOuts.forEach(({ room, guest }) => {
      msg += `  🧹 ห้อง ${room}  —  ${guest}\n`;
    });
  } else {
    msg += `\n🚪 เช็คเอาท์ : ไม่มี\n`;
  }

  msg += `${"─".repeat(26)}\n💌 ส่งอัตโนมัติโดยระบบโรงแรม`;
  return msg;
}

// ─────────────────────────────────────────────
// ส่งข้อความผ่าน LINE Messaging API (Push Message)
// ─────────────────────────────────────────────
async function sendLine(message) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: LINE_GROUP_ID,
      messages: [{ type: "text", text: message }],
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
  console.log("📱 ส่ง LINE สำเร็จ");
}

// ─────────────────────────────────────────────
// Webhook Server — รับ event จาก LINE (ใช้ครั้งแรกเพื่อดู Group ID)
// ─────────────────────────────────────────────
function startWebhookServer() {
  const PORT = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/webhook") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          for (const event of data.events || []) {
            const src = event.source || {};
            // แสดง Group ID ใน log เมื่อบอทถูกเพิ่มเข้ากลุ่ม หรือมีคนพูดในกลุ่ม
            if (src.groupId) {
              console.log("🎯 พบ LINE_GROUP_ID:", src.groupId);
              console.log("➡️  คัดลอกไปใส่ใน .env: LINE_GROUP_ID=" + src.groupId);
            }
          }
        } catch {}
        res.writeHead(200);
        res.end("OK");
      });
    } else {
      res.writeHead(200);
      res.end("Hotel LINE Bot is running 🏨");
    }
  });
  server.listen(PORT, () => console.log(`🌐 Webhook server listening on port ${PORT}`));
}

// ─────────────────────────────────────────────
// MAIN JOB
// ─────────────────────────────────────────────
async function runJob() {
  console.log(`\n[${new Date().toLocaleString("th-TH")}] 🚀 เริ่มทำงาน...`);
  try {
    const tomorrow = getTomorrow();
    const { checkIns, checkOuts } = await scrapeReservations(tomorrow);
    const msg = buildMessage(checkIns, checkOuts, tomorrow);
    console.log("📋 ข้อความ:\n" + msg);
    await sendLine(msg);
  } catch (err) {
    console.error("❌ Error:", err.message);
    try {
      await sendLine("\n⚠️ ระบบแจ้งเตือนแม่บ้านขัดข้อง\nกรุณาตรวจสอบข้อมูลด้วยตนเอง\n" + err.message);
    } catch {}
  }
}

// ─────────────────────────────────────────────
// SCHEDULER
// ─────────────────────────────────────────────
console.log("🤖 Hotel LINE Bot พร้อมทำงาน");
console.log(`⏰ ส่งข้อความทุกวันตาม schedule: ${CRON_SCHED} (Asia/Bangkok)`);

// เริ่ม Webhook Server (Railway ต้องการ HTTP server)
startWebhookServer();

cron.schedule(CRON_SCHED, runJob, { timezone: "Asia/Bangkok" });

if (process.argv.includes("--test")) {
  console.log("🧪 โหมดทดสอบ...");
  runJob();
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function getTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function formatThaiDate(iso) {
  const months = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
                  "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const days   = ["อาทิตย์","จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์"];
  const d = new Date(iso + "T00:00:00");
  return `วัน${days[d.getDay()]}ที่ ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}
