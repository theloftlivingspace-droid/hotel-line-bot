/**
 * Email Sync v3
 * - รองรับทั้ง text และ HTML email
 * - เพิ่ม debug log เพื่อวินิจฉัยปัญหา
 */

require("dotenv").config();
const Imap             = require("imap");
const { simpleParser } = require("mailparser");
const { google }       = require("googleapis");
const axios            = require("axios");
const cron             = require("node-cron");

const GMAIL_USER  = process.env.GMAIL_USER;
const GMAIL_PASS  = process.env.GMAIL_APP_PASSWORD;
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_GROUP  = process.env.LINE_GROUP_ID;
const SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME  = process.env.GOOGLE_SHEET_NAME || "Sheet1";

// ─────────────────────────────────────────────
// Google Sheets
// ─────────────────────────────────────────────
function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getEmailLog(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "email_log!A:D",
    });
    return res.data.values || [];
  } catch (_) { return []; }
}

async function appendEmailLog(sheets, resId, guest, roomName, checkIn, checkOut, isAirbnb) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "email_log!A:F",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[resId, guest, roomName, checkIn, checkOut, isAirbnb ? "" : "มัดจำ 3,000 บาท"]] },
  });
}

async function updateRoomInSheet(sheets, resId, roomNumber) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:E",
  });
  const rows = res.data.values || [];

  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][4] || "").trim() === resId) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: SHEET_NAME + "!A" + (i + 1),
        valueInputOption: "RAW",
        requestBody: { values: [[roomNumber]] },
      });
      return true;
    }
  }
  return false;
}

async function addPendingRow(sheets, res) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:F",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        "รอยืนยัน",
        res.guest,
        res.checkIn,
        res.checkOut,
        res.resId,
        res.note,
      ]],
    },
  });
}

// ─────────────────────────────────────────────
// Parse อีเมล — รองรับ text และ HTML
// ─────────────────────────────────────────────
function extractTextFromEmail(email) {
  // ลอง text ก่อน ถ้าไม่มีค่อยดึงจาก HTML
  if (email.text && email.text.trim().length > 10) {
    return email.text;
  }
  if (email.html) {
    // ลบ HTML tags ออก
    return email.html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

function parseEmail(email) {
  const rawText = extractTextFromEmail(email);

  // DEBUG: แสดง 300 ตัวอักษรแรกของ email content
  console.log("DEBUG email content:", rawText.substring(0, 300));
  console.log("DEBUG subject:", email.subject || "(no subject)");

  if (!rawText || rawText.length < 10) {
    console.log("DEBUG: email body ว่างเปล่า");
    return null;
  }

  const resMatch = rawText.match(/[A-Z]{2,4}-[A-Z0-9]{8,}/);
  const resId    = resMatch ? resMatch[0] : ("NOID-" + Date.now());
  console.log("DEBUG resId:", resId);

  const pattern = /(.+?)\s+booked\s+the\s+(.+?)\s+for\s+(.+?)\s+to\s+(.+?)\s+on\s+([^\n\r.]+)/im;
  const m       = rawText.match(pattern);

  if (!m) {
    console.log("DEBUG: pattern ไม่ match — raw text ช่วงสำคัญ:", rawText.substring(0, 500));
    return null;
  }

  console.log("DEBUG match:", m[1], "|", m[2], "|", m[3], "|", m[4], "|", m[5]);

  const checkIn  = isoDate(m[3].trim());
  const checkOut = isoDate(m[4].trim());
  if (!checkIn || !checkOut) {
    console.log("DEBUG: แปลงวันที่ไม่ได้ —", m[3], "→", checkIn, "|", m[4], "→", checkOut);
    return null;
  }

  const isAirbnb = resId.startsWith("ABB-");
  return {
    resId,
    guest:    m[1].trim(),
    roomName: m[2].trim(),
    checkIn,
    checkOut,
    channel:  m[5].trim(),
    isAirbnb,
    note:     isAirbnb ? "" : "มัดจำ 3,000 บาท",
  };
}

function isoDate(str) {
  const months = {
    january:1,february:2,march:3,april:4,may:5,june:6,
    july:7,august:8,september:9,october:10,november:11,december:12
  };
  const clean = str.replace(/(\d+)(st|nd|rd|th)/i,"$1").trim();
  const parts = clean.split(/\s+/);
  const day   = parseInt(parts[0]);
  const mon   = months[(parts[1]||"").toLowerCase()];
  const year  = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
  if (!day || !mon) return null;
  return year+"-"+String(mon).padStart(2,"0")+"-"+String(day).padStart(2,"0");
}

function thaiDate(iso) {
  const M=["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const d = new Date(iso+"T00:00:00");
  return d.getDate()+" "+M[d.getMonth()]+" "+(d.getFullYear()+543);
}

// ─────────────────────────────────────────────
// ส่ง LINE
// ─────────────────────────────────────────────
async function sendNewBookingAlert(res) {
  const depositLine = res.isAirbnb ? "" : "\n💰 เก็บมัดจำ 3,000 บาท";
  const msg =
    "\n🔔 จองใหม่! กรุณาระบุเลขห้อง\n" +
    "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n" +
    "👤 " + res.guest + "\n" +
    "🛏 " + res.roomName + "\n" +
    "📅 " + thaiDate(res.checkIn) + " → " + thaiDate(res.checkOut) + "\n" +
    "📌 " + res.resId +
    depositLine + "\n" +
    "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n" +
    "👇 ตอบกลับแค่ตัวเลข เช่น  203";

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: LINE_GROUP, messages: [{ type: "text", text: msg }] },
    { headers: { Authorization: "Bearer " + LINE_TOKEN, "Content-Type": "application/json" } }
  );
  console.log("แจ้ง LINE: " + res.resId);
}

async function sendConfirmation(resId, roomNumber, guest) {
  const msg = "✅ อัปเดตแล้ว!\n" + guest + "\nห้อง " + roomNumber + " (" + resId + ")";
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: LINE_GROUP, messages: [{ type: "text", text: msg }] },
    { headers: { Authorization: "Bearer " + LINE_TOKEN, "Content-Type": "application/json" } }
  );
}

// ─────────────────────────────────────────────
// รับ Reply จาก LINE webhook
// ─────────────────────────────────────────────
async function handleLineReply(messageText) {
  const match = messageText.trim().match(/^(?:ห้อง\s*)?(\d{2,3}\w*)$/);
  if (!match) return;

  const roomNumber = match[1];
  const sheets = getSheets();
  const res2 = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:E",
  });
  const rows = res2.data.values || [];

  let pendingRowIndex = -1;
  let resId = "";
  for (let i = rows.length - 1; i >= 1; i--) {
    if ((rows[i][0] || "").trim() === "รอยืนยัน") {
      pendingRowIndex = i;
      resId = (rows[i][4] || "").trim();
      break;
    }
  }

  if (pendingRowIndex === -1) {
    console.log("ไม่มีการจองที่รอยืนยัน");
    return;
  }

  console.log("ได้รับ reply: ห้อง " + roomNumber + " → " + resId);

  try {
    const updated = await updateRoomInSheet(sheets, resId, roomNumber);
    if (updated) {
      const log = await getEmailLog(sheets);
      const logRow = log.find((r) => r[0] === resId);
      const guest = logRow ? logRow[1] : resId;
      await sendConfirmation(resId, roomNumber, guest);
      console.log("อัปเดต Sheet สำเร็จ: ห้อง " + roomNumber);
    }
  } catch (err) {
    console.error("อัปเดต error: " + err.message);
  }
}

// ─────────────────────────────────────────────
// ดึงอีเมลจาก Gmail
// ─────────────────────────────────────────────
function fetchEmails(since) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: GMAIL_USER, password: GMAIL_PASS,
      host: "imap.gmail.com", port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });
    const emails = [];
    imap.once("ready", () => {
      imap.openBox("INBOX", true, (err) => {
        if (err) return reject(err);
        imap.search([
          ["SINCE", since],
          ["FROM", "no-reply@app.littlehotelier.com"],
          ["SUBJECT", "New Reservation"],
        ], (err, uids) => {
          if (err || !uids || uids.length === 0) {
            console.log("ไม่พบอีเมลใหม่");
            imap.end();
            return resolve([]);
          }
          console.log("พบอีเมล: " + uids.length + " ฉบับ");
          const fetch = imap.fetch(uids, { bodies: "" });
          const tasks = [];
          fetch.on("message", (msg) => {
            const p = new Promise((res) => {
              msg.on("body", (stream) => {
                simpleParser(stream, (err, parsed) => {
                  if (!err) emails.push(parsed);
                  res();
                });
              });
            });
            tasks.push(p);
          });
          fetch.once("end", async () => { await Promise.all(tasks); imap.end(); resolve(emails); });
          fetch.once("error", (e) => { imap.end(); reject(e); });
        });
      });
    });
    imap.once("error", reject);
    imap.connect();
  });
}

// ─────────────────────────────────────────────
// MAIN SYNC JOB
// ─────────────────────────────────────────────
async function syncEmails() {
  console.log("[" + new Date().toLocaleString("th-TH") + "] ตรวจอีเมลใหม่...");
  try {
    const sheets = getSheets();
    const log    = await getEmailLog(sheets);
    const notifiedIds = new Set(log.map((r) => r[0]));
    console.log("email_log มี " + notifiedIds.size + " รายการ");

    const since = new Date();
    since.setDate(since.getDate() - 3);
    const emails = await fetchEmails(since);
    console.log("parse อีเมลทั้งหมด " + emails.length + " ฉบับ");

    for (const email of emails) {
      const res = parseEmail(email);
      if (!res) {
        console.log("parse ไม่ได้ — ข้ามไป");
        continue;
      }
      if (notifiedIds.has(res.resId)) {
        console.log("แจ้งไปแล้ว: " + res.resId);
        continue;
      }

      await addPendingRow(sheets, res);
      await appendEmailLog(sheets, res.resId, res.guest, res.roomName, res.checkIn, res.checkOut, res.isAirbnb);
      await sendNewBookingAlert(res);
    }
    console.log("ตรวจเสร็จ");
  } catch (err) {
    console.error("sync error: " + err.message);
  }
}

module.exports = { syncEmails, handleLineReply };

console.log("Email Sync พร้อมทำงาน (ทุก 30 นาที)");
cron.schedule("*/30 * * * *", syncEmails, { timezone: "Asia/Bangkok" });
if (process.argv.includes("--sync")) { console.log("sync ทันที..."); syncEmails(); }
