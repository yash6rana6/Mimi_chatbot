const axios = require('axios');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Multiple Gemini API keys support - comma se separate karke .env mein daal sakte ho
// GEMINI_API_KEY=key1,key2,key3 - ek key ki limit khatam ho to agli try hogi
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

// Gemini ka apna alag chat format hai (OpenAI jaisa nahi) - isliye messages ko convert karna padta hai
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
      // Gemini ke naye models "thinking" mode default on rakhte hain jo kabhi kabhi
      // internal reasoning ko final text mein leak kar deta hai. Ise disable kar rahe hain.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

async function callGemini(systemPrompt, chatHistory, userMessage) {
  const payload = buildGeminiPayload(systemPrompt, chatHistory, userMessage);

  // Gemini ka default safety filter casual gaaliyan/harassment-tone content ko block/soften kar deta hai
  // chahe system prompt mein allow kiya ho. Yahan sirf harassment category thodi relax kar rahe hain -
  // hate speech, sexual content, aur dangerous content abhi bhi strictly blocked rahenge.
  payload.safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  ];

  if (!GEMINI_API_KEYS.length) return null;

  let lastErr = null;

  // Har key ko ek-ek karke try karo - jis key ki limit khatam ho (429) usse agli try karo
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
      // 429 (rate limit) ya 403 (invalid key) -> seedha agli key try karo
      continue;
    }
  }

  if (lastErr) throw lastErr;
  return null;
}

module.exports = { callGemini };