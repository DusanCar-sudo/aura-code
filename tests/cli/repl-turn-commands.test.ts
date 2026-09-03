import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTurnCommand, type TurnCommandCtx } from '../../src/cli/repl-turn-commands.js';
import { DEFAULT_MAX_TURNS } from '../../src/agent/loop-profile.js';

describe('handleTurnCommand', () => {
  let successMsg: string | null = null;
  let warningMsg: string | null = null;
  let ctx: TurnCommandCtx;

  beforeEach(() => {
    successMsg = null;
    warningMsg = null;
    ctx = {
      turnsOverride: undefined,
      defaultMaxTurns: undefined,   // fall back to DEFAULT_MAX_TURNS
      display: {
        success: (msg: string) => { successMsg = msg; },
        warning: (msg: string) => { warningMsg = msg; },
      },
    };
  });

  describe(':turnsoff and aliases', () => {
    it.each([
      ':turnsoff',
      '/turnsoff',
      ':turns off',
      '/turns off',
      ':turn off',
      '/turn off',
      ':noturns',
    ])('turns off turn limit with %s', (cmd) => {
      const res = handleTurnCommand(cmd, ctx);
      expect(res).toEqual({ handled: true, newTurnsOverride: Infinity });
      expect(successMsg).toContain('Turn limit: OFF');
    });
  });

  describe(':turnson and aliases', () => {
    it.each([
      ':turnson',
      '/turnson',
      ':turns on',
      '/turns on',
      ':turn on',
      '/turn on',
    ])('turns on turn limit with %s', (cmd) => {
      const res = handleTurnCommand(cmd, ctx);
      expect(res).toEqual({ handled: true, newTurnsOverride: DEFAULT_MAX_TURNS });
      expect(successMsg).toContain(`Turn limit: ON (${DEFAULT_MAX_TURNS} turns cap per task)`);
    });

    it('uses configured defaultMaxTurns when provided', () => {
      ctx.defaultMaxTurns = 75;
      const res = handleTurnCommand(':turnson', ctx);
      expect(res).toEqual({ handled: true, newTurnsOverride: 75 });
      expect(successMsg).toContain('75 turns cap');
    });
  });

  describe(':turns <arg>', () => {
    it('sets custom numeric turn limit', () => {
      const res = handleTurnCommand(':turns 100', ctx);
      expect(res).toEqual({ handled: true, newTurnsOverride: 100 });
      expect(successMsg).toContain('Turn limit set to 100 turns');
    });

    it('sets 0 to Infinity (off)', () => {
      const res = handleTurnCommand(':turns 0', ctx);
      expect(res).toEqual({ handled: true, newTurnsOverride: Infinity });
      expect(successMsg).toContain('Turn limit: OFF');
    });

    it('supports :turns off and :turns on', () => {
      const resOff = handleTurnCommand(':turns off', ctx);
      expect(resOff).toEqual({ handled: true, newTurnsOverride: Infinity });

      const resOn = handleTurnCommand(':turns on', ctx);
      expect(resOn).toEqual({ handled: true, newTurnsOverride: DEFAULT_MAX_TURNS });
    });

    it('warns on invalid turn count', () => {
      const res = handleTurnCommand(':turns invalid', ctx);
      expect(res).toEqual({ handled: true });
      expect(warningMsg).toContain('Invalid turn limit "invalid"');
    });

    it('warns on negative turn count', () => {
      const res = handleTurnCommand(':turns -5', ctx);
      expect(res).toEqual({ handled: true });
      expect(warningMsg).toContain('Invalid turn limit "-5"');
    });
  });

  describe(':turns (status check)', () => {
    it('shows default status when no override is active', () => {
      const res = handleTurnCommand(':turns', ctx);
      expect(res).toEqual({ handled: true });
      expect(successMsg).toContain(`Turn limit: ${DEFAULT_MAX_TURNS} turns per task (default)`);
    });

    it('shows OFF status when Infinity override is active', () => {
      ctx.turnsOverride = Infinity;
      const res = handleTurnCommand(':turns', ctx);
      expect(res).toEqual({ handled: true });
      expect(successMsg).toContain('Turn limit: OFF (unlimited turns per task)');
    });

    it('shows custom numeric override when active', () => {
      ctx.turnsOverride = 120;
      const res = handleTurnCommand('/turns', ctx);
      expect(res).toEqual({ handled: true });
      expect(successMsg).toContain('Turn limit: 120 turns per task (session override)');
    });
  });

  describe('unhandled commands', () => {
    it('returns null for non-turn commands so other handlers can run', () => {
      expect(handleTurnCommand(':help', ctx)).toBeNull();
      expect(handleTurnCommand(':model gpt-4', ctx)).toBeNull();
      expect(handleTurnCommand('fix something', ctx)).toBeNull();
    });
  });
});
