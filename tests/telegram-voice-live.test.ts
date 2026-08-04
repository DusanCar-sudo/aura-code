import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { textToSpeech, sendVoiceMessage, isOggOpus } from '../src/tools/telegram-voice.js';

/**
 * Live end-to-end check that a synthesized reply arrives as an inline voice
 * bubble rather than a file attachment. It sends a real Telegram message, so it
 * is OPT-IN and never runs as part of `npm test`.
 *
 *   AURA_LIVE_VOICE_TEST=1 AURA_TEST_CHAT_ID=<chat id> npx vitest run tests/telegram-voice-live.test.ts
 *
 * This used to be gated the other way round — `skipIf(isCI || !hasTelegramConfig)`
 * — which skipped on CI and ran everywhere else. On any developer machine with a
 * configured bot, every `npm test` fired a real voice note at the chat in
 * `telegram.json:default_chat_id`. That produced weeks of unexplained "the bot
 * keeps sending me audio every few hours" reports: the sends left no trace in
 * the bot's own journal or session history, because they came from the vitest
 * process rather than the running bot service.
 *
 * Two rules follow from that, and both matter:
 *   1. Opt-in, not opt-out. An absent variable must mean "do not send".
 *   2. The target chat is explicit. Never fall back to default_chat_id — that
 *      is a real person's inbox, not a test fixture.
 */
const optedIn = process.env.AURA_LIVE_VOICE_TEST === '1';
const testChatId = process.env.AURA_TEST_CHAT_ID ?? '';
const configPath = path.join(os.homedir(), '.aura', 'telegram.json');

describe.skipIf(!optedIn)('LIVE voice bubble check (opt-in)', () => {
  it('sends a real inline voice note', async () => {
    expect(
      testChatId,
      'AURA_TEST_CHAT_ID must name the chat to send to — this test will not fall back to default_chat_id',
    ).toBeTruthy();
    expect(fs.existsSync(configPath), `${configPath} exists`).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let groqKey = process.env.GROQ_API_KEY ?? '';
    if (!groqKey) {
      const envDir = path.join(os.homedir(), '.config', 'environment.d');
      if (fs.existsSync(envDir)) {
        for (const f of fs.readdirSync(envDir)) {
          const m = fs.readFileSync(path.join(envDir, f), 'utf8').match(/^GROQ_API_KEY=(.+)$/m);
          if (m) { groqKey = m[1].trim(); break; }
        }
      }
    }
    expect(groqKey, 'GROQ_API_KEY found').toBeTruthy();

    const audio = await textToSpeech('Voice fix test. This should play inline as a voice bubble.', groqKey);
    console.log('groq bytes:', audio.length, '| magic:', audio.subarray(0, 4).toString('latin1'), '| isOggOpus:', isOggOpus(audio));
    await sendVoiceMessage(cfg.bot_token, testChatId, audio);
    console.log('SENT_OK');
  }, 120_000);
});
