/**
 * Voice I/O wrapper: OpenAI Whisper (STT) + OpenAI TTS.
 * Uses axios (already a project dep) — no new SDK.
 *
 * Required env:
 *   OPENAI_API_KEY         — for both transcription + speech
 * Optional env:
 *   OPENAI_STT_MODEL       — default 'whisper-1'
 *   OPENAI_TTS_MODEL       — default 'tts-1'
 *   OPENAI_TTS_VOICE       — default 'alloy'
 */

import axios from 'axios';

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const STT_MODEL = process.env.OPENAI_STT_MODEL || 'whisper-1';
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'tts-1';
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';

const OPENAI_API_BASE = 'https://api.openai.com/v1';

export function isVoiceConfigured() {
  return !!OPENAI_KEY;
}

/**
 * Transcribe an audio buffer.
 * @param {Buffer} buffer
 * @param {string} filename - used to hint MIME (e.g. "voice.webm")
 * @returns {Promise<{ text: string }>}
 */
export async function transcribeAudio(buffer, filename = 'audio.webm') {
  if (!OPENAI_KEY) {
    throw new Error('Voice is not configured. Set OPENAI_API_KEY in your .env file.');
  }
  // Use global FormData/Blob (Node 18+).
  const form = new FormData();
  const blob = new Blob([buffer]);
  form.append('file', blob, filename);
  form.append('model', STT_MODEL);
  form.append('response_format', 'json');

  const res = await axios.post(`${OPENAI_API_BASE}/audio/transcriptions`, form, {
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    maxContentLength: 30 * 1024 * 1024,
    maxBodyLength: 30 * 1024 * 1024,
    timeout: 60000,
  });
  const text = typeof res.data?.text === 'string' ? res.data.text : '';
  return { text };
}

/**
 * Synthesize speech to MP3 bytes.
 * @param {string} text
 * @param {string} [voice]
 * @returns {Promise<{ audioBuffer: Buffer, contentType: string }>}
 */
export async function synthesizeSpeech(text, voice = TTS_VOICE) {
  if (!OPENAI_KEY) {
    throw new Error('Voice is not configured. Set OPENAI_API_KEY in your .env file.');
  }
  const input = typeof text === 'string' ? text.slice(0, 4000) : '';
  if (!input) throw new Error('text is required');

  const res = await axios.post(
    `${OPENAI_API_BASE}/audio/speech`,
    { model: TTS_MODEL, voice, input, response_format: 'mp3' },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );

  return { audioBuffer: Buffer.from(res.data), contentType: 'audio/mpeg' };
}
