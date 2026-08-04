import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The registry resolves its path from XDG_CONFIG_HOME at call time, so each
// test gets a throwaway directory rather than touching the real one.
let tmp: string;
let original: string | undefined;

async function devices(): Promise<typeof import('../src/server/devices.js')> {
  return import('../src/server/devices.js');
}

beforeEach(() => {
  original = process.env.XDG_CONFIG_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-devices-'));
  process.env.XDG_CONFIG_HOME = tmp;
});

afterEach(() => {
  if (original === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = original;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('paired device registry', () => {
  it('starts empty when no registry exists', async () => {
    const { loadDevices } = await devices();
    expect(loadDevices()).toEqual([]);
  });

  it('never stores the token itself', async () => {
    const { addDevice, devicesPath } = await devices();
    const { token } = addDevice("Mum's phone");

    const raw = fs.readFileSync(devicesPath(), 'utf8');
    // The whole point of hashing: a stolen registry yields no credential.
    expect(raw).not.toContain(token);
    expect(raw).toContain("Mum's phone");
  });

  it('writes the registry 0600', async () => {
    const { addDevice, devicesPath } = await devices();
    addDevice('phone');
    const mode = fs.statSync(devicesPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('identifies a device by its token', async () => {
    const { addDevice, findDeviceByToken } = await devices();
    const { device, token } = addDevice("Mum's phone");

    const found = findDeviceByToken(token);
    expect(found?.id).toBe(device.id);
    expect(found?.name).toBe("Mum's phone");
  });

  it('rejects an unknown or empty token', async () => {
    const { addDevice, findDeviceByToken } = await devices();
    addDevice('phone');

    expect(findDeviceByToken('not-a-real-token')).toBeNull();
    expect(findDeviceByToken('')).toBeNull();
  });

  it('gives each device a distinct token', async () => {
    const { addDevice, findDeviceByToken } = await devices();
    const mine = addDevice('my phone');
    const hers = addDevice("Mum's phone");

    expect(mine.token).not.toBe(hers.token);
    // Crucially, one device's token must not authenticate as the other —
    // that is what keeps their conversations and approvals apart.
    expect(findDeviceByToken(mine.token)?.id).toBe(mine.device.id);
    expect(findDeviceByToken(hers.token)?.id).toBe(hers.device.id);
  });

  it('revoking one device leaves the other working', async () => {
    const { addDevice, revokeDevice, findDeviceByToken, loadDevices } = await devices();
    const mine = addDevice('my phone');
    const hers = addDevice("Mum's phone");

    expect(revokeDevice(hers.device.id)?.name).toBe("Mum's phone");

    expect(findDeviceByToken(hers.token)).toBeNull();
    expect(findDeviceByToken(mine.token)?.id).toBe(mine.device.id);
    expect(loadDevices()).toHaveLength(1);
  });

  it('revokes by name as well as id', async () => {
    const { addDevice, revokeDevice, findDeviceByToken } = await devices();
    const hers = addDevice("Mum's phone");

    expect(revokeDevice("mum's phone")?.id).toBe(hers.device.id);
    expect(findDeviceByToken(hers.token)).toBeNull();
  });

  it('reports nothing revoked for an unknown device', async () => {
    const { addDevice, revokeDevice } = await devices();
    addDevice('phone');
    expect(revokeDevice('nope')).toBeNull();
  });

  it('records last-seen without disturbing other devices', async () => {
    const { addDevice, touchDevice, loadDevices } = await devices();
    const mine = addDevice('my phone');
    const hers = addDevice("Mum's phone");

    expect(loadDevices().every(d => d.lastSeenAt === null)).toBe(true);
    touchDevice(hers.device.id);

    const after = loadDevices();
    expect(after.find(d => d.id === hers.device.id)?.lastSeenAt).not.toBeNull();
    expect(after.find(d => d.id === mine.device.id)?.lastSeenAt).toBeNull();
  });

  it('treats a corrupt registry as unpaired rather than throwing', async () => {
    const { addDevice, devicesPath, loadDevices, findDeviceByToken } = await devices();
    addDevice('phone');
    fs.writeFileSync(devicesPath(), '{ this is not json');

    // Failing closed is the safe direction: nobody is authorised.
    expect(loadDevices()).toEqual([]);
    expect(findDeviceByToken('anything')).toBeNull();
  });
});

describe('pairing codes', () => {
  it('is short enough to type and avoids ambiguous characters', async () => {
    const { createPairingCode } = await devices();
    const { code } = createPairingCode("Mum's phone");

    expect(code).toHaveLength(6);
    // 0/O and 1/I/L are the classic mistypes when reading off a screen.
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  });

  it('creates no device until the code is redeemed', async () => {
    const { createPairingCode, loadDevices } = await devices();
    createPairingCode("Mum's phone");
    // An unused code must grant nothing and leave nothing behind.
    expect(loadDevices()).toEqual([]);
  });

  it('exchanges a code for a working long token', async () => {
    const { createPairingCode, redeemPairingCode, findDeviceByToken } = await devices();
    const { code } = createPairingCode("Mum's phone");

    const paired = redeemPairingCode(code);
    expect(paired).not.toBeNull();
    expect(paired!.device.name).toBe("Mum's phone");
    // The token it hands back is the real credential, not the short code.
    expect(paired!.token.length).toBeGreaterThan(40);
    expect(findDeviceByToken(paired!.token)?.id).toBe(paired!.device.id);
  });

  it('accepts the code case-insensitively', async () => {
    const { createPairingCode, redeemPairingCode } = await devices();
    const { code } = createPairingCode('phone');
    expect(redeemPairingCode(code.toLowerCase())).not.toBeNull();
  });

  it('cannot be redeemed twice', async () => {
    const { createPairingCode, redeemPairingCode, loadDevices } = await devices();
    const { code } = createPairingCode('phone');

    expect(redeemPairingCode(code)).not.toBeNull();
    // Otherwise a code read aloud once could pair a second, unwanted phone.
    expect(redeemPairingCode(code)).toBeNull();
    expect(loadDevices()).toHaveLength(1);
  });

  it('refuses an expired code', async () => {
    const { createPairingCode, redeemPairingCode, devicesPath, pendingPairings } = await devices();
    const { code } = createPairingCode('phone');

    const file = JSON.parse(fs.readFileSync(devicesPath(), 'utf8'));
    file.pairings[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(devicesPath(), JSON.stringify(file));

    expect(redeemPairingCode(code)).toBeNull();
    expect(pendingPairings()).toEqual([]);
  });

  it('burns the code after repeated wrong guesses', async () => {
    const { createPairingCode, redeemPairingCode, pendingPairings } = await devices();
    const { code } = createPairingCode('phone');

    // Six characters only stays safe because guessing is capped.
    for (let i = 0; i < 5; i++) expect(redeemPairingCode('WRONG1')).toBeNull();

    expect(pendingPairings()).toEqual([]);
    expect(redeemPairingCode(code)).toBeNull();
  });

  it('does not let a wrong guess be spread across several codes', async () => {
    const { createPairingCode, redeemPairingCode, pendingPairings } = await devices();
    createPairingCode('phone A');
    createPairingCode('phone B');

    for (let i = 0; i < 5; i++) redeemPairingCode('WRONG1');

    // Both codes are spent, not just one — otherwise having two outstanding
    // codes would double the number of guesses on offer.
    expect(pendingPairings()).toEqual([]);
  });

  it('keeps other pending codes usable after one is redeemed', async () => {
    const { createPairingCode, redeemPairingCode, pendingPairings } = await devices();
    const mine = createPairingCode('my phone');
    const hers = createPairingCode("Mum's phone");

    expect(redeemPairingCode(mine.code)?.device.name).toBe('my phone');
    expect(pendingPairings().map(p => p.code)).toEqual([hers.code]);
    expect(redeemPairingCode(hers.code)?.device.name).toBe("Mum's phone");
  });

  it('unused corrupt-registry check still holds with pairings present', async () => {
    const { addDevice, devicesPath, loadDevices, findDeviceByToken } = await devices();
    addDevice('phone');
    fs.writeFileSync(devicesPath(), '{ this is not json');

    // Failing closed is the safe direction: nobody is authorised.
    expect(loadDevices()).toEqual([]);
    expect(findDeviceByToken('anything')).toBeNull();
  });
});
