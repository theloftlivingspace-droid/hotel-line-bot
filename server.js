require("dotenv").config();

const express = require("express");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");
const fetch   = require("node-fetch");
const multer  = require("multer");
const XLSX    = require("xlsx");

const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app  = express();
const PORT = process.env.PORT || 3000;

const CHANNEL_SECRET  = process.env.LINE_CHANNEL_SECRET  || "";
const CHANNEL_TOKEN   = process.env.LINE_CHANNEL_TOKEN   || "";
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN          || "apt2025@secret";
const REDIS_URL       = process.env.UPSTASH_REDIS_REST_URL   || "https://thorough-dogfish-77360.upstash.io";
const REDIS_TOKEN     = process.env.UPSTASH_REDIS_REST_TOKEN || "gQAAAAAAAS4wAAIncDExNzdhOTliNWYzMzI0NTljYmZiZDhkZWEyYzI1OGU3NXAxNzczNjA";

// ── Upstash Redis REST helpers ────────────────────────────────
async function redisGet(key) {
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch { return null; }
}

async function redisSet(key, value) {
  try {
    const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json();
    return data.result === "OK";
  } catch(e) { console.error("Redis SET error:", e.message); return false; }
}

// ── Storage functions (Redis-backed, fallback to file) ─────────
const DATA_DIR      = path.join(__dirname, "data");
const ROOMS_FILE    = path.join(DATA_DIR, "rooms.json");
const USERS_FILE    = path.join(DATA_DIR, "users.json");
const PAYMENTS_FILE = path.join(DATA_DIR, "payments.json");
const LOG_FILE      = path.join(DATA_DIR, "send-log.json");

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJSON(file, data) {
  ensureDir(path.dirname(file));
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); } catch {}
}

async function loadRooms() {
  const r = await redisGet("rooms");
  if (r) return r;
  const fromFile = loadJSON(ROOMS_FILE, null);
  if (fromFile) return fromFile;
  return buildDefaultRooms();
}
async function saveRooms(r) {
  await redisSet("rooms", r);
  saveJSON(ROOMS_FILE, r);
}
async function loadUsers() {
  const u = await redisGet("users");
  if (u) return u;
  return loadJSON(USERS_FILE, {});
}
async function saveUsers(u) {
  await redisSet("users", u);
  saveJSON(USERS_FILE, u);
}
async function loadPayments() {
  const p = await redisGet("payments");
  if (p) return p;
  return loadJSON(PAYMENTS_FILE, []);
}
async function savePayments(p) {
  // เก็บ metadata ใน Redis ปกติ (ไม่มี imageBase64)
  const meta = p.map(({imageBase64, ...rest}) => rest);
  await redisSet("payments", meta);
  saveJSON(PAYMENTS_FILE, p);
  // เก็บรูปแยกต่างหาก พร้อม TTL 60 วัน
  for(const pay of p) {
    if(pay.imageBase64) {
      try {
        await fetch(`${REDIS_URL}/set`, {
          method:"POST",
          headers:{Authorization:`Bearer ${REDIS_TOKEN}`,"Content-Type":"application/json"},
          body: JSON.stringify([`slip_img:${pay.id}`, pay.imageBase64, "EX", 5184000])
        });
      } catch{}
    }
  }
}

function buildDefaultRooms() {
  const data = [
    {roomNumber:"101",tenantName:"สุณิสา จงจิตตาภิบาล",                    amount:4902, invoiceLink:"https://aprty.co/i/rQQAq58n8"},
    {roomNumber:"102",tenantName:"เพลินพิศ โค้งอาภาส",                     amount:2761, invoiceLink:"https://aprty.co/i/V11kwAKGW"},
    {roomNumber:"103",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:6312, invoiceLink:"https://aprty.co/i/eGGz9Qvxr"},
    {roomNumber:"106",tenantName:"วีรภา ภู่ชำนาญ",                         amount:2599, invoiceLink:"https://aprty.co/i/pGG0BqYJ0"},
    {roomNumber:"107",tenantName:"นันทิดา ชวนพิศ",                         amount:4525, invoiceLink:"https://aprty.co/i/nggmqLA9r"},
    {roomNumber:"108",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:5853, invoiceLink:"https://aprty.co/i/9llLkr93M"},
    {roomNumber:"110",tenantName:"สำฤทธิ์ อุตตะมะ",                        amount:2602, invoiceLink:"https://aprty.co/i/aGGMgAzan"},
    {roomNumber:"111",tenantName:"วิชชุอร ภู่วงค์",                         amount:2200, invoiceLink:"https://aprty.co/i/k997qB6Ja"},
    {roomNumber:"113",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:3980, invoiceLink:"https://aprty.co/i/Dee7Yr9g0"},
    {roomNumber:"201",tenantName:"ธนัชพร บัวบาน",                          amount:2336, invoiceLink:"https://aprty.co/i/611Bqr9nD"},
    {roomNumber:"202",tenantName:"รุ่งนภา วีระนรพานิช",                     amount:5233, invoiceLink:"https://aprty.co/i/wXXxyvQ7j"},
    {roomNumber:"203",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:5832, invoiceLink:"https://aprty.co/i/NeeZqA936"},
    {roomNumber:"204",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:5280, invoiceLink:"https://aprty.co/i/KeeANZ936"},
    {roomNumber:"205",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:6080, invoiceLink:"https://aprty.co/i/1DDwQr9V4"},
    {roomNumber:"206",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:3016, invoiceLink:"https://aprty.co/i/XBBwkAXpk"},
    {roomNumber:"207",tenantName:"โสริยา วิสัยเกตุ",                        amount:1075, invoiceLink:"https://aprty.co/i/xBBjJ4GWq"},
    {roomNumber:"212",tenantName:"ธาราทิพย์ บุตรดี",                        amount:2404, invoiceLink:"https://aprty.co/i/lVV3Ll09m"},
    {roomNumber:"213",tenantName:"จิรภา คาขุนทด",                          amount:4132, invoiceLink:"https://aprty.co/i/lVV3Ll06Z"},
    {roomNumber:"214",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:6235, invoiceLink:"https://aprty.co/i/LeedKA9Zj"},
    {roomNumber:"300",tenantName:"บริษัท เดอะ ลอฟท์ ลิฟวิ่ง สเปซ จำกัด",  amount:8016, invoiceLink:"https://aprty.co/i/MeeY1A9mX"},
    {roomNumber:"301",tenantName:"สุภัทราวลี สิทธิศร",                      amount:2068, invoiceLink:"https://aprty.co/i/Dee7Yr9gw"},
    {roomNumber:"304",tenantName:"อนันท์ ยามดี",                            amount:2381, invoiceLink:"https://aprty.co/i/QDDj7A9pZ"},
    {roomNumber:"305",tenantName:"ดวงเดือน ลาภทวี",                         amount:2310, invoiceLink:"https://aprty.co/i/wXXxyvQ7a"},
    {roomNumber:"306",tenantName:"ฉันทพิชญา ใสใหม",                         amount:3898, invoiceLink:"https://aprty.co/i/NeeZqA93d"},
    {roomNumber:"307",tenantName:"บัว เหลือบแล",                            amount:2598, invoiceLink:"https://aprty.co/i/KeeANZ93e"},
    {roomNumber:"308",tenantName:"มุกธิดา อินทร์ไทยวงษ์",                   amount:5036, invoiceLink:"https://aprty.co/i/1DDwQr9Ve"},
    {roomNumber:"309",tenantName:"สันทนา นรานอก",                           amount:2216, invoiceLink:"https://aprty.co/i/XBBwkAXpp"},
    {roomNumber:"310",tenantName:"กองคำ นามปัญญา",                          amount:4074, invoiceLink:"https://aprty.co/i/Beev0r9Z3"},
    {roomNumber:"311",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:5833, invoiceLink:"https://aprty.co/i/lVV3Ll09p"},
    {roomNumber:"312",tenantName:"อิดดาเร๊ะ วาแม",                          amount:2256, invoiceLink:"https://aprty.co/i/zWWra3Kwo"},
    {roomNumber:"314",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:3138, invoiceLink:"https://aprty.co/i/LeedKA9Zl"},
    {roomNumber:"315",tenantName:"ฤกษ์มงคล เย็นใจ",                         amount:3346, invoiceLink:"https://aprty.co/i/MeeY1A9mn"},
    {roomNumber:"316",tenantName:"กัญญาพร คล่องแคล่ว",                      amount:2100, invoiceLink:"https://aprty.co/i/qDDyBRZ7Y"},
    {roomNumber:"402",tenantName:"พงศกร อาษานอก",                           amount:2312, invoiceLink:"https://aprty.co/i/RQQk7dD3m"},
    {roomNumber:"403",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:3248, invoiceLink:"https://aprty.co/i/5KKX1V9n3"},
    {roomNumber:"404",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:2232, invoiceLink:"https://aprty.co/i/zWWra3KD3"},
    {roomNumber:"405",tenantName:"Nan Mue Noke",                            amount:3074, invoiceLink:"https://aprty.co/i/oGG6aMd3L"},
    {roomNumber:"406",tenantName:"ชาญวุฒิ รุ่งฤทธิ์ดี",                     amount:5870, invoiceLink:"https://aprty.co/i/Geem8r93n"},
    {roomNumber:"407",tenantName:"นาย จักรินทร์ เวียงลอ",                   amount:2320, invoiceLink:"https://aprty.co/i/dee5rDO76"},
    {roomNumber:"408",tenantName:"ไชยยันห์ ดาโอภา",                         amount:2456, invoiceLink:"https://aprty.co/i/v118qODJW"},
    {roomNumber:"409",tenantName:"สุจินต์ จงกรฏ",                           amount:3436, invoiceLink:"https://aprty.co/i/4NN1Kr9e4"},
    {roomNumber:"410",tenantName:"เจนจิรา ปัดถาวโร",                        amount:3068, invoiceLink:"https://aprty.co/i/7XXljr9vO"},
    {roomNumber:"411",tenantName:"นุสรา บุญจันทร์",                          amount:3916, invoiceLink:"https://aprty.co/i/3wwKNa980"},
    {roomNumber:"412",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:2795, invoiceLink:"https://aprty.co/i/Jeeywr93x"},
    {roomNumber:"413",tenantName:"สุทธินันท์ เวียงนนท์",                    amount:2258, invoiceLink:"https://aprty.co/i/rQQAq58KW"},
    {roomNumber:"414",tenantName:"สถาพร โพธิ์แก้วเจริญพันธ์",              amount:2954, invoiceLink:"https://aprty.co/i/611Bqr9vD"},
    {roomNumber:"415",tenantName:"เสงี่ยม แดงวิบูลย์",                      amount:2496, invoiceLink:"https://aprty.co/i/066QDr987"},
    {roomNumber:"416",tenantName:"วีรศักดิ์ กองสุข",                         amount:2600, invoiceLink:"https://aprty.co/i/yllgJ7Nkg"},
    {roomNumber:"506",tenantName:"ทองใส มโนธรรม",                            amount:2214, invoiceLink:"https://aprty.co/i/AeeOqr9YZ"},
    {roomNumber:"507",tenantName:"ยลลดา โอสถศรี",                            amount:2054, invoiceLink:"https://aprty.co/i/k997qB7zR"},
    {roomNumber:"509",tenantName:"วิมลรัตน์ ทองผุย",                         amount:3184, invoiceLink:"https://aprty.co/i/dee5rDOpR"},
    {roomNumber:"512",tenantName:"บริษัท แอส บิลท์ เอ็นจิเนียริ่ง จำกัด", amount:2372, invoiceLink:"https://aprty.co/i/YllN1ABp8"},
    {roomNumber:"513",tenantName:"เด็จฤดี มีชัย",                            amount:3028, invoiceLink:"https://aprty.co/i/ZWWKRAkpl"},
    {roomNumber:"514",tenantName:"ลัศติพัจค์ บางปา",                         amount:1900, invoiceLink:"https://aprty.co/i/8BBW7ra4j"},
    {roomNumber:"515",tenantName:"อมรวิทย์ วรรณทอง",                         amount:2700, invoiceLink:"https://aprty.co/i/xBBjJ4wRk"},
  ];
  const rooms = {};
  data.forEach(d => { rooms[d.roomNumber] = {...d, lineUserId:""}; });
  return rooms;
}

async function setRichMenuForUser(userId) {
  const idFile = path.join(__dirname, "rich-menu-id.txt");
  if (!fs.existsSync(idFile)) return;
  const richMenuId = fs.readFileSync(idFile, "utf8").trim();
  if (!richMenuId) return;
  try {
    await fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` },
    });
    console.log(`[RichMenu] ตั้ง rich menu ให้ ${userId} สำเร็จ`);
  } catch (e) {
    console.error("[RichMenu Error]", e.message);
  }
}

async function lineReply(replyToken, messages) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${CHANNEL_TOKEN}`},
    body: JSON.stringify({replyToken, messages}),
  });
}
async function linePush(to, messages) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${CHANNEL_TOKEN}`},
    body: JSON.stringify({to, messages}),
  });
}
async function getLineProfile(userId) {
  const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {headers:{"Authorization":`Bearer ${CHANNEL_TOKEN}`}});
  if (res.ok) return res.json();
  return {displayName:"ผู้เช่า"};
}

function floorButtons(rooms) {
  const floors = [...new Set(Object.keys(rooms).map(r => r[0]))].sort();
  return {
    type:"text", text:"กรุณาเลือกชั้นของคุณ 👇",
    quickReply:{items: floors.map(f => ({type:"action",action:{type:"message",label:`ชั้น ${f}`,text:`ชั้น${f}`}}))}
  };
}
function roomButtons(floor, rooms) {
  const floorRooms = Object.values(rooms)
    .filter(r => r.roomNumber[0] === floor && !r.lineUserId) // ซ่อนห้องที่ลงทะเบียนแล้ว
    .sort((a,b) => a.roomNumber.localeCompare(b.roomNumber));

  if (!floorRooms.length) {
    return [{ type:"text", text:`ชั้น ${floor} ทุกห้องลงทะเบียนครบแล้วค่ะ 🎉\nหากต้องการแก้ไข กรุณาพิมพ์เลขห้องได้เลยค่ะ` }];
  }

  const chunkSize = 8;
  const chunks = [];
  for (let i = 0; i < floorRooms.length; i += chunkSize) {
    chunks.push(floorRooms.slice(i, i + chunkSize));
  }

  const bubbles = chunks.map((chunk, idx) => ({
    type: "bubble",
    size: "micro",
    header: {
      type: "box", layout: "vertical", backgroundColor: "#0d9488",
      contents: [{ type: "text", text: `ชั้น ${floor}${chunks.length > 1 ? ` (${idx+1}/${chunks.length})` : ""}`, color: "#ffffff", size: "sm", weight: "bold" }]
    },
    body: {
      type: "box", layout: "vertical", spacing: "sm", paddingAll: "8px",
      contents: chunk.map(r => ({
        type: "button", style: "secondary", height: "sm",
        action: { type: "message", label: `ห้อง ${r.roomNumber}`, text: `room:${r.roomNumber}` }
      }))
    }
  }));

  return [{
    type: "flex",
    altText: `เลือกห้องชั้น ${floor}`,
    contents: { type: "carousel", contents: bubbles }
  }];
}
function confirmButtons(roomNum, tenantName) {
  return {
    type: "text",
    text: `ยืนยันการลงทะเบียนค่ะ\n\n🏠 ห้อง: ${roomNum}\n👤 ชื่อ: ${tenantName||"(ยังไม่ระบุ)"}\n\nพิมพ์ "ยืนยัน" เพื่อยืนยัน\nหรือพิมพ์เลขห้องใหม่เพื่อแก้ไขค่ะ`,
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "✅ ยืนยัน",    text: "confirm:yes" } },
        { type: "action", action: { type: "message", label: "❌ เลือกใหม่", text: "confirm:no"  } },
      ]
    }
  };
}

function verifySignature(rawBody, signature) {
  if (!CHANNEL_SECRET) return true;
  const hash = crypto.createHmac("SHA256", CHANNEL_SECRET).update(rawBody).digest("base64");
  return hash === signature;
}

app.use((req, res, next) => {
  let data="";
  req.on("data", chunk => (data += chunk));
  req.on("end", () => { req.rawBody=data; req.body=data?JSON.parse(data):{}; next(); });
});
app.use(express.static(path.join(__dirname, "public")));

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({error:"Unauthorized"});
  next();
}

async function downloadLineImage(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {headers:{"Authorization":`Bearer ${CHANNEL_TOKEN}`}});
  if (!res.ok) throw new Error(`ดาวน์โหลดรูปล้มเหลว: ${res.status}`);
  return (await res.buffer()).toString("base64");
}

async function verifySlipWithAI(base64Image, expectedAmount) {
  if (!process.env.ANTHROPIC_API_KEY) return {isSlip:false, amount:null};
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
    body: JSON.stringify({
      model:"claude-opus-4-6", max_tokens:300,
      messages:[{role:"user",content:[
        {type:"image",source:{type:"base64",media_type:"image/jpeg",data:base64Image}},
        {type:"text",text:`สลิปโอนเงิน ตอบ JSON เท่านั้น:\n{"isSlip":bool,"amount":number_or_null,"bankName":"string","toAccount":"string","date":"string"}\nยอดที่คาดหวัง: ${expectedAmount} บาท`}
      ]}]
    }),
  });
  if (!res.ok) return {isSlip:false, amount:null};
  const data = await res.json();
  try { return JSON.parse(data.content?.[0]?.text?.replace(/```json|```/g,"").trim()||"{}"); }
  catch { return {isSlip:false, amount:null}; }
}

async function handleFollow(event) {
  const {userId} = event.source;
  const users = await loadUsers();
  const rooms = await loadRooms();
  const profile = await getLineProfile(userId);
  users[userId] = {userId, displayName:profile.displayName, state:"WAIT_FLOOR", pendingFloor:null, pendingRoom:null,
    roomNumber:users[userId]?.roomNumber||null, registeredAt:users[userId]?.registeredAt||new Date().toISOString(), updatedAt:new Date().toISOString()};
  await saveUsers(users);
  await lineReply(event.replyToken, [
    {type:"text", text:`สวัสดีค่ะ คุณ${profile.displayName} 👋\n\nยินดีต้อนรับสู่ระบบบริการผู้พักอาศัยค่ะ\nกรุณาเลือกชั้นและห้องของคุณด้านล่างเพื่อลงทะเบียนค่ะ`},
    floorButtons(rooms),
  ]);
  console.log(`[Follow] ${profile.displayName} (${userId})`);
}

async function handleUnfollow(event) {
  const {userId} = event.source;
  const rooms = await loadRooms(); const users = await loadUsers();
  const user = users[userId];
  if (user?.roomNumber && rooms[user.roomNumber]) { rooms[user.roomNumber].lineUserId=""; await saveRooms(rooms); }
  if (users[userId]) { users[userId].state="INACTIVE"; users[userId].updatedAt=new Date().toISOString(); await saveUsers(users); }
  console.log(`[Unfollow] ${userId}`);
}

async function handleMessage(event) {
  const {userId} = event.source;
  const text = event.message.text?.trim()||"";
  const users = await loadUsers(); const rooms = await loadRooms();
  let user = users[userId];
  if (!user) {
    const profile = await getLineProfile(userId);
    user = users[userId] = {userId, displayName:profile.displayName, state:"WAIT_FLOOR", pendingFloor:null, pendingRoom:null, roomNumber:null};
  }

  const floorMatch = text.match(/^ชั้น(\d)/);
  if (floorMatch) {
    users[userId].state="WAIT_ROOM"; users[userId].pendingFloor=floorMatch[1]; users[userId].updatedAt=new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, roomButtons(floorMatch[1], rooms));
    return;
  }

  const roomMatch = text.match(/^room:(\w+)/);
  if (roomMatch) {
    const roomNum = roomMatch[1];
    if (!rooms[roomNum]) { await lineReply(event.replyToken, [{type:"text",text:`ไม่พบห้อง ${roomNum} ค่ะ`}]); return; }
    const existing = rooms[roomNum].lineUserId;
    if (existing && existing !== userId) { await lineReply(event.replyToken, [{type:"text",text:`ห้อง ${roomNum} ถูกลงทะเบียนไปแล้วค่ะ\nกรุณาติดต่อผู้จัดการอาคารค่ะ`}]); return; }
    users[userId].state="CONFIRM_ROOM"; users[userId].pendingRoom=roomNum; users[userId].updatedAt=new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, [confirmButtons(roomNum, rooms[roomNum].tenantName)]);
    return;
  }

  // ── พิมพ์เลขห้องตรงๆ เช่น "315", "101" ──────────────────────
  const directRoomMatch = text.match(/^(?:ห้อง\s*)?(\d{3,4})$/);
  if (directRoomMatch) {
    const roomNum = directRoomMatch[1];
    if (!rooms[roomNum]) {
      await lineReply(event.replyToken, [{type:"text",
        text:`ไม่พบห้อง ${roomNum} ในระบบค่ะ\nกรุณาตรวจสอบเลขห้องและลองใหม่อีกครั้งค่ะ`
      }]);
      return;
    }
    const existing = rooms[roomNum].lineUserId;
    if (existing && existing !== userId) {
      await lineReply(event.replyToken, [{type:"text",
        text:`ห้อง ${roomNum} ถูกลงทะเบียนไปแล้วค่ะ\nกรุณาติดต่อผู้จัดการอาคารค่ะ`
      }]);
      return;
    }
    users[userId].state="CONFIRM_ROOM"; users[userId].pendingRoom=roomNum; users[userId].updatedAt=new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, [confirmButtons(roomNum, rooms[roomNum].tenantName)]);
    return;
  }

  if (text==="confirm:yes" && user.state==="CONFIRM_ROOM") {
    const roomNum = user.pendingRoom;
    rooms[roomNum].lineUserId=userId; await saveRooms(rooms);
    users[userId].state="REGISTERED"; users[userId].roomNumber=roomNum; users[userId].pendingRoom=null; users[userId].updatedAt=new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, [{type:"text",text:`✅ ลงทะเบียนห้อง ${roomNum} สำเร็จแล้วค่ะ\n\nคุณจะได้รับการแจ้งเตือนค่าเช่าทาง LINE ทุกเดือนอัตโนมัติค่ะ`}]);
    console.log(`[Registered] ห้อง ${roomNum} <- ${userId}`);
    setRichMenuForUser(userId); // ตั้ง Rich Menu อัตโนมัติ
    return;
  }

  if (text==="confirm:no") {
    users[userId].state="WAIT_FLOOR"; users[userId].pendingRoom=null; users[userId].updatedAt=new Date().toISOString();
    await saveUsers(users);
    await lineReply(event.replyToken, [floorButtons(rooms)]);
    return;
  }

  if (text==="เปลี่ยนห้อง"||text==="แก้ไขห้อง"||text==="ลงทะเบียน") {
    users[userId].state="WAIT_FLOOR"; await saveUsers(users);
    await lineReply(event.replyToken, [floorButtons(rooms)]);
    return;
  }

  // ── รับข้อความขอเอกสาร ────────────────────────────────────────
  if (user.state === "WAIT_DOC_REQUEST") {
    users[userId].state = "REGISTERED";
    await saveUsers(users);
    const roomNum = user.roomNumber || "ไม่ระบุ";
    // แจ้ง admin ผ่าน log (ในระบบจริงอาจ push ไปแชท admin)
    const docLogs = loadJSON(path.join(__dirname,"data","doc-requests.json"), []);
    docLogs.unshift({ date:new Date().toISOString(), roomNumber:roomNum, userId, request:text });
    saveJSON(path.join(__dirname,"data","doc-requests.json"), docLogs.slice(0,200));
    await lineReply(event.replyToken, [{type:"text",
      text:`✅ รับเรื่องขอเอกสารแล้วค่ะ\n\nห้อง: ${roomNum}\nเอกสารที่ต้องการ: ${text}\n\nเจ้าหน้าที่จะดำเนินการและแจ้งให้ทราบภายใน 1-2 วันทำการค่ะ 😊`
    }]);
    return;
  }

  // ── รับข้อความติดต่อเจ้าหน้าที่ ──────────────────────────────
  if (user.state === "WAIT_CONTACT_MSG") {
    users[userId].state = "REGISTERED";
    await saveUsers(users);
    const roomNum = user.roomNumber || "ไม่ระบุ";

    // ── แจ้งย้ายออก ──────────────────────────────────────────
    if (text === "แจ้งย้ายออก" || text.includes("ย้ายออก")) {
      users[userId].state = "WAIT_MOVEOUT_DATE";
      await saveUsers(users);
      await lineReply(event.replyToken, [{type:"text",
        text:`📦 แจ้งย้ายออกห้อง ${roomNum} ค่ะ\n\n` +
        `📋 เงื่อนไขการย้ายออก\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `1️⃣ ต้องแจ้งเป็นลายลักษณ์อักษรล่วงหน้าอย่างน้อย 1 เดือน\n` +
        `2️⃣ การย้ายออกต้องภายในวันสิ้นเดือนเท่านั้น\n` +
        `3️⃣ ต้องชำระค่าเช่าของเดือนสุดท้ายให้ครบถ้วน\n` +
        `4️⃣ หากละเมิดเงื่อนไข จะไม่ได้รับเงินประกันคืน หรือต้องคืนห้องทันที\n` +
        `5️⃣ ทั้งนี้ให้เป็นไปตามสัญญาเช่าทุกประการ\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `กรุณาระบุวันที่ต้องการย้ายออกค่ะ\n` +
        `เช่น: ย้ายออกวันที่ 31 พฤษภาคม 2569\n\nพิมพ์รายละเอียดได้เลยค่ะ 👇`
      }]);
      return;
    }

    const contactLogs = loadJSON(path.join(__dirname,"data","contact-logs.json"), []);
    contactLogs.unshift({ date:new Date().toISOString(), roomNumber:roomNum, userId, message:text });
    saveJSON(path.join(__dirname,"data","contact-logs.json"), contactLogs.slice(0,200));
    await lineReply(event.replyToken, [{type:"text",
      text:`✅ รับเรื่องแล้วค่ะ\n\nห้อง: ${roomNum}\nเรื่อง: ${text}\n\nเจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุดค่ะ 😊`
    }]);
    return;
  }

  // ── รับวันที่ย้ายออก ──────────────────────────────────────────
  if (user.state === "WAIT_MOVEOUT_DATE") {
    users[userId].state = "REGISTERED";
    await saveUsers(users);
    const roomNum = user.roomNumber || "ไม่ระบุ";

    // บันทึกลง moveout-requests.json
    const moveoutLogs = loadJSON(path.join(__dirname,"data","moveout-requests.json"), []);
    moveoutLogs.unshift({
      date: new Date().toISOString(),
      roomNumber: roomNum,
      tenantName: rooms[roomNum]?.tenantName || "ไม่ระบุ",
      userId,
      moveoutDetail: text,
      status: "pending",
    });
    saveJSON(path.join(__dirname,"data","moveout-requests.json"), moveoutLogs.slice(0,200));

    await lineReply(event.replyToken, [{type:"text",
      text:`✅ รับแจ้งย้ายออกเป็นลายลักษณ์อักษรแล้วค่ะ\n\n` +
      `🏠 ห้อง: ${roomNum}\n` +
      `👤 ชื่อ: ${rooms[roomNum]?.tenantName || "ไม่ระบุ"}\n` +
      `📅 รายละเอียด: ${text}\n\n` +
      `📋 สรุปเงื่อนไขที่ต้องปฏิบัติ\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `✔️ การย้ายออกต้องภายในวันสิ้นเดือนเท่านั้น\n` +
      `✔️ ชำระค่าเช่าของเดือนสุดท้ายให้ครบถ้วน\n` +
      `✔️ หากละเมิดเงื่อนไข จะไม่ได้รับเงินประกันคืน\n` +
      `✔️ ทั้งนี้ให้เป็นไปตามสัญญาเช่าทุกประการ\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `เจ้าหน้าที่จะติดต่อกลับเพื่อนัดหมายตรวจสอบห้องและดำเนินการต่อไปค่ะ 😊`
    }]);
    return;
  }

  if (user.state==="REGISTERED") {
    await lineReply(event.replyToken, [{type:"text",text:`คุณลงทะเบียนห้อง ${user.roomNumber} เรียบร้อยแล้วค่ะ\nหากต้องการเปลี่ยนห้อง พิมพ์ "เปลี่ยนห้อง" ได้เลยค่ะ`}]);
    return;
  }

  users[userId].state="WAIT_FLOOR"; await saveUsers(users);
  await lineReply(event.replyToken, [{type:"text",text:"กรุณาเลือกชั้นของคุณค่ะ"}, floorButtons(rooms)]);
}

async function handleImageMessage(event) {
  const {userId} = event.source;
  const users = await loadUsers(); const rooms = await loadRooms();
  const user = users[userId];
  if (!user?.roomNumber) { await lineReply(event.replyToken, [{type:"text",text:"กรุณาลงทะเบียนห้องก่อนส่งสลิปค่ะ"}]); return; }
  const room = rooms[user.roomNumber];
  if (!room) return;

  // หาทุกห้องที่ใช้ userId เดียวกัน
  const myRooms = Object.values(rooms).filter(r => r.lineUserId === userId);
  const roomList = myRooms.map(r => r.roomNumber).join(", ");
  const totalAmount = myRooms.reduce((s,r) => s + Number(r.amount), 0);

  // ประมวลผลรูปโดยไม่ส่งข้อความก่อน
  try {
    const base64 = await downloadLineImage(event.message.id);
    const result = await verifySlipWithAI(base64, totalAmount);
    const slipAmount = result.amount ? Number(result.amount) : null;
    const amountMatch = slipAmount!==null && Math.abs(slipAmount-totalAmount)<1;
    const payment = {
      id:Date.now().toString(), roomNumber:roomList, tenantName:room.tenantName,
      userId, messageId:event.message.id,
      imageBase64: base64, // เก็บรูปไว้ถาวร
      slipAmount, expectedAmount:totalAmount, amountMatch,
      isSlip:result.isSlip, bankName:result.bankName||null, toAccount:result.toAccount||null, date:result.date||null,
      status:(result.isSlip&&amountMatch)?"confirmed":"pending_review", receivedAt:new Date().toISOString(),
    };
    const payments = await loadPayments(); payments.unshift(payment); await savePayments(payments.slice(0,200));
    let replyText;
    if (!result.isSlip) replyText =
      `📸 ได้รับรูปภาพแล้วค่ะ\n\n🏠 ห้อง: ${roomList}\n\nเจ้าหน้าที่รับเรื่องแล้วและจะติดต่อกลับโดยเร็วที่สุดค่ะ 😊\n\n━━━━━━━━━━━━━━━━\n💡 หากส่งสลิปชำระค่าเช่า กรุณารอการยืนยันจากเจ้าหน้าที่ค่ะ`;
    else if (amountMatch) replyText =
      `✅ ได้รับสลิปเรียบร้อยค่ะ\n\n🏠 ห้อง: ${roomList}\nยอดโอน: ${slipAmount.toLocaleString("th-TH",{minimumFractionDigits:2})} บาท\n${result.bankName?`ธนาคาร: ${result.bankName}\n`:""}${result.date?`วันที่: ${result.date}\n`:""}\nทีมงานจะตรวจสอบและยืนยันการชำระเงินภายใน 24 ชั่วโมงค่ะ`;
    else replyText =
      `⚠️ ยอดเงินไม่ตรงค่ะ\n\n🏠 ห้อง: ${roomList}\nยอดในสลิป: ${slipAmount?.toLocaleString("th-TH",{minimumFractionDigits:2})??"ไม่พบ"} บาท\nยอดที่ต้องชำระ: ${totalAmount.toLocaleString("th-TH",{minimumFractionDigits:2})} บาท\n\nกรุณาติดต่อเจ้าหน้าที่ค่ะ`;
    await linePush(userId, [{type:"text",text:replyText}]);
    console.log(`[Slip] ห้อง ${roomList} - ${payment.status} - ${slipAmount} บาท`);
  } catch(e) {
    console.error("[Slip Error]", e.message);
    await linePush(userId, [{type:"text",text:"เกิดข้อผิดพลาด กรุณาลองใหม่หรือติดต่อเจ้าหน้าที่ค่ะ"}]);
  }
}

// ── POSTBACK HANDLER (Rich Menu) ──────────────────────────────
async function handlePostback(event) {
  const {userId} = event.source;
  const data     = event.postbackEvent?.data || event.postback?.data || "";
  const users    = await loadUsers();
  const rooms    = await loadRooms();
  const user     = users[userId];
  const room     = user?.roomNumber ? rooms[user.roomNumber] : null;

  // ── ตรวจสอบค่าเช่า ──────────────────────────────────────────
  if (data === "action=CHECK_RENT") {
    // หาทุกห้องที่ใช้ userId เดียวกัน
    const myRooms = Object.values(rooms).filter(r => r.lineUserId === userId);

    if (!myRooms.length) {
      await lineReply(event.replyToken, [{type:"text", text:"กรุณาลงทะเบียนห้องก่อนนะคะ\nพิมพ์ \"ลงทะเบียน\" เพื่อเริ่มต้นค่ะ"}]);
      return;
    }

    const messages = [];

    if (myRooms.length === 1) {
      const r = myRooms[0];
      const amount = Number(r.amount).toLocaleString("th-TH", {minimumFractionDigits:2});
      messages.push({type:"text", text:`📋 ข้อมูลค่าเช่าห้อง ${r.roomNumber} ค่ะ\n\nยอดค่าเช่าเดือนนี้: ${amount} บาท\nกำหนดชำระ: วันที่ 7 ของทุกเดือน\n\nกดลิงค์ด้านล่างเพื่อดูรายละเอียดใบแจ้งหนี้ค่ะ 👇`});
      messages.push({type:"template", altText:"ดูใบแจ้งหนี้", template:{
        type:"buttons", text:`ใบแจ้งหนี้ห้อง ${r.roomNumber}`,
        actions:[{type:"uri", label:"ดูใบแจ้งหนี้", uri: r.invoiceLink}]
      }});
    } else {
      // หลายห้อง — แสดงสรุปและลิงค์ทุกห้อง
      const summary = myRooms.map(r => {
        const amount = Number(r.amount).toLocaleString("th-TH", {minimumFractionDigits:2});
        return `🏠 ห้อง ${r.roomNumber}: ${amount} บาท`;
      }).join("\n");
      const total = myRooms.reduce((s,r) => s + Number(r.amount), 0).toLocaleString("th-TH", {minimumFractionDigits:2});
      messages.push({type:"text", text:`📋 ข้อมูลค่าเช่าทุกห้องของคุณค่ะ\n\n${summary}\n\nรวมทั้งหมด: ${total} บาท\nกำหนดชำระ: วันที่ 7 ของทุกเดือน`});

      // ส่งลิงค์ใบแจ้งหนี้แต่ละห้อง
      const bubbles = myRooms.map(r => ({
        type: "bubble", size: "kilo",
        header: {
          type:"box", layout:"vertical", backgroundColor:"#0d9488",
          contents:[{type:"text", text:`ห้อง ${r.roomNumber}`, color:"#ffffff", weight:"bold", size:"md"}]
        },
        body: {
          type:"box", layout:"vertical", spacing:"sm",
          contents:[
            {type:"text", text:`ยอด: ${Number(r.amount).toLocaleString("th-TH",{minimumFractionDigits:2})} บาท`, size:"sm", color:"#333333"},
          ]
        },
        footer: {
          type:"box", layout:"vertical",
          contents:[{type:"button", style:"primary", color:"#0d9488",
            action:{type:"uri", label:"ดูใบแจ้งหนี้", uri: r.invoiceLink}
          }]
        }
      }));
      messages.push({type:"flex", altText:"ใบแจ้งหนี้ทุกห้อง", contents:{type:"carousel", contents:bubbles}});
    }

    await lineReply(event.replyToken, messages);
    return;
  }

  // ── ส่งหลักฐานการชำระเงิน ────────────────────────────────────
  if (data === "action=SEND_SLIP") {
    const myRooms = Object.values(rooms).filter(r => r.lineUserId === userId);
    if (!myRooms.length) {
      await lineReply(event.replyToken, [{type:"text", text:"กรุณาลงทะเบียนห้องก่อนนะคะ"}]);
      return;
    }
    users[userId].state = "WAIT_SLIP";
    await saveUsers(users);
    const total = myRooms.reduce((s,r) => s + Number(r.amount), 0);
    const totalStr = total.toLocaleString("th-TH", {minimumFractionDigits:2});
    await lineReply(event.replyToken, [{type:"text",
      text:`💳 ส่งหลักฐานการชำระเงินค่ะ\n\n` +
      `ยอดรวมที่ต้องชำระ: ${totalStr} บาท\n` +
      `กำหนดชำระ: วันที่ 7 ของทุกเดือน\n\n` +
      `กรุณาถ่ายรูปหรืออัปโหลดสลิปการโอนเงินได้เลยค่ะ 👇`
    }]);
    return;
  }

  // ── ขอเอกสาร ─────────────────────────────────────────────────
  if (data === "action=REQUEST_DOC") {
    if (!room) {
      await lineReply(event.replyToken, [{type:"text", text:"กรุณาลงทะเบียนห้องก่อนนะคะ"}]);
      return;
    }
    users[userId].state = "WAIT_DOC_REQUEST";
    await saveUsers(users);
    await lineReply(event.replyToken, [{type:"text",
      text:`📄 ขอเอกสารค่ะ\n\nกรุณาพิมพ์เอกสารที่ต้องการ เช่น\n- หนังสือรับรองการพักอาศัย\n- ใบเสร็จย้อนหลัง\n- สัญญาเช่า\n\nพิมพ์รายละเอียดได้เลยค่ะ 👇`
    }]);
    return;
  }

  // ── ติดต่อเจ้าหน้าที่ ─────────────────────────────────────────
  if (data === "action=CONTACT") {
    users[userId].state = "WAIT_CONTACT_MSG";
    await saveUsers(users);
    await lineReply(event.replyToken, [{type:"text",
      text:`📞 ติดต่อเจ้าหน้าที่ค่ะ\n\nกรุณาพิมพ์เรื่องที่ต้องการสอบถามหรือแจ้งปัญหาได้เลยค่ะ\nเจ้าหน้าที่จะตอบกลับโดยเร็วที่สุดค่ะ 😊`
    }]);
    return;
  }
}

app.post("/webhook", async (req, res) => {
  const sig = req.headers["x-line-signature"];
  if (!verifySignature(req.rawBody, sig)) return res.status(401).send("Invalid signature");
  res.status(200).send("OK");
  const {events=[]} = req.body;
  for (const event of events) {
    try {
      if      (event.type==="follow")   await handleFollow(event);
      else if (event.type==="unfollow") await handleUnfollow(event);
      else if (event.type==="postback") await handlePostback(event);
      // รับเฉพาะข้อความจากแชทส่วนตัว (1:1) เท่านั้น ไม่รับจากกลุ่มหรือห้อง
      else if (event.source?.type==="user" && event.type==="message"&&event.message.type==="text")  await handleMessage(event);
      else if (event.source?.type==="user" && event.type==="message"&&event.message.type==="image") await handleImageMessage(event);
    } catch(err) { console.error("[Event Error]", err.message); }
  }
});

// ── Bill History helpers ──────────────────────────────────────
async function loadBillHistory() {
  const h = await redisGet("bill_history");
  return h || [];
}
async function saveBillHistory(h) {
  await redisSet("bill_history", h);
}

app.get("/api/rooms", adminAuth, async(req,res)=>{ const r=await loadRooms(); res.json(r); });

// POST /api/upload-invoice → อัปโหลด Excel แล้วอัปเดตข้อมูลห้องทันที
app.post("/api/upload-invoice", adminAuth, upload.single("file"), async(req, res) => {
  if (!req.file) return res.status(400).json({ error: "ไม่พบไฟล์ที่อัปโหลด" });

  try {
    // Parse Excel
    const wb   = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    if (!rows.length) return res.status(400).json({ error: "ไม่พบข้อมูลในไฟล์" });

    // ตรวจหา column ที่ต้องการ
    const firstRow = rows[0];
    const hasRequired = ["ห้อง", "ลูกค้า", "ยอดรวม", "ลิงก์สาธารณะ"].every(k => k in firstRow);
    if (!hasRequired) return res.status(400).json({ error: "ไม่พบคอลัมน์ที่จำเป็น (ห้อง, ลูกค้า, ยอดรวม, ลิงก์สาธารณะ)" });

    // โหลดข้อมูลห้องเก่า + archive ก่อน
    const oldRooms = await loadRooms();
    const now = new Date();
    const monthLabel = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
    const history = await loadBillHistory();

    if (!history.find(h => h.month === monthLabel)) {
      history.unshift({
        month: monthLabel,
        archivedAt: now.toISOString(),
        rooms: Object.values(oldRooms).map(r => ({
          roomNumber: r.roomNumber, tenantName: r.tenantName,
          amount: r.amount, invoiceLink: r.invoiceLink, lineUserId: r.lineUserId,
        }))
      });
      if (history.length > 24) history.pop();
      await saveBillHistory(history);
    }

    // สร้างข้อมูลห้องใหม่จาก Excel
    const newRooms = {};
    const skipped  = [];

    // กรองเฉพาะแถวที่มีลิงค์ใบแจ้งหนี้ (aprty.co/i/)
    const invoiceRows = rows.filter(r => r["ลิงก์สาธารณะ"]?.includes("aprty.co/i/"));

    // ถ้ามีหลายแถวต่อห้อง ใช้แถวล่าสุด (ยอดสุดท้าย)
    invoiceRows.forEach(row => {
      const roomNum   = String(row["ห้อง"]).padStart(3, "0").replace(/^0+(\d{3,})$/, "$1");
      const tenantName = String(row["ลูกค้า"] || "").trim();
      const amount    = Number(row["ยอดรวม"]) || 0;
      const link      = String(row["ลิงก์สาธารณะ"]).trim();

      if (!roomNum || roomNum === "undefined") { skipped.push(row); return; }

      newRooms[roomNum] = {
        roomNumber:  roomNum,
        tenantName,
        amount,
        invoiceLink: link,
        lineUserId:  oldRooms[roomNum]?.lineUserId || "", // คง lineUserId เดิม
      };
    });

    if (!Object.keys(newRooms).length) {
      return res.status(400).json({ error: "ไม่พบข้อมูลห้องที่ถูกต้องในไฟล์ (ต้องมีลิงค์ aprty.co/i/)" });
    }

    await saveRooms(newRooms);

    res.json({
      ok: true,
      total: Object.keys(newRooms).length,
      archived: monthLabel,
      skipped:  skipped.length,
    });

  } catch(e) {
    console.error("[Upload Error]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bill-history → ดูประวัติบิลทุกเดือน
app.get("/api/bill-history", adminAuth, async(req,res) => {
  const history = await loadBillHistory();
  res.json(history);
});

// DELETE /api/rooms/reset → archive เดือนเก่า แล้ว reset ด้วยข้อมูลใหม่
app.delete("/api/rooms/reset", adminAuth, async(req,res) => {
  const oldRooms   = await loadRooms();
  const freshRooms = buildDefaultRooms();

  // ── Archive เดือนเก่าลง bill_history ─────────────────────
  const now = new Date();
  const monthLabel = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const history = await loadBillHistory();

  // ตรวจว่าเดือนนี้ archive ไปแล้วหรือยัง
  if (!history.find(h => h.month === monthLabel)) {
    history.unshift({
      month: monthLabel,
      archivedAt: now.toISOString(),
      rooms: Object.values(oldRooms).map(r => ({
        roomNumber: r.roomNumber,
        tenantName: r.tenantName,
        amount:     r.amount,
        invoiceLink: r.invoiceLink,
        lineUserId:  r.lineUserId,
      }))
    });
    if (history.length > 24) history.pop(); // เก็บสูงสุด 24 เดือน
    await saveBillHistory(history);
  }

  // คง lineUserId เดิมไว้
  Object.keys(freshRooms).forEach(num => {
    if (oldRooms[num]?.lineUserId) freshRooms[num].lineUserId = oldRooms[num].lineUserId;
  });
  await saveRooms(freshRooms);
  res.json({ ok: true, total: Object.keys(freshRooms).length, archived: monthLabel });
});

app.get("/api/rooms.csv", adminAuth, async(req,res)=>{
  const rooms=await loadRooms();
  const rows=["roomNumber,tenantName,lineUserId,amount,invoiceLink",...Object.values(rooms).map(r=>`${r.roomNumber},"${r.tenantName}",${r.lineUserId},${r.amount},${r.invoiceLink}`)];
  res.setHeader("Content-Type","text/csv;charset=utf-8"); res.setHeader("Content-Disposition",'attachment;filename="rooms.csv"'); res.send(rows.join("\n"));
});
app.get("/api/users", adminAuth, async(req,res)=>{ const u=await loadUsers(); res.json(u); });
app.patch("/api/rooms/:roomNumber", adminAuth, async(req,res)=>{
  const rooms=await loadRooms();
  if (!rooms[req.params.roomNumber]) return res.status(404).json({error:"Room not found"});
  ["tenantName","lineUserId","amount","invoiceLink"].forEach(k=>{if(req.body[k]!==undefined)rooms[req.params.roomNumber][k]=req.body[k];});
  await saveRooms(rooms); res.json(rooms[req.params.roomNumber]);
});
app.delete("/api/rooms/:roomNumber/userId", adminAuth, async(req,res)=>{
  const rooms=await loadRooms();
  if (!rooms[req.params.roomNumber]) return res.status(404).json({error:"Room not found"});
  const oldId=rooms[req.params.roomNumber].lineUserId; rooms[req.params.roomNumber].lineUserId=""; await saveRooms(rooms);
  if (oldId){const users=await loadUsers();if(users[oldId]){users[oldId].state="WAIT_FLOOR";users[oldId].roomNumber=null;await saveUsers(users);}}
  res.json({ok:true});
});
app.post("/api/send-rent-one/:roomNumber", adminAuth, async(req,res)=>{
  const rooms=await loadRooms(); const room=rooms[req.params.roomNumber];
  if (!room) return res.json({ok:false,error:"ไม่พบห้อง"});
  if (!room.lineUserId) return res.json({ok:false,error:"ไม่มี LINE ID"});
  const amount=Number(room.amount).toLocaleString("th-TH",{minimumFractionDigits:2});
  const msg=`คุณมีค่าเช่าห้อง ${room.roomNumber} เดือนนี้จำนวน ${amount} บาท ชำระภายในวันที่ 7 โอนผ่านบัญชีธนาคารไทยพาณิชย์ 353-2-05292-9 หรือ ธนาคารกสิกรไทย 799-2-39682-9 ชื่อบัญชี ณัฐวุฒิ จงจิตตาภิบาล ดูรายละเอียดกดลิงค์นี้ ${room.invoiceLink}`;
  try{await linePush(room.lineUserId,[{type:"text",text:msg}]);res.json({ok:true});}
  catch(e){res.json({ok:false,error:e.message});}
});
app.post("/api/send-msg-one", adminAuth, async(req,res)=>{
  const {roomNumber,message}=req.body; const rooms=await loadRooms(); const room=rooms[roomNumber];
  if (!room) return res.json({ok:false,error:"ไม่พบห้อง"});
  if (!room.lineUserId) return res.json({ok:false,error:"ไม่มี LINE ID"});
  try{await linePush(room.lineUserId,[{type:"text",text:message}]);res.json({ok:true});}
  catch(e){res.json({ok:false,error:e.message});}
});
app.post("/api/send-rent", adminAuth, async(req,res)=>{
  const rooms = await loadRooms();
  const allRooms = Object.values(rooms).filter(r => r.lineUserId);

  // จัดกลุ่มห้องตาม lineUserId
  const grouped = {};
  allRooms.forEach(room => {
    if (!grouped[room.lineUserId]) grouped[room.lineUserId] = [];
    grouped[room.lineUserId].push(room);
  });

  const DUE_DAY = 7;
  const BANK_SCB = "353-2-05292-9";
  const BANK_KBANK = "799-2-39682-9";
  const ACCOUNT = "ณัฐวุฒิ จงจิตตาภิบาล";

  let ok=0, fail=0; const errors=[];

  for (const [userId, userRooms] of Object.entries(grouped)) {
    let messages;
    if (userRooms.length === 1) {
      // 1 ห้อง — ข้อความเดิม
      const r = userRooms[0];
      const amount = Number(r.amount).toLocaleString("th-TH", {minimumFractionDigits:2});
      const msg = `คุณมีค่าเช่าห้อง ${r.roomNumber} เดือนนี้จำนวน ${amount} บาท ชำระภายในวันที่ ${DUE_DAY} โอนผ่านบัญชีธนาคารไทยพาณิชย์ ${BANK_SCB} หรือ ธนาคารกสิกรไทย ${BANK_KBANK} ชื่อบัญชี ${ACCOUNT} ดูรายละเอียดกดลิงค์นี้ ${r.invoiceLink}`;
      messages = [{type:"text", text:msg}];
    } else {
      // หลายห้อง — สรุปยอดรวม + ลิงค์แต่ละห้อง
      const total = userRooms.reduce((s,r) => s + Number(r.amount), 0);
      const summary = userRooms.map(r =>
        `🏠 ห้อง ${r.roomNumber}: ${Number(r.amount).toLocaleString("th-TH",{minimumFractionDigits:2})} บาท`
      ).join("\n");
      const textMsg = `คุณมีค่าเช่าเดือนนี้ดังนี้ค่ะ\n\n${summary}\n\nรวมทั้งหมด: ${total.toLocaleString("th-TH",{minimumFractionDigits:2})} บาท\nชำระภายในวันที่ ${DUE_DAY} โอนผ่านบัญชีธนาคารไทยพาณิชย์ ${BANK_SCB} หรือ ธนาคารกสิกรไทย ${BANK_KBANK} ชื่อบัญชี ${ACCOUNT}`;
      const bubbles = userRooms.map(r => ({
        type:"bubble", size:"kilo",
        header:{type:"box",layout:"vertical",backgroundColor:"#0d9488",contents:[{type:"text",text:`ห้อง ${r.roomNumber}`,color:"#ffffff",weight:"bold",size:"md"}]},
        body:{type:"box",layout:"vertical",spacing:"sm",contents:[{type:"text",text:`ยอด: ${Number(r.amount).toLocaleString("th-TH",{minimumFractionDigits:2})} บาท`,size:"sm",color:"#333333"}]},
        footer:{type:"box",layout:"vertical",contents:[{type:"button",style:"primary",color:"#0d9488",action:{type:"uri",label:"ดูใบแจ้งหนี้",uri:r.invoiceLink}}]}
      }));
      messages = [
        {type:"text", text:textMsg},
        {type:"flex", altText:"ใบแจ้งหนี้ทุกห้อง", contents:{type:"carousel",contents:bubbles}}
      ];
    }

    try {
      await linePush(userId, messages);
      ok += userRooms.length;
    } catch(e) {
      fail += userRooms.length;
      userRooms.forEach(r => errors.push({room:r.roomNumber, error:e.message}));
    }
    await new Promise(r => setTimeout(r, 250));
  }

  const skipped = Object.values(rooms).filter(r => !r.lineUserId).length;
  const logs = loadJSON(LOG_FILE,[]); logs.unshift({date:new Date().toISOString(),ok,fail,skipped,errors}); saveJSON(LOG_FILE,logs.slice(0,60));
  res.json({ok, fail, skipped, total:allRooms.length});
});
app.post("/api/broadcast", adminAuth, async(req,res)=>{
  const {message}=req.body; if (!message) return res.status(400).json({error:"message required"});
  const allR=await loadRooms();const targets=Object.values(allR).filter(r=>r.lineUserId);
  let ok=0,fail=0;
  for (const room of targets){try{await linePush(room.lineUserId,[{type:"text",text:message}]);ok++;}catch{fail++;}await new Promise(r=>setTimeout(r,250));}
  res.json({ok,fail,total:targets.length});
});
app.get("/api/payments", adminAuth, async(req,res)=>{ const p=await loadPayments(); res.json(p); });

// GET /api/slip-image/:id → แสดงรูปสลิป (เก็บ 60 วัน)
app.get("/api/slip-image/:id", adminAuth, async(req,res)=>{
  try {
    let base64 = null;

    // 1. หาจาก slip_img: key (วิธีใหม่)
    const r = await fetch(`${REDIS_URL}/get/slip_img:${req.params.id}`, {
      headers:{Authorization:`Bearer ${REDIS_TOKEN}`}
    });
    const data = await r.json();
    if(data.result) base64 = data.result;

    // 2. fallback → หาจาก payment record เดิม (วิธีเก่า)
    if(!base64) {
      const payments = await loadPayments();
      const p = payments.find(p => p.id === req.params.id);
      if(p?.imageBase64) base64 = p.imageBase64;
    }

    if(!base64) return res.status(404).send("ไม่พบรูปภาพ");
    const buffer = Buffer.from(base64, "base64");
    res.setHeader("Content-Type","image/jpeg");
    res.setHeader("Cache-Control","public,max-age=86400");
    res.send(buffer);
  } catch(e){ res.status(500).send(e.message); }
});
app.patch("/api/payments/:id", adminAuth, async(req,res)=>{
  const {status,note}=req.body; const payments=await loadPayments();
  const idx=payments.findIndex(p=>p.id===req.params.id);
  if (idx===-1) return res.status(404).json({error:"ไม่พบรายการ"});
  payments[idx].status=status; payments[idx].note=note||""; payments[idx].updatedAt=new Date().toISOString();
  await savePayments(payments);
  const p=payments[idx];
  if (p.userId&&CHANNEL_TOKEN){
    const msg=status==="confirmed"?`✅ ยืนยันการชำระเงินแล้วค่ะ\nห้อง ${p.roomNumber} ขอบคุณค่ะ`:`❌ สลิปถูกปฏิเสธค่ะ\n${note?`เหตุผล: ${note}\n`:""}กรุณาติดต่อเจ้าหน้าที่ค่ะ`;
    linePush(p.userId,[{type:"text",text:msg}]).catch(()=>{});
  }
  res.json(payments[idx]);
});
app.post("/api/collect-followers", adminAuth, async(req,res)=>{
  const customMsg=req.body?.message;
  const rooms=await loadRooms();
  const REGISTER_MSG=customMsg||`สวัสดีค่ะ 👋\n\nทางอพาร์ทเมนท์ได้เปิดระบบแจ้งค่าเช่าผ่าน LINE แล้ว\nกรุณาเลือกชั้นและห้องของคุณด้านล่างเพื่อลงทะเบียนค่ะ`;
  async function fetchAll(){
    const ids=[];let start;
    while(true){
      const url=new URL("https://api.line.me/v2/bot/followers/ids");
      if(start)url.searchParams.set("start",start); url.searchParams.set("limit","1000");
      const r=await fetch(url.toString(),{headers:{"Authorization":`Bearer ${CHANNEL_TOKEN}`}});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const d=await r.json(); ids.push(...(d.userIds||[]));
      if(!d.next)break; start=d.next; await new Promise(r=>setTimeout(r,200));
    }
    return ids;
  }
  try{
    const allIds=await fetchAll(); const users=await loadUsers();
    const regIds=new Set(Object.values(rooms).map(r=>r.lineUserId).filter(Boolean));
    const need=allIds.filter(id=>!regIds.has(id));
    let sent=0,fail=0;
    for(const userId of need){
      if(!users[userId]){
        let displayName="-";
        try{const p=await fetch(`https://api.line.me/v2/bot/profile/${userId}`,{headers:{"Authorization":`Bearer ${CHANNEL_TOKEN}`}});if(p.ok)({displayName}=await p.json());}catch{}
        users[userId]={userId,displayName,state:"WAIT_FLOOR",roomNumber:null,pendingRoom:null,registeredAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      }else{users[userId].state="WAIT_FLOOR";users[userId].pendingRoom=null;users[userId].updatedAt=new Date().toISOString();}
      try{await linePush(userId,[{type:"text",text:REGISTER_MSG},floorButtons(rooms)]);sent++;}catch{fail++;}
      await new Promise(r=>setTimeout(r,250));
    }
    await saveUsers(users);
    res.json({total:allIds.length,already:allIds.length-need.length,needsRegistration:need.length,sent,failed:fail});
  }catch(e){res.status(500).json({error:e.message});}
});
// POST /api/set-richmenu-all → ตั้ง Rich Menu ให้ทุกห้องที่ลงทะเบียนแล้ว
app.post("/api/set-richmenu-all", adminAuth, async (req, res) => {
  const idFile = path.join(__dirname, "rich-menu-id.txt");
  if (!fs.existsSync(idFile)) return res.status(400).json({ error: "ไม่พบ rich-menu-id.txt — รัน create-rich-menu.js ก่อนครับ" });
  const richMenuId = fs.readFileSync(idFile, "utf8").trim();
  const rooms = await loadRooms();
  const targets = Object.values(rooms).filter(r => r.lineUserId);
  let ok = 0, fail = 0;
  for (const room of targets) {
    try {
      await fetch(`https://api.line.me/v2/bot/user/${room.lineUserId}/richmenu/${richMenuId}`, {
        method: "POST", headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` },
      });
      ok++;
    } catch { fail++; }
    await new Promise(r => setTimeout(r, 100));
  }
  res.json({ ok, fail, total: targets.length, richMenuId });
});

app.get("/api/doc-requests", adminAuth, (req,res) => {
  res.json(loadJSON(path.join(__dirname,"data","doc-requests.json"), []));
});
app.get("/api/contact-logs", adminAuth, (req,res) => {
  res.json(loadJSON(path.join(__dirname,"data","contact-logs.json"), []));
});
app.get("/api/moveout-requests", adminAuth, (req,res) => {
  res.json(loadJSON(path.join(__dirname,"data","moveout-requests.json"), []));
});
app.patch("/api/moveout-requests/:idx", adminAuth, async(req,res) => {
  const idx = parseInt(req.params.idx);
  const { status } = req.body;
  const logs = loadJSON(path.join(__dirname,"data","moveout-requests.json"), []);
  if (!logs[idx]) return res.status(404).json({error:"Not found"});
  logs[idx].status = status;
  logs[idx].updatedAt = new Date().toISOString();
  saveJSON(path.join(__dirname,"data","moveout-requests.json"), logs);

  // ถ้า confirm → ล้าง lineUserId ออกจากห้อง
  if (status === "confirmed") {
    const roomNum = logs[idx].roomNumber;
    const rooms = await loadRooms();
    if (rooms[roomNum]) {
      const oldUserId = rooms[roomNum].lineUserId;
      rooms[roomNum].lineUserId = "";
      await saveRooms(rooms);
      // แจ้งผู้เช่าทาง LINE
      if (oldUserId) {
        try {
          await linePush(oldUserId, [{type:"text",
            text:`✅ รับทราบการแจ้งย้ายออกห้อง ${roomNum} แล้วค่ะ\n\nเจ้าหน้าที่จะติดต่อเพื่อนัดตรวจสอบห้องและดำเนินการต่อไปค่ะ\n\nขอบคุณที่ใช้บริการนะคะ 😊`
          }]);
        } catch {}
      }
    }
  }
  res.json({ ok: true });
});
app.get("/api/stats", adminAuth, async(req,res)=>{
  const rooms=Object.values(await loadRooms()); const users=await loadUsers();
  res.json({totalRooms:rooms.length,registeredRooms:rooms.filter(r=>r.lineUserId).length,totalFollowers:Object.keys(users).length,activeUsers:Object.values(users).filter(u=>u.state==="REGISTERED").length});
});
app.get("/health",(req,res)=>res.json({ok:true,ts:new Date().toISOString()}));

// POST /api/test-reminder → ทดสอบส่งเตือนค่าเช่า (admin only)
app.post("/api/test-reminder", adminAuth, async(req,res)=>{
  const day        = Number(req.body.day) || new Date().getDate();
  const roomNumber = req.body.roomNumber || null;
  try { await runRentReminder(day, roomNumber, true); res.json({ok:true, day, roomNumber}); }
  catch(e) { res.json({ok:false, error:e.message}); }
});

ensureDir(DATA_DIR);
if(!fs.existsSync(ROOMS_FILE))saveJSON(ROOMS_FILE,buildDefaultRooms());
if(!fs.existsSync(USERS_FILE))saveJSON(USERS_FILE,{});

app.listen(PORT,()=>{
  console.log(`\n🚀  LINE Webhook Server พร้อมทำงาน`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Webhook: http://localhost:${PORT}/webhook`);
  console.log(`   Admin:   http://localhost:${PORT}/api/stats?token=${ADMIN_TOKEN}\n`);

  // ── Self-ping ทุก 14 นาที ป้องกัน Render sleep ──────────────
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/health`);
      console.log(`[Keep-alive] ping ${new Date().toLocaleTimeString("th-TH")} ✓`);
    } catch(e) {
      console.warn(`[Keep-alive] ping failed: ${e.message}`);
    }
  }, 14 * 60 * 1000); // 14 นาที

  // ── ลบ payment ที่ยืนยันแล้ว และเก่ากว่า 30 วัน ทุกวัน ──────
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const payments = await loadPayments();
      const now = Date.now();
      const before = payments.length;
      const cleaned = payments.filter(p => {
        if (p.status !== "confirmed") return true; // เก็บไว้ถ้ายังไม่ยืนยัน
        return (now - new Date(p.receivedAt).getTime()) < THIRTY_DAYS; // ลบถ้าเกิน 30 วัน
      });
      if (cleaned.length < before) {
        await savePayments(cleaned);
        console.log(`[Cleanup] ลบ payment เก่า ${before - cleaned.length} รายการ`);
      }
    } catch(e) { console.error("[Cleanup Error]", e.message); }
  }, 24 * 60 * 60 * 1000); // ทุก 24 ชั่วโมง

  // รันทุกวันเวลา 09:00 น. (เช็คทุก 1 ชั่วโมง)
  setInterval(async () => {
    if (new Date().getHours() === 9) await runRentReminder();
  }, 60 * 60 * 1000);

  // รันทันทีถ้าเป็นเวลา 9 โมงพอดี
  if (new Date().getHours() === 9) runRentReminder();
});

// ── แจ้งเตือนค่าเช่า (วันที่ 5 และวันที่ 8+) ─────────────────
async function runRentReminder(forceDay, onlyRoom=null, isTest=false) {
    const now   = new Date();
    const day   = forceDay || now.getDate();
    const month = now.getMonth() + 1;
    const year  = now.getFullYear();

    if (!isTest && !onlyRoom && day !== 5 && (day < 8 || day > 15)) return;

    try {
      const rooms    = await loadRooms();
      const payments = await loadPayments();

      const paidRooms = new Set(
        isTest ? [] : // ทดสอบ = ไม่กรองห้องที่จ่ายแล้ว
        payments
          .filter(p => {
            if (p.status !== "confirmed") return false;
            const d = new Date(p.receivedAt);
            return d.getMonth() + 1 === month && d.getFullYear() === year;
          })
          .flatMap(p => p.roomNumber.split(",").map(r => r.trim()))
      );

      const unpaidRooms = Object.values(rooms).filter(r =>
        r.lineUserId && !paidRooms.has(r.roomNumber) &&
        (!onlyRoom || r.roomNumber === onlyRoom)
      );

      if (!unpaidRooms.length) {
        console.log(`[Reminder] วันที่ ${day} — ทุกห้องชำระแล้ว ✓`);
        return { sent: 0 };
      }

      for (const room of unpaidRooms) {
        const amount = Number(room.amount).toLocaleString("th-TH", {minimumFractionDigits:2});
        let msg = "";

        if (day === 5) {
          msg = `⚠️ แจ้งเตือนค่าเช่าห้อง ${room.roomNumber} ค่ะ\n\n` +
            `ยอดค่าเช่าเดือนนี้: ${amount} บาท\n` +
            `กำหนดชำระ: วันที่ 7 ของเดือนนี้\n\n` +
            `⏰ กรุณาชำระภายในวันที่ 7 ค่ะ\n` +
            `หากเกินกำหนดจะมีค่าปรับ 100 บาท/วัน\n\n` +
            `โอนผ่านบัญชีธนาคาร:\n` +
            `• SCB 353-2-05292-9\n` +
            `• KBank 799-2-39682-9\n` +
            `ชื่อบัญชี: ณัฐวุฒิ จงจิตตาภิบาล\n\n` +
            `ชำระแล้วกรุณาส่งสลิปในแชทนี้ด้วยนะคะ 🙏`;
        } else if (day >= 8 && day <= 15) {
          const overdueDays = day - 7;
          const fine        = overdueDays * 100;
          const total       = Number(room.amount) + fine;
          const totalStr    = total.toLocaleString("th-TH", {minimumFractionDigits:2});
          const fineStr     = fine.toLocaleString("th-TH");

          if (day === 15) {
            msg = `🚨 แจ้งเตือนขั้นสุดท้าย ห้อง ${room.roomNumber} ค่ะ\n\n` +
              `ค่าเช่า: ${amount} บาท\n` +
              `ค่าปรับ (${overdueDays} วัน × 100): ${fineStr} บาท\n` +
              `──────────────────\n` +
              `ยอดรวมที่ต้องชำระ: ${totalStr} บาท\n\n` +
              `⚠️ กรุณาชำระค่าเช่าพร้อมค่าปรับภายในวันนี้ค่ะ\n\n` +
              `หากไม่ชำระภายในวันที่ 15 สัญญาเช่าจะถูกยกเลิก\n` +
              `และต้องคืนห้องทันที ทั้งนี้เป็นไปตามสัญญาเช่าค่ะ\n\n` +
              `โอนผ่านบัญชีธนาคาร:\n` +
              `• SCB 353-2-05292-9\n` +
              `• KBank 799-2-39682-9\n` +
              `ชื่อบัญชี: ณัฐวุฒิ จงจิตตาภิบาล\n\n` +
              `ชำระแล้วกรุณาส่งสลิปในแชทนี้ด้วยนะคะ 🙏`;
          } else {
            msg = `🔴 แจ้งเตือนค่าเช่าเกินกำหนด ห้อง ${room.roomNumber} ค่ะ\n\n` +
              `ค่าเช่า: ${amount} บาท\n` +
              `ค่าปรับ (${overdueDays} วัน × 100): ${fineStr} บาท\n` +
              `──────────────────\n` +
              `ยอดรวมที่ต้องชำระ: ${totalStr} บาท\n\n` +
              `กรุณาชำระโดยด่วนค่ะ โอนผ่านบัญชีธนาคาร:\n` +
              `• SCB 353-2-05292-9\n` +
              `• KBank 799-2-39682-9\n` +
              `ชื่อบัญชี: ณัฐวุฒิ จงจิตตาภิบาล\n\n` +
              `ชำระแล้วกรุณาส่งสลิปในแชทนี้ด้วยนะคะ 🙏`;
          }
        }

        if (msg) {
          try {
            await linePush(room.lineUserId, [{type:"text", text:msg}]);
            console.log(`[Reminder] ส่งเตือนห้อง ${room.roomNumber} (วันที่ ${day})`);
          } catch(e) {
            console.error(`[Reminder] ส่งไม่สำเร็จห้อง ${room.roomNumber}:`, e.message);
          }
          await new Promise(r => setTimeout(r, 500));
        }
      }
      console.log(`[Reminder] วันที่ ${day} — ส่งเตือน ${unpaidRooms.length} ห้อง`);
      return { sent: unpaidRooms.length };
    } catch(e) { console.error("[Reminder Error]", e.message); throw e; }
}
