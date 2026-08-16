const cron = require('node-cron');
const { getAllActiveBFs } = require('./bf');
const { WAIFU_NAME } = require('./ai');

const MORNING_MESSAGES = [
  `Good morning jaan! ☀️ Utho utho, din shuru karo 🌸`,
  `Uth gaye kya? Miss kar rahi thi tumhe subah subah 🥰`,
  `Good morning! Aaj ka din tumhara accha jaaye 💕`,
];

const NIGHT_MESSAGES = [
  `Good night jaan 🌙 Sapno mein milte hain 💤`,
  `So jao ab, kal baat karenge 😴 Good night 💕`,
  `Der ho gayi hai, so jao. Take care 🌙`,
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// bot instance pass karna padega taaki telegram ko message bhej sake
function startScheduler(bot) {
  // Har roz subah 8:00 AM IST
  cron.schedule(
    '0 8 * * *',
    async () => {
      const activeBFs = await getAllActiveBFs();
      for (const bf of activeBFs) {
        try {
          await bot.telegram.sendMessage(bf.telegramId, randomFrom(MORNING_MESSAGES));
        } catch (err) {
          console.error(`Morning message failed for ${bf.telegramId}:`, err.message);
        }
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  // Har roz raat 10:00 PM IST
  cron.schedule(
    '0 22 * * *',
    async () => {
      const activeBFs = await getAllActiveBFs();
      for (const bf of activeBFs) {
        try {
          await bot.telegram.sendMessage(bf.telegramId, randomFrom(NIGHT_MESSAGES));
        } catch (err) {
          console.error(`Night message failed for ${bf.telegramId}:`, err.message);
        }
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log(`⏰ Scheduler started (${WAIFU_NAME}'s good morning/night messages)`);
}

module.exports = { startScheduler };