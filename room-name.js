/**
 * เติมชื่อห้องให้การจองที่อ่านจากอีเมลแบบ Detail แล้วชื่อห้องว่าง
 *
 * LH ส่งอีเมลจองเดียวกันมา 2 ฉบับพร้อมกัน (ฉบับสั้น "X booked the <room> for ..."
 * กับฉบับตาราง "Booking for #...") ฉบับที่ถูกอ่านก่อนจะชนะ ส่วนอีกฉบับถูกข้ามเป็น resId ซ้ำ
 * ถ้าฉบับ Detail ชนะแต่ดึงชื่อห้องไม่ได้ ประเภทห้องจะเป็น null แล้วระบบส่งการ์ด
 * "(รอระบุห้อง)" ทั้งที่ฉบับสั้นมีชื่อห้องครบ → ใช้ชื่อห้องของฉบับพี่น้อง (ชื่อแขก + วันเช็คอิน เดียวกัน)
 */
function roomNameKey(res) {
  const g = String(res.guest || "").toLowerCase().replace(/[^a-z\u0e00-\u0e7f\u4e00-\u9fff]/g, "");
  return g + "|" + res.checkIn;
}

function buildRoomNameIndex(parsed) {
  const idx = new Map();
  for (const res of parsed) {
    if (!res || !res.roomName) continue;
    const k = roomNameKey(res);
    if (!idx.has(k)) idx.set(k, res.roomName);
  }
  return idx;
}

// คืน true ถ้าเติมชื่อห้องให้ res
function fillRoomName(res, idx) {
  if (!res || res.roomName) return false;
  const name = idx.get(roomNameKey(res));
  if (!name) return false;
  res.roomName = name;
  return true;
}

module.exports = { roomNameKey, buildRoomNameIndex, fillRoomName };
