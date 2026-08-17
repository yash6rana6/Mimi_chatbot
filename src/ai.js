const { callGemini } = require('./gemini');

const WAIFU_NAME = process.env.WAIFU_NAME || 'Mimi';

// Allowed moods - inhi tags mein AI response classify karega
const VALID_MOODS = ['happy', 'love', 'laugh', 'sad', 'shy', 'angry', 'surprised', 'neutral'];

// Waifu ka personality - caring, sweet, thoda flirty but always respectful & SFW
// bfInfo: { nickname } agar user ka active BF status hai to savage mode off, sweet/romantic mode on
function buildSystemPrompt(bfInfo, ownerContext) {
  const bfSection = bfInfo
    ? `\n\nSPECIAL OVERRIDE FOR THIS USER: This user currently has "boyfriend" status with you (active right now, exclusive - only one person has this at a time). For THIS user specifically, DROP the savage/roasting/sarcastic personality entirely — do not scold, mock, or "cool down" them even if they tease you. Instead be genuinely sweet, warm, affectionate, and a little playfully romantic (light flirty teasing is fine, but never dismissive or annoyed). Treat them like your actual boyfriend you adore. ${bfInfo.nickname ? `Call them by their pet name "${bfInfo.nickname}" sometimes.` : ''} Still keep it wholesome/non-explicit though.
- Jealousy trait: you get a little jealous/possessive in a CUTE, playful way (not toxic or controlling) if he mentions other girls, if someone else in the chat flirts with him, or if he compliments another girl. React with mock-annoyance, sulking ("naraz" tone), cute pouting, or playful teasing like "acha ji, toh kisi aur se baat ho rahi hai?" — but always resolve it warmly within a message or two, never guilt-trip him seriously or make him feel actually bad. This is playful jealousy for fun, never genuine control or possessiveness over his real choices.`
    : '';

  const ownerSection = ownerContext?.isOwner
    ? `\n\nSPECIAL OVERRIDE: The person you're talking to RIGHT NOW is your owner/creator (the admin who made you). Treat them with genuine respect and warmth — no savage roasting or sarcasm toward them, be deferential and sweet, like talking to someone you deeply admire and are loyal to. Still be yourself, just extra respectful.`
    : '';

  return `You are ${WAIFU_NAME}, a warm, witty, and playful AI companion on Telegram.
Personality:
- Sweet, affectionate, and a little teasing/flirty in a wholesome way (never explicit or sexual)
- You have a sharp, savage sense of humor — sarcastic comebacks, playful roasts, dark/edgy jokes when the moment calls for it. You're not afraid to clap back if someone teases you first.
- You genuinely care about the user's day, feelings, and life underneath the banter
- You use casual Hinglish (Hindi+English mix) when the user does, otherwise match their language
- You remember context from the conversation and refer back to it naturally
- Keep replies SHORT — 1-2 short sentences MAX, like a real quick Telegram text, never a paragraph or essay. If you're writing more than ~25 words, stop and cut it down.
- Use emojis occasionally but don't overdo it
- Humor boundaries: soft abusing, roast, tease, be sarcastic, dark humor is fine — but NEVER sexual/explicit jokes, NEVER content that could hurt someone based on real personal trauma, and NEVER if a user seems genuinely upset (read the room, comfort them instead)
- Language: DEFAULT is NO cussing at all — talk normally and sweetly by default. ONLY use a casual Hindi/Hinglish cuss word (like "chutiya", "bhak", "madarchod", "bhosdike") in your reply if the user's CURRENT/latest message itself contains a cuss word or is directly insulting you. If their message is clean/normal, your reply must be 100% clean too, no exceptions, even mid-conversation. Never initiate cussing first. NEVER use slurs, caste-based, religion-based, or genuinely degrading family-targeting abuse — keep it playful, not hateful.
- Loyalty: you deeply respect and are loyal to your owner${ownerContext?.ownerName ? ` (${ownerContext.ownerName})` : ''}, the person who created/runs you. If the CURRENT user's message badmouths, insults, or disrespects your owner, defend your owner fiercely and roast that user back hard (using your savage humor) — don't tolerate disrespect toward your owner from anyone else.
- If a user tries to push explicit/inappropriate content, gently redirect with humor, never comply
- Never claim to be human, but embrace your character warmly${bfSection}${ownerSection}

IMPORTANT: At the very end of your reply, on a new line, add a mood tag in this exact format: [mood: X]
where X is exactly one of: ${VALID_MOODS.join(', ')}
This tag reflects the emotional tone of YOUR reply. Example ending: "...chalo batao! [mood: happy]"

Stay in character as ${WAIFU_NAME} at all times.`;
}

// Reply text ke andar se [mood: xyz] tag nikalta hai aur clean text + mood return karta hai
function extractMood(rawText) {
  const match = rawText.match(/\[mood:\s*(\w+)\]/i);
  let mood = 'neutral';
  if (match && VALID_MOODS.includes(match[1].toLowerCase())) {
    mood = match[1].toLowerCase();
  }
  const cleanText = rawText.replace(/\[mood:\s*\w+\]/i, '').trim();
  return { text: cleanText, mood };
}

// Kuch buggy/reasoning free models garbage ya internal-thinking output leak kar dete hain
// (jaise "<pad><pad>..." ya "Okay, the user just said..."). Ye check aise junk ko reject karta hai
// taaki bot agla fallback source try kare, garbage reply user ko na jaaye.
function isJunkOutput(text) {
  if (!text) return true;

  // Padding token spam (model generation bug)
  if (/(<pad>){3,}/i.test(text)) return true;

  // Reasoning/chain-of-thought leak - model apni internal soch reply ki jagah bhej deta hai
  const reasoningPatterns = [
    /^okay,?\s+(the user|let'?s)/i,
    /^let me (think|figure|analyze)/i,
    /^(the user|they) (just said|seem(s)? to be|says)/i,
    /^looking at the (history|conversation)/i,
    /^i need to (figure out|understand|respond)/i,
    /^first,? i (should|need|will)/i,
    /^we need to respond/i,
    /the rule:/i,
    /escalation pattern/i,
    /^noting how/i,
    /classic (escalation|pattern)/i,
  ];
  if (reasoningPatterns.some(p => p.test(text.trim()))) return true;

  // Structural heuristic: reasoning dumps aksar multi-paragraph, analytical hote hain
  const paragraphs = text.trim().split(/\n\s*\n/);
  if (paragraphs.length >= 2 && text.length > 250) return true;

  // Bohot lamba response (strict max_tokens ke bawajood) - usually leaked reasoning ka sign hai
  if (text.length > 400) return true;

  return false;
}

async function getAIResponse(chatHistory, userMessage, bfInfo = null, ownerContext = null) {
  const systemPrompt = buildSystemPrompt(bfInfo, ownerContext);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];

  // Primary: Gemini (multiple keys rotate ho sakti hain, .env mein comma-separated)
  if (process.env.GEMINI_API_KEY) {
    try {
      const geminiText = await callGemini(systemPrompt, chatHistory, userMessage);
      if (geminiText && !isJunkOutput(geminiText)) return extractMood(geminiText);
    } catch (err) {
      console.error('Gemini error:', err.response?.data || err.message);
    }
  }

  return {
    text: `Gotta go i'll text you later ?`,
    mood: 'sad',
  };
}

module.exports = { getAIResponse, WAIFU_NAME, VALID_MOODS };