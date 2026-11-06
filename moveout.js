// ฟังก์ชันล้วน (pure) สำหรับระบบแจ้งย้ายออก — แยกไฟล์เพื่อทดสอบได้โดยไม่ต้องสตาร์ทเซิร์ฟเวอร์

// ห้องทั้งหมดที่ผูกกับ LINE userId นี้ (ผู้เช่า 1 คนมีได้หลายห้อง เช่น 202 + 406)
// ถ้าไม่มีห้องผูกอยู่เลย ให้ fallback ไปที่ roomNumber ที่เก็บในโปรไฟล์ผู้ใช้
function roomsOfUser(rooms, userId, user) {
  const nums = Object.entries(rooms || {})
    .filter(([, r]) => r && r.lineUserId === userId)
    .map(([k]) => String(k));
  if (!nums.length && user && user.roomNumber) nums.push(String(user.roomNumber));
  return nums;
}

// หาเลขห้องที่ผู้เช่าพิมพ์ในข้อความ (เฉพาะห้องของเขาเอง) — คืนค่าเมื่อเจอ "ห้องเดียว" เท่านั้น
// ใช้ขอบเขตตัวเลข กันชนกับปี/วันที่ เช่น "2569" ไม่ถูกมองเป็นห้อง 256
function pickMentionedRoom(text, roomNums) {
  const t = String(text || "");
  const found = (roomNums || []).filter(n => new RegExp(`(^|\\D)${String(n).replace(/[^\w]/g, "")}(\\D|$)`).test(t));
  return found.length === 1 ? found[0] : null;
}

// เลือกห้องสำหรับบันทึกแจ้งย้ายออก: ห้องที่ระบุในข้อความ > ห้องที่เลือกไว้ > ห้องในโปรไฟล์
function resolveMoveoutRoom({ text, roomNums, selected, profileRoom }) {
  const mentioned = pickMentionedRoom(text, roomNums);
  if (mentioned) return mentioned;
  if (selected && (!roomNums.length || roomNums.includes(selected))) return selected;
  return profileRoom || roomNums[0] || null;
}

const THAI_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

// วันที่รูปแบบ YYYY-MM-DD ที่เป็นวันจริง (กัน 2026-02-31)
function isValidIsoDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// "2026-11-15" → "15 พ.ย. 2569"
function formatThaiDateShort(str) {
  if (!isValidIsoDate(str)) return String(str || "");
  const [y, mo, d] = str.split("-").map(Number);
  return `${d} ${THAI_MONTHS_SHORT[mo - 1]} ${y + 543}`;
}

// ─── flow แจ้งย้ายออกผ่าน LINE ─────────────────────────────────
const MOVEOUT_KEYWORDS = ["แจ้งออก", "ย้ายออก", "เลิกเช่า", "คืนห้อง", "สิ้นสัญญา", "ไม่ต่อสัญญา", "ยกเลิกสัญญา", "ออกจากห้อง", "แจ้งย้าย", "ไม่เช่าต่อ"];
const MOVEOUT_NEGATIVE = /ใบเสร็จ|บิล|ใบแจ้ง|ใบกำกับ|เอกสาร|ค่าน้ำ|ค่าไฟ/;

// ข้อความที่ผู้เช่าพิมพ์เพื่อขอแจ้งย้ายออกหรือไม่ (ข้อความสั้น + ไม่ใช่เรื่องเอกสาร/บิล)
function isMoveoutKeyword(text) {
  const t = String(text || "").replace(/\s+/g, "");
  if (!t || t.length > 80 || MOVEOUT_NEGATIVE.test(t)) return false;
  return MOVEOUT_KEYWORDS.some(k => t.includes(k));
}

// เลือกห้องจากข้อความ: "ทุกห้อง/ทั้งหมด/ทั้งสอง" → ทุกห้อง, ระบุเลขห้องเดียว → ห้องนั้น, ไม่ชัด → null
function pickRoomsFromText(text, roomNums) {
  const t = String(text || "");
  if (/ทุกห้อง|ทั้งหมด|ทั้งสอง/.test(t)) return roomNums.slice();
  const one = pickMentionedRoom(t, roomNums);
  return one ? [one] : null;
}

// วันที่ปัจจุบันตามเวลาไทย (YYYY-MM-DD)
function bangkokTodayIso(now = Date.now()) { return new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10); }
function addDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// วันย้ายออกที่เลือกได้: ตั้งแต่พรุ่งนี้ ถึง +90 วัน
function moveoutDateRange(now = Date.now()) {
  const today = bangkokTodayIso(now);
  return { min: addDaysIso(today, 1), max: addDaysIso(today, 90) };
}
function isMoveoutDateInRange(iso, now = Date.now()) {
  if (!isValidIsoDate(iso)) return false;
  const { min, max } = moveoutDateRange(now);
  return iso >= min && iso <= max;
}

// ข้อความตอบผู้เช่า (LINE) เมื่อรับแจ้งย้ายออก — เช็กลิสต์สิ่งที่ต้องเตรียม (รับเลขห้องเดียวหรือหลายห้อง)
function buildMoveoutTenantMessage(roomNums, isoDate) {
  const rooms = [].concat(roomNums).join(", ");
  return `📦 รับแจ้งย้ายออกแล้วค่ะ\n\n🏠 ห้อง: ${rooms}\n📅 วันที่ย้ายออก: ${formatThaiDateShort(isoDate)}\n\n` +
    `กรุณาเตรียมการดังนี้ค่ะ\n` +
    `1️⃣ เตรียมห้องให้พร้อมสำหรับตรวจห้อง\n` +
    `2️⃣ คืนกุญแจ / คีย์การ์ด\n` +
    `3️⃣ เคลียร์ค่าใช้จ่ายให้เรียบร้อย\n\n` +
    `เจ้าหน้าที่จะติดต่อกลับเพื่อนัดตรวจห้องค่ะ 😊`;
}

module.exports = {
  roomsOfUser, pickMentionedRoom, resolveMoveoutRoom, isValidIsoDate, formatThaiDateShort,
  isMoveoutKeyword, pickRoomsFromText, bangkokTodayIso, addDaysIso, moveoutDateRange, isMoveoutDateInRange,
  buildMoveoutTenantMessage,
};
