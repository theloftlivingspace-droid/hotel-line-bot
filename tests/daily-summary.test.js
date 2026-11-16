const assert = require("assert");
const D = require("../daily-summary.js");

// สร้าง CSV จำลอง (ชื่อแขกสมมติ) — รวมกรณีจริง: หมายเหตุหลายบรรทัด, แถวซ้ำ, ห้อง block, ของลืมยังไม่แจ้ง, ready ว่าง
const HEAD = ["UID","Date","Time","Inspector","Room","OTA","Guest","Status","Ready","Issues","Damages","Charge(THB)","ChargeNote","ElecUnit","ElecTHB","LateCheckout","Repairs","ExtraNote","Photo","Timestamp","FullJSON"];
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
function row(o) {
  const j = Object.assign({ roomStatus: "normal", ready: "พร้อม", damages: [], repairs: [], isCritical: false, leftBehind: "ไม่มี", extraNote: "", timestamp: 1 }, o.json || {});
  const cells = [o.uid, o.date, "10:00", "Inspector", o.room, "Airbnb", "Guest A", j.roomStatus, j.ready, "", "", 0, "", 0, 0, "ไม่มี", "", j.extraNote, "", "2026-11-16T03:00:00.000Z", JSON.stringify(j)];
  return cells.map(q).join(",");
}
const csv = [HEAD.map(q).join(",")].concat([
  row({ uid: "a", date: "2026-11-16", room: "113 — Legacy" }),
  row({ uid: "b1", date: "2026-11-16", room: "103 — Elegance", json: { timestamp: 1, ready: "พร้อม" } }),
  row({ uid: "b2", date: "2026-11-16", room: "103 — Elegance", json: { timestamp: 2, roomStatus: "block", ready: "ยังไม่พร้อม" } }),
  row({ uid: "c", date: "2026-11-16", room: "214 — Legacy", json: { leftBehind: "มี-ยังไม่แจ้ง", extraNote: "ชามแตก 2 ใบ\nมีกลิ่นกัญชา" } }),
  row({ uid: "d", date: "2026-11-15", room: "205 — Allure" }),
]).join("\r\n");

// 1) CSV: หมายเหตุหลายบรรทัดต้องไม่แตกเป็นหลายแถว
const logs = D.parseCheckoutLog(csv);
assert.strictEqual(logs.length, 5);
assert.ok(logs.find((l) => l.uid === "c").extraNote.includes("\n"));

// 2) ตัดแถวซ้ำ: 103 วันเดียวกันมี 2 แถว → ใช้แถว timestamp ล่าสุด (block)
let s = D.buildEveningSummary({ date: "2026-11-16", expectedRooms: ["113", "103", "214", "209"], logs });
assert.strictEqual(s.inspected, 3);
assert.deepStrictEqual(s.ready.sort(), ["113", "214"]);
assert.deepStrictEqual(s.notReady, [{ room: "103", reason: "ห้องถูกบล็อก" }]);
assert.deepStrictEqual(s.missing, ["209"]);           // เช็คเอาท์วันนี้แต่ไม่มีรายงาน
assert.strictEqual(s.followUps.length, 1);
assert.deepStrictEqual(s.followUps[0].reasons, ["ของลืมยังไม่แจ้งแขก"]);
assert.strictEqual(D.shouldSendEvening(s), true);

// 3) "พร้อม" ต้องไม่ถูกจับจาก "ยังไม่พร้อม"
assert.strictEqual(D.isReadyForGuests({ status: "normal", ready: "ยังไม่พร้อม" }), false);
assert.strictEqual(D.isReadyForGuests({ status: "normal", ready: "" }), false);
assert.strictEqual(D.isReadyForGuests({ status: "block", ready: "พร้อม" }), false);
assert.strictEqual(D.isReadyForGuests({ status: "normal", ready: "พร้อม" }), true);

// 4) ทุกห้องพร้อมและไม่มีเรื่องต้องตาม → ไม่ส่ง
const clean = D.parseCheckoutLog([HEAD.map(q).join(","), row({ uid: "x", date: "2026-11-16", room: "113" }), row({ uid: "y", date: "2026-11-16", room: "209" })].join("\n"));
s = D.buildEveningSummary({ date: "2026-11-16", expectedRooms: ["113", "209"], logs: clean });
assert.strictEqual(D.shouldSendEvening(s), false);

// 5) พร้อม แต่มีงานซ่อม/ความเสียหาย/ธงวิกฤต → ยังส่ง; Late Checkout อย่างเดียวไม่นับ
const flagged = D.parseCheckoutLog([HEAD.map(q).join(","), row({ uid: "x", date: "2026-11-16", room: "113", json: { repairs: ["งานสี"] } })].join("\n"));
assert.strictEqual(D.shouldSendEvening(D.buildEveningSummary({ date: "2026-11-16", expectedRooms: ["113"], logs: flagged })), true);
const lateOnly = D.parseCheckoutLog([HEAD.map(q).join(","), row({ uid: "x", date: "2026-11-16", room: "113", json: { damages: ["Late Checkout"] } })].join("\n"));
assert.strictEqual(D.shouldSendEvening(D.buildEveningSummary({ date: "2026-11-16", expectedRooms: ["113"], logs: lateOnly })), false);

// 6) วันไม่มีเช็คเอาท์และไม่มีรายงาน → ไม่ส่ง
assert.strictEqual(D.shouldSendEvening(D.buildEveningSummary({ date: "2026-11-17", expectedRooms: [], logs })), false);

// 7) ข้อความ: ไม่มีชื่อแขก, ตัดหมายเหตุยาว
const msg = D.buildEveningMessage(D.buildEveningSummary({ date: "2026-11-16", expectedRooms: ["113", "103", "214", "209"], logs }), "วันจันทร์ที่ 16 พฤศจิกายน 2569");
assert.ok(msg.includes("ตรวจแล้ว 3 จาก 4 ห้อง") && msg.includes("ห้อง 209") && msg.includes("ของลืมยังไม่แจ้งแขก"));
assert.ok(!msg.includes("Guest A"));

// 8) แผนเช้า: ห้องที่เช็คเอาท์แล้วมีแขกใหม่เข้าวันเดียวกัน + ค้างจากเมื่อวาน
const plan = D.buildMorningPlan({
  today: { checkIns: [{ room: "113" }, { room: "300" }], checkOuts: [{ room: "113" }, { room: "205" }], stayOvers: [] },
  yesterdayLogs: D.dedupeLatest(logs.filter((l) => l.date === "2026-11-16")),
});
assert.deepStrictEqual(plan.turnover, ["113"]);
assert.deepStrictEqual(plan.carry.map((c) => c.room), ["214"]);
assert.strictEqual(D.shouldSendMorning(plan), true);
assert.strictEqual(D.shouldSendMorning({ checkIns: 0, checkOuts: 0, stayOvers: 0, turnover: [], carry: [] }), false);
console.log("daily-summary tests OK");
