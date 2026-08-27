import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { auraHome, auraPath } from '../../src/util/aura-home.js';

afterEach(() => vi.unstubAllEnvs());

describe('auraHome', () => {
  it('defaults to ~/.aura', () => {
    vi.stubEnv('AURA_HOME', '');
    expect(auraHome()).toBe(path.join(os.homedir(), '.aura'));
  });

  it('honours AURA_HOME', () => {
    vi.stubEnv('AURA_HOME', '/tmp/elsewhere');
    expect(auraHome()).toBe('/tmp/elsewhere');
  });

  it('resolves per call, so a value set after import still applies', () => {
    vi.stubEnv('AURA_HOME', '/tmp/first');
    expect(auraHome()).toBe('/tmp/first');
    vi.stubEnv('AURA_HOME', '/tmp/second');
    // A module-level constant would still be returning /tmp/first here. That
    // is the bug this helper exists to make impossible.
    expect(auraHome()).toBe('/tmp/second');
  });

  it('treats an empty or whitespace value as unset, not as the filesystem root', () => {
    vi.stubEnv('AURA_HOME', '   ');
    expect(auraHome()).toBe(path.join(os.homedir(), '.aura'));
  });
});

describe('auraPath', () => {
  it('joins under the home', () => {
    vi.stubEnv('AURA_HOME', '/tmp/h');
    expect(auraPath('memory', 'identity.json')).toBe('/tmp/h/memory/identity.json');
  });

  it('with no segments is the home itself', () => {
    vi.stubEnv('AURA_HOME', '/tmp/h');
    expect(auraPath()).toBe('/tmp/h');
  });
});

describe('every state path follows AURA_HOME', () => {
  const HOME = '/tmp/aura-home-probe';
  beforeEach(() => vi.stubEnv('AURA_HOME', HOME));

  /**
   * The regression this whole change exists for: AURA_HOME used to be honoured
   * by four modules and ignored by twenty-two, so setting it relocated memory
   * and consent while leaving Telegram config, email, sessions, recordings,
   * plugins and the queue behind. Each of these came from a different file.
   */
  it('covers memory, consent, lessons, episodes and plugins', async () => {
    const [memory, disclosure, learning, episodic, plugins, screenLessons] = await Promise.all([
      import('../../src/agent/unified-memory.js'),
      import('../../src/tools/screen/disclosure.js'),
      import('../../src/agent/learning.js'),
      import('../../src/agent/episodic-memory.js'),
      import('../../src/plugins/loader.js'),
      import('../../src/tools/screen/lessons.js'),
    ]);

    // Only genuinely exported path functions — an entry that fell back to a
    // default would assert nothing while looking like coverage.
    const paths: Array<[string, string]> = [
      ['identity',        memory.identityFile()],
      ['global lessons',  memory.globalLessonsFile()],
      ['computer-use ack', disclosure.acknowledgementPath()],
      ['learned lessons', learning.globalLessonsPath()],
      ['episodes',        episodic.episodesPath()],
      ['plugins',         plugins.pluginsDir()],
      ['marketplaces',    plugins.marketplacesDir()],
      ['screen lessons',  screenLessons.lessonsPath()],
    ];

    for (const [what, p] of paths) {
      expect(p, `${what} (${p}) escaped AURA_HOME`).toContain(HOME);
    }
    expect(paths).toHaveLength(8);
  });
});
