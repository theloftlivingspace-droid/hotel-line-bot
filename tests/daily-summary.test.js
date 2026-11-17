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

// ── Flex ──
(function flexTests() {
  const walk = (n, f) => { f(n); (n.contents || []).forEach((c) => walk(c, f)); };
  const sEve = D.buildEveningSummary({ date: "2026-11-16", expectedRooms: ["113", "103", "214", "209"], logs });
  const ev = D.buildEveningFlex(sEve, "วันจันทร์ที่ 16 พฤศจิกายน 2569", { dashboardUrl: "https://example.com/admin" });
  assert.strictEqual(ev.type, "flex");
  assert.ok(ev.altText.length > 0 && ev.altText.length <= 400);
  assert.strictEqual(ev.contents.type, "bubble");
  assert.strictEqual(ev.contents.footer.contents[0].action.uri, "https://example.com/admin");
  let n = 0;
  for (const part of ["header", "body", "footer"]) walk(ev.contents[part], (x) => { if (x.type === "text") { n++; assert.ok(x.text && x.text.trim() !== "", "ข้อความว่างใน Flex"); } });
  assert.ok(n > 5);
  assert.ok(!JSON.stringify(ev).includes("Guest A"));
  // ไม่มี URL หรือไม่ใช่ https → ไม่มีปุ่ม (LINE ปฏิเสธ uri ที่ไม่ใช่ https)
  assert.strictEqual(D.buildEveningFlex(sEve, "x", {}).contents.footer, undefined);
  assert.strictEqual(D.buildEveningFlex(sEve, "x", { dashboardUrl: "http://x" }).contents.footer, undefined);
  const mp = D.buildMorningFlex(D.buildMorningPlan({ today: { checkIns: [{ room: "113" }], checkOuts: [{ room: "113" }], stayOvers: [] }, yesterdayLogs: [] }), "x", {});
  assert.strictEqual(mp.type, "flex");
  assert.ok(JSON.stringify(mp).includes("ทำก่อน"));
  console.log("daily-summary flex tests OK");
})();

// ── การตั้งค่า / เวลา ──
(function settingsTests() {
  const d = D.DEFAULT_SETTINGS;
  assert.deepStrictEqual(D.normalizeSettings(null), d);
  const n = D.normalizeSettings({ morning: { enabled: false, time: "06:05" }, evening: { time: "25:99", onlyWhenFlagged: false } });
  assert.strictEqual(n.morning.enabled, false);
  assert.strictEqual(n.morning.time, "06:05");
  assert.strictEqual(n.evening.time, "18:30");              // เวลาผิดรูปแบบ → ใช้ค่าเริ่มต้น
  assert.strictEqual(n.evening.onlyWhenFlagged, false);
  assert.ok(!("onlyWhenFlagged" in n.morning));
  assert.strictEqual(D.isDue("18:30", 18 * 60 + 29), false);
  assert.strictEqual(D.isDue("18:30", 18 * 60 + 30), true);
  assert.strictEqual(D.isDue("18:30", 19 * 60 + 29), true);   // ตื่นช้าก็ยังส่งตาม (catch-up 60 นาที)
  assert.strictEqual(D.isDue("18:30", 19 * 60 + 30), false);
  const calm = D.buildEveningSummary({ date: "2026-11-16", expectedRooms: ["113"], logs: D.parseCheckoutLog([HEAD.map(q).join(","), row({ uid: "x", date: "2026-11-16", room: "113" })].join("\n")) });
  assert.strictEqual(D.shouldSendEveningWith(calm, { onlyWhenFlagged: true }), false);
  assert.strictEqual(D.shouldSendEveningWith(calm, { onlyWhenFlagged: false }), true);   // ปิด "เฉพาะเมื่อมีเรื่อง" → ส่งทุกวันที่มีเช็คเอาท์
  const none = D.buildEveningSummary({ date: "2026-11-17", expectedRooms: [], logs: [] });
  assert.strictEqual(D.shouldSendEveningWith(none, { onlyWhenFlagged: false }), false);  // ไม่มีเช็คเอาท์/รายงาน → ไม่ส่งแน่นอน
  const h = D.historyEntry({ kind: "evening", date: "2026-11-16", decision: "sent", text: "x".repeat(5000) });
  assert.ok(h.text.length <= 1500 && h.at);
  console.log("daily-summary settings tests OK");
})();

// ── กลุ่มแม่บ้าน / ราคาเป้าหมาย / AI สรุปหมายเหตุ ──
(function groupPriceAiTests() {
  // settings ใหม่
  const n = D.normalizeSettings({ morning: { recipients: "both", includePrices: true }, evening: { aiSummary: true } });
  assert.strictEqual(n.morning.recipients, "both");
  assert.strictEqual(n.morning.includePrices, true);
  assert.strictEqual(n.evening.aiSummary, true);
  assert.strictEqual(D.normalizeSettings({ morning: { recipients: "everyone" } }).morning.recipients, "admin");   // ค่าแปลก → ค่าเริ่มต้น
  assert.strictEqual(D.normalizeSettings({ morning: { includePrices: "yes" } }).morning.includePrices, false);
  assert.ok(!("recipients" in D.normalizeSettings(null).evening));                                                 // การ์ดเย็นส่งแอดมินเท่านั้น

  // ราคาเป้าหมาย
  const csvIso = "Date,RoomType,Rate,Occ%,DaysAhead,UpdatedAt\n2026-11-17,Luxury,1900,0.5,0,x\n2026-11-17,Retro,1500,0.6,0,x\n2026-11-18,Luxury,2100,0.5,1,x\n";
  assert.deepStrictEqual(D.parseTargetRates(csvIso, "2026-11-17"), { Luxury: 1900, Retro: 1500 });
  const csvDmy = "Date,RoomType,Rate\n17/11/2026,Legacy,\"1,234\"\n";
  assert.deepStrictEqual(D.parseTargetRates(csvDmy, "2026-11-17", "dmy"), { Legacy: 1234 });
  assert.strictEqual(D.parseTargetRates(csvDmy, "2026-11-17", "mdy"), null);          // อ่านเป็น m/d → เดือน 17 ไม่มี → ไม่เจอวันนี้ → null ไม่เดา
  assert.strictEqual(D.parseTargetRates(csvIso, "2026-12-01"), null);                  // ไม่มีข้อมูลวันนั้น → null (ไม่ใช้ราคาเก่า)
  assert.strictEqual(D.parseTargetRates("a,b\n1,2\n", "2026-11-17"), null);            // โครงสร้างผิด → null
  assert.strictEqual(D.formatPrices({ Retro: 1500, Luxury: 1900 }), "Luxury ฿1,900 · Retro ฿1,500");

  // ข้อความเช้า: แอดมินเห็นราคา+ค้างจากเมื่อวาน ; กลุ่มแม่บ้านไม่เห็น และไม่มีปุ่มแดชบอร์ด
  const plan = D.buildMorningPlan({ today: { checkIns: [{ room: "113" }], checkOuts: [{ room: "113" }], stayOvers: [] }, yesterdayLogs: [{ room: "214", damages: [], repairs: [], isCritical: true, leftBehind: "ไม่มี" }] });
  const prices = { Luxury: 1900 };
  const adminTxt = D.buildMorningMessage(plan, "x", { prices }), groupTxt = D.buildMorningMessage(plan, "x", { audience: "group", prices });
  assert.ok(adminTxt.includes("ราคาเป้าหมาย") && adminTxt.includes("ค้างจากเมื่อวาน"));
  assert.ok(!groupTxt.includes("ราคา") && !groupTxt.includes("ค้างจากเมื่อวาน") && groupTxt.includes("ทำก่อน"));
  const gFlex = D.buildMorningFlex(plan, "x", { audience: "group", prices, dashboardUrl: "https://example.com" });
  assert.strictEqual(gFlex.contents.footer, undefined);
  assert.ok(!JSON.stringify(gFlex).includes("ราคา") && !JSON.stringify(gFlex).includes("ค้างจากเมื่อวาน"));
  assert.ok(JSON.stringify(D.buildMorningFlex(plan, "x", { prices, dashboardUrl: "https://example.com" })).includes("ราคาเป้าหมาย"));

  // AI: ตรวจสเปกผลลัพธ์
  const raw = '```json\n[{"room":"103","summary":"แก้วแตก 1 ใบ","needsAttention":true},{"room":"999","summary":"ห้องที่ไม่ได้ส่ง","needsAttention":true},{"room":"214","summary":"  ", "needsAttention":true},{"room":"113","summary":"' + "ก".repeat(300) + '"}]\n```';
  const v = D.validateAiNotes(raw, ["103", "214", "113"]);
  assert.deepStrictEqual(Object.keys(v).sort(), ["103", "113"]);                      // ห้องนอกรายการ / summary ว่าง ถูกตัด
  assert.strictEqual(v["113"].summary.length, 120);
  assert.strictEqual(v["113"].needsAttention, false);                                  // ไม่ใช่ true ชัดเจน → false
  assert.deepStrictEqual(D.validateAiNotes("ไม่ใช่ JSON", ["103"]), {});
  assert.deepStrictEqual(D.validateAiNotes('{"room":"103"}', ["103"]), {});
  // AI: เติมลงการ์ดเย็น
  const base = D.buildEveningSummary({ date: "2026-11-16", expectedRooms: ["113", "103"], logs: logs.filter((l) => l.date === "2026-11-16") });
  assert.ok(Array.isArray(base.notes));
  const withAi = D.applyAiNotes(base, { "214": { summary: "ชามแตก มีกลิ่นผิดปกติ", needsAttention: true }, "113": { summary: "เรียบร้อย", needsAttention: false }, "103": { summary: "แก้วแตก 1 ใบ", needsAttention: true } });
  const f214 = withAi.followUps.find((f) => f.room === "214"), f103 = withAi.followUps.find((f) => f.room === "103");
  assert.strictEqual(f214.ai, "ชามแตก มีกลิ่นผิดปกติ");                               // ห้องที่ติดธงอยู่แล้ว → ได้สรุปเพิ่ม
  assert.ok(f103 && f103.fromAi);                                                      // ห้องที่ไม่ติดธง แต่ AI เห็นว่าต้องใส่ใจ → เพิ่ม
  assert.ok(!withAi.followUps.some((f) => f.room === "113"));                          // needsAttention=false → ไม่เพิ่ม
  assert.strictEqual(D.applyAiNotes(base, null), base);
  const aiMsg = D.buildEveningMessage(withAi, "x");
  assert.ok(aiMsg.includes("🤖 ชามแตก มีกลิ่นผิดปกติ") && aiMsg.includes("🤖 แก้วแตก 1 ใบ"));
  assert.ok(JSON.stringify(D.buildEveningFlex(withAi, "x", {})).includes("🤖 แก้วแตก 1 ใบ"));
  // AI ทำให้ "ไม่ส่ง" กลายเป็น "ส่ง" ได้เมื่อพบเรื่องต้องตามจากหมายเหตุ
  const calmLogs = D.parseCheckoutLog([HEAD.map(q).join(","), row({ uid: "x", date: "2026-11-16", room: "103", json: { extraNote: "แก้วแตก 1 ใบ" } })].join("\n"));
  const calm = D.buildEveningSummary({ date: "2026-11-16", expectedRooms: ["103"], logs: calmLogs });
  assert.strictEqual(D.shouldSendEvening(calm), false);
  assert.strictEqual(D.shouldSendEvening(D.applyAiNotes(calm, { "103": { summary: "แก้วแตก 1 ใบ", needsAttention: true } })), true);
  console.log("daily-summary group/price/AI tests OK");
})();
