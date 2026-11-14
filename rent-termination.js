// สิ้นสุดสัญญาอัตโนมัติ: เลยวันที่ 15 แล้วยังไม่ชำระค่าเช่า — ฟังก์ชันล้วน (pure) ทดสอบได้โดยไม่ต้องสตาร์ทเซิร์ฟเวอร์

const TERMINATE_FROM_DAY = 16;   // วันแรกที่เลยวันที่ 15
const TERMINATE_UNTIL_DAY = 20;  // ช่วงเผื่อรอบ cron พลาด (ส่งซ้ำไม่ได้ เพราะมี flag รายเดือน/รายห้อง)

// ข้อความถึงผู้เช่า (LINE)
function buildRentTerminationMessage(roomNum) {
  return `📕 แจ้งสิ้นสุดสัญญาเช่า ห้อง ${roomNum}\n\n` +
    `ตามที่ได้แจ้งเตือนไปแล้ว ไม่พบการชำระค่าเช่าภายในวันที่ 15 ของเดือน จึงถือว่าสัญญาเช่าสิ้นสุดลงตามสัญญาค่ะ\n\n` +
    `กรุณาดำเนินการดังนี้ค่ะ\n` +
    `1️⃣ คืนห้อง\n` +
    `2️⃣ คืนคีย์การ์ดและกุญแจ\n` +
    `โดยติดต่อเจ้าหน้าที่เพื่อนัดตรวจห้องและส่งมอบค่ะ\n\n` +
    `ทั้งนี้ ทางบริษัทขอสงวนสิทธิ์เรียกเก็บค่าเช่าค้างชำระ ค่าปรับ และค่าเสียหายอื่นๆ ตามสัญญา\n\n` +
    `หากชำระแล้ว กรุณาส่งสลิปในแชทนี้ทันทีค่ะ 🙏`;
}

// ข้อความเข้ากลุ่มแม่บ้าน: ล็อคห้อง + ยกเลิกคีย์การ์ด (ไม่ใส่ชื่อ/ยอดเงิน)
function buildHousekeepingLockMessage(roomNums) {
  return `🔒 ห้อง ${[].concat(roomNums).join(", ")} สิ้นสุดสัญญา (ค้างชำระค่าเช่าเกินวันที่ 15)\n\n` +
    `• กรุณาล็อคห้อง\n• ยกเลิกคีย์การ์ด\n\n` +
    `ถ้าผู้เช่าชำระแล้ว แอดมินจะแจ้งอีกครั้งค่ะ`;
}

// ตัวกันพลาด: ถ้าห้องที่จะสิ้นสุดสัญญามีจำนวนมากผิดปกติ (เช่น รอบบิลเพิ่งเปลี่ยนทำให้ทุกห้องดูเหมือนยังไม่จ่าย) → ไม่ส่งอัตโนมัติ
function exceedsMassLimit(candidateCount, tenantCount) {
  return candidateCount > Math.max(3, Math.ceil(tenantCount * 0.3));
}

function inTerminationWindow(day) { return day >= TERMINATE_FROM_DAY && day <= TERMINATE_UNTIL_DAY; }

module.exports = { TERMINATE_FROM_DAY, TERMINATE_UNTIL_DAY, buildRentTerminationMessage, buildHousekeepingLockMessage, exceedsMassLimit, inTerminationWindow };
