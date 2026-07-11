import { describe, it, expect } from 'vitest';
import { toCachedSystem, toCachedTools } from '../../src/providers/anthropic.js';
import type { ToolDefinition } from '../../src/providers/types.js';

const tools: ToolDefinition[] = [
  { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
  { name: 'edit_file', description: 'edit', parameters: { type: 'object', properties: {} } },
  { name: 'run_shell', description: 'shell', parameters: { type: 'object', properties: {} } },
];

describe('anthropic prompt caching', () => {
  it('wraps system prompt in a text block with an ephemeral cache breakpoint', () => {
    const system = toCachedSystem('you are aura');
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({
      type: 'text',
      text: 'you are aura',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('marks only the last tool definition as a cache breakpoint', () => {
    const out = toCachedTools(tools);
    expect(out).toHaveLength(3);
    expect(out[0]).not.toHaveProperty('cache_control');
    expect(out[1]).not.toHaveProperty('cache_control');
    expect(out[2]).toMatchObject({
      name: 'run_shell',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('preserves tool name/description/schema on the marked tool', () => {
    const out = toCachedTools(tools);
    expect(out[2].description).toBe('shell');
    expect(out[2].input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('handles empty tool list without adding markers', () => {
    expect(toCachedTools([])).toEqual([]);
  });
});
