const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');

ffmpeg.setFfmpegPath(ffmpegPath);

const POLLINATIONS_VOICE = process.env.POLLINATIONS_VOICE || 'nova';

// Pollinations ke free TTS se text ko MP3 audio mein convert karta hai
async function textToMp3(text) {
  const url = `https://text.pollinations.ai/${encodeURIComponent(text)}`;
  const response = await axios.get(url, {
    params: { model: 'openai-audio', voice: POLLINATIONS_VOICE },
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  return Buffer.from(response.data);
}

// MP3 ko Telegram voice-note format (OGG/Opus) mein convert karta hai
// Telegram ko round waveform-wala "voice message" bubble dikhane ke liye yehi format chahiye
function mp3ToOggOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    input.end(mp3Buffer);

    const chunks = [];
    const output = new PassThrough();
    output.on('data', chunk => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);

    ffmpeg(input)
      .inputFormat('mp3')
      .audioCodec('libopus')
      .audioBitrate('64k')
      .format('ogg')
      .on('error', reject)
      .pipe(output, { end: true });
  });
}

// Text se seedha ready-to-send Telegram voice note (Buffer) banata hai
async function generateVoiceNote(text) {
  const mp3 = await textToMp3(text);
  return mp3ToOggOpus(mp3);
}

module.exports = { generateVoiceNote };