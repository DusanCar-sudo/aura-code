import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectRubyProject } from '../../src/orchestration/ruby-detect.js';

describe('detectRubyProject', () => {
  let projectTmp: string;

  beforeEach(() => {
    projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-rb-'));
  });

  afterEach(() => {
    fs.rmSync(projectTmp, { recursive: true, force: true });
  });

  it('returns unknown for empty non-Ruby directory', () => {
    const ctx = detectRubyProject(projectTmp);
    expect(ctx.framework).toBe('unknown');
    expect(ctx.hasGemfile).toBe(false);
    expect(ctx.entrypoints).toEqual([]);
  });

  it('detects plain Ruby project with Gemfile and lib/', () => {
    fs.writeFileSync(path.join(projectTmp, 'Gemfile'), "source 'https://rubygems.org'\n");
    fs.mkdirSync(path.join(projectTmp, 'lib'));
    fs.writeFileSync(path.join(projectTmp, 'main.rb'), 'puts 1');

    const ctx = detectRubyProject(projectTmp);
    expect(ctx.framework).toBe('plain');
    expect(ctx.hasGemfile).toBe(true);
  });

  it('detects Rails from Gemfile and config/application.rb', () => {
    fs.writeFileSync(
      path.join(projectTmp, 'Gemfile'),
      "gem 'rails'\nruby '3.2.2'\ngem 'rspec'\n",
    );
    fs.mkdirSync(path.join(projectTmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(projectTmp, 'config', 'application.rb'), 'module App; end');
    fs.writeFileSync(path.join(projectTmp, 'config.ru'), 'run App');

    const ctx = detectRubyProject(projectTmp);
    expect(ctx.framework).toBe('rails');
    expect(ctx.rubyVersion).toBe('3.2.2');
    expect(ctx.testFramework).toBe('rspec');
    expect(ctx.entrypoints).toContain('config.ru');
  });

  it('reads ruby version from .ruby-version', () => {
    fs.writeFileSync(path.join(projectTmp, '.ruby-version'), '3.3.6\n');
    const ctx = detectRubyProject(projectTmp);
    expect(ctx.rubyVersion).toBe('3.3.6');
  });
});