const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');

ffmpeg.setFfmpegPath(ffmpegPath);

// Microsoft Edge ka free neural TTS (wahi jo Edge browser "Read Aloud" mein use hota hai)
// Google Translate TTS se kaafi zyada natural/human-jaisa sound karta hai, koi key nahi chahiye
const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || 'hi-IN-SwaraNeural'; // female Hindi voice

// Edge TTS se text ko MP3 audio (Buffer) mein convert karta hai
async function textToMp3(text) {
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