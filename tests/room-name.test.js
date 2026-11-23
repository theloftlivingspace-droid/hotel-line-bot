const assert = require("assert");
const { buildRoomNameIndex, fillRoomName } = require("../room-name.js");

// ฉบับสั้นมีชื่อห้อง, ฉบับ Detail ชื่อห้องว่าง (เคส Loïc Gimenes 2026-11-28)
const short  = { guest: "Loïc Gimenes", checkIn: "2026-11-28", roomName: "The loft radiance living space" };
const detail = { guest: "Loïc Gimenes", checkIn: "2026-11-28", roomName: "" };
const idx = buildRoomNameIndex([detail, short]); // ลำดับไม่มีผล
assert.strictEqual(fillRoomName(detail, idx), true);
assert.strictEqual(detail.roomName, "The loft radiance living space");

// ชื่อห้องมีอยู่แล้ว ห้ามทับ
const has = { guest: "Loïc Gimenes", checkIn: "2026-11-28", roomName: "Allure" };
assert.strictEqual(fillRoomName(has, idx), false);
assert.strictEqual(has.roomName, "Allure");

// คนละวันเช็คอิน / คนละแขก ห้ามเอามาปน
const otherDay = { guest: "Loïc Gimenes", checkIn: "2026-12-05", roomName: "" };
assert.strictEqual(fillRoomName(otherDay, idx), false);
const otherGuest = { guest: "Someone Else", checkIn: "2026-11-28", roomName: "" };
assert.strictEqual(fillRoomName(otherGuest, idx), false);
assert.strictEqual(otherGuest.roomName, "");

// ไม่มีฉบับพี่น้อง → คงเดิม (ยังขึ้นการ์ดให้แอดมินระบุห้อง)
assert.strictEqual(fillRoomName({ guest: "A B", checkIn: "2026-11-28", roomName: "" }, new Map()), false);
console.log("room-name tests passed");
