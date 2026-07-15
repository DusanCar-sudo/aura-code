import { describe, it, expect } from 'vitest';
import { selectTools, TOOL_DEFINITIONS } from '../../src/tools/index.js';
import type { HistoryMessage } from '../../src/providers/types.js';

const CORE = [
  'read_file', 'list_dir', 'edit_file', 'write_file', 'search_code',
  'run_shell', 'run_tests', 'git_status', 'git_diff',
];
const CORE_CONDITIONAL = ['spawn_task', 'web_fetch', 'web_search', 'memory', 'mcp'];
const CONDITIONAL = [
  'telegram', 'whatsapp', 'email', 'calendar', 'cron',
  'browser', 'http_request', 'notify', 'image_read', 'clipboard',
];

const names = (task: string, history: HistoryMessage[] = [], included?: Set<string>) =>
  selectTools(task, history, included).map(t => t.name);

describe('selectTools relevance gate', () => {
  it('plain code-fix task excludes all personal-integration tools', () => {
    const sent = names('fix the null check bug in the parser and make the tests pass');
    for (const t of ['telegram', 'whatsapp', 'email', 'calendar', 'cron']) {
      expect(sent, `${t} should be gated out`).not.toContain(t);
    }
  });

  it('CORE tools present regardless of task text', () => {
    for (const task of [
      'fix the parser bug',
      'send me a telegram message when done',
      '',
      'schedule a daily email report with a screenshot from the browser',
    ]) {
      const sent = names(task);
      for (const t of CORE) expect(sent, `${t} missing for task "${task}"`).toContain(t);
    }
  });

  it('telegram mention includes the telegram tool', () => {
    expect(names('refactor the config loader and send me a telegram message when done'))
      .toContain('telegram');
  });

  it('mid-session pivot in history adds the tool before next turn', () => {
    const included = new Set<string>();
    const history: HistoryMessage[] = [{ role: 'user', content: 'fix the parser bug' }];
    expect(names('fix the parser bug', history, included)).not.toContain('telegram');

    history.push({ role: 'assistant', content: 'fixed, tests green' });
    history.push({ role: 'user', content: 'nice — actually send this summary via telegram' });
    expect(names('fix the parser bug', history, included)).toContain('telegram');
  });

  it('sticky: tool stays included after compaction rewrites the keyword out of history', () => {
    const included = new Set<string>();
    names('fix the bug', [{ role: 'user', content: 'send it via telegram' }], included);
    // simulate compaction: keyword gone from history
    const sent = names('fix the bug', [{ role: 'user', content: '[recap] fixed a bug' }], included);
    expect(sent).toContain('telegram');
  });

  it('every conditional tool has a working trigger', () => {
    const samples: Record<string, string> = {
      telegram: 'ping the telegram bot',
      whatsapp: 'forward to whatsapp',
      email: 'check my gmail inbox',
      calendar: 'add a meeting to my calendar',
      cron: 'set up a cron job',
      browser: 'take a screenshot of the website in chrome',
      http_request: 'call the api endpoint with curl',
      notify: 'show a desktop notification',
      image_read: 'read this png image',
      clipboard: 'copy to clipboard',
    };
    for (const [tool, task] of Object.entries(samples)) {
      expect(names(task), `trigger for ${tool}`).toContain(tool);
    }
  });

  it('selected tools preserve TOOL_DEFINITIONS order and cover all 24 when everything triggers', () => {
    const everything = Object.values({
      t: 'telegram whatsapp email calendar cron browser http api screenshot clipboard notify image mcp connect spawn delegate web_search fetch memory remember url',
    }).join(' ');
    const sent = names(everything);
    expect(sent).toEqual(TOOL_DEFINITIONS.map(t => t.name));
  });

  it('gate ignores tool_result content', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'fix the bug' },
      { role: 'tool_result', results: [{ id: '1', content: 'grep hit: sendTelegramMessage()', isError: false }] },
    ];
    expect(names('fix the bug', history)).not.toContain('whatsapp');
  });
});
