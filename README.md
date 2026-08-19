# Nazoratchi Bot

Kurs ishtirokchilarini nazorat qiluvchi Telegram bot: kanalga aʼzolikni tekshiradi, roʻyxatdan oʻtkazadi, testlarni "kalit" orqali qabul qiladi, natijalarni hisoblaydi va reyting koʻrsatadi.

**Kutubxonalar:** `node-telegram-bot-api` (telegraf emas) + `mongodb` (rasmiy MongoDB driver) + `dotenv`.

## 1. MongoDB Atlas sozlash

1. [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas) da bepul cluster yarating (allaqachon yaratgan boʻlsangiz, shu qadamni oʻtkazib yuboring).
2. **Database Access** boʻlimida foydalanuvchi parolini **almashtiring** (skrinshot/chatda koʻringan parolni ishlatmang — u koʻpchilikka maʼlum boʻlib qoldi deb hisoblang).
3. **Network Access** boʻlimida Render serverlari ulana olishi uchun `0.0.0.0/0` (Allow access from anywhere) qoʻshing — aks holda Render’dan ulanish bloklanadi.
4. **Connect → Drivers** boʻlimidan connection string’ni oling, u shunga oʻxshaydi:
   ```
   mongodb+srv://user:PAROL@cluster0.xxxxx.mongodb.net/?appName=Cluster0
   ```
5. Agar parolda maxsus belgilar boʻlsa (`@ : / # % &` va h.k.), ularni [URL-encode](https://www.urlencoder.org/) qiling, aks holda ulanish xato beradi.

## 2. Lokal ishga tushirish

```bash
git clone <sizning-repo-url>
cd nazoratchi-bot
npm install
cp .env.example .env
```

`.env` faylini oching va toʻldiring:

| Oʻzgaruvchi | Izoh |
|---|---|
| `BOT_TOKEN` | @BotFather dan olinadigan token |
| `MONGODB_URI` | Atlas’dan olingan connection string (yangi parol bilan) |
| `MONGODB_DB_NAME` | Baza nomi (istalgan, masalan `nazoratchi`) |
| `ADMIN_IDS` | Admin(lar) Telegram `user_id` lari, vergul bilan |
| `WEBHOOK_URL` | Boʻsh qoldirsangiz — polling. Toʻldirsangiz — webhook (Render uchun) |
| `PORT` | Webhook rejimida ishlatiladigan port |

**Majburiy kanallar** `index.js` faylining yuqori qismida, `CHANNELS` massivida yoziladi:
```js
const CHANNELS = [
  { id: '@talimtalaba', link: 'https://t.me/talimtalaba' },
  { id: '@Matematika_milliysertifikatim', link: 'https://t.me/Matematika_milliysertifikatim' },
];
```
Yangi kanal qoʻshish yoki oʻchirish uchun shu massivni tahrirlab, GitHub’ga qayta push qilsangiz yetarli — Render avtomatik qayta deploy qiladi. Environment Variables’da bu uchun hech narsa sozlash shart emas.

**Muhim:** bot **har bir** majburiy kanalga admin sifatida qoʻshilishi shart, aks holda aʼzolikni tekshira olmaydi (`getChatMember` metodi shu talab bilan ishlaydi). Foydalanuvchi faqat **barcha** kanallarga aʼzo boʻlgandagina davom eta oladi; aʼzo boʻlmagan kanallar roʻyxati unga alohida-alohida koʻrsatiladi.

### Kanallarni botni qayta deploy qilmasdan boshqarish (ixtiyoriy)
Kod faylini oʻzgartirmasdan ham, bot ishlab turgan holatda admin sifatida shu buyruqlarni yuborib kanal qoʻshishingiz/oʻchirishingiz mumkin:
```
/addchannel @yangi_kanal https://t.me/yangi_kanal
/removechannel @kanal_username
/listchannels
```
Shu buyruqlardan foydalansangiz, keyingi safar bot qayta ishga tushganda ham (Render qayta deploy qilsa ham) siz admin buyruq bilan qoʻshgan kanallar saqlanib qoladi — chunki ular MongoDB’da saqlanadi, kod emas.

Ishga tushirish:

```bash
npm start
```

Konsolda `✅ MongoDB'ga ulanish oʻrnatildi.` va `Bot polling rejimida ishga tushdi.` koʻrinsa — hammasi toʻgʻri ishlayapti.

## 3. Foydalanuvchi oqimi

1. `/start` → kanalga aʼzolik tekshiriladi
2. Aʼzo boʻlmasa → kanal linki yuboriladi
3. Aʼzo boʻlsa, birinchi marta boʻlsa → Ism-familiya, telefon (contact tugmasi) soʻraladi
4. Asosiy menyu: **📝 Vazifani yuborish**, **📊 Mening natijalarim**, **🏆 Reyting**
5. Test kodi kiritilib, javoblar `A*B*C*D*...` formatida yuboriladi, ball avtomatik hisoblanadi

Bitta test kodini qayta topshirish siyosati `index.js` faylidagi `RESUBMIT_POLICY` oʻzgaruvchisi orqali boshqariladi (standart: `BEST` — eng yaxshi natija saqlanadi; `LAST` yoki `FIRST` ga oʻzgartirish mumkin).

## 4. Admin buyruqlari

Faqat `.env` dagi `ADMIN_IDS` roʻyxatidagilar uchun ishlaydi:

```
/admin                                — buyruqlar roʻyxati
/addtest KOD|Nomi|JAVOBLAR            — test qoʻshish/tahrirlash
                                          masalan: /addtest TEST01|1-mavzu|A*B*C*D*A*B*C*D*A*B
/toggletest KOD                       — testni faol/nofaol qilish
/listtests                            — barcha testlar roʻyxati
/addchannel @kanal https://t.me/kanal — majburiy kanal qoʻshish
/removechannel @kanal                 — majburiy kanalni olib tashlash
/listchannels                         — barcha majburiy kanallar roʻyxati
/users                                — roʻyxatdan oʻtganlar soni va oxirgi 20 tasi
/export                               — barcha natijalarni CSV (Excelda ochiladi) qilib yuklab olish
/resetrating                          — reyting va barcha natijalarni tozalash
/broadcast Matn                       — barcha roʻyxatdan oʻtganlarga xabar yuborish
```

## 5. Github + Render orqali deploy qilish

### Github

```bash
git init
git add .
git commit -m "Nazoratchi bot"
git branch -M main
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```

`.env` fayli `.gitignore` da boʻlgani uchun repoga tushmaydi — token va MongoDB parol hech qachon GitHub’da ochiq koʻrinmaydi.

### Render (Background Worker — eng oddiy, polling rejimi)

MongoDB’dan foydalanilgani uchun maʼlumotlar bazasi endi Render’dan mustaqil — bot qayta ishga tushsa ham natijalar yoʻqolmaydi.

1. [render.com](https://render.com) da **New → Background Worker** tanlang
2. Github repongizni ulang
3. **Build Command:** `npm install`
4. **Start Command:** `npm start`
5. **Environment** boʻlimida quyidagilarni qoʻshing (`.env` faylni yuklamaysiz — har birini alohida kiritasiz):

   | Key | Value |
   |---|---|
   | `BOT_TOKEN` | BotFather bergan token |
   | `MONGODB_URI` | Atlas connection string |
   | `MONGODB_DB_NAME` | `nazoratchi` |
   | `CHANNEL_ID` | `@kanal_username` yoki `-100...` |
   | `CHANNEL_LINK` | `https://t.me/kanal_username` |
   | `ADMIN_IDS` | `987654321` |
   | `WEBHOOK_URL` | boʻsh qoldiring |

6. Deploy qiling

### Render (Web Service — webhook rejimi, ixtiyoriy)

Agar **Web Service** sifatida deploy qilmoqchi boʻlsangiz (Render bepul planida uxlab qolmasligi uchun ping kerak boʻladi):

1. **New → Web Service** tanlang, Build/Start buyruqlari yuqoridagidek
2. Environment’ga qoʻshimcha ravishda `WEBHOOK_URL` = Render bergan URL (masalan `https://nazoratchi-bot.onrender.com`)
3. Deploy qiling — bot avtomatik ravishda `setWebHook` qiladi

## 6. Baza tuzilishi (MongoDB collectionlari)

- `users` — roʻyxatdan oʻtganlar (`user_id`, `full_name`, `phone`, `registered_at`, `is_active`)
- `tests` — test kodlari va toʻgʻri javoblar kaliti (`test_code`, `title`, `answer_key`, `questions_count`, `is_active`)
- `submissions` — har bir topshirilgan test natijasi (`user_id`, `test_code`, `user_answers`, `correct_count`, `percentage`, `submitted_at`)
- `settings` — kanal ID/link kabi sozlamalar (`key`, `value`)

## 7. Eslatmalar

- Javob formati faqat `A/B/C/D` yoki `1/2/3/4`, `*` bilan ajratiladi — notoʻgʻri format aniq xato xabari bilan qaytariladi.
- Har safar "Vazifani yuborish" bosilganda aʼzolik qayta tekshiriladi.
- Reytingda faqat toʻliq (savollar soniga mos) topshirilgan natijalar hisobga olinadi, chunki notoʻgʻri sonli javoblar bazaga yozilmaydi.
- **Xavfsizlik:** `MONGODB_URI` ichidagi parolni hech qachon skrinshot, chat yoki koddagi ochiq matnda ulashmang — ulashib qoʻysangiz, Atlas’da parolni darhol almashtiring.
