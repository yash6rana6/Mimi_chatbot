# AI Waifu Bot 🌸

AI companion Telegram bot — DM aur Group dono mein kaam karta hai, free OpenRouter models se powered.

## Features
- DM mein direct chat
- Groups mein sirf tag/reply pe respond karta hai (spam nahi karta)
- Daily message limit per user (free tier protect karne ke liye)
- Chat memory (last 6 messages context, 3 din tak store hote hain)
- `/reset` command — memory clear karne ke liye
- **Emoji reactions** — tera message padh ke keyword ya AI mood ke hisaab se react karta hai (❤️😂🔥😢 etc)
- **Mood-based stickers** — bot ke reply ke emotion ke hisaab se matching sticker bhej sakta hai
- `/addsticker <mood>` — admin sticker ko reply karke apni collection banayega
- `/stickers` — saved sticker categories dekhne ke liye
- Promo/ads system — har 15th message pe promotion bhejta hai

## Setup (5 minute mein ready)

### 1. Telegram Bot banao
- Telegram pe [@BotFather](https://t.me/BotFather) ko message karo
- `/newbot` bhejo, naam aur username do
- Jo token milega, wo copy kar lo

### 2. OpenRouter API key lo
- [openrouter.ai](https://openrouter.ai) pe free account banao
- API Keys section se key generate karo
- Model list mein se koi free model choose karo (default: `nvidia/nemotron-3-nano-omni:free`)

### 3. MongoDB Atlas free cluster banao
- [mongodb.com/atlas](https://mongodb.com/atlas) pe free account
- Cluster banao, connection string copy karo (Database > Connect > Drivers)

### 4. Install & Configure
```bash
npm install
cp .env.example .env
```
Ab `.env` file kholo aur apni values daal do:
- `TELEGRAM_BOT_TOKEN`
- `OPENROUTER_API_KEY`
- `MONGODB_URI`
- `WAIFU_NAME` (bot ka character naam)
- `ADMIN_IDS` (tera Telegram user ID — sticker add karne ke liye, @userinfobot se pata chalega)

### 5. Stickers add karo (optional but recommended)
1. Bot ko DM mein koi bhi sticker bhejo (ya group mein bhej ke bot ko reply karao)
2. Us sticker ko **reply** karke likho: `/addsticker happy`
3. Available moods: `happy, love, laugh, sad, shy, angry, surprised, neutral`
4. `/stickers` se check kar sakte ho kitne saved hain

Jitne zyada stickers har mood mein honge, utna natural lagega bot ka response.

### 6. Run karo
```bash
npm start
```

Bot live ho jayega! Telegram pe apne bot ko search karke `/start` bhejo.

## Group mein add karna
1. Bot ko group mein add karo
2. **Zaroori:** BotFather mein jaake `/setprivacy` command se bot ki privacy mode **disable** karo (warna bot group ke normal messages nahi padh payega, sirf mentions ke)
3. Group mein bot ko `@botusername` tag karke ya uske message ko reply karke baat karo

## Free hosting (Railway recommended)
1. GitHub pe is code ko push karo
2. [railway.app](https://railway.app) pe login karo (GitHub se)
3. "New Project" → "Deploy from GitHub repo"
4. Environment variables (.env wale) Railway ke dashboard mein add karo
5. Deploy — bot 24/7 free tier pe chalega (limited hours/month, upgrade kar sakte ho baad mein)

Alternative: Render.com (Background Worker service type use karna, web service nahi)

## Monetization (jaisa discuss kiya)
- `.env` mein `PROMO_LINK` aur `PROMO_TEXT` set karo — apna channel/sponsor link
- Har 15 messages pe automatically promo bhejta hai (bot.js mein `% 15` change kar sakte ho frequency ke liye)
- Jab userbase badhe, sponsors se paid promo slots bech sakte ho

## Important Notes
- Free OpenRouter models ki bhi rate limits hoti hain — agar bohot users aa gaye to `DAILY_MSG_LIMIT` kam karo ya paid model pe switch karo peak hours mein
- Bot ka personality `src/ai.js` ke `SYSTEM_PROMPT` mein hai — customize kar sakte ho
- Content SFW (safe for work) rakha gaya hai by design — Telegram ToS violation se bachne ke liye
