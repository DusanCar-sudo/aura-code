// TEMPORARY live verification — real Groq TTS + real Telegram sendVoice.
// Deleted after the live check; not part of the suite.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { textToSpeech, sendVoiceMessage, isOggOpus } from '../src/tools/telegram-voice.js';

const isCI = process.env.CI === 'true';

describe.skipIf(isCI)('LIVE voice bubble check', () => {
  it('sends a real inline voice note', async () => {
    const cfg = JSON.parse(fs.readFileSync('/home/dusan/.aura/telegram.json', 'utf8'));
    let groqKey = process.env.GROQ_API_KEY ?? '';
    if (!groqKey) {
      for (const f of fs.readdirSync('/home/dusan/.config/environment.d')) {
        const m = fs.readFileSync(`/home/dusan/.config/environment.d/${f}`, 'utf8').match(/^GROQ_API_KEY=(.+)$/m);
        if (m) { groqKey = m[1].trim(); break; }
      }
    }
    expect(groqKey, 'GROQ_API_KEY found').toBeTruthy();

    const audio = await textToSpeech('Voice fix test. This should play inline as a voice bubble.', groqKey);
    console.log('groq bytes:', audio.length, '| magic:', audio.subarray(0, 4).toString('latin1'), '| isOggOpus:', isOggOpus(audio));
    await sendVoiceMessage(cfg.bot_token, cfg.default_chat_id, audio);
    console.log('SENT_OK');
  }, 120_000);
});
