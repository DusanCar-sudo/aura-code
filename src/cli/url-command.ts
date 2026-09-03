import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import chalk from 'chalk';
import { auraPath } from '../util/aura-home.js';
import { openExternal } from '../util/open.js';

const CYAN = '#3fb9d8';
const RUBY = '#b15439';
const SAGE = '#5a9e6e';

interface TokenRecord {
  token: string;
  pid: number;
  startedAt: number;
}

function readTokenRecord(port: number): TokenRecord | null {
  // The global file (`~/.aura/tokens/<port>.json`) is the canonical source —
  // it is keyed correctly regardless of which directory `aura url` is run
  // from. The project-local copy (`<cwd>/.aura/tokens/<port>.json`) is a
  // fallback for the rare case the home write failed but the project one
  // didn't (e.g. a read-only home during a container run).
  const candidates = [
    auraPath('tokens', `${port}.json`),
    path.join(process.cwd(), '.aura', 'tokens', `${port}.json`),
  ];
  for (const file of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw.token === 'string') return raw as TokenRecord;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function pidLooksAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing — it only checks whether the process exists
    // and is ours to signal, so this never actually touches the server.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function probe(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

export async function runUrl(port: number, opts: { open?: boolean } = {}): Promise<number> {
  const record = readTokenRecord(port);
  if (!record) {
    console.error(chalk.hex(RUBY)(`\n  No aura serve session found on port ${port}.`));
    console.log('  Start one with:  ' + chalk.hex(CYAN)(`aura serve --port ${port}`) + '\n');
    return 1;
  }

  const url = `http://127.0.0.1:${port}/?token=${record.token}`;

  if (!pidLooksAlive(record.pid)) {
    console.error(chalk.hex(RUBY)(`\n  The server that minted this token (pid ${record.pid}) is not running.`));
    console.log('  Start a fresh one with:  ' + chalk.hex(CYAN)(`aura serve --port ${port}`) + '\n');
    return 1;
  }

  const status = await probe(url);
  if (status !== 200) {
    console.error(chalk.hex(RUBY)(
      status === null
        ? `\n  Nothing answered on 127.0.0.1:${port} — the process is alive but the port isn't up yet.`
        : `\n  The stored token was rejected (HTTP ${status}) — it's stale even though pid ${record.pid} is running.`,
    ));
    console.log('  Restart with:  ' + chalk.hex(CYAN)(`aura serve --port ${port}`) + '\n');
    return 1;
  }

  console.log('\n  ' + chalk.hex(SAGE)('✓ ') + chalk.bold('Live URL') + '\n');
  console.log('  ' + chalk.hex(CYAN)(url) + '\n');

  if (opts.open) openExternal(url);
  return 0;
}
