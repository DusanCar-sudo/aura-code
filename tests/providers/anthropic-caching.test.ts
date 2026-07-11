import { describe, it, expect } from 'vitest';
import { toCachedSystem, toCachedTools, fromAnthropicResponse } from '../../src/providers/anthropic.js';
import type { ToolDefinition } from '../../src/providers/types.js';
import type Anthropic from '@anthropic-ai/sdk';

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

describe('anthropic cache stats extraction', () => {
  // Helper to build a minimal Anthropic.Message with custom usage fields
  function fakeMessage(usage: Record<string, unknown>) {
    return {
      id: 'msg_test',
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'claude-sonnet-4-5-20251001',
      stop_reason: 'end_turn' as const,
      content: [{ type: 'text' as const, text: 'ok' }],
      usage: usage as Anthropic.Usage,
    };
  }

  it('extracts cache_read_input_tokens as cachedTokens', () => {
    const msg = fakeMessage({ input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 800 });
    const res = fromAnthropicResponse(msg);
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 50, cachedTokens: 800 });
  });

  it('omits cachedTokens when cache_read_input_tokens is 0', () => {
    const msg = fakeMessage({ input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0 });
    const res = fromAnthropicResponse(msg);
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 50 });
  });

  it('omits cachedTokens when cache fields are absent', () => {
    const msg = fakeMessage({ input_tokens: 1000, output_tokens: 50 });
    const res = fromAnthropicResponse(msg);
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 50 });
  });
});
