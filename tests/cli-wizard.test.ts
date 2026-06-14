/**
 * Integration test: launch the CLI as a child process with a fully cleaned
 * env, pipe in wizard choices, and verify a global config gets saved.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI = path.resolve(__dirname, '../dist/cli/index.js');

function runCliWithCleanEnv(input: string, configDir: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: configDir,
        XDG_CONFIG_HOME: configDir,
        TERM: 'dumb',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', reject);
    // Feed input line-by-line with small delays so readline can process each
    // question() callback separately (mimics human typing).
    const lines = input.split('\n');
    let i = 0;
    const feed = () => {
      if (i >= lines.length) return;
      proc.stdin.write(lines[i] + '\n');
      i++;
      setTimeout(feed, 50);
    };
    setTimeout(feed, 100);  // let the wizard print its first prompt first
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 8000);
    proc.on('close', () => clearTimeout(killTimer));
  });
}

describe('CLI integration: first-run wizard', () => {
  let tmpConfigDir: string;
  let origXdg: string | undefined;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-int-'));
    origXdg = process.env.XDG_CONFIG_HOME;
    origHome = process.env.HOME;
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.HOME = tmpConfigDir;
  });
  afterEach(() => {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it('saves global config after wizard completes (pick Xiaomi, first model, default baseUrl)', async () => {
    // Choices: 4 (Xiaomi) → tp-fake-key → 1 (first model: mimo-v2.5-pro) → empty (default baseUrl)
    const input = '4\ntp-fake-key-test\n1\n\n';
    const result = await runCliWithCleanEnv(input, tmpConfigDir);

    // Wizard should have written the config file at $XDG_CONFIG_HOME/aura-code/config.json
    const configPath = path.join(tmpConfigDir, 'aura-code', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.provider).toBe('xiaomi');
    expect(cfg.apiKeyEnv).toBe('XIAOMI_API_KEY');
    expect(cfg.defaultModel).toBe('mimo-v2.5-pro');
    expect(cfg.baseUrl).toBe('https://token-plan-sgp.xiaomimimo.com/v1');
    expect(cfg.createdAt).toBeTruthy();
  });

  it('runs the wizard when no env vars are set and no global config exists', async () => {
    const input = '4\ntp-fake-key\n1\n\n';
    const result = await runCliWithCleanEnv(input, tmpConfigDir);
    // Should NOT show "No model configured" error
    expect(result.stderr).not.toContain('No model configured');
    // Should mention "Welcome"
    expect(result.stdout).toContain('Welcome to Aura');
  });

  it('bypasses the wizard when --no-setup is given (then errors about no model)', async () => {
    const proc = spawn('node', [CLI, '--no-setup'], {
      env: { PATH: '/usr/bin:/bin', HOME: tmpConfigDir, XDG_CONFIG_HOME: tmpConfigDir, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    await new Promise<void>((res) => { proc.on('close', () => res()); proc.stdin.end(); });
    expect(stderr).toContain('No model configured');
    // No config should be written
    const configPath = path.join(tmpConfigDir, 'aura-code', 'config.json');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('bypasses the wizard when --api-key is given (then tries to use that key)', async () => {
    const proc = spawn('node', [CLI, '--api-key', 'cli-supplied-key', '--model', 'gpt-4o'], {
      env: { PATH: '/usr/bin:/bin', HOME: tmpConfigDir, XDG_CONFIG_HOME: tmpConfigDir, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    await new Promise<void>((res) => { proc.on('close', () => res()); proc.stdin.end(); });
    // Wizard should NOT have run (no "Welcome" in stdout)
    expect(stdout).not.toContain('Welcome to Aura');
  });
});
