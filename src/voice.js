const axios = require('axios');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');

ffmpeg.setFfmpegPath(ffmpegPath);

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_LANG = process.env.SARVAM_TTS_LANG || 'hi-IN';
const SARVAM_SPEAKER = process.env.SARVAM_TTS_SPEAKER || 'anushka';
const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || 'hi-IN-SwaraNeural';

// VOICE_PROVIDER control karta hai kaunsa use ho:
// 'sarvam' - sirf Sarvam (agar fail ho to bhi Edge pe fallback nahi hoga)
// 'edge'   - sirf Edge-TTS (Sarvam bilkul skip)
// 'auto'   - (default) Sarvam try karo, fail ho to Edge pe automatically fallback
const VOICE_PROVIDER = process.env.VOICE_PROVIDER || 'auto';

// ---------- PRIMARY: Sarvam AI (Bulbul v3) - Hinglish ke liye best, real fast API ----------
async function sarvamTextToWav(text) {
  const response = await axios.post(
    'https://api.sarvam.ai/text-to-speech',
    {
      text,
      language_code: SARVAM_LANG,
      model: 'bulbul:v3',
      speaker: SARVAM_SPEAKER,
    },
    {
      headers: {
        'api-subscription-key': SARVAM_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );
  const base64Audio = response.data.audios[0];
  return Buffer.from(base64Audio, 'base64');
}

// ---------- BACKUP: Microsoft Edge TTS - unlimited free, agar Sarvam fail/khatam ho jaye ----------
async function edgeTextToMp3(text) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(EDGE_TTS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = await tts.toStream(text);

  return new Promise((resolve, reject) => {
    const chunks = [];
    audioStream.on('data', chunk => chunks.push(chunk));
    audioStream.on('end', () => resolve(Buffer.concat(chunks)));
    audioStream.on('error', reject);
  });
}

// Audio Buffer (kisi bhi format) ko Telegram voice-note format (OGG/Opus) mein convert karta hai
function toOggOpus(audioBuffer, inputFormat) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    input.end(audioBuffer);

    const chunks = [];
    const output = new PassThrough();
    output.on('data', chunk => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);

    ffmpeg(input)
      .inputFormat(inputFormat)
      .audioCodec('libopus')
      .audioBitrate('64k')
      .format('ogg')
      .on('error', reject)
      .pipe(output, { end: true });
  });
}

// Text se seedha ready-to-send Telegram voice note (Buffer) banata hai
// VOICE_PROVIDER ke hisaab se decide karta hai kaunsa provider use karna hai
async function generateVoiceNote(text) {
  if (VOICE_PROVIDER === 'edge') {
    const mp3 = await edgeTextToMp3(text);
    return toOggOpus(mp3, 'mp3');
  }

  if (VOICE_PROVIDER === 'sarvam') {
    const wav = await sarvamTextToWav(text);
    return toOggOpus(wav, 'wav');
  }

  // 'auto' (default): Sarvam try karo (behtar Hinglish quality), fail ho to Edge pe fallback
  if (SARVAM_API_KEY) {
    try {
      const wav = await sarvamTextToWav(text);
      return await toOggOpus(wav, 'wav');
    } catch (err) {
      console.error('Sarvam TTS error, falling back to Edge-TTS:', err.response?.data || err.message);
    }
  }

  const mp3 = await edgeTextToMp3(text);
  return toOggOpus(mp3, 'mp3');
}

module.exports = { generateVoiceNote };