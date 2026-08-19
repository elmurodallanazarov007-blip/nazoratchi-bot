/**
 * Nazoratchi Bot
 * Kurs ishtirokchilarini nazorat qiluvchi Telegram bot.
 * Kutubxona: node-telegram-bot-api (telegraf EMAS)
 * Baza: MongoDB Atlas (mongodb rasmiy driver)
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

// ---------- BOT ----------
let bot;
async function startBot() {
  if (WEBHOOK_URL) {
    bot = new TelegramBot(BOT_TOKEN, { webHook: { port: PORT } });
    await bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
    console.log(`Bot webhook rejimida ishga tushdi: ${WEBHOOK_URL}/bot${BOT_TOKEN}`);
  } else {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
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
  sessions.set(chatId, { state: STATES.IDLE, data: {} });
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

// Har bir kanal uchun shaffof (style berilmagan — Bot API 9.4'da inline tugmalar uchun
// standart koʻrinish shaffof boʻladi) URL-tugma, pastda esa koʻk (primary) "Tekshirish" tugmasi.
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

// Bitta test kodini qayta topshirish siyosati:
// "BEST" - eng yaxshi natija saqlanadi (standart)
// "LAST" (har doim oxirgisi) yoki "FIRST" (faqat birinchisi) ga oʻzgartirish mumkin.
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
    const session = getSession(chatId);
    const text = msg.text ? msg.text.trim() : '';

    if (text === '📝 Vazifani yuborish') {
      return handleAskForTestCode(chatId, userId);
    }
    if (text === '📊 Mening natijalarim') {
      resetSession(chatId);
      return handleMyResults(chatId, userId);
    }
    if (text === '🏆 Reyting') {
      resetSession(chatId);
      return handleRating(chatId, userId, 0);
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
        session.data.test_code = test.test_code;
        session.state = STATES.TEST_ANSWERS;
        return bot.sendMessage(
          chatId,
          `Javoblaringizni * belgisi bilan ajratib yuboring.\nMasalan: A*B*C*D*A*B*C*D*A*B*...\nJami ${test.questions_count} ta javob boʻlishi kerak.`
        );
      }

      case STATES.TEST_ANSWERS: {
        if (!text) return bot.sendMessage(chatId, 'Iltimos, javoblarni matn koʻrinishida yuboring.');

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

    if (query.data === 'check_membership') {
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
      } catch (e) {
        // xabar oʻzgarmagan boʻlishi mumkin (hali ham xuddi shu kanallarga aʼzo emas)
      }
      return bot.answerCallbackQuery(query.id, { text: '❌ Hali barcha kanallarga aʼzo emassiz.' });
    }

    if (query.data && query.data.startsWith('rating_')) {
      const page = parseInt(query.data.split('_')[1], 10) || 0;
      const { text, totalPages } = await buildRatingText(page, userId);
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: query.message.message_id,
          ...ratingKeyboard(page, totalPages),
        });
      } catch (e) {
        // xabar oʻzgarmagan boʻlishi mumkin, xato eʼtiborsiz qoldiriladi
      }
      return bot.answerCallbackQuery(query.id);
    }
    return bot.answerCallbackQuery(query.id);
  });

  // =====================================================================
  // ADMIN BUYRUQLARI
  // =====================================================================

  function requireAdmin(msg) {
    if (!isAdmin(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Bu buyruq faqat adminlar uchun.');
      return false;
    }
    return true;
  }

  // /addtest TEST01|12-mavzu testi|ABCDABCDAB...
  bot.onText(/^\/addtest ([\s\S]+)/, async (msg, match) => {
    if (!requireAdmin(msg)) return;
    const parts = match[1].split('|').map((p) => p.trim());
    if (parts.length < 3) {
      return bot.sendMessage(
        msg.chat.id,
        'Format: /addtest TEST_KODI|Test nomi|TOʻGʻRI_JAVOBLAR\nMasalan: /addtest TEST01|1-mavzu|A*B*C*D*A*B*C*D*A*B'
      );
    }
    const [code, title, keyRaw] = parts;
    const key = normalizeAnswers(keyRaw);
    if (key.length === 0) {
      return bot.sendMessage(msg.chat.id, '❌ Javoblar kaliti boʻsh boʻlmasligi kerak.');
    }
    const testCode = code.toUpperCase();
    await Tests.updateOne(
      { test_code: testCode },
      {
        $set: {
          test_code: testCode,
          title,
          answer_key: key.join('*'),
          questions_count: key.length,
          is_active: true,
        },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true }
    );
    bot.sendMessage(msg.chat.id, `✅ Test saqlandi: ${testCode} (${key.length} ta savol).`);
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
      } catch (e) {
        // foydalanuvchi botni bloklagan boʻlishi mumkin
      }
    }
    bot.sendMessage(msg.chat.id, `✅ Xabar ${sent}/${users.length} foydalanuvchiga yuborildi.`);
  });

  // /admin - admin buyruqlar roʻyxati
  bot.onText(/^\/admin$/, (msg) => {
    if (!requireAdmin(msg)) return;
    bot.sendMessage(
      msg.chat.id,
      [
        'Admin buyruqlari:',
        '/addtest KOD|Nomi|JAVOBLAR — test qoʻshish/tahrirlash',
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

async function buildRatingText(page, userId) {
  const all = await Submissions.aggregate([
    { $group: { _id: '$user_id', total: { $sum: '$correct_count' } } },
    { $sort: { total: -1 } },
  ]).toArray();

  const userIds = all.map((r) => r._id);
  const users = await Users.find({ user_id: { $in: userIds } }).toArray();
  const userMap = new Map(users.map((u) => [u.user_id, u]));

  const start = page * PAGE_SIZE;
  const pageRows = all.slice(start, start + PAGE_SIZE);

  let text = '🏆 UMUMIY REYTING\n\n';
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

function ratingKeyboard(page, totalPages) {
  const buttons = [];
  if (page > 0) buttons.push({ text: '◀️ Oldingi', callback_data: `rating_${page - 1}`, style: 'primary' });
  if (page < totalPages - 1) buttons.push({ text: 'Keyingi ▶️', callback_data: `rating_${page + 1}`, style: 'primary' });
  return buttons.length ? { reply_markup: { inline_keyboard: [buttons] } } : {};
}

async function handleRating(chatId, userId, page) {
  const { text, totalPages } = await buildRatingText(page, userId);
  return bot.sendMessage(chatId, text, ratingKeyboard(page, totalPages));
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
