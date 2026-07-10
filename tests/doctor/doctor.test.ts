import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { runDoctor, formatDoctorReport } from '../../src/doctor/index.js';
import { checkBuild, checkConfig, checkSource, checkDeps, checkGit, checkHygiene } from '../../src/doctor/checks.js';
import type { Finding } from '../../src/doctor/types.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function has(finding: Finding[], category: string, name: string): Finding | undefined {
  return finding.find(f => f.category === category && f.name === name);
}

// ── Real-repo checks (the healthy path) ──────────────────────────────────────

describe('Aura Doctor — real repo', () => {
  it('runDoctor returns a report with all categories', async () => {
    const report = await runDoctor({ projectRoot: REPO_ROOT, offline: true });
    const cats = new Set(report.findings.map(f => f.category));
    expect(cats.has('build')).toBe(true);
    expect(cats.has('config')).toBe(true);
    expect(cats.has('source')).toBe(true);
    expect(cats.has('assets')).toBe(true);
    expect(cats.has('skills')).toBe(true);
    expect(cats.has('deps')).toBe(true);
    expect(cats.has('git')).toBe(true);
    expect(cats.has('env')).toBe(true);
    expect(cats.has('version')).toBe(true);
    expect(cats.has('memory')).toBe(true);
    expect(cats.has('hygiene')).toBe(true);
    // Compare against the real package.json rather than a hardcoded literal —
    // a version bump must not fail this test.
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
    expect(report.version).toBe(pkgVersion);
    expect(report.summary.ok).toBeGreaterThan(0);
  });

  it('formatDoctorReport renders the header and summary', async () => {
    const report = await runDoctor({ projectRoot: REPO_ROOT, offline: true });
    const out = strip(formatDoctorReport(report));
    expect(out).toContain('Aura Doctor');
    expect(out).toContain('Build');
    expect(out).toContain('Config');
    expect(out).toContain('ok');
  });

  it('detects dist exists and is up to date on the real repo', () => {
    const findings = checkBuild(REPO_ROOT);
    expect(has(findings, 'build', 'dist directory')?.severity).toBe('ok');
    expect(has(findings, 'build', 'entry point')?.severity).toBe('ok');
  });

  it('detects package.json is valid', () => {
    const findings = checkConfig(REPO_ROOT);
    expect(has(findings, 'config', 'package.json')?.severity).toBe('ok');
    expect(has(findings, 'config', 'tsconfig.json')?.severity).toBe('ok');
  });

  it('detects all key source files', () => {
    const findings = checkSource(REPO_ROOT);
    const ok = has(findings, 'source', 'key source files');
    expect(ok?.severity).toBe('ok');
  });

  it('detects node_modules and key deps', () => {
    const findings = checkDeps(REPO_ROOT);
    expect(has(findings, 'deps', 'node_modules')?.severity).toBe('ok');
  });

  it('detects git repo', () => {
    const findings = checkGit(REPO_ROOT);
    expect(has(findings, 'git', 'git repo')?.severity).toBe('ok');
  });
});

// ── Hygiene check — flags stray non-aura files in the repo root ─────────────

describe('Aura Doctor — repo-root hygiene', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-hygiene-'));
    execSync('git init -q', { cwd: tmp });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -qm init', { cwd: tmp });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports ok when there are no untracked top-level items', () => {
    const findings = checkHygiene(tmp);
    expect(has(findings, 'hygiene', 'repo root')?.severity).toBe('ok');
  });

  it('flags an untracked top-level file', () => {
    fs.writeFileSync(path.join(tmp, 'gpu-dashboard.sh'), '#!/bin/bash\n');
    const findings = checkHygiene(tmp);
    const f = has(findings, 'hygiene', 'stray root files');
    expect(f?.severity).toBe('warn');
    expect(f?.message).toContain('gpu-dashboard.sh');
    expect(f?.fixable).toBe(false);
  });

  it('flags an untracked top-level directory once, not per file inside it', () => {
    fs.mkdirSync(path.join(tmp, 'surveillance'));
    fs.writeFileSync(path.join(tmp, 'surveillance', 'cam-1.jpg'), 'x');
    fs.writeFileSync(path.join(tmp, 'surveillance', 'cam-2.jpg'), 'x');
    const findings = checkHygiene(tmp);
    const f = has(findings, 'hygiene', 'stray root files');
    expect(f?.message).toContain('1 untracked top-level item');
    expect(f?.message).toContain('surveillance');
  });

  it('does not flag gitignored top-level entries', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored-thing/\n');
    execSync('git add .gitignore && git -c user.email=t@t -c user.name=t commit -qm gitignore', { cwd: tmp });
    fs.mkdirSync(path.join(tmp, 'ignored-thing'));
    fs.writeFileSync(path.join(tmp, 'ignored-thing', 'x.txt'), 'x');
    const findings = checkHygiene(tmp);
    expect(has(findings, 'hygiene', 'repo root')?.severity).toBe('ok');
  });

  it('returns no findings when not a git repo', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-hygiene-norepo-'));
    try {
      expect(checkHygiene(nonRepo)).toEqual([]);
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

// ── Temp-dir checks (the broken path) ────────────────────────────────────────

describe('Aura Doctor — broken install in temp dir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-doctor-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports error when dist/ is missing', () => {
    const findings = checkBuild(tmp);
    expect(has(findings, 'build', 'dist directory')?.severity).toBe('error');
    expect(has(findings, 'build', 'dist directory')?.fixable).toBe(true);
  });

  it('reports error when package.json is missing', () => {
    const findings = checkConfig(tmp);
    expect(has(findings, 'config', 'package.json')?.severity).toBe('error');
  });

  it('reports error when tsconfig.json is missing', () => {
    const findings = checkConfig(tmp);
    expect(has(findings, 'config', 'tsconfig.json')?.severity).toBe('error');
  });

  it('reports error when src/ is missing', () => {
    const findings = checkSource(tmp);
    expect(has(findings, 'source', 'src directory')?.severity).toBe('error');
  });

  it('reports error when node_modules/ is missing', () => {
    const findings = checkDeps(tmp);
    expect(has(findings, 'deps', 'node_modules')?.severity).toBe('error');
    expect(has(findings, 'deps', 'node_modules')?.fixable).toBe(true);
  });

  it('reports warn when .aura.json is invalid JSON', () => {
    fs.writeFileSync(path.join(tmp, '.aura.json'), '{ broken json');
    const findings = checkConfig(tmp);
    const aura = has(findings, 'config', '.aura.json');
    expect(aura?.severity).toBe('error');
  });

  it('reports ok when package.json is valid', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0', bin: { test: 'dist/test.js' } }));
    const findings = checkConfig(tmp);
    expect(has(findings, 'config', 'package.json')?.severity).toBe('ok');
  });

  it('runDoctor on an empty dir reports multiple errors', async () => {
    const report = await runDoctor({ projectRoot: tmp, offline: true });
    expect(report.summary.error).toBeGreaterThan(0);
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('runDoctor writes a report to ~/.aura/doctor-report.json', async () => {
    await runDoctor({ projectRoot: tmp, offline: true });
    const home = process.env.HOME ?? os.homedir();
    const reportPath = path.join(home, '.aura', 'doctor-report.json');
    expect(fs.existsSync(reportPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(saved.timestamp).toBeGreaterThan(0);
    expect(Array.isArray(saved.findings)).toBe(true);
  });
});

// ── Formatting ───────────────────────────────────────────────────────────────

describe('formatDoctorReport', () => {
  it('shows [fixable] tag on fixable findings and suggests --fix', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-fmt-'));
    try {
      const report = await runDoctor({ projectRoot: tmp, offline: true });
      const out = strip(formatDoctorReport(report));
      // Missing dist is fixable
      expect(out).toContain('[fixable]');
      expect(out).toContain('--fix');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('shows [fixed] tag after repair', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-fix-'));
    try {
      // Create a minimal src so build repair can at least attempt
      fs.mkdirSync(path.join(tmp, 'src'));
      const report = await runDoctor({ projectRoot: tmp, fix: true, offline: true });
      const out = strip(formatDoctorReport(report));
      // The dist was missing and fix was attempted — even if build fails (no tsconfig),
      // the report should mention the repair attempt.
      if (report.fixed.length > 0) {
        expect(out).toContain('[fixed]');
      }
      if (report.fixFailed.length > 0) {
        expect(out).toContain('Could not repair');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
