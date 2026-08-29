#!/usr/bin/env node
/**
 * `webaura` — start Aura's web client and open it.
 *
 * A second binary rather than a flag, because `aura` with no arguments starts
 * the TUI: any name beginning with `aura` reads like "the TUI, but…" and the
 * one thing this must not do is drop the user into the terminal UI they were
 * trying to avoid. Hence `webaura`, which cannot be mistaken for it.
 *
 * Everything it does is `aura serve` plus opening a browser. It spawns rather
 * than imports for the reason given in web-launcher.ts.
 */

import chalk from 'chalk';
import { launchWebServer } from './web-launcher.js';
import { FAINT_HEX } from './diamond.js';

const args = process.argv.slice(2);

if (args[0] === '--help' || args[0] === '-h') {
  console.log(`
  ${chalk.hex('#cc785c').bold('webaura')} — Aura's web client

  ${chalk.hex(FAINT_HEX)('webaura')}                 start the server and open it in your browser
  ${chalk.hex(FAINT_HEX)('webaura --port 8080')}     serve on a different port
  ${chalk.hex(FAINT_HEX)('webaura --no-open')}       start it, but do not open a browser

  Every other flag is passed straight through to ${chalk.hex(FAINT_HEX)('aura serve')}.
  Stop it with Ctrl+C.
`);
  process.exit(0);
}

// --no-open is ours, not the server's, so it must not be forwarded.
const noOpen = args.includes('--no-open');
const forwarded = args.filter((a) => a !== '--no-open');

const child = launchWebServer({
  args: forwarded,
  open: !noOpen,
  onUrl: (url) => {
    if (noOpen) return;
    console.log(chalk.hex(FAINT_HEX)(`\n  Opening ${url}\n`));
  },
});

// Forward the signal rather than dying first: the server owns sessions, and
// killing this wrapper while leaving it running would strand a port.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { child.kill(signal); });
}

child.on('exit', (code) => process.exit(code ?? 0));
