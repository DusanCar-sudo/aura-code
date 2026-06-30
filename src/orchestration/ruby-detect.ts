import * as fs from 'fs';
import * as path from 'path';
import type { RubyFramework, RubyProjectContext, RubyTestFramework } from './ruby-types.js';

function readTextIfExists(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function detectRubyVersion(projectRoot: string): string | undefined {
  const dotRuby = readTextIfExists(path.join(projectRoot, '.ruby-version'));
  if (dotRuby?.trim()) return dotRuby.trim();

  const gemfile = readTextIfExists(path.join(projectRoot, 'Gemfile'));
  if (!gemfile) return undefined;
  const m = gemfile.match(/^\s*ruby\s+['"]([^'"]+)['"]/m);
  return m?.[1];
}

function detectFramework(projectRoot: string, gemfile?: string): RubyFramework {
  if (fs.existsSync(path.join(projectRoot, 'config', 'application.rb'))) return 'rails';
  if (gemfile?.includes("'rails'") || gemfile?.includes('"rails"')) return 'rails';
  if (gemfile?.includes("'sinatra'") || gemfile?.includes('"sinatra"')) return 'sinatra';
  if (gemfile?.includes("'rack'") || gemfile?.includes('"rack"')) return 'rack';
  if (fs.existsSync(path.join(projectRoot, 'lib')) && fs.existsSync(path.join(projectRoot, 'Gemfile'))) {
    return 'plain';
  }
  const rbFiles = fs.readdirSync(projectRoot).filter(f => f.endsWith('.rb'));
  if (rbFiles.length > 0) return 'plain';
  return 'unknown';
}

function detectTestFramework(gemfile?: string): RubyTestFramework {
  if (!gemfile) return 'unknown';
  if (gemfile.includes('rspec')) return 'rspec';
  if (gemfile.includes('minitest')) return 'minitest';
  if (gemfile.includes('test-unit')) return 'test-unit';
  return 'unknown';
}

function detectEntrypoints(projectRoot: string, framework: RubyFramework): string[] {
  const candidates = [
    'config.ru',
    'app.rb',
    'main.rb',
    'bin/rails',
    'lib/application.rb',
    'Rakefile',
  ];
  const found: string[] = [];
  for (const rel of candidates) {
    const full = path.join(projectRoot, rel);
    if (fs.existsSync(full)) found.push(rel);
  }
  if (framework === 'rails' && !found.includes('config.ru')) {
    const ru = path.join(projectRoot, 'config.ru');
    if (fs.existsSync(ru)) found.push('config.ru');
  }
  return found;
}

/**
 * Builds a RubyProjectContext from on-disk signals (Gemfile, layout, etc.).
 * Safe to call on non-Ruby trees — returns `framework: 'unknown'` with empty entrypoints.
 */
export function detectRubyProject(projectRoot: string): RubyProjectContext {
  const gemfilePath = path.join(projectRoot, 'Gemfile');
  const hasGemfile = fs.existsSync(gemfilePath);
  const hasGemfileLock = fs.existsSync(path.join(projectRoot, 'Gemfile.lock'));
  const gemfile = hasGemfile ? readTextIfExists(gemfilePath) : undefined;
  const framework = detectFramework(projectRoot, gemfile);

  return {
    projectRoot,
    framework,
    hasGemfile,
    hasGemfileLock,
    rubyVersion: detectRubyVersion(projectRoot),
    testFramework: detectTestFramework(gemfile),
    entrypoints: detectEntrypoints(projectRoot, framework),
    capturedAt: Date.now(),
  };
}