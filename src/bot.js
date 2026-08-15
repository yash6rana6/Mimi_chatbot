require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const { User, ChatHistory, GroupMessage, Sticker, Admin } = require('./models');
const { getAIResponse, WAIFU_NAME, VALID_MOODS } = require('./ai');
const { pickReactionForText, reactToMessage, MOOD_TO_EMOJI } = require('./reactions');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const DAILY_LIMIT = parseInt(process.env.DAILY_MSG_LIMIT || '50');
const PROMO_LINK = process.env.PROMO_LINK;
const PROMO_TEXT = process.env.PROMO_TEXT || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Group autonomous reply settings
const GROUP_AUTO_REPLY = (process.env.GROUP_AUTO_REPLY || 'true') === 'true';
const GROUP_AUTO_REPLY_CHANCE = parseFloat(process.env.GROUP_AUTO_REPLY_CHANCE || '0.06');
const GROUP_AUTO_REPLY_COOLDOWN = parseInt(process.env.GROUP_AUTO_REPLY_COOLDOWN || '180') * 1000;

// In-memory cooldown tracker per group (chatId -> last autonomous reply timestamp)
const lastAutoReplyAt = new Map();

// ---------- MongoDB Connect ----------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ---------- Helper: get or create user, handle daily reset ----------
async function getOrCreateUser(ctx) {
  const telegramId = String(ctx.from.id);
  const today = new Date().toISOString().split('T')[0];

  let user = await User.findOne({ telegramId });
  if (!user) {
    user = await User.create({
      telegramId,
      username: ctx.from.username || '',
      firstName: ctx.from.first_name || '',
    });
  }

  if (user.lastResetDate !== today) {
    user.messageCount = 0;
    user.lastResetDate = today;
  }

  return user;
}

// Admin ke liye daily limit check skip ho jata hai
// Check karta hai .env ke ADMIN_IDS (owner admins) + DB mein dynamically add kiye gaye admins
async function isAdmin(ctx) {
  const userId = String(ctx.from.id);
  if (ADMIN_IDS.includes(userId)) return true;
  const found = await Admin.findOne({ telegramId: userId }).lean();
  return !!found;
}

// ---------- Decide: group mein reply karna hai ya nahi, aur kis wajah se ----------
// Returns: { should: bool, reason: 'tagged' | 'name' | 'random' | null }
function decideGroupReply(ctx) {
  const botUsername = ctx.botInfo.username;
  const text = ctx.message.text || '';
  const chatId = String(ctx.chat.id);

  // 1. Direct tag ya reply -> hamesha respond karo
  if (text.includes(`@${botUsername}`)) return { should: true, reason: 'tagged' };
  if (ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) return { should: true, reason: 'tagged' };

  if (!GROUP_AUTO_REPLY) return { should: false, reason: null };

  const cooldownOk = Date.now() - (lastAutoReplyAt.get(chatId) || 0) > GROUP_AUTO_REPLY_COOLDOWN;
  if (!cooldownOk) return { should: false, reason: null };

  // 2. Apna naam sune (bina @) -> zyada chance se jump in karo
  const nameRegex = new RegExp(`\\b${WAIFU_NAME}\\b`, 'i');
  if (nameRegex.test(text)) {
    return { should: Math.random() < 0.7, reason: 'name' };
  }

  // 3. Warna chhota sa random chance (real group member jaisa behave karne ke liye)
  // Bohot chhote/generic messages (jaise "ok", "haan") pe skip karo, waste na ho
  if (text.trim().length < 8) return { should: false, reason: null };

  return { should: Math.random() < GROUP_AUTO_REPLY_CHANCE, reason: 'random' };
}

// ---------- /start command ----------
bot.start(async ctx => {
  await getOrCreateUser(ctx);
  await ctx.reply(
    `Hiii! Main ${WAIFU_NAME} hu 🌸\n\nDM mein bindaas baat karo, groups mein tag karo ya bas mera naam lo — main sun rahi hoti hu 👀\n\nChalo batao, kaisa chal raha hai din?`
  );
});

// ---------- /help command ----------
bot.help(async ctx => {
  await ctx.reply(
    `📖 Kaise use karu:\n\n• DM mein direct message karo\n• Group mein @${ctx.botInfo.username} tag karo, mera naam lo, ya mere message ko reply karo\n• Kabhi kabhi main khud se bhi baat mein kood jaati hu 😄\n• Daily ${DAILY_LIMIT} messages free hain\n\n/reset - purani chat bhula dungi (fresh start)`
  );
});

// ---------- /reset command ----------
bot.command('reset', async ctx => {
  const telegramId = String(ctx.from.id);
  await ChatHistory.deleteMany({ telegramId });
  await ctx.reply(`Theek hai, sab bhula diya 🌸 Fresh start karte hain!`);
});

// ---------- /addadmin <telegram_id> (admin only) ----------
bot.command('addadmin', async ctx => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply('Ye command sirf admin use kar sakta hai 🙅‍♀️');
  }

  const targetId = (ctx.message.text.split(' ')[1] || '').trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.reply('Sahi ID do: /addadmin 123456789\n\nID pata karne ke liye us user ko @userinfobot pe apna ID check karne bolo.');
  }

  const already = ADMIN_IDS.includes(targetId) || (await Admin.findOne({ telegramId: targetId }));
  if (already) return ctx.reply('Ye pehle se admin hai.');

  await Admin.create({ telegramId: targetId, addedBy: String(ctx.from.id) });
  await ctx.reply(`✅ ID ${targetId} ko admin bana diya!`);
});

// ---------- /removeadmin <telegram_id> (admin only) ----------
bot.command('removeadmin', async ctx => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply('Ye command sirf admin use kar sakta hai 🙅‍♀️');
  }

  const targetId = (ctx.message.text.split(' ')[1] || '').trim();
  if (!targetId) return ctx.reply('Sahi ID do: /removeadmin 123456789');

  if (ADMIN_IDS.includes(targetId)) {
    return ctx.reply('Ye owner admin hai (.env mein set hai), bot se remove nahi ho sakta - .env se hi hataana padega.');
  }

  const result = await Admin.deleteOne({ telegramId: targetId });
  if (result.deletedCount) {
    await ctx.reply(`✅ ID ${targetId} ko admin se hata diya.`);
  } else {
    await ctx.reply('Ye admin list mein nahi mila.');
  }
});

// ---------- /listadmins ----------
bot.command('listadmins', async ctx => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply('Ye command sirf admin use kar sakta hai 🙅‍♀️');
  }
  const dbAdmins = await Admin.find().lean();
  const lines = [
    ...ADMIN_IDS.map(id => `${id} (owner)`),
    ...dbAdmins.map(a => a.telegramId),
  ];
  await ctx.reply(`👑 Admins:\n${lines.join('\n')}`);
});

// ---------- /addsticker <mood> (admin only, reply to a sticker) ----------
bot.command('addsticker', async ctx => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply('Ye command sirf admin use kar sakta hai 🙅‍♀️');
  }

  const replied = ctx.message.reply_to_message;
  if (!replied || !replied.sticker) {
    return ctx.reply('Kisi sticker ko reply karke likho: /addsticker happy\n\nMoods: ' + VALID_MOODS.join(', '));
  }

  const mood = (ctx.message.text.split(' ')[1] || '').toLowerCase();
  if (!VALID_MOODS.includes(mood)) {
    return ctx.reply('Valid mood do: ' + VALID_MOODS.join(', '));
  }

  await Sticker.create({ mood, fileId: replied.sticker.file_id, addedBy: String(ctx.from.id) });
  await ctx.reply(`✅ Sticker "${mood}" category mein save ho gaya!`);
});

// ---------- /stickers (list counts) ----------
bot.command('stickers', async ctx => {
  const counts = await Sticker.aggregate([{ $group: { _id: '$mood', count: { $sum: 1 } } }]);
  if (!counts.length) return ctx.reply('Abhi koi sticker saved nahi hai.');
  const lines = counts.map(c => `${c._id}: ${c.count}`).join('\n');
  await ctx.reply(`🎀 Saved stickers:\n${lines}`);
});

// ---------- Helper: mood ke hisaab se random sticker bhejna ----------
async function maybeSendMoodSticker(ctx, mood) {
  if (Math.random() > 0.4) return;

  const stickers = await Sticker.aggregate([{ $match: { mood } }, { $sample: { size: 1 } }]);
  if (!stickers.length) return;

  try {
    await ctx.replyWithSticker(stickers[0].fileId);
  } catch (err) {
    console.error('Sticker send error:', err.message);
  }
}

// ---------- Sticker messages se bhi react ho jaye ----------
bot.on('sticker', async ctx => {
  const isGroup = ['group', 'supergroup'].includes(ctx.chat.type);
  if (isGroup) {
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.botInfo.id;
    if (!isReplyToBot) return;
  }
  await reactToMessage(ctx, '❤');
});

// ---------- Main text message handler ----------
bot.on('text', async ctx => {
  try {
    const isGroup = ['group', 'supergroup'].includes(ctx.chat.type);
    let groupReplyReason = null;

    if (isGroup) {
      const chatId = String(ctx.chat.id);
      const rawText = ctx.message.text || '';

      // Har group message ko buffer mein save karo, chahe bot reply kare ya na kare (context ke liye)
      await GroupMessage.create({
        chatId,
        username: ctx.from.first_name || ctx.from.username || 'Someone',
        content: rawText,
      });

      const decision = decideGroupReply(ctx);
      if (!decision.should) return;
      groupReplyReason = decision.reason;
    }

    const user = await getOrCreateUser(ctx);

    if (user.messageCount >= DAILY_LIMIT && !(await isAdmin(ctx))) {
      await ctx.reply(
        `Aaj ke liye ${DAILY_LIMIT} messages ho gaye hamare 🥺 Kal fir baat karenge, promise!` +
          (PROMO_LINK ? `\n\n${PROMO_TEXT}\n${PROMO_LINK}` : '')
      );
      return;
    }

    let userText = ctx.message.text.replace(`@${ctx.botInfo.username}`, '').trim();

    const quickReaction = pickReactionForText(userText);
    if (quickReaction) await reactToMessage(ctx, quickReaction);

    await ctx.sendChatAction('typing');

    // Group mein autonomous reply ke liye recent group chat context use karo,
    // warna (DM ya direct tag) per-user chat history use karo
    let history;
    if (isGroup && groupReplyReason !== 'tagged') {
      const recentGroupMsgs = await GroupMessage.find({ chatId: String(ctx.chat.id) })
        .sort({ createdAt: -1 })
        .limit(8)
        .lean();
      recentGroupMsgs.reverse();
      history = recentGroupMsgs.map(m => ({
        role: 'user',
        content: `${m.username}: ${m.content}`,
      }));
    } else {
      history = await ChatHistory.find({ telegramId: user.telegramId })
        .sort({ createdAt: -1 })
        .limit(6)
        .lean();
      history.reverse();
    }

    const { text: aiReply, mood } = await getAIResponse(history, userText);

    await ctx.reply(aiReply, { reply_to_message_id: isGroup ? ctx.message.message_id : undefined });

    if (isGroup) lastAutoReplyAt.set(String(ctx.chat.id), Date.now());

    if (!quickReaction) {
      await reactToMessage(ctx, MOOD_TO_EMOJI[mood]).catch(() => {});
    }

    await maybeSendMoodSticker(ctx, mood);

    await ChatHistory.create([
      { telegramId: user.telegramId, role: 'user', content: userText },
      { telegramId: user.telegramId, role: 'assistant', content: aiReply },
    ]);

    user.messageCount += 1;
    user.totalMessages += 1;
    await user.save();

    if (PROMO_LINK && user.totalMessages % 15 === 0) {
      await ctx.reply(`✨ ${PROMO_TEXT}\n${PROMO_LINK}`);
    }
  } catch (err) {
    console.error('Message handler error:', err);
  }
});

// ---------- Launch ----------
bot.launch().then(() => console.log(`🌸 ${WAIFU_NAME} bot is live!`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));