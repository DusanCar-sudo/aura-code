import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const version: string = JSON.parse(read('package.json')).version;

describe('version sync', () => {
  it('package-lock.json matches package.json', () => {
    expect(JSON.parse(read('package-lock.json')).version).toBe(version);
  });

  it('README badge shows the package version', () => {
    expect(read('README.md')).toContain(`version-v${version}-`);
  });

  it('AGENTS.md names the package version', () => {
    expect(read('AGENTS.md')).toContain(`\`aura-code\` (v${version})`);
  });

  it('CHANGELOG has an entry for the package version', () => {
    expect(read('CHANGELOG.md')).toContain(`## [${version}]`);
  });

  it('site manual shows only the package version', () => {
    // v0.x only: the manual also quotes the Node.js version (v20.x).
    const found = new Set(read('site/aura-windows-manual.html').match(/v0\.\d+\.\d+/g) ?? []);
    expect([...found]).toEqual([`v${version}`]);
  });
});
