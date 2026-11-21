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

// Ops Copilot (แบบกฎ ไม่ใช้ AI): เสนอ "ขั้นต่อไป" ต่อเรื่องที่ต้องตามต่อ — เสนอเท่านั้น ไม่ลงมือทำและไม่สัญญาอะไรกับแขก
function suggestActions(rec) {
  const out = [];
  if (isBlocked(rec) || rec.isCritical) out.push("ตรวจ/แก้ก่อนขายห้อง");
  if (/ยังไม่แจ้ง/.test(rec.leftBehind)) out.push("แจ้งแขกเรื่องของลืม");
  if (rec.damages.some((d) => !/late\s*checkout/i.test(d))) out.push("ถ่ายรูป ประเมินค่าเสียหาย แล้วแจ้งแขก");
  if (rec.repairs.length) out.push("เปิดงานซ่อม");
  return out;
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
    .map((l) => ({ room: l.room, reasons: followUpReasons(l), actions: suggestActions(l), note: l.extraNote }))
    .filter((f) => f.reasons.length);
  const notes = today
    .map((l) => ({ room: l.room, text: [l.extraNote, ...l.damages.filter((d) => !/late\s*checkout/i.test(d)), ...l.repairs.map((x) => "ซ่อม: " + x)].filter(Boolean).join(" | ") }))
    .filter((n) => n.text);
  return { date, expected: expected.length, inspected: today.length, ready: ready.map((l) => l.room), notReady, missing, followUps, notes };
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
      if (f.actions && f.actions.length) m += "   👉 " + f.actions.join(" / ") + "\n";
      if (f.ai) m += "   🤖 " + f.ai + "\n";
      else if (f.note) m += "   📝 " + clip(f.note.replace(/\s+/g, " "), 80) + "\n";
    }
  }
  return m + SEP + "\n💌 ส่งอัตโนมัติโดยระบบ";
}

// ─── แผนเช้า ───
// today = { checkIns, checkOuts, stayOvers } จาก filterByDate(rows, วันนี้)
// yesterdayLogs = records ของเมื่อวาน (หลัง dedupe) ใช้หา "ค้างจากเมื่อวาน"
function buildMorningPlan({ today, yesterdayLogs, yesterdayEvening, anomalies }) {
  const ins = new Set(today.checkIns.map((r) => roomNum(r.room)));
  const turnover = [...new Set(today.checkOuts.map((r) => roomNum(r.room)).filter((r) => ins.has(r)))];
  const carry = (yesterdayLogs || [])
    .map((l) => ({ room: l.room, reasons: followUpReasons(l).filter((x) => /ยังไม่แจ้ง|วิกฤต/.test(x)) }))
    .filter((c) => c.reasons.length);
  // yesterday = สรุปผลตรวจห้องของเมื่อวาน (ใช้ buildEveningSummary) — ถ้ามี จะแทนส่วน "ค้างจากเมื่อวาน" ในการ์ดแอดมิน
  const yesterday = yesterdayEvening && (yesterdayEvening.expected > 0 || yesterdayEvening.inspected > 0) ? yesterdayEvening : null;
  return { checkIns: today.checkIns.length, checkOuts: today.checkOuts.length, stayOvers: (today.stayOvers || []).length, turnover, carry, yesterday, anomalies: anomalies || [] };
}
function shouldSendMorning(p) {
  return p.checkIns + p.checkOuts + p.stayOvers > 0 || p.carry.length > 0 || (p.yesterday ? shouldSendEvening(p.yesterday) : false) || (p.anomalies || []).length > 0;
}
// ส่วน "ผลตรวจห้องเมื่อวาน" ในการ์ดเช้า (ข้อความ) — ทุกห้องเรียบร้อยให้แค่บรรทัดเดียว
function yesterdayText(y) {
  let m = "\n📋 ผลตรวจห้องเมื่อวาน: ตรวจแล้ว " + y.inspected + (y.expected ? " จาก " + y.expected : "") + " ห้อง · พร้อม " + y.ready.length + "\n";
  if (!shouldSendEvening(y)) return m + "✅ ทุกห้องพร้อม ไม่มีเรื่องต้องตาม\n";
  if (y.notReady.length) m += "⚠️ ไม่พร้อม: " + y.notReady.map((x) => "ห้อง " + x.room + " (" + x.reason + ")").join(", ") + "\n";
  if (y.missing.length) m += "❓ ยังไม่มีรายงาน: ห้อง " + y.missing.join(", ") + "\n";
  for (const f of y.followUps.slice(0, 6)) {
    m += "📌 ห้อง " + f.room + " — " + f.reasons.join(" / ") + "\n";
    if (f.actions && f.actions.length) m += "   👉 " + f.actions.join(" / ") + "\n";
    if (f.ai) m += "   🤖 " + f.ai + "\n";
    else if (f.note) m += "   📝 " + clip(f.note.replace(/\s+/g, " "), 80) + "\n";
  }
  if (y.followUps.length > 6) m += "และอีก " + (y.followUps.length - 6) + " ห้อง ดูในแดชบอร์ด\n";
  return m;
}
function buildMorningMessage(p, dateLabel, opts) {
  const o = opts || {}, group = o.audience === "group";
  let m = "🌅 แผนวันนี้\n📅 " + dateLabel + "\n" + SEP + "\n";
  m += "🚪 เช็คเอาท์ " + p.checkOuts + " ห้อง\n✅ เช็คอิน " + p.checkIns + " ห้อง\n";
  if (p.stayOvers) m += "🔁 ต่อพัก " + p.stayOvers + " ห้อง\n";
  if (p.turnover.length) m += "\n⏱ ทำก่อน (เช็คเอาท์แล้วมีแขกใหม่เข้าวันเดียวกัน): ห้อง " + p.turnover.join(", ") + "\n";
  if (!group && o.prices) m += "\n💰 ราคาเป้าหมายคืนนี้: " + formatPrices(o.prices) + "\n";
  if (!group && o.priceWarning) m += "\n⚠️ " + o.priceWarning + "\n";
  if (!group && p.yesterday) m += yesterdayText(p.yesterday);
  else if (!group && p.carry.length) {
    m += "\n📌 ค้างจากเมื่อวาน\n";
    for (const c of p.carry) m += "• ห้อง " + c.room + " — " + c.reasons.join(" / ") + "\n";
  }
  if (!group && p.anomalies && p.anomalies.length) {
    m += "\n⚠️ ความผิดปกติ " + p.anomalies.length + " เรื่อง\n";
    for (const a of p.anomalies.slice(0, 8)) m += (a.severity === "high" ? "🔴 " : "🟡 ") + a.text + "\n";
  }
  return m + SEP + "\n💌 ส่งอัตโนมัติโดยระบบ";
}


// ─── LINE Flex Message (การ์ดตามดีไซน์ AI-PMS: หัว navy/ทอง, แถวตัวเลข, กล่องเหลือง/แดง, ปุ่มเปิดแดชบอร์ด) ───
const { C, fx, fxRow, fxCallout, fxBubble } = require("./flex-cards"); // การ์ด navy/ทอง กลาง — ใช้ร่วมกับรายงานอื่นของบอท

function buildEveningFlex(s, dateLabel, opts) {
  const rows = [fxRow("ตรวจแล้ว", s.inspected + (s.expected ? " จาก " + s.expected : "") + " ห้อง"), fxRow("พร้อมรับแขก", s.ready.length + " ห้อง")];
  const callouts = [];
  if (s.notReady.length) callouts.push(fxCallout("⚠️ ไม่พร้อม", s.notReady.map((x) => "ห้อง " + x.room + " (" + x.reason + ")").join(", "), C.amberBg, C.amberTx));
  if (s.missing.length) callouts.push(fxCallout("❓ ยังไม่มีรายงานตรวจห้อง", "ห้อง " + s.missing.join(", "), C.amberBg, C.amberTx));
  for (const f of s.followUps.slice(0, 5)) {
    const note = f.ai ? "\n🤖 " + f.ai : f.note ? "\n📝 " + clip(f.note.replace(/\s+/g, " "), 120) : "";
    const act = f.actions && f.actions.length ? "\n👉 " + f.actions.join(" / ") : "";
    callouts.push(fxCallout("📌 ห้อง " + f.room + " — ต้องตามต่อ", f.reasons.join(" / ") + act + note, C.redBg, C.redTx));
  }
  if (s.followUps.length > 5) callouts.push(fx("และอีก " + (s.followUps.length - 5) + " ห้อง ดูรายละเอียดในแดชบอร์ด", { size: "xs" }));
  const alt = "ผลตรวจห้องวันนี้: พร้อม " + s.ready.length + " ห้อง" + (s.notReady.length ? ", ไม่พร้อม " + s.notReady.length : "") + (s.missing.length ? ", ยังไม่มีรายงาน " + s.missing.length : "") + (s.followUps.length ? ", ต้องตามต่อ " + s.followUps.length : "");
  return fxBubble({ title: "ผลตรวจห้องวันนี้", sub: dateLabel, rows, callouts, altText: alt, dashboardUrl: opts && opts.dashboardUrl });
}

function buildMorningFlex(p, dateLabel, opts) {
  const o = opts || {}, group = o.audience === "group";
  const rows = [fxRow("เช็คเอาท์วันนี้", p.checkOuts + " ห้อง"), fxRow("เช็คอินวันนี้", p.checkIns + " ห้อง")];
  if (p.stayOvers) rows.push(fxRow("ต่อพัก", p.stayOvers + " ห้อง"));
  const callouts = [];
  if (p.turnover.length) callouts.push(fxCallout("⏱ ทำก่อน", "ห้อง " + p.turnover.join(", ") + " เช็คเอาท์แล้วมีแขกใหม่เข้าวันเดียวกัน", C.amberBg, C.amberTx));
  if (!group && o.prices) callouts.push(fxCallout("💰 ราคาเป้าหมายคืนนี้", formatPrices(o.prices), "#EAF0FA", C.navy));
  if (!group && o.priceWarning) callouts.push(fxCallout("⚠️ ระบบตั้งราคา", o.priceWarning, C.redBg, C.redTx));
  if (!group && p.yesterday) {
    const y = p.yesterday;
    rows.push(fxRow("ผลตรวจห้องเมื่อวาน", "พร้อม " + y.ready.length + (y.expected ? "/" + y.expected : "") + " ห้อง"));
    if (y.notReady.length) callouts.push(fxCallout("⚠️ เมื่อวานไม่พร้อม", y.notReady.map((x) => "ห้อง " + x.room + " (" + x.reason + ")").join(", "), C.amberBg, C.amberTx));
    if (y.missing.length) callouts.push(fxCallout("❓ เมื่อวานยังไม่มีรายงานตรวจห้อง", "ห้อง " + y.missing.join(", "), C.amberBg, C.amberTx));
    for (const f of y.followUps.slice(0, 4)) {
      const note = f.ai ? "\n🤖 " + f.ai : f.note ? "\n📝 " + clip(f.note.replace(/\s+/g, " "), 100) : "";
      const act = f.actions && f.actions.length ? "\n👉 " + f.actions.join(" / ") : "";
      callouts.push(fxCallout("📌 ห้อง " + f.room + " — ต้องตามต่อ", f.reasons.join(" / ") + act + note, C.redBg, C.redTx));
    }
    if (y.followUps.length > 4) callouts.push(fx("และอีก " + (y.followUps.length - 4) + " ห้อง ดูในแดชบอร์ด", { size: "xs" }));
  } else if (!group && p.carry.length) callouts.push(fxCallout("📌 ค้างจากเมื่อวาน", p.carry.map((c) => "ห้อง " + c.room + " — " + c.reasons.join(" / ")).join("\n"), C.redBg, C.redTx));
  if (!group && p.anomalies && p.anomalies.length) callouts.push(fxCallout("⚠️ ความผิดปกติ " + p.anomalies.length + " เรื่อง", p.anomalies.slice(0, 5).map((a) => (a.severity === "high" ? "🔴 " : "🟡 ") + a.text).join("\n"), C.redBg, C.redTx));
  const alt = "แผนวันนี้: เช็คเอาท์ " + p.checkOuts + " ห้อง, เช็คอิน " + p.checkIns + " ห้อง" + (p.turnover.length ? ", ทำก่อน ห้อง " + p.turnover.join(", ") : "") + (!group && p.anomalies && p.anomalies.length ? ", ความผิดปกติ " + p.anomalies.length : "") + (!group && p.yesterday && shouldSendEvening(p.yesterday) ? ", เมื่อวานต้องตามต่อ" : "");
  // ข้อความถึงกลุ่มแม่บ้านไม่มีปุ่มแดชบอร์ด
  return fxBubble({ title: "แผนวันนี้", sub: dateLabel, rows, callouts, altText: alt, dashboardUrl: group ? "" : o.dashboardUrl });
}


// ─── การตั้งค่า (ตั้งจากแดชบอร์ด) + ตัวช่วยกำหนดเวลา/ประวัติ ───
const DEFAULT_SETTINGS = {
  morning: { enabled: true, time: "07:30", recipients: "admin", includePrices: false, consolidated: true }, // consolidated: รวมรายงานแอดมินทั้งหมดไว้ในการ์ดเช้าใบเดียว (ผลตรวจห้องเมื่อวาน + ความผิดปกติ) และงดการ์ดเย็น
  evening: { enabled: true, time: "18:30", onlyWhenFlagged: true, aiSummary: false },
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const RECIPIENTS = ["admin", "group", "both"];
function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const pick = (k, def) => {
    const v = r[k] && typeof r[k] === "object" ? r[k] : {};
    const out = {};
    for (const key of Object.keys(def)) {
      if (key === "time") out.time = TIME_RE.test(String(v.time || "")) ? String(v.time) : def.time;
      else if (key === "recipients") out.recipients = RECIPIENTS.includes(v.recipients) ? v.recipients : def.recipients;
      else out[key] = typeof v[key] === "boolean" ? v[key] : def[key];
    }
    return out;
  };
  return { morning: pick("morning", DEFAULT_SETTINGS.morning), evening: pick("evening", DEFAULT_SETTINGS.evening) };
}
const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
// ถึงเวลาส่งหรือยัง: ภายใน windowMin นาทีหลังเวลาที่ตั้ง (ถ้าบริการหลับแล้วตื่นทีหลังก็ยังส่งตาม — กันส่งซ้ำด้วยแฟลกรายวันที่อื่น)
function isDue(hhmm, nowMinutes, windowMin) {
  const m = minutesOf(hhmm), w = windowMin == null ? 60 : windowMin;
  return nowMinutes >= m && nowMinutes < m + w;
}
// onlyWhenFlagged=true → ใช้กติกาเดิม ; false → ส่งทุกวันที่มีเช็คเอาท์หรือมีรายงาน
function shouldSendEveningWith(s, evCfg) {
  return evCfg && evCfg.onlyWhenFlagged === false ? s.expected > 0 || s.inspected > 0 : shouldSendEvening(s);
}
// ประวัติ: เก็บทีละวัน+ชนิด (ค่าเล็ก ๆ) ไม่ใส่ชื่อแขก
function historyEntry({ kind, date, decision, reason, summary, text, at }) {
  return { at: at || new Date().toISOString(), kind, date, decision, reason: reason || "", summary: summary || null, text: text ? String(text).slice(0, 1500) : "" };
}


// ─── ราคาเป้าหมายคืนนี้ (อ่านจากชีต Target_Rates ของ lh-rate-automation: Date | RoomType | Rate | Occ% | DaysAhead | UpdatedAt) ───
const ROOM_TYPE_ORDER = ["Luxury", "Retro", "Allure", "Elegance", "Legacy", "Radiance"];
// ชีตอาจแปลงคอลัมน์ Date เป็นวันที่ตามภาษา/ locale → รองรับ ISO, y/m/d และ d/m/y หรือ m/d/y (ตั้ง dateOrder = "dmy" | "mdy")
function toIsoDate(raw, dateOrder) {
  const t = String(raw || "").trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/) || t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return "";
  const [d, mo] = dateOrder === "mdy" ? [m[2], m[1]] : [m[1], m[2]];
  return m[3] + "-" + mo.padStart(2, "0") + "-" + d.padStart(2, "0");
}
// อ่านแถวของวันที่ระบุจากตาราง Target_Rates (rows = array ของแถว รวมหัวตาราง)
// คืน { rates, updatedAt, ageHours, stale } — rates = null เมื่อไม่พบข้อมูลของวันนั้น/โครงสร้างผิด (ไม่เดา)
// stale = true เมื่อ UpdatedAt ใหม่สุดของแถววันนั้นเก่ากว่า maxAgeHours (ระบบตั้งราคาอาจหยุดทำงาน → ไม่ควรเอาราคาเก่ามาเรียกว่า "คืนนี้")
function readTargetRates(rows, date, dateOrder, opts) {
  const o = opts || {}, maxAge = o.maxAgeHours == null ? 36 : o.maxAgeHours;
  const none = { rates: null, updatedAt: "", ageHours: null, stale: false };
  if (!Array.isArray(rows) || rows.length < 2) return none;
  const h = rows[0].map((x) => String(x == null ? "" : x).trim());
  const iD = h.indexOf("Date"), iT = h.indexOf("RoomType"), iR = h.indexOf("Rate"), iU = h.indexOf("UpdatedAt");
  if (iD < 0 || iT < 0 || iR < 0) return none;
  const rates = {};
  let newest = 0;
  for (const r of rows.slice(1)) {
    if (toIsoDate(r[iD], dateOrder) !== date) continue;
    const rate = Number(String(r[iR] == null ? "" : r[iR]).replace(/[^\d.]/g, ""));
    if (r[iT] && rate > 0) {
      rates[String(r[iT]).trim()] = Math.round(rate);
      const t = iU >= 0 ? Date.parse(String(r[iU] || "")) : NaN;
      if (t > newest) newest = t;
    }
  }
  if (!Object.keys(rates).length) return none;
  if (!newest) return { rates, updatedAt: "", ageHours: null, stale: false };    // ไม่มี UpdatedAt ให้ตรวจ — ใช้ได้แต่ตรวจความสดไม่ได้
  const ageHours = ((o.nowMs == null ? Date.now() : o.nowMs) - newest) / 3600000;
  return { rates, updatedAt: new Date(newest).toISOString(), ageHours, stale: ageHours > maxAge };
}
// เวอร์ชัน CSV (คงไว้สำหรับเทสต์/การใช้เดิม): คืนเฉพาะแผนที่ราคา หรือ null
function parseTargetRates(csvText, date, dateOrder) {
  return readTargetRates(parseCsv(csvText), date, dateOrder, { maxAgeHours: Infinity }).rates;
}
function formatPrices(map) {
  const keys = ROOM_TYPE_ORDER.filter((k) => k in map).concat(Object.keys(map).filter((k) => !ROOM_TYPE_ORDER.includes(k)));
  return keys.map((k) => k + " ฿" + Number(map[k]).toLocaleString("en-US")).join(" · ");
}

// ─── AI สรุปหมายเหตุตรวจห้อง (บอทเรียก Claude; ฟังก์ชันตรวจผลลัพธ์เป็นแบบล้วน ไม่เชื่อผลที่ไม่ตรงสเปก) ───
// raw = ข้อความที่ AI ตอบ ; allowedRooms = ห้องที่ส่งให้ AI  → { "214": { summary, needsAttention } }
function validateAiNotes(raw, allowedRooms) {
  let t = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let arr;
  try { arr = JSON.parse(t); } catch (_) { return {}; }
  if (!Array.isArray(arr)) return {};
  const ok = new Set(allowedRooms), out = {};
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const room = String(it.room || "").trim();
    const summary = typeof it.summary === "string" ? it.summary.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!ok.has(room) || !summary || out[room]) continue;
    out[room] = { summary, needsAttention: it.needsAttention === true };
  }
  return out;
}
// เติมสรุปของ AI ลงในเรื่องต้องตามต่อ + เพิ่มห้องที่ AI เห็นว่าต้องใส่ใจ (เช่น "แก้วแตก" ที่ไม่ได้ติ๊กช่องความเสียหาย)
function applyAiNotes(s, aiMap) {
  if (!aiMap || !Object.keys(aiMap).length) return s;
  const followUps = s.followUps.map((f) => (aiMap[f.room] ? Object.assign({}, f, { ai: aiMap[f.room].summary }) : f));
  const have = new Set(followUps.map((f) => f.room));
  for (const room of Object.keys(aiMap)) {
    if (aiMap[room].needsAttention && !have.has(room)) followUps.push({ room, reasons: ["จากหมายเหตุ (AI)"], note: "", ai: aiMap[room].summary, fromAi: true });
  }
  return Object.assign({}, s, { followUps });
}

module.exports = {
  parseCsv, parseCheckoutLog, dedupeLatest, isReadyForGuests, followUpReasons,
  suggestActions, buildEveningSummary, shouldSendEvening, buildEveningMessage,
  buildMorningPlan, shouldSendMorning, buildMorningMessage, roomNum,
  buildEveningFlex, buildMorningFlex,
  DEFAULT_SETTINGS, normalizeSettings, isDue, shouldSendEveningWith, historyEntry,
  toIsoDate, parseTargetRates, readTargetRates, formatPrices, validateAiNotes, applyAiNotes,
};
