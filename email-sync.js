/**
 * Email Sync — ดึงอีเมล New Reservation จาก Little Hotelier
 * อัปเดต Google Sheet อัตโนมัติทุก 30 นาที
 *
 * อีเมลรูปแบบ:
 * "[Guest Name] booked the [Room Name] for [Date] to [Date] on [Channel]"
 */

require("dotenv").config();
const Imap             = require("imap");
const { simpleParser } = require("mailparser");
const { google }       = require("googleapis");
const cron             = require("node-cron");

const GMAIL_USER  = process.env.GMAIL_USER;
const GMAIL_PASS  = process.env.GMAIL_APP_PASSWORD;
const SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME  = process.env.GOOGLE_SHEET_NAME || "Sheet1";

// ── ตารางแปลงชื่อห้อง → เลขห้อง ──────────────
// แก้ให้ตรงกับโรงแรมของคุณ
const ROOM_MAP = {
  "the loft elegance living space": "101",
  "103 elegance": "103 Elegance",
  "108 retro":    "108 Retro",
  "113 legacy":   "113 Legacy",
  "203 allure":   "203 Allure",
  "204 elegance": "204 Elegance",
  "205 allure":   "205 Allure",
  "214 legacy":   "214 Legacy",
  "300 luxury":   "300 Luxury",
};

function getRoomNumber(name) {
  if (!name) return name;
  const lower = name.toLowerCase().trim();
  if (ROOM_MAP[lower]) return ROOM_MAP[lower];
  for (const [k, v] of Object.entries(ROOM_MAP)) {
    if (lower.includes(k) || k.includes(lower)) return v;
  }
  return name; // ถ้าไม่เจอ ใช้ชื่อเดิม
}

// ─────────────────────────────────────────────
// Google Sheets API
// ─────────────────────────────────────────────
function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getExistingReservations(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:E",
  });
  return res.data.values || [];
}

async function appendRow(sheets, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:F",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

// ─────────────────────────────────────────────
// Parse อีเมล Little Hotelier
// ─────────────────────────────────────────────
function parseEmail(email) {
  const subject = email.subject || "";
  const text    = email.text   || "";

  // ดึง Reservation Number จาก subject หรือ body
  const resMatch = (subject + " " + text).match(/[A-Z]{2,4}-[A-Z0-9]{8,}/);
  const resNo    = resMatch ? resMatch[0] : ("EMAIL-" + Date.now());

  // รูปแบบ: "Name booked the Room for 11th March to 14th March on Channel"
  const pattern = /(.+?)\s+booked\s+the\s+(.+?)\s+for\s+(.+?)\s+to\s+(.+?)\s+on\s+(.+?)[\.\n\r]/i;
  const m = text.match(pattern);
  if (!m) {
    console.log("parse ไม่ได้: " + subject);
    return null;
  }

  const guest    = m[1].trim();
  const roomName = m[2].trim();
  const checkIn  = parseEmailDate(m[3].trim());
  const checkOut = parseEmailDate(m[4].trim());
  const channel  = resNo; // ใช้ reservation number เป็น channel identifier

  if (!checkIn || !checkOut) {
    console.log("parse วันที่ไม่ได้: " + m[3] + " / " + m[4]);
    return null;
  }

  const room = getRoomNumber(roomName);
  const note = channel.startsWith("ABB-") ? "" : "มัดจำ 3,000 บาท";

  return { resNo, room, guest, checkIn, checkOut, channel, note };
}

function parseEmailDate(str) {
  const months = {
    january:1, february:2, march:3, april:4, may:5, june:6,
    july:7, august:8, september:9, october:10, november:11, december:12
  };
  const clean = str.replace(/(\d+)(st|nd|rd|th)/i, "$1").trim();
  const parts = clean.split(/\s+/);
  const day   = parseInt(parts[0]);
  const mon   = months[(parts[1] || "").toLowerCase()];
  const year  = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
  if (!day || !mon) return null;
  return year + "-" + String(mon).padStart(2,"0") + "-" + String(day).padStart(2,"0");
}

// ─────────────────────────────────────────────
// ดึงอีเมลใหม่จาก Gmail
// ─────────────────────────────────────────────
function fetchNewEmails(sinceDate) {
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
          ["SINCE", sinceDate],
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

          fetch.once("end", async () => {
            await Promise.all(tasks);
            imap.end();
            resolve(emails);
          });
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
  console.log("[" + new Date().toLocaleString("th-TH") + "] เริ่ม sync อีเมล...");

  try {
    const sheets = getSheets();

    // ดึงข้อมูลที่มีอยู่แล้วใน Sheet
    const existing = await getExistingReservations(sheets);
    const existingChannels = new Set(
      existing.slice(1).map((r) => (r[4] || "").trim())
    );
    console.log("ข้อมูลใน Sheet: " + (existing.length - 1) + " แถว");

    // ดึงอีเมลย้อนหลัง 7 วัน (ครอบคลุม email ที่อาจพลาด)
    const since = new Date();
    since.setDate(since.getDate() - 7);

    const emails = await fetchNewEmails(since);
    let added = 0;

    for (const email of emails) {
      const res = parseEmail(email);
      if (!res) continue;

      // ข้ามถ้ามีอยู่แล้ว (เช็คจาก Reservation Number)
      if (existingChannels.has(res.resNo)) {
        console.log("มีอยู่แล้ว: " + res.resNo);
        continue;
      }

      // เพิ่มแถวใหม่
      const row = [res.room, res.guest, res.checkIn, res.checkOut, res.resNo, res.note];
      await appendRow(sheets, row);
      existingChannels.add(res.resNo);
      added++;

      console.log("เพิ่มใหม่: " + res.room + " - " + res.guest + " (" + res.checkIn + " → " + res.checkOut + ")" + (res.note ? " [" + res.note + "]" : ""));
    }

    console.log("sync เสร็จ: เพิ่ม " + added + " แถว");

  } catch (err) {
    console.error("sync error: " + err.message);
  }
}

// ─────────────────────────────────────────────
// SCHEDULER — ทุก 30 นาที
// ─────────────────────────────────────────────
console.log("Email Sync พร้อมทำงาน (ทุก 30 นาที)");
cron.schedule("*/30 * * * *", syncEmails, { timezone: "Asia/Bangkok" });

if (process.argv.includes("--sync")) {
  console.log("sync ทันที...");
  syncEmails();
}
