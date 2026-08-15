// Telegram sirf ek FIXED list of emojis allow karta hai message reactions ke liye
// (harek emoji allowed nahi hai - sirf Telegram ki official reaction list use kar sakte hain)
const KEYWORD_REACTIONS = [
  { emoji: '🤣', patterns: [/\bha+ha+\b/i, /\blo+l\b/i, /😂/, /🤣/, /funny/i, /majaak/i] },
  { emoji: '❤', patterns: [/love/i, /pyaar/i, /pyar/i, /❤/, /😍/] },
  { emoji: '🔥', patterns: [/\bfire\b/i, /awesome/i, /zabardast/i, /badhiya/i, /🔥/] },
  { emoji: '😢', patterns: [/sad/i, /udaas/i, /rona/i, /😢/, /😭/] },
  { emoji: '🎉', patterns: [/congrat/i, /badhai/i, /party/i, /🎉/] },
  { emoji: '👍', patterns: [/thanks/i, /thank you/i, /shukriya/i, /nice/i] },
  { emoji: '😱', patterns: [/wow/i, /omg/i, /kya baat/i, /shocking/i] },
];

// Mood -> reaction emoji (sirf Telegram ki allowed reaction list mein se)
const MOOD_TO_EMOJI = {
  happy: '😁',
  love: '❤',
  laugh: '🤣',
  sad: '😢',
  shy: '🥰',
  angry: '😡',
  surprised: '😱',
  neutral: '👍',
};

// User ke message ka content dekh ke koi matching reaction emoji dhundta hai (null agar kuch match na ho)
function pickReactionForText(text) {
  if (!text) return null;
  for (const rule of KEYWORD_REACTIONS) {
    if (rule.patterns.some(p => p.test(text))) return rule.emoji;
  }
  return null;
}

// Telegram Bot API ka setMessageReaction call karta hai
async function reactToMessage(ctx, emoji) {
  if (!emoji) return;
  try {
    await ctx.telegram.callApi('setMessageReaction', {
      chat_id: ctx.chat.id,
      message_id: ctx.message.message_id,
      reaction: [{ type: 'emoji', emoji }],
    });
  } catch (err) {
    // Reactions fail hona critical nahi hai, chat flow ko block nahi karna.
    // REACTION_INVALID ka matlab wo emoji Telegram ki allowed list mein nahi hai - silently skip.
    if (!err.message?.includes('REACTION_INVALID')) {
      console.error('Reaction error:', err.message);
    }
  }
}

module.exports = { pickReactionForText, reactToMessage, MOOD_TO_EMOJI };