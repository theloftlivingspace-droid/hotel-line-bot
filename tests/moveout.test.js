const assert = require("assert");
const { roomsOfUser, pickMentionedRoom, resolveMoveoutRoom } = require("../moveout.js");

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

console.log("moveout tests OK");
