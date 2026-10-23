import { describe, it, expect, vi } from 'vitest';
import { handleModeCommand } from '../src/cli/repl-mode-commands.js';
import { buildAccountantPrompt, ACCOUNTANT_TOOLS } from '../src/agent/accountant-prompt.js';

describe('Repl Mode Commands - Accountant One Toggle', () => {
  const makeCtx = (mode: any = 'coder') => ({
    mode,
    display: {
      warning: vi.fn(),
    },
  });

  it('toggles into accountant1 mode when currently in coder mode', () => {
    const ctx = makeCtx('coder');
    const result = handleModeCommand(':accountant1', ctx);
    expect(result).toEqual({ handled: true, newMode: 'accountant1' });
    expect(ctx.display.warning).not.toHaveBeenCalled();
  });

  it('toggles back to coder mode when already in accountant1 mode', () => {
    const ctx = makeCtx('accountant1');
    const result = handleModeCommand(':accountant1', ctx);
    expect(result).toEqual({ handled: true, newMode: 'coder' });
    expect(ctx.display.warning).toHaveBeenCalledWith(
      expect.stringContaining('Toggled off Accountant One mode')
    );
  });

  it('supports slash format /accountant1', () => {
    const ctx = makeCtx('coder');
    const result = handleModeCommand('/accountant1', ctx);
    expect(result).toEqual({ handled: true, newMode: 'accountant1' });
  });

  it('supports /accountant-1 hyphenated alias', () => {
    const ctx = makeCtx('coder');
    const result = handleModeCommand('/accountant-1', ctx);
    expect(result).toEqual({ handled: true, newMode: 'accountant1' });
  });

  it('handles explicit on/off subcommands', () => {
    const ctxOn = makeCtx('coder');
    const resOn = handleModeCommand(':accountant1 on', ctxOn);
    expect(resOn).toEqual({ handled: true, newMode: 'accountant1' });

    const ctxAlreadyOn = makeCtx('accountant1');
    const resAlreadyOn = handleModeCommand(':accountant1 on', ctxAlreadyOn);
    expect(resAlreadyOn).toEqual({ handled: true });
    expect(ctxAlreadyOn.display.warning).toHaveBeenCalledWith('Already in Accountant One mode.');

    const ctxOff = makeCtx('accountant1');
    const resOff = handleModeCommand(':accountant1 off', ctxOff);
    expect(resOff).toEqual({ handled: true, newMode: 'coder' });
  });

  it('provides a lightweight prompt and scoped toolset for Accountant One', () => {
    const prompt = buildAccountantPrompt();
    expect(prompt).toContain('Accountant One');
    expect(prompt).toContain('bookkeeping');
    expect(ACCOUNTANT_TOOLS).toContain('bookkeeping');
    expect(ACCOUNTANT_TOOLS).toContain('email');
    expect(ACCOUNTANT_TOOLS).not.toContain('git_status');
    expect(ACCOUNTANT_TOOLS).not.toContain('search_code');
  });
});

describe('Repl Mode Commands - Accountant Two Toggle', () => {
  const makeCtx = (mode: any = 'coder') => ({
    mode,
    display: {
      warning: vi.fn(),
    },
  });

  it('toggles into accountant2 mode when currently in coder mode', () => {
    const ctx = makeCtx('coder');
    const result = handleModeCommand(':accountant2', ctx);
    expect(result).toEqual({ handled: true, newMode: 'accountant2' });
    expect(ctx.display.warning).not.toHaveBeenCalled();
  });

  it('toggles back to coder mode when already in accountant2 mode', () => {
    const ctx = makeCtx('accountant2');
    const result = handleModeCommand(':accountant2', ctx);
    expect(result).toEqual({ handled: true, newMode: 'coder' });
    expect(ctx.display.warning).toHaveBeenCalledWith(
      expect.stringContaining('Toggled off Accountant Two mode')
    );
  });

  it('supports slash format /accountant2', () => {
    const ctx = makeCtx('coder');
    const result = handleModeCommand('/accountant2', ctx);
    expect(result).toEqual({ handled: true, newMode: 'accountant2' });
  });

  it('supports /accountant-2 hyphenated alias', () => {
    const ctx = makeCtx('coder');
    const result = handleModeCommand('/accountant-2', ctx);
    expect(result).toEqual({ handled: true, newMode: 'accountant2' });
  });

  it('supports :accountant2 on / off', () => {
    const on = handleModeCommand(':accountant2 on', makeCtx('coder'));
    expect(on).toEqual({ handled: true, newMode: 'accountant2' });
    const off = handleModeCommand(':accountant2 off', makeCtx('accountant2'));
    expect(off).toEqual({ handled: true, newMode: 'coder' });
  });
});
