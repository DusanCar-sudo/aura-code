import { describe, it, expect } from 'vitest';
import { selectTools, selectToolsWithEviction, TOOL_DEFINITIONS } from '../../src/tools/index.js';
import type { HistoryMessage } from '../../src/providers/types.js';

const names = (tools: { name: string }[]) => tools.map(t => t.name);

/** Fresh per-run state, as the loop owns it. */
function freshState() {
  return {
    included: new Set<string>(),
    lastUsedTurn: new Map<string, number>(),
    evicted: new Set<string>(),
  };
}

describe('selectToolsWithEviction', () => {
  const task = 'refactor the config loader and send me a telegram message when done';

  it('triggers a conditional tool like selectTools does', () => {
    const s = freshState();
    const sent = names(selectToolsWithEviction(task, [], s.included, s.lastUsedTurn, 1, 3, s.evicted));
    expect(sent).toContain('telegram');
    expect(s.lastUsedTurn.get('telegram')).toBe(1);
  });

  it('evicts a triggered-but-never-called tool after evictAfterTurns turns', () => {
    const s = freshState();
    const history: HistoryMessage[] = [{ role: 'user', content: task }];
    // Turn 1: triggered, offered. Turns 2-4: offered, never called.
    for (let turn = 1; turn <= 4; turn++) {
      const sent = names(selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, turn, 3, s.evicted));
      expect(sent, `turn ${turn} should still offer telegram`).toContain('telegram');
    }
    // Turn 5: 5 - 1 > 3 — evicted, schema no longer includes it.
    const sent = names(selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, 5, 3, s.evicted));
    expect(sent).not.toContain('telegram');
    expect(s.evicted).toContain('telegram');
  });

  it('stale history keyword does not resurrect an evicted tool', () => {
    const s = freshState();
    const history: HistoryMessage[] = [
      { role: 'user', content: task },
      { role: 'assistant', content: 'working on it' },
      { role: 'user', content: 'looks good, keep going' },
    ];
    selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, 1, 3, s.evicted);
    const sent = names(selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, 6, 3, s.evicted));
    expect(sent).not.toContain('telegram');
    // task keyword still matches gateText, but eviction must hold
    const again = names(selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, 7, 3, s.evicted));
    expect(again).not.toContain('telegram');
  });

  it('fresh mention in the latest user message re-admits an evicted tool', () => {
    const s = freshState();
    const history: HistoryMessage[] = [{ role: 'user', content: task }];
    selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, 1, 3, s.evicted);
    selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, 6, 3, s.evicted);
    expect(s.evicted).toContain('telegram');

    history.push({ role: 'user', content: 'now actually send that telegram message' });
    const sent = names(selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, 7, 3, s.evicted));
    expect(sent).toContain('telegram');
    expect(s.evicted).not.toContain('telegram');
    expect(s.lastUsedTurn.get('telegram')).toBe(7);
  });

  it('a call refreshes lastUsedTurn and prevents eviction', () => {
    const s = freshState();
    const history: HistoryMessage[] = [{ role: 'user', content: task }];
    selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, 1, 3, s.evicted);
    // loop.ts sets this when the tool is actually called
    s.lastUsedTurn.set('telegram', 4);
    const sent = names(selectToolsWithEviction(task, history, s.included, s.lastUsedTurn, 7, 3, s.evicted));
    expect(sent).toContain('telegram');
  });

  it('CORE tools are never evicted', () => {
    const s = freshState();
    const sent = names(selectToolsWithEviction('fix bug', [], s.included, s.lastUsedTurn, 50, 1, s.evicted));
    for (const core of ['read_file', 'list_dir', 'edit_file', 'write_file', 'search_code', 'run_shell', 'run_tests', 'git_status', 'git_diff']) {
      expect(sent).toContain(core);
    }
  });

  it('sticky selectTools() behavior is unchanged (large-model path)', () => {
    const included = new Set<string>();
    const history: HistoryMessage[] = [{ role: 'user', content: task }];
    // many turns, tool never called — still present every time
    for (let i = 0; i < 10; i++) {
      expect(names(selectTools(task, history, included))).toContain('telegram');
    }
    expect(names(selectTools(task, [{ role: 'user', content: '[recap] done' }], included))).toContain('telegram');
  });

  it('with everything triggered and nothing stale, matches full TOOL_DEFINITIONS order', () => {
    const s = freshState();
    const everything = 'telegram whatsapp email calendar cron browser http api screenshot clipboard notify image mcp connect spawn delegate web_search fetch memory remember url';
    const sent = names(selectToolsWithEviction(everything, [], s.included, s.lastUsedTurn, 1, 3, s.evicted));
    expect(sent).toEqual(TOOL_DEFINITIONS.map(t => t.name));
  });
});
