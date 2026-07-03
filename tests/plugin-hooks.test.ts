import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { runHooks } from '../src/plugins/hooks.js';
import type { HookEntry } from '../src/plugins/types.js';

const root = os.tmpdir();

function entry(over: Partial<HookEntry>): HookEntry {
  return {
    event: 'PreToolUse', command: 'true',
    pluginName: 'test-plugin', pluginRoot: '/fake/plugin',
    ...over,
  };
}

describe('runHooks', () => {
  it('exit code 2 blocks with stderr as the reason', async () => {
    const out = await runHooks('PreToolUse', 'run_shell', { command: 'ls' },
      [entry({ command: 'echo "not allowed" >&2; exit 2' })], root);
    expect(out.block).toBe(true);
    expect(out.messages[0]).toContain('not allowed');
    expect(out.messages[0]).toContain('[test-plugin]');
  });

  it('exit code 0 passes', async () => {
    const out = await runHooks('PreToolUse', 'run_shell', { command: 'ls' },
      [entry({ command: 'exit 0' })], root);
    expect(out.block).toBe(false);
    expect(out.messages).toEqual([]);
  });

  it('other non-zero exits warn but do not block', async () => {
    const out = await runHooks('PreToolUse', 'run_shell', { command: 'ls' },
      [entry({ command: 'echo oops >&2; exit 1' })], root);
    expect(out.block).toBe(false);
    expect(out.messages[0]).toContain('hook exited 1');
  });

  it('stdout JSON {"decision":"block"} blocks regardless of exit code', async () => {
    const out = await runHooks('PreToolUse', 'run_shell', { command: 'ls' },
      [entry({ command: `echo '{"decision":"block","reason":"policy says no"}'; exit 0` })], root);
    expect(out.block).toBe(true);
    expect(out.messages[0]).toContain('policy says no');
  });

  it('receives the Claude Code payload spelling on stdin', async () => {
    // Hook greps stdin for the CC alias of run_shell ("Bash") and blocks if found.
    const out = await runHooks('PreToolUse', 'run_shell', { command: 'rm -rf x' },
      [entry({ command: `input=$(cat); echo "$input" | grep -q '"tool_name":"Bash"' && echo "$input" | grep -q '"command":"rm -rf x"' && exit 2 || exit 0` })], root);
    expect(out.block).toBe(true);
  });

  it('maps write_file input keys to Claude Code spelling (file_path)', async () => {
    const out = await runHooks('PreToolUse', 'write_file', { path: 'a.ts', content: 'x' },
      [entry({ matcher: 'Write', command: `grep -q '"file_path":"a.ts"' && exit 2 || exit 0` })], root);
    expect(out.block).toBe(true);
  });

  it('matcher filters by Claude Code tool name', async () => {
    const entries = [entry({ matcher: 'Bash', command: 'exit 2' })];
    const shell = await runHooks('PreToolUse', 'run_shell', { command: 'ls' }, entries, root);
    expect(shell.block).toBe(true);
    const write = await runHooks('PreToolUse', 'write_file', { path: 'a' }, entries, root);
    expect(write.block).toBe(false);
  });

  it('matcher also accepts aura tool names and regex alternation', async () => {
    const entries = [entry({ matcher: 'Edit|write_file', command: 'exit 2' })];
    expect((await runHooks('PreToolUse', 'write_file', {}, entries, root)).block).toBe(true);
    expect((await runHooks('PreToolUse', 'edit_file', {}, entries, root)).block).toBe(true);
    expect((await runHooks('PreToolUse', 'read_file', {}, entries, root)).block).toBe(false);
  });

  it('only fires entries for the requested event', async () => {
    const entries = [entry({ event: 'PostToolUse', command: 'exit 2' })];
    const out = await runHooks('PreToolUse', 'run_shell', {}, entries, root);
    expect(out.block).toBe(false);
  });

  it('substitutes ${CLAUDE_PLUGIN_ROOT} and exposes CLAUDE_PROJECT_DIR', async () => {
    const out = await runHooks('PreToolUse', 'run_shell', {},
      [entry({
        pluginRoot: '/expected/root',
        // eslint-disable-next-line no-template-curly-in-string
        command: 'test "${CLAUDE_PLUGIN_ROOT}" = "/expected/root" && test -n "$CLAUDE_PROJECT_DIR" && exit 2 || exit 0',
      })], root);
    expect(out.block).toBe(true);
  });

  it('kills hooks that exceed their timeout and warns', async () => {
    const start = Date.now();
    const out = await runHooks('PreToolUse', 'run_shell', {},
      [entry({ command: 'sleep 30', timeout: 1 })], root);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(out.block).toBe(false);
    expect(out.messages[0]).toContain('timed out');
  });

  it('PostToolUse receives tool_response', async () => {
    const out = await runHooks('PostToolUse', 'run_shell', { command: 'ls' },
      [entry({ event: 'PostToolUse', command: `grep -q '"tool_response":"file listing"' && exit 2 || exit 0` })],
      root, 'file listing');
    // PostToolUse "block" has no call to stop, but the outcome still reports it —
    // the loop ignores block on Post; here it just proves the payload arrived.
    expect(out.block).toBe(true);
  });
});
