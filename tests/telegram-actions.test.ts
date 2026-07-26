import { describe, it, expect } from 'vitest';
import {
  parseAgentAction, stripDirectives, hasToolCallResidue, claimsDelivery,
} from '../src/tools/telegram-actions.js';

/**
 * The XML fixtures below are verbatim assistant messages from the production
 * session store (~/.aura/sessions/telegram/8519031951.json, indices 4, 8, 16,
 * 18, 20, 34). Every one of them was rendered to the user as chat text and
 * executed nothing. They are the regression bar.
 */
describe('parseAgentAction — XML dialect (real leaked payloads)', () => {
  it('[4] parses <tool_call> wrapper + named parameter, discarding the preamble', () => {
    const a = parseAgentAction(
      'Let me check the Data1 partition first, then download all three TTS models.<tool_call>\n' +
      '<function=run>\n' +
      '<parameter=command>df -h /mnt/Data1 2>/dev/null || findmnt -T /mnt/Data1 2>/dev/null; lsblk | grep -i data</parameter>\n' +
      '</function>\n</tool_call>',
    );
    expect(a?.verb).toBe('RUN');
    expect(a?.arg).toBe('df -h /mnt/Data1 2>/dev/null || findmnt -T /mnt/Data1 2>/dev/null; lsblk | grep -i data');
    expect(a?.arg).not.toContain('Let me check');
    expect(a?.arg).not.toContain('<');
  });

  it('[18] parses an UNNAMED <parameter> tag', () => {
    const a = parseAgentAction(
      'Let me check the current Ollama setup.<tool_call>\n<function=run>\n' +
      '<parameter>ps aux | grep ollama | grep -v grep; ollama list 2>/dev/null</parameter>\n' +
      '</function>\n</tool_call>',
    );
    expect(a?.verb).toBe('RUN');
    expect(a?.arg).toBe('ps aux | grep ollama | grep -v grep; ollama list 2>/dev/null');
  });

  it('[20] parses a single-line cam call with an unclosed, valueless parameter', () => {
    const a = parseAgentAction('<function=cam><parameter=default></function>');
    expect(a).toEqual({ verb: 'CAM', arg: '' });   // empty arg → default device
  });

  it('[34] parses a bare <function=...> with no <tool_call> wrapper', () => {
    const a = parseAgentAction(
      '<function=run>\n<parameter=command>crontab -l 2>/dev/null; cat /proc/loadavg</parameter>\n</function>',
    );
    expect(a?.verb).toBe('RUN');
    expect(a?.arg).toBe('crontab -l 2>/dev/null; cat /proc/loadavg');
  });

  it('preserves a multi-line command body verbatim', () => {
    const a = parseAgentAction('<function=run><parameter=command>echo one\necho two</parameter></function>');
    expect(a?.arg).toBe('echo one\necho two');
  });

  it('executes a truncated call rather than leaking it', () => {
    const a = parseAgentAction('<function=run><parameter=command>uptime');
    expect(a).toEqual({ verb: 'RUN', arg: 'uptime' });
  });

  it('maps alias function names onto the executor verbs', () => {
    expect(parseAgentAction('<function=shell><parameter=command>ls</parameter></function>')?.verb).toBe('RUN');
    expect(parseAgentAction('<function=webcam></function>')?.verb).toBe('CAM');
    expect(parseAgentAction('<function=send_file><parameter=path>/tmp/a.png</parameter></function>')).toEqual(
      { verb: 'SEND', arg: '/tmp/a.png' },
    );
  });

  it('refuses an unknown function name instead of guessing a verb', () => {
    expect(parseAgentAction('<function=rm_rf><parameter=command>rm -rf /</parameter></function>')).toBeNull();
  });

  it('never lets markup reach the shell argument', () => {
    const a = parseAgentAction('<function=run><parameter=command>ls</parameter><parameter=x>y</parameter></function>');
    expect(a?.arg).not.toMatch(/<|>/);
  });
});

describe('parseAgentAction — bare dialect still works', () => {
  it('parses a plain RUN: line', () => {
    expect(parseAgentAction('RUN: ps aux | head -5')).toEqual({ verb: 'RUN', arg: 'ps aux | head -5' });
  });

  it('tolerates markdown wrapping', () => {
    expect(parseAgentAction('> `RUN: df -h`')).toEqual({ verb: 'RUN', arg: 'df -h' });
  });

  it('parses SEND and CAM', () => {
    expect(parseAgentAction('SEND: /tmp/x.png')).toEqual({ verb: 'SEND', arg: '/tmp/x.png' });
    expect(parseAgentAction('CAM: /dev/video1')).toEqual({ verb: 'CAM', arg: '/dev/video1' });
  });

  it('does not truncate an XML command that itself contains "RUN:"', () => {
    // XML must win, or the bare matcher would cut the command at RUN:.
    const a = parseAgentAction('<function=run><parameter=command>grep -r "RUN:" /etc</parameter></function>');
    expect(a?.arg).toBe('grep -r "RUN:" /etc');
  });

  it('returns null for ordinary conversation', () => {
    expect(parseAgentAction('Dobro sam, Dušane. Kako si ti?')).toBeNull();
    expect(parseAgentAction('The function returns a value.')).toBeNull();
  });
});

describe('stripDirectives', () => {
  it('removes a whole XML call, leaving the prose', () => {
    const out = stripDirectives(
      'Evo provere.<tool_call>\n<function=run>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>',
    );
    expect(out).toBe('Evo provere.');
    expect(out).not.toContain('<');
  });

  it('removes bare directives', () => {
    expect(stripDirectives('Checking.\nRUN: ls -la')).toBe('Checking.');
  });

  it('removes an unclosed call', () => {
    expect(stripDirectives('Evo.<function=run><parameter=command>ls')).toBe('Evo.');
  });
});

describe('hasToolCallResidue', () => {
  it('detects markup', () => {
    expect(hasToolCallResidue('<function=rm_rf>')).toBe(true);
    expect(hasToolCallResidue('</parameter>')).toBe(true);
  });

  it('is stable across repeated calls on the same input', () => {
    // A shared /g regex would alternate true/false here via lastIndex.
    const s = '<function=run>';
    expect([hasToolCallResidue(s), hasToolCallResidue(s), hasToolCallResidue(s)]).toEqual([true, true, true]);
  });

  it('does not fire on ordinary prose about functions', () => {
    expect(hasToolCallResidue('The function is defined in loop.ts')).toBe(false);
    expect(hasToolCallResidue('a < b and c > d')).toBe(false);
  });
});

describe('claimsDelivery', () => {
  it('catches the exact fabricated claims from production', () => {
    expect(claimsDelivery('Done, Dušan. Snapshot taken and sent to you right here on Telegram.')).toBe(true);
    expect(claimsDelivery('Webcam picture just sent. 😊')).toBe(true);
  });

  it('ignores ordinary conversation', () => {
    expect(claimsDelivery('Dobro sam, hvala. Kako si ti?')).toBe(false);
    expect(claimsDelivery('I can take a webcam photo if you want.')).toBe(false); // no delivery word
  });
});
