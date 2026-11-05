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

module.exports = { roomsOfUser, pickMentionedRoom, resolveMoveoutRoom };
