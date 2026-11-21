"use strict";
// anomalies.js — ตรวจความผิดปกติของการจอง/รายงานตรวจห้อง (กฎล้วน ไม่ใช้ AI ไม่มีต้นทุนเพิ่ม)
// ฟังก์ชันล้วน (ไม่แตะ Sheets/Redis/LINE) ให้ bot.js เป็นผู้โหลดข้อมูลและส่งข้อความ — เทสต์ได้ตรงๆ
//   1) จองซ้อนกัน (ห้องเดียวกัน วันที่คาบเกี่ยว; เช็คเอาท์-เช็คอินวันเดียวกันไม่นับ)
//   2) เช็คอินวันนี้/พรุ่งนี้ แต่ยังไม่ระบุเลขห้อง
//   3) เช็คเอาท์วันนี้แล้ว (เลยเวลาตัดรอบ) แต่ยังไม่มีรายงานตรวจห้อง
// ข้อความถึงแอดมินใช้รหัสการจอง (resId) ไม่ใส่ชื่อแขก

const SKIP_ROOM = /\b363\b|cancel|ยกเลิก/i; // 363 (Mycondo) นอกงานแม่บ้าน · แถวยกเลิก
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function roomKey(room) {
  const m = String(room || "").match(/\d{3}/);
  return m ? m[0] : String(room || "").trim();
}

// โครงแถวเหมือน filterByDate ใน bot.js: A=ห้อง B=แขก C=เช็คอิน D=เช็คเอาท์ แล้วแบบใหม่ E=ช่องทาง F=resId / แบบเก่า E=resId
function parseBookings(rows, normalizeDate) {
  const out = [];
  for (let i = 1; i < (rows || []).length; i++) {
    const row = rows[i];
    if (!row || row.length < 4) continue;
    const room = String(row[0] || "").trim(), guest = String(row[1] || "").trim();
    if (!guest) continue;
    const resId = /^(ABB|BKC|EXP|TRP|DBK|OTH)-/i.test(row[5]) ? String(row[5]).trim() : String(row[4] || "").trim();
    out.push({ room, key: roomKey(room), checkIn: normalizeDate(row[2] || ""), checkOut: normalizeDate(row[3] || ""), resId, line: i + 1 });
  }
  return out;
}

function detect({ rows, logs, today, tomorrow, hour, normalizeDate, reportAfterHour = 15 }) {
  const items = [];
  const all = parseBookings(rows, normalizeDate).filter((b) => ISO.test(b.checkIn) && ISO.test(b.checkOut));
  const assigned = all.filter((b) => b.room && !SKIP_ROOM.test(b.room) && b.checkOut >= today);

  // 1) จองซ้อนกัน
  const byRoom = {};
  assigned.forEach((b) => { (byRoom[b.key] = byRoom[b.key] || []).push(b); });
  Object.keys(byRoom).forEach((k) => {
    const list = byRoom[k].sort((a, b) => (a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.resId && a.resId === b.resId) continue;           // แถวเดียวกันของการจองเดียว
        if (b.checkIn >= a.checkOut) break;                      // เรียงตามเช็คอินแล้ว ที่เหลือไม่ซ้อนแน่
        if (a.checkIn < b.checkOut && b.checkIn < a.checkOut) {
          items.push({
            id: "overlap:" + k + ":" + (a.resId || "L" + a.line) + ":" + (b.resId || "L" + b.line),
            severity: "high", type: "overlap", room: k,
            text: "ห้อง " + k + " จองซ้อนกัน: " + (a.resId || "ไม่มีรหัส") + " (" + a.checkIn + "→" + a.checkOut + ") กับ " + (b.resId || "ไม่มีรหัส") + " (" + b.checkIn + "→" + b.checkOut + ") — ตรวจแล้วย้ายห้องหรือแก้ใบที่ผิด",
          });
        }
      }
    }
  });

  // 2) เช็คอินวันนี้/พรุ่งนี้ ยังไม่ระบุเลขห้อง
  all.filter((b) => !b.room && (b.checkIn === today || b.checkIn === tomorrow)).forEach((b) => {
    items.push({
      id: "unassigned:" + (b.resId || "L" + b.line), severity: "medium", type: "unassigned", room: "",
      text: "การจอง " + (b.resId || "(ไม่มีรหัส)") + " เช็คอิน " + b.checkIn + " ยังไม่ระบุเลขห้อง — ระบุเลขห้องก่อนแขกมาถึง",
    });
  });

  // 3) เช็คเอาท์วันนี้ เลยเวลาตัดรอบ แต่ไม่มีรายงานตรวจห้อง
  if (hour >= reportAfterHour) {
    const reported = new Set((logs || []).map((l) => roomKey(l.room)));
    const seen = new Set();
    assigned.filter((b) => b.checkOut === today).forEach((b) => {
      if (reported.has(b.key) || seen.has(b.key)) return;
      seen.add(b.key);
      items.push({
        id: "noreport:" + b.key + ":" + today, severity: "medium", type: "noreport", room: b.key,
        text: "ห้อง " + b.key + " เช็คเอาท์วันนี้แล้ว แต่ยังไม่มีรายงานตรวจห้อง — ให้แม่บ้านส่งรายงาน (ทุกห้องที่แขกพักจริงต้องมีรายงาน)",
      });
    });
  }
  // แถวซ้ำของการจองเดียวกันทำให้ id ซ้ำได้ — เก็บอันเดียว
  const uniq = [];
  const seenIds = new Set();
  items.forEach((i) => { if (!seenIds.has(i.id)) { seenIds.add(i.id); uniq.push(i); } });
  return uniq.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}

function filterNew(items, sentIds) {
  const sent = new Set(sentIds || []);
  return items.filter((i) => !sent.has(i.id));
}

function buildAlertText(items, label) {
  const lines = ["⚠️ ตรวจพบความผิดปกติ " + items.length + " เรื่อง · " + label];
  items.forEach((i) => lines.push((i.severity === "high" ? "🔴 " : "🟡 ") + i.text));
  return lines.join("\n");
}

module.exports = { roomKey, parseBookings, detect, filterNew, buildAlertText };
