// สรุปประจำวันถึงแอดมิน (เช้า = แผนวันนี้ / เย็น = ผลตรวจห้องหลังเช็คเอาท์)
// ฟังก์ชันล้วน (pure) ทดสอบได้โดยไม่ต้องสตาร์ทเซิร์ฟเวอร์ — ตัวเลขทั้งหมดมาจากโค้ด ไม่ใช่จาก AI
// ไม่ใส่ชื่อแขกในข้อความ

// ─── CSV (รองรับ field ในเครื่องหมายคำพูดที่มีคอมมา/ขึ้นบรรทัดใหม่ — เช่น ExtraNote หลายบรรทัด) ───
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", inQ = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function roomNum(raw) {
  const m = String(raw || "").match(/\d{3}/);
  return m ? m[0] : "";
}
const splitList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

// ─── Raw_Checkout_Log → records ───
function parseCheckoutLog(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];
  const h = rows[0].map((x) => x.trim());
  const ix = (name) => h.indexOf(name);
  const out = [];
  for (const r of rows.slice(1)) {
    const room = roomNum(r[ix("Room")]);
    const date = (r[ix("Date")] || "").trim();
    if (!room || !date) continue;
    let j = {};
    try { j = JSON.parse(r[ix("FullJSON")] || "{}") || {}; } catch (_) { j = {}; }
    const ts = Number(j.timestamp) || Date.parse(r[ix("Timestamp")] || "") || 0;
    out.push({
      uid: r[ix("UID")] || "",
      date, room,
      status: (j.roomStatus ?? r[ix("Status")] ?? "").toString().trim().toLowerCase(),
      ready: (j.ready ?? r[ix("Ready")] ?? "").toString().trim(),
      damages: Array.isArray(j.damages) ? j.damages : splitList(r[ix("Damages")]),
      repairs: Array.isArray(j.repairs) ? j.repairs : splitList(r[ix("Repairs")]),
      isCritical: j.isCritical === true,
      leftBehind: (j.leftBehind ?? "").toString().trim(),
      extraNote: (j.extraNote ?? r[ix("ExtraNote")] ?? "").toString().trim(),
      timestamp: ts,
    });
  }
  return out;
}

// ห้อง+วันเดียวกันมีหลายแถว (กดบันทึกซ้ำ) → เอาแถวที่ timestamp ล่าสุด
function dedupeLatest(records) {
  const best = new Map();
  for (const r of records) {
    const k = r.room + "_" + r.date;
    const cur = best.get(k);
    if (!cur || r.timestamp >= cur.timestamp) best.set(k, r);
  }
  return [...best.values()];
}

// "พร้อม" เป็น substring ของ "ไม่พร้อม" → ต้องกันกรณีนี้ (ตรรกะเดียวกับ the-loft-admin)
function isBlocked(rec) { return ["block", "major"].includes(rec.status); }
function isReadyForGuests(rec) {
  return !isBlocked(rec) && /พร้อม/.test(rec.ready) && !/ไม่พร้อม/.test(rec.ready);
}
function notReadyReason(rec) {
  if (isBlocked(rec)) return "ห้องถูกบล็อก";
  if (/ไม่พร้อม/.test(rec.ready)) return "ยังไม่พร้อม";
  return "ไม่ได้ระบุความพร้อม";
}

// เรื่องที่ต้องตามต่อ (แม้ห้อง "พร้อม")
// หมายเหตุ: "Late Checkout" อย่างเดียวไม่ถือเป็นความเสียหาย
function followUpReasons(rec) {
  const reasons = [];
  if (rec.isCritical) reasons.push("ธงวิกฤต");
  if (/ยังไม่แจ้ง/.test(rec.leftBehind)) reasons.push("ของลืมยังไม่แจ้งแขก");
  const dmg = rec.damages.filter((d) => !/late\s*checkout/i.test(d));
  if (dmg.length) reasons.push("ความเสียหาย: " + dmg.join(", "));
  if (rec.repairs.length) reasons.push("งานซ่อม: " + rec.repairs.join(", "));
  return reasons;
}

// ─── สรุปเย็น ───
// expectedRooms = เลขห้องที่ต้องเช็คเอาท์วันนี้ (จากชีทจอง ตัดยกเลิก/ต่อพักแล้ว)
// logs = ผลจาก parseCheckoutLog
function buildEveningSummary({ date, expectedRooms, logs }) {
  const today = dedupeLatest(logs.filter((l) => l.date === date));
  const expected = [...new Set((expectedRooms || []).map(roomNum).filter(Boolean))];
  const done = new Set(today.map((l) => l.room));
  const missing = expected.filter((r) => !done.has(r));
  const ready = today.filter(isReadyForGuests);
  const notReady = today.filter((l) => !isReadyForGuests(l)).map((l) => ({ room: l.room, reason: notReadyReason(l) }));
  const followUps = today
    .map((l) => ({ room: l.room, reasons: followUpReasons(l), note: l.extraNote }))
    .filter((f) => f.reasons.length);
  return { date, expected: expected.length, inspected: today.length, ready: ready.map((l) => l.room), notReady, missing, followUps };
}

// ส่งเมื่อ: มีห้องไม่พร้อม / ยังไม่มีรายงาน / มีเรื่องต้องตาม  — ไม่ส่งเมื่อทุกอย่างเรียบร้อยหรือวันนั้นไม่มีอะไรเลย
function shouldSendEvening(s) {
  return s.notReady.length > 0 || s.missing.length > 0 || s.followUps.length > 0;
}

const SEP = "─────────────────────────";
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

function buildEveningMessage(s, dateLabel) {
  let m = "📋 ผลตรวจห้องวันนี้\n📅 " + dateLabel + "\n" + SEP + "\n";
  m += "🧾 ตรวจแล้ว " + s.inspected + (s.expected ? " จาก " + s.expected : "") + " ห้อง\n";
  m += "✅ พร้อมรับแขก " + s.ready.length + " ห้อง\n";
  if (s.notReady.length) m += "⚠️ ไม่พร้อม: " + s.notReady.map((x) => "ห้อง " + x.room + " (" + x.reason + ")").join(", ") + "\n";
  if (s.missing.length) m += "❓ ยังไม่มีรายงาน: ห้อง " + s.missing.join(", ") + "\n";
  if (s.followUps.length) {
    m += "\n📌 ต้องตามต่อ\n";
    for (const f of s.followUps) {
      m += "• ห้อง " + f.room + " — " + f.reasons.join(" / ") + "\n";
      if (f.note) m += "   📝 " + clip(f.note.replace(/\s+/g, " "), 80) + "\n";
    }
  }
  return m + SEP + "\n💌 ส่งอัตโนมัติโดยระบบ";
}

// ─── แผนเช้า ───
// today = { checkIns, checkOuts, stayOvers } จาก filterByDate(rows, วันนี้)
// yesterdayLogs = records ของเมื่อวาน (หลัง dedupe) ใช้หา "ค้างจากเมื่อวาน"
function buildMorningPlan({ today, yesterdayLogs }) {
  const ins = new Set(today.checkIns.map((r) => roomNum(r.room)));
  const turnover = [...new Set(today.checkOuts.map((r) => roomNum(r.room)).filter((r) => ins.has(r)))];
  const carry = (yesterdayLogs || [])
    .map((l) => ({ room: l.room, reasons: followUpReasons(l).filter((x) => /ยังไม่แจ้ง|วิกฤต/.test(x)) }))
    .filter((c) => c.reasons.length);
  return { checkIns: today.checkIns.length, checkOuts: today.checkOuts.length, stayOvers: (today.stayOvers || []).length, turnover, carry };
}
function shouldSendMorning(p) { return p.checkIns + p.checkOuts + p.stayOvers > 0 || p.carry.length > 0; }
function buildMorningMessage(p, dateLabel) {
  let m = "🌅 แผนวันนี้\n📅 " + dateLabel + "\n" + SEP + "\n";
  m += "🚪 เช็คเอาท์ " + p.checkOuts + " ห้อง\n✅ เช็คอิน " + p.checkIns + " ห้อง\n";
  if (p.stayOvers) m += "🔁 ต่อพัก " + p.stayOvers + " ห้อง\n";
  if (p.turnover.length) m += "\n⏱ ทำก่อน (เช็คเอาท์แล้วมีแขกใหม่เข้าวันเดียวกัน): ห้อง " + p.turnover.join(", ") + "\n";
  if (p.carry.length) {
    m += "\n📌 ค้างจากเมื่อวาน\n";
    for (const c of p.carry) m += "• ห้อง " + c.room + " — " + c.reasons.join(" / ") + "\n";
  }
  return m + SEP + "\n💌 ส่งอัตโนมัติโดยระบบ";
}


// ─── LINE Flex Message (การ์ดตามดีไซน์ AI-PMS: หัว navy/ทอง, แถวตัวเลข, กล่องเหลือง/แดง, ปุ่มเปิดแดชบอร์ด) ───
const C = { navy: "#071B3D", gold: "#D9B25C", ink: "#1B2A41", sub: "#C9D3E3", amberBg: "#FFF1D6", amberTx: "#7A4B00", redBg: "#FDE7E7", redTx: "#8A1C1C" };
const fx = (text, o) => Object.assign({ type: "text", text: String(text) || "-", wrap: true, size: "sm", color: C.ink }, o || {});
const fxRow = (label, value) => ({ type: "box", layout: "horizontal", contents: [fx(label, { flex: 3 }), fx(value, { flex: 2, align: "end", weight: "bold" })] });
const fxCallout = (title, body, bg, fg) => ({
  type: "box", layout: "vertical", backgroundColor: bg, cornerRadius: "md", paddingAll: "10px", spacing: "xs",
  contents: [fx(title, { weight: "bold", color: fg }), ...(body ? [fx(body, { size: "xs", color: fg })] : [])],
});
function fxBubble({ title, sub, rows, callouts, altText, dashboardUrl }) {
  const bubble = {
    type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: C.navy, paddingAll: "14px", spacing: "xs",
      contents: [fx(title, { color: C.gold, weight: "bold", size: "md" }), fx(sub, { color: C.sub, size: "xs" })] },
    body: { type: "box", layout: "vertical", spacing: "md", paddingAll: "14px", contents: [...rows, ...callouts] },
  };
  if (dashboardUrl && /^https:\/\//.test(dashboardUrl)) {
    bubble.footer = { type: "box", layout: "vertical", paddingAll: "12px",
      contents: [{ type: "button", style: "primary", color: C.gold, height: "sm", action: { type: "uri", label: "เปิดแดชบอร์ด", uri: dashboardUrl } }] };
  }
  return { type: "flex", altText: clip(altText, 380), contents: bubble };
}

function buildEveningFlex(s, dateLabel, opts) {
  const rows = [fxRow("ตรวจแล้ว", s.inspected + (s.expected ? " จาก " + s.expected : "") + " ห้อง"), fxRow("พร้อมรับแขก", s.ready.length + " ห้อง")];
  const callouts = [];
  if (s.notReady.length) callouts.push(fxCallout("⚠️ ไม่พร้อม", s.notReady.map((x) => "ห้อง " + x.room + " (" + x.reason + ")").join(", "), C.amberBg, C.amberTx));
  if (s.missing.length) callouts.push(fxCallout("❓ ยังไม่มีรายงานตรวจห้อง", "ห้อง " + s.missing.join(", "), C.amberBg, C.amberTx));
  for (const f of s.followUps.slice(0, 5)) {
    const note = f.note ? "\n📝 " + clip(f.note.replace(/\s+/g, " "), 120) : "";
    callouts.push(fxCallout("📌 ห้อง " + f.room + " — ต้องตามต่อ", f.reasons.join(" / ") + note, C.redBg, C.redTx));
  }
  if (s.followUps.length > 5) callouts.push(fx("และอีก " + (s.followUps.length - 5) + " ห้อง ดูรายละเอียดในแดชบอร์ด", { size: "xs" }));
  const alt = "ผลตรวจห้องวันนี้: พร้อม " + s.ready.length + " ห้อง" + (s.notReady.length ? ", ไม่พร้อม " + s.notReady.length : "") + (s.missing.length ? ", ยังไม่มีรายงาน " + s.missing.length : "") + (s.followUps.length ? ", ต้องตามต่อ " + s.followUps.length : "");
  return fxBubble({ title: "ผลตรวจห้องวันนี้", sub: dateLabel, rows, callouts, altText: alt, dashboardUrl: opts && opts.dashboardUrl });
}

function buildMorningFlex(p, dateLabel, opts) {
  const rows = [fxRow("เช็คเอาท์วันนี้", p.checkOuts + " ห้อง"), fxRow("เช็คอินวันนี้", p.checkIns + " ห้อง")];
  if (p.stayOvers) rows.push(fxRow("ต่อพัก", p.stayOvers + " ห้อง"));
  const callouts = [];
  if (p.turnover.length) callouts.push(fxCallout("⏱ ทำก่อน", "ห้อง " + p.turnover.join(", ") + " เช็คเอาท์แล้วมีแขกใหม่เข้าวันเดียวกัน", C.amberBg, C.amberTx));
  if (p.carry.length) callouts.push(fxCallout("📌 ค้างจากเมื่อวาน", p.carry.map((c) => "ห้อง " + c.room + " — " + c.reasons.join(" / ")).join("\n"), C.redBg, C.redTx));
  const alt = "แผนวันนี้: เช็คเอาท์ " + p.checkOuts + " ห้อง, เช็คอิน " + p.checkIns + " ห้อง" + (p.turnover.length ? ", ทำก่อน ห้อง " + p.turnover.join(", ") : "");
  return fxBubble({ title: "แผนวันนี้", sub: dateLabel, rows, callouts, altText: alt, dashboardUrl: opts && opts.dashboardUrl });
}

module.exports = {
  parseCsv, parseCheckoutLog, dedupeLatest, isReadyForGuests, followUpReasons,
  buildEveningSummary, shouldSendEvening, buildEveningMessage,
  buildMorningPlan, shouldSendMorning, buildMorningMessage, roomNum,
  buildEveningFlex, buildMorningFlex,
};
