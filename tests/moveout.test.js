const assert = require("assert");
const { roomsOfUser, pickMentionedRoom, resolveMoveoutRoom, isValidIsoDate, formatThaiDateShort, buildMoveoutTenantMessage,
  isMoveoutKeyword, pickRoomsFromText, bangkokTodayIso, addDaysIso, addMonthsIso, endOfMonthIso, moveoutDateRange, isMoveoutDateInRange } = require("../moveout.js");

const rooms = { 202: { lineUserId: "U1" }, 406: { lineUserId: "U1" }, 113: { lineUserId: "U2" } };
assert.deepStrictEqual(roomsOfUser(rooms, "U1", {}).sort(), ["202", "406"]);
assert.deepStrictEqual(roomsOfUser(rooms, "U9", { roomNumber: "305" }), ["305"]);
assert.deepStrictEqual(roomsOfUser(rooms, "U9", {}), []);

// เคสจริง 9 ต.ค.: ผู้เช่า 202+406 พิมพ์ "ห้อง 202 ย้ายออกวันที่ 15 พ.ย.2569"
assert.strictEqual(pickMentionedRoom("ห้อง 202  ย้ายออกวันที่ 15 พ.ย.2569", ["202", "406"]), "202");
assert.strictEqual(pickMentionedRoom("ย้ายออกวันที่ 15 พ.ย.2569", ["202", "406"]), null); // ปี 2569 ต้องไม่ชนห้อง
assert.strictEqual(pickMentionedRoom("202 กับ 406 ย้ายออกทั้งคู่", ["202", "406"]), null); // กำกวม → ให้ถามต่อ
assert.strictEqual(pickMentionedRoom("ห้อง 113 ย้ายออก", ["202", "406"]), null); // ห้องคนอื่นไม่นับ
assert.strictEqual(pickMentionedRoom("ย้ายออก 20/2/69", ["202"]), null);

const base = { roomNums: ["202", "406"], profileRoom: "406" };
assert.strictEqual(resolveMoveoutRoom({ ...base, text: "ห้อง 202 ย้ายออก 15 พ.ย.2569", selected: null }), "202");
assert.strictEqual(resolveMoveoutRoom({ ...base, text: "ย้ายออก 15 พ.ย.2569", selected: "202" }), "202");
assert.strictEqual(resolveMoveoutRoom({ ...base, text: "ย้ายออก 15 พ.ย.2569", selected: null }), "406");
assert.strictEqual(resolveMoveoutRoom({ roomNums: ["202"], text: "x", selected: "999", profileRoom: "202" }), "202");
assert.strictEqual(resolveMoveoutRoom({ roomNums: [], text: "x", selected: null, profileRoom: null }), null);

assert.strictEqual(isValidIsoDate("2026-11-15"), true);
assert.strictEqual(isValidIsoDate("2026-02-31"), false);
assert.strictEqual(isValidIsoDate("15/11/2026"), false);
assert.strictEqual(isValidIsoDate(""), false);
assert.strictEqual(formatThaiDateShort("2026-11-15"), "15 พ.ย. 2569");
assert.strictEqual(formatThaiDateShort("2026-01-05"), "5 ม.ค. 2569");
assert.strictEqual(formatThaiDateShort("bad"), "bad");

const msg = buildMoveoutTenantMessage("202", "2026-11-15");
assert.ok(msg.includes("ห้อง: 202") && msg.includes("15 พ.ย. 2569"));
assert.ok(msg.includes("ตรวจห้อง") && msg.includes("คืนกุญแจ") && msg.includes("เคลียร์ค่าใช้จ่าย"));

// keyword
for (const k of ["แจ้งออก", "ย้ายออก", "เลิกเช่า", "คืนห้อง", "ห้อง 202 ขอย้ายออกวันที่ 15 พ.ย. ค่ะ", "สิ้นสัญญา", "ไม่ต่อสัญญา", "ยกเลิกสัญญา"]) assert.strictEqual(isMoveoutKeyword(k), true, k);
for (const k of ["", "สวัสดีค่ะ", "ขอใบเสร็จออกวันที่ 5", "แจ้งออกใบแจ้งหนี้ให้หน่อย", "ค่าไฟเดือนนี้เท่าไหร่", "แจ้งโอนแล้วค่ะ"]) assert.strictEqual(isMoveoutKeyword(k), false, k);
assert.strictEqual(isMoveoutKeyword("ย้ายออก ".repeat(30)), false); // ยาวผิดปกติ

// เลือกห้อง
assert.deepStrictEqual(pickRoomsFromText("ทุกห้อง", ["202", "406"]), ["202", "406"]);
assert.deepStrictEqual(pickRoomsFromText("ห้อง 406", ["202", "406"]), ["406"]);
assert.strictEqual(pickRoomsFromText("อะไรก็ได้", ["202", "406"]), null);

// วันที่ (เวลาไทย): 2026-11-06 20:00 UTC = 7 พ.ย. 03:00 ไทย
const NOW = Date.UTC(2026, 10, 6, 20, 0, 0);
assert.strictEqual(bangkokTodayIso(NOW), "2026-11-07");
assert.strictEqual(addDaysIso("2026-11-30", 1), "2026-12-01");
assert.strictEqual(addDaysIso("2026-12-31", 1), "2027-01-01");
// กฎสัญญา: ล่วงหน้า ≥ 1 เดือน, เลือกได้ไม่เกินสิ้นเดือนของ +3 เดือน (วันนี้ไทย = 7 พ.ย. 2026 → 7 ธ.ค. – 28 ก.พ. 2027)
assert.deepStrictEqual(moveoutDateRange(NOW), { min: "2026-12-07", max: "2027-02-28" });
for (const d of ["2026-12-07", "2026-12-31", "2027-01-15", "2027-02-28"]) assert.strictEqual(isMoveoutDateInRange(d, NOW), true, d);
for (const d of ["2026-12-06", "2026-11-30", "2026-11-15", "2027-03-01"]) assert.strictEqual(isMoveoutDateInRange(d, NOW), false, d);
// ตัวอย่างจริง: แจ้ง 9 ต.ค. 2026 → 9 พ.ย. – 31 ม.ค. 2027
const OCT9 = Date.UTC(2026, 9, 9, 5, 0, 0);
assert.deepStrictEqual(moveoutDateRange(OCT9), { min: "2026-11-09", max: "2027-01-31" });
assert.strictEqual(isMoveoutDateInRange("2026-11-15", OCT9), true);
// ขอบเดือน
assert.strictEqual(addMonthsIso("2027-01-31", 1), "2027-02-28");
assert.strictEqual(addMonthsIso("2028-01-31", 1), "2028-02-29");
assert.strictEqual(addMonthsIso("2026-12-15", 1), "2027-01-15");
assert.strictEqual(endOfMonthIso("2026-02-10"), "2026-02-28");
assert.deepStrictEqual(moveoutDateRange(Date.UTC(2026, 9, 31, 5, 0, 0)), { min: "2026-11-30", max: "2027-01-31" });
assert.strictEqual(isMoveoutDateInRange("garbage", NOW), false);
assert.ok(buildMoveoutTenantMessage(["202", "406"], "2026-11-15").includes("ห้อง: 202, 406"));

console.log("moveout tests OK");
