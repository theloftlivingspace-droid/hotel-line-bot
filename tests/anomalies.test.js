const assert = require("assert");
const AN = require("../anomalies.js");
const nd = (s) => String(s || "").trim();
const hdr = ["ห้อง", "แขก", "เช็คอิน", "เช็คเอาท์", "ช่องทาง", "resId", "note"];
const R = (room, guest, ci, co, res) => [room, guest, ci, co, "Airbnb", res, ""];
const T = "2026-11-20", TM = "2026-11-21";
const base = { today: T, tomorrow: TM, hour: 16, normalizeDate: nd };
const ids = (items) => items.map((i) => i.id);

// ไม่มีเรื่องผิดปกติ: เช็คเอาท์-เช็คอินวันเดียวกัน (turnover) ไม่นับว่าซ้อน
let items = AN.detect(Object.assign({}, base, {
  rows: [hdr, R("203", "A", "2026-11-18", T, "ABB-1"), R("203", "B", T, "2026-11-22", "ABB-2")],
  logs: [{ room: "203" }],
}));
assert.deepStrictEqual(items, []);

// จองซ้อนกัน → high + ข้อความไม่มีชื่อแขก + แถวซ้ำของ resId เดียวกันไม่นับ
items = AN.detect(Object.assign({}, base, {
  rows: [hdr, R("205", "SecretName1", "2026-11-19", "2026-11-23", "ABB-1"), R("205", "SecretName2", "2026-11-22", "2026-11-25", "BKC-2"), R("205", "SecretName1", "2026-11-19", "2026-11-23", "ABB-1")],
  logs: [],
}));
assert.strictEqual(items.length, 1); assert.strictEqual(items[0].type, "overlap"); assert.strictEqual(items[0].severity, "high");
assert.ok(!/SecretName/.test(items[0].text) && /ABB-1/.test(items[0].text));

// ห้อง 363 / ยกเลิก / จองที่จบไปแล้ว ไม่ถูกนับ
items = AN.detect(Object.assign({}, base, {
  rows: [hdr, R("363", "A", "2026-11-20", "2026-11-22", "ABB-1"), R("363", "B", "2026-11-21", "2026-11-23", "ABB-2"),
    R("cancel 204", "C", "2026-11-20", "2026-11-22", "ABB-3"), R("204", "D", "2026-11-20", "2026-11-22", "ABB-4"),
    R("204", "E", "2026-11-01", "2026-11-05", "ABB-5"), R("204", "F", "2026-11-03", "2026-11-07", "ABB-6")],
  logs: [],
}));
assert.deepStrictEqual(items, []);

// ยังไม่ระบุเลขห้อง (วันนี้/พรุ่งนี้ ใช่ · อีกสามวัน ไม่)
items = AN.detect(Object.assign({}, base, {
  rows: [hdr, R("", "G1", TM, "2026-11-23", "ABB-7"), R("", "G2", "2026-11-24", "2026-11-26", "ABB-8")], logs: [],
}));
assert.deepStrictEqual(ids(items), ["unassigned:ABB-7"]);

// เช็คเอาท์แล้วไม่มีรายงาน: ก่อนเวลาตัดรอบไม่เตือน · หลังเวลาเตือนเฉพาะห้องที่ยังไม่มีรายงาน
const rows3 = [hdr, R("203", "A", "2026-11-18", T, "ABB-1"), R("205", "B", "2026-11-18", T, "ABB-2")];
assert.deepStrictEqual(AN.detect(Object.assign({}, base, { rows: rows3, logs: [], hour: 12 })), []);
items = AN.detect(Object.assign({}, base, { rows: rows3, logs: [{ room: "203 — Allure" }] }));
assert.deepStrictEqual(ids(items), ["noreport:205:" + T]);

// เรียง high ก่อน, filterNew กันแจ้งซ้ำ, ข้อความรวม
const mixed = AN.detect(Object.assign({}, base, {
  rows: [hdr, R("203", "A", "2026-11-18", T, "ABB-1"), R("205", "B", "2026-11-19", "2026-11-23", "ABB-2"), R("205", "C", "2026-11-22", "2026-11-24", "ABB-3")], logs: [],
}));
assert.strictEqual(mixed[0].type, "overlap");
const fresh = AN.filterNew(mixed, [mixed[0].id]);
assert.strictEqual(fresh.length, mixed.length - 1);
const txt = AN.buildAlertText(mixed, "20 พ.ย.");
assert.ok(/^⚠️ ตรวจพบความผิดปกติ 2 เรื่อง/.test(txt) && txt.includes("🔴") && txt.includes("🟡"));
console.log("anomalies tests OK");
