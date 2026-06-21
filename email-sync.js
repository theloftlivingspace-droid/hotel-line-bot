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
const GAS_STYLE_URL = "https://script.google.com/macros/s/AKfycbz3r-wEAImmD3jJUhTE58Z6IOQV_R1Q0iYs5imf8l4f5EUqZEdIKjQJzF4HuENgiJ4/exec";

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
  "209": "Radiance",
  "210": "Radiance",
  "214": "Legacy",
  "300": "Luxury",
  "363": "Mycondo",  // Mycondo — Airbnb only, no maid group
};

// ห้องที่ไม่ต้องส่งกลุ่มแม่บ้าน
const NO_MAID_ROOMS = new Set(["363"]);
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

// ─────────────────────────────────────────────
// Trigger styleSheet1 ใน GAS (sort + format Sheet1)
// ─────────────────────────────────────────────
async function triggerStyleSheet1() {
  try {
    await axios.post(GAS_STYLE_URL, { action: "styleSheet1" }, {
      headers: { "Content-Type": "application/json" },
      maxRedirects: 5,
      timeout: 30000,
    });
    console.log("styleSheet1: triggered OK");
  } catch (e) {
    console.error("styleSheet1: trigger failed:", e.message);
  }
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
  // A=รอยืนยัน B=ชื่อแขก C=เช็คอิน D=เช็คเอาท์ E=channel F=resId G=note H=วันจอง
  const bookingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:H",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [["รอยืนยัน", res.guest, res.checkIn, res.checkOut, res.channel, res.resId, res.note, bookingDate]],
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
  const months = {
    // English full
    january:1, february:2, march:3, april:4, may:5, june:6,
    july:7, august:8, september:9, october:10, november:11, december:12,
    // English short (Airbnb format: "Jun 20", "Jul 12")
    jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
    // Thai
    "มกราคม":1, "กุมภาพันธ์":2, "มีนาคม":3, "เมษายน":4,
    "พฤษภาคม":5, "มิถุนายน":6, "กรกฎาคม":7, "สิงหาคม":8,
    "กันยายน":9, "ตุลาคม":10, "พฤศจิกายน":11, "ธันวาคม":12,
  };
  const clean = str.replace(/(\d+)(st|nd|rd|th)/i, "$1").replace(/,/g, "").trim();
  const parts = clean.split(/\s+/);
  const thisYear = new Date().getFullYear();
  // รองรับ "Month DD [YYYY]" (Airbnb: "Jun 20" หรือ "June 20, 2026") และ "DD Month YYYY"
  const shortMonth = (s) => {
    const m = months[s.toLowerCase()] || months[s.toLowerCase().substring(0,3)];
    return m || null;
  };
  if (shortMonth(parts[0])) {
    const mon = shortMonth(parts[0]);
    const day = parseInt(parts[1]);
    const year = parts[2] ? parseInt(parts[2]) : thisYear;
    if (day && mon) return year + "-" + String(mon).padStart(2,"0") + "-" + String(day).padStart(2,"0");
  }
  const day = parseInt(parts[0]), mon = months[(parts[1]||"").toLowerCase()] || months[parts[1]];
  const year = parts[2] ? parseInt(parts[2]) : thisYear;
  if (!day || !mon) return null;
  return year + "-" + String(mon).padStart(2,"0") + "-" + String(day).padStart(2,"0");
}

// ─────────────────────────────────────────────
// Airbnb Direct Email Parser (ห้อง 363 Mycondo)
// Listing IDs ของ 363 Mycondo บน Airbnb: 18163498, 17444947
// ─────────────────────────────────────────────
const MYCONDO_LISTING_IDS = new Set(["18163498", "17444947"]);

function parseAirbnbDirectEmail(email) {
  const subject = email.subject || "";

  // ตรวจ subject ก่อน — ต้องเป็น "Reservation confirmed" จาก Airbnb
  if (!/Reservation confirmed/i.test(subject)) return null;

  // ใช้ HTML body สำหรับ Airbnb (text body มีแค่ tracking pixel)
  const textBody = email.text || "";
  const rawHtml  = email.html || "";

  // ดึง href URLs ออกมาก่อน strip tags (listing ID อยู่ใน href)
  const hrefUrls = [];
  rawHtml.replace(/href="([^"]+)"/gi, (_, url) => hrefUrls.push(url));

  const htmlBody = rawHtml
    ? rawHtml
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#x27;/gi, "'")
        .replace(/\s+/g, " ").trim()
    : "";

  // combined = subject + text + hrefs (text body มีวันที่, hrefs มี listing ID)
  const combined = subject + "\n" + textBody + "\n" + hrefUrls.join("\n");

  // ตรวจ listing ID จาก hrefs — ถ้าไม่ใช่ Mycondo ให้ return null
  const listingMatch = combined.match(/(?:rooms?|listing)[\/?=]+(\d{6,})/i);
  const listingId = listingMatch ? listingMatch[1] : null;
  if (!listingId || !MYCONDO_LISTING_IDS.has(listingId)) return null;

  // Guest name จาก subject
  const guestMatch = subject.match(/Reservation confirmed\s*[-–]\s*(.+?)\s+arrives/i);
  const guest = guestMatch ? guestMatch[1].trim() : null;

  // Confirmation code — text body ใช้ "CONFIRMATION CODE\nXXXX" (all caps, newline)
  const confMatch = combined.match(/CONFIRMATION CODE\s+([A-Z0-9]{6,12})/i)
                 || combined.match(/Confirmation code[:\s]+([A-Z0-9]{6,12})/i);
  const confCode = confMatch ? confMatch[1] : null;

  // วันที่จาก HTML: <...class="heading2...">Sat, Jun 20<  และ  >Sun, Jul 12<
  // Airbnb email มี 2 วัน (checkin, checkout) ใน format "Day, Mon DD"
  const htmlDates = [];
  rawHtml.replace(/>((Mon|Tue|Wed|Thu|Fri|Sat|Sun), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2})</g,
    (_, d) => htmlDates.push(d));
  // Fallback: text body / combined
  const dateLineMatch = combined.match(
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]+ \d{1,2})\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]+ \d{1,2})/
  );
  const inMatchFb  = combined.match(/will arrive on ([A-Za-z]+ \d{1,2},?\s*\d{0,4})/i);
  const outMatchFb = combined.match(/check out on ([A-Za-z]+ \d{1,2},?\s*\d{0,4})/i);

  let checkIn, checkOut;
  if (htmlDates.length >= 2) {
    checkIn  = isoDate(htmlDates[0]);
    checkOut = isoDate(htmlDates[1]);
  } else if (dateLineMatch) {
    checkIn  = isoDate(dateLineMatch[1]);
    checkOut = isoDate(dateLineMatch[2]);
  } else {
    checkIn  = inMatchFb  ? isoDate(inMatchFb[1])  : null;
    checkOut = outMatchFb ? isoDate(outMatchFb[1]) : null;
  }

  if (!guest || !checkIn || !checkOut) {
    console.log("❌ parseAirbnbDirect FAIL: listing=" + listingId + " guest=" + guest + " in=" + checkIn + " out=" + checkOut);
    return null;
  }

  const resId = confCode ? "ABB-" + confCode + "-" + checkIn.replace(/-/g,"") : "ABB-363-" + checkIn.replace(/-/g,"");
  console.log("✅ parseAirbnbDirect OK: " + resId + " | " + guest + " | " + checkIn + " -> " + checkOut);
  return { resId, guest, roomName: "363", checkIn, checkOut, channel: "Airbnb", isAirbnb: true, note: "" };
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

// ดึงชื่อ OTA จาก keyword — ไม่สนว่าหลัง channel จะมี trailing text อะไรตามมา
function normalizeChannel(rawChannel, subject, body) {
  const all = (rawChannel || "") + " " + (subject || "") + " " + (body || "").substring(0, 500);
  if (/airbnb/i.test(all))           return "Airbnb";
  if (/booking\.com/i.test(all))     return "Booking";
  if (/trip\.com|tripcom/i.test(all))return "Trip";
  if (/expedia/i.test(all))          return "Expedia";
  if (/agoda/i.test(all))            return "Agoda";
  if (/direct|ตรง/i.test(all))       return "Direct";
  // fallback: เอาแค่คำแรกของ rawChannel
  return (rawChannel || "Other").trim().split(/\s+/)[0];
}

function parseEmail(email) {
  // ── ลอง Airbnb direct parser ก่อน (363 Mycondo) ────────────────────────
  const airbnbDirect = parseAirbnbDirectEmail(email);
  if (airbnbDirect) return airbnbDirect;

  const body = extractText(email);
  const subject = email.subject || "";
  if (!body || body.length < 20) return null;

  const cleaned = body.replace(/(?:New\s+Reservation\s+(?:\d+\s+)?)+/gi, " ").replace(/\s+/g, " ").trim();

  let guest, roomName, checkIn, checkOut, channel;

  // ── English pattern ──────────────────────────────────────────────────────
  // "{guest} booked the {room} for {checkIn} to {checkOut} on {channel}"
  const mEn = cleaned.match(
    /([\p{L}\u4e00-\u9fff][\p{L}\u4e00-\u9fff\w\s,.''-]{1,50}?)\s+booked\s+the\s+(.+?)\s+for\s+(.+?)\s+to\s+(.+?)\s+on\s+([^\n\r]+)/imu
  );

  // ── Thai pattern ─────────────────────────────────────────────────────────
  // "{guest} จองห้อง {room} สำหรับวันที่ {checkIn} ถึง {checkOut} ทาง {channel}"
  const mTh = cleaned.match(
    /([\p{L}\u4e00-\u9fff][\p{L}\u4e00-\u9fff\w\s,.''-]{1,50}?)\s+จองห้อง\s+(.+?)\s+สำหรับวันที่\s+(.+?)\s+ถึง\s+(.+?)\s+ทาง\s+([^\n\r(]+)/imu
  );

  if (mEn) {
    guest    = mEn[1].trim();
    roomName = mEn[2].trim();
    checkIn  = isoDate(mEn[3].trim());
    checkOut = isoDate(mEn[4].trim());
    channel  = normalizeChannel(mEn[5], subject, body);
  } else if (mTh) {
    guest    = mTh[1].trim();
    roomName = mTh[2].trim();
    checkIn  = isoDate(mTh[3].trim());
    checkOut = isoDate(mTh[4].trim());
    channel  = normalizeChannel(mTh[5], subject, body);
  } else {
    console.log("parse FAIL (no match): subject=" + subject.substring(0, 80));
    console.log("parse FAIL body(200):", cleaned.substring(0, 200));
    return null;
  }

  if (!checkIn || !checkOut) {
    console.log("parse FAIL (date): in=" + checkIn + " out=" + checkOut);
    return null;
  }

  const codeMatch = (subject + " " + body).match(/\b[A-Z]{2,4}-[A-Z0-9]{6,}\b/);
  const guestKey  = guest.toLowerCase().replace(/[^a-z]/g, "").substring(0, 10) || Buffer.from(guest).toString("hex").substring(0, 10);
  const isAirbnb  = /airbnb/i.test(channel);
  const prefix    = /airbnb/i.test(channel)  ? "ABB" :
                    /direct/i.test(channel)  ? "DBK" :
                    /booking/i.test(channel) ? "BKC" :
                    /expedia/i.test(channel) ? "EXP" :
                    /trip/i.test(channel)    ? "TRP" : "OTH";
  const resId     = codeMatch ? codeMatch[0] : (prefix + "-" + guestKey + "-" + checkIn.replace(/-/g, ""));

  console.log("parse OK: " + resId + " | " + guest + " | " + channel + " | " + checkIn + " -> " + checkOut);

  return { resId, guest, roomName, checkIn, checkOut, channel, isAirbnb, note: isAirbnb ? "" : "มัดจำ 3,000 บาท" };
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

  const match = messageText.trim().match(/^(?:ห้อง\s*)?(\d{2,3}(?:\s+cancel)?)$/i);
  if (!match) return;

  const rawRoom    = match[1].trim();
  const isCancel   = /\s+cancel$/i.test(rawRoom);
  const roomNumber = isCancel
    ? getRoomLabel(rawRoom.replace(/\s+cancel$/i, '').trim()) + ' cancel'
    : getRoomLabel(rawRoom);
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

    if (isCancel) {
      // ห้อง cancel → ไม่ส่งอะไรไปกลุ่มแม่บ้านเลย
      console.log('cancel booking: skip group notify | ' + roomNumber + ' | ' + info.guest);
      return;
    }

    const today    = todayBKK();
    const tomorrow = tomorrowBKK();
    const hour     = hourBKK();

    // วันนี้ → แจ้งทันที, พรุ่งนี้ + หลัง 19:00 → แจ้งทันที, พรุ่งนี้ + ก่อน 19:00 → รอ cron
    if (info.checkIn === today || (info.checkIn === tomorrow && hour >= 19)) {
      // ห้อง 363 (Mycondo) ไม่ส่งเข้ากลุ่มแม่บ้าน
      if (!NO_MAID_ROOMS.has(String(roomNumber))) {
        await sendUrgentToGroup(roomNumber, info.guest, info.checkIn, info.note);
      }
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

    // helper: fetch a list of uids → parsed emails
    function fetchUids(uids) {
      return new Promise((res, rej) => {
        if (!uids || uids.length === 0) return res([]);
        const fetched = [];
        const f = imap.fetch(uids, { bodies: "" });
        const tasks = [];
        f.on("message", (msg) => {
          tasks.push(new Promise((r) => {
            msg.on("body", (stream) => { simpleParser(stream, (err, parsed) => { if (!err) fetched.push(parsed); r(); }); });
          }));
        });
        f.once("end", async () => { await Promise.all(tasks); res(fetched); });
        f.once("error", rej);
      });
    }

    imap.once("ready", () => {
      imap.openBox("INBOX", true, async (err) => {
        if (err) return reject(err);

        const baseLH  = [["SINCE", since], ["FROM", "no-reply@app.littlehotelier.com"]];
        const baseABB = [["SINCE", since], ["FROM", "automated@airbnb.com"]];

        // search EN and TH subjects in parallel (both over same open connection sequentially)
        const search = (criteria) => new Promise((res, rej) =>
          imap.search(criteria, (e, uids) => e ? rej(e) : res(uids || []))
        );

        try {
          const [uidsEn, uidsTh, uidsAbb] = await Promise.all([
            search([...baseLH,  ["SUBJECT", "New Reservation"]]),
            search([...baseLH,  ["SUBJECT", "การจองใหม่"]]),
            search([...baseABB, ["SUBJECT", "Reservation confirmed"]]),
          ]);

          // merge + deduplicate uid lists
          const allUids = [...new Set([...uidsEn, ...uidsTh, ...uidsAbb])];
          console.log(`พบอีเมล: LH-EN=${uidsEn.length} LH-TH=${uidsTh.length} ABB363=${uidsAbb.length} รวม=${allUids.length} ฉบับ`);

          if (allUids.length === 0) { console.log("ไม่พบอีเมลใหม่"); imap.end(); return resolve([]); }

          const fetched = await fetchUids(allUids);
          emails.push(...fetched);
          imap.end();
          resolve(emails);
        } catch (e) {
          imap.end();
          reject(e);
        }
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
    since.setMonth(since.getMonth() - 4);
    const emails = await fetchEmails(since);

    let newCount = 0;
    const heldRooms = new Set(); // ห้องที่ assign ไปแล้วในรอบนี้ (กันชนกันเมื่อมีหลาย booking พร้อมกัน)
    for (const email of emails) {
      const res = parseEmail(email);
      if (!res) continue;
      if (notifiedIds.has(res.resId)) { console.log("แจ้งไปแล้ว: " + res.resId); continue; }

      await addPendingRow(sheets, res);
      await appendEmailLog(sheets, res);

      // auto-assign: เลือกห้องว่างใน type เดียวกัน, เลขห้องน้อยก่อน
      // Mycondo 363: ถ้า roomName มี "363" หรือ "mycondo" → assign 363 ตรงๆ
      const isMycondo = /363|mycondo/i.test(res.roomName || "") || /363|mycondo/i.test(res.listingTitle || "");
      const roomType     = isMycondo ? "Mycondo" : getRoomTypeFromName(res.roomName || "");
      const candidateRooms = getRoomsOfType(roomType)
        .slice()
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

      let assignedRoom = null;
      if (candidateRooms.length >= 1) {
        const checkIn  = normalizeDate(res.checkIn);
        const checkOut = normalizeDate(res.checkOut);
        const available = await getAvailableRooms(sheets, candidateRooms, checkIn, checkOut);
        // กรองห้องที่ถูก assign ไปแล้วใน run นี้ (booking อื่นที่เพิ่ง process ในรอบเดียวกัน)
        const free = available.filter(r => !heldRooms.has(r));

        if (free.length >= 1) {
          // เรียงเลขห้องน้อยก่อนแล้วเลือกตัวแรก
          free.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
          assignedRoom = free[0];
          heldRooms.add(assignedRoom);
        }
      }

      if (assignedRoom) {
        const roomLabel = getRoomLabel(assignedRoom);
        await updateRoomInSheet(sheets, res.resId, roomLabel);
        console.log("auto-assign: " + res.resId + " -> " + roomLabel);
        const today = todayBKK(), tomorrow = tomorrowBKK(), hour = hourBKK();
        if (res.checkIn === today || (res.checkIn === tomorrow && hour >= 19)) {
          // ห้อง 363 (Mycondo) ไม่ส่งเข้ากลุ่มแม่บ้าน
          if (!NO_MAID_ROOMS.has(String(assignedRoom))) {
            await sendUrgentToGroup(roomLabel, res.guest, res.checkIn, res.note);
          }
        }
        await sendNewBookingToAdmin(res, roomLabel);
      } else if (candidateRooms.length >= 1) {
        // ทุกห้องใน type นี้ไม่ว่างในช่วงวันที่จอง (รวมที่ถูก hold ใน run นี้)
        await sendNewBookingToAdmin(res, null, "conflict");
      } else {
        await sendNewBookingToAdmin(res, null);
      }

      notifiedIds.add(res.resId);
      newCount++;
    }
    console.log("ตรวจเสร็จ (ใหม่ " + newCount + " รายการ)");
    if (newCount > 0) await triggerStyleSheet1();
  } catch (err) {
    console.error("sync error: " + err.message);
  }
}

module.exports = { syncEmails, handleLineReply };

console.log("Email Sync พร้อมทำงาน (ทุก 30 นาที)");
cron.schedule("*/30 * * * *", syncEmails, { timezone: "Asia/Bangkok" });
if (process.argv.includes("--sync")) { console.log("sync ทันที..."); syncEmails(); }

