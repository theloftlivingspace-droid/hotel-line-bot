const assert = require("assert");
const { buildRentTerminationMessage, buildHousekeepingLockMessage, exceedsMassLimit, inTerminationWindow } = require("../rent-termination.js");

const m = buildRentTerminationMessage("202");
assert.ok(m.includes("ห้อง 202") && m.includes("สิ้นสุด") && m.includes("คืนห้อง") && m.includes("คีย์การ์ด") && m.includes("สลิป"));

const g = buildHousekeepingLockMessage(["202", "406"]);
assert.ok(g.includes("ห้อง 202, 406") && g.includes("ล็อคห้อง") && g.includes("ยกเลิกคีย์การ์ด"));
assert.ok(!/บาท|ชื่อ/.test(g)); // กลุ่มแม่บ้านไม่เห็นยอดเงิน/ชื่อผู้เช่า

// ตัวกันพลาดรอบบิล: ผู้เช่า 40 ห้อง → จำกัด 12 ห้อง; ผู้เช่า 5 ห้อง → จำกัด 3 ห้อง
assert.strictEqual(exceedsMassLimit(2, 40), false);
assert.strictEqual(exceedsMassLimit(12, 40), false);
assert.strictEqual(exceedsMassLimit(13, 40), true);
assert.strictEqual(exceedsMassLimit(40, 40), true);   // รอบบิลเพิ่งเปลี่ยน → ทุกห้องยังไม่จ่าย
assert.strictEqual(exceedsMassLimit(3, 5), false);
assert.strictEqual(exceedsMassLimit(4, 5), true);

for (const d of [16, 17, 20]) assert.strictEqual(inTerminationWindow(d), true, String(d));
for (const d of [1, 8, 15, 21, 31]) assert.strictEqual(inTerminationWindow(d), false, String(d));
console.log("rent-termination tests OK");
