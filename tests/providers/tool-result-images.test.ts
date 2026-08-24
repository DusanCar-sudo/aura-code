import { describe, it, expect } from 'vitest';
import { toOpenAIMessages } from '../../src/providers/openai-compatible.js';
import { pruneToolResultImages, IMAGE_DROPPED_NOTE, KEEP_LAST_IMAGES }
  from '../../src/agent/tool-elision.js';
import type { HistoryMessage } from '../../src/providers/types.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PNG2 = 'data:image/png;base64,AAAAAAAAAAA=';

const shot = (id: string, images?: string[]) => ({
  id, name: 'computer', content: 'screen 2259x2471', ...(images ? { images } : {}),
});

describe('tool results carrying images → OpenAI wire format', () => {
  const convert = (h: HistoryMessage[]) => toOpenAIMessages('sys', h);

  it('never puts an image inside the tool message', () => {
    // OpenAI rejects image parts in `role: "tool"`. This is the whole reason
    // the adapter emits a separate user message, and it is not discoverable
    // from the type — ToolResult.images sits right there looking usable.
    const msgs = convert([{ role: 'tool_result', results: [shot('c1', [PNG])] }]);
    const toolMsg = msgs.find(m => m.role === 'tool')!;
    expect(typeof toolMsg.content).toBe('string');
    expect(JSON.stringify(toolMsg)).not.toContain('image_url');
  });

  it('emits the image in a user message right after the tool message', () => {
    const msgs = convert([{ role: 'tool_result', results: [shot('c1', [PNG])] }]);
    const toolIdx = msgs.findIndex(m => m.role === 'tool');
    const next = msgs[toolIdx + 1]!;
    expect(next.role).toBe('user');
    const parts = next.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: 'image_url', image_url: { url: PNG } });
    // A text part names the source, so the image is not an unexplained blob.
    expect(JSON.stringify(parts.at(-1))).toContain('computer');
  });

  it('adds nothing at all when no result has images', () => {
    // The overwhelmingly common case — every text tool. A stray empty user
    // message here would land in every single turn of every session.
    const msgs = convert([{ role: 'tool_result', results: [shot('c1')] }]);
    expect(msgs.filter(m => m.role === 'user')).toHaveLength(0);
  });

  it('batches images from several results into one user message', () => {
    const msgs = convert([{
      role: 'tool_result',
      results: [shot('c1', [PNG]), shot('c2', [PNG2])],
    }]);
    const users = msgs.filter(m => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(JSON.stringify(users[0])).toContain(PNG);
    expect(JSON.stringify(users[0])).toContain(PNG2);
  });
});

describe('pruneToolResultImages', () => {
  const histOf = (n: number): HistoryMessage[] =>
    Array.from({ length: n }, (_, i) =>
      ({ role: 'tool_result', results: [shot(`c${i}`, [PNG])] } as HistoryMessage));

  it('keeps only the most recent images', () => {
    const h = histOf(5);
    pruneToolResultImages(h);
    const withImages = h.filter(m => m.role === 'tool_result' && m.results[0].images);
    expect(withImages).toHaveLength(KEEP_LAST_IMAGES);
  });

  it('keeps the newest ones, not the oldest', () => {
    const h = histOf(5);
    pruneToolResultImages(h);
    const kept = h.flatMap(m => m.role === 'tool_result' ? m.results : [])
      .filter(r => r.images).map(r => r.id);
    expect(kept).toEqual(['c3', 'c4']);
  });

  it('tells the model an image was dropped rather than silently forgetting', () => {
    const h = histOf(4);
    pruneToolResultImages(h);
    const dropped = (h[0] as { results: { content: string }[] }).results[0];
    expect(dropped.content).toContain(IMAGE_DROPPED_NOTE);
    expect(dropped.content).toContain('screen 2259x2471');  // original text kept
  });

  it('is stable across repeated calls, so the cached prefix is not rewritten', () => {
    // Called once per turn on the same history. A counter or timestamp in the
    // note would change these bytes every turn and thrash the prompt cache.
    const h = histOf(4);
    pruneToolResultImages(h);
    const first = JSON.stringify(h);
    pruneToolResultImages(h);
    pruneToolResultImages(h);
    expect(JSON.stringify(h)).toBe(first);
  });

  it('leaves an image-free history untouched', () => {
    const h: HistoryMessage[] = [{ role: 'tool_result', results: [shot('c1')] }];
    const before = JSON.stringify(h);
    pruneToolResultImages(h);
    expect(JSON.stringify(h)).toBe(before);
  });
});
