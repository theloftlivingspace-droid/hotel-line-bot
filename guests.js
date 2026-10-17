/**
 * guests.js — จำนวนแขกต่อ booking (ผู้ใหญ่ / เด็ก)
 *
 * ปัญหา: อีเมลสรุป "New Reservation ... booked the ... on Airbnb" ของ Little Hotelier
 * ไม่มีจำนวนแขกเลย แต่จำนวนแขกอยู่ในอีเมลฉบับคู่ของแต่ละช่องทาง:
 *   - Airbnb      : automated@airbnb.com   "GUESTS\n\n2 adults, 1 child"
 *   - Booking.com : LH detail-table        "Guest Count: Number of adults : 2"
 *   - Trip.com    : noreply_htl@trip.com   "Guests (estimated):2 adults"
 *
 * โมดูลนี้ดึงตัวเลขจากอีเมลคู่เหล่านั้น จับคู่กับ booking ด้วย ชื่อแขก + วันเช็คอิน
 * แล้วเก็บลง Sheet1 ในคอลัมน์ Adults / Children / Guests (หาคอลัมน์จากชื่อหัวตาราง
 * ไม่ผูกกับตำแหน่ง เพราะ GAS ก็เพิ่มคอลัมน์ท้ายตารางเหมือนกัน)
 *
 * ถ้าไม่พบตัวเลข จะคืน null → ข้อความแสดง "ไม่ระบุ" (ห้ามเดาเป็น 1)
 */
"use strict";

const GUEST_HEADERS = { adults: "Adults", children: "Children", total: "Guests" };

// ─────────────────────────────────────────────
// Parse counts จากข้อความอีเมล
// ─────────────────────────────────────────────
function num(s) {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// ดึง adults/children จากข้อความสั้นๆ เช่น "2 adults, 1 child" / "ผู้ใหญ่ 2 คน เด็ก 1 คน"
function countsFromSegment(seg) {
  if (!seg) return null;
  const a = seg.match(/(\d+)\s*adults?\b/i) || seg.match(/ผู้ใหญ่\s*(\d+)/);
  const c = seg.match(/(\d+)\s*(?:children|child|kids?)\b/i) || seg.match(/เด็ก\s*(\d+)/);
  const i = seg.match(/(\d+)\s*infants?\b/i) || seg.match(/ทารก\s*(\d+)/);
  const adults = a ? num(a[1]) : null;
  // ทารก (infant) นับรวมในช่อง "เด็ก" — แม่บ้านต้องเตรียมของให้เด็กเล็กเหมือนกัน
  let children = null;
  if (c) children = num(c[1]);
  if (i) children = (children || 0) + (num(i[1]) || 0);
  if (adults === null && children === null) return null;
  return { adults: adults === null ? 0 : adults, children: children === null ? 0 : children };
}

function parseAirbnbGuests(text) {
  // หัวข้อ "GUESTS" ตัวใหญ่ ตามด้วย "1 adult" ก่อนถึง "MORE DETAILS ABOUT WHO'S COMING"
  const m = text.match(/GUESTS\s+([\s\S]{0,200}?)(?:MORE DETAILS|CONFIRMATION CODE|$)/);
  return m ? countsFromSegment(m[1]) : null;
}

function parseLhDetailGuests(text) {
  // "Guest Count: Number of adults : 2" (+ "Number of children : 1" ถ้ามี)
  const a = text.match(/Number of adults\s*:\s*(\d+)/i);
  const c = text.match(/Number of children\s*:\s*(\d+)/i);
  if (!a && !c) return null;
  return { adults: a ? num(a[1]) : 0, children: c ? num(c[1]) : 0 };
}

function parseTripGuests(text) {
  const m = text.match(/Guests \(estimated\)\s*:\s*([^\n|]+)/i)
         || text.match(/ผู้เข้าพัก \(โดยประมาณ\)\s*:\s*([^\n|]+)/);
  return m ? countsFromSegment(m[1]) : null;
}

// ─────────────────────────────────────────────
// ชื่อ + วันที่ → key สำหรับจับคู่
// ─────────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const mmdd = (m, d) => String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
const monthNum = (s) => MONTHS[String(s).toLowerCase().slice(0, 3)] || null;

// ชื่อ → token เรียงตามตัวอักษร (รองรับ "Saphanthong/Chinchutha" = "Chinchutha Saphanthong")
function nameTokens(name) {
  // เทียบแบบไม่สนสำเนียง/รูปแบบ Unicode: "č" ตัวเดียว = "c"+เครื่องหมายแยก = "c" (อีเมล/LH/ชีตเก็บไม่เหมือนกัน)
  return String(name || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[\s,\/]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .sort();
}
const nameKey = (name) => nameTokens(name).join("");

function senderOf(email) {
  try { return String(email.from.value[0].address || "").toLowerCase(); } catch (_) { return ""; }
}

function emailText(email) {
  if (email.text && email.text.trim().length > 20) return email.text;
  if (email.html) {
    return email.html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

// อีเมลที่มีไว้ให้ดึงจำนวนแขกอย่างเดียว (ไม่ใช่อีเมลจอง) — ห้ามส่งเข้า parseEmail()
function isGuestOnlyEmail(email) {
  return senderOf(email) === "noreply_htl@trip.com";
}

// คืน { key, tokens, mmdd, counts, source } หรือ null
function extractGuestEntry(email) {
  const subject = email.subject || "";
  const sender = senderOf(email);
  const text = emailText(email);
  if (!text) return null;

  // Airbnb: "Reservation confirmed - {name} arrives Oct 11"
  if (sender === "automated@airbnb.com") {
    const sm = subject.match(/Reservation confirmed\s*[-–]\s*(.+?)\s+arrives\s+([A-Za-z]+)\s+(\d{1,2})/i);
    const counts = parseAirbnbGuests(text);
    if (!sm || !monthNum(sm[2]) || !counts) return null;
    return mk(sm[1], mmdd(monthNum(sm[2]), sm[3]), counts, "airbnb");
  }

  // Trip.com: "Guest Name: Saphanthong/Chinchutha" + "Staying period:Oct 10, 2026 - ..."
  if (sender === "noreply_htl@trip.com") {
    const gm = text.match(/Guest Name\s*:\s*([^\n|]+)/i);
    const pm = text.match(/Staying period\s*:\s*([A-Za-z]{3,9})\s+(\d{1,2}),?\s+\d{4}/i);
    const counts = parseTripGuests(text);
    if (!gm || !pm || !monthNum(pm[1]) || !counts) return null;
    return mk(gm[1], mmdd(monthNum(pm[1]), pm[2]), counts, "trip");
  }

  // Little Hotelier detail-table (Booking.com / Expedia): "Booking for # ..."
  if (/Booking for #\s*\d+/i.test(subject)) {
    const gm = text.match(/Guest\s*:\s*([^\n|]+?)\s*\|?\s*Age\s*:/i);
    const im = text.match(/Check-in\s*:\s*(\d{1,2})-([A-Za-z]{3})-\d{4}/i);
    const counts = parseLhDetailGuests(text);
    if (!gm || !im || !monthNum(im[2]) || !counts) return null;
    return mk(gm[1], mmdd(monthNum(im[2]), im[1]), counts, "lh-detail");
  }
  return null;

  function mk(name, md, counts, source) {
    return { key: nameKey(name) + "|" + md, tokens: nameTokens(name), mmdd: md, counts, source };
  }
}

// สร้าง index จากอีเมลทั้งหมดที่ดึงมาในรอบ sync (รวมอีเมลคู่)
function buildGuestIndex(emails) {
  const exact = new Map();
  const list = [];
  for (const email of emails) {
    let entry = null;
    try { entry = extractGuestEntry(email); } catch (e) { console.error("guest-index error: " + e.message); }
    if (!entry) continue;
    if (!exact.has(entry.key)) exact.set(entry.key, entry);
    list.push(entry);
  }
  return { exact, list };
}

// res = ผลจาก parseEmail() ({ guest, checkIn, ... }) → { adults, children } | null
function lookupGuests(index, res) {
  if (!index || !res || !res.guest || !res.checkIn) return null;
  const md = String(res.checkIn).slice(5, 10);
  const hit = index.exact.get(nameKey(res.guest) + "|" + md);
  if (hit) return hit.counts;

  // ชื่อบนอีเมลคู่อาจสั้น/ยาวกว่ากัน → ยอมรับเมื่อ token ของชื่อที่สั้นกว่าอยู่ในชื่อที่ยาวกว่า
  // และมีอย่างน้อย 2 token (กันเดาผิด — ผิดแล้วแม่บ้านเตรียมห้องผิด ดีกว่าแสดง "ไม่ระบุ")
  const mine = nameTokens(res.guest);
  for (const e of index.list) {
    if (e.mmdd !== md) continue;
    const [small, big] = mine.length <= e.tokens.length ? [mine, e.tokens] : [e.tokens, mine];
    if (small.length >= 2 && small.every((t) => big.includes(t))) return e.counts;
  }
  return null;
}

// ─────────────────────────────────────────────
// Format
// ─────────────────────────────────────────────
function totalOf(g) {
  if (!g) return 0;
  if (g.total) return g.total;
  return (g.adults || 0) + (g.children || 0);
}

// ข้อความไทย: "3 ท่าน (ผู้ใหญ่ 2 / เด็ก 1)" | "2 ท่าน" | "ไม่ระบุ"
function formatGuestsTh(g) {
  const t = totalOf(g);
  if (!t) return "ไม่ระบุ";
  if (g.children > 0 && g.adults > 0) return t + " ท่าน (ผู้ใหญ่ " + g.adults + " / เด็ก " + g.children + ")";
  if (g.children > 0) return t + " ท่าน (เด็ก " + g.children + ")";
  return t + " ท่าน";
}

// บรรทัดสำหรับข้อความ LINE
// อีโมจินำหน้าตามจำนวนแขก: 1 👤 · 2 👥 · 3 คนขึ้นไป 🫂 · ไม่ระบุ ❓
function guestEmoji(g) {
  const t = totalOf(g);
  if (!t) return "\u2753";
  if (t === 1) return "\u{1F464}";
  if (t === 2) return "\u{1F465}";
  return "\u{1FAC2}";
}

function guestsLine(g) {
  return guestEmoji(g) + " " + formatGuestsTh(g);
}

// ─────────────────────────────────────────────
// Sheet1 helpers (หาคอลัมน์จากชื่อหัวตาราง)
// ─────────────────────────────────────────────
function colLetter(n) { // 0-based → A, B, ... AA
  let s = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function guestColIndexes(header) {
  const h = (header || []).map((x) => String(x || "").trim());
  return {
    adults: h.indexOf(GUEST_HEADERS.adults),
    children: h.indexOf(GUEST_HEADERS.children),
    total: h.indexOf(GUEST_HEADERS.total),
  };
}

// อ่านจำนวนแขกจากแถวใน Sheet1 → { adults, children, total } | null
function guestsFromRow(row, idx) {
  if (!row || !idx) return null;
  const a = idx.adults >= 0 ? num(row[idx.adults]) : null;
  const c = idx.children >= 0 ? num(row[idx.children]) : null;
  const t = idx.total >= 0 ? num(row[idx.total]) : null;
  if (a === null && c === null && t === null) return null;
  const adults = a === null ? 0 : a;
  const children = c === null ? 0 : c;
  // ถ้าแอดมินกรอกเฉพาะ Guests (รวม) เอง → ใช้ยอดรวมนั้น ไม่มีรายละเอียดแยก
  const total = t !== null && t > 0 ? t : adults + children;
  return { adults, children, total };
}

// วางแผนว่าแถวไหนของ Sheet1 ควรถูกเติมจำนวนแขก (ฟังก์ชันล้วน ไม่แตะ Sheets — ทดสอบได้)
//   rows   = ค่าจาก Sheet1 (แถวแรกคือหัวตาราง)
//   parsed = [{ resId, guests }] จากอีเมลที่ parse ได้ในรอบนี้
//   index  = buildGuestIndex(emails)
// ลำดับ: จับด้วย ResId ก่อน → ถ้าไม่ได้ ใช้ ชื่อ+วันเช็คอิน จากอีเมลคู่ (ครอบคลุมแถวที่ ResId ไม่ตรง/แก้มือ/ห้อง Mycondo)
// ไม่แตะ: แถวที่มีจำนวนแขกอยู่แล้ว, แถวยกเลิก, แถวที่เช็คเอาท์แล้ว
function planGuestFills(rows, parsed, index, todayIso) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map((x) => String(x || "").trim());
  const col = (name, fallback) => (header.indexOf(name) >= 0 ? header.indexOf(name) : fallback);
  const cRoom = col("เลขห้อง", 0), cName = col("ชื่อแขก", 1), cIn = col("เช็คอิน", 2), cOut = col("เช็คเอาท์", 3), cRes = col("ResId", 5);
  const gi = guestColIndexes(header);
  const byRes = new Map((parsed || []).filter((p) => p.guests).map((p) => [p.resId, p.guests]));
  const iso = (v) => { const m = String(v || "").trim().match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ""; };
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (guestsFromRow(row, gi)) continue; // มีค่าแล้ว (รวมที่แอดมินกรอกเอง) ไม่ทับ
    if (/cancel|ยกเลิก/i.test(String(row[cRoom] || ""))) continue;
    const checkOut = iso(row[cOut]);
    if (todayIso && checkOut && checkOut < todayIso) continue;
    let g = byRes.get(String(row[cRes] || "").trim()) || null;
    if (!g) g = lookupGuests(index, { guest: String(row[cName] || ""), checkIn: iso(row[cIn]) });
    if (g && totalOf(g) > 0) out.push({ row: i + 1, g });
  }
  return out;
}

let _colCache = null;
// หาคอลัมน์ Adults/Children/Guests ใน Sheet1 — ถ้ายังไม่มีหัวตารางให้สร้างต่อท้าย
async function ensureGuestColumns(sheets, sheetId, sheetName) {
  if (_colCache) return _colCache;
  const got = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: sheetName + "!1:1" });
  const header = (got.data.values && got.data.values[0]) || [];
  const idx = guestColIndexes(header);
  let next = header.length;
  const writes = [];
  for (const k of ["adults", "children", "total"]) {
    if (idx[k] < 0) {
      idx[k] = next++;
      writes.push({ range: sheetName + "!" + colLetter(idx[k]) + "1", values: [[GUEST_HEADERS[k]]] });
    }
  }
  if (writes.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: "RAW", data: writes },
    });
    console.log("guests: เพิ่มหัวคอลัมน์ใน " + sheetName + " → " + writes.map((w) => w.range).join(", "));
  }
  _colCache = idx;
  return idx;
}

// เขียนจำนวนแขกหลายแถวในคำขอเดียว (rows = [{ row: เลขแถว 1-based, g: {adults, children} }])
// ไม่เขียนแถวที่ไม่มีข้อมูล — เว้นว่างไว้ให้ข้อความแสดง "ไม่ระบุ" ดีกว่าเดา
async function writeGuestsToRows(sheets, sheetId, sheetName, rows) {
  const todo = (rows || []).filter((r) => r && r.row && r.g && totalOf(r.g) > 0);
  if (!todo.length) return 0;
  const idx = await ensureGuestColumns(sheets, sheetId, sheetName);
  const data = [];
  for (const { row, g } of todo) {
    data.push({ range: sheetName + "!" + colLetter(idx.adults) + row, values: [[g.adults || 0]] });
    data.push({ range: sheetName + "!" + colLetter(idx.children) + row, values: [[g.children || 0]] });
    data.push({ range: sheetName + "!" + colLetter(idx.total) + row, values: [[totalOf(g)]] });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: "RAW", data },
  });
  return todo.length;
}

async function writeGuestsToRow(sheets, sheetId, sheetName, rowNumber, g) {
  return (await writeGuestsToRows(sheets, sheetId, sheetName, [{ row: rowNumber, g }])) > 0;
}

module.exports = {
  GUEST_HEADERS,
  parseAirbnbGuests, parseLhDetailGuests, parseTripGuests, countsFromSegment,
  nameKey, nameTokens, isGuestOnlyEmail, extractGuestEntry, buildGuestIndex, lookupGuests,
  totalOf, formatGuestsTh, guestEmoji, guestsLine, planGuestFills,
  colLetter, guestColIndexes, guestsFromRow, ensureGuestColumns, writeGuestsToRow, writeGuestsToRows,
};
