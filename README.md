# 🏨 Hotel Housekeeping LINE Bot
## คู่มือติดตั้ง — ใช้ LINE Messaging API

ส่งข้อมูล **เช็คอิน / เช็คเอาท์** ของวันพรุ่งนี้ไปกลุ่มไลน์แม่บ้าน  
**อัตโนมัติทุกวัน เวลา 19:00 น.** — ฟรี รันบน Render

---

## ตัวอย่างข้อความที่จะได้รับ

```
🏨 รายการห้องพักวันพรุ่งนี้
📅 วันพุธที่ 12 มีนาคม 2568
──────────────────────────
✅ เช็คอิน (2 ห้อง)
  🔑 ห้อง 101  —  สมชาย ใจดี
  🔑 ห้อง 203  —  นางสาว อรอุมา

🚪 เช็คเอาท์ (3 ห้อง)
  🧹 ห้อง 102  —  วิชัย สุขสันต์
  🧹 ห้อง 205  —  John Smith
  🧹 ห้อง 301  —  กานดา รักไทย
──────────────────────────
💌 ส่งอัตโนมัติโดยระบบโรงแรม
```

---

## ขั้นตอนที่ 1 — สร้าง LINE Official Account & ขอ Token

1. เปิด https://developers.line.biz → **Log in**
2. กด **"Create a new provider"** → ตั้งชื่อ เช่น `Hotel Bot`
3. กด **"Create a new channel"** → เลือก **Messaging API**
4. กรอกข้อมูล:
   - Channel name: `Hotel Housekeeping`
   - Channel description: `แจ้งห้องพักแม่บ้าน`
   - Category: เลือกตามต้องการ
5. เข้าไปที่ tab **"Messaging API"**
6. เลื่อนลงหา **"Channel access token"** → กด **Issue** → **คัดลอก Token**
7. ที่เมนู **"Basic settings"** เลื่อนหา **Channel secret** → คัดลอกไว้ด้วย

> 💡 ไปที่ LINE Official Account Manager → ปิด **"Auto-reply messages"** และ **"Greeting messages"**

---

## ขั้นตอนที่ 2 — Deploy บน Render + รับ Webhook URL

**2.1 อัปโหลดโค้ดขึ้น GitHub**
1. สมัคร https://github.com (ถ้ายังไม่มี)
2. สร้าง repository ใหม่ชื่อ `hotel-line-bot`
3. อัปโหลดไฟล์ทั้งหมดในโฟลเดอร์นี้

**2.2 Deploy บน Render**
1. เปิด https://dashboard.render.com → สมัครด้วย GitHub
2. **"New +"** → **"Web Service"** → เลือก repo `hotel-line-bot`
3. Build Command: `npm install` / Start Command: `node bot.js`
4. Render จะออก URL ให้อัตโนมัติ เช่น `https://hotel-line-bot.onrender.com` (ดูได้บนหน้า service)

**2.3 ตั้ง Webhook ใน LINE Developers**
1. กลับไปที่ https://developers.line.biz → Channel ของคุณ
2. Tab **"Messaging API"** → หา **"Webhook URL"**
3. ใส่: `https://hotel-line-bot.onrender.com/webhook`
4. กด **"Verify"** → ต้องขึ้น **"Success"**
5. เปิด **"Use webhook"** เป็น ON

---

## ขั้นตอนที่ 3 — หา Group ID

1. เพิ่มบอท LINE เข้ากลุ่มไลน์แม่บ้าน  
   *(ค้นหาชื่อบอทใน LINE หรือสแกน QR จาก LINE Developers)*
2. พิมพ์ข้อความใดๆ ในกลุ่ม
3. เปิด **Render → service → Logs**
4. จะเห็น log ว่า:
   ```
   🎯 พบ LINE_GROUP_ID: C1234567890abcdef...
   ➡️  คัดลอกไปใส่ใน .env: LINE_GROUP_ID=C1234567890abcdef...
   ```
5. คัดลอก Group ID นั้น

---

## ขั้นตอนที่ 4 — ใส่ Environment Variables ใน Render

ไปที่ Render → service → **Environment** → เพิ่มทีละตัว:

| Variable | ค่า |
|----------|-----|
| `LH_EMAIL` | อีเมล Login Little Hotelier |
| `LH_PASSWORD` | รหัสผ่าน Little Hotelier |
| `LINE_CHANNEL_ACCESS_TOKEN` | Token จากขั้นตอนที่ 1 |
| `LINE_GROUP_ID` | Group ID จากขั้นตอนที่ 3 |
| `CRON_SCHEDULE` | `0 19 * * *` |

กด **Manual Deploy** อีกครั้ง (หรือรอ auto-deploy) — บอทพร้อมทำงาน ✅

---

## ทดสอบส่งข้อความทันที

ดูใน Render Logs หรือรันใน terminal:
```bash
node bot.js --test
```

---

## โครงสร้างไฟล์

```
hotel-line-bot/
├── bot.js           ← โค้ดหลัก (webhook + cron + LINE Messaging API)
├── email-sync.js    ← sync อีเมลจอง OTA
├── push-badge.js    ← Web Push badge (the-loft-admin PWA)
├── slip-push.js     ← Web Push แจ้งสลิปใหม่ (Billing Console)
├── .env.example     ← ตัวอย่างค่า config
├── package.json     ← dependencies
├── Procfile         ← start command (Render อ่านไฟล์นี้ได้)
├── Dockerfile
└── README.md
```

---

## การแก้ไขปัญหา

| ปัญหา | วิธีแก้ |
|-------|---------|
| Login Little Hotelier ไม่ได้ | ตรวจ LH_EMAIL / LH_PASSWORD |
| LINE ไม่ได้รับข้อความ | ตรวจ LINE_CHANNEL_ACCESS_TOKEN และ LINE_GROUP_ID |
| Webhook Verify ไม่ผ่าน | ตรวจ Render URL และ `/webhook` ต่อท้าย |
| ข้อมูลห้องว่างเปล่า | ดู log ใน Render — อาจต้องปรับ CSS selector |
