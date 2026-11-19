"use strict";
// ─── การ์ดรายงานของบอท The Loft — ธีม navy/ทอง (ดีไซน์เดียวกับการ์ด "แผนวันนี้") ───
// ใช้ร่วมกันทุกรายงาน: สรุปแม่บ้าน 19:00, ยกเลิกจอง, Checkout, ย้ายห้อง, โน้ตแม่บ้าน, จองใหม่
// ปิดกลับเป็นข้อความธรรมดาได้ด้วย env BOT_CARD_FORMAT=text (ค่าเริ่มต้น = flex)

const C = {
  navy: "#071B3D", gold: "#D9B25C", ink: "#1B2A41", sub: "#C9D3E3", mute: "#7A8599",
  cream: "#FBF6E9",
  amberBg: "#FFF1D6", amberTx: "#7A4B00",
  redBg: "#FDE7E7", redTx: "#8A1C1C",
  greenBg: "#E4F3E8", greenTx: "#1D6A3B",
};

const useCards = () => (process.env.BOT_CARD_FORMAT || "flex").toLowerCase() !== "text";
const clip = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

const fx = (text, o) => Object.assign({
  type: "text", text: text == null || String(text).trim() === "" ? "-" : String(text), wrap: true, size: "sm", color: C.ink,
}, o || {});

const fxRow = (label, value) => ({ type: "box", layout: "horizontal", contents: [fx(label, { flex: 3 }), fx(value, { flex: 2, align: "end", weight: "bold" })] });
// แถวข้อมูล: ป้ายเทา ๆ ซ้าย / ค่าตัวหนาขวา (ค่ายาวได้ ขึ้นบรรทัดใหม่)
const fxInfo = (label, value) => ({
  type: "box", layout: "horizontal", spacing: "md",
  contents: [fx(label, { flex: 2, size: "xs", color: C.mute }), fx(value, { flex: 5, weight: "bold" })],
});
const fxCallout = (title, body, bg, fg) => ({
  type: "box", layout: "vertical", backgroundColor: bg, cornerRadius: "md", paddingAll: "10px", spacing: "xs",
  contents: [fx(title, { weight: "bold", color: fg }), ...(body ? [fx(body, { size: "xs", color: fg })] : [])],
});
// หัวข้อหมวด เช่น "เช็คอิน (3 ห้อง)" — ตัวทองเข้มบนพื้นขาว + เส้นบาง
const fxSection = (label) => ({
  type: "box", layout: "vertical", spacing: "sm",
  contents: [fx(label, { weight: "bold", size: "sm", color: "#9A7420" }), { type: "separator", color: "#E9E1CC" }],
});
// รายการห้อง: ป้ายเลขห้อง navy/ทองด้านซ้าย + ชื่อแขก / จำนวนแขก / โน้ต
function fxRoomItem({ room, name, meta, note }) {
  // room อาจเป็น "204 Allure" → ป้ายแสดงเฉพาะเลขห้อง ส่วนชื่อห้องไปอยู่บรรทัดย่อยใต้ชื่อแขก (กันป้ายถูกตัดเป็น "20…")
  const parts = String(room == null ? "" : room).trim().split(/\s+/);
  const num = parts[0] || "-", kind = parts.slice(1).join(" ");
  const sub = [kind, meta].filter(Boolean).join("  ·  ");
  const right = [fx(name, { weight: "bold" })];
  if (sub) right.push(fx(sub, { size: "xs", color: C.mute }));
  if (note) right.push(fx("📝 " + clip(String(note).replace(/\s+/g, " "), 120), { size: "xs", color: C.amberTx }));
  return {
    type: "box", layout: "horizontal", spacing: "md", backgroundColor: C.cream, cornerRadius: "md", paddingAll: "8px", alignItems: "center",
    contents: [
      { type: "box", layout: "vertical", flex: 0, width: "52px", backgroundColor: C.navy, cornerRadius: "md", paddingAll: "8px", justifyContent: "center",
        contents: [fx(num, { color: C.gold, weight: "bold", align: "center", wrap: false })] },
      { type: "box", layout: "vertical", flex: 1, spacing: "xs", contents: right },
    ],
  };
}
const fxGroup = (heading, items) => ({ type: "box", layout: "vertical", spacing: "sm", contents: [fxSection(heading), ...items.map(fxRoomItem)] });

function fxBubble({ title, sub, rows, blocks, callouts, altText, dashboardUrl, footerNote }) {
  const header = [fx(title, { color: C.gold, weight: "bold", size: "md" }), fx(sub, { color: C.sub, size: "xs" })];
  const body = [...(rows || []), ...(blocks || []), ...(callouts || [])];
  const bubble = {
    type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: C.navy, paddingAll: "14px", spacing: "xs", contents: header },
    body: { type: "box", layout: "vertical", spacing: "md", paddingAll: "14px", contents: body.length ? body : [fx("-")] },
  };
  const footer = [];
  if (dashboardUrl && /^https:\/\//.test(dashboardUrl)) footer.push({ type: "button", style: "primary", color: C.gold, height: "sm", action: { type: "uri", label: "เปิดแดชบอร์ด", uri: dashboardUrl } });
  if (footerNote) footer.push(fx(footerNote, { size: "xxs", color: C.mute, align: "center" }));
  if (footer.length) bubble.footer = { type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm", contents: footer };
  return { type: "flex", altText: clip(altText || title, 380), contents: bubble };
}

// ── 19:00 สรุปห้องพักวันพรุ่งนี้ (ส่งกลุ่มแม่บ้าน) ──
// รายการ item = { room, name, meta, note }
function buildMaidPlanFlex({ checkIns, checkOuts, stayOvers, dateLabel }) {
  stayOvers = stayOvers || [];
  const rows = [fxRow("เช็คอิน", checkIns.length + " ห้อง"), fxRow("เช็คเอาท์", checkOuts.length + " ห้อง")];
  if (stayOvers.length) rows.push(fxRow("ต่อพักห้องเดิม", stayOvers.length + " ห้อง"));
  const blocks = [];
  if (checkIns.length) blocks.push(fxGroup("🔑 เช็คอิน (" + checkIns.length + " ห้อง)", checkIns));
  if (checkOuts.length) blocks.push(fxGroup("🧹 เช็คเอาท์ (" + checkOuts.length + " ห้อง)", checkOuts));
  if (stayOvers.length) blocks.push(fxGroup("🔁 ต่อพักห้องเดิม — ไม่ต้องทำความสะอาดใหญ่", stayOvers));
  const alt = "รายการห้องพักวันพรุ่งนี้: เช็คอิน " + checkIns.length + " ห้อง, เช็คเอาท์ " + checkOuts.length + " ห้อง" + (stayOvers.length ? ", ต่อพัก " + stayOvers.length + " ห้อง" : "");
  return fxBubble({ title: "🏨 รายการห้องพักวันพรุ่งนี้", sub: dateLabel, rows, blocks, altText: alt, footerNote: "ส่งอัตโนมัติโดยระบบโรงแรม" });
}

// ── การ์ดเหตุการณ์ (ยกเลิก / Checkout / ย้ายห้อง / จองใหม่ ฯลฯ) ──
// info = [[ป้าย, ค่า], ...] (ค่าว่างจะถูกข้าม)
function buildEventFlex({ title, sub, info, note, callout, altText, footerNote }) {
  const rows = (info || []).filter((p) => p && p[1] != null && String(p[1]).trim() !== "").map((p) => fxInfo(p[0], p[1]));
  const callouts = [];
  if (callout) callouts.push(fxCallout(callout.title, callout.body, callout.bg, callout.fg));
  if (note) callouts.push(fxCallout("📝 โน้ต", note, C.amberBg, C.amberTx));
  return fxBubble({ title, sub, rows, callouts, altText: altText || title, footerNote });
}

const stripEmoji = (s) => String(s == null ? "" : s).replace(/^[^\p{L}\p{N}]+/u, "").trim(); // ตัดอีโมจินำหน้า (guestsLine → "2 ท่าน")

module.exports = { C, useCards, clip, fx, fxRow, fxInfo, fxCallout, fxSection, fxRoomItem, fxGroup, fxBubble, buildMaidPlanFlex, buildEventFlex, stripEmoji };
