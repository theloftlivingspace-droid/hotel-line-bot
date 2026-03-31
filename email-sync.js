/**
 * Email Sync v5
 * - แก้ parser ดึงชื่อแขกได้ถูกต้อง (ตัด "New Reservation XX" prefix)
 * - resId stable จากชื่อแขกจริง + วันเช็คอิน
 * - column E = channel, F = resId, G = note
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
      range: "email_log!A:F",
    });
    return res.data.values || [];
  } catch (_) { return []; }
}

async function appendEmailLog(sheets, res) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "email_log!A:F",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[res.resId, res.guest, res.roomName, res.checkIn, res.checkOut, res.note]],
    },
  });
}

async function addPendingRow(sheets, res) {
  // A=รอยืนยัน B=ชื่อแขก C=เช็คอิน D=เช็คเอาท์ E=channel F=resId G=note
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:G",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [["รอยืนยัน", res.guest, res.checkIn, res.checkOut, res.channel, res.resId, res.note]],
    },
  });
}

async function updateRoomInSheet(sheets, resId, roomNumber) {
  // ค้นหา resId ใน column F (index 5)
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:F",
  });
  const rows = result.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][5] || "").trim() === resId) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: SHEET_NAME + "!A" + (i + 1),
        valueInputOption: "RAW",
        requestBody: { values: [[roomNumber]] },
      });
      return rows[i][1] || resId; // คืนชื่อแขก
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// Parse อีเมล Little Hotelier
// ─────────────────────────────────────────────
function extractText(email) {
  if (email.text && email.text.trim().length > 20) return email.text;
  if (email.html) {
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

function isoDate(str) {
  const months = {
    january:1, february:2, march:3, april:4, may:5, june:6,
    july:7, august:8, september:9, october:10, november:11, december:12,
  };
  const clean = str.replace(/(\d+)(st|nd|rd|th)/i, "$1").trim();
  const parts = clean.split(/\s+/);
  const day = parseInt(parts[0]);
  const mon = months[(parts[1] || "").toLowerCase()];
  const year = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
  if (!day || !mon) return null;
  return year + "-" + String(mon).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

function parseEmail(email) {
  const body    = extractText(email);
  const subject = email.subject || "";
  if (!body || body.length < 20) return null;

  // ตัด prefix ขยะ เช่น "New Reservation 96 New Reservation " ออกก่อน
  // แล้วค่อย match รูปแบบ "NAME booked the ROOM for DATE to DATE on CHANNEL"
  const cleaned = body.replace(/(?:New\s+Reservation\s+(?:\d+\s+)?)+/gi, " ").replace(/\s+/g, " ").trim();

  const m = cleaned.match(
    /([A-Za-zÀ-ÿ][\w\s,.''-]{1,50}?)\s+booked\s+the\s+(.+?)\s+for\s+(.+?)\s+to\s+(.+?)\s+on\s+([^\n\r]+)/im
  );
  if (!m) {
    console.log("parse ไม่ได้ — cleaned:", cleaned.substring(0, 200));
    return null;
  }

  const checkIn  = isoDate(m[3].trim());
  const checkOut = isoDate(m[4].trim());
  if (!checkIn || !checkOut) {
    console.log("วันที่ผิด:", m[3], m[4]);
    return null;
  }

  // ตัด trailing text ออกจาก channel เช่น "Airbnb We're here to help"
  const channel = m[5].trim()
    .replace(/\s+(We're|For\s+guidance|Click\s+here|\.).*$/i, "")
    .trim();

  // resId: ใช้รหัสจองถ้ามี (ABB-xxx, BDC-xxx), ไม่มีสร้างจากชื่อแขกจริง+เช็คอิน
  const codeMatch = (subject + " " + body).match(/\b[A-Z]{2,4}-[A-Z0-9]{6,}\b/);
  const guestKey  = m[1].trim().toLowerCase().replace(/[^a-z]/g, "").substring(0, 10);
  const resId     = codeMatch
    ? codeMatch[0]
    : ("BK-" + guestKey + "-" + checkIn.replace(/-/g, ""));

  const isAirbnb = /airbnb/i.test(channel) || resId.startsWith("ABB-");

  console.log("parse OK: " + resId + " | " + m[1].trim() + " | " + channel + " | " + checkIn + " -> " + checkOut);

  return {
    resId,
    guest:    m[1].trim(),
    roomName: m[2].trim(),
    checkIn,
    checkOut,
    channel,
    isAirbnb,
    note: isAirbnb ? "" : "มัดจำ 3,000 บาท",
  };
}

// ─────────────────────────────────────────────
// ส่ง LINE
// ─────────────────────────────────────────────
function thaiDate(iso) {
  const M = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const d = new Date(iso + "T00:00:00");
  return d.getDate() + " " + M[d.getMonth()] + " " + (d.getFullYear() + 543);
}

async function sendNewBookingAlert(res) {
  const depositLine = res.isAirbnb ? "" : "\n\u{1F4B0} เก็บมัดจำ 3,000 บาท";
  const sep = "\u2500".repeat(25);
  const msg =
    "\n\u{1F514} จองใหม่! กรุณาระบุเลขห้อง\n" + sep + "\n" +
    "\u{1F464} " + res.guest + "\n" +
    "\u{1F6CF} " + res.roomName + "\n" +
    "\u{1F4C5} " + thaiDate(res.checkIn) + " \u2192 " + thaiDate(res.checkOut) + "\n" +
    "\u{1F4CC} " + res.channel +
    depositLine + "\n" + sep + "\n" +
    "\u{1F447} ตอบกลับแค่ตัวเลข เช่น  203";

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: LINE_GROUP, messages: [{ type: "text", text: msg }] },
    { headers: { Authorization: "Bearer " + LINE_TOKEN, "Content-Type": "application/json" } }
  );
  console.log("แจ้ง LINE: " + res.resId);
}

async function sendConfirmation(resId, roomNumber, guest) {
  const msg = "\u2705 อัปเดตแล้ว!\n" + guest + "\nห้อง " + roomNumber + " (" + resId + ")";
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: LINE_GROUP, messages: [{ type: "text", text: msg }] },
    { headers: { Authorization: "Bearer " + LINE_TOKEN, "Content-Type": "application/json" } }
  );
}

// ─────────────────────────────────────────────
// รับ Reply เลขห้องจาก LINE
// ─────────────────────────────────────────────
async function handleLineReply(messageText) {
  const match = messageText.trim().match(/^(?:ห้อง\s*)?(\d{2,3}\w*)$/);
  if (!match) return;

  const roomNumber = match[1];
  const sheets = getSheets();

  // หาแถวล่าสุดที่ยัง "รอยืนยัน" — resId อยู่ column F (index 5)
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:F",
  });
  const rows = result.data.values || [];
  let resId = "";
  for (let i = rows.length - 1; i >= 1; i--) {
    if ((rows[i][0] || "").trim() === "รอยืนยัน") {
      resId = (rows[i][5] || "").trim();
      break;
    }
  }
  if (!resId) { console.log("ไม่มีการจองที่รอยืนยัน"); return; }

  console.log("reply: ห้อง " + roomNumber + " -> " + resId);
  try {
    const guest = await updateRoomInSheet(sheets, resId, roomNumber);
    if (guest) await sendConfirmation(resId, roomNumber, guest);
    else console.log("ไม่เจอ resId ใน Sheet: " + resId);
  } catch (err) {
    console.error("reply error: " + err.message);
  }
}

// ─────────────────────────────────────────────
// ดึงอีเมลจาก Gmail IMAP
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
            tasks.push(new Promise((res) => {
              msg.on("body", (stream) => {
                simpleParser(stream, (err, parsed) => { if (!err) emails.push(parsed); res(); });
              });
            }));
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
// MAIN SYNC
// ─────────────────────────────────────────────
async function syncEmails() {
  console.log("[" + new Date().toLocaleString("th-TH") + "] ตรวจอีเมลใหม่...");
  try {
    const sheets = getSheets();
    const log    = await getEmailLog(sheets);
    const dataRows = (log.length > 0 && log[0][0] === "resId") ? log.slice(1) : log;
    const notifiedIds = new Set(dataRows.map((r) => r[0]).filter(Boolean));
    console.log("email_log: " + notifiedIds.size + " รายการ");

    const since = new Date();
    since.setDate(since.getDate() - 7);
    const emails = await fetchEmails(since);

    let newCount = 0;
    for (const email of emails) {
      const res = parseEmail(email);
      if (!res) continue;
      if (notifiedIds.has(res.resId)) { console.log("แจ้งไปแล้ว: " + res.resId); continue; }

      await addPendingRow(sheets, res);
      await appendEmailLog(sheets, res);
      await sendNewBookingAlert(res);
      notifiedIds.add(res.resId);
      newCount++;
    }
    console.log("ตรวจเสร็จ (ใหม่ " + newCount + " รายการ)");
  } catch (err) {
    console.error("sync error: " + err.message);
  }
}

// ─────────────────────────────────────────────
// EXPORTS & SCHEDULER
// ─────────────────────────────────────────────
module.exports = { syncEmails, handleLineReply };

console.log("Email Sync พร้อมทำงาน (ทุก 30 นาที)");
cron.schedule("*/30 * * * *", syncEmails, { timezone: "Asia/Bangkok" });
if (process.argv.includes("--sync")) { console.log("sync ทันที..."); syncEmails(); }
