/**
 * Email Sync v6
 * - แจ้งจองใหม่ → ไลน์ส่วนตัวแอดมิน
 * - แอดมินยืนยันเลขห้อง → อัปเดต Sheet
 * - ถ้าเช็คอินวันนี้ + หลัง 19:00 → แจ้งกลุ่มแม่บ้านทันที
 * - ถ้าเช็คอินพรุ่งนี้/วันอื่น → รอ 19:00 ตามปกติ
 */

require("dotenv").config();
const Imap             = require("imap");
const { simpleParser } = require("mailparser");
const { google }       = require("googleapis");
const axios            = require("axios");
const cron             = require("node-cron");

const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;
const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_GROUP   = process.env.LINE_GROUP_ID;
const ADMIN_ID     = process.env.ADMIN_USER_ID; // ไลน์ส่วนตัวแอดมิน
const SHEET_ID     = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME   = process.env.GOOGLE_SHEET_NAME || "Sheet1";

// ─────────────────────────────────────────────
// Room type map
// ─────────────────────────────────────────────
const ROOM_TYPE_MAP = {
  "103": "Elegance",
  "108": "Retro",
  "113": "Legacy",
  "203": "Allure",
  "204": "Elegance",
  "205": "Allure",
  "214": "Legacy",
  "300": "Luxury",
};
function getRoomLabel(num) {
  const type = ROOM_TYPE_MAP[String(num).trim()];
  return type ? num + " " + type : num;
}
function getRoomTypeFromName(roomName) {
  const types = [...new Set(Object.values(ROOM_TYPE_MAP))];
  const n = roomName.toLowerCase();
  const matched = types.find(t => n.includes(t.toLowerCase()));
  return matched || null;
}
function getRoomsOfType(typeName) {
  if (!typeName) return [];
  return Object.entries(ROOM_TYPE_MAP)
    .filter(([, t]) => t === typeName)
    .map(([num]) => num);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function todayBKK() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }))
    .toISOString().slice(0, 10);
}
function tomorrowBKK() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
function hourBKK() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" })).getHours();
}
function thaiDate(iso) {
  const M = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const d = new Date(iso + "T00:00:00");
  return d.getDate() + " " + M[d.getMonth()] + " " + (d.getFullYear() + 543);
}

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

// ─────────────────────────────────────────────
// ตรวจห้องว่างตามช่วงวันที่
// ─────────────────────────────────────────────
// คืน subset ของ candidateRooms ที่ไม่มีการจองทับซ้อนกับ [newCheckIn, newCheckOut)
async function getAvailableRooms(sheets, candidateRooms, newCheckIn, newCheckOut) {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:G",
  });
  const rows = result.data.values || [];

  const occupiedRooms = new Set();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 4) continue;

    const roomCol  = (row[0] || "").trim();
    // ข้ามแถวที่รอยืนยัน/ยกเลิก/ว่าง
    if (!roomCol || roomCol === "รอยืนยัน" || roomCol === "ยกเลิก") continue;

    // roomCol อาจเป็น "103 Elegance" → ดึงเฉพาะตัวเลขหน้า
    const roomNum = roomCol.split(/\s+/)[0];
    if (!candidateRooms.includes(roomNum)) continue;

    const existIn  = normalizeDate(row[2] || "");
    const existOut = normalizeDate(row[3] || "");
    if (!existIn || !existOut) continue;

    // overlap: existIn < newCheckOut  AND  existOut > newCheckIn
    if (existIn < newCheckOut && existOut > newCheckIn) {
      occupiedRooms.add(roomNum);
      console.log(`  ห้อง ${roomNum} ถูกจองอยู่ (${existIn}→${existOut}) ทับ (${newCheckIn}→${newCheckOut})`);
    }
  }

  const available = candidateRooms.filter(r => !occupiedRooms.has(r));
  console.log(`getAvailableRooms [${candidateRooms.join(",")}] ${newCheckIn}→${newCheckOut}: ว่าง=[${available.join(",")}]`);
  return available;
}

async function updateRoomInSheet(sheets, resId, roomNumber) {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:G",
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
      return { guest: rows[i][1], checkIn: rows[i][2], note: rows[i][6] || "" };
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// ส่ง LINE
// ─────────────────────────────────────────────
async function linePush(to, text) {
  try {
    const res = await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to, messages: [{ type: "text", text }] },
      { headers: { Authorization: "Bearer " + LINE_TOKEN, "Content-Type": "application/json" } }
    );
    console.log("[linePush] OK to=" + to.slice(0,10) + "... status=" + res.status);
  } catch (e) {
    const body = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error("[linePush] FAIL to=" + to + " error=" + body);
  }
}

async function sendNewBookingToAdmin(res, roomLabel, status = null) {
  // roomLabel: ห้องที่ auto-assign แล้ว  |  status: "conflict" = ไม่มีห้องว่าง
  const depositLine = res.isAirbnb ? "" : "\n\u{1F4B0} เก็บมัดจำ 3,000 บาท";
  const sep = "\u2500".repeat(25);
  const roomType = getRoomTypeFromName(res.roomName || "");
  const matchedRooms = getRoomsOfType(roomType);

  let roomLine, hintLine;
  if (roomLabel) {
    roomLine = "\u{1F511} " + roomLabel + " (กำหนดอัตโนมัติ)";
    hintLine = "\u{2139}\uFE0F แจ้งเพื่อทราบ ไม่ต้องตอบกลับ";
  } else if (status === "conflict") {
    roomLine = "\u26A0\uFE0F " + (roomType || "(ไม่ทราบ type)") + " \u2014 ไม่มีห้องว่างช่วงนี้!";
    hintLine = "\u{1F447} กรุณาตรวจสอบและระบุห้อง: " + matchedRooms.join(", ");
  } else if (matchedRooms.length > 1) {
    roomLine = "\u{1F6CF} " + (roomType || "(รอระบุห้อง)");
    hintLine = "\u{1F447} ตอบกลับห้องไหน: " + matchedRooms.join(" หรือ ");
  } else {
    roomLine = "\u{1F6CF} (รอระบุห้อง)";
    hintLine = "\u{1F447} ตอบกลับแค่ตัวเลข เช่น  204";
  }

  const msg =
    "\n\u{1F514} จองใหม่!\n" + sep + "\n" +
    "\u{1F464} " + res.guest + "\n" +
    roomLine + "\n" +
    "\u{1F4C5} " + thaiDate(res.checkIn) + " \u2192 " + thaiDate(res.checkOut) + "\n" +
    "\u{1F4CC} " + res.channel +
    depositLine + "\n" + sep + "\n" +
    hintLine;
  await linePush(ADMIN_ID, msg);
  console.log("แจ้ง admin: " + res.resId + (roomLabel ? " [auto=" + roomLabel + "]" : status === "conflict" ? " [CONFLICT]" : ""));
}

async function sendConfirmToAdmin(resId, roomNumber, guest) {
  await linePush(ADMIN_ID, "\u2705 อัปเดตแล้ว!\n" + guest + "\nห้อง " + roomNumber + " (" + resId + ")");
}

async function sendUrgentToGroup(roomNumber, guest, checkIn, note) {
  const depositLine = note ? "\n\u{1F4B0} " + note : "";
  const sep = "\u2500".repeat(25);
  const dayLabel = checkIn === todayBKK() ? "เช็คอินวันนี้" : "เช็คอินพรุ่งนี้";
  const msg =
    "\n\u{1F6A8} จองใหม่! " + dayLabel + "\n" + sep + "\n" +
    "\u{1F511} ห้อง " + roomNumber + "  \u2014  " + guest + "\n" +
    "\u{1F4C5} เช็คอิน " + thaiDate(checkIn) +
    depositLine + "\n" + sep;
  await linePush(LINE_GROUP, msg);
  console.log("แจ้งกลุ่มแม่บ้าน (urgent): ห้อง " + roomNumber);
}

// ─────────────────────────────────────────────
// Parse อีเมล
// ─────────────────────────────────────────────
function extractText(email) {
  if (email.text && email.text.trim().length > 20) return email.text;
  if (email.html) {
    return email.html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ").trim();
  }
  return "";
}

function isoDate(str) {
  const months = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
  const clean = str.replace(/(\d+)(st|nd|rd|th)/i, "$1").trim();
  const parts = clean.split(/\s+/);
  const day = parseInt(parts[0]), mon = months[(parts[1]||"").toLowerCase()];
  const year = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
  if (!day || !mon) return null;
  return year + "-" + String(mon).padStart(2,"0") + "-" + String(day).padStart(2,"0");
}

// แปลงวันที่ใน Sheet → ISO (รองรับทั้ง YYYY-MM-DD และ DD/MM/YYYY)
function normalizeDate(str) {
  if (!str) return "";
  str = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return dmy[3] + "-" + dmy[2].padStart(2,"0") + "-" + dmy[1].padStart(2,"0");
  return str;
}

function parseEmail(email) {
  const body = extractText(email);
  const subject = email.subject || "";
  if (!body || body.length < 20) return null;

  const cleaned = body.replace(/(?:New\s+Reservation\s+(?:\d+\s+)?)+/gi, " ").replace(/\s+/g, " ").trim();
  const m = cleaned.match(
    /([\p{L}\u4e00-\u9fff][\p{L}\u4e00-\u9fff\w\s,.''-]{1,50}?)\s+booked\s+the\s+(.+?)\s+for\s+(.+?)\s+to\s+(.+?)\s+on\s+([^\n\r]+)/imu
  );
  if (!m) {
    console.log("parse FAIL (no match): subject=" + subject.substring(0, 80));
    console.log("parse FAIL body(200):", cleaned.substring(0, 200));
    return null;
  }

  const checkIn  = isoDate(m[3].trim());
  const checkOut = isoDate(m[4].trim());
  if (!checkIn || !checkOut) {
    console.log("parse FAIL (date): in=" + m[3].trim() + " out=" + m[4].trim());
    return null;
  }

  const channel = m[5].trim().replace(/\s+(We're|For\s+guidance|Click\s+here|\.).*$/i, "").trim()
    .replace(/Trip\.com.*$/i, "Trip").replace(/Booking\.com.*$/i, "Booking");
  const codeMatch = (subject + " " + body).match(/\b[A-Z]{2,4}-[A-Z0-9]{6,}\b/);
  const guestKey  = m[1].trim().toLowerCase().replace(/[^a-z]/g, "") .substring(0, 10) || Buffer.from(m[1].trim()).toString("hex").substring(0, 10);
  const isAirbnb  = /airbnb/i.test(channel);
  const prefix    = /airbnb/i.test(channel)     ? "ABB" :
                    /direct/i.test(channel)     ? "DBK" :
                    /booking/i.test(channel)     ? "BKC" :
                    /expedia/i.test(channel)     ? "EXP" :
                    /trip/i.test(channel)        ? "TRP" : "OTH";
  const resId     = codeMatch ? codeMatch[0] : (prefix + "-" + guestKey + "-" + checkIn.replace(/-/g, ""));

  console.log("parse OK: " + resId + " | " + m[1].trim() + " | " + channel + " | " + checkIn + " -> " + checkOut);

  return { resId, guest: m[1].trim(), roomName: m[2].trim(), checkIn, checkOut, channel, isAirbnb, note: isAirbnb ? "" : "มัดจำ 3,000 บาท" };
}

// ─────────────────────────────────────────────
// รับ Reply เลขห้องจาก LINE (admin ส่วนตัว)
// ─────────────────────────────────────────────
async function handleLineReply(messageText, sourceId) {
  // รับเฉพาะจาก admin ส่วนตัว
  if (sourceId !== ADMIN_ID) return;

  // ─── ยกเลิกการจอง ───────────────────────────
  const cancelMatch = messageText.trim().match(/^ยกเลิก\s+(.+)$/i);
  if (cancelMatch) {
    const guestName = cancelMatch[1].trim().toLowerCase();
    const sheets = getSheets();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + "!A:G",
    });
    const rows = result.data.values || [];
    let found = null;
    for (let i = rows.length - 1; i >= 1; i--) {
      const rowGuest = (rows[i][1] || "").trim().toLowerCase();
      const rowStatus = (rows[i][0] || "").trim();
      if (rowGuest.includes(guestName) && rowStatus !== "ยกเลิก") {
        found = { rowIdx: i, guest: rows[i][1], room: rows[i][0], resId: rows[i][5] };
        break;
      }
    }
    if (!found) {
      await linePush(ADMIN_ID, "\u274C ไม่พบการจองของ " + cancelMatch[1].trim());
      return;
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + "!A" + (found.rowIdx + 1),
      valueInputOption: "RAW",
      requestBody: { values: [["ยกเลิก"]] },
    });
    await linePush(ADMIN_ID,
      "\u2705 ยกเลิกแล้ว\n" +
      "\u{1F464} " + found.guest + "\n" +
      "\u{1F3E8} ห้อง " + (found.room || "รอยืนยัน") + "\n" +
      "\u{1F4CB} " + (found.resId || "-")
    );
    console.log("ยกเลิก: " + found.resId + " | " + found.guest);
    return;
  }

  const match = messageText.trim().match(/^(?:ห้อง\s*)?(\d{2,3})$/);
  if (!match) return;

  const roomNumber = getRoomLabel(match[1]);
  const sheets = getSheets();

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
    const info = await updateRoomInSheet(sheets, resId, roomNumber);
    if (!info) { console.log("ไม่เจอ resId: " + resId); return; }

    await sendConfirmToAdmin(resId, roomNumber, info.guest);

    const today    = todayBKK();
    const tomorrow = tomorrowBKK();
    const hour     = hourBKK();

    // วันนี้ → แจ้งทันที, พรุ่งนี้ + หลัง 19:00 → แจ้งทันที, พรุ่งนี้ + ก่อน 19:00 → รอ cron
    if (info.checkIn === today || (info.checkIn === tomorrow && hour >= 19)) {
      await sendUrgentToGroup(roomNumber, info.guest, info.checkIn, info.note);
    }
  } catch (err) {
    console.error("reply error: " + err.message);
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
          if (err || !uids || uids.length === 0) { console.log("ไม่พบอีเมลใหม่"); imap.end(); return resolve([]); }
          console.log("พบอีเมล: " + uids.length + " ฉบับ");
          const fetch = imap.fetch(uids, { bodies: "" });
          const tasks = [];
          fetch.on("message", (msg) => {
            tasks.push(new Promise((res) => {
              msg.on("body", (stream) => { simpleParser(stream, (err, parsed) => { if (!err) emails.push(parsed); res(); }); });
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

      // ─── auto-assign: เลือกห้องว่างเลขน้อยสุดในประเภทเดียวกัน ───
      const roomType    = getRoomTypeFromName(res.roomName || "");
      const matchedRooms = getRoomsOfType(roomType);

      if (matchedRooms.length === 0) {
        // ไม่รู้ประเภทห้อง → ถามแอดมิน
        await sendNewBookingToAdmin(res, null);
      } else {
        // ตรวจห้องว่างตามช่วงวันที่จอง
        const availableRooms = await getAvailableRooms(sheets, matchedRooms, res.checkIn, res.checkOut);

        if (availableRooms.length === 0) {
          // ทุกห้องเต็ม → แจ้งแอดมินให้ตรวจสอบ
          console.log(`conflict: ${roomType} ${res.checkIn}→${res.checkOut} ไม่มีห้องว่าง`);
          await sendNewBookingToAdmin(res, null, "conflict");
        } else {
          // เรียงเลขห้องน้อย→มาก แล้วเลือกอันแรก
          availableRooms.sort((a, b) => parseInt(a) - parseInt(b));
          const selectedRoom = availableRooms[0];
          const roomLabel    = getRoomLabel(selectedRoom);

          await updateRoomInSheet(sheets, res.resId, roomLabel);
          console.log(`auto-assign: ${res.resId} → ${roomLabel}  (ว่าง ${availableRooms.length}/${matchedRooms.length} ห้อง)`);

          const today    = todayBKK(), tomorrow = tomorrowBKK(), hour = hourBKK();
          if (res.checkIn === today || (res.checkIn === tomorrow && hour >= 19)) {
            await sendUrgentToGroup(roomLabel, res.guest, res.checkIn, res.note);
          }
          await sendNewBookingToAdmin(res, roomLabel);
        }
      }

      notifiedIds.add(res.resId);
      newCount++;
    }
    console.log("ตรวจเสร็จ (ใหม่ " + newCount + " รายการ)");
  } catch (err) {
    console.error("sync error: " + err.message);
  }
}

module.exports = { syncEmails, handleLineReply };

console.log("Email Sync พร้อมทำงาน (ทุก 30 นาที)");
cron.schedule("*/30 * * * *", syncEmails, { timezone: "Asia/Bangkok" });
if (process.argv.includes("--sync")) { console.log("sync ทันที..."); syncEmails(); }
