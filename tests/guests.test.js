const g = require("../guests.js");
const assert = require("assert");
const mkEmail = (from, subject, text) => ({ from: { value: [{ address: from }] }, subject, text });

// Airbnb (รูปแบบจากอีเมลจริง)
const abb = mkEmail("automated@airbnb.com", "Reservation confirmed - Test Guest arrives Oct 11",
 "NEW BOOKING CONFIRMED!\n\nCheck-in Checkout\n\nSun, Oct 11 Tue, Oct 13\n\nGUESTS\n\n1 adult\n\nMORE DETAILS ABOUT WHO’S COMING\n\nGuests will now let you know if they’re bringing children\nand infants.\n\nCONFIRMATION CODE\nHMX39CZRJK");
const abb2 = mkEmail("automated@airbnb.com", "Reservation confirmed - Family Name arrives Nov 2",
 "GUESTS\n\n2 adults, 1 child\n\nMORE DETAILS ABOUT WHO’S COMING\n\nCONFIRMATION CODE\nXX");
const abb3 = mkEmail("automated@airbnb.com", "Reservation confirmed - Big Family arrives Dec 5",
 "GUESTS 3 adults, 2 children, 1 infant MORE DETAILS ABOUT WHO’S COMING CONFIRMATION CODE");
// Booking.com via LH detail
const bk = mkEmail("no-reply@app.littlehotelier.com", "Booking.com Booking for # 5138215548 for Chairach, Tharanyu, Arriving 30-Oct-2026",
 "| Check-in: 30-Oct-2026 Check-out: 03-Nov-2026 |\n| Guest Count: Number of adults : 2 |\n| Guest: Tharanyu Chairach | Age: |\n\n| Guest Count: Number of adults : 2 |");
// Trip.com
const trip = mkEmail("noreply_htl@trip.com", "Booking no. #1622930961967037# accepted",
 "| Guest Name: Saphanthong/Chinchutha |\n| Staying period:Oct 10, 2026 - Oct 14, 2026 | 4 night(s) |\n| Guests (estimated):2 adults |\n| ราคานี้สำหรับ ผู้ใหญ่ 2 คน |");
const tripTh = mkEmail("noreply_htl@trip.com", "x", "| Guest Name: Foo/Bar |\n| Staying period:Nov 1, 2026 - Nov 3, 2026 |\n| ผู้เข้าพัก (โดยประมาณ):ผู้ใหญ่ 2 คน เด็ก 1 คน |");

const idx = g.buildGuestIndex([abb, abb2, abb3, bk, trip, tripTh]);
const L = (guest, checkIn) => g.lookupGuests(idx, { guest, checkIn });

assert.deepStrictEqual(L("Test Guest", "2026-10-11"), { adults: 1, children: 0 });
assert.deepStrictEqual(L("Family Name", "2026-11-02"), { adults: 2, children: 1 });
assert.deepStrictEqual(L("Big Family", "2026-12-05"), { adults: 3, children: 3 }); // infant รวมในเด็ก
assert.deepStrictEqual(L("Tharanyu Chairach", "2026-10-30"), { adults: 2, children: 0 });
assert.deepStrictEqual(L("Chinchutha Saphanthong", "2026-10-10"), { adults: 2, children: 0 });
assert.deepStrictEqual(L("Bar Foo", "2026-11-01"), { adults: 2, children: 1 });
// ไม่มีคู่ → null (ไม่เดา)
assert.strictEqual(L("Nobody Here", "2026-10-11"), null);
assert.strictEqual(L("Test Guest", "2026-10-12"), null); // คนละวัน
// subset match ต้อง >= 2 token
assert.strictEqual(L("Test", "2026-10-11"), null);
assert.deepStrictEqual(L("Test Guest Junior", "2026-10-11"), { adults: 1, children: 0 });

assert.strictEqual(g.isGuestOnlyEmail(trip), true);
assert.strictEqual(g.isGuestOnlyEmail(abb), false);

// format
assert.strictEqual(g.formatGuestsTh({ adults: 2, children: 1 }), "3 ท่าน (ผู้ใหญ่ 2 / เด็ก 1)");
assert.strictEqual(g.formatGuestsTh({ adults: 2, children: 0 }), "2 ท่าน");
assert.strictEqual(g.formatGuestsTh(null), "ไม่ระบุ");
assert.strictEqual(g.formatGuestsTh({ adults: 0, children: 0 }), "ไม่ระบุ");
assert.strictEqual(g.formatGuestsTh({ adults: 0, children: 0, total: 4 }), "4 ท่าน");

// sheet row
const h = ["A","B","C","D","E","F","G","H","Apartmentery Booking ID","Adults","Children","Guests"];
const ix = g.guestColIndexes(h);
assert.deepStrictEqual(ix, { adults: 9, children: 10, total: 11 });
assert.deepStrictEqual(g.guestsFromRow(["","","","","","","","","","2","1","3"], ix), { adults: 2, children: 1, total: 3 });
assert.strictEqual(g.guestsFromRow(["","","","","","","","","x"], ix), null);
assert.deepStrictEqual(g.guestsFromRow(["","","","","","","","","","","","4"], ix), { adults: 0, children: 0, total: 4 });
assert.strictEqual(g.colLetter(0), "A"); assert.strictEqual(g.colLetter(25), "Z"); assert.strictEqual(g.colLetter(26), "AA");
// สำเนียง: precomposed / decomposed / ตัดสำเนียง / "นามสกุล, ชื่อ" ต้องจับคู่ได้ทั้งหมด
{
  const pre = "Andrius Rudavi\u010dius", dec = "Andrius Rudavic\u030cius";
  for (const [subj, guest] of [[pre, pre], [dec, pre], [pre, dec], ["Andrius Rudavicius", pre], [pre, "Rudavi\u010dius, Andrius"]]) {
    const ix = g.buildGuestIndex([mkEmail("automated@airbnb.com", "Reservation confirmed - " + subj + " arrives Oct 16", "GUESTS\n\n1 adult\n\nMORE DETAILS")]);
    assert.deepStrictEqual(g.lookupGuests(ix, { guest, checkIn: "2026-10-16" }), { adults: 1, children: 0 });
  }
}
// อีโมจิตามจำนวนแขก
assert.strictEqual(g.guestsLine({ adults: 1, children: 0 }), "\u{1F9CD} 1 ท่าน");
assert.strictEqual(g.guestsLine({ adults: 2, children: 0 }), "\u{1F46B} 2 ท่าน");
assert.strictEqual(g.guestsLine({ adults: 2, children: 1 }), "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} 3 ท่าน (ผู้ใหญ่ 2 / เด็ก 1)");
assert.strictEqual(g.guestsLine({ adults: 3, children: 2 }).startsWith("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} 5 ท่าน"), true);
assert.strictEqual(g.guestsLine({ adults: 0, children: 0, total: 6 }).startsWith("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} 6"), true); // กรอกเฉพาะยอดรวม
assert.strictEqual(g.guestsLine(null), "\u2753 ไม่ระบุ");
console.log("ALL OK");
