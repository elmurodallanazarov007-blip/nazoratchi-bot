/**
 * Nazoratchi Bot
 * Kurs ishtirokchilarini nazorat qiluvchi Telegram bot.
 * Kutubxona: node-telegram-bot-api (telegraf EMAS)
 * Baza: MongoDB Atlas (mongodb rasmiy driver)
 *
 * v2 (zamonaviylashtirilgan):
 * - Inline tugmali admin panel (/admin)
 * - Test uchun vaqt chegarasi (timer) va muddat (deadline)
 * - Muddat tugashi oldidan avtomatik eslatma
 * - Umumiy / Haftalik / Oylik reyting
 * - Statistika: eng ko'p xato qilingan savollar
 * - Barcha tugmalar rangli (Bot API 9.4 style: primary/success/danger)
 */

require('dotenv').config();
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

// ---------- MAJBURIY KANALLAR ----------
// Shu yerga xohlagancha kanal qo'shishingiz yoki o'chirishingiz mumkin.
// Bot HAR BIR shu kanalda ADMIN bo'lishi shart, aks holda a'zolikni tekshira olmaydi.
const CHANNELS = [
  { id: '@talimtalaba', link: 'https://t.me/talimtalaba' },
  { id: '@Matematika_milliysertifikatim', link: 'https://t.me/Matematika_milliysertifikatim' },
];

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'nazoratchi';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

if (!BOT_TOKEN) {
  console.error('XATO: .env faylida BOT_TOKEN topilmadi.');
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error('XATO: .env faylida MONGODB_URI topilmadi.');
  process.exit(1);
}

// ---------- DB ----------
const mongoClient = new MongoClient(MONGODB_URI);
let db, Users, Tests, Submissions, Settings;

async function initDb() {
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB_NAME);
  Users = db.collection('users');
  Tests = db.collection('tests');
  Submissions = db.collection('submissions');
  Settings = db.collection('settings');

  await Users.createIndex({ user_id: 1 }, { unique: true });
  await Tests.createIndex({ test_code: 1 }, { unique: true });
  await Submissions.createIndex({ user_id: 1, test_code: 1 }, { unique: true });
  await Submissions.createIndex({ test_code: 1 });
  await Submissions.createIndex({ submitted_at: 1 });
  await Settings.createIndex({ key: 1 }, { unique: true });

  console.log('✅ MongoDB’ga ulanish oʻrnatildi.');
}

async function getSetting(key, fallback) {
  const row = await Settings.findOne({ key });
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  await Settings.updateOne({ key }, { $set: { value } }, { upsert: true });
}

// ---------- CUSTOM EMOJI ----------
// Oddiy Unicode emoji -> Telegram Premium custom_emoji_id xaritasi.
// Matnda shu emojilar uchrasa, avtomatik ravishda "custom_emoji" entity
// sifatida yuboriladi (pastdagi wrapCustomEmoji() orqali).
const CUSTOM_EMOJI_MAP = {
  '✅': '5260463209562776385',
  '❌': '5210952531676504517',
  '⛔': '5260293700088511294',
  '⚠️': '5447644880824181073',
  '🎉': '5461151367559141950',
  '⬅️': '5411112567609243032',
  '➕': '5397916757333654639',
  '➖': '5382261056078881010',
  '🔟': '5429525083817255471',
  '📊': '5231200819986047254',
  '📢': '5321042567926652202',
  '🏆': '5368617177635107810',
  '📅': '5413879192267805083',
  '🗓': '5472026645659401564',
  '📝': '5814427657609153890',
  '📱': '5407025283456835913',
  '📋': '5352765106180610755',
  '📡': '5413337163100083587',
  '👥': '5264942233387285985',
  '♻️': '5377584064326804458',
  '🛠': '6332490126135920267',
  '📘': '5388845245238622191',
  '🔗': '5271604874419647061',
  '📥': '5443127283898405358',
  '🔹': '5980903978731310545',
  '1️⃣': '5382322671679708881',
  '2️⃣': '5381990043642502553',
  '3️⃣': '5381879959335738545',
  '4️⃣': '5382054253403577563',
  '5️⃣': '5391197405553107640',
  '6️⃣': '5390966190283694453',
  '7️⃣': '5382132232829804982',
  '8️⃣': '5391038994274329680',
  '9️⃣': '5391234698754138414',
};
// Uzunroq (koʻp belgili, masalan variation selector qoʻshilgan) kalitlar
// birinchi tekshirilishi uchun uzunlik boʻyicha kamayish tartibida saralanadi.
const CUSTOM_EMOJI_KEYS = Object.keys(CUSTOM_EMOJI_MAP).sort((a, b) => b.length - a.length);

// Matn ichidan bilingan emojilarni topib, Bot API "custom_emoji" entity
// roʻyxatini quradi. offset/length UTF-16 kod birliklarida hisoblanadi —
// JS stringlari aynan shu birliklarda indekslangani uchun to‘g‘ridan-to‘g‘ri mos keladi.
function buildCustomEmojiEntities(text) {
  const entities = [];
  if (!text || typeof text !== 'string') return entities;
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const key of CUSTOM_EMOJI_KEYS) {
      if (text.startsWith(key, i)) {
        entities.push({
          type: 'custom_emoji',
          offset: i,
          length: key.length,
          custom_emoji_id: CUSTOM_EMOJI_MAP[key],
        });
        i += key.length;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  return entities;
}

// bot.sendMessage / bot.editMessageText metodlarini "o'rab", matnda uchragan
// oddiy emojilarni avtomatik custom_emoji entity bilan almashtiradi.
// parse_mode ishlatilgan joylarda (bu botda hozircha yo'q) entities bilan
// mos kelmasligi mumkin bo'lgani uchun bunday holatda tegilmaydi.
function wrapCustomEmoji(botInstance) {
  const originalSendMessage = botInstance.sendMessage.bind(botInstance);
  botInstance.sendMessage = function (chatId, text, options = {}) {
    if (!options.parse_mode && !options.entities) {
      const entities = buildCustomEmojiEntities(text);
      if (entities.length) options = { ...options, entities };
    }
    return originalSendMessage(chatId, text, options);
  };

  const originalEditMessageText = botInstance.editMessageText.bind(botInstance);
  botInstance.editMessageText = function (text, options = {}) {
    if (!options.parse_mode && !options.entities) {
      const entities = buildCustomEmojiEntities(text);
      if (entities.length) options = { ...options, entities };
    }
    return originalEditMessageText(text, options);
  };

  return botInstance;
}

// ---------- BOT ----------
let bot;
async function startBot() {
  if (WEBHOOK_URL) {
    bot = new TelegramBot(BOT_TOKEN, { webHook: { port: PORT } });
    wrapCustomEmoji(bot);
    await bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
    console.log(`Bot webhook rejimida ishga tushdi: ${WEBHOOK_URL}/bot${BOT_TOKEN}`);
  } else {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    wrapCustomEmoji(bot);
    console.log('Bot polling rejimida ishga tushdi.');

    // Render "Web Service" turi HTTP portni tinglashni talab qiladi (health check uchun),
    // aks holda deploy "abadiy kutish" holatida qotib qoladi. Polling rejimida
    // node-telegram-bot-api hech qanday port ochmaydi, shuning uchun shu yerda
    // eng oddiy HTTP server ochib qoʻyamiz — u faqat "OK" deb javob beradi.
    http
      .createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Nazoratchi bot ishlab turibdi.');
      })
      .listen(PORT, () => {
        console.log(`Health-check server ${PORT}-portda ishga tushdi.`);
      });
  }

  // Majburiy kanallar bazada topilmasa, index.js yuqorisidagi CHANNELS massividan olinadi.
  const existingChannels = await getSetting('channels', null);
  if (!existingChannels) {
    await setSetting('channels', JSON.stringify(CHANNELS));
  }

  registerHandlers();
  startReminderScheduler();
  console.log('Nazoratchi bot ishga tushdi.');
}

// ---------- IN-MEMORY FSM (holatlar mashinasi) ----------
// chatId -> { state, data }
const sessions = new Map();
const STATES = {
  IDLE: 'idle',
  REG_NAME: 'reg_name',
  REG_PHONE: 'reg_phone',
  TEST_CODE: 'test_code',
  TEST_ANSWERS: 'test_answers',
};

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { state: STATES.IDLE, data: {} });
  return sessions.get(chatId);
}
function resetSession(chatId) {
  const existing = sessions.get(chatId);
  if (existing && existing.data && existing.data.timer) {
    clearTimeout(existing.data.timer);
  }
  sessions.set(chatId, { state: STATES.IDLE, data: {} });
}

// Admin uchun alohida holat mashinasi — foydalanuvchi FSM'siga aralashmasligi uchun.
const adminSessions = new Map();
const ADMIN_STATES = {
  IDLE: 'idle',
  ADD_CODE: 'add_code',
  ADD_TITLE: 'add_title',
  ADD_KEY: 'add_key',
  ADD_DURATION: 'add_duration',
  ADD_DEADLINE: 'add_deadline',
  ADD_CHANNEL: 'add_channel',
  BROADCAST: 'broadcast',
};
function getAdminSession(chatId) {
  if (!adminSessions.has(chatId)) adminSessions.set(chatId, { state: ADMIN_STATES.IDLE, data: {} });
  return adminSessions.get(chatId);
}
function resetAdminSession(chatId) {
  adminSessions.set(chatId, { state: ADMIN_STATES.IDLE, data: {} });
}

// ---------- KEYBOARDS ----------
const mainMenu = {
  reply_markup: {
    keyboard: [
      [{ text: '📝 Vazifani yuborish', style: 'primary' }],
      [
        { text: '📊 Mening natijalarim', style: 'primary' },
        { text: '🏆 Reyting', style: 'primary' },
      ],
    ],
    resize_keyboard: true,
  },
};
const contactKeyboard = {
  reply_markup: {
    keyboard: [[{ text: '📱 Raqamni yuborish', request_contact: true, style: 'success' }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};
const removeKeyboard = { reply_markup: { remove_keyboard: true } };

// ---------- HELPERS ----------
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

async function getUser(userId) {
  return Users.findOne({ user_id: userId });
}

async function getChannels() {
  const raw = await getSetting('channels', null);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}
async function saveChannels(channels) {
  await setSetting('channels', JSON.stringify(channels));
}

// Barcha sozlangan kanallarni tekshiradi. Foydalanuvchi hali aʼzo boʻlmagan
// kanallar roʻyxatini qaytaradi (boʻsh roʻyxat = hammasiga aʼzo).
async function checkMembership(userId) {
  const channels = await getChannels();
  if (channels.length === 0) return { ok: true, missing: [] };

  const missing = [];
  for (const ch of channels) {
    try {
      const member = await bot.getChatMember(ch.id, userId);
      if (!['creator', 'administrator', 'member'].includes(member.status)) {
        missing.push(ch);
      }
    } catch (err) {
      console.error(`getChatMember xatosi (${ch.id}):`, err.message);
      missing.push(ch);
    }
  }
  return { ok: missing.length === 0, missing };
}

function notMemberMessage(missing) {
  return `❌ Siz barcha majburiy kanallarga aʼzo emassiz.\nQuyidagi kanal(lar)ga aʼzo boʻling, keyin "✅ Tekshirish" tugmasini bosing:`;
}

// Har bir kanal uchun shaffof URL-tugma, pastda esa yashil "Tekshirish" tugmasi (Bot API 9.4 style).
function notMemberKeyboard(missing) {
  const rows = missing.map((ch) => [
    { text: `🔗 ${ch.id.replace('@', '')}`, url: ch.link, style: 'primary' },
  ]);
  rows.push([{ text: '✅ Tekshirish', callback_data: 'check_membership', style: 'success' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function normalizeAnswers(raw) {
  return raw
    .split('*')
    .map((a) => a.trim().toUpperCase())
    .filter((a) => a.length > 0);
}

const VALID_ANSWER_RE = /^[A-D1-4]$/;

function validateAnswers(answers, expectedCount) {
  if (answers.length !== expectedCount) {
    return { ok: false, reason: 'count', got: answers.length };
  }
  for (const a of answers) {
    if (!VALID_ANSWER_RE.test(a)) {
      return { ok: false, reason: 'format', bad: a };
    }
  }
  return { ok: true };
}

function scoreAnswers(userAnswers, keyAnswers) {
  let correct = 0;
  for (let i = 0; i < keyAnswers.length; i++) {
    if (userAnswers[i] === keyAnswers[i]) correct++;
  }
  return correct;
}

function formatDateTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleString('uz-UZ', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// "YYYY-MM-DD HH:MM" formatini Date obyektiga aylantiradi. Notoʻgʻri boʻlsa null.
function parseDeadlineInput(text) {
  const t = text.trim();
  if (t === '0' || t.toLowerCase() === "yo'q" || t.toLowerCase() === 'yoq') return { skip: true };
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return { skip: false, valid: false };
  const [, y, mo, da, h, mi] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi));
  if (isNaN(date.getTime())) return { skip: false, valid: false };
  return { skip: false, valid: true, date };
}

// Bitta test kodini qayta topshirish siyosati:
// "BEST" - eng yaxshi natija saqlanadi (standart), "LAST" - oxirgisi, "FIRST" - faqat birinchisi.
const RESUBMIT_POLICY = 'BEST';

async function saveSubmission(userId, testCode, userAnswersRaw, correctCount, percentage) {
  const existing = await Submissions.findOne({ user_id: userId, test_code: testCode });

  if (!existing) {
    await Submissions.insertOne({
      user_id: userId,
      test_code: testCode,
      user_answers: userAnswersRaw,
      correct_count: correctCount,
      percentage,
      submitted_at: new Date(),
    });
    return { saved: true, correctCount, percentage };
  }

  if (RESUBMIT_POLICY === 'FIRST') {
    return { saved: false, correctCount: existing.correct_count, percentage: existing.percentage };
  }
  if (RESUBMIT_POLICY === 'LAST') {
    await Submissions.updateOne(
      { user_id: userId, test_code: testCode },
      { $set: { user_answers: userAnswersRaw, correct_count: correctCount, percentage, submitted_at: new Date() } }
    );
    return { saved: true, correctCount, percentage };
  }
  // BEST (default)
  if (correctCount > existing.correct_count) {
    await Submissions.updateOne(
      { user_id: userId, test_code: testCode },
      { $set: { user_answers: userAnswersRaw, correct_count: correctCount, percentage, submitted_at: new Date() } }
    );
    return { saved: true, correctCount, percentage, improved: true };
  }
  return { saved: false, correctCount: existing.correct_count, percentage: existing.percentage };
}

// Testni yaratadi yoki yangilaydi (legacy /addtest buyrug'i va admin panel ikkalasi ham shundan foydalanadi).
async function upsertTest(testCode, title, keyRaw, durationMinutes, deadlineDate) {
  const key = normalizeAnswers(keyRaw);
  if (key.length === 0) return { ok: false, reason: 'empty_key' };
  const code = testCode.toUpperCase();
  await Tests.updateOne(
    { test_code: code },
    {
      $set: {
        test_code: code,
        title,
        answer_key: key.join('*'),
        questions_count: key.length,
        is_active: true,
        duration_minutes: durationMinutes || null,
        deadline: deadlineDate || null,
        reminder_sent: false,
      },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true }
  );
  return { ok: true, code, questionsCount: key.length };
}

// Test uchun har bir savol boʻyicha xato foizini hisoblaydi.
async function computeQuestionStats(testCode) {
  const test = await Tests.findOne({ test_code: testCode });
  if (!test) return null;
  const key = normalizeAnswers(test.answer_key);
  const subs = await Submissions.find({ test_code: testCode }).toArray();
  const total = subs.length;
  const wrongCounts = new Array(key.length).fill(0);
  for (const s of subs) {
    const ua = normalizeAnswers(s.user_answers);
    for (let i = 0; i < key.length; i++) {
      if (ua[i] !== key[i]) wrongCounts[i]++;
    }
  }
  const stats = wrongCounts.map((w, i) => ({
    q: i + 1,
    wrong: w,
    total,
    rate: total ? Math.round((w / total) * 1000) / 10 : 0,
  }));
  stats.sort((a, b) => b.rate - a.rate);
  return { test, total, stats };
}

function registerHandlers() {
  // ---------- /start ----------
  bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const membership = await checkMembership(userId);
    if (!membership.ok) {
      return bot.sendMessage(chatId, notMemberMessage(membership.missing), notMemberKeyboard(membership.missing));
    }

    const user = await getUser(userId);
    if (user) {
      resetSession(chatId);
      return bot.sendMessage(chatId, `Xush kelibsiz, ${user.full_name}!`, mainMenu);
    }

    const session = getSession(chatId);
    session.state = STATES.REG_NAME;
    session.data = {};
    bot.sendMessage(chatId, "✅ Kanalga aʼzoligingiz tasdiqlandi.\n\nIsmingiz va familiyangizni kiriting:", removeKeyboard);
  });

  // ---------- Matnli va boshqa xabarlar (FSM) ----------
  bot.on('message', async (msg) => {
    if (!msg.text && !msg.contact) return;
    if (msg.text && msg.text.startsWith('/')) return; // buyruqlar alohida ishlanadi

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text ? msg.text.trim() : '';

    // ---- Avval admin FSM holatini tekshiramiz ----
    if (isAdmin(userId)) {
      const aSession = getAdminSession(chatId);
      if (aSession.state !== ADMIN_STATES.IDLE) {
        return handleAdminFsmMessage(chatId, aSession, text);
      }
    }

    const session = getSession(chatId);

    if (text === '📝 Vazifani yuborish') {
      return handleAskForTestCode(chatId, userId);
    }
    if (text === '📊 Mening natijalarim') {
      resetSession(chatId);
      return handleMyResults(chatId, userId);
    }
    if (text === '🏆 Reyting') {
      resetSession(chatId);
      return handleRating(chatId, userId, 0, 'all');
    }

    switch (session.state) {
      case STATES.REG_NAME: {
        if (!text || text.length < 2) {
          return bot.sendMessage(chatId, 'Iltimos, ism va familiyangizni toʻliq kiriting.');
        }
        session.data.full_name = text;
        session.state = STATES.REG_PHONE;
        return bot.sendMessage(chatId, 'Telefon raqamingizni yuboring:', contactKeyboard);
      }

      case STATES.REG_PHONE: {
        let phone = null;
        if (msg.contact && msg.contact.phone_number) {
          phone = msg.contact.phone_number;
        } else if (text && /^[+0-9][0-9\s\-()]{6,}$/.test(text)) {
          phone = text;
        }
        if (!phone) {
          return bot.sendMessage(
            chatId,
            '❌ Telefon raqam notoʻgʻri. Iltimos "📱 Raqamni yuborish" tugmasini bosing yoki raqamni toʻgʻri formatda yozing.',
            contactKeyboard
          );
        }
        await Users.updateOne(
          { user_id: userId },
          { $set: { user_id: userId, full_name: session.data.full_name, phone, is_active: true, registered_at: new Date() } },
          { upsert: true }
        );
        resetSession(chatId);
        return bot.sendMessage(chatId, '✅ Roʻyxatdan oʻtdingiz!', mainMenu);
      }

      case STATES.TEST_CODE: {
        if (!text) return bot.sendMessage(chatId, 'Iltimos, test kodini matn koʻrinishida yuboring.');
        const test = await Tests.findOne({ test_code: text.toUpperCase(), is_active: true });
        if (!test) {
          return bot.sendMessage(chatId, '❌ Bunday test kodi topilmadi. Qaytadan urinib koʻring.');
        }
        if (test.deadline && new Date() > new Date(test.deadline)) {
          return bot.sendMessage(
            chatId,
            `⛔ "${test.title}" testini topshirish muddati tugagan (${formatDateTime(test.deadline)}).`
          );
        }

        session.data.test_code = test.test_code;
        session.state = STATES.TEST_ANSWERS;

        let infoLines = [
          `Javoblaringizni * belgisi bilan ajratib yuboring.`,
          `Masalan: A*B*C*D*A*B*C*D*A*B*...`,
          `Jami ${test.questions_count} ta javob boʻlishi kerak.`,
        ];

        if (test.duration_minutes) {
          const timeoutMs = test.duration_minutes * 60 * 1000;
          session.data.deadline_ts = Date.now() + timeoutMs;
          infoLines.push(`⏱ Sizda ${test.duration_minutes} daqiqa vaqt bor. Vaqt tugasa test avtomatik bekor boʻladi.`);

          session.data.timer = setTimeout(() => {
            const s = sessions.get(chatId);
            if (s && s.state === STATES.TEST_ANSWERS && s.data.test_code === test.test_code) {
              resetSession(chatId);
              bot.sendMessage(chatId, `⏱ "${test.title}" uchun vaqt tugadi. Test bekor qilindi, qaytadan urinib koʻring.`, mainMenu);
            }
          }, timeoutMs);
        }

        return bot.sendMessage(chatId, infoLines.join('\n'));
      }

      case STATES.TEST_ANSWERS: {
        if (!text) return bot.sendMessage(chatId, 'Iltimos, javoblarni matn koʻrinishida yuboring.');

        if (session.data.deadline_ts && Date.now() > session.data.deadline_ts) {
          resetSession(chatId);
          return bot.sendMessage(chatId, '⏱ Vaqt tugagan. Testni qaytadan boshlang.', mainMenu);
        }

        const membership = await checkMembership(userId);
        if (!membership.ok) {
          resetSession(chatId);
          return bot.sendMessage(chatId, notMemberMessage(membership.missing), notMemberKeyboard(membership.missing));
        }

        const test = await Tests.findOne({ test_code: session.data.test_code });
        if (!test || !test.is_active) {
          resetSession(chatId);
          return bot.sendMessage(chatId, '❌ Bu test endi faol emas.', mainMenu);
        }

        const answers = normalizeAnswers(text);
        const check = validateAnswers(answers, test.questions_count);
        if (!check.ok) {
          if (check.reason === 'count') {
            return bot.sendMessage(
              chatId,
              `❌ Javoblar soni notoʻgʻri (siz ${check.got} ta yubordingiz). Aynan ${test.questions_count} ta javob kerak. Qaytadan yuboring.`
            );
          }
          return bot.sendMessage(
            chatId,
            `❌ Notoʻgʻri belgi topildi: "${check.bad}". Faqat A/B/C/D yoki 1/2/3/4 dan foydalaning va javoblarni * bilan ajrating (masalan: A*B*C*D).`
          );
        }

        const keyAnswers = normalizeAnswers(test.answer_key);
        const correctCount = scoreAnswers(answers, keyAnswers);
        const percentage = Math.round((correctCount / test.questions_count) * 1000) / 10;

        const result = await saveSubmission(userId, test.test_code, answers.join('*'), correctCount, percentage);

        if (session.data.timer) clearTimeout(session.data.timer);
        resetSession(chatId);

        if (!result.saved) {
          return bot.sendMessage(
            chatId,
            `ℹ️ Siz bu testni avval ${result.correctCount}/${test.questions_count} (${result.percentage}%) natija bilan topshirgansiz. Eng yaxshi natijangiz saqlanmoqda, shuning uchun bu urinish hisobga olinmadi.`,
            mainMenu
          );
        }
        return bot.sendMessage(
          chatId,
          `✅ Natijangiz: ${correctCount}/${test.questions_count} (${percentage}%)`,
          mainMenu
        );
      }

      default:
        return;
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data || '';

    // ---- A'zolikni tekshirish ----
    if (data === 'check_membership') {
      const membership = await checkMembership(userId);
      if (membership.ok) {
        try {
          await bot.editMessageText('✅ Aʼzolik tasdiqlandi! Davom etish uchun /start bosing.', {
            chat_id: chatId,
            message_id: query.message.message_id,
          });
        } catch (e) {}
        await bot.answerCallbackQuery(query.id, { text: '✅ Barcha kanallarga aʼzosiz!' });
        return;
      }
      try {
        await bot.editMessageText(notMemberMessage(membership.missing), {
          chat_id: chatId,
          message_id: query.message.message_id,
          ...notMemberKeyboard(membership.missing),
        });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id, { text: '❌ Hali barcha kanallarga aʼzo emassiz.' });
    }

    // ---- Reyting: davr almashtirish / sahifalash (rating_<period>_<page>) ----
    if (data.startsWith('rating_')) {
      const parts = data.split('_');
      const period = parts[1];
      const page = parseInt(parts[2], 10) || 0;
      const { text, totalPages } = await buildRatingText(page, userId, period);
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: query.message.message_id,
          ...ratingKeyboard(page, totalPages, period),
        });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    // ---- Admin panel tugmalari ----
    if (data.startsWith('admin_')) {
      if (!isAdmin(userId)) {
        return bot.answerCallbackQuery(query.id, { text: '⛔ Bu sizga tegishli emas.' });
      }
      await handleAdminCallback(chatId, query, data);
      return;
    }

    return bot.answerCallbackQuery(query.id);
  });

  // =====================================================================
  // ADMIN: INLINE PANEL
  // =====================================================================

  function requireAdmin(msg) {
    if (!isAdmin(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Bu buyruq faqat adminlar uchun.');
      return false;
    }
    return true;
  }

  function adminMainKeyboard() {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ Test qoʻshish', callback_data: 'admin_addtest', style: 'primary' },
            { text: '📋 Testlar', callback_data: 'admin_listtests', style: 'primary' },
          ],
          [
            { text: '📡 Kanallar', callback_data: 'admin_channels', style: 'primary' },
            { text: '👥 Foydalanuvchilar', callback_data: 'admin_users', style: 'primary' },
          ],
          [
            { text: '📊 Statistika', callback_data: 'admin_stats', style: 'primary' },
            { text: '📢 Xabar yuborish', callback_data: 'admin_broadcast', style: 'primary' },
          ],
          [
            { text: '📥 Export CSV', callback_data: 'admin_export', style: 'success' },
            { text: '♻️ Reytingni tozalash', callback_data: 'admin_resetrating', style: 'danger' },
          ],
        ],
      },
    };
  }

  // /admin — inline panelni ochadi
  bot.onText(/^\/admin$/, (msg) => {
    if (!requireAdmin(msg)) return;
    resetAdminSession(msg.chat.id);
    bot.sendMessage(msg.chat.id, '🛠 Admin panel:', adminMainKeyboard());
  });

  async function backToAdminMenu(chatId, messageId, extraText) {
    const text = (extraText ? extraText + '\n\n' : '') + '🛠 Admin panel:';
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...adminMainKeyboard() });
    } catch (e) {
      await bot.sendMessage(chatId, text, adminMainKeyboard());
    }
  }

  async function handleAdminCallback(chatId, query, data) {
    const messageId = query.message.message_id;

    // ---- Bosh menyu ----
    if (data === 'admin_menu') {
      await backToAdminMenu(chatId, messageId);
      return bot.answerCallbackQuery(query.id);
    }

    // ---- Test qoʻshish (bosqichma-bosqich) ----
    if (data === 'admin_addtest') {
      const aSession = getAdminSession(chatId);
      aSession.state = ADMIN_STATES.ADD_CODE;
      aSession.data = {};
      await bot.sendMessage(chatId, '➕ Yangi test.\n\nTest kodini kiriting (masalan: TEST01):');
      return bot.answerCallbackQuery(query.id);
    }

    // ---- Testlar roʻyxati ----
    if (data === 'admin_listtests') {
      const rows = await Tests.find({}).sort({ created_at: -1 }).toArray();
      if (rows.length === 0) {
        try {
          await bot.editMessageText('Hozircha testlar yoʻq.', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Orqaga', callback_data: 'admin_menu', style: 'primary' }]] },
          });
        } catch (e) {}
        return bot.answerCallbackQuery(query.id);
      }
      const buttons = rows.map((r) => [
        {
          text: `${r.is_active ? '✅' : '⛔'} ${r.test_code} (${r.questions_count} savol)`,
          callback_data: `admin_testcard_${r.test_code}`,
          style: 'primary',
        },
      ]);
      buttons.push([{ text: '⬅️ Orqaga', callback_data: 'admin_menu', style: 'primary' }]);
      try {
        await bot.editMessageText('📋 Testlar roʻyxati (batafsil koʻrish uchun bosing):', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: buttons },
        });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    // ---- Bitta test kartasi: toggle / statistika ----
    if (data.startsWith('admin_testcard_')) {
      const code = data.replace('admin_testcard_', '');
      const test = await Tests.findOne({ test_code: code });
      if (!test) {
        return bot.answerCallbackQuery(query.id, { text: '❌ Test topilmadi.' });
      }
      const count = await Submissions.countDocuments({ test_code: code });
      const lines = [
        `📘 ${test.test_code} — ${test.title}`,
        `Holati: ${test.is_active ? '✅ faol' : '⛔ nofaol'}`,
        `Savollar soni: ${test.questions_count}`,
        `Vaqt chegarasi: ${test.duration_minutes ? test.duration_minutes + ' daqiqa' : 'yoʻq'}`,
        `Muddat: ${test.deadline ? formatDateTime(test.deadline) : 'yoʻq'}`,
        `Topshirganlar soni: ${count}`,
      ];
      const buttons = [
        [
          { text: test.is_active ? '⛔ Nofaol qilish' : '✅ Faollashtirish', callback_data: `admin_toggletest_${code}`, style: test.is_active ? 'danger' : 'success' },
          { text: '📊 Statistika', callback_data: `admin_teststats_${code}`, style: 'primary' },
        ],
        [{ text: '⬅️ Testlar roʻyxati', callback_data: 'admin_listtests', style: 'primary' }],
      ];
      try {
        await bot.editMessageText(lines.join('\n'), { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    // ---- Testni faol/nofaol qilish ----
    if (data.startsWith('admin_toggletest_')) {
      const code = data.replace('admin_toggletest_', '');
      const test = await Tests.findOne({ test_code: code });
      if (!test) return bot.answerCallbackQuery(query.id, { text: '❌ Test topilmadi.' });
      const newState = !test.is_active;
      await Tests.updateOne({ test_code: code }, { $set: { is_active: newState } });
      await bot.answerCallbackQuery(query.id, { text: newState ? '✅ Faollashtirildi' : '⛔ Nofaol qilindi' });
      // Kartani yangilab qayta chizamiz
      return handleAdminCallback(chatId, { message: { message_id: messageId }, id: query.id }, `admin_testcard_${code}`);
    }

    // ---- Statistika: testlar roʻyxati (tanlash uchun) ----
    if (data === 'admin_stats') {
      const rows = await Tests.find({}).sort({ created_at: -1 }).toArray();
      if (rows.length === 0) {
        try {
          await bot.editMessageText('Hozircha testlar yoʻq.', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Orqaga', callback_data: 'admin_menu', style: 'primary' }]] },
          });
        } catch (e) {}
        return bot.answerCallbackQuery(query.id);
      }
      const buttons = rows.map((r) => [{ text: `${r.test_code} — ${r.title}`, callback_data: `admin_teststats_${r.test_code}`, style: 'primary' }]);
      buttons.push([{ text: '⬅️ Orqaga', callback_data: 'admin_menu', style: 'primary' }]);
      try {
        await bot.editMessageText('📊 Qaysi test statistikasini koʻrmoqchisiz?', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    // ---- Bitta test uchun statistika (eng ko'p xato qilingan savollar) ----
    if (data.startsWith('admin_teststats_')) {
      const code = data.replace('admin_teststats_', '');
      const result = await computeQuestionStats(code);
      if (!result) return bot.answerCallbackQuery(query.id, { text: '❌ Test topilmadi.' });
      const { test, total, stats } = result;
      let text;
      if (total === 0) {
        text = `📊 ${test.test_code} — hali hech kim topshirmagan.`;
      } else {
        const top = stats.slice(0, 10).filter((s) => s.wrong > 0);
        const lines = [`📊 ${test.test_code} — ${total} ta topshirilgan`, '', 'Eng koʻp xato qilingan savollar:'];
        if (top.length === 0) {
          lines.push('Hech kim xato qilmagan 🎉');
        } else {
          top.forEach((s) => lines.push(`${s.q}-savol: ${s.rate}% xato (${s.wrong}/${s.total})`));
        }
        text = lines.join('\n');
      }
      const buttons = [[{ text: '⬅️ Orqaga', callback_data: 'admin_stats', style: 'primary' }]];
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    // ---- Kanallar boshqaruvi ----
    if (data === 'admin_channels') {
      const channels = await getChannels();
      const lines = channels.length ? channels.map((c, i) => `${i + 1}. ${c.id} — ${c.link}`) : ['Hozircha majburiy kanal yoʻq.'];
      const buttons = channels.map((c) => [{ text: `➖ ${c.id}`, callback_data: `admin_removechannel_${c.id}`, style: 'danger' }]);
      buttons.push([{ text: '➕ Kanal qoʻshish', callback_data: 'admin_addchannel', style: 'success' }]);
      buttons.push([{ text: '⬅️ Orqaga', callback_data: 'admin_menu', style: 'primary' }]);
      try {
        await bot.editMessageText(`📡 Majburiy kanallar:\n${lines.join('\n')}`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    if (data === 'admin_addchannel') {
      const aSession = getAdminSession(chatId);
      aSession.state = ADMIN_STATES.ADD_CHANNEL;
      aSession.data = {};
      await bot.sendMessage(chatId, 'Kanalni shu formatda yuboring:\n@kanal_username https://t.me/kanal_username');
      return bot.answerCallbackQuery(query.id);
    }

    if (data.startsWith('admin_removechannel_')) {
      const id = data.replace('admin_removechannel_', '');
      const channels = await getChannels();
      const filtered = channels.filter((c) => c.id !== id);
      await saveChannels(filtered);
      await bot.answerCallbackQuery(query.id, { text: `✅ ${id} olib tashlandi` });
      return handleAdminCallback(chatId, { message: { message_id: messageId }, id: query.id }, 'admin_channels');
    }

    // ---- Foydalanuvchilar ----
    if (data === 'admin_users') {
      const count = await Users.countDocuments();
      const rows = await Users.find({}).sort({ registered_at: -1 }).limit(20).toArray();
      let text = `👥 Jami roʻyxatdan oʻtganlar: ${count}\n\nOxirgi 20 ta:\n`;
      text += rows.map((r) => `${r.full_name} — ${r.phone} — ${formatDateTime(r.registered_at)}`).join('\n') || 'Hozircha hech kim yoʻq.';
      const buttons = [[{ text: '⬅️ Orqaga', callback_data: 'admin_menu', style: 'primary' }]];
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons } });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    // ---- Broadcast ----
    if (data === 'admin_broadcast') {
      const aSession = getAdminSession(chatId);
      aSession.state = ADMIN_STATES.BROADCAST;
      aSession.data = {};
      await bot.sendMessage(chatId, '📢 Barchaga yuboriladigan xabar matnini kiriting:');
      return bot.answerCallbackQuery(query.id);
    }

    if (data === 'admin_broadcast_send') {
      const aSession = getAdminSession(chatId);
      const text = aSession.data.broadcastText;
      resetAdminSession(chatId);
      if (!text) return bot.answerCallbackQuery(query.id, { text: '❌ Xabar topilmadi.' });
      const users = await Users.find({}).toArray();
      let sent = 0;
      for (const u of users) {
        try {
          await bot.sendMessage(u.user_id, `📢 ${text}`);
          sent++;
        } catch (e) {}
      }
      try {
        await bot.editMessageText(`✅ Xabar ${sent}/${users.length} foydalanuvchiga yuborildi.`, { chat_id: chatId, message_id: messageId });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    if (data === 'admin_broadcast_cancel') {
      resetAdminSession(chatId);
      try {
        await bot.editMessageText('❌ Bekor qilindi.', { chat_id: chatId, message_id: messageId });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    // ---- Export ----
    if (data === 'admin_export') {
      await bot.answerCallbackQuery(query.id, { text: 'Tayyorlanmoqda...' });
      const submissions = await Submissions.find({}).sort({ submitted_at: -1 }).toArray();
      if (submissions.length === 0) return bot.sendMessage(chatId, 'Eksport qilish uchun maʼlumot yoʻq.');
      const userIds = [...new Set(submissions.map((s) => s.user_id))];
      const users = await Users.find({ user_id: { $in: userIds } }).toArray();
      const userMap = new Map(users.map((u) => [u.user_id, u]));
      const header = 'Ism Familiya,Telefon,Test kodi,Toʻgʻri javob,Foiz,Sana\n';
      const body = submissions
        .map((s) => {
          const u = userMap.get(s.user_id) || {};
          return `"${u.full_name || ''}","${u.phone || ''}","${s.test_code}",${s.correct_count},${s.percentage},"${new Date(s.submitted_at).toISOString()}"`;
        })
        .join('\n');
      const csv = header + body;
      const filePath = path.join(__dirname, 'export.csv');
      fs.writeFileSync(filePath, csv, 'utf8');
      bot.sendDocument(chatId, filePath).finally(() => {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
      });
      return;
    }

    // ---- Reytingni tozalash (tasdiqlash bilan) ----
    if (data === 'admin_resetrating') {
      const buttons = [
        [
          { text: '⚠️ Ha, tozalash', callback_data: 'admin_resetrating_confirm', style: 'danger' },
          { text: '❌ Bekor qilish', callback_data: 'admin_menu', style: 'primary' },
        ],
      ];
      try {
        await bot.editMessageText('♻️ Haqiqatan ham barcha natijalarni oʻchirmoqchimisiz? Bu amalni ortga qaytarib boʻlmaydi.', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: buttons },
        });
      } catch (e) {}
      return bot.answerCallbackQuery(query.id);
    }

    if (data === 'admin_resetrating_confirm') {
      await Submissions.deleteMany({});
      await bot.answerCallbackQuery(query.id, { text: '✅ Tozalandi' });
      return backToAdminMenu(chatId, messageId, '✅ Reyting va barcha natijalar tozalandi.');
    }

    return bot.answerCallbackQuery(query.id);
  }

  // Admin FSM: matnli xabarlarni qayta ishlash (test qoʻshish bosqichlari, kanal, broadcast)
  async function handleAdminFsmMessage(chatId, aSession, text) {
    switch (aSession.state) {
      case ADMIN_STATES.ADD_CODE: {
        if (!text) return bot.sendMessage(chatId, 'Test kodini kiriting:');
        aSession.data.code = text.toUpperCase();
        aSession.state = ADMIN_STATES.ADD_TITLE;
        return bot.sendMessage(chatId, 'Test nomini kiriting (masalan: 1-mavzu testi):');
      }
      case ADMIN_STATES.ADD_TITLE: {
        if (!text) return bot.sendMessage(chatId, 'Test nomini kiriting:');
        aSession.data.title = text;
        aSession.state = ADMIN_STATES.ADD_KEY;
        return bot.sendMessage(chatId, "Toʻgʻri javoblar kalitini kiriting (masalan: A*B*C*D*A*B*C*D*A*B):");
      }
      case ADMIN_STATES.ADD_KEY: {
        const key = normalizeAnswers(text || '');
        if (key.length === 0) {
          return bot.sendMessage(chatId, '❌ Javoblar kaliti boʻsh boʻlmasligi kerak. Qaytadan kiriting:');
        }
        aSession.data.keyRaw = text;
        aSession.state = ADMIN_STATES.ADD_DURATION;
        return bot.sendMessage(chatId, "⏱ Vaqt chegarasi (daqiqada) kiriting. Kerak boʻlmasa 0 yozing:");
      }
      case ADMIN_STATES.ADD_DURATION: {
        const n = parseInt(text, 10);
        if (isNaN(n) || n < 0) {
          return bot.sendMessage(chatId, "❌ Butun son kiriting (masalan: 30), kerak boʻlmasa 0:");
        }
        aSession.data.duration = n > 0 ? n : null;
        aSession.state = ADMIN_STATES.ADD_DEADLINE;
        return bot.sendMessage(chatId, "📅 Test muddatini kiriting (format: YYYY-MM-DD HH:MM). Kerak boʻlmasa 0 yozing:");
      }
      case ADMIN_STATES.ADD_DEADLINE: {
        const parsed = parseDeadlineInput(text || '0');
        if (!parsed.skip && !parsed.valid) {
          return bot.sendMessage(chatId, "❌ Format notoʻgʻri. Masalan: 2026-09-01 18:00, yoki kerak boʻlmasa 0:");
        }
        const deadlineDate = parsed.skip ? null : parsed.date;
        const { code, title, keyRaw, duration } = aSession.data;
        const result = await upsertTest(code, title, keyRaw, duration, deadlineDate);
        resetAdminSession(chatId);
        if (!result.ok) {
          return bot.sendMessage(chatId, '❌ Xatolik yuz berdi, qaytadan urinib koʻring.');
        }
        const lines = [
          `✅ Test saqlandi: ${result.code} (${result.questionsCount} ta savol)`,
          duration ? `⏱ Vaqt chegarasi: ${duration} daqiqa` : '⏱ Vaqt chegarasi: yoʻq',
          deadlineDate ? `📅 Muddat: ${formatDateTime(deadlineDate)}` : '📅 Muddat: yoʻq',
        ];
        return bot.sendMessage(chatId, lines.join('\n'), adminMainKeyboard());
      }
      case ADMIN_STATES.ADD_CHANNEL: {
        const m = (text || '').match(/^(\S+)\s+(\S+)$/);
        if (!m) {
          return bot.sendMessage(chatId, 'Format notoʻgʻri. Masalan: @kanal https://t.me/kanal');
        }
        const [, id, link] = m;
        const channels = await getChannels();
        if (channels.some((c) => c.id === id)) {
          resetAdminSession(chatId);
          return bot.sendMessage(chatId, `ℹ️ ${id} allaqachon roʻyxatda bor.`, adminMainKeyboard());
        }
        channels.push({ id, link });
        await saveChannels(channels);
        resetAdminSession(chatId);
        return bot.sendMessage(chatId, `✅ Kanal qoʻshildi: ${id}\nJami majburiy kanallar: ${channels.length}`, adminMainKeyboard());
      }
      case ADMIN_STATES.BROADCAST: {
        if (!text) return bot.sendMessage(chatId, 'Xabar matnini kiriting:');
        aSession.data.broadcastText = text;
        const buttons = [
          [
            { text: '✅ Yuborish', callback_data: 'admin_broadcast_send', style: 'success' },
            { text: '❌ Bekor qilish', callback_data: 'admin_broadcast_cancel', style: 'danger' },
          ],
        ];
        return bot.sendMessage(chatId, `Quyidagi xabar barcha foydalanuvchilarga yuboriladi:\n\n📢 ${text}`, {
          reply_markup: { inline_keyboard: buttons },
        });
      }
      default:
        resetAdminSession(chatId);
        return;
    }
  }

  // =====================================================================
  // LEGACY ADMIN BUYRUQLARI (matn orqali, /admin panel bilan bir xil funksiyalardan foydalanadi)
  // =====================================================================

  // /addtest KOD|Nomi|JAVOBLAR|[DAQIQA]|[YYYY-MM-DD HH:MM]
  bot.onText(/^\/addtest ([\s\S]+)/, async (msg, match) => {
    if (!requireAdmin(msg)) return;
    const parts = match[1].split('|').map((p) => p.trim());
    if (parts.length < 3) {
      return bot.sendMessage(
        msg.chat.id,
        'Format: /addtest TEST_KODI|Test nomi|TOʻGʻRI_JAVOBLAR|[daqiqa]|[YYYY-MM-DD HH:MM]\nMasalan: /addtest TEST01|1-mavzu|A*B*C*D*A*B*C*D*A*B|30'
      );
    }
    const [code, title, keyRaw, durationRaw, deadlineRaw] = parts;
    const duration = durationRaw ? parseInt(durationRaw, 10) || null : null;
    let deadlineDate = null;
    if (deadlineRaw) {
      const parsed = parseDeadlineInput(deadlineRaw);
      if (parsed.valid) deadlineDate = parsed.date;
    }
    const result = await upsertTest(code, title, keyRaw, duration, deadlineDate);
    if (!result.ok) {
      return bot.sendMessage(msg.chat.id, '❌ Javoblar kaliti boʻsh boʻlmasligi kerak.');
    }
    bot.sendMessage(msg.chat.id, `✅ Test saqlandi: ${result.code} (${result.questionsCount} ta savol).`);
  });

  // /toggletest TEST01
  bot.onText(/^\/toggletest (\S+)/, async (msg, match) => {
    if (!requireAdmin(msg)) return;
    const code = match[1].toUpperCase();
    const test = await Tests.findOne({ test_code: code });
    if (!test) return bot.sendMessage(msg.chat.id, '❌ Test topilmadi.');
    const newState = !test.is_active;
    await Tests.updateOne({ test_code: code }, { $set: { is_active: newState } });
    bot.sendMessage(msg.chat.id, `Test ${code}: ${newState ? '✅ faollashtirildi' : '⛔ nofaol qilindi'}.`);
  });

  // /listtests
  bot.onText(/^\/listtests$/, async (msg) => {
    if (!requireAdmin(msg)) return;
    const rows = await Tests.find({}).toArray();
    if (rows.length === 0) return bot.sendMessage(msg.chat.id, 'Hozircha testlar yoʻq.');
    const text = rows
      .map((r) => `${r.is_active ? '✅' : '⛔'} ${r.test_code} — ${r.title} (${r.questions_count} savol)`)
      .join('\n');
    bot.sendMessage(msg.chat.id, text);
  });

  // /addchannel @kanal_username https://t.me/kanal — yangi majburiy kanal qoʻshadi
  bot.onText(/^\/addchannel (\S+)\s+(\S+)/, async (msg, match) => {
    if (!requireAdmin(msg)) return;
    const id = match[1];
    const link = match[2];
    const channels = await getChannels();
    if (channels.some((c) => c.id === id)) {
      return bot.sendMessage(msg.chat.id, `ℹ️ ${id} allaqachon roʻyxatda bor.`);
    }
    channels.push({ id, link });
    await saveChannels(channels);
    bot.sendMessage(msg.chat.id, `✅ Kanal qoʻshildi: ${id}\nJami majburiy kanallar: ${channels.length}`);
  });

  // /removechannel @kanal_username — kanalni majburiy roʻyxatdan olib tashlaydi
  bot.onText(/^\/removechannel (\S+)/, async (msg, match) => {
    if (!requireAdmin(msg)) return;
    const id = match[1];
    const channels = await getChannels();
    const filtered = channels.filter((c) => c.id !== id);
    if (filtered.length === channels.length) {
      return bot.sendMessage(msg.chat.id, `❌ ${id} roʻyxatda topilmadi.`);
    }
    await saveChannels(filtered);
    bot.sendMessage(msg.chat.id, `✅ Kanal olib tashlandi: ${id}\nJami majburiy kanallar: ${filtered.length}`);
  });

  // /listchannels — barcha majburiy kanallarni koʻrsatadi
  bot.onText(/^\/listchannels$/, async (msg) => {
    if (!requireAdmin(msg)) return;
    const channels = await getChannels();
    if (channels.length === 0) {
      return bot.sendMessage(msg.chat.id, 'Hozircha majburiy kanal sozlanmagan (aʼzolik tekshirilmaydi).');
    }
    const text = channels.map((c, i) => `${i + 1}. ${c.id} — ${c.link}`).join('\n');
    bot.sendMessage(msg.chat.id, `Majburiy kanallar (${channels.length}):\n${text}`);
  });

  // /users - roʻyxatdan oʻtganlar soni va oxirgi 20 tasi
  bot.onText(/^\/users$/, async (msg) => {
    if (!requireAdmin(msg)) return;
    const count = await Users.countDocuments();
    const rows = await Users.find({}).sort({ registered_at: -1 }).limit(20).toArray();
    let text = `Jami roʻyxatdan oʻtganlar: ${count}\n\nOxirgi 20 ta:\n`;
    text += rows.map((r) => `${r.full_name} — ${r.phone} — ${new Date(r.registered_at).toLocaleString()}`).join('\n');
    bot.sendMessage(msg.chat.id, text || 'Hozircha hech kim yoʻq.');
  });

  // /export - CSV holida barcha natijalarni yuborish (Excelda ochish mumkin)
  bot.onText(/^\/export$/, async (msg) => {
    if (!requireAdmin(msg)) return;
    const submissions = await Submissions.find({}).sort({ submitted_at: -1 }).toArray();
    if (submissions.length === 0) return bot.sendMessage(msg.chat.id, 'Eksport qilish uchun maʼlumot yoʻq.');

    const userIds = [...new Set(submissions.map((s) => s.user_id))];
    const users = await Users.find({ user_id: { $in: userIds } }).toArray();
    const userMap = new Map(users.map((u) => [u.user_id, u]));

    const header = 'Ism Familiya,Telefon,Test kodi,Toʻgʻri javob,Foiz,Sana\n';
    const body = submissions
      .map((s) => {
        const u = userMap.get(s.user_id) || {};
        return `"${u.full_name || ''}","${u.phone || ''}","${s.test_code}",${s.correct_count},${s.percentage},"${new Date(s.submitted_at).toISOString()}"`;
      })
      .join('\n');
    const csv = header + body;

    const filePath = path.join(__dirname, 'export.csv');
    fs.writeFileSync(filePath, csv, 'utf8');
    bot.sendDocument(msg.chat.id, filePath).finally(() => {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {}
    });
  });

  // /resetrating - barcha submissionlarni oʻchirish
  bot.onText(/^\/resetrating$/, async (msg) => {
    if (!requireAdmin(msg)) return;
    await Submissions.deleteMany({});
    bot.sendMessage(msg.chat.id, '✅ Reyting va barcha natijalar tozalandi.');
  });

  // /broadcast Matn shu yerda
  bot.onText(/^\/broadcast ([\s\S]+)/, async (msg, match) => {
    if (!requireAdmin(msg)) return;
    const text = match[1];
    const users = await Users.find({}).toArray();
    let sent = 0;
    for (const u of users) {
      try {
        await bot.sendMessage(u.user_id, `📢 ${text}`);
        sent++;
      } catch (e) {}
    }
    bot.sendMessage(msg.chat.id, `✅ Xabar ${sent}/${users.length} foydalanuvchiga yuborildi.`);
  });

  // /adminhelp - matnli buyruqlar roʻyxati (legacy, /admin panel tavsiya etiladi)
  bot.onText(/^\/adminhelp$/, (msg) => {
    if (!requireAdmin(msg)) return;
    bot.sendMessage(
      msg.chat.id,
      [
        'Admin buyruqlari (matn orqali, /admin panel ham mavjud):',
        '/addtest KOD|Nomi|JAVOBLAR|[daqiqa]|[YYYY-MM-DD HH:MM]',
        '/toggletest KOD — testni faol/nofaol qilish',
        '/listtests — barcha testlar',
        '/addchannel @kanal https://t.me/kanal — majburiy kanal qoʻshish',
        '/removechannel @kanal — majburiy kanalni olib tashlash',
        '/listchannels — barcha majburiy kanallar roʻyxati',
        '/users — roʻyxatdan oʻtganlar',
        '/export — natijalarni CSV qilib yuklab olish',
        '/resetrating — reytingni tozalash',
        '/broadcast Matn — barchaga xabar yuborish',
      ].join('\n')
    );
  });
}

async function handleAskForTestCode(chatId, userId) {
  const membership = await checkMembership(userId);
  if (!membership.ok) {
    resetSession(chatId);
    return bot.sendMessage(chatId, notMemberMessage(membership.missing), notMemberKeyboard(membership.missing));
  }
  const user = await getUser(userId);
  if (!user) {
    resetSession(chatId);
    return bot.sendMessage(chatId, 'Avval /start bosib roʻyxatdan oʻting.');
  }
  const session = getSession(chatId);
  session.state = STATES.TEST_CODE;
  session.data = {};
  return bot.sendMessage(chatId, 'Test kodini kiriting:');
}

async function handleMyResults(chatId, userId) {
  const rows = await Submissions.find({ user_id: userId }).sort({ submitted_at: -1 }).toArray();

  if (rows.length === 0) {
    return bot.sendMessage(chatId, 'Siz hali birorta test topshirmagansiz.', mainMenu);
  }

  const testCodes = [...new Set(rows.map((r) => r.test_code))];
  const tests = await Tests.find({ test_code: { $in: testCodes } }).toArray();
  const testMap = new Map(tests.map((t) => [t.test_code, t]));

  let total = 0;
  let totalMax = 0;
  let lines = [];
  for (const r of rows) {
    const test = testMap.get(r.test_code);
    const questionsCount = test ? test.questions_count : r.correct_count;
    const date = new Date(r.submitted_at).toISOString().split('T')[0];
    lines.push(`📘 ${r.test_code} — ${r.correct_count}/${questionsCount} (${r.percentage}%) — ${date}`);
    total += r.correct_count;
    totalMax += questionsCount;
  }
  const avg = totalMax ? Math.round((total / totalMax) * 1000) / 10 : 0;
  lines.push('');
  lines.push(`Jami ball: ${total} / ${totalMax}`);
  lines.push(`Oʻrtacha: ${avg}%`);

  return bot.sendMessage(chatId, lines.join('\n'), mainMenu);
}

const PAGE_SIZE = 10;
const RATING_PERIODS = {
  all: { label: '🏆 Umumiy', days: null },
  week: { label: '📅 Hafta', days: 7 },
  month: { label: '🗓 Oy', days: 30 },
};

function periodCutoff(period) {
  const cfg = RATING_PERIODS[period] || RATING_PERIODS.all;
  if (!cfg.days) return null;
  return new Date(Date.now() - cfg.days * 24 * 60 * 60 * 1000);
}

async function buildRatingText(page, userId, period) {
  const cutoff = periodCutoff(period);
  const pipeline = [];
  if (cutoff) pipeline.push({ $match: { submitted_at: { $gte: cutoff } } });
  pipeline.push({ $group: { _id: '$user_id', total: { $sum: '$correct_count' } } });
  pipeline.push({ $sort: { total: -1 } });

  const all = await Submissions.aggregate(pipeline).toArray();

  const userIds = all.map((r) => r._id);
  const users = await Users.find({ user_id: { $in: userIds } }).toArray();
  const userMap = new Map(users.map((u) => [u.user_id, u]));

  const start = page * PAGE_SIZE;
  const pageRows = all.slice(start, start + PAGE_SIZE);

  const periodLabel = (RATING_PERIODS[period] || RATING_PERIODS.all).label;
  let text = `🏆 REYTING — ${periodLabel}\n\n`;
  if (pageRows.length === 0) {
    text += 'Hozircha hech kim test topshirmagan.';
  } else {
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    pageRows.forEach((row, i) => {
      const place = start + i;
      const label = place < 10 ? emojis[place] : `${place + 1}.`;
      const u = userMap.get(row._id);
      text += `${label} ${u ? u.full_name : 'Nomaʼlum'} — ${row.total} ball\n`;
    });
  }

  const myIndex = all.findIndex((r) => r._id === userId);
  if (myIndex >= 0) {
    text += `\n🔹 Sizning oʻrningiz: ${myIndex + 1}-oʻrin (${all[myIndex].total} ball)`;
  } else {
    text += `\n🔹 Siz hali reytingda yoʻqsiz — test topshiring!`;
  }

  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  return { text, totalPages };
}

function ratingKeyboard(page, totalPages, period) {
  const periodRow = Object.keys(RATING_PERIODS).map((key) => ({
    text: (key === period ? '✅ ' : '') + RATING_PERIODS[key].label,
    callback_data: `rating_${key}_0`,
    style: key === period ? 'success' : 'primary',
  }));

  const navRow = [];
  if (page > 0) navRow.push({ text: '◀️ Oldingi', callback_data: `rating_${period}_${page - 1}`, style: 'primary' });
  if (page < totalPages - 1) navRow.push({ text: 'Keyingi ▶️', callback_data: `rating_${period}_${page + 1}`, style: 'primary' });

  const inline_keyboard = [periodRow];
  if (navRow.length) inline_keyboard.push(navRow);
  return { reply_markup: { inline_keyboard } };
}

async function handleRating(chatId, userId, page, period) {
  const { text, totalPages } = await buildRatingText(page, userId, period);
  return bot.sendMessage(chatId, text, ratingKeyboard(page, totalPages, period));
}

// ---------- ESLATMA TIZIMI ----------
// Muddati belgilangan testlar uchun, muddat tugashiga REMINDER_WINDOW_HOURS soat qolganda
// hali topshirmagan foydalanuvchilarga bir martalik eslatma yuboradi.
const REMINDER_CHECK_INTERVAL_MS = 30 * 60 * 1000; // har 30 daqiqada tekshiradi
const REMINDER_WINDOW_HOURS = 24;

function startReminderScheduler() {
  setInterval(async () => {
    try {
      const now = new Date();
      const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000);
      const tests = await Tests.find({
        is_active: true,
        deadline: { $ne: null, $gte: now, $lte: windowEnd },
        reminder_sent: { $ne: true },
      }).toArray();

      for (const test of tests) {
        const submitted = await Submissions.find({ test_code: test.test_code }).toArray();
        const submittedIds = new Set(submitted.map((s) => s.user_id));
        const users = await Users.find({ is_active: true }).toArray();
        const targets = users.filter((u) => !submittedIds.has(u.user_id));

        for (const u of targets) {
          try {
            await bot.sendMessage(
              u.user_id,
              `⏰ Eslatma: "${test.title}" (${test.test_code}) testini topshirish muddati tez orada tugaydi!\nOxirgi muddat: ${formatDateTime(test.deadline)}`
            );
          } catch (e) {
            // foydalanuvchi botni bloklagan boʻlishi mumkin
          }
        }
        await Tests.updateOne({ test_code: test.test_code }, { $set: { reminder_sent: true } });
      }
    } catch (err) {
      console.error('Eslatma tizimi xatosi:', err);
    }
  }, REMINDER_CHECK_INTERVAL_MS);
}

// ---------- ISHGA TUSHIRISH ----------
(async () => {
  try {
    await initDb();
    await startBot();
  } catch (err) {
    console.error('Ishga tushirishda xato:', err);
    process.exit(1);
  }
})();

process.on('SIGINT', async () => {
  await mongoClient.close();
  process.exit(0);
});
