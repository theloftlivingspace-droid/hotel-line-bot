const assert = require("assert");
const FC = require("../flex-cards.js");

function walk(n, fn) { if (!n || typeof n !== "object") return; fn(n); (n.contents || []).forEach((c) => walk(c, fn)); }
function check(msg) {
  assert.strictEqual(msg.type, "flex");
  assert.ok(msg.altText && msg.altText.length <= 400, "altText ต้อง 1-400 ตัวอักษร");
  assert.ok(Buffer.byteLength(JSON.stringify(msg)) < 50000, "Flex ต้อง < 50KB");
  const b = msg.contents;
  assert.strictEqual(b.type, "bubble");
  for (const part of ["header", "body", "footer"]) walk(b[part], (x) => {
    if (x.type === "text") assert.ok(x.text && x.text.trim() !== "" && x.text !== "undefined", "ข้อความว่าง/undefined ใน Flex");
    if (x.type === "box") assert.ok(Array.isArray(x.contents) && x.contents.length > 0, "box ว่าง");
  });
}
const it = (room) => ({ room, name: "Guest " + room, meta: "👥 2 ท่าน", note: "มัดจำ 3,000\nรับแล้ว" });

// 19:00 สรุปแม่บ้าน: ครบทุกหมวด / ว่างทั้งหมด / ห้องเยอะ
let m = FC.buildMaidPlanFlex({ checkIns: [it("113"), it("204")], checkOuts: [it("103")], stayOvers: [it("300")], dateLabel: "วันศุกร์ที่ 20 พฤศจิกายน 2569" });
check(m);
assert.ok(m.altText.includes("เช็คอิน 2 ห้อง") && m.altText.includes("ต่อพัก 1 ห้อง"));
check(FC.buildMaidPlanFlex({ checkIns: [], checkOuts: [], stayOvers: [], dateLabel: "x" }));
check(FC.buildMaidPlanFlex({ checkIns: Array.from({ length: 12 }, (_, i) => it("2" + i)), checkOuts: Array.from({ length: 12 }, (_, i) => it("1" + i)), dateLabel: "x" }));
// ค่า undefined/ว่างต้องไม่หลุดเป็นคำว่า undefined
check(FC.buildMaidPlanFlex({ checkIns: [{ room: "113", name: undefined, meta: "", note: null }], checkOuts: [], dateLabel: undefined }));

// การ์ดเหตุการณ์: ข้ามแถวที่ค่าว่าง
const ev = FC.buildEventFlex({ title: "🚫 ยกเลิกการจอง", sub: "ห้อง 204", tone: "red", info: [["ห้อง", "204"], ["แขก", "Guest"], ["ResId", ""], ["เข้าพัก", "2026-11-20 → 2026-11-22"]], altText: "x" });
check(ev);
assert.strictEqual(ev.contents.body.contents.length, 3);
check(FC.buildEventFlex({ title: "t", info: [], callout: { title: "c", bg: FC.C.amberBg, fg: FC.C.amberTx }, note: "โน้ต" }));

// ปุ่มแดชบอร์ดเฉพาะ https
assert.ok(FC.fxBubble({ title: "t", sub: "s", rows: [FC.fx("a")], dashboardUrl: "https://x.co" }).contents.footer);
assert.strictEqual(FC.fxBubble({ title: "t", sub: "s", rows: [FC.fx("a")], dashboardUrl: "http://x.co" }).contents.footer, undefined);

// สวิตช์ย้อนกลับเป็นข้อความ
process.env.BOT_CARD_FORMAT = "text"; assert.strictEqual(FC.useCards(), false);
delete process.env.BOT_CARD_FORMAT; assert.strictEqual(FC.useCards(), true);
console.log("flex-cards tests OK");
