/**
 * Hotel Housekeeping LINE Bot v5
 * ดึงข้อมูลจาก Google Sheets → ส่งสรุปวันพรุ่งนี้ไปกลุ่มไลน์แม่บ้าน
 * ทุกวัน 19:00 น.
 *
 * โครงสร้าง Google Sheet (row 1 = header):
 * A: เลขห้อง | B: ชื่อแขก | C: วันเช็คอิน (YYYY-MM-DD) | D: วันเช็คเอาท์ (YYYY-MM-DD) | E: ช่องทาง
 */

require("dotenv").config();
const { google } = require("googleapis");
const axios      = require("axios");
const cron       = require("node-cron");
const http       = require("http");

const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || "Sheet1";
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_GROUP = process.env.LINE_GROUP_ID;
const CRON_SCHED = process.env.CRON_SCHEDULE || "0 19 * * *";

// ─────────────────────────────────────────────
// Google Sheets — ดึงข้อมูล
// ─────────────────────────────────────────────
async function fetchSheetData() {
  // ใช้ Service Account credentials จาก environment variable
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:E",
  });

  const rows = res.data.values || [];
  console.log("ดึงข้อมูลจาก Google Sheets: " + (rows.length - 1) + " แถว");
  return rows;
}

// ─────────────────────────────────────────────
// แยก check-in / check-out ของวันพรุ่งนี้
// ─────────────────────────────────────────────
function filterByDate(rows, targetDate) {
  const checkIns  = [];
  const checkOuts = [];

  // ข้าม header row (row แรก)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 4) continue;

    const room      = (row[0] || "").trim();
    const guest     = (row[1] || "").trim();
    const checkIn   = normalizeDate(row[2] || "");
    const checkOut  = normalizeDate(row[3] || "");

    if (!room || !guest) continue;

    if (checkIn === targetDate) {
      checkIns.push({ room, guest });
      console.log("เช็คอิน: ห้อง " + room + " - " + guest);
    }
    if (checkOut === targetDate) {
      checkOuts.push({ room, guest });
      console.log("เช็คเอาท์: ห้อง " + room + " - " + guest);
    }
  }

  return { checkIns, checkOuts };
}

// แปลงวันที่หลายรูปแบบ → YYYY-MM-DD
function normalizeDate(str) {
  if (!str) return "";
  str = str.trim();

  // YYYY-MM-DD แล้ว
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // DD/MM/YYYY หรือ DD-MM-YYYY
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    return dmy[3] + "-" + dmy[2].padStart(2,"0") + "-" + dmy[1].padStart(2,"0");
  }

  // MM/DD/YYYY
  const mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return mdy[3] + "-" + mdy[1].padStart(2,"0") + "-" + mdy[2].padStart(2,"0");
  }

  // Google Sheets serial number (เช่น 46123)
  if (/^\d{5}$/.test(str)) {
    const d = new Date(Date.UTC(1899, 11, 30) + parseInt(str) * 86400000);
    return d.toISOString().slice(0, 10);
  }

  return str;
}

// ─────────────────────────────────────────────
// สร้างข้อความ LINE
// ─────────────────────────────────────────────
function buildMessage(checkIns, checkOuts, targetDate) {
  const sep = "─────────────────────────";
  let msg = "\n🏨 รายการห้องพักวันพรุ่งนี้\n📅 " + formatThaiDate(targetDate) + "\n" + sep + "\n";

  if (checkIns.length > 0) {
    msg += "\n✅ เช็คอิน (" + checkIns.length + " ห้อง)\n";
    checkIns.forEach((r) => { msg += "  🔑 ห้อง " + r.room + "  —  " + r.guest + "\n"; });
  } else {
    msg += "\n✅ เช็คอิน : ไม่มี\n";
  }

  if (checkOuts.length > 0) {
    msg += "\n🚪 เช็คเอาท์ (" + checkOuts.length + " ห้อง)\n";
    checkOuts.forEach((r) => { msg += "  🧹 ห้อง " + r.room + "  —  " + r.guest + "\n"; });
  } else {
    msg += "\n🚪 เช็คเอาท์ : ไม่มี\n";
  }

  msg += sep + "\n💌 ส่งอัตโนมัติโดยระบบโรงแรม";
  return msg;
}

// ─────────────────────────────────────────────
// ส่ง LINE
// ─────────────────────────────────────────────
async function sendLine(message) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: LINE_GROUP, messages: [{ type: "text", text: message }] },
    { headers: { Authorization: "Bearer " + LINE_TOKEN, "Content-Type": "application/json" } }
  );
  console.log("ส่ง LINE สำเร็จ");
}

// ─────────────────────────────────────────────
// MAIN JOB
// ─────────────────────────────────────────────
async function runJob() {
  console.log("[" + new Date().toLocaleString("th-TH") + "] เริ่มทำงาน...");
  try {
    const tomorrow = getTomorrow();
    console.log("วันเป้าหมาย: " + tomorrow);
    const rows = await fetchSheetData();
    const { checkIns, checkOuts } = filterByDate(rows, tomorrow);
    const msg = buildMessage(checkIns, checkOuts, tomorrow);
    console.log("ข้อความ:\n" + msg);
    await sendLine(msg);
  } catch (err) {
    console.error("Error: " + err.message);
    try { await sendLine("⚠️ ระบบแจ้งเตือนแม่บ้านขัดข้อง\n" + err.message); } catch (_) {}
  }
}

// ─────────────────────────────────────────────
// Webhook + Scheduler
// ─────────────────────────────────────────────
function startWebhookServer() {
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/webhook") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          (data.events || []).forEach((e) => {
            if (e.source && e.source.groupId) console.log("LINE_GROUP_ID: " + e.source.groupId);
          });
        } catch (_) {}
        res.writeHead(200); res.end("OK");
      });
    } else { res.writeHead(200); res.end("Hotel LINE Bot running"); }
  }).listen(PORT, () => console.log("Webhook port " + PORT));
}

console.log("Hotel LINE Bot v5 (Google Sheets) พร้อมทำงาน");
startWebhookServer();
cron.schedule(CRON_SCHED, runJob, { timezone: "Asia/Bangkok" });
if (process.argv.includes("--test")) { console.log("โหมดทดสอบ..."); runJob(); }

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function getTomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
function formatThaiDate(iso) {
  const M = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
             "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const D = ["อาทิตย์","จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์"];
  const d = new Date(iso + "T00:00:00");
  return "วัน" + D[d.getDay()] + "ที่ " + d.getDate() + " " + M[d.getMonth()] + " " + (d.getFullYear() + 543);
}
