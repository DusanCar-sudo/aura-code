import chalk from 'chalk';
import { pickLanAddress } from '../server/lan.js';
import { createPairingCode, loadDevices, revokeDevice, devicesPath, pendingPairings } from '../server/devices.js';

const CYAN = '#3fb9d8';
const RUBY = '#b15439';

function heading(text: string): void {
  console.log('\n  ' + chalk.hex(CYAN).bold(text) + '\n');
}

function relativeAge(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function listDevices(): number {
  const devices = loadDevices();
  const waiting = pendingPairings();

  if (devices.length === 0 && waiting.length === 0) {
    heading('No paired devices');
    console.log('  Pair one with:  ' + chalk.hex(CYAN)('aura devices add "Mum\'s phone"') + '\n');
    return 0;
  }

  if (waiting.length > 0) {
    heading(`Waiting to pair (${waiting.length})`);
    for (const p of waiting) {
      const mins = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 60_000));
      console.log('  ' + chalk.bold(p.name) + '  code ' + chalk.hex(CYAN).bold(p.code)
        + chalk.dim(`  expires in ${mins}m`));
    }
    console.log('');
  }

  if (devices.length === 0) return 0;

  heading(`Paired devices (${devices.length})`);
  const width = Math.max(...devices.map(d => d.name.length), 4);
  for (const d of devices) {
    console.log(
      '  ' + chalk.bold(d.name.padEnd(width))
      + '  ' + chalk.dim(d.id)
      + '  ' + chalk.dim('last seen ' + relativeAge(d.lastSeenAt)),
    );
  }
  console.log('\n  ' + chalk.dim(devicesPath()) + '\n');
  return 0;
}

function addNamedDevice(name: string, port: number): number {
  if (!name.trim()) {
    console.error(chalk.hex(RUBY)('\n  Give the device a name, e.g. aura devices add "Mum\'s phone"\n'));
    return 1;
  }

  const pairing = createPairingCode(name);
  const minutes = Math.max(1, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 60_000));

  const wifi = pickLanAddress();

  heading(`Pairing "${pairing.name}"`);
  console.log('  Type this code into the phone:\n');
  console.log('    ' + chalk.hex(CYAN).bold(pairing.code.split('').join(' ')) + '\n');
  console.log('  On that phone, open Aura and enter:\n');
  if (wifi) {
    console.log('    Address  ' + chalk.bold(wifi.address) + chalk.dim(`   (Wi-Fi, ${wifi.iface})`));
  } else {
    console.log('    Address  ' + chalk.bold('127.0.0.1') + chalk.dim('   (over USB)'));
  }
  console.log('    Port     ' + chalk.bold(String(port)));
  console.log('    Code     ' + chalk.bold(pairing.code) + '\n');
  if (wifi) {
    console.log('  Wi-Fi needs the server started with '
      + chalk.hex(CYAN)('aura serve --lan') + '. Same network, no cable.');
    console.log('  ' + chalk.dim('Over USB instead: use 127.0.0.1 and run ')
      + chalk.hex(CYAN)(`adb reverse tcp:${port} tcp:${port}`) + '\n');
  } else {
    console.log('  Over USB, first run:  ' + chalk.hex(CYAN)(`adb reverse tcp:${port} tcp:${port}`) + '\n');
  }
  console.log(chalk.dim(`  Valid ${minutes} minutes, once. The phone swaps it for a long token`));
  console.log(chalk.dim('  and stores that, so nobody ever types the long one.') + '\n');
  return 0;
}

function revokeNamedDevice(idOrName: string): number {
  if (!idOrName.trim()) {
    console.error(chalk.hex(RUBY)('\n  Which device? Run `aura devices` to see their ids.\n'));
    return 1;
  }
  const removed = revokeDevice(idOrName);
  if (!removed) {
    console.error(chalk.hex(RUBY)(`\n  No paired device matches "${idOrName}".\n`));
    return 1;
  }
  // The token is only ever compared against the stored hash, so deleting the
  // row is the whole revocation — there is no cached copy to invalidate.
  // A device holding the old token is refused at the next handshake.
  console.log('\n  ' + chalk.hex(CYAN)('Revoked') + ` "${removed.name}". `
    + chalk.dim('It will be refused at its next connection.') + '\n');
  return 0;
}

/** Returns the process exit code. */
export async function runDevices(sub: string, args: string[], port = 7337): Promise<number> {
  switch (sub) {
    case 'list':
      return listDevices();
    case 'add':
      return addNamedDevice(args.join(' '), port);
    case 'revoke':
    case 'remove':
      return revokeNamedDevice(args.join(' '));
    default:
      console.error(chalk.hex(RUBY)(`\n  Unknown: aura devices ${sub}`));
      console.log('  Usage: aura devices [list | add <name> | revoke <id|name>]\n');
      return 1;
  }
}
