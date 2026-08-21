// Telegram only allows a FIXED list of emojis for message reactions
// (not every emoji is allowed - only Telegram's official reaction list works)
const KEYWORD_REACTIONS = [
  { emoji: '🤣', patterns: [/\bha+ha+\b/i, /\blo+l\b/i, /😂/, /🤣/, /funny/i, /majaak/i] },
  { emoji: '❤', patterns: [/love/i, /pyaar/i, /pyar/i, /❤/, /😍/] },
  { emoji: '🔥', patterns: [/\bfire\b/i, /awesome/i, /zabardast/i, /badhiya/i, /🔥/] },
  { emoji: '😢', patterns: [/sad/i, /udaas/i, /rona/i, /😢/, /😭/] },
  { emoji: '🎉', patterns: [/congrat/i, /badhai/i, /party/i, /🎉/] },
  { emoji: '👍', patterns: [/thanks/i, /thank you/i, /shukriya/i, /nice/i] },
  { emoji: '😱', patterns: [/wow/i, /omg/i, /kya baat/i, /shocking/i] },
];

// Mood -> reaction emoji (only from Telegram's allowed reaction list)
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

// Looks at the content of the user's message and finds a matching reaction emoji (null if nothing matches)
function pickReactionForText(text) {
  if (!text) return null;
  for (const rule of KEYWORD_REACTIONS) {
    if (rule.patterns.some(p => p.test(text))) return rule.emoji;
  }
  return null;
}

// Calls the Telegram Bot API's setMessageReaction
async function reactToMessage(ctx, emoji) {
  if (!emoji) return;
  try {
    await ctx.telegram.callApi('setMessageReaction', {
      chat_id: ctx.chat.id,
      message_id: ctx.message.message_id,
      reaction: [{ type: 'emoji', emoji }],
    });
  } catch (err) {
    // A failed reaction isn't critical, don't block the chat flow.
    // REACTION_INVALID means that emoji isn't in Telegram's allowed list - skip silently.
    if (!err.message?.includes('REACTION_INVALID')) {
      console.error('Reaction error:', err.message);
    }
  }
}

module.exports = { pickReactionForText, reactToMessage, MOOD_TO_EMOJI };