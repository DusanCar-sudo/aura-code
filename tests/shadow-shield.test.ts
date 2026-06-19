import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Shadow Shield tests
// ─────────────────────────────────────────────────────────────────────────────

// Mock child_process, fs, and fetch before importing
vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => Buffer.from('fake-image-data')),
    statSync: vi.fn(() => ({ size: 12345, mtime: new Date() })),
    copyFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Need to mock global fetch
const mockFetch = vi.fn();
(globalThis as any).fetch = mockFetch;

describe('shadow-shield', () => {
  let shadowShield: typeof import('../src/tools/shadow-shield.js').shadowShield;
  let SHADOW_SHIELD_DEFINITION: typeof import('../src/tools/shadow-shield.js').SHADOW_SHIELD_DEFINITION;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }),
    });

    // Re-import to get fresh module state
    const mod = await import('../src/tools/shadow-shield.js');
    shadowShield = mod.shadowShield;
    SHADOW_SHIELD_DEFINITION = mod.SHADOW_SHIELD_DEFINITION;
  });

  afterEach(() => {
    // Always stop after each test to prevent timer leaks
    try {
      shadowShield({ action: 'stop' });
    } catch { /* ok */ }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tool definition
  // ─────────────────────────────────────────────────────────────────────────

  it('exports a valid tool definition', () => {
    expect(SHADOW_SHIELD_DEFINITION.name).toBe('shadow_shield');
    expect(SHADOW_SHIELD_DEFINITION.description).toContain('surveillance');
    expect(SHADOW_SHIELD_DEFINITION.parameters.required).toContain('action');
  });

  it('defines all actions in the schema', () => {
    const actionDesc = SHADOW_SHIELD_DEFINITION.parameters.properties.action.description;
    expect(actionDesc).toContain('start');
    expect(actionDesc).toContain('stop');
    expect(actionDesc).toContain('status');
    expect(actionDesc).toContain('snapshot');
    expect(actionDesc).toContain('scan');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Status (when inactive)
  // ─────────────────────────────────────────────────────────────────────────

  it('reports inactive status initially', async () => {
    const result = await shadowShield({ action: 'status' });
    expect(result).toContain('INACTIVE');
    expect(result).toContain('Scans completed: 0');
    expect(result).toContain('Alerts sent: 0');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Stop (when not running)
  // ─────────────────────────────────────────────────────────────────────────

  it('reports not running when stopped while inactive', async () => {
    const result = await shadowShield({ action: 'stop' });
    expect(result).toContain('not running');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Start
  // ─────────────────────────────────────────────────────────────────────────

  it('starts surveillance and reports active', async () => {
    const { execSync } = await import('child_process');
    // Mock ffmpeg available
    (execSync as any).mockReturnValue(Buffer.from(''));
    // Mock volumedetect output
    (execSync as any).mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('volumedetect')) {
        return Buffer.from('[Parsed_volumedetect_0 @ 0x123] max_volume: -20.0 dB\n[Parsed_volumedetect_0 @ 0x123] mean_volume: -35.0 dB');
      }
      return Buffer.from('');
    });

    // Mock fs for photo to exist
    const fs = await import('fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(Buffer.from('fake-jpeg-data-12345'));
    (fs.statSync as any).mockReturnValue({ size: 50000 });

    const result = await shadowShield({ action: 'start', interval_minutes: 10 });

    expect(result).toContain('Shadow Shield ACTIVATED');
    expect(result).toContain('10 minutes');
    expect(result).toContain('/dev/video0');
  });

  it('rejects double start', async () => {
    const { execSync } = await import('child_process');
    (execSync as any).mockReturnValue(Buffer.from(''));
    const fs = await import('fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(Buffer.from('data'));
    (fs.statSync as any).mockReturnValue({ size: 100 });

    await shadowShield({ action: 'start' });
    const result = await shadowShield({ action: 'start' });

    expect(result).toContain('already running');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Stop after start
  // ─────────────────────────────────────────────────────────────────────────

  it('stops and reports summary', async () => {
    const { execSync } = await import('child_process');
    (execSync as any).mockReturnValue(Buffer.from(''));
    const fs = await import('fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(Buffer.from('data'));
    (fs.statSync as any).mockReturnValue({ size: 100 });

    await shadowShield({ action: 'start' });
    const result = await shadowShield({ action: 'stop' });

    expect(result).toContain('Shadow Shield DEACTIVATED');
    expect(result).toContain('Scans completed:');
    expect(result).toContain('Alerts sent:');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Status after start
  // ─────────────────────────────────────────────────────────────────────────

  it('shows active status with configuration', async () => {
    const { execSync } = await import('child_process');
    (execSync as any).mockReturnValue(Buffer.from(''));
    const fs = await import('fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(Buffer.from('data'));
    (fs.statSync as any).mockReturnValue({ size: 100 });

    await shadowShield({ action: 'start', interval_minutes: 5, sensitivity: 3 });
    const result = await shadowShield({ action: 'status' });

    expect(result).toContain('ACTIVE');
    expect(result).toContain('5 minutes');
    expect(result).toContain('Sensitivity: 3');
    expect(result).toContain('Last snapshot:');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Snapshot (single shot)
  // ─────────────────────────────────────────────────────────────────────────

  it('takes a snapshot and sends to Telegram', async () => {
    const { execSync } = await import('child_process');
    (execSync as any).mockReturnValue(Buffer.from(''));
    const fs = await import('fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(Buffer.from('jpeg-data'));
    (fs.statSync as any).mockReturnValue({ size: 42000 });

    // Need telegram config — mock it
    (fs.existsSync as any).mockImplementation((p: string) => {
      if (String(p).includes('telegram.json')) return true;
      return true;
    });
    (fs.readFileSync as any).mockImplementation((p: string) => {
      if (String(p).includes('telegram.json')) {
        return JSON.stringify({ bot_token: 'test-token', default_chat_id: '12345' });
      }
      return Buffer.from('jpeg-data');
    });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, result: { message_id: 99 } }),
    });

    const result = await shadowShield({ action: 'snapshot' });

    expect(result).toContain('sent to');
    expect(result).toContain('12345');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('sendPhoto'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('handles snapshot without Telegram config', async () => {
    const { execSync } = await import('child_process');
    (execSync as any).mockReturnValue(Buffer.from(''));
    const fs = await import('fs');
    (fs.existsSync as any).mockImplementation((p: string) => {
      if (String(p).includes('telegram.json')) return false;
      return true;
    });
    (fs.readFileSync as any).mockReturnValue(Buffer.from('jpeg-data'));
    (fs.statSync as any).mockReturnValue({ size: 42000 });

    const result = await shadowShield({ action: 'snapshot' });

    expect(result).toContain('not configured');
    expect(result).toContain('saved at');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scan (one-time)
  // ─────────────────────────────────────────────────────────────────────────

  it('performs a one-time scan without starting the loop', async () => {
    const { execSync } = await import('child_process');
    (execSync as any).mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('volumedetect')) {
        return Buffer.from('max_volume: -10.0 dB\nmean_volume: -30.0 dB');
      }
      return Buffer.from('');
    });
    const fs = await import('fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(Buffer.from('jpeg-data'));
    (fs.statSync as any).mockReturnValue({ size: 30000 });

    const result = await shadowShield({ action: 'scan' });

    expect(result).toContain('sweep #');
    expect(result).toContain('Snapshot:');
    expect(result).toContain('Audio:');

    // Verify not running
    const status = await shadowShield({ action: 'status' });
    expect(status).toContain('INACTIVE');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unknown action
  // ─────────────────────────────────────────────────────────────────────────

  it('returns error for unknown action', async () => {
    const result = await shadowShield({ action: 'nonexistent' as any });
    expect(result).toContain('Unknown');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Custom configuration
  // ─────────────────────────────────────────────────────────────────────────

  it('accepts custom video and audio devices', async () => {
    const { execSync } = await import('child_process');
    (execSync as any).mockReturnValue(Buffer.from(''));
    const fs = await import('fs');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(Buffer.from('data'));
    (fs.statSync as any).mockReturnValue({ size: 100 });

    const result = await shadowShield({
      action: 'start',
      video_device: '/dev/video2',
      audio_device: 'hw:1,0',
    });

    expect(result).toContain('/dev/video2');
    expect(result).toContain('hw:1,0');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ffmpeg not available
  // ─────────────────────────────────────────────────────────────────────────

  it('reports error when ffmpeg is not installed', async () => {
    const { execSync } = await import('child_process');
    (execSync as any).mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('which ffmpeg')) {
        throw new Error('not found');
      }
      return Buffer.from('');
    });

    const result = await shadowShield({ action: 'start' });

    expect(result).toContain('ffmpeg not installed');
  });
});
