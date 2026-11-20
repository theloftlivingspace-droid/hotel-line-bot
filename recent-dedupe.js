"use strict";
// กันส่งซ้ำ: จำคีย์ที่เพิ่งทำไปแล้วไว้ช่วงสั้น ๆ (ในหน่วยความจำ — พอสำหรับกดรัว ๆ / ส่งซ้ำจากฟอร์ม)
function makeDeduper(ttlMs, max) {
  const m = new Map();
  max = max || 500;
  const prune = (now) => { for (const [k, t] of m) if (now - t > ttlMs) m.delete(k); while (m.size > max) m.delete(m.keys().next().value); };
  return {
    seen(key, now) { if (now == null) now = Date.now(); prune(now); return m.has(key); },
    mark(key, now) { if (now == null) now = Date.now(); prune(now); m.set(key, now); },
    clear(key) { m.delete(key); },
  };
}
module.exports = { makeDeduper };
