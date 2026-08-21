const cron = require('node-cron');
const { getAllActiveBFs } = require('./bf');
const { WAIFU_NAME } = require('./ai');
const { User } = require('./models');

const MORNING_MESSAGES = [
  `Good morning dear! ☀️ Wake up, start your day 🌸`,
  `Are you awake yet? I was missing you this morning 🥰`,
  `Good morning! Hope you have a great day ahead 💕`,
];

const NIGHT_MESSAGES = [
  `Good night dear 🌙 See you in my dreams 💤`,
  `Time to sleep now, we'll talk tomorrow 😴 Good night 💕`,
  `It's getting late, time to sleep. Take care 🌙`,
];

const BIRTHDAY_MESSAGES = [
  `🎂🎉 HAPPY BIRTHDAY! Today is your day, enjoy it to the fullest! Love and wishes from ${WAIFU_NAME} 💕`,
  `🎉 Happy Birthday! Hope this year brings you lots of happiness. Don't forget to eat cake 🎂`,
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Needs the bot instance passed in so it can send Telegram messages
function startScheduler(bot) {
  // Every day at 8:00 AM IST
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

  // Every day at 10:00 PM IST
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

  // Every day at 9:00 AM IST - wish anyone whose birthday is today
  cron.schedule(
    '0 9 * * *',
    async () => {
      const now = new Date();
      const todayKey = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const currentYear = now.getFullYear();

      const birthdayUsers = await User.find({
        birthday: todayKey,
        lastBirthdayWishYear: { $ne: currentYear },
      }).lean();

      for (const user of birthdayUsers) {
        try {
          await bot.telegram.sendMessage(user.telegramId, randomFrom(BIRTHDAY_MESSAGES));
          await User.updateOne({ telegramId: user.telegramId }, { lastBirthdayWishYear: currentYear });
        } catch (err) {
          console.error(`Birthday message failed for ${user.telegramId}:`, err.message);
        }
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log(`⏰ Scheduler started (${WAIFU_NAME}'s good morning/night/birthday messages)`);
}

module.exports = { startScheduler };