/**
 * Hotel Housekeeping LINE Bot
 * ดึงข้อมูลจาก Little Hotelier Dashboard (Web Scraping)
 * ส่งข้อความกลุ่มไลน์แม่บ้านทุกวัน 19:00 น.
 */

require("dotenv").config();
const { chromium } = require("playwright");
const axios = require("axios");
const cron = require("node-cron");
const http = require("http");

const LH_EMAIL           = process.env.LH_EMAIL;
const LH_PASSWORD        = process.env.LH_PASSWORD;
const LINE_CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_GROUP_ID      = process.env.LINE_GROUP_ID;
const CRON_SCHED         = process.env.CRON_SCHEDULE || "0 19 * * *";

// ─────────────────────────────────────────────
// SCRAPER
// ─────────────────────────────────────────────
async function scrapeReservations(targetDate) {
  console.log("กำลังดึงข้อมูล Little Hotelier สำหรับวันที่ " + targetDate);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    console.log("กำลัง Login...");
    await page.goto("https://app.littlehotelier.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3000);

    // Debug input fields
    const inputs = await page.$$eval("input", (els) =>
      els.map((e) => "type=" + e.type + " name=" + e.name + " id=" + e.id)
    );
    console.log("Input fields: " + inputs.join(" | "));

    // กรอก email
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="user[email]"]',
      'input[placeholder*="email" i]',
      "input#email",
    ];
    let emailOk = false;
    for (const sel of emailSelectors) {
      try {
        await page.fill(sel, LH_EMAIL, { timeout: 3000 });
        console.log("email selector OK: " + sel);
        emailOk = true;
        break;
      } catch (_) {}
    }
    if (!emailOk) throw new Error("หา email input ไม่เจอ");

    // กด Next / Continue ถ้าเป็น two-step login
    const nextSelectors = [
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("ถัดไป")',
      'input[type="submit"]',
      'button[type="submit"]',
    ];
    for (const sel of nextSelectors) {
      try {
        await page.click(sel, { timeout: 2000 });
        console.log("next/continue selector OK: " + sel);
        await page.waitForTimeout(2000);
        break;
      } catch (_) {}
    }

    // log inputs อีกครั้งหลัง next step
    const inputs2 = await page.$$eval("input", (els) =>
      els.map((e) => "type=" + e.type + " name=" + e.name + " id=" + e.id)
    );
    console.log("Input fields (step2): " + inputs2.join(" | "));

    // กรอก password
    const passSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[name="user[password]"]',
      'input[placeholder*="password" i]',
      "input#password",
    ];
    let passOk = false;
    for (const sel of passSelectors) {
      try {
        await page.fill(sel, LH_PASSWORD, { timeout: 3000 });
        console.log("password selector OK: " + sel);
        passOk = true;
        break;
      } catch (_) {}
    }
    if (!passOk) throw new Error("หา password input ไม่เจอ");

    // กดปุ่ม submit
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      ".login-button",
    ];
    for (const sel of submitSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        console.log("submit selector OK: " + sel);
        break;
      } catch (_) {}
    }

    await page.waitForTimeout(5000);
    const currentUrl = page.url();
    console.log("URL หลัง Login: " + currentUrl);

    if (currentUrl.includes("login")) {
      throw new Error("Login ไม่สำเร็จ กรุณาตรวจสอบ LH_EMAIL / LH_PASSWORD");
    }
    console.log("Login สำเร็จ");

    // เปิดหน้า Calendar
    await page.goto(
      "https://app.littlehotelier.com/reservations/calendar?date=" + targetDate,
      { waitUntil: "networkidle", timeout: 30000 }
    );
    await page.waitForTimeout(3000);

    // ดึงข้อมูลจาก DOM
    const reservations = await page.evaluate(function(date) {
      var results = { checkIns: [], checkOuts: [] };
      var els = document.querySelectorAll('[class*="reservation"], [class*="booking"], [data-type="reservation"]');
      els.forEach(function(el) {
        var text = el.innerText || "";
        var arrival   = el.getAttribute("data-arrival")   || el.getAttribute("data-check-in")  || "";
        var departure = el.getAttribute("data-departure") || el.getAttribute("data-check-out") || "";
        var guestEl   = el.querySelector('[class*="guest"], [class*="name"]');
        var guestName = guestEl ? guestEl.innerText.trim() : text.split("\n")[0].trim();
        var roomEl    = el.closest('[class*="room"], [class*="unit"]');
        var roomName  = "N/A";
        if (roomEl) {
          var rn = roomEl.querySelector('[class*="room-name"], [class*="title"]');
          roomName = (rn || roomEl).innerText.split("\n")[0].trim();
        }
        if (arrival === date)   results.checkIns.push({ room: roomName, guest: guestName });
        if (departure === date) results.checkOuts.push({ room: roomName, guest: guestName });
      });
      return results;
    }, targetDate);

    if (reservations.checkIns.length === 0 && reservations.checkOuts.length === 0) {
      console.log("DOM ว่าง ลอง network intercept...");
      const apiData = await tryNetworkIntercept(page, targetDate);
      if (apiData) return apiData;
    }

    return reservations;
  } finally {
    await browser.close();
  }
}

async function tryNetworkIntercept(page, targetDate) {
  const captured = [];
  page.on("response", async function(response) {
    var url = response.url();
    if (url.includes("reservation") || url.includes("booking")) {
      try { captured.push(await response.json()); } catch (_) {}
    }
  });
  await page.goto(
    "https://app.littlehotelier.com/reservations?arrival_date=" + targetDate + "&departure_date=" + targetDate,
    { waitUntil: "networkidle", timeout: 20000 }
  );
  await page.waitForTimeout(3000);
  if (captured.length > 0) {
    var flat = captured.flatMap(function(d) { return d.reservations || d.data || []; });
    return parseApiReservations(flat, targetDate);
  }
  return null;
}

function parseApiReservations(data, targetDate) {
  var checkIns = [], checkOuts = [];
  data.forEach(function(r) {
    var arrival   = (r.arrival_date   || r.check_in  || "").slice(0, 10);
    var departure = (r.departure_date || r.check_out || "").slice(0, 10);
    var room  = (r.room && r.room.name) || r.room_name || r.unit_name || "N/A";
    var guest = r.guest
      ? ((r.guest.first_name || "") + " " + (r.guest.last_name || "")).trim()
      : (r.guest_name || "ไม่ระบุชื่อ");
    if (arrival   === targetDate) checkIns.push({ room: room, guest: guest });
    if (departure === targetDate) checkOuts.push({ room: room, guest: guest });
  });
  return { checkIns: checkIns, checkOuts: checkOuts };
}

// ─────────────────────────────────────────────
// สร้างข้อความ
// ─────────────────────────────────────────────
function buildMessage(checkIns, checkOuts, targetDate) {
  var sep = "─────────────────────────";
  var msg = "\n รายการห้องพักวันพรุ่งนี้\n วันที่ " + formatThaiDate(targetDate) + "\n" + sep + "\n";

  if (checkIns.length > 0) {
    msg += "\nเช็คอิน (" + checkIns.length + " ห้อง)\n";
    checkIns.forEach(function(item) { msg += "  ห้อง " + item.room + "  -  " + item.guest + "\n"; });
  } else {
    msg += "\nเช็คอิน : ไม่มี\n";
  }
  if (checkOuts.length > 0) {
    msg += "\nเช็คเอาท์ (" + checkOuts.length + " ห้อง)\n";
    checkOuts.forEach(function(item) { msg += "  ห้อง " + item.room + "  -  " + item.guest + "\n"; });
  } else {
    msg += "\nเช็คเอาท์ : ไม่มี\n";
  }
  msg += sep + "\nส่งอัตโนมัติโดยระบบโรงแรม";
  return msg;
}

// ─────────────────────────────────────────────
// ส่ง LINE Messaging API
// ─────────────────────────────────────────────
async function sendLine(message) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: LINE_GROUP_ID, messages: [{ type: "text", text: message }] },
    { headers: { Authorization: "Bearer " + LINE_CHANNEL_TOKEN, "Content-Type": "application/json" } }
  );
  console.log("ส่ง LINE สำเร็จ");
}

// ─────────────────────────────────────────────
// Webhook Server
// ─────────────────────────────────────────────
function startWebhookServer() {
  var PORT = process.env.PORT || 3000;
  http.createServer(function(req, res) {
    if (req.method === "POST" && req.url === "/webhook") {
      var body = "";
      req.on("data", function(chunk) { body += chunk; });
      req.on("end", function() {
        try {
          var data = JSON.parse(body);
          (data.events || []).forEach(function(event) {
            if (event.source && event.source.groupId) {
              console.log("LINE_GROUP_ID: " + event.source.groupId);
            }
          });
        } catch (_) {}
        res.writeHead(200);
        res.end("OK");
      });
    } else {
      res.writeHead(200);
      res.end("Hotel LINE Bot is running");
    }
  }).listen(PORT, function() {
    console.log("Webhook server port " + PORT);
  });
}

// ─────────────────────────────────────────────
// MAIN JOB
// ─────────────────────────────────────────────
async function runJob() {
  console.log("[" + new Date().toLocaleString("th-TH") + "] เริ่มทำงาน...");
  try {
    var tomorrow = getTomorrow();
    var result = await scrapeReservations(tomorrow);
    var msg = buildMessage(result.checkIns, result.checkOuts, tomorrow);
    console.log("ข้อความ:\n" + msg);
    await sendLine(msg);
  } catch (err) {
    console.error("Error: " + err.message);
    try { await sendLine("ระบบแจ้งเตือนแม่บ้านขัดข้อง\n" + err.message); } catch (_) {}
  }
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
console.log("Hotel LINE Bot พร้อมทำงาน");
console.log("Schedule: " + CRON_SCHED + " (Asia/Bangkok)");

startWebhookServer();
cron.schedule(CRON_SCHED, runJob, { timezone: "Asia/Bangkok" });

if (process.argv.includes("--test")) {
  console.log("โหมดทดสอบ...");
  runJob();
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function getTomorrow() {
  var d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function formatThaiDate(iso) {
  var months = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
                "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  var days = ["อาทิตย์","จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์"];
  var d = new Date(iso + "T00:00:00");
  return "วัน" + days[d.getDay()] + "ที่ " + d.getDate() + " " + months[d.getMonth()] + " " + (d.getFullYear() + 543);
}
