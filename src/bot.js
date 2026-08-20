require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const { User, ChatHistory, GroupMessage, Sticker, Admin, Score, GroupMember } = require('./models');
const { getAIResponse, WAIFU_NAME, VALID_MOODS } = require('./ai');
const { pickReactionForText, reactToMessage, MOOD_TO_EMOJI } = require('./reactions');
const { getActiveBF, getActiveBFIdentity, setBFByAdmin } = require('./bf');
const { BF } = require('./models');
const { startScheduler } = require('./scheduler');
const { generateVoiceNote } = require('./voice');
const games = require('./games');
const ttt = require('./ttt');

// Prevents "message is not modified" error when two people double-click the same button
// or content is the same - prevents crashing
async function safeEditMessageText(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (!err.description?.includes('message is not modified')) throw err;
  }
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const DAILY_LIMIT = parseInt(process.env.DAILY_MSG_LIMIT || '50');
const PROMO_LINK = process.env.PROMO_LINK;
const PROMO_TEXT = process.env.PROMO_TEXT || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Group autonomous reply settings
const GROUP_AUTO_REPLY = (process.env.GROUP_AUTO_REPLY || 'true') === 'true';
const GROUP_AUTO_REPLY_CHANCE = parseFloat(process.env.GROUP_AUTO_REPLY_CHANCE || '0.06');
const GROUP_AUTO_REPLY_COOLDOWN = parseInt(process.env.GROUP_AUTO_REPLY_COOLDOWN || '180') * 1000;

// Voice message settings
const VOICE_ENABLED = (process.env.VOICE_ENABLED || 'false') === 'true';
const VOICE_REPLY_CHANCE = parseFloat(process.env.VOICE_REPLY_CHANCE || '0.15');

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

// Admin daily limit check is skipped
// Checks .env ADMIN_IDS (owner admins) + dynamically added admins from DB
async function isAdmin(ctx) {
  const userId = String(ctx.from.id);
  if (ADMIN_IDS.includes(userId)) return true;
  const found = await Admin.findOne({ telegramId: userId }).lean();
  return !!found;
}

// Only .env "owner" admins can add/remove new admins (top-level control)
function isOwnerAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

// Tracks group members - needed for /tagall
async function trackGroupMember(ctx) {
  try {
    await GroupMember.findOneAndUpdate(
      { chatId: String(ctx.chat.id), telegramId: String(ctx.from.id) },
      {
        username: ctx.from.username || '',
        firstName: ctx.from.first_name || 'User',
        lastSeen: new Date(),
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('trackGroupMember error:', err.message);
  }
}

// Adds score to a user in a chat (for games)
async function addScore(chatId, telegramId, name, field, points = 10) {
  try {
    await Score.findOneAndUpdate(
      { chatId: String(chatId), telegramId: String(telegramId) },
      { $inc: { [field]: 1, points }, $set: { name } },
      { upsert: true }
    );
  } catch (err) {
    console.error('addScore error:', err.message);
  }
}

// ---------- Decide: whether to reply in group and for what reason ----------
// Returns: { should: bool, reason: 'tagged' | 'name' | 'random' | null }
function decideGroupReply(ctx) {
  const botUsername = ctx.botInfo.username;
  const text = ctx.message.text || '';
  const chatId = String(ctx.chat.id);

  // 1. Direct tag or reply -> always respond
  if (text.includes(`@${botUsername}`)) return { should: true, reason: 'tagged' };
  if (ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) return { should: true, reason: 'tagged' };

  if (!GROUP_AUTO_REPLY) return { should: false, reason: null };

  const cooldownOk = Date.now() - (lastAutoReplyAt.get(chatId) || 0) > GROUP_AUTO_REPLY_COOLDOWN;
  if (!cooldownOk) return { should: false, reason: null };

  // 2. Hear their name (without @) -> higher chance to jump in
  const nameRegex = new RegExp(`\\b${WAIFU_NAME}\\b`, 'i');
  if (nameRegex.test(text)) {
    return { should: Math.random() < 0.7, reason: 'name' };
  }

  // 3. Otherwise small random chance (to behave like a real group member)
  // Skip very short/generic messages (like "ok", "yes") to avoid waste
  if (text.trim().length < 8) return { should: false, reason: null };

  return { should: Math.random() < GROUP_AUTO_REPLY_CHANCE, reason: 'random' };
}

// ---------- /start command ----------
bot.start(async ctx => {
  await getOrCreateUser(ctx);
  await ctx.reply(
    `Hi! I'm ${WAIFU_NAME} 🌸\n\nFeel free to chat with me in DMs, tag me in groups, or just say my name — I'm always listening 👀\n\nSo tell me, how's your day going?`
  );
});

// ---------- /help command ----------
bot.help(async ctx => {
  await ctx.reply(
    `📖 How to use me:\n\n• Send me a direct message in DM\n• Tag @${ctx.botInfo.username} in groups, say my name, or reply to my message\n• Sometimes I jump into conversations on my own 😄\n• ${DAILY_LIMIT} free messages per day\n\n/reset - forget our chat history\n/mood - check my current mood\n/becomebf - get special BF status for 24h\n/nickname <name> - (BF only) set your pet name\n/voice <text> - hear me say it as a voice message\n\n🎮 Games:\n/games - view all games menu\n/truthordare - play Truth or Dare\n/wyr - Would You Rather\n/love <name1> and <name2> - Compatibility calculator\n/quiz - Trivia quiz\n/ttt - Tic-Tac-Toe (2 players)\n/leaderboard - top scorers in this group\n\n👑 Admin:\n/tagall <message> - mention everyone\n/broadcast <message> - (owner only) send to all groups+DMs`
  );
});

// ---------- /reset command ----------
bot.command('reset', async ctx => {
  const telegramId = String(ctx.from.id);
  await ChatHistory.deleteMany({ telegramId });
  await ctx.reply(`Okay, I've forgotten everything 🌸 Let's start fresh!`);
});

// ---------- /setbf <telegram_id> [paid] (admin only) - BF status for 24h ----------
// Also works via reply. Adding "paid" at the end logs it as a payment source.
bot.command('setbf', async ctx => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply('This command can only be used by admins 🙅‍♀️');
  }

  const parts = ctx.message.text.split(' ').slice(1).map(s => s.trim());
  let targetId = parts[0] || '';
  const isPaid = parts.includes('paid');
  let targetName = '';

  if ((!targetId || targetId === 'paid') && ctx.message.reply_to_message) {
    targetId = String(ctx.message.reply_to_message.from.id);
    targetName = ctx.message.reply_to_message.from.first_name || '';
  }
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.reply('Reply to someone with /setbf (or /setbf paid for UPI payments), or use /setbf 123456789 [paid]');
  }

  // If name wasn't obtained from reply (manual ID), try to fetch from Telegram
  if (!targetName) {
    try {
      const chatInfo = await ctx.telegram.getChat(targetId);
      targetName = chatInfo.first_name || '';
    } catch (err) {
      // If fetch fails, name stays blank
    }
  }

  await setBFByAdmin(targetId, isPaid ? 'payment' : 'admin', targetName);
  await ctx.reply(`💕 ID ${targetId}${targetName ? ` (${targetName})` : ''} is now BF for the next 24 hours!${isPaid ? ' (paid ✅)' : ''}`);
});

// ---------- /becomebf - guides users to DM admin, who manually verifies and activates ----------
bot.command('becomebf', async ctx => {
  const adminUsername = process.env.ADMIN_CONTACT_USERNAME;

  if (!adminUsername) {
    return ctx.reply('This feature isn\'t available right now, ask the admin to use /setbf 🙈');
  }

  await ctx.reply(
    `💕 Want BF status for 24 hours?\n\n` +
      `DM @${adminUsername} with your Telegram ID (${ctx.from.id}), and they'll guide you on how to activate it 🥰`
  );
});

// ---------- /removebf <telegram_id> (admin only) - remove BF status early ----------
bot.command('removebf', async ctx => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply('This command can only be used by admins 🙅‍♀️');
  }

  let targetId = (ctx.message.text.split(' ')[1] || '').trim();
  if (!targetId && ctx.message.reply_to_message) {
    targetId = String(ctx.message.reply_to_message.from.id);
  }
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.reply('Reply to someone with /removebf, or use /removebf 123456789');
  }

  const result = await BF.deleteOne({ telegramId: targetId });
  if (result.deletedCount) {
    await ctx.reply(`💔 Removed BF status for ID ${targetId}.`);
  } else {
    await ctx.reply('This user is not currently a BF.');
  }
});

// ---------- /voice <text> - anyone can hear any text in Mimi's voice ----------
bot.command('voice', async ctx => {
  if (!isOwnerAdmin(ctx)) {
    return ctx.reply('This command is restricted to bot owner only 🙅‍♀️');
  }

  if (!VOICE_ENABLED) {
    return ctx.reply('Voice feature is currently off');
  }
  const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!text) return ctx.reply('Give me some text too: /voice hi how are you');

  try {
    await ctx.sendChatAction('record_voice');
    const voiceBuffer = await generateVoiceNote(text);
    await ctx.replyWithVoice({ source: voiceBuffer });
  } catch (err) {
    console.error('Voice command error:', err.message);
    await ctx.reply('Something went wrong creating the voice note 🥺 try again in a bit');
  }
});

// ============ GAMES ============

// ---------- /broadcast <message> (owner only) - sends to all groups + DMs ----------
bot.command('broadcast', async ctx => {
  if (!isOwnerAdmin(ctx)) {
    return ctx.reply('This command can only be used by the owner 👑');
  }

  const message = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!message) return ctx.reply('Write a message too: /broadcast Hello everyone! 📢');

  await ctx.reply('📢 Sending broadcast, this might take a moment...');

  // All known groups (from GroupMember) + all known DM users (from User collection) - combine to unique list
  const groupChatIds = await GroupMember.distinct('chatId');
  const userIds = await User.distinct('telegramId');
  const allTargets = [...new Set([...groupChatIds, ...userIds])];

  let success = 0;
  let failed = 0;

  for (const chatId of allTargets) {
    try {
      await bot.telegram.sendMessage(chatId, message);
      success++;
    } catch (err) {
      failed++; // bot blocked, chat deleted, or user never started DM - skip
    }
    await new Promise(resolve => setTimeout(resolve, 50)); // Avoid Telegram rate-limit
  }

  await ctx.reply(`✅ Broadcast complete!\n\nSent: ${success}\nFailed: ${failed}`);
});

// ---------- /tagall - mention all known group members (admin only, spam-protection) ----------
bot.command('tagall', async ctx => {
  const isGroup = ['group', 'supergroup'].includes(ctx.chat.type);
  if (!isGroup) return ctx.reply('This command only works in groups.');

  if (!(await isAdmin(ctx))) {
    return ctx.reply('This command can only be used by admins 🙅‍♀️ (to prevent spam)');
  }

  const chatId = String(ctx.chat.id);
  const members = await GroupMember.find({ chatId }).lean();

  if (!members.length) {
    return ctx.reply('No members tracked yet. They\'ll appear here once they send messages.');
  }

  const customMsg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const header = customMsg ? `📢 ${customMsg}\n\n` : '📢 Mentioning everyone:\n\n';

  // Send in batches to avoid Telegram message limits (10 mentions per message)
  const BATCH_SIZE = 10;
  for (let i = 0; i < members.length; i += BATCH_SIZE) {
    const batch = members.slice(i, i + BATCH_SIZE);
    const mentions = batch
      .map(m => `[${m.firstName || 'User'}](tg://user?id=${m.telegramId})`)
      .join(' ');
    await ctx.reply(i === 0 ? header + mentions : mentions, { parse_mode: 'Markdown' });
  }
});


bot.command('leaderboard', async ctx => {
  const chatId = String(ctx.chat.id);
  const top = await Score.find({ chatId }).sort({ points: -1 }).limit(10).lean();

  if (!top.length) {
    return ctx.reply('No scores yet! Play some games: /games 🎮');
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map((s, i) => {
    const medal = medals[i] || `${i + 1}.`;
    return `${medal} ${s.name} - ${s.points} pts (Quiz: ${s.quizWins}, TTT: ${s.tttWins})`;
  });

  await ctx.reply(`🏆 Leaderboard:\n\n${lines.join('\n')}`);
});

// ---------- /games - all games in one place, launch with buttons ----------
bot.command('games', async ctx => {
  await ctx.reply('🎮 Games Menu - what would you like to play?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🤔🔥 Truth or Dare', callback_data: 'menu:truthordare' }],
        [{ text: '🆚 Would You Rather', callback_data: 'menu:wyr' }],
        [{ text: '💘 Love Calculator', callback_data: 'menu:love' }],
        [{ text: '❓ Quiz', callback_data: 'menu:quiz' }],
        [{ text: '❌⭕ Tic-Tac-Toe', callback_data: 'menu:ttt' }],
      ],
    },
  });
});

bot.action(/^menu:(.+)$/, async ctx => {
  const game = ctx.match[1];
  await ctx.answerCbQuery();

  if (game === 'love') {
    return ctx.reply('💘 Use: /love name1 and name2\n\nExample: /love Yash and Priya');
  }

  if (game === 'truthordare') {
    return ctx.reply('Truth or Dare? 😏', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🤔 Truth', callback_data: 'tod:truth' },
          { text: '🔥 Dare', callback_data: 'tod:dare' },
        ]],
      },
    });
  }

  if (game === 'wyr') {
    const q = games.getRandomWYR();
    return ctx.reply('🆚 Would You Rather...', {
      reply_markup: {
        inline_keyboard: [
          [{ text: `A) ${q.a}`, callback_data: 'wyr:a' }],
          [{ text: `B) ${q.b}`, callback_data: 'wyr:b' }],
        ],
      },
    });
  }

  if (game === 'quiz') {
    const q = games.getRandomQuiz();
    const buttons = q.options.map((opt, i) => [{ text: opt, callback_data: `quiz:${i}:${q.correct}` }]);
    return ctx.reply(`❓ ${q.q}`, { reply_markup: { inline_keyboard: buttons } });
  }

  if (game === 'ttt') {
    const chatId = ctx.chat.id;
    if (ttt.getGame(chatId)) {
      return ctx.reply('A game is already running in this chat! Finish it first.');
    }
    ttt.startGame(chatId, ctx.from.id, ctx.from.first_name || 'Player 1');
    return ctx.reply(
      `❌⭕ Tic-Tac-Toe started! ${ctx.from.first_name} has challenged you.\n\nAnother player should click "Join Game"!`,
      { reply_markup: { inline_keyboard: [[{ text: '🎮 Join Game', callback_data: `ttt_join:${chatId}` }]] } }
    );
  }
});

// ---------- /truth - random truth question ----------
bot.command('truth', async ctx => {
  await ctx.reply(`🤔 Truth: ${games.getRandomTruth()}`);
});

// ---------- /dare - random dare ----------
bot.command('dare', async ctx => {
  await ctx.reply(`🔥 Dare: ${games.getRandomDare()}`);
});

// ---------- /truthordare - choose with buttons ----------
bot.command('truthordare', async ctx => {
  await ctx.reply('Truth or Dare? 😏', {
    reply_markup: {
      inline_keyboard: [[
        { text: '🤔 Truth', callback_data: 'tod:truth' },
        { text: '🔥 Dare', callback_data: 'tod:dare' },
      ]],
    },
  });
});

bot.action(/^tod:(truth|dare)$/, async ctx => {
  const type = ctx.match[1];
  const result = type === 'truth' ? games.getRandomTruth() : games.getRandomDare();
  const emoji = type === 'truth' ? '🤔' : '🔥';
  await safeEditMessageText(ctx, `${emoji} ${type === 'truth' ? 'Truth' : 'Dare'}: ${result}`);
  await ctx.answerCbQuery();
});

// ---------- /wyr - Would You Rather ----------
bot.command('wyr', async ctx => {
  const q = games.getRandomWYR();
  await ctx.reply(`🆚 Would You Rather...`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: `A) ${q.a}`, callback_data: 'wyr:a' }],
        [{ text: `B) ${q.b}`, callback_data: 'wyr:b' }],
      ],
    },
  });
});

bot.action(/^wyr:(a|b)$/, async ctx => {
  const choice = ctx.match[1].toUpperCase();
  await ctx.answerCbQuery(`You chose ${choice}! 😄`);
  await ctx.reply(`Nice choice! ${choice === 'A' ? '🅰️' : '🅱️'} Want to play again? /wyr`);
});

// ---------- /love <name1> <name2> - Compatibility Calculator ----------
bot.command('love', async ctx => {
  const parts = ctx.message.text.split(' ').slice(1).join(' ').split(/\s+and\s+|\s*&\s*|\s*,\s*/i);
  let name1 = (parts[0] || '').trim();
  let name2 = (parts[1] || '').trim();

  if (!name1 || !name2) {
    return ctx.reply('Give me two names: /love Yash and Priya');
  }

  const { percent, message } = games.calculateLoveCompatibility(name1, name2);
  const bar = '💗'.repeat(Math.round(percent / 10)) + '🖤'.repeat(10 - Math.round(percent / 10));

  await ctx.reply(`💘 ${name1} + ${name2}\n\n${bar}\n${percent}% match!\n\n${message}`);
});

// ---------- /quiz - relationship/general trivia ----------
bot.command('quiz', async ctx => {
  const q = games.getRandomQuiz();
  const buttons = q.options.map((opt, i) => [
    { text: opt, callback_data: `quiz:${i}:${q.correct}` },
  ]);
  await ctx.reply(`❓ ${q.q}`, { reply_markup: { inline_keyboard: buttons } });
});

bot.action(/^quiz:(\d):(\d)$/, async ctx => {
  const chosen = parseInt(ctx.match[1]);
  const correct = parseInt(ctx.match[2]);
  if (chosen === correct) {
    await ctx.answerCbQuery('✅ Correct!');
    await safeEditMessageText(ctx, `✅ That was correct! You're so smart 🧠\nWant to play again? /quiz`);
    await addScore(ctx.chat.id, ctx.from.id, ctx.from.first_name || 'Player', 'quizWins', 10);
  } else {
    await ctx.answerCbQuery('❌ Wrong!');
    await safeEditMessageText(ctx, `❌ That was wrong, no worries! Try again with /quiz`);
  }
});

// ---------- /ttt - Tic-Tac-Toe (2 player, best in groups) ----------
bot.command('ttt', async ctx => {
  const chatId = ctx.chat.id;
  const existing = ttt.getGame(chatId);
  if (existing) {
    return ctx.reply('A game is already running in this chat! Finish it first.');
  }

  ttt.startGame(chatId, ctx.from.id, ctx.from.first_name || 'Player 1');
  await ctx.reply(
    `❌⭕ Tic-Tac-Toe started! ${ctx.from.first_name} has challenged you.\n\nAnother player should click "Join Game"!`,
    { reply_markup: { inline_keyboard: [[{ text: '🎮 Join Game', callback_data: `ttt_join:${chatId}` }]] } }
  );
});

bot.action(/^ttt_join:(-?\d+)$/, async ctx => {
  const chatId = ctx.match[1];
  const game = ttt.joinGame(chatId, ctx.from.id, ctx.from.first_name || 'Player 2');
  if (!game) {
    return ctx.answerCbQuery('Cannot join this game (already full or it\'s your own game)', { show_alert: true });
  }

  await ctx.answerCbQuery('Joined the game!');
  const p1Name = game.names[game.players[0]];
  const p2Name = game.names[game.players[1]];
  await safeEditMessageText(ctx, 
    `❌ ${p1Name} vs ⭕ ${p2Name}\n\nIt's ${p1Name}'s turn (❌)`,
    { reply_markup: ttt.buildKeyboard(chatId, game.board) }
  );
});

bot.action(/^ttt:(-?\d+):(\d)$/, async ctx => {
  const chatId = ctx.match[1];
  const cellIndex = parseInt(ctx.match[2]);
  const result = ttt.makeMove(chatId, ctx.from.id, cellIndex);

  if (!result.success) {
    const messages = {
      no_game: 'This game has already ended.',
      waiting_for_player: 'Waiting for the second player!',
      not_your_turn: 'It\'s not your turn!',
      cell_taken: 'This cell is already filled!',
    };
    return ctx.answerCbQuery(messages[result.reason] || 'Invalid move', { show_alert: true });
  }

  await ctx.answerCbQuery();

  const { winner, board, game } = result;
  const p1Name = game?.names?.[game.players[0]] || 'Player 1';
  const p2Name = game?.names?.[game.players[1]] || 'Player 2';

  if (winner === 'draw') {
    await safeEditMessageText(ctx, `🤝 Match drawn! Well played both.`, {
      reply_markup: ttt.buildKeyboard(chatId, board),
    });
  } else if (winner) {
    const winnerId = winner === 'X' ? game.players[0] : game.players[1];
    const winnerName = winner === 'X' ? p1Name : p2Name;
    await safeEditMessageText(ctx, `🎉 ${winnerName} (${winner === 'X' ? '❌' : '⭕'}) wins!`, {
      reply_markup: ttt.buildKeyboard(chatId, board),
    });
    await addScore(chatId, winnerId, winnerName, 'tttWins', 15);
  } else {
    const currentGame = ttt.getGame(chatId);
    const turnName = currentGame.names[currentGame.turn];
    const turnSymbol = currentGame.turn === currentGame.players[0] ? '❌' : '⭕';
    await safeEditMessageText(ctx, `❌ ${p1Name} vs ⭕ ${p2Name}\n\nIt's ${turnName}'s turn (${turnSymbol})`, {
      reply_markup: ttt.buildKeyboard(chatId, board),
    });
  }
});

// ---------- /nickname <name> - only active BF can set their pet name ----------
bot.command('nickname', async ctx => {
  const telegramId = String(ctx.from.id);
  const bf = await getActiveBF(telegramId);
  if (!bf) return ctx.reply('This feature is only for my BF 🙈 Become a BF first!');

  const nickname = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!nickname) return ctx.reply('Give me a nickname too: /nickname cutie');

  await BF.updateOne({ telegramId }, { nickname });
  await ctx.reply(`Okay ${nickname}! I'll call you that from now on 🥰`);
});

// ---------- /mood - bot tells its current mood ----------
const MOOD_LINES = [
  { mood: 'happy', text: '😁 I\'m in a great mood right now, let\'s have some fun!' },
  { mood: 'love', text: '🥰 Feeling a bit romantic today, was thinking of you' },
  { mood: 'laugh', text: '😂 In a playful mood, tell me a joke!' },
  { mood: 'sad', text: '🥺 Feeling a little low, talk to me' },
  { mood: 'shy', text: '🥰 Feeling shy today for some reason' },
  { mood: 'neutral', text: '😌 Chill mood, just waiting for your messages' },
];
bot.command('mood', async ctx => {
  const pick = MOOD_LINES[Math.floor(Math.random() * MOOD_LINES.length)];
  await ctx.reply(pick.text);
});

// ---------- /addadmin <telegram_id> (owner only) ----------
bot.command('addadmin', async ctx => {
  if (!isOwnerAdmin(ctx)) {
    return ctx.reply('This command can only be used by the owner 👑');
  }

  const targetId = (ctx.message.text.split(' ')[1] || '').trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.reply('Give a valid ID: /addadmin 123456789\n\nTo find their ID, ask the user to check with @userinfobot.');
  }

  const already = ADMIN_IDS.includes(targetId) || (await Admin.findOne({ telegramId: targetId }));
  if (already) return ctx.reply('This user is already an admin.');

  await Admin.create({ telegramId: targetId, addedBy: String(ctx.from.id) });
  await ctx.reply(`✅ Made ID ${targetId} an admin!`);
});

// ---------- /removeadmin <telegram_id> (owner only) ----------
bot.command('removeadmin', async ctx => {
  if (!isOwnerAdmin(ctx)) {
    return ctx.reply('This command can only be used by the owner 👑');
  }

  const targetId = (ctx.message.text.split(' ')[1] || '').trim();
  if (!targetId) return ctx.reply('Give a valid ID: /removeadmin 123456789');

  if (ADMIN_IDS.includes(targetId)) {
    return ctx.reply('This is an owner admin (set in .env), cannot be removed via bot - you\'ll need to remove from .env.');
  }

  const result = await Admin.deleteOne({ telegramId: targetId });
  if (result.deletedCount) {
    await ctx.reply(`✅ Removed ID ${targetId} from admin list.`);
  } else {
    await ctx.reply('Not found in admin list.');
  }
});

// ---------- /listadmins ----------
bot.command('listadmins', async ctx => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply('This command can only be used by admins 🙅‍♀️');
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
    return ctx.reply('This command can only be used by admins 🙅‍♀️');
  }

  const replied = ctx.message.reply_to_message;
  if (!replied || !replied.sticker) {
    return ctx.reply('Reply to a sticker with: /addsticker happy\n\nMoods: ' + VALID_MOODS.join(', '));
  }

  const mood = (ctx.message.text.split(' ')[1] || '').toLowerCase();
  if (!VALID_MOODS.includes(mood)) {
    return ctx.reply('Valid moods: ' + VALID_MOODS.join(', '));
  }

  await Sticker.create({ mood, fileId: replied.sticker.file_id, addedBy: String(ctx.from.id) });
  await ctx.reply(`✅ Sticker saved under "${mood}" category!`);
});

// ---------- /stickers (list counts) ----------
bot.command('stickers', async ctx => {
  const counts = await Sticker.aggregate([{ $group: { _id: '$mood', count: { $sum: 1 } } }]);
  if (!counts.length) return ctx.reply('No stickers saved yet.');
  const lines = counts.map(c => `${c._id}: ${c.count}`).join('\n');
  await ctx.reply(`🎀 Saved stickers:\n${lines}`);
});

// ---------- Helper: send random sticker based on mood ----------
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

// ---------- React to sticker messages too ----------
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

      // Save every group message to buffer, whether bot replies or not (for context)
      await GroupMessage.create({
        chatId,
        username: ctx.from.first_name || ctx.from.username || 'Someone',
        content: rawText,
      });

      // Track member for /tagall (in background, doesn't block)
      trackGroupMember(ctx);

      const decision = decideGroupReply(ctx);
      if (!decision.should) return;
      groupReplyReason = decision.reason;
    }

    const user = await getOrCreateUser(ctx);

    if (user.messageCount >= DAILY_LIMIT && !(await isAdmin(ctx))) {
      await ctx.reply(
        `We've hit our ${DAILY_LIMIT} messages for today 🥺 Let's talk again tomorrow, promise!` +
          (PROMO_LINK ? `\n\n${PROMO_TEXT}\n${PROMO_LINK}` : '')
      );
      return;
    }

    let userText = ctx.message.text.replace(`@${ctx.botInfo.username}`, '').trim();

    const quickReaction = pickReactionForText(userText);
    if (quickReaction) await reactToMessage(ctx, quickReaction);

    // If bot doesn't have permission to write in this chat (kicked/muted/restricted),
    // stop here immediately - don't waste AI call if we can't reply
    try {
      await ctx.sendChatAction('typing');
    } catch (err) {
      if (err.description?.includes('CHAT_WRITE_FORBIDDEN') || err.response?.description?.includes('CHAT_WRITE_FORBIDDEN')) {
        return; // Silently skip - bot is blocked in this chat/group
      }
      throw err;
    }

    // For autonomous group replies, use recent group chat context;
    // for DM or direct tags, use per-user chat history
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

    const ownerContext = {
      isOwner: ADMIN_IDS.includes(user.telegramId),
      ownerName: process.env.OWNER_NAME || '',
    };
    // Bot should always know its active BF identity, regardless of who's typing -
    // this prevents someone from "using BF's name" to make the bot say bad things about them
    const bfIdentity = await getActiveBFIdentity();
    const { text: aiReply, mood } = await getAIResponse(
      history,
      userText,
      await getActiveBF(user.telegramId),
      ownerContext,
      bfIdentity
    );

    // Sometimes send the entire reply as a voice message (instead of text, like a real person)
    const sendAsVoice = VOICE_ENABLED && Math.random() < VOICE_REPLY_CHANCE;
    let voiceSent = false;

    if (sendAsVoice) {
      try {
        await ctx.sendChatAction('record_voice');
        const voiceBuffer = await generateVoiceNote(aiReply);
        await ctx.replyWithVoice(
          { source: voiceBuffer },
          { reply_to_message_id: isGroup ? ctx.message.message_id : undefined }
        );
        voiceSent = true;
      } catch (err) {
        console.error('Voice reply error:', err.message);
        // If voice fails, fallback to text below
      }
    }

    if (!voiceSent) {
      await ctx.reply(aiReply, { reply_to_message_id: isGroup ? ctx.message.message_id : undefined });
    }

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

    // Daily streak update
    const today = new Date().toISOString().split('T')[0];
    if (user.lastStreakDate !== today) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      user.streakCount = user.lastStreakDate === yesterday ? user.streakCount + 1 : 1;
      user.lastStreakDate = today;

      // Mention streak milestones every 7 days
      if (user.streakCount > 0 && user.streakCount % 7 === 0) {
        await ctx.reply(`🔥 Wow! You've been talking to me for ${user.streakCount} days straight, I'm proud of you!`);
      }
    }

    await user.save();

    if (PROMO_LINK && user.totalMessages % 15 === 0) {
      await ctx.reply(`✨ ${PROMO_TEXT}\n${PROMO_LINK}`);
    }
  } catch (err) {
    if (err.description?.includes('CHAT_WRITE_FORBIDDEN') || err.response?.description?.includes('CHAT_WRITE_FORBIDDEN')) {
      // Bot doesn't have permission to write in this chat (kicked/muted) - don't spam console
      return;
    }
    console.error('Message handler error:', err);
  }
});

// ---------- Launch ----------
bot.launch().then(() => {
  console.log(`🌸 ${WAIFU_NAME} bot is live!`);
  startScheduler(bot);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));