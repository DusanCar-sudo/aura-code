/**
 * Integration test: launch the CLI as a child process with a fully cleaned
 * env, pipe in wizard choices, and verify a global config gets saved.
 *
 * The wizard's Step 4 tests the connection for real, so these tests stand up
 * a local stub /chat/completions endpoint and steer the wizard at it — no
 * real network, deterministic timing.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { PROVIDER_REGISTRY } from '../src/setup/provider-registry.js';

const CLI = path.resolve(__dirname, '../dist/cli/index.js');

// The wizard menu is 1-based over PROVIDER_REGISTRY — derive Xiaomi's number
// instead of hardcoding it so registry additions don't silently re-aim the test.
const XIAOMI_CHOICE = String(PROVIDER_REGISTRY.findIndex(p => p.name === 'Xiaomi MiMo') + 1);

let stubServer: http.Server;
let stubBaseUrl: string;

beforeAll(async () => {
  stubServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise<void>(res => stubServer.listen(0, '127.0.0.1', res));
  const addr = stubServer.address() as { port: number };
  stubBaseUrl = `http://127.0.0.1:${addr.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>(res => stubServer.close(() => res()));
});

// Wizard walk-through for Xiaomi MiMo against the stub endpoint:
//   provider number → model 1 (mimo-v2.5-pro) → API key (deliberately NOT
//   tp-/sk- prefixed: a tp- key makes the wizard force the real Token Plan
//   host over our stub URL) → region default → stub base URL.
function wizardInput(): string {
  return `${XIAOMI_CHOICE}\n1\nfake-key-test\n\n${stubBaseUrl}\n`;
}

function runCliWithCleanEnv(input: string, configDir: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: configDir,
        XDG_CONFIG_HOME: configDir,
        TERM: 'dumb',
      },
      // Isolate cwd too: from the repo root the CLI would load the repo's
      // own .aura.json project config and think a model is configured.
      cwd: configDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const lines = input.split('\n').filter((_, idx, arr) => idx < arr.length - 1 || arr[idx] !== '');
    let sent = 0;
    let promptsSeen = 0;
    // The wizard's askInput defers rl.question by 30ms (paste-safety), so a
    // line written before its question is registered is emitted as an
    // unclaimed readline 'line' event and silently lost. Feed each answer
    // only after its "▸" prompt has actually been printed, with a delay
    // comfortably past the 30ms question registration.
    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      const prompts = (chunk.match(/▸/g) ?? []).length;
      for (let p = 0; p < prompts; p++) {
        promptsSeen++;
        if (sent < lines.length && sent < promptsSeen) {
          const line = lines[sent];
          sent++;
          setTimeout(() => proc.stdin.write(line + '\n'), 100);
        }
      }
      // Wizard outcome reached — the CLI would now sit in the REPL waiting on
      // stdin (which must stay open: an early EOF closes readline out from
      // under a pending deferred question). Kill instead.
      if (/Saved to|Setup cancelled/.test(stdout)) {
        setTimeout(() => proc.kill('SIGKILL'), 200);
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', reject);
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 15000);
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

  it('saves global config after wizard completes (pick Xiaomi, first model, stub baseUrl)', async () => {
    const result = await runCliWithCleanEnv(wizardInput(), tmpConfigDir);

    // Wizard should have written the config file at $XDG_CONFIG_HOME/aura-code/config.json
    const configPath = path.join(tmpConfigDir, 'aura-code', 'config.json');
    expect(fs.existsSync(configPath), `config.json missing.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.provider).toBe('Xiaomi MiMo');
    expect(cfg.apiKeyEnv).toBe('XIAOMI_API_KEY');
    expect(cfg.defaultModel).toBe('mimo-v2.5-pro');
    expect(cfg.baseUrl).toBe(stubBaseUrl);
    expect(cfg.createdAt).toBeTruthy();

    // The full provider config (incl. the key) lands next to it for the factory.
    const providerPath = path.join(tmpConfigDir, 'aura-code', 'provider.json');
    expect(fs.existsSync(providerPath)).toBe(true);
    const providerCfg = JSON.parse(fs.readFileSync(providerPath, 'utf8'));
    expect(providerCfg.apiKey).toBe('fake-key-test');
  });

  it('runs the wizard when no env vars are set and no global config exists', async () => {
    const result = await runCliWithCleanEnv(wizardInput(), tmpConfigDir);
    // Should NOT show "No model configured" error
    expect(result.stderr).not.toContain('No model configured');
    // Should show the wizard banner
    expect(result.stdout).toContain('Provider Setup Wizard');
  });

  it('bypasses the wizard when --no-setup is given (then errors about no model)', async () => {
    const proc = spawn('node', [CLI, '--no-setup'], {
      env: { PATH: '/usr/bin:/bin', HOME: tmpConfigDir, XDG_CONFIG_HOME: tmpConfigDir, TERM: 'dumb' },
      cwd: tmpConfigDir, // see runCliWithCleanEnv — avoid the repo's .aura.json
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
    // Wizard should NOT have run
    expect(stdout).not.toContain('Provider Setup Wizard');
  });
});
