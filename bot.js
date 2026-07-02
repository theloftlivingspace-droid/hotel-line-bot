/**
 * Hotel + Apartment LINE Bot (Merged v1)
 * ─────────────────────────────────────
 * Hotel features:
 *   - แจ้งเช็คอิน/เอาท์ทุกวัน 19:00 → กลุ่มแม่บ้าน
 *   - Email sync ทุก 30 นาที → แจ้งจองใหม่ → กลุ่มแม่บ้าน
 *   - รับ reply เลขห้อง (#xxx) จากกลุ่มแม่บ้าน
 *
 * Apartment features:
 *   - Follow → ลงทะเบียนห้อง (Redis/file)
 *   - Rich Menu: ตรวจค่าเช่า, ส่งสลิป, ระเบียบ, เอกสาร, ติดต่อ
 *   - รับสลิปรูป → verify AI → forward รูปไปกลุ่มแม่บ้าน
 *   - Cron ส่งค่าเช่าวันที่ 5 และ 8-15
 *
 * Webhook รับทั้ง:
 *   - source.type === "group"  → hotel (reply เลขห้อง)
 *   - source.type === "user"   → apartment (ผู้เช่า 1:1)
 */

require("dotenv").config();
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");
const fetch   = require("node-fetch");
const cron    = require("node-cron");
const { google } = require("googleapis");

// ─── ENV ────────────────────────────────────────────────────────
const LINE_TOKEN    = process.env.LINE_CHANNEL_ACCESS_TOKEN        || "";
const LINE_SECRET   = process.env.LINE_CHANNEL_SECRET               || "";
const LINE_GROUP    = process.env.LINE_GROUP_ID                     || "";   // กลุ่มแม่บ้าน (ยังใช้สำหรับสรุปประจำวัน)
const LINE_TOKEN_BACKUP = process.env.LINE_CHANNEL_ACCESS_TOKEN_BACKUP || ""; // OA สำรอง (เพิ่มเข้ากลุ่มแม่บ้านแทน OA หลักเมื่อ quota หมด)
const LINE_GROUP_BACKUP = process.env.LINE_GROUP_ID_BACKUP          || "";   // group ID ที่ใช้ OA สำรอง (ถ้าต่างจาก LINE_GROUP)
const ADMIN_USER    = process.env.ADMIN_USER_ID             || "";
const ADMIN_USER_2  = process.env.ADMIN_USER_ID_BACKUP        || "";   // LINE User ID แอดมิน (รับแจ้งจองใหม่)
const SHEET_ID      = process.env.GOOGLE_SHEET_ID           || "";
const SHEET_NAME    = process.env.GOOGLE_SHEET_NAME         || "Sheet1";
const CRON_SCHED    = process.env.CRON_SCHEDULE             || "0 19 * * *";
const PORT          = process.env.PORT                      || 3000;

// Upstash Redis (apartment state)
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL    || "";
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN  || "";
const RICH_MENU_ID  = process.env.RICH_MENU_ID              || "";

// ─── LINE helpers ───────────────────────────────────────────────
// เช็ค quota คงเหลือของ OA token นั้นๆ
async function getQuotaRemaining(token) {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/quota/consumption", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null; // null = API error (ไม่รู้ quota จริง)
    const d = await res.json();
    const FREE_QUOTA = 300;
    return Math.max(0, FREE_QUOTA - (d.totalUsage || 0));
  } catch {
    return null; // null = ไม่รู้ อย่า fallback
  }
}

// push ด้วย token ที่ระบุ
async function linePushWithToken(to, messages, token) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LINE push failed (${res.status}): ${err}`);
  }
}

// แจ้ง admin เมื่อ quota หมด — ใช้ LINE_TOKEN_BACKUP ส่งเพราะ token หลัก quota หมดแล้ว
async function notifyAdminQuotaExhausted(usage) {
  if (!ADMIN_USER) return;
  const token = LINE_TOKEN_BACKUP || LINE_TOKEN;
  const messages = [
    {
      type: "text",
      text: `⚠️ LINE OA "Loft Auto Report" quota หมดแล้ว\n` +
            `📊 ใช้ไปแล้ว: ${usage}/300 ข้อความ\n\n` +
            `📋 ขั้นตอน:\n` +
            `1. เปิด LINE กลุ่มแม่บ้าน\n` +
            `2. ลบ OA "Loft Auto Report" ออกจากกลุ่ม\n` +
            `3. เพิ่ม OA สำรองเข้ากลุ่มแทน\n\n` +
            `⏳ กดปุ่มด้านล่างหลังสลับ OA เรียบร้อยแล้ว`,
      quickReply: {
        items: [
          { type: "action", action: { type: "postback", label: "✅ สลับ OA แล้ว", data: "action=USE_BACKUP_OA" } },
        ]
      }
    }
  ];
  try {
    await linePushWithToken(ADMIN_USER, messages, token);
  } catch (e) {
    console.error("[LINE] แจ้ง admin ไม่ได้:", e.message);
  }
}

// push หลัก → เช็ค Redis flag ก่อน ถ้าสลับ OA แล้วใช้ backup ทันที
async function linePush(to, messages) {
  // admin กด "สลับ OA แล้ว" → ใช้ backup token + group ทันที ไม่เช็ค quota
  const useBackup = await redisGet("use_backup_oa");
  if (useBackup === "1" && LINE_TOKEN_BACKUP) {
    const target = (to === LINE_GROUP && LINE_GROUP_BACKUP) ? LINE_GROUP_BACKUP : to;
    console.log("[LINE] Redis flag use_backup_oa=1 — ใช้ OA สำรอง");
    return linePushWithToken(target, messages, LINE_TOKEN_BACKUP);
  }

  const remaining = await getQuotaRemaining(LINE_TOKEN);

  // null = API error → ลองส่งก่อน ถ้า LINE ตอบ quota error ค่อยแจ้ง admin
  if (remaining === null) {
    try {
      return await linePushWithToken(to, messages, LINE_TOKEN);
    } catch (err) {
      const isQuotaErr = err.message && (
        err.message.includes("monthly limit") || err.message.includes("430")
      );
      if (isQuotaErr) {
        console.warn("[LINE] quota หมด (caught from push) — แจ้ง admin");
        await notifyAdminQuotaExhausted("≥300");
        return; // ไม่ส่งข้อความนั้น
      }
      throw err;
    }
  }

  // เหลือ ≤ 10 → เตือน admin ล่วงหน้า แต่ยังส่งได้
  if (remaining > 0 && remaining <= 10) {
    console.warn(`[LINE] quota เหลือน้อย (${remaining}) — เตือน admin`);
    if (ADMIN_USER) {
      const token = LINE_TOKEN_BACKUP || LINE_TOKEN; // ใช้ backup ส่งเตือน ไม่นับ quota หลัก
      const warnMsg = {
        type: "text",
        text: `⚠️ LINE OA "Loft Auto Report" quota เหลือ ${remaining} ข้อความ\n\n` +
              `📋 เตรียมสลับ OA:\n` +
              `1. เปิด LINE กลุ่มแม่บ้าน\n` +
              `2. ลบ OA "Loft Auto Report" ออกจากกลุ่ม\n` +
              `3. เพิ่ม OA สำรองเข้ากลุ่มแทน\n\n` +
              `⏳ กดปุ่มด้านล่างหลังสลับ OA เรียบร้อยแล้ว`,
        quickReply: {
          items: [
            { type: "action", action: { type: "postback", label: "✅ สลับ OA แล้ว", data: "action=USE_BACKUP_OA" } },
          ]
        }
      };
      linePushWithToken(ADMIN_USER, [warnMsg], token).catch(() => {});
    }
    return linePushWithToken(to, messages, LINE_TOKEN);
  }

  // quota หมด → แจ้ง admin ไม่ส่ง
  if (remaining <= 0) {
    console.warn("[LINE] quota หมด — แจ้ง admin ไม่ส่งข้อความ");
    await notifyAdminQuotaExhausted(300);
    return;
  }

  // ปกติ → ส่งเลย
  console.log(`[LINE] quota เหลือ ${remaining} — ส่งปกติ`);
  return linePushWithToken(to, messages, LINE_TOKEN);
}
async function lineReply(replyToken, messages) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  });
}
async function getLineProfile(userId) {
  const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` },
  });
  if (res.ok) return res.json();
  return { displayName: "ผู้เช่า" };
}
async function downloadLineImage(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` },
  });
  if (!res.ok) throw new Error(`ดาวน์โหลดรูปล้มเหลว: ${res.status}`);
  return (await res.buffer()).toString("base64");
}

// ─── Redis helpers ──────────────────────────────────────────────
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
      method: "GET",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json();
    return data.result === "OK";
  } catch (e) { console.error("Redis SET error:", e.message); return false; }
}

async function redisDel(key) {
  if (!REDIS_URL) return false;
  try {
    const res = await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json();
    return data.result >= 1;
  } catch (e) { console.error("Redis DEL error:", e.message); return false; }
}

// ─── File helpers (fallback) ────────────────────────────────────
const DATA_DIR      = path.join(__dirname, "data");
const ROOMS_FILE    = path.join(DATA_DIR, "rooms.json");
const USERS_FILE    = path.join(DATA_DIR, "users.json");
const PAYMENTS_FILE = path.join(DATA_DIR, "payments.json");

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJSON(file, data) {
  ensureDir(path.dirname(file));
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); } catch {}
}

// ─── Apartment storage ──────────────────────────────────────────
async function loadRooms() {
  const r = await redisGet("rooms");
  if (r) return r;
  const fromFile = loadJSON(ROOMS_FILE, null);
  if (fromFile) return fromFile;
  return buildDefaultRooms();
}
async function saveRooms(r) { await redisSet("rooms", r); saveJSON(ROOMS_FILE, r); }
async function loadUsers() { const u = await redisGet("users"); return u || loadJSON(USERS_FILE, {}); }
async function saveUsers(u) { await redisSet("users", u); saveJSON(USERS_FILE, u); }
async function loadPayments() { const p = await redisGet("payments"); return p || loadJSON(PAYMENTS_FILE, []); }
async function savePayments(p) {
  const meta = p.map(({ imageBase64, ...rest }) => rest);
  await redisSet("payments", meta);
  saveJSON(PAYMENTS_FILE, p);
  // save รูปแยก key ใน Redis ผ่าน pipeline
  for (const pay of p) {
    if (pay.imageBase64 && REDIS_URL) {
      try {
        await fetch(`${REDIS_URL}/pipeline`, {
          method: "POST",
          headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify([
            ["SET", `slip_img:${pay.id}`, pay.imageBase64, "EX", 5184000]
          ]),
        });
      } catch (e) { console.error("[Redis slip img save]", e.message); }
    }
  }
}

// ─── Google Sheets (hotel) ──────────────────────────────────────
function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}
async function fetchSheetData() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + "!A:G",
  });
  const rows = res.data.values || [];
  console.log("ดึงข้อมูลจาก Google Sheets: " + (rows.length - 1) + " แถว");
  return rows;
}

// ═══════════════════════════════════════════════════════════════
// HOTEL — daily checkin/checkout summary
// ═══════════════════════════════════════════════════════════════
function normalizeDate(str) {
  if (!str) return "";
  str = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return dmy[3] + "-" + dmy[2].padStart(2, "0") + "-" + dmy[1].padStart(2, "0");
  if (/^\d{5}$/.test(str)) {
    const d = new Date(Date.UTC(1899, 11, 30) + parseInt(str) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return str;
}
function filterByDate(rows, targetDate) {
  const checkIns = [];
  const checkOuts = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 4) continue;
    const room = (row[0] || "").trim(), guest = (row[1] || "").trim();
    const checkIn = normalizeDate(row[2] || ""), checkOut = normalizeDate(row[3] || "");
    // รองรับ 2 โครงสร้าง:
    // เก่า (6 cols): A=ห้อง B=แขก C=checkIn D=checkOut E=resId F=note
    // ใหม่ (7 cols): A=ห้อง B=แขก C=checkIn D=checkOut E=channel F=resId G=note
    let channel, resId, note;
    if (/^(ABB|BKC|EXP|TRP|DBK|OTH)-/i.test(row[5])) {
      // ใหม่ (7 cols): A=ห้อง B=แขก C=checkIn D=checkOut E=channel F=resId G=note
      channel = (row[4] || "").trim();
      resId   = (row[5] || "").trim();
      note    = (row[6] || "").trim();
    } else {
      // เก่า (6 cols): A=ห้อง B=แขก C=checkIn D=checkOut E=resId F=note
      channel = "";
      resId   = (row[4] || "").trim();
      note    = (row[5] || "").trim();
    }
    if (!room || !guest) continue;
    // ห้อง 363 (Mycondo) ไม่ส่งเข้ากลุ่มแม่บ้าน
    if (/\b363\b/.test(String(room))) continue;  // ห้อง 363 (Mycondo) ไม่ส่งแม่บ้าน
    // ห้อง cancel/ยกเลิก ไม่ส่งเข้ากลุ่มแม่บ้าน
    if (/cancel|ยกเลิก/i.test(room)) continue;
    const isAirbnb = /ABB-/i.test(channel) || /airbnb/i.test(channel) ||
                     /ABB-/i.test(resId)   || /airbnb/i.test(resId);
    const displayNote = (!isAirbnb && note) ? note : "";
    if (checkIn === targetDate)  checkIns.push({ room, guest, note: displayNote });
    if (checkOut === targetDate) checkOuts.push({ room, guest, note: displayNote });
  }
  return { checkIns, checkOuts };
}
function formatThaiDate(iso) {
  const M = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  const D = ["อาทิตย์","จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์"];
  const d = new Date(iso + "T00:00:00");
  return "วัน" + D[d.getDay()] + "ที่ " + d.getDate() + " " + M[d.getMonth()] + " " + (d.getFullYear() + 543);
}
function buildHotelMessage(checkIns, checkOuts, targetDate) {
  const sep = "─────────────────────────";
  let msg = "\n🏨 รายการห้องพักวันพรุ่งนี้\n📅 " + formatThaiDate(targetDate) + "\n" + sep + "\n";
  if (checkIns.length > 0) {
    msg += "\n✅ เช็คอิน (" + checkIns.length + " ห้อง)\n";
    checkIns.forEach(r => { msg += "  🔑 ห้อง " + r.room + "  —  " + r.guest + (r.note ? "  📝 " + r.note : "") + "\n"; });
  } else { msg += "\n✅ เช็คอิน : ไม่มี\n"; }
  if (checkOuts.length > 0) {
    msg += "\n🚪 เช็คเอาท์ (" + checkOuts.length + " ห้อง)\n";
    checkOuts.forEach(r => { msg += "  🧹 ห้อง " + r.room + "  —  " + r.guest + (r.note ? "  📝 " + r.note : "") + "\n"; });
  } else { msg += "\n🚪 เช็คเอาท์ : ไม่มี\n"; }
  msg += sep + "\n💌 ส่งอัตโนมัติโดยระบบโรงแรม";
  return msg;
}
async function runHotelJob() {
  console.log("[" + new Date().toLocaleString("th-TH") + "] เริ่มส่งสรุปแม่บ้าน...");
  try {
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
    const rows = await fetchSheetData();
    const { checkIns, checkOuts } = filterByDate(rows, tomorrow);
    const msg = buildHotelMessage(checkIns, checkOuts, tomorrow);
    await linePush(LINE_GROUP, [{ type: "text", text: msg }]);
    console.log("ส่ง LINE สำเร็จ");
  } catch (err) {
    console.error("Hotel job error: " + err.message);
    try { await linePush(LINE_GROUP, [{ type: "text", text: "⚠️ ระบบแจ้งเตือนแม่บ้านขัดข้อง\n" + err.message }]); } catch (_) {}
  }
}

// ─── Hotel: reply เลขห้องจากกลุ่ม ──────────────────────────────
async function updateRoomInSheet(sheets, resId, roomNumber) {
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_NAME + "!A:G" });
  const rows = result.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][4] || "").trim() === resId) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: SHEET_NAME + "!A" + (i + 1),
        valueInputOption: "RAW", requestBody: { values: [[roomNumber]] },
      });
      return { guest: rows[i][1] || resId, row: rows[i] };
    }
  }
  return { guest: null, row: null };
}
async function handleAdminReply(text, userId) {
  // รับเฉพาะจากแอดมิน
  if (ADMIN_USER && userId !== ADMIN_USER) return false;
  const match = text.trim().match(/^(?:ห้อง\s*)?(\d{2,3}\w*)$/);
  if (!match) return false;
  const roomNumber = match[1];

  // ใช้ handleLineReply จาก email-sync (รองรับ column F=resId)
  await emailHandleReply(text, userId);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// APARTMENT — room registration & rich menu
// ═══════════════════════════════════════════════════════════════
function floorButtons(rooms) {
  const floors = [...new Set(Object.keys(rooms).map(r => r[0]))].sort();
  return {
    type: "text", text: "กรุณาเลือกชั้นของคุณ 👇",
    quickReply: { items: floors.map(f => ({ type: "action", action: { type: "message", label: `ชั้น ${f}`, text: `ชั้น${f}` } })) },
  };
}
function roomButtons(floor, rooms) {
  const floorRooms = Object.values(rooms)
    .filter(r => r.roomNumber[0] === floor && !r.lineUserId)
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber));
  if (!floorRooms.length) return [{ type: "text", text: `ชั้น ${floor} ทุกห้องลงทะเบียนครบแล้วค่ะ 🎉\nหากต้องการแก้ไข กรุณาพิมพ์เลขห้องได้เลยค่ะ` }];
  const chunkSize = 8;
  const chunks = [];
  for (let i = 0; i < floorRooms.length; i += chunkSize) chunks.push(floorRooms.slice(i, i + chunkSize));
  const bubbles = chunks.map((chunk, idx) => ({
    type: "bubble", size: "micro",
    header: { type: "box", layout: "vertical", backgroundColor: "#0d9488", contents: [{ type: "text", text: `ชั้น ${floor}${chunks.length > 1 ? ` (${idx + 1}/${chunks.length})` : ""}`, color: "#ffffff", size: "sm", weight: "bold" }] },
    body: { type: "box", layout: "vertical", spacing: "sm", paddingAll: "8px", contents: chunk.map(r => ({ type: "button", style: "secondary", height: "sm", action: { type: "message", label: `ห้อง ${r.roomNumber}`, text: `room:${r.roomNumber}` } })) },
  }));
  return [{ type: "flex", altText: `เลือกห้องชั้น ${floor}`, contents: { type: "carousel", contents: bubbles } }];
}
function confirmButtons(roomNum, tenantName) {
  return {
    type: "text",
    text: `ยืนยันการลงทะเบียนค่ะ\n\n🏠 ห้อง: ${roomNum}\n👤 ชื่อ: ${tenantName || "(ยังไม่ระบุ)"}\n\nพิมพ์ "ยืนยัน" เพื่อยืนยัน\nหรือพิมพ์เลขห้องใหม่เพื่อแก้ไขค่ะ`,
    quickReply: { items: [
      { type: "action", action: { type: "message", label: "✅ ยืนยัน",    text: "confirm:yes" } },
      { type: "action", action: { type: "message", label: "❌ เลือกใหม่", text: "confirm:no"  } },
    ]},
  };
}

async function setRichMenuForUser(userId) {
  const richMenuId = RICH_MENU_ID;
  if (!richMenuId) return;
  try {
    await fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {
      method: "POST", headers: { Authorization: `Bearer ${LINE_TOKEN}` },
    });
  } catch (e) { console.error("[RichMenu Error]", e.message); }
}

async function verifySlipWithAI(base64Image, expectedAmount) {
  if (!process.env.ANTHROPIC_API_KEY) return { isSlip: false, amount: null };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-opus-4-6", max_tokens: 300,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
        { type: "text", text: `สลิปโอนเงิน ตอบ JSON เท่านั้น:\n{"isSlip":bool,"amount":number_or_null,"bankName":"string","toAccount":"string","date":"string"}\nยอดที่คาดหวัง: ${expectedAmount} บาท` },
      ]}],
    }),
  });
  if (!res.ok) return { isSlip: false, amount: null };
  const data = await res.json();
  try { return JSON.parse(data.content?.[0]?.text?.replace(/```json|```/g, "").trim() || "{}"); }
  catch { return { isSlip: false, amount: null }; }
}

// ─── Apartment event handlers ────────────────────────────────────
async function handleFollow(event) {
  const { userId } = event.source;
  const users = await loadUsers(), rooms = await loadRooms();
  const profile = await getLineProfile(userId);
  users[userId] = { userId, displayName: profile.displayName, state: "WAIT_FLOOR", pendingFloor: null, pendingRoom: null,
    roomNumber: users[userId]?.roomNumber || null, registeredAt: users[userId]?.registeredAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  await saveUsers(users);
  await lineReply(event.replyToken, [
    { type: "text", text: `สวัสดีค่ะ คุณ${profile.displayName} 👋\n\nยินดีต้อนรับสู่ระบบบริการผู้พักอาศัยค่ะ\nกรุณาเลือกชั้นและห้องของคุณด้านล่างเพื่อลงทะเบียนค่ะ` },
    floorButtons(rooms),
  ]);
  console.log(`[Follow] ${profile.displayName} (${userId})`);
}

async function handleUnfollow(event) {
  const { userId } = event.source;
  const rooms = await loadRooms(), users = await loadUsers();
  const user = users[userId];
  if (user?.roomNumber && rooms[user.roomNumber]) { rooms[user.roomNumber].lineUserId = ""; await saveRooms(rooms); }
  if (users[userId]) { users[userId].state = "INACTIVE"; users[userId].updatedAt = new Date().toISOString(); await saveUsers(users); }
}

async function handleUserMessage(event) {
  const { userId } = event.source;
  const text = event.message.text?.trim() || "";
  const users = await loadUsers(), rooms = await loadRooms();
  let user = users[userId];
  if (!user) {
    const profile = await getLineProfile(userId);
    user = users[userId] = { userId, displayName: profile.displayName, state: "WAIT_FLOOR", pendingFloor: null, pendingRoom: null, roomNumber: null };
  }

  // ─── Admin OA switch commands ────────────────────────────────
  if (userId === ADMIN_USER && (text === "/backup" || text === "/oa backup")) {
    await redisSet("use_backup_oa", "1");
    await lineReply(event.replyToken, [{
      type: "text",
      text: "✅ ระบบเปลี่ยนไปใช้ OA สำรองแล้ว\nข้อความแม่บ้านจะส่งจาก OA สำรองต่อไป",
      quickReply: { items: [
        { type: "action", action: { type: "postback", label: "🔄 กลับ OA หลัก", data: "action=USE_PRIMARY_OA" } }
      ]}
    }]);
    return;
  }
  if (userId === ADMIN_USER && (text === "/primary" || text === "/oa primary" || text === "/oa หลัก")) {
    await redisSet("use_backup_oa", "0");
    await lineReply(event.replyToken, [{ type: "text", text: "✅ ระบบกลับมาใช้ OA หลักแล้ว" }]);
    return;
  }
  if (userId === ADMIN_USER && (text === "/oa status" || text === "/oa")) {
    const flag = await redisGet("use_backup_oa");
    const using = flag === "1" ? "🔁 OA สำรอง" : "✅ OA หลัก";
    await lineReply(event.replyToken, [{
      type: "text",
      text: `📡 ใช้งานอยู่: ${using}`,
      quickReply: { items: [
        { type: "action", action: { type: "postback", label: "🔁 สลับ OA สำรอง", data: "action=USE_BACKUP_OA" } },
        { type: "action", action: { type: "postback", label: "✅ กลับ OA หลัก", data: "action=USE_PRIMARY_OA" } }
      ]}
    }]);
    return;
  }

  const floorMatch = text.match(/^ชั้น(\d)/);
  if (floorMatch) {
    users[userId].state = "WAIT_ROOM"; users[userId].pendingFloor = floorMatch[1]; users[userId].updatedAt = new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, roomButtons(floorMatch[1], rooms));
    return;
  }

  const roomMatch = text.match(/^room:(\w+)/);
  if (roomMatch) {
    const roomNum = roomMatch[1];
    if (!rooms[roomNum]) { await lineReply(event.replyToken, [{ type: "text", text: `ไม่พบห้อง ${roomNum} ค่ะ` }]); return; }
    const existing = rooms[roomNum].lineUserId;
    if (existing && existing !== userId) { await lineReply(event.replyToken, [{ type: "text", text: `ห้อง ${roomNum} ถูกลงทะเบียนไปแล้วค่ะ\nกรุณาติดต่อผู้จัดการอาคารค่ะ` }]); return; }
    users[userId].state = "CONFIRM_ROOM"; users[userId].pendingRoom = roomNum; users[userId].updatedAt = new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, [confirmButtons(roomNum, rooms[roomNum].tenantName)]);
    return;
  }

  const directRoomMatch = text.match(/^(\d{3,4})$/);
  if (directRoomMatch) {
    const roomNum = directRoomMatch[1];
    if (!rooms[roomNum]) { await lineReply(event.replyToken, [{ type: "text", text: `ไม่พบห้อง ${roomNum} ในระบบค่ะ\nกรุณาตรวจสอบเลขห้องและลองใหม่อีกครั้งค่ะ` }]); return; }
    const existing = rooms[roomNum].lineUserId;
    if (existing && existing !== userId) { await lineReply(event.replyToken, [{ type: "text", text: `ห้อง ${roomNum} ถูกลงทะเบียนไปแล้วค่ะ\nกรุณาติดต่อผู้จัดการอาคารค่ะ` }]); return; }
    users[userId].state = "CONFIRM_ROOM"; users[userId].pendingRoom = roomNum; users[userId].updatedAt = new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, [confirmButtons(roomNum, rooms[roomNum].tenantName)]);
    return;
  }

  if (text === "confirm:yes" && user.state === "CONFIRM_ROOM") {
    const roomNum = user.pendingRoom;
    rooms[roomNum].lineUserId = userId; await saveRooms(rooms);
    users[userId].state = "REGISTERED"; users[userId].roomNumber = roomNum; users[userId].pendingRoom = null; users[userId].updatedAt = new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, [{ type: "text", text: `✅ ลงทะเบียนห้อง ${roomNum} สำเร็จแล้วค่ะ\n\nคุณจะได้รับการแจ้งเตือนค่าเช่าทาง LINE ทุกเดือนอัตโนมัติค่ะ` }]);
    console.log(`[Registered] ห้อง ${roomNum} <- ${userId}`);
    setRichMenuForUser(userId);
    return;
  }
  if (text === "confirm:no") {
    users[userId].state = "WAIT_FLOOR"; users[userId].pendingRoom = null; users[userId].updatedAt = new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, [floorButtons(rooms)]);
    return;
  }
  if (text === "เปลี่ยนห้อง" || text === "แก้ไขห้อง" || text === "ลงทะเบียน") {
    users[userId].state = "WAIT_FLOOR"; await saveUsers(users);
    await lineReply(event.replyToken, [floorButtons(rooms)]);
    return;
  }

  // ─── จับ keyword ย้ายออก ทุก state (ถ้ามีห้องแล้ว) ────────────
  const isMoveout = user.roomNumber && (
    text.includes("ย้ายออก") ||
    text.includes("สิ้นสัญญา") ||
    (/ออก/.test(text) && /สิ้นเดือน|เดือน|วันที่|\d/.test(text))
  );
  if (isMoveout && user.state !== "WAIT_MOVEOUT_DATE") {
    users[userId].state = "WAIT_MOVEOUT_DATE"; await saveUsers(users);
    await lineReply(event.replyToken, [{ type: "text", text: `📦 แจ้งย้ายออกห้อง ${user.roomNumber} ค่ะ\n\nกรุณาระบุวันที่ต้องการย้ายออกค่ะ\nเช่น: ย้ายออกวันที่ 31 พฤษภาคม 2569\n\nพิมพ์รายละเอียดได้เลยค่ะ 👇` }]);
    return;
  }

  if (user.state === "WAIT_DOC_REQUEST") {
    users[userId].state = "REGISTERED"; await saveUsers(users);
    const roomNum = user.roomNumber || "ไม่ระบุ";
    await lineReply(event.replyToken, [{ type: "text", text: `✅ รับเรื่องขอเอกสารแล้วค่ะ\n\nห้อง: ${roomNum}\nเอกสารที่ต้องการ: ${text}\n\nเจ้าหน้าที่จะดำเนินการและแจ้งให้ทราบภายใน 1-2 วันทำการค่ะ 😊` }]);
    return;
  }
  if (user.state === "WAIT_CONTACT_MSG") {
    users[userId].state = "REGISTERED"; await saveUsers(users);
    const roomNum = user.roomNumber || "ไม่ระบุ";
    await lineReply(event.replyToken, [{ type: "text", text: `✅ รับเรื่องแล้วค่ะ\n\nห้อง: ${roomNum}\nเรื่อง: ${text}\n\nเจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุดค่ะ 😊` }]);
    return;
  }
  if (user.state === "WAIT_MOVEOUT_DATE") {
    users[userId].state = "REGISTERED"; await saveUsers(users);
    const roomNum = user.roomNumber || "ไม่ระบุ";
    await lineReply(event.replyToken, [{ type: "text",
      text: `✅ รับแจ้งย้ายออกเป็นลายลักษณ์อักษรแล้วค่ะ\n\n🏠 ห้อง: ${roomNum}\n👤 ชื่อ: ${rooms[roomNum]?.tenantName || "ไม่ระบุ"}\n📅 รายละเอียด: ${text}\n\nเจ้าหน้าที่จะติดต่อกลับเพื่อนัดหมายตรวจสอบห้องค่ะ 😊` }]);
    return;
  }

  if (user.state === "REGISTERED") {
    // ไม่ตอบข้อความทั่วไป — ผู้เช่าอาจแค่คุยกัน ไม่ต้องการให้บอทตอบทุกครั้ง
    return;
  }
}

async function handleImageMessage(event) {
  const { userId } = event.source;
  const users = await loadUsers(), rooms = await loadRooms();
  const user = users[userId];
  const myRooms = Object.values(rooms).filter(r => r.lineUserId === userId);
  if (!myRooms.length) { await lineReply(event.replyToken, [{ type: "text", text: "กรุณาลงทะเบียนห้องก่อนส่งสลิปค่ะ" }]); return; }
  if (user && !user.roomNumber) { users[userId].roomNumber = myRooms[0].roomNumber; users[userId].updatedAt = new Date().toISOString(); await saveUsers(users); }
  const roomList = myRooms.map(r => r.roomNumber).join(", ");
  const totalAmount = myRooms.reduce((s, r) => s + Number(r.amount), 0);
  try {
    const base64 = await downloadLineImage(event.message.id);
    const paymentId = Date.now().toString();

    // save รูปใน payment record โดยตรง (Redis จะเก็บแยก key โดย savePayments)
    const payment = {
      id: paymentId, roomNumber: roomList, tenantName: myRooms[0]?.tenantName,
      userId, messageId: event.message.id,
      imageBase64: base64,
      slipAmount: null, expectedAmount: totalAmount, amountMatch: false,
      isSlip: true, bankName: null, date: null,
      status: "pending_review",
      receivedAt: new Date().toISOString(),
    };
    const payments = await loadPayments(); payments.unshift(payment); await savePayments(payments.slice(0, 200));

    console.log(`[Slip] ห้อง ${roomList} - รับสลิปแล้ว id=${paymentId}`);
  } catch (e) {
    console.error("[Slip Error]", e.message);
    await linePush(userId, [{ type: "text", text: "เกิดข้อผิดพลาด กรุณาลองใหม่หรือติดต่อเจ้าหน้าที่ค่ะ" }]);
  }
}

async function handlePostback(event) {
  const { userId } = event.source;
  const data = event.postback?.data || "";
  const users = await loadUsers(), rooms = await loadRooms();
  const user = users[userId];
  const room = user?.roomNumber ? rooms[user.roomNumber] : null;

  // admin กดปุ่ม "สลับ OA แล้ว" → set Redis flag ให้ใช้ backup OA
  if (data === "action=USE_BACKUP_OA") {
    if (userId !== ADMIN_USER) return;
    await redisSet("use_backup_oa", "1");
    await lineReply(event.replyToken, [{ type: "text", text: "✅ ระบบเปลี่ยนไปใช้ OA สำรองแล้ว\nข้อความแม่บ้านจะส่งจาก OA สำรองต่อไป" }]);
    return;
  }

  // admin กดปุ่ม "กลับ OA หลัก" → ล้าง Redis flag
  if (data === "action=USE_PRIMARY_OA") {
    if (userId !== ADMIN_USER) return;
    await redisSet("use_backup_oa", "0");
    await lineReply(event.replyToken, [{ type: "text", text: "✅ ระบบกลับมาใช้ OA หลักแล้ว" }]);
    return;
  }

  if (data === "action=CHECK_RENT") {
  const myRooms = Object.values(rooms).filter(r => r.lineUserId === userId);
  if (!myRooms.length) { await lineReply(event.replyToken, [{ type: "text", text: "กรุณาลงทะเบียนห้องก่อนนะคะ" }]); return; }
  const roomNums = myRooms.map(r => r.roomNumber);
  const { confirmed, fine, confirmedAmount } = await getPaymentStatus(roomNums);
  const overdueDays = fine / 100;
  const fineNote = fine > 0 ? `\nค่าปรับ (${overdueDays} วัน × 100): ${fine.toLocaleString("th-TH")} บาท` : "";

  if (myRooms.length === 1) {
    const r = myRooms[0];
    const baseAmount = Number(r.amount);
    const total = confirmed
      ? (confirmedAmount || (baseAmount + fine))
      : baseAmount + fine;
    const totalStr = total.toLocaleString("th-TH", { minimumFractionDigits: 2 });

    // ✅ แยก text ชัดเจนระหว่าง ชำระแล้ว vs ยังไม่ชำระ
    const statusText = confirmed
      ? `✅ ชำระแล้ว ${totalStr} บาท\n\nไม่ต้องดำเนินการใดๆ เพิ่มเติมค่ะ 😊`
      : `ยอดค่าเช่าเดือนนี้: ${baseAmount.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท${fineNote}\n──────────────────\nยอดรวมที่ต้องชำระ: ${totalStr} บาท\nกำหนดชำระ: วันที่ 7 ของทุกเดือน`;

    await lineReply(event.replyToken, [
      { type: "text", text: `📋 ข้อมูลค่าเช่าห้อง ${r.roomNumber} ค่ะ\n\n${statusText}` },
      { type: "flex", altText: `ใบแจ้งหนี้ห้อง ${r.roomNumber}`, contents: {
        type: "bubble",
        header: { type:"box", layout:"vertical", backgroundColor: confirmed ? "#16a34a" : "#0d9488", contents:[{type:"text", text:`ห้อง ${r.roomNumber}`, color:"#ffffff", weight:"bold", size:"md"}] },
        body:   { type:"box", layout:"vertical", contents:[{type:"text", text: confirmed ? `✅ ชำระแล้ว: ${totalStr} บาท` : `ยอดรวม: ${totalStr} บาท`, size:"sm", color:"#333333"}] },
        footer: { type:"box", layout:"vertical", contents:[{type:"button", style:"primary", color: confirmed ? "#16a34a" : "#0d9488", action:{type:"uri", label: confirmed ? "ดูใบเสร็จ" : "ดูใบแจ้งหนี้", uri: r.invoiceLink}}] },
      }},
    ]);

  } else {
    const baseTotal = myRooms.reduce((s, r) => s + Number(r.amount), 0);
    const grandTotal = baseTotal + fine;
    const grandTotalStr = grandTotal.toLocaleString("th-TH", { minimumFractionDigits: 2 });
    // ยอดที่ชำระแล้วจริง ต้องใช้ confirmedAmount (จากสลิป) ไม่ใช่ยอดบิลปัจจุบัน
    // เพราะถ้ายังไม่โหลดบิลเดือนใหม่ ยอด room.amount อาจไม่ตรงกับที่จ่ายจริง
    const paidTotalStr = (confirmedAmount || grandTotal).toLocaleString("th-TH", { minimumFractionDigits: 2 });
    const summary = myRooms.map(r => `🏠 ห้อง ${r.roomNumber}: ${Number(r.amount).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`).join("\n");

    // ✅ เพิ่ม confirmed check สำหรับหลายห้อง
    const statusText = confirmed
      ? `✅ ชำระแล้ว ${paidTotalStr} บาท\n\nไม่ต้องดำเนินการใดๆ เพิ่มเติมค่ะ 😊`
      : `${summary}${fineNote}\n──────────────────\nยอดรวมที่ต้องชำระ: ${grandTotalStr} บาท\nกำหนดชำระ: วันที่ 7 ของทุกเดือน`;

    const billBubbles = myRooms.map(r => ({
      type: "bubble", size: "kilo",
      header: { type: "box", layout: "vertical", backgroundColor: confirmed ? "#16a34a" : "#0d9488", contents: [{ type: "text", text: `ห้อง ${r.roomNumber}`, color: "#ffffff", weight: "bold", size: "md" }] },
      body:   { type: "box", layout: "vertical", contents: [{ type: "text", text: `ยอด: ${Number(r.amount).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`, size: "sm", color: "#333333" }] },
      footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: confirmed ? "#16a34a" : "#0d9488", action: { type: "uri", label: confirmed ? "ดูใบเสร็จ" : "ดูใบแจ้งหนี้", uri: r.invoiceLink } }] },
    }));

    await lineReply(event.replyToken, [
      { type: "text", text: `📋 ข้อมูลค่าเช่าทุกห้องของคุณค่ะ\n\n${statusText}` },
      { type: "flex", altText: "ใบแจ้งหนี้ทุกห้อง", contents: { type: "carousel", contents: billBubbles } },
    ]);
  }
  return;
}

  if (data === "action=SEND_SLIP") {
    const myRooms = Object.values(rooms).filter(r => r.lineUserId === userId);
    if (!myRooms.length) { await lineReply(event.replyToken, [{ type: "text", text: "กรุณาลงทะเบียนห้องก่อนนะคะ" }]); return; }
    users[userId].state = "WAIT_SLIP"; await saveUsers(users);
    const baseAmount = myRooms.reduce((s, r) => s + Number(r.amount), 0);
    const { confirmed: slipConfirmed, fine, confirmedAmount: slipConfirmedAmount } = await getPaymentStatus(myRooms.map(r => r.roomNumber));
    const overdueDays = fine / 100;
    const totalAmount = slipConfirmed ? (slipConfirmedAmount || baseAmount + fine) : baseAmount + fine;
    const total = totalAmount.toLocaleString("th-TH", { minimumFractionDigits: 2 });
    const fineLine = fine > 0 ? `\nค่าปรับ (${overdueDays} วัน × 100): ${fine.toLocaleString("th-TH")} บาท` : "";
    const paidLine = slipConfirmed ? `\n✅ ชำระแล้ว: ${total} บาท` : `\n──────────────────\nยอดรวมที่ต้องชำระ: ${total} บาท`;
    await lineReply(event.replyToken, [{ type: "text", text: `💳 ส่งหลักฐานการชำระเงินค่ะ\n\nยอดค่าเช่า: ${baseAmount.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท${fineLine}${paidLine}\nกำหนดชำระ: วันที่ 7 ของทุกเดือน\n\nกรุณาถ่ายรูปหรืออัปโหลดสลิปการโอนเงินได้เลยค่ะ 👇` }]);
    return;
  }
  if (data === "action=REQUEST_DOC") {
    if (!room) { await lineReply(event.replyToken, [{ type: "text", text: "กรุณาลงทะเบียนห้องก่อนนะคะ" }]); return; }
    users[userId].state = "WAIT_DOC_REQUEST"; await saveUsers(users);
    await lineReply(event.replyToken, [{ type: "text", text: `📄 ขอเอกสารค่ะ\n\nกรุณาพิมพ์เอกสารที่ต้องการ เช่น\n- หนังสือรับรองการพักอาศัย\n- ใบเสร็จย้อนหลัง\n- สัญญาเช่า\n\nพิมพ์รายละเอียดได้เลยค่ะ 👇` }]);
    return;
  }
  if (data === "action=CONTACT") {
    users[userId].state = "WAIT_CONTACT_MSG"; await saveUsers(users);
    await lineReply(event.replyToken, [{ type: "text", text: `📞 ติดต่อเจ้าหน้าที่ค่ะ\n\nกรุณาพิมพ์เรื่องที่ต้องการสอบถามหรือแจ้งปัญหาได้เลยค่ะ\nเจ้าหน้าที่จะตอบกลับโดยเร็วที่สุดค่ะ 😊` }]);
    return;
  }
}

// ═══════════════════════════════════════════════════════════════
// APARTMENT — rent reminder
// ═══════════════════════════════════════════════════════════════
function getBillingCycle(now=new Date()){
  const bkk = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const y = bkk.getFullYear(), m = bkk.getMonth();
  // start = วันที่ 1 ของเดือนนี้
  // end = วันที่ 7 เดือนถัดไป - 8 วัน (≈ 29/30 ของเดือนนี้)
  const start = new Date(y, m, 1, 0, 0, 0, 0);
  const end   = new Date(y, m + 1, -1, 23, 59, 59, 999);
  return { start, end };
}

async function getPaymentStatus(roomNumbers) {
  const nowBKK = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const dayNow = nowBKK.getDate();
  const payments = await loadPayments();
  // เช็คเฉพาะ confirmed payment ที่ยังไม่ถูก archive
  // (ไม่ผูกกับเดือนปฏิทินจริง — รอบบิลจะเปลี่ยนก็ต่อเมื่อโหลดบิลเดือนใหม่เข้าไปเท่านั้น
  //  ซึ่งตอนนั้น upload-invoice จะ archive confirmed payment เก่าให้อัตโนมัติ)
  const confirmedPayment = payments.find(p => {
    if (p.status !== "confirmed") return false;
    const paidRooms = p.roomNumber.split(",").map(r => r.trim());
    return roomNumbers.some(rn => paidRooms.includes(rn));
  });
  if (confirmedPayment) {
    return { confirmed: true, fine: 0, confirmedAmount: confirmedPayment.slipAmount || null };
  }
  const overdueDays = dayNow > 7 ? dayNow - 7 : 0;
  return { confirmed: false, fine: overdueDays * 100, confirmedAmount: null };
}

async function runRentReminder(forceDay, onlyRoom = null, isTest = false) {
  // ใช้วันที่ตาม timezone ไทย (Asia/Bangkok) ไม่ใช่ UTC
  const now = new Date();
  const bangkokDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const day = forceDay || bangkokDate.getDate();
  if (!isTest && !onlyRoom && day !== 5 && (day < 8 || day > 15)) return;
  try {
    const rooms = await loadRooms(), payments = await loadPayments();
    // ไม่ผูกกับเดือนปฏิทินจริง — ใช้สถานะ confirmed ล้วนๆ (archive เกิดตอนโหลดบิลใหม่เท่านั้น)
    const paidRooms = new Set(
      isTest ? [] :
      payments
        .filter(p => p.status === "confirmed")
        .flatMap(p => p.roomNumber.split(",").map(r => r.trim()))
    );
    const unpaidRooms = Object.values(rooms).filter(r => r.lineUserId && !paidRooms.has(r.roomNumber) && (!onlyRoom || r.roomNumber === onlyRoom));
    if (!unpaidRooms.length) { console.log(`[Reminder] วันที่ ${day} — ทุกห้องชำระแล้ว ✓`); return; }
    for (const room of unpaidRooms) {
      const amount = Number(room.amount).toLocaleString("th-TH", { minimumFractionDigits: 2 });
      let msg = "";
      if (day === 5) {
        msg = `⚠️ แจ้งเตือนค่าเช่าห้อง ${room.roomNumber} ค่ะ\n\nยอดค่าเช่าเดือนนี้: ${amount} บาท\nกำหนดชำระ: วันที่ 7 ของเดือนนี้\n\n⏰ กรุณาชำระภายในวันที่ 7 ค่ะ\nหากเกินกำหนดจะมีค่าปรับ 100 บาท/วัน\n\nโอนผ่านบัญชีธนาคาร:\n• SCB 353-2-05292-9\n• KBank 799-2-39682-9\nชื่อบัญชี: ณัฐวุฒิ จงจิตตาภิบาล\n\nชำระแล้วกรุณาส่งสลิปในแชทนี้ด้วยนะคะ 🙏`;
      } else if (day >= 8 && day <= 15) {
        const overdueDays = day - 7, fine = overdueDays * 100;
        const total = (Number(room.amount) + fine).toLocaleString("th-TH", { minimumFractionDigits: 2 });
        const fineStr = fine.toLocaleString("th-TH");
        const daysLeft = 15 - day; // วันที่เหลือก่อนสิ้นสุดสัญญา
        if (day === 15) {
          msg = `🚨 แจ้งเตือนขั้นสุดท้าย ห้อง ${room.roomNumber} ค่ะ\n\nค่าเช่า: ${amount} บาท\nค่าปรับ (${overdueDays} วัน × 100): ${fineStr} บาท\n──────────────────\nยอดรวมที่ต้องชำระ: ${total} บาท\n\n⚠️ กรุณาชำระค่าเช่าพร้อมค่าปรับให้ครบถ้วนภายในวันนี้ค่ะ\nเพื่อหลีกเลี่ยงค่าธรรมเนียมหรือผลกระทบเพิ่มเติม หากเลยกำหนด ทางบริษัทขอสงวนสิทธิ์ดำเนินการตามสัญญา รวมถึงการยกเลิกการเช่าและเรียกเก็บค่าเสียหายอื่นๆต่อไป\n\nโอนผ่านบัญชีธนาคาร:\n• SCB 353-2-05292-9\n• KBank 799-2-39682-9\nชื่อบัญชี: ณัฐวุฒิ จงจิตตาภิบาล\n\nชำระแล้วกรุณาส่งสลิปในแชทนี้ด้วยนะคะ 🙏`;
        } else if (day >= 12) {
          msg = `🔴 แจ้งเตือนค่าเช่าเกินกำหนด ห้อง ${room.roomNumber} ค่ะ\n\nค่าเช่า: ${amount} บาท\nค่าปรับ (${overdueDays} วัน × 100): ${fineStr} บาท\n──────────────────\nยอดรวมที่ต้องชำระ: ${total} บาท\n\n⏳ เหลืออีก ${daysLeft} วัน สัญญาเช่าจะสิ้นสุดในวันที่ 15 ค่ะ\nหากยังไม่ชำระค่าเช่าพร้อมค่าปรับครบถ้วน ทางบริษัทขอสงวนสิทธิ์บอกเลิกสัญญาเช่าตามเงื่อนไขที่ตกลงกันไว้ค่ะ\n\nกรุณาชำระโดยด่วนค่ะ โอนผ่านบัญชีธนาคาร:\n• SCB 353-2-05292-9\n• KBank 799-2-39682-9\nชื่อบัญชี: ณัฐวุฒิ จงจิตตาภิบาล\n\nชำระแล้วกรุณาส่งสลิปในแชทนี้ด้วยนะคะ 🙏`;
        } else {
          msg = `🔴 แจ้งเตือนค่าเช่าเกินกำหนด ห้อง ${room.roomNumber} ค่ะ\n\nค่าเช่า: ${amount} บาท\nค่าปรับ (${overdueDays} วัน × 100): ${fineStr} บาท\n──────────────────\nยอดรวมที่ต้องชำระ: ${total} บาท\n\nกรุณาชำระโดยด่วนค่ะ โอนผ่านบัญชีธนาคาร:\n• SCB 353-2-05292-9\n• KBank 799-2-39682-9\nชื่อบัญชี: ณัฐวุฒิ จงจิตตาภิบาล\n\nชำระแล้วกรุณาส่งสลิปในแชทนี้ด้วยนะคะ 🙏`;
        }
      }
      if (msg) {
        try { await linePush(room.lineUserId, [{ type: "text", text: msg }]); console.log(`[Reminder] ส่งเตือนห้อง ${room.roomNumber} วันที่ ${day}`); }
        catch (e) { console.error(`[Reminder] ส่งไม่สำเร็จห้อง ${room.roomNumber}:`, e.message); }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (e) { console.error("[Reminder Error]", e.message); }
}

// ═══════════════════════════════════════════════════════════════
// EXPRESS SERVER + ADMIN API + WEBHOOK
// ═══════════════════════════════════════════════════════════════
const express = require("express");
const multer  = require("multer");
const XLSX    = require("xlsx");

const app     = express();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "apt2025@secret";
const LOG_FILE    = path.join(DATA_DIR, "send-log.json");

function verifySignature(rawBody, signature) {
  if (!LINE_SECRET) return true;
  const hash = crypto.createHmac("SHA256", LINE_SECRET).update(rawBody).digest("base64");
  return hash === signature;
}
function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─── Bill History helpers ────────────────────────────────────────
async function loadBillHistory() { return (await redisGet("bill_history")) || []; }
async function saveBillHistory(h) { await redisSet("bill_history", h); }

// ─── Webhook ─────────────────────────────────────────────────────
// Webhook สำรอง — ไม่ verify signature ใช้แค่ดึง groupId จาก OA สำรอง
app.post("/webhook-backup", (req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    res.status(200).send("OK");
    let data; try { data = JSON.parse(body); } catch { return; }
    for (const event of (data.events || [])) {
      (async () => {
        try {
          const sourceType = event.source?.type;
          const isGroup = sourceType === "group" || sourceType === "room";
          const uid = event.source?.userId || "";
          const gid = event.source?.groupId || "";
          console.log("[WebhookBackup] type=" + event.type + " source=" + sourceType + " userId=" + (uid||"-") + " groupId=" + (gid||"-"));

          // join/leave → สลับ OA อัตโนมัติ
          if (event.type === "join" && isGroup) {
            if (gid === LINE_GROUP_BACKUP) {
              await redisSet("use_backup_oa", "1");
              console.log("[OA] backup OA joined group → use_backup_oa=1");
              await linePushWithToken(ADMIN_USER, [{ type: "text", text: "🔁 OA สำรองเข้ากลุ่มแม่บ้านแล้ว\n✅ ระบบสลับไปใช้ OA สำรองอัตโนมัติ" }], LINE_TOKEN_BACKUP || LINE_TOKEN).catch(() => {});
            } else if (gid === LINE_GROUP) {
              await redisSet("use_backup_oa", "0");
              console.log("[OA] primary OA joined group → use_backup_oa=0");
              await linePushWithToken(ADMIN_USER, [{ type: "text", text: "✅ OA หลักเข้ากลุ่มแม่บ้านแล้ว\nระบบกลับมาใช้ OA หลักอัตโนมัติ" }], LINE_TOKEN).catch(() => {});
            }
            return;
          }
          if (event.type === "leave" && isGroup && gid === LINE_GROUP_BACKUP) {
            await redisSet("use_backup_oa", "0");
            console.log("[OA] backup OA left group → use_backup_oa=0");
            return;
          }

          // admin พิมพ์คำสั่งในกลุ่มผ่าน OA สำรอง
          if (event.type === "message" && isGroup && event.message.type === "text" && (uid === ADMIN_USER || uid === ADMIN_USER_2)) {
            const cmd = (event.message.text || "").trim().toLowerCase();
            const bReply = async (text) => fetch("https://api.line.me/v2/bot/message/reply", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN_BACKUP}` },
              body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: "text", text }] }),
            });
            if (cmd === "/backup" || cmd === "/oa backup") {
              await redisSet("use_backup_oa", "1");
              await bReply("✅ สลับไปใช้ OA สำรองแล้ว");
            } else if (cmd === "/primary" || cmd === "/oa primary") {
              await redisSet("use_backup_oa", "0");
              await bReply("✅ กลับมาใช้ OA หลักแล้ว");
            } else if (cmd === "/oa" || cmd === "/oa status") {
              const flag = await redisGet("use_backup_oa");
              const using = flag === "1" ? "🔁 OA สำรอง" : "✅ OA หลัก";
              await bReply(`📡 ใช้งานอยู่: ${using}`);
            }
          }
        } catch (err) { console.error("[WebhookBackup Error]", err.message); }
      })();
    }
  });
});

app.post("/webhook", (req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    if (!verifySignature(body, req.headers["x-line-signature"])) { res.status(401).send("Invalid signature"); return; }
    res.status(200).send("OK");
    let data; try { data = JSON.parse(body); } catch { return; }
    for (const event of (data.events || [])) {
      (async () => {
        try {
          const sourceType = event.source?.type;
          const isGroup = sourceType === "group" || sourceType === "room";
          const isUser  = sourceType === "user";
          if (event.type === "follow")   { await handleFollow(event); return; }
          if (event.type === "unfollow") { await handleUnfollow(event); return; }
          if (event.type === "postback") { await handlePostback(event); return; }
          // ─── OA ถูกเพิ่ม/ลบออกจากกลุ่มแม่บ้าน → สลับ OA อัตโนมัติ ───
          if (event.type === "join" && isGroup) {
            const gid = event.source?.groupId || "";
            if (gid === LINE_GROUP || gid === LINE_GROUP_BACKUP) {
              // OA ถูก invite เข้ากลุ่ม → เช็คว่าเป็น OA ไหน แล้วตั้ง flag
              // LINE_GROUP = OA หลัก, LINE_GROUP_BACKUP = OA สำรอง
              if (gid === LINE_GROUP_BACKUP) {
                // OA สำรองเข้ากลุ่มใหม่ → สลับไป backup
                await redisSet("use_backup_oa", "1");
                console.log("[OA] backup OA joined group → use_backup_oa=1");
                await linePushWithToken(ADMIN_USER, [{ type: "text", text: "🔁 OA สำรองเข้ากลุ่มแม่บ้านแล้ว\n✅ ระบบสลับไปใช้ OA สำรองอัตโนมัติ" }], LINE_TOKEN_BACKUP || LINE_TOKEN).catch(() => {});
              } else {
                // OA หลักเข้ากลุ่ม → สลับกลับ primary
                await redisSet("use_backup_oa", "0");
                console.log("[OA] primary OA joined group → use_backup_oa=0");
                await linePushWithToken(ADMIN_USER, [{ type: "text", text: "✅ OA หลักเข้ากลุ่มแม่บ้านแล้ว\nระบบกลับมาใช้ OA หลักอัตโนมัติ" }], LINE_TOKEN).catch(() => {});
              }
            }
            return;
          }
          if (event.type === "leave" && isGroup) {
            const gid = event.source?.groupId || "";
            if (gid === LINE_GROUP) {
              // OA หลักถูกลบออก → สลับไป backup
              await redisSet("use_backup_oa", "1");
              console.log("[OA] primary OA left group → use_backup_oa=1");
            }
            return;
          }

          if (event.type === "message") {
            const uid = event.source?.userId || "";
            const gid = event.source?.groupId || "";
            console.log(`[Webhook] type=${event.type} source=${event.source?.type} userId=${uid} groupId=${gid||"-"} LINE_GROUP=${LINE_GROUP}`);

            // ─── Admin พิมพ์คำสั่งในกลุ่มแม่บ้าน ───
            if (isGroup && event.message.type === "text" && uid === ADMIN_USER) {
              const cmd = (event.message.text || "").trim().toLowerCase();
              if (cmd === "/backup" || cmd === "/oa backup") {
                await redisSet("use_backup_oa", "1");
                await lineReply(event.replyToken, [{ type: "text", text: "✅ สลับไปใช้ OA สำรองแล้ว" }]);
                return;
              }
              if (cmd === "/primary" || cmd === "/oa primary") {
                await redisSet("use_backup_oa", "0");
                await lineReply(event.replyToken, [{ type: "text", text: "✅ กลับมาใช้ OA หลักแล้ว" }]);
                return;
              }
              if (cmd === "/oa" || cmd === "/oa status") {
                const flag = await redisGet("use_backup_oa");
                const using = flag === "1" ? "🔁 OA สำรอง" : "✅ OA หลัก";
                await lineReply(event.replyToken, [{ type: "text", text: `📡 ใช้งานอยู่: ${using}` }]);
                return;
              }
              // admin reply เลขห้องในกลุ่ม
              await handleAdminReply(event.message.text || "", uid);
              return;
            }

            if (isUser && event.message.type === "text") {
              // ถ้าเป็นแอดมิน → จัดการ hotel เท่านั้น ไม่ส่งไป apartment
              if (ADMIN_USER && event.source.userId === ADMIN_USER) {
                await handleAdminReply(event.message.text || "", event.source.userId);
                return;
              }
              await handleUserMessage(event);
              return;
            }
            if (isUser  && event.message.type === "image") { await handleImageMessage(event); return; }
          }
        } catch (err) { console.error("[Event Error]", err.message); }
      })();
    }
  });
});

// ─── Static + Health ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "20mb" }));
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Trigger email sync ทันที ──────────────────────────────────────────────
app.post("/api/sync-email", adminAuth, async (req, res) => {
  res.json({ ok: true, message: "sync started" });
  try { await syncEmails(); } catch(e) { console.error("sync-email error:", e.message); }
});

// ─── Admin API ────────────────────────────────────────────────────
app.get("/api/stats", adminAuth, async (req, res) => {
  const rooms = Object.values(await loadRooms()), users = await loadUsers();
  res.json({ totalRooms: rooms.length, registeredRooms: rooms.filter(r => r.lineUserId).length, totalFollowers: Object.keys(users).length, activeUsers: Object.values(users).filter(u => u.state === "REGISTERED").length });
});
app.get("/api/rooms", adminAuth, async (req, res) => { res.json(await loadRooms()); });
app.get("/api/rooms.csv", adminAuth, async (req, res) => {
  const rooms = await loadRooms();
  const rows = ["roomNumber,tenantName,lineUserId,amount,invoiceLink", ...Object.values(rooms).map(r => `${r.roomNumber},"${r.tenantName}",${r.lineUserId},${r.amount},${r.invoiceLink}`)];
  res.setHeader("Content-Type", "text/csv;charset=utf-8"); res.setHeader("Content-Disposition", 'attachment;filename="rooms.csv"'); res.send(rows.join("\n"));
});
app.get("/api/users", adminAuth, async (req, res) => { res.json(await loadUsers()); });
app.patch("/api/rooms/:roomNumber", adminAuth, async (req, res) => {
  const rooms = await loadRooms();
  // ถ้าห้องไม่มี → สร้างใหม่ (upsert)
  if (!rooms[req.params.roomNumber]) {
    rooms[req.params.roomNumber] = { roomNumber: req.params.roomNumber, tenantName: "", amount: 0, invoiceLink: "", lineUserId: "" };
  }
  ["tenantName", "lineUserId", "amount", "invoiceLink"].forEach(k => { if (req.body[k] !== undefined) rooms[req.params.roomNumber][k] = req.body[k]; });
  await saveRooms(rooms); res.json(rooms[req.params.roomNumber]);
});
app.delete("/api/rooms/:roomNumber/userId", adminAuth, async (req, res) => {
  const rooms = await loadRooms();
  if (!rooms[req.params.roomNumber]) return res.status(404).json({ error: "Room not found" });
  const oldId = rooms[req.params.roomNumber].lineUserId; rooms[req.params.roomNumber].lineUserId = ""; await saveRooms(rooms);
  if (oldId) { const users = await loadUsers(); if (users[oldId]) { users[oldId].state = "WAIT_FLOOR"; users[oldId].roomNumber = null; await saveUsers(users); } }
  res.json({ ok: true });
});
app.get("/api/payments", adminAuth, async (req, res) => { res.json(await loadPayments()); });
app.get("/api/slip-image/:id", adminAuth, async (req, res) => {
  try {
    let base64 = null;
    const r = await fetch(`${REDIS_URL}/get/slip_img:${req.params.id}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const data = await r.json(); if (data.result) base64 = data.result;
    if (!base64) { const payments = await loadPayments(); const p = payments.find(p => p.id === req.params.id); if (p?.imageBase64) base64 = p.imageBase64; }
    if (!base64) return res.status(404).send("ไม่พบรูปภาพ");
    res.setHeader("Content-Type", "image/jpeg"); res.setHeader("Cache-Control", "public,max-age=86400");
    res.send(Buffer.from(base64, "base64"));
  } catch (e) { res.status(500).send(e.message); }
});
app.patch("/api/payments/:id", adminAuth, async (req, res) => {
  const { status, note } = req.body; const payments = await loadPayments();
  const idx = payments.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "ไม่พบรายการ" });
  payments[idx].status = status; payments[idx].note = note || ""; payments[idx].updatedAt = new Date().toISOString();
  await savePayments(payments);
  const p = payments[idx];
  if (p.userId) {
    const msg = status === "confirmed" ? `✅ ยืนยันการชำระเงินแล้วค่ะ\nห้อง ${p.roomNumber} ขอบคุณค่ะ` : `❌ สลิปถูกปฏิเสธค่ะ\n${note ? `เหตุผล: ${note}\n` : ""}กรุณาติดต่อเจ้าหน้าที่ค่ะ`;
    linePush(p.userId, [{ type: "text", text: msg }]).catch(() => {});
  }
  res.json(payments[idx]);
});
app.post("/api/payments/manual", adminAuth, async (req, res) => {
  const { roomNumber, tenantName, amount, status, imageBase64 } = req.body;
  if (!roomNumber) return res.status(400).json({ error: "roomNumber required" });
  const paymentId = Date.now().toString();
  const payment = {
    id: paymentId,
    roomNumber: String(roomNumber),
    tenantName: tenantName || "",
    userId: null,
    messageId: null,
    imageBase64: imageBase64 || null,
    slipAmount: amount ? Number(amount) : null,
    expectedAmount: amount ? Number(amount) : 0,
    amountMatch: true,
    isSlip: true, bankName: null, date: null,
    status: status || "confirmed",
    receivedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    manualEntry: true,
  };
  const payments = await loadPayments();
  payments.unshift(payment);
  await savePayments(payments.slice(0, 200));
  console.log(`[Manual Payment] ห้อง ${roomNumber} ยอด ${amount} สถานะ ${status} id=${paymentId}`);
  res.json({ ok: true, id: paymentId });
});
app.delete("/api/payments/:id", adminAuth, async (req, res) => {
  const payments = await loadPayments();
  const idx = payments.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "ไม่พบรายการ" });
  payments.splice(idx, 1);
  await savePayments(payments);
  // ลบรูปสลิปออกจาก Redis ด้วย
  await redisDel(`slip_img:${req.params.id}`);
  res.json({ ok: true });
});
app.post("/api/upload-invoice", adminAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ไม่พบไฟล์ที่อัปโหลด" });
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" }), ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    if (!rows.length) return res.status(400).json({ error: "ไม่พบข้อมูลในไฟล์" });
    const firstRow = rows[0];
    if (!["ห้อง", "ลูกค้า", "ยอดรวม", "ลิงก์สาธารณะ"].every(k => k in firstRow)) return res.status(400).json({ error: "ไม่พบคอลัมน์ที่จำเป็น" });
    const oldRooms = await loadRooms(), now = new Date();
    const monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const history = await loadBillHistory();
    if (!history.find(h => h.month === monthLabel)) {
      history.unshift({ month: monthLabel, archivedAt: now.toISOString(), rooms: Object.values(oldRooms).map(r => ({ roomNumber: r.roomNumber, tenantName: r.tenantName, amount: r.amount, invoiceLink: r.invoiceLink, lineUserId: r.lineUserId })) });
      if (history.length > 24) history.pop(); await saveBillHistory(history);
    }
    const newRooms = {}; const skipped = [];
    rows.filter(r => r["ลิงก์สาธารณะ"]?.includes("aprty.co/i/")).forEach(row => {
      const roomNum = String(row["ห้อง"]).padStart(3, "0").replace(/^0+(\d{3,})$/, "$1");
      if (!roomNum || roomNum === "undefined") { skipped.push(row); return; }
      newRooms[roomNum] = { roomNumber: roomNum, tenantName: String(row["ลูกค้า"] || "").trim(), amount: Number(row["ยอดรวม"]) || 0, invoiceLink: String(row["ลิงก์สาธารณะ"]).trim(), lineUserId: oldRooms[roomNum]?.lineUserId || "" };
    });
    if (!Object.keys(newRooms).length) return res.status(400).json({ error: "ไม่พบข้อมูลห้องที่ถูกต้อง" });
    await saveRooms(newRooms);
    // ล้าง confirmed payments เก่า เพื่อให้สถานะชำระรีเซ็ตพร้อมบิลใหม่
    const oldPayments = await loadPayments();
    const resetPayments = oldPayments.map(p => p.status === "confirmed" ? { ...p, status: "archived" } : p);
    await savePayments(resetPayments);
    // ล้าง guard ส่งบิล เพื่อให้กดส่งบิลได้ในเดือนถัดไป
    const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    const monthKey = `send_rent_${bkk.getFullYear()}_${bkk.getMonth() + 1}`;
    await redisDel(monthKey);
    res.json({ ok: true, total: Object.keys(newRooms).length, archived: monthLabel, skipped: skipped.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/bill-history", adminAuth, async (req, res) => { res.json(await loadBillHistory()); });
app.delete("/api/rooms/reset", adminAuth, async (req, res) => {
  const oldRooms = await loadRooms(), freshRooms = buildDefaultRooms(), now = new Date();
  const monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const history = await loadBillHistory();
  if (!history.find(h => h.month === monthLabel)) {
    history.unshift({ month: monthLabel, archivedAt: now.toISOString(), rooms: Object.values(oldRooms).map(r => ({ roomNumber: r.roomNumber, tenantName: r.tenantName, amount: r.amount, invoiceLink: r.invoiceLink, lineUserId: r.lineUserId })) });
    if (history.length > 24) history.pop(); await saveBillHistory(history);
  }
  Object.keys(freshRooms).forEach(num => { if (oldRooms[num]?.lineUserId) freshRooms[num].lineUserId = oldRooms[num].lineUserId; });
  await saveRooms(freshRooms); res.json({ ok: true, total: Object.keys(freshRooms).length, archived: monthLabel });
});
app.get("/api/send-rent-status", adminAuth, async (req, res) => {
  const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const monthKey = `send_rent_${bkk.getFullYear()}_${bkk.getMonth() + 1}`;
  const alreadySent = await redisGet(monthKey);
  res.json({ alreadySent: !!alreadySent, sentAt: alreadySent || null });
});
app.post("/api/send-rent", adminAuth, async (req, res) => {
  // guard: ส่งได้แค่เดือนละครั้ง
  const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const monthKey = `send_rent_${bkk.getFullYear()}_${bkk.getMonth() + 1}`;
  const alreadySent = await redisGet(monthKey);
  if (alreadySent) {
    return res.json({ ok: false, error: `ส่งบิลทั้งหมดไปแล้วเดือนนี้ (${alreadySent}) กรุณาใช้ปุ่มส่งทีละห้องแทนค่ะ` });
  }

  const dayNow = bkk.getDate();
  const overdueDays = dayNow > 7 ? dayNow - 7 : 0;
  const rooms = await loadRooms(), allRooms = Object.values(rooms).filter(r => r.lineUserId);
  const grouped = {}; allRooms.forEach(room => { if (!grouped[room.lineUserId]) grouped[room.lineUserId] = []; grouped[room.lineUserId].push(room); });
  let ok = 0, fail = 0; const errors = [];
  for (const [userId, userRooms] of Object.entries(grouped)) {
    let messages;
    if (userRooms.length === 1) {
      const r = userRooms[0];
      const base = Number(r.amount);
      const fine = overdueDays * 100;
      const total = base + fine;
      const amountStr = base.toLocaleString("th-TH", { minimumFractionDigits: 2 });
      const totalStr  = total.toLocaleString("th-TH", { minimumFractionDigits: 2 });
      const fineLine  = fine > 0 ? `\nค่าปรับ (${overdueDays} วัน × 100): ${fine.toLocaleString("th-TH")} บาท\n──────────────────\nยอดรวม: ${totalStr} บาท` : "";
      const text = `คุณมีค่าเช่าห้อง ${r.roomNumber} เดือนนี้จำนวน ${amountStr} บาท${fineLine}\nชำระภายในวันที่ 7 โอนผ่านบัญชีธนาคารไทยพาณิชย์ 353-2-05292-9 หรือ ธนาคารกสิกรไทย 799-2-39682-9 ชื่อบัญชี ณัฐวุฒิ จงจิตตาภิบาล ดูรายละเอียดกดลิงค์นี้ ${r.invoiceLink}`;
      messages = [{ type: "text", text }];
    } else {
      const fine = overdueDays * 100;
      const baseTotal = userRooms.reduce((s, r) => s + Number(r.amount), 0);
      const grandTotal = baseTotal + fine;
      const summary = userRooms.map(r => `🏠 ห้อง ${r.roomNumber}: ${Number(r.amount).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`).join("\n");
      const fineLine = fine > 0 ? `\nค่าปรับ (${overdueDays} วัน × 100): ${fine.toLocaleString("th-TH")} บาท\n──────────────────\nยอดรวม: ${grandTotal.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท` : `\n──────────────────\nรวม: ${grandTotal.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`;
      const bubbles = userRooms.map(r => ({ type: "bubble", size: "kilo", header: { type: "box", layout: "vertical", backgroundColor: "#0d9488", contents: [{ type: "text", text: `ห้อง ${r.roomNumber}`, color: "#ffffff", weight: "bold", size: "md" }] }, body: { type: "box", layout: "vertical", contents: [{ type: "text", text: `ยอด: ${Number(r.amount).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท`, size: "sm" }] }, footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#0d9488", action: { type: "uri", label: "ดูใบแจ้งหนี้", uri: r.invoiceLink } }] } }));
      messages = [{ type: "text", text: `คุณมีค่าเช่าเดือนนี้ดังนี้ค่ะ\n\n${summary}${fineLine}\nชำระภายในวันที่ 7 โอนผ่านบัญชีธนาคารไทยพาณิชย์ 353-2-05292-9 หรือ ธนาคารกสิกรไทย 799-2-39682-9 ชื่อบัญชี ณัฐวุฒิ จงจิตตาภิบาล` }, { type: "flex", altText: "ใบแจ้งหนี้ทุกห้อง", contents: { type: "carousel", contents: bubbles } }];
    }
    try { await linePush(userId, messages); ok += userRooms.length; } catch (e) { fail += userRooms.length; userRooms.forEach(r => errors.push({ room: r.roomNumber, error: e.message })); }
    await new Promise(r => setTimeout(r, 250));
  }

  // บันทึกว่าส่งแล้วเดือนนี้
  await redisSet(monthKey, new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }));

  const skipped = Object.values(rooms).filter(r => !r.lineUserId).length;
  const logs = loadJSON(LOG_FILE, []); logs.unshift({ date: new Date().toISOString(), ok, fail, skipped, errors }); saveJSON(LOG_FILE, logs.slice(0, 60));
  res.json({ ok, fail, skipped, total: allRooms.length });
});
app.post("/api/send-rent-one/:roomNumber", adminAuth, async (req, res) => {
  const rooms = await loadRooms(), room = rooms[req.params.roomNumber];
  if (!room) return res.json({ ok: false, error: "ไม่พบห้อง" });
  if (!room.lineUserId) return res.json({ ok: false, error: "ไม่มี LINE ID" });
  const bkk = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const dayNow = bkk.getDate();
  const overdueDays = dayNow > 7 ? dayNow - 7 : 0;
  const base = Number(room.amount);
  const fine = overdueDays * 100;
  const total = base + fine;
  const amountStr = base.toLocaleString("th-TH", { minimumFractionDigits: 2 });
  const totalStr  = total.toLocaleString("th-TH", { minimumFractionDigits: 2 });
  const fineLine  = fine > 0 ? `\nค่าปรับ (${overdueDays} วัน × 100): ${fine.toLocaleString("th-TH")} บาท\n──────────────────\nยอดรวม: ${totalStr} บาท` : "";
  const text = `คุณมีค่าเช่าห้อง ${room.roomNumber} เดือนนี้จำนวน ${amountStr} บาท${fineLine}\nชำระภายในวันที่ 7 โอนผ่านบัญชีธนาคารไทยพาณิชย์ 353-2-05292-9 หรือ ธนาคารกสิกรไทย 799-2-39682-9 ชื่อบัญชี ณัฐวุฒิ จงจิตตาภิบาล ดูรายละเอียดกดลิงค์นี้ ${room.invoiceLink}`;
  try { await linePush(room.lineUserId, [{ type: "text", text }]); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/send-msg-one", adminAuth, async (req, res) => {
  const { roomNumber, message } = req.body;
  if (!roomNumber || !message) return res.json({ ok: false, error: "ต้องระบุ roomNumber และ message" });
  const rooms = await loadRooms(), room = rooms[roomNumber];
  if (!room) return res.json({ ok: false, error: `ไม่พบห้อง ${roomNumber}` });
  if (!room.lineUserId) return res.json({ ok: false, error: `ห้อง ${roomNumber} ไม่มี LINE ID` });
  try { await linePush(room.lineUserId, [{ type: "text", text: message }]); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
// ── Send note to maid LINE group ──────────────────────────────────────
app.post("/api/send-maid-note", adminAuth, async (req, res) => {
  const { room, guest, checkin, checkout, note } = req.body;
  if (!note) return res.status(400).json({ ok: false, error: "note required" });
  const lines = [];
  if (room)    lines.push(`🏠 ห้อง ${room}`);
  if (guest)   lines.push(`👤 ${guest}`);
  lines.push(`📝 ${note}`);
  const msg = lines.join("\n");
  try {
    await linePush(LINE_GROUP, [{ type: "text", text: msg }]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/cancel-notify", adminAuth, async (req, res) => {
  const { room, guest, checkin, checkout } = req.body;
  if (!room || !guest) return res.status(400).json({ ok: false, error: "room and guest required" });
  const msg = [
    "🚫 ยกเลิกการจอง",
    `🏠 ห้อง ${room}`,
    `👤 ${guest}`,
    `📅 ${checkin} → ${checkout}`,
  ].join("\n");
  try {
    await linePush(LINE_GROUP, [{ type: "text", text: msg }]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/broadcast", adminAuth, async (req, res) => {
  const { message } = req.body; if (!message) return res.status(400).json({ error: "message required" });
  const targets = Object.values(await loadRooms()).filter(r => r.lineUserId);
  let ok = 0, fail = 0;
  for (const room of targets) { try { await linePush(room.lineUserId, [{ type: "text", text: message }]); ok++; } catch { fail++; } await new Promise(r => setTimeout(r, 250)); }
  res.json({ ok, fail, total: targets.length });
});
app.post("/api/collect-followers", adminAuth, async (req, res) => {
  const rooms = await loadRooms(), REGISTER_MSG = req.body?.message || `สวัสดีค่ะ 👋\n\nทางอพาร์ทเมนท์ได้เปิดระบบแจ้งค่าเช่าผ่าน LINE แล้ว\nกรุณาเลือกชั้นและห้องของคุณด้านล่างเพื่อลงทะเบียนค่ะ`;
  async function fetchAll() { const ids = []; let start; while (true) { const url = new URL("https://api.line.me/v2/bot/followers/ids"); if (start) url.searchParams.set("start", start); url.searchParams.set("limit", "1000"); const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const d = await r.json(); ids.push(...(d.userIds || [])); if (!d.next) break; start = d.next; await new Promise(r => setTimeout(r, 200)); } return ids; }
  try {
    const allIds = await fetchAll(), users = await loadUsers();
    const regIds = new Set(Object.values(rooms).map(r => r.lineUserId).filter(Boolean));
    const need = allIds.filter(id => !regIds.has(id));
    let sent = 0, fail = 0;
    for (const userId of need) {
      if (!users[userId]) { let displayName = "-"; try { const p = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }); if (p.ok) ({ displayName } = await p.json()); } catch {} users[userId] = { userId, displayName, state: "WAIT_FLOOR", roomNumber: null, pendingRoom: null, registeredAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
      else { users[userId].state = "WAIT_FLOOR"; users[userId].pendingRoom = null; users[userId].updatedAt = new Date().toISOString(); }
      try { await linePush(userId, [{ type: "text", text: REGISTER_MSG }, floorButtons(rooms)]); sent++; } catch { fail++; }
      await new Promise(r => setTimeout(r, 250));
    }
    await saveUsers(users); res.json({ total: allIds.length, already: allIds.length - need.length, sent, failed: fail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/set-richmenu-all", adminAuth, async (req, res) => {
  const richMenuId = RICH_MENU_ID;
  if (!richMenuId) return res.status(400).json({ error: "ไม่พบ RICH_MENU_ID ใน Environment Variables" });
  const rooms = await loadRooms();
  const targets = Object.values(rooms).filter(r => r.lineUserId);
  let ok = 0, fail = 0;
  for (const room of targets) { try { await fetch(`https://api.line.me/v2/bot/user/${room.lineUserId}/richmenu/${richMenuId}`, { method: "POST", headers: { Authorization: `Bearer ${LINE_TOKEN}` } }); ok++; } catch { fail++; } await new Promise(r => setTimeout(r, 100)); }
  res.json({ ok, fail, total: targets.length, richMenuId });
});
app.post("/api/test-reminder", adminAuth, async (req, res) => {
  const day = Number(req.body.day) || new Date().getDate(), roomNumber = req.body.roomNumber || null;
  try { await runRentReminder(day, roomNumber, true); res.json({ ok: true, day, roomNumber }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get("/api/doc-requests",     adminAuth, (req, res) => { res.json(loadJSON(path.join(DATA_DIR, "doc-requests.json"), [])); });
app.get("/api/contact-logs",     adminAuth, (req, res) => { res.json(loadJSON(path.join(DATA_DIR, "contact-logs.json"), [])); });
app.get("/api/moveout-requests", adminAuth, (req, res) => { res.json(loadJSON(path.join(DATA_DIR, "moveout-requests.json"), [])); });
app.patch("/api/moveout-requests/:idx", adminAuth, async (req, res) => {
  const idx = parseInt(req.params.idx), { status } = req.body;
  const logs = loadJSON(path.join(DATA_DIR, "moveout-requests.json"), []);
  if (!logs[idx]) return res.status(404).json({ error: "Not found" });
  logs[idx].status = status; logs[idx].updatedAt = new Date().toISOString();
  saveJSON(path.join(DATA_DIR, "moveout-requests.json"), logs);
  if (status === "confirmed") {
    const roomNum = logs[idx].roomNumber, rooms = await loadRooms();
    if (rooms[roomNum]) { const oldUserId = rooms[roomNum].lineUserId; rooms[roomNum].lineUserId = ""; await saveRooms(rooms); if (oldUserId) { linePush(oldUserId, [{ type: "text", text: `✅ รับทราบการแจ้งย้ายออกห้อง ${roomNum} แล้วค่ะ\n\nเจ้าหน้าที่จะติดต่อเพื่อนัดตรวจสอบห้องและดำเนินการต่อไปค่ะ\n\nขอบคุณที่ใช้บริการนะคะ 😊` }]).catch(() => {}); } }
  }
  res.json({ ok: true });
});

function startWebhookServer() {
  app.listen(PORT, () => console.log("Webhook port " + PORT));
}

// ═══════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════
console.log("Hotel + Apartment LINE Bot พร้อมทำงาน");
ensureDir(DATA_DIR);

const { syncEmails, handleLineReply: emailHandleReply } = require("./email-sync");
console.log("Email Sync พร้อมทำงาน (ทุก 30 นาที)");
console.log("GOOGLE_SHEET_ID:", process.env.GOOGLE_SHEET_ID || "(ไม่พบ)");
console.log("GOOGLE_SHEET_NAME:", process.env.GOOGLE_SHEET_NAME || "(ไม่พบ)");
console.log("GOOGLE_SERVICE_ACCOUNT_JSON:", process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? `OK (${process.env.GOOGLE_SERVICE_ACCOUNT_JSON.length} chars)` : "(ไม่พบ)");

startWebhookServer();

// Hotel cron 19:00
cron.schedule(CRON_SCHED, runHotelJob, { timezone: "Asia/Bangkok" });
// Rent reminder: วันที่ 5 และ 8-15 เวลา 7:00 น.
cron.schedule("0 7 * * *", () => runRentReminder(), { timezone: "Asia/Bangkok" });
// ต้นเดือน 09:00 → เช็ค Redis flag ถ้าใช้ OA สำรองอยู่ แจ้ง admin ให้กลับ OA หลัก
cron.schedule("0 9 1 * *", async () => {
  try {
    const useBackup = await redisGet("use_backup_oa");
    if (useBackup !== "1" || !ADMIN_USER) return;
    const token = LINE_TOKEN_BACKUP || LINE_TOKEN;
    const msg = {
      type: "text",
      text: "🔄 ต้นเดือนใหม่แล้ว quota LINE OA หลัก reset เป็น 300 แล้ว\n\n" +
            "📋 ขั้นตอน:\n" +
            "1. เปิด LINE กลุ่มแม่บ้าน\n" +
            "2. ลบ OA สำรองออกจากกลุ่ม\n" +
            "3. เพิ่ม OA \"Loft Auto Report\" กลับเข้ากลุ่ม\n\n" +
            "กดปุ่มด้านล่างหลังสลับเรียบร้อยแล้ว",
      quickReply: {
        items: [
          { type: "action", action: { type: "postback", label: "✅ กลับ OA หลัก", data: "action=USE_PRIMARY_OA" } },
        ]
      }
    };
    await linePushWithToken(ADMIN_USER, [msg], token);
    console.log("[CRON] แจ้ง admin ต้นเดือน — กลับ OA หลัก");
  } catch (e) {
    console.error("[CRON] แจ้ง admin ต้นเดือนไม่ได้:", e.message);
  }
}, { timezone: "Asia/Bangkok" });
if (process.argv.includes("--test")) { console.log("โหมดทดสอบ..."); runHotelJob(); }
if (process.argv.includes("--sync")) { console.log("sync email ทันที..."); syncEmails(); }

// ─── Default rooms (apartment) ─────────────────────────────────
function buildDefaultRooms() {
  const data = [
    {roomNumber:"101",tenantName:"สุณิสา จงจิตตาภิบาล",                    amount:4902, invoiceLink:"https://aprty.co/i/rQQAq58n8"},
    {roomNumber:"102",tenantName:"เพลินพิศ โค้งอาภาส",                     amount:2761, invoiceLink:"https://aprty.co/i/V11kwAKGW"},
    {roomNumber:"103",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:6312, invoiceLink:"https://aprty.co/i/eGGz9Qvxr"},
    {roomNumber:"106",tenantName:"วีรภา ภู่ชำนาญ",                         amount:2599, invoiceLink:"https://aprty.co/i/pGG0BqYJ0"},
    {roomNumber:"107",tenantName:"นันทิดา ชวนพิศ",                         amount:4525, invoiceLink:"https://aprty.co/i/nggmqLA9r"},
    {roomNumber:"108",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:5853, invoiceLink:"https://aprty.co/i/9llLkr93M"},
    {roomNumber:"110",tenantName:"สำฤทธิ์ อุตตะมะ",                        amount:2602, invoiceLink:"https://aprty.co/i/aGGMgAzan"},
    {roomNumber:"111",tenantName:"วิชชุอร ภู่วงค์",                         amount:2200, invoiceLink:"https://aprty.co/i/k997qB6Ja"},
    {roomNumber:"113",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:3980, invoiceLink:"https://aprty.co/i/Dee7Yr9g0"},
    {roomNumber:"201",tenantName:"ธนัชพร บัวบาน",                          amount:2336, invoiceLink:"https://aprty.co/i/611Bqr9nD"},
    {roomNumber:"202",tenantName:"รุ่งนภา วีระนรพานิช",                     amount:5233, invoiceLink:"https://aprty.co/i/wXXxyvQ7j"},
    {roomNumber:"203",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:5832, invoiceLink:"https://aprty.co/i/NeeZqA936"},
    {roomNumber:"204",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:5280, invoiceLink:"https://aprty.co/i/KeeANZ936"},
    {roomNumber:"205",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:6080, invoiceLink:"https://aprty.co/i/1DDwQr9V4"},
    {roomNumber:"206",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:3016, invoiceLink:"https://aprty.co/i/XBBwkAXpk"},
    {roomNumber:"207",tenantName:"โสริยา วิสัยเกตุ",                        amount:1075, invoiceLink:"https://aprty.co/i/xBBjJ4GWq"},
    {roomNumber:"212",tenantName:"ธาราทิพย์ บุตรดี",                        amount:2404, invoiceLink:"https://aprty.co/i/lVV3Ll09m"},
    {roomNumber:"213",tenantName:"จิรภา คาขุนทด",                          amount:4132, invoiceLink:"https://aprty.co/i/lVV3Ll06Z"},
    {roomNumber:"214",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:6235, invoiceLink:"https://aprty.co/i/LeedKA9Zj"},
    {roomNumber:"300",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:8016, invoiceLink:"https://aprty.co/i/MeeY1A9mX"},
    {roomNumber:"301",tenantName:"สุภัทราวลี สิทธิศร",                      amount:2068, invoiceLink:"https://aprty.co/i/Dee7Yr9gw"},
    {roomNumber:"304",tenantName:"อนันท์ ยามดี",                            amount:2381, invoiceLink:"https://aprty.co/i/QDDj7A9pZ"},
    {roomNumber:"305",tenantName:"ดวงเดือน ลาภทวี",                         amount:2310, invoiceLink:"https://aprty.co/i/wXXxyvQ7a"},
    {roomNumber:"306",tenantName:"ฉันทพิชญา ใสใหม",                         amount:3898, invoiceLink:"https://aprty.co/i/NeeZqA93d"},
    {roomNumber:"307",tenantName:"บัว เหลือบแล",                            amount:2598, invoiceLink:"https://aprty.co/i/KeeANZ93e"},
    {roomNumber:"308",tenantName:"มุกธิดา อินทร์ไทยวงษ์",                   amount:5036, invoiceLink:"https://aprty.co/i/1DDwQr9Ve"},
    {roomNumber:"309",tenantName:"สันทนา นรานอก",                           amount:2216, invoiceLink:"https://aprty.co/i/XBBwkAXpp"},
    {roomNumber:"310",tenantName:"กองคำ นามปัญญา",                          amount:4074, invoiceLink:"https://aprty.co/i/Beev0r9Z3"},
    {roomNumber:"311",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:5833, invoiceLink:"https://aprty.co/i/lVV3Ll09p"},
    {roomNumber:"312",tenantName:"อิดดาเร๊ะ วาแม",                          amount:2256, invoiceLink:"https://aprty.co/i/zWWra3Kwo"},
    {roomNumber:"314",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:3138, invoiceLink:"https://aprty.co/i/LeedKA9Zl"},
    {roomNumber:"315",tenantName:"ฤกษ์มงคล เย็นใจ",                         amount:3346, invoiceLink:"https://aprty.co/i/MeeY1A9mn"},
    {roomNumber:"316",tenantName:"กัญญาพร คล่องแคล่ว",                      amount:2100, invoiceLink:"https://aprty.co/i/qDDyBRZ7Y"},
    {roomNumber:"402",tenantName:"พงศกร อาษานอก",                           amount:2312, invoiceLink:"https://aprty.co/i/RQQk7dD3m"},
    {roomNumber:"403",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:3248, invoiceLink:"https://aprty.co/i/5KKX1V9n3"},
    {roomNumber:"404",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:2232, invoiceLink:"https://aprty.co/i/zWWra3KD3"},
    {roomNumber:"405",tenantName:"Nan Mue Noke",                            amount:3074, invoiceLink:"https://aprty.co/i/oGG6aMd3L"},
    {roomNumber:"406",tenantName:"ชาญวุฒิ รุ่งฤทธิ์ดี",                     amount:5870, invoiceLink:"https://aprty.co/i/Geem8r93n"},
    {roomNumber:"407",tenantName:"นาย จักรินทร์ เวียงลอ",                   amount:2320, invoiceLink:"https://aprty.co/i/dee5rDO76"},
    {roomNumber:"408",tenantName:"ไชยยันห์ ดาโอภา",                         amount:2456, invoiceLink:"https://aprty.co/i/v118qODJW"},
    {roomNumber:"409",tenantName:"สุจินต์ จงกรฏ",                           amount:3436, invoiceLink:"https://aprty.co/i/4NN1Kr9e4"},
    {roomNumber:"410",tenantName:"เจนจิรา ปัดถาวโร",                        amount:3068, invoiceLink:"https://aprty.co/i/7XXljr9vO"},
    {roomNumber:"411",tenantName:"นุสรา บุญจันทร์",                          amount:3916, invoiceLink:"https://aprty.co/i/3wwKNa980"},
    {roomNumber:"412",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:2795, invoiceLink:"https://aprty.co/i/Jeeywr93x"},
    {roomNumber:"413",tenantName:"สุทธินันท์ เวียงนนท์",                    amount:2258, invoiceLink:"https://aprty.co/i/rQQAq58KW"},
    {roomNumber:"414",tenantName:"สถาพร โพธิ์แก้วเจริญพันธ์",              amount:2954, invoiceLink:"https://aprty.co/i/611Bqr9vD"},
    {roomNumber:"415",tenantName:"เสงี่ยม แดงวิบูลย์",                      amount:2496, invoiceLink:"https://aprty.co/i/066QDr987"},
    {roomNumber:"416",tenantName:"วีรศักดิ์ กองสุข",                         amount:2600, invoiceLink:"https://aprty.co/i/yllgJ7Nkg"},
    {roomNumber:"506",tenantName:"ทองใส มโนธรรม",                            amount:2214, invoiceLink:"https://aprty.co/i/AeeOqr9YZ"},
    {roomNumber:"507",tenantName:"ยลลดา โอสถศรี",                            amount:2054, invoiceLink:"https://aprty.co/i/k997qB7zR"},
    {roomNumber:"509",tenantName:"วิมลรัตน์ ทองผุย",                         amount:3184, invoiceLink:"https://aprty.co/i/dee5rDOpR"},
    {roomNumber:"512",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:2372, invoiceLink:"https://aprty.co/i/YllN1ABp8"},
    {roomNumber:"513",tenantName:"เด็จฤดี มีชัย",                            amount:3028, invoiceLink:"https://aprty.co/i/ZWWKRAkpl"},
    {roomNumber:"514",tenantName:"ลัศติพัจค์ บางปา",                         amount:1900, invoiceLink:"https://aprty.co/i/8BBW7ra4j"},
    {roomNumber:"515",tenantName:"อมรวิทย์ วรรณทอง",                         amount:2700, invoiceLink:"https://aprty.co/i/xBBjJ4wRk"},
  ];
  const rooms = {};
  data.forEach(d => { rooms[d.roomNumber] = { ...d, lineUserId: "" }; });
  return rooms;
}


