const axios = require('axios');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Support for multiple Gemini API keys - comma-separate them in .env
// GEMINI_API_KEY=key1,key2,key3 - if one key's quota runs out, the next one is tried
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

// Gemini uses its own chat format (not OpenAI-style) - so messages need converting
function buildGeminiPayload(systemPrompt, chatHistory, userMessage) {
  const contents = [
    ...chatHistory.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  return {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      maxOutputTokens: 100,
      temperature: 0.9,
      // Gemini's newer models default to "thinking" mode on, which can sometimes
      // leak internal reasoning into the final text. Disabling that here.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

async function callGemini(systemPrompt, chatHistory, userMessage) {
  const payload = buildGeminiPayload(systemPrompt, chatHistory, userMessage);

  // Gemini's default safety filter blocks/softens casual profanity or harassment-tone content
  // even if the system prompt allows it. Here we only relax the harassment category -
  // hate speech, sexual content, and dangerous content remain strictly blocked.
  payload.safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  ];

  if (!GEMINI_API_KEYS.length) return null;

  let lastErr = null;

  // Try each key one by one - if a key's quota is exhausted (429), move to the next
  for (const key of GEMINI_API_KEYS) {
    try {
      const response = await axios.post(GEMINI_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        timeout: 30000,
      });

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text?.trim()) return text.trim();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      console.error(`Gemini key ending ...${key.slice(-4)} failed (status ${status}):`, err.response?.data || err.message);
      // 429 (rate limit) or 403 (invalid key) -> just try the next key
      continue;
    }
  }

  if (lastErr) throw lastErr;
  return null;
}

module.exports = { callGemini };