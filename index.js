// =========================================================
// BIZ Bot - Node.js version for Railway
// v3: เช็กสลิป Thunder + Google Cloud Vision OCR
// =========================================================
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");
const FormData = require("form-data");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const THUNDER_API_KEY = process.env.THUNDER_API_KEY;
const VISION_API_KEY = process.env.VISION_API_KEY;
const THUNDER_URL = "https://api.thunder.in.th/v2/verify/bank";
const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const money = (n) => Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2 });
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const shortBank = (b) => b ? `ธ.${b.replace(/ธนาคาร/g, "").trim()}` : "";
const LINE = "━━━━━━━━━━━━━━━━━━━━━━━━━";
const BANGKOK = (d) => {
  const dt = new Date(d);
  const date = dt.toLocaleDateString("th-TH-u-ca-gregory", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" });
  const time = dt.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  return `${date} | ${time} น.`;
};

// ===== OCR ด้วย Gemini 2.5 Flash-Lite =====
async function ocrSlip(imgBuffer) {
  if (!GEMINI_API_KEY) return null;
  try {
    const b64 = imgBuffer.toString("base64");
    const res = await fetch(`${GEMINI_API}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: "image/jpeg", data: b64 } },
          { text: `Thai bank transfer slip image. Find ONLY the transfer amount (จำนวนเงิน).
- It is a number with 2 decimal places like 100.30 or 499.94
- It is NOT an account number (which is long like 004999251595053)
- It is NOT a fee (ค่าธรรมเนียม)
- Look for the big number labeled จำนวนเงิน or near บาท

Also find:
- RECEIVER_NAME: name of receiver (ชื่อผู้รับ)
- ACCOUNT: last 4 digits of receiver account only
- BANK: receiver bank name in Thai

Reply ONLY: AMOUNT|RECEIVER_NAME|ACCOUNT|BANK
Example: 100.30|นาย ไสว ด|null|กสิกร
Use null for missing fields.` }
        ]}],
        generationConfig: { maxOutputTokens: 100, temperature: 0 },
      }),
    });
    const data = await res.json();
    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    console.log("Gemini 2.5 Flash-Lite OCR:", raw);
    return raw;
  } catch (e) {
    console.error("OCR error:", e.message);
    return null;
  }
}

// ===== แยกข้อมูลจาก OCR (format: AMOUNT|NAME|ACCOUNT|BANK) =====
function parseSlipOCR(ocrRaw) {
  if (!ocrRaw) return { amount: null, name: "", acc: "", bank: "" };
  const parts = ocrRaw.split("|");
  const amtStr = (parts[0] || "").replace(/,/g, "").trim();
  const amount = amtStr === "null" || !amtStr ? null : parseFloat(amtStr);
  const name = (parts[1] || "").trim().replace(/^null$/i, "");
  const acc = (parts[2] || "").trim().replace(/\D/g, "").replace(/^null$/i, "");
  const bank = (parts[3] || "").trim().replace(/^null$/i, "");
  return { amount: isNaN(amount) ? null : amount, name, acc, bank };
}

// ===== อ่าน QR code จากรูป =====
async function readQRCode(imgBuffer) {
  try {
    const Jimp = require("jimp");
    const jsQR = require("jsqr");
    const image = await Jimp.read(imgBuffer);
    const { data, width, height } = image.bitmap;
    const code = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
    return code ? code.data : null;
  } catch (e) {
    console.error("QR read error:", e.message);
    return null;
  }
}

// ===== แปลง PromptPay QR EMV =====
function parsePromptPayQR(qrContent) {
  let acc = "", amount = "", accType = "พร้อมเพย์";
  try {
    // parse EMV TLV format
    let i = 0;
    while (i < qrContent.length) {
      const tag = qrContent.substring(i, i + 2);
      const len = parseInt(qrContent.substring(i + 2, i + 4), 10);
      if (isNaN(len)) break;
      const val = qrContent.substring(i + 4, i + 4 + len);

      // tag 54 = transaction amount
      if (tag === "54") {
        amount = val;
      }

      // tag 29 หรือ 30 = PromptPay merchant
      if (tag === "29" || tag === "30") {
        // หาเบอร์/เลขบัญชีใน sub-TLV
        let j = 0;
        while (j < val.length) {
          const stag = val.substring(j, j + 2);
          const slen = parseInt(val.substring(j + 2, j + 4), 10);
          if (isNaN(slen)) break;
          const sval = val.substring(j + 4, j + 4 + slen);
          if (stag === "01") {
            // เบอร์โทร/เลขประชาชน/e-wallet
            if (sval.startsWith("00")) {
              acc = "0" + sval.slice(2);
              accType = "เบอร์โทร/พร้อมเพย์";
            } else if (sval.startsWith("66")) {
              acc = "0" + sval.slice(2);
              accType = "เบอร์โทร/พร้อมเพย์";
            } else {
              acc = sval;
              accType = sval.length === 13 ? "เลขประชาชน" : "พร้อมเพย์";
            }
          }
          j += 4 + slen;
        }
      }
      i += 4 + len;
    }
  } catch (e) { /* ข้าม */ }
  return { acc, amount, accType };
}

// ===== ตรวจสลิป =====
async function checkSlip(msg, captionAmount) {
  const chatId = String(msg.chat.id);
  const msgId = msg.message_id;
  const fromName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || "";
  try {
    const photo = msg.photo;
    const doc = msg.document;
    const fileId = doc ? doc.file_id : photo[photo.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const imgRes = await fetch(fileUrl);
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    const form = new FormData();
    form.append("image", imgBuffer, { filename: "slip.jpg", contentType: "image/jpeg" });

    // ส่ง Thunder และ Vision OCR พร้อมกัน
    const [thunderRes, ocrText] = await Promise.all([
      fetch(THUNDER_URL, { method: "POST", headers: { Authorization: `Bearer ${THUNDER_API_KEY}` }, body: form }).then((r) => r.json()),
      captionAmount === null ? ocrSlip(imgBuffer) : Promise.resolve(null),
    ]);

    const v = thunderRes;
    if (!v.success) {
      const rawMsg = (v.error?.message || "").toLowerCase();
      let text = "";
      if (v.error?.code === "SLIP_NOT_FOUND" || /no qr|not found/.test(rawMsg))
        text = `⚠️ <b>ตรวจสอบไม่ได้</b>\n📷 อ่าน QR ในรูปไม่ได้ กรุณาส่งรูปที่ชัดขึ้น`;
      else if (/too old|expired/.test(rawMsg))
        text = `⚠️ <b>ตรวจสอบย้อนไม่ได้</b>\n📅 สลิปเกินช่วงที่ธนาคารให้ตรวจย้อนได้`;
      else
        text = `⚠️ <b>ตรวจสอบไม่ได้</b>\n${esc(v.error?.message || "ลองใหม่อีกครั้ง")}`;
      await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_to_message_id: msgId });
      return;
    }

    const d = v.data, raw = d.rawSlip || {};
    const amount = raw.amount?.amount ?? d.amountInSlip;
    const sender = raw.sender?.account?.name?.th || raw.sender?.account?.name?.en || "-";
    const receiver = raw.receiver?.account?.name?.th || raw.receiver?.account?.name?.en || "-";
    const sBank = shortBank(raw.sender?.bank?.name || "");
    const rBank = shortBank(raw.receiver?.bank?.name || "");
    const rBankFull = raw.receiver?.bank?.name || "";
    const rcvAcc = raw.receiver?.account?.bank?.account || raw.receiver?.account?.proxy?.account || "";
    const dup = d.isDuplicate;

    const sndInfo = `${esc(sender)}${sBank ? ` (${esc(sBank)})` : ""}`;
    const rcvInfo = `${esc(receiver)}${rBank ? ` (${esc(rBank)}${rcvAcc ? " " + esc(rcvAcc) : ""})` : ""}`;

    const qrBlock =
      `📌 สถานะ: ✅ สลิปจริง\n` +
      `💰 ยอดเงิน: <b>${money(amount)} บาท</b>\n` +
      (raw.date ? `📅 วันที่-เวลา: ${BANGKOK(raw.date)}\n` : "") +
      `👤 ผู้โอน: ${sndInfo}\n` +
      `🏦 ผู้รับ: ${rcvInfo}\n` +
      (raw.transRef ? `🔖 เลขอ้างอิง: <code>${esc(raw.transRef)}</code>` : "");

    // แยกข้อมูลจาก OCR
    const ocr = parseSlipOCR(ocrText);
    const expectAmount = captionAmount ?? ocr.amount;

    // เทียบแต่ละส่วน
    const amtOk = expectAmount === null || Math.abs(expectAmount - amount) <= 0.10;
    const nameOk = !ocr.name || receiver.toLowerCase().includes(ocr.name.toLowerCase()) ||
      ocr.name.toLowerCase().split(" ").some((w) => w.length > 1 && receiver.toLowerCase().includes(w.toLowerCase()));
    const accOk = !ocr.acc || !rcvAcc || rcvAcc.replace(/\D/g, "").slice(-4) === ocr.acc.slice(-4);

    const mismatches = [];
    if (!amtOk && expectAmount !== null) mismatches.push(`💰 ยอดเงิน: รูปแสดง <b>${money(expectAmount)} บาท</b> แต่ QR ระบุ <b>${money(amount)} บาท</b> ❌`);
    if (!nameOk) mismatches.push(`👤 ชื่อผู้รับ: รูปแสดง <b>${esc(ocr.name)}</b> แต่ QR ระบุ <b>${esc(receiver)}</b> ❌`);
    if (!accOk) mismatches.push(`🏦 เลขบัญชี: รูปแสดง <b>...${ocr.acc}</b> แต่ QR ระบุ <b>...${rcvAcc.replace(/\D/g, "").slice(-4)}</b> ❌`);

    const isFake = mismatches.length > 0;

    if (!isFake) {
      const confirmed = [];
      if (expectAmount !== null) confirmed.push(`ยอด ${money(expectAmount)} บาท ✅`);
      if (ocr.name) confirmed.push(`ชื่อ ${ocr.name} ✅`);
      if (ocr.acc) confirmed.push(`...${ocr.acc} ✅`);
      const ocrNote = confirmed.length > 0 ? `\n🤖 <i>AI ยืนยัน: ${confirmed.join(" · ")}</i>` : "";
      const text = `🟢 <b>ส ลิ ป จ ริ ง</b>${dup ? "  ♻️ <i>ซ้ำ</i>" : ""}\n\n` + qrBlock + ocrNote;
      await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_to_message_id: msgId });
    } else {
      const text =
        `🔴 <b>ส ลิ ป ป ล อ ม</b>\n\n` +
        `🟢 <b>ข้อมูลจริงจาก QR</b>\n${LINE}\n` + qrBlock +
        `\n\n${LINE}\n\n` +
        `🔴 <b>ข้อมูลในรูปไม่ตรง</b>\n${LINE}\n` +
        mismatches.join("\n");
      await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_to_message_id: msgId });
    }

    try {
      await db.rpc("slip_log_internal", { p: {
        chat_id: chatId, chat_title: msg.chat.title || null, from_name: fromName,
        ref: raw.transRef || null, ok: !isFake, amount, sender, receiver,
        bank: rBankFull, trans_time: raw.date || null, duplicate: dup, raw: v
      }});
    } catch { /* ข้าม */ }

  } catch (e) {
    console.error("checkSlip error:", e.message);
    await bot.sendMessage(chatId, `⚠️ <b>ตรวจสลิปไม่สำเร็จ</b>\n${esc(e.message)}`, { parse_mode: "HTML", reply_to_message_id: msgId });
  }
}

// ===== อ่าน QR รับเงิน =====
async function readPaymentQR(msg) {
  const chatId = String(msg.chat.id);
  const msgId = msg.message_id;
  try {
    const photo = msg.photo;
    const doc = msg.document;
    const fileId = doc ? doc.file_id : photo[photo.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const imgRes = await fetch(fileUrl);
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    const qrContent = await readQRCode(imgBuffer);
    if (!qrContent || !qrContent.includes("A000000677010111")) {
      await bot.sendMessage(chatId, `⚠️ <b>อ่าน QR ไม่ได้</b>\nกรุณาส่งรูป QR ที่ชัดขึ้นครับ`, { parse_mode: "HTML", reply_to_message_id: msgId });
      return;
    }

    const { acc, amount, accType } = parsePromptPayQR(qrContent);
    const amtNum = parseFloat(amount);
    const text =
      `📋 <b>ข้อมูล QR พร้อมเพย์</b>\n${LINE}\n` +
      (amount ? `💰 ยอดเงิน: <b>${isNaN(amtNum) ? amount : money(amtNum)} บาท</b>\n` : `💰 ยอดเงิน: <b>ไม่ระบุ (โอนได้ทุกจำนวน)</b>\n`) +
      (acc ? `🔢 ${accType}: <code>${acc}</code>\n` : "") +
      `🏦 ระบบ: พร้อมเพย์\n${LINE}\n` +
      `⚠️ <i>QR นี้ใช้รับเงินเท่านั้น ไม่ใช่หลักฐานการโอน</i>`;
    await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_to_message_id: msgId });
  } catch (e) {
    console.error("readPaymentQR error:", e.message);
    await bot.sendMessage(chatId, `⚠️ <b>อ่าน QR ไม่สำเร็จ</b>\n${esc(e.message)}`, { parse_mode: "HTML", reply_to_message_id: msgId });
  }
}

function parseAmounts(caption) {
  const nums = (caption || "").match(/[0-9][0-9,]*\.?[0-9]*/g) || [];
  return nums.map((n) => parseFloat(n.replace(/,/g, ""))).filter((n) => !isNaN(n) && n > 0);
}

bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || msg.caption || "").trim();
  const photo = msg.photo;
  const doc = msg.document;
  const hasImage = photo || (doc && /image\//.test(doc.mime_type || ""));

  if (text === "เปิด" || text === "ปิด") {
    try {
      const member = await bot.getChatMember(chatId, msg.from.id);
      const isAdmin = ["administrator", "creator"].includes(member.status);
      if (!isAdmin) {
        await bot.sendMessage(chatId, "⛔ เฉพาะแอดมินเท่านั้น", { reply_to_message_id: msg.message_id });
        return;
      }
      const enable = text === "เปิด";
      await db.rpc("slip_cfg_save", { p: { enabled: enable } });
      await bot.sendMessage(chatId,
        enable ? `✅ <b>เปิดระบบเช็กสลิปแล้ว</b>` : `🔴 <b>ปิดระบบเช็กสลิปแล้ว</b>`,
        { parse_mode: "HTML", reply_to_message_id: msg.message_id }
      );
    } catch (e) { console.error("open/close error:", e.message); }
    return;
  }

  if (!hasImage) return;

  const { data: cfg } = await db.rpc("slip_cfg_internal");
  if (!cfg || !cfg.enabled) return;

  if (text.toLowerCase() === "qr") {
    await readPaymentQR(msg);
    return;
  }

  const amounts = parseAmounts(text);
  const captionAmount = amounts[0] ?? null;
  await checkSlip(msg, captionAmount);
});

console.log("BIZ Bot v3 started! 🤖");