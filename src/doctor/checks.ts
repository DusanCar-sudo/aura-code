/**
 * Aura Doctor — scanner. Each check function returns one or more Findings.
 *
 * All checks are pure reads — they never modify the filesystem. Repair
 * logic lives in repair.ts and is only invoked when the caller passes
 * fix:true to runDoctor().
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { isNativeWindows, isWSL } from '../util/platform.js';
import type { Finding, Category } from './types.js';
import type { Episode } from '../archimedes/types.js';
import { DEFAULT_ARCHIMEDES_CONFIG } from '../archimedes/types.js';
import { getCompetenceReport } from '../archimedes/competence.js';
import { loadProjectConfig } from '../config/project-config.js';
import { fetchLatestVersion, isUpdateAvailable } from '../util/update-check.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJson<T = unknown>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; }
}

function mtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function sh(cmd: string, cwd: string): string {
  try { return execSync(cmd, { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { return ''; }
}

// ── 1. Build integrity ───────────────────────────────────────────────────────

export function checkBuild(root: string): Finding[] {
  const dist = path.join(root, 'dist');
  const entry = path.join(dist, 'cli', 'index.js');
  const out: Finding[] = [];

  if (!exists(dist)) {
    out.push({ category: 'build', name: 'dist directory', severity: 'error', message: 'dist/ does not exist — the compiled output is missing.', fixable: true, fixDescription: 'Run npm run build to compile src/ → dist/.' });
    return out;
  }
  out.push({ category: 'build', name: 'dist directory', severity: 'ok', message: 'dist/ exists.', fixable: false });

  if (!exists(entry)) {
    out.push({ category: 'build', name: 'entry point', severity: 'error', message: 'dist/cli/index.js is missing — the CLI entry point cannot run.', fixable: true, fixDescription: 'Run npm run build.' });
  } else {
    out.push({ category: 'build', name: 'entry point', severity: 'ok', message: 'dist/cli/index.js exists.', fixable: false });
  }

  // Staleness: any src/*.ts newer than dist/cli/index.js?
  const entryMtime = mtime(entry);
  if (entryMtime > 0) {
    const newer = findNewerSource(root, entryMtime);
    if (newer.length > 0) {
      out.push({
        category: 'build', name: 'dist freshness', severity: 'fixable',
        message: `dist/ is stale — ${newer.length} source file(s) newer than the build.`,
        detail: newer.slice(0, 5).join('\n') + (newer.length > 5 ? `\n… and ${newer.length - 5} more` : ''),
        fixable: true, fixDescription: 'Run npm run build to recompile.',
      });
    } else {
      out.push({ category: 'build', name: 'dist freshness', severity: 'ok', message: 'dist/ is up to date with src/.', fixable: false });
    }
  }
  return out;
}

function findNewerSource(root: string, threshold: number): string[] {
  const srcDir = path.join(root, 'src');
  const result: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && mtime(full) > threshold) {
        result.push(path.relative(root, full));
      }
    }
  }
  try { walk(srcDir); } catch { /* src missing — handled elsewhere */ }
  return result;
}

// ── 2. Config validity ───────────────────────────────────────────────────────

export function checkConfig(root: string): Finding[] {
  const out: Finding[] = [];

  // package.json
  const pkgPath = path.join(root, 'package.json');
  const pkg = readJson<{ name?: string; version?: string; bin?: unknown; main?: string }>(pkgPath);
  if (!pkg) {
    out.push({ category: 'config', name: 'package.json', severity: 'error', message: 'package.json is missing or not valid JSON.', fixable: false });
  } else {
    out.push({ category: 'config', name: 'package.json', severity: 'ok', message: `package.json valid — ${pkg.name ?? '?'} v${pkg.version ?? '?'}.`, fixable: false });
    if (!pkg.bin || (typeof pkg.bin === 'object' && Object.keys(pkg.bin as object).length === 0)) {
      out.push({ category: 'config', name: 'package.json bin', severity: 'warn', message: 'package.json has no "bin" field — the CLI may not be installed globally.', fixable: false });
    }
  }

  // tsconfig.json
  const tsconfigPath = path.join(root, 'tsconfig.json');
  if (!exists(tsconfigPath)) {
    out.push({ category: 'config', name: 'tsconfig.json', severity: 'error', message: 'tsconfig.json is missing — cannot build.', fixable: false });
  } else if (!readJson(tsconfigPath)) {
    out.push({ category: 'config', name: 'tsconfig.json', severity: 'error', message: 'tsconfig.json is not valid JSON.', fixable: false });
  } else {
    out.push({ category: 'config', name: 'tsconfig.json', severity: 'ok', message: 'tsconfig.json valid.', fixable: false });
  }

  // .aura.json
  const auraPath = path.join(root, '.aura.json');
  if (exists(auraPath)) {
    const aura = readJson<{ providers?: Array<{ apiKeyEnv?: string }>; model?: string }>(auraPath);
    if (!aura) {
      out.push({ category: 'config', name: '.aura.json', severity: 'error', message: '.aura.json is not valid JSON.', fixable: true, fixDescription: 'Fix the JSON syntax or delete the file to use defaults.' });
    } else {
      out.push({ category: 'config', name: '.aura.json', severity: 'ok', message: `.aura.json valid — model: ${aura.model ?? '(default)'}.`, fixable: false });
    }
  }

  // .env.example
  if (!exists(path.join(root, '.env.example'))) {
    out.push({ category: 'config', name: '.env.example', severity: 'warn', message: '.env.example is missing — new users won\'t know which API keys to set.', fixable: false });
  } else {
    out.push({ category: 'config', name: '.env.example', severity: 'ok', message: '.env.example exists.', fixable: false });
  }

  // Cross-check: .aura.json references env vars not in .env.example
  if (exists(auraPath) && exists(path.join(root, '.env.example'))) {
    const aura = readJson<{ providers?: Array<{ apiKeyEnv?: string }> }>(auraPath);
    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    if (aura?.providers) {
      for (const prov of aura.providers) {
        if (prov.apiKeyEnv && !envExample.includes(prov.apiKeyEnv)) {
          out.push({ category: 'config', name: `.env.example vs .aura.json`, severity: 'warn', message: `.aura.json references ${prov.apiKeyEnv} but .env.example doesn't document it.`, fixable: false });
        }
      }
    }
  }

  return out;
}

// ── 3. Source integrity ──────────────────────────────────────────────────────

const KEY_SOURCE_FILES = [
  'cli/index.ts', 'cli/display.ts', 'cli/tui.ts',
  'agent/loop.ts', 'agent/compactor.ts', 'agent/system-prompt.ts',
  'providers/factory.ts', 'providers/types.ts',
  'tools/index.ts', 'safety/permissions.ts',
];

export function checkSource(root: string): Finding[] {
  const out: Finding[] = [];
  const srcDir = path.join(root, 'src');
  if (!exists(srcDir)) {
    out.push({ category: 'source', name: 'src directory', severity: 'error', message: 'src/ directory is missing — this is not a development checkout.', fixable: false });
    return out;
  }
  out.push({ category: 'source', name: 'src directory', severity: 'ok', message: 'src/ exists.', fixable: false });

  for (const rel of KEY_SOURCE_FILES) {
    const full = path.join(srcDir, rel);
    if (!exists(full)) {
      out.push({ category: 'source', name: `src/${rel}`, severity: 'error', message: `src/${rel} is missing.`, fixable: false });
    } else {
      const size = fs.statSync(full).size;
      if (size < 50) {
        out.push({ category: 'source', name: `src/${rel}`, severity: 'warn', message: `src/${rel} is suspiciously small (${size} bytes) — may be truncated or corrupted.`, fixable: false });
      }
    }
  }
  // Don't emit an "ok" per file — too noisy. Only surface problems.
  const problems = out.filter(f => f.severity !== 'ok');
  if (problems.length === 0) {
    out.push({ category: 'source', name: 'key source files', severity: 'ok', message: `All ${KEY_SOURCE_FILES.length} key source files present and non-trivial.`, fixable: false });
  }
  return out;
}

// ── 4. Static assets ─────────────────────────────────────────────────────────

const EXPECTED_ASSETS = ['architecture-diagram.png', 'demo.gif', 'ruby-diamond.jpg'];

export function checkAssets(root: string): Finding[] {
  const out: Finding[] = [];
  const assetsDir = path.join(root, 'assets');
  if (!exists(assetsDir)) {
    out.push({ category: 'assets', name: 'assets directory', severity: 'warn', message: 'assets/ directory is missing.', fixable: false });
    return out;
  }
  let allOk = true;
  for (const file of EXPECTED_ASSETS) {
    const full = path.join(assetsDir, file);
    if (!exists(full)) {
      allOk = false;
      out.push({ category: 'assets', name: `assets/${file}`, severity: 'warn', message: `assets/${file} is missing.`, fixable: false });
    } else {
      const size = fs.statSync(full).size;
      if (size < 1000) {
        allOk = false;
        out.push({ category: 'assets', name: `assets/${file}`, severity: 'warn', message: `assets/${file} is only ${size} bytes — likely corrupted.`, fixable: false });
      }
    }
  }
  if (allOk) {
    out.push({ category: 'assets', name: 'static assets', severity: 'ok', message: `All ${EXPECTED_ASSETS.length} static assets present.`, fixable: false });
  }
  return out;
}

// ── 5. Skills ────────────────────────────────────────────────────────────────

export function checkSkills(root: string): Finding[] {
  const out: Finding[] = [];
  const skillsDir = path.join(root, '.agents', 'skills');
  if (!exists(skillsDir)) {
    out.push({ category: 'skills', name: 'skills directory', severity: 'warn', message: '.agents/skills/ is missing — no skills loaded.', fixable: false });
    return out;
  }
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  if (entries.length === 0) {
    out.push({ category: 'skills', name: 'skills', severity: 'warn', message: '.agents/skills/ has no skill subdirectories.', fixable: false });
    return out;
  }
  let problems = 0;
  for (const dir of entries) {
    const skillMd = path.join(skillsDir, dir.name, 'SKILL.md');
    if (!exists(skillMd)) {
      problems++;
      out.push({ category: 'skills', name: `skill:${dir.name}`, severity: 'warn', message: `.agents/skills/${dir.name}/SKILL.md is missing.`, fixable: false });
    }
  }
  if (problems === 0) {
    out.push({ category: 'skills', name: 'skills', severity: 'ok', message: `All ${entries.length} skill(s) have SKILL.md.`, fixable: false });
  }
  return out;
}

// ── 6. Dependencies ──────────────────────────────────────────────────────────

const KEY_DEPS = ['chalk', 'minimist', 'openai'];

export function checkDeps(root: string): Finding[] {
  const out: Finding[] = [];
  const nm = path.join(root, 'node_modules');
  if (!exists(nm)) {
    out.push({ category: 'deps', name: 'node_modules', severity: 'error', message: 'node_modules/ is missing — dependencies not installed.', fixable: true, fixDescription: 'Run npm install.' });
    return out;
  }
  out.push({ category: 'deps', name: 'node_modules', severity: 'ok', message: 'node_modules/ exists.', fixable: false });

  for (const dep of KEY_DEPS) {
    if (!exists(path.join(nm, dep))) {
      out.push({ category: 'deps', name: `dep:${dep}`, severity: 'error', message: `node_modules/${dep} is missing.`, fixable: true, fixDescription: 'Run npm install.' });
    }
  }

  if (!exists(path.join(root, 'package-lock.json'))) {
    out.push({ category: 'deps', name: 'package-lock.json', severity: 'warn', message: 'package-lock.json is missing — installs are not reproducible.', fixable: false });
  } else {
    out.push({ category: 'deps', name: 'package-lock.json', severity: 'ok', message: 'package-lock.json exists.', fixable: false });
  }

  // Only emit the all-ok if no deps errors were added above
  const depErrors = out.filter(f => f.category === 'deps' && f.severity === 'error');
  if (depErrors.length === 0) {
    out.push({ category: 'deps', name: 'key dependencies', severity: 'ok', message: `All ${KEY_DEPS.length} key dependencies present.`, fixable: false });
  }
  return out;
}

// ── 7. Git state ─────────────────────────────────────────────────────────────

export function checkGit(root: string): Finding[] {
  const out: Finding[] = [];
  const isRepo = sh('git rev-parse --is-inside-work-tree', root);
  if (isRepo !== 'true') {
    out.push({ category: 'git', name: 'git repo', severity: 'warn', message: 'Not a git repository — file restoration is not available.', fixable: false });
    return out;
  }
  const branch = sh('git branch --show-current', root) || '(detached)';
  out.push({ category: 'git', name: 'git repo', severity: 'ok', message: `Git repository on branch "${branch}".`, fixable: false });

  const status = sh('git status --short', root);
  if (status) {
    const lines = status.split('\n').filter(Boolean);
    const trackedModified = lines.filter(l => !l.startsWith('??')).length;
    out.push({
      category: 'git', name: 'working tree', severity: 'warn',
      message: `Working tree has ${lines.length} change(s)${trackedModified > 0 ? ` (${trackedModified} tracked)` : ' (all untracked)'}.`,
      detail: lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… and ${lines.length - 8} more` : ''),
      fixable: false,
    });
  } else {
    out.push({ category: 'git', name: 'working tree', severity: 'ok', message: 'Working tree clean.', fixable: false });
  }
  return out;
}

// ── 8. Environment / API keys ────────────────────────────────────────────────

export function checkEnv(root: string): Finding[] {
  const out: Finding[] = [];
  const auraPath = path.join(root, '.aura.json');
  const aura = readJson<{ providers?: Array<{ name?: string; apiKeyEnv?: string }> }>(auraPath);

  // Platform support — native Windows degrades the shell guardrails in ways
  // that are invisible until something goes wrong, so surface it here too.
  if (isNativeWindows()) {
    out.push({
      category: 'env', name: 'platform',
      severity: 'warn',
      message: 'Running natively on Windows — shell safety lists are POSIX-only, '
        + 'so nothing is auto-approved and the dangerous-command denylist misses '
        + 'del /s /q, rd /s, and Remove-Item -Recurse -Force. Run Aura inside WSL.',
      fixable: false,
    });
  } else {
    out.push({
      category: 'env', name: 'platform',
      severity: 'ok',
      message: isWSL() ? 'Running under WSL.' : `Running on ${process.platform}.`,
      fixable: false,
    });
  }

  // Web search. The no-key path scrapes DuckDuckGo, which blocks a lot of IPs
  // with a bot-check page; when that happens every research-shaped command
  // (:research, :ecclesia, :designx) degrades. Worth surfacing here because the
  // symptom at the call site — searches that return nothing — reads as "the
  // topic is obscure" rather than "the tool is down".
  if (process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || process.env.TAVILY_API_KEY) {
    const which = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY ? 'Brave' : 'Tavily';
    out.push({
      category: 'env', name: 'web search',
      severity: 'ok',
      message: `web_search backed by the ${which} API.`,
      fixable: false,
    });
  } else {
    out.push({
      category: 'env', name: 'web search',
      severity: 'warn',
      message: 'No search API key set — web_search falls back to scraping DuckDuckGo, which blocks '
        + 'many IPs with a bot-check page. Set BRAVE_API_KEY (free tier: brave.com/search/api) or '
        + 'TAVILY_API_KEY for search that works reliably.',
      fixable: false,
    });
  }

  const knownEnvVars = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY',
    'XAI_API_KEY', 'OPENROUTER_API_KEY', 'XIAOMI_API_KEY',
    'ZHIPU_API_KEY', 'OPENCODE_GO_API_KEY', 'DEEPSEEK_API_KEY',
    'ARK_API_KEY', 'FPT_API_KEY',
  ];

  const set: string[] = [];
  const unset: string[] = [];
  for (const v of knownEnvVars) {
    if (process.env[v]) set.push(v);
    else unset.push(v);
  }

  out.push({
    category: 'env', name: 'API keys',
    severity: set.length > 0 ? 'ok' : 'warn',
    message: `${set.length}/${knownEnvVars.length} API key(s) set${set.length > 0 ? ': ' + set.join(', ') : '.'}`,
    fixable: false,
  });

  // Cross-check: .aura.json providers whose keys are unset
  if (aura?.providers) {
    for (const prov of aura.providers) {
      if (prov.apiKeyEnv && !process.env[prov.apiKeyEnv]) {
        out.push({
          category: 'env', name: `provider:${prov.name ?? prov.apiKeyEnv}`,
          severity: 'warn',
          message: `Provider "${prov.name ?? '?'}" needs ${prov.apiKeyEnv} but it is not set.`,
          fixable: false,
        });
      }
    }
  }

  if (set.length === 0) {
    out.push({
      category: 'env', name: 'no provider',
      severity: 'warn',
      message: 'No API keys detected — Aura cannot run any LLM task. Run :provider or set an env var.',
      fixable: false,
    });
  }
  return out;
}

// ── 9. Version ───────────────────────────────────────────────────────────────

export function checkVersion(root: string, _offline?: boolean): Finding[] {
  const out: Finding[] = [];
  const pkg = readJson<{ version?: string }>(path.join(root, 'package.json'));
  const current = pkg?.version ?? 'unknown';
  out.push({ category: 'version', name: 'installed version', severity: 'ok', message: `Installed version: ${current}.`, fixable: false });
  // The latest-version network check is done separately by runDoctor()
  // (async fetch) to avoid a sync function kicking off fire-and-forget I/O.
  return out;
}

/** Async latest-version check. Returns a Finding or null if it can't reach the API. */
export async function checkLatestVersion(currentVersion: string): Promise<Finding | null> {
  // npm, not GitHub releases. Users install with `npm install -g aura-code`, so
  // the registry is what "is there an update" means for them — and the GitHub
  // URL this used to call was a stale mirror (milodule3-debug/aura-code, last
  // release v0.10.3) that would have told everyone on 0.16.0 they were behind.
  //
  // The comparison is numeric too. It used to be `latest !== current`, which
  // reports a *downgrade* as an update: with 0.15.5 published and 0.16.0 built
  // locally — this repo's exact state while the publish workflow was blocked —
  // it advised updating to an older version.
  const latest = await fetchLatestVersion();
  if (!latest) return null;
  if (!isUpdateAvailable(currentVersion, latest)) return null;
  return {
    category: 'version', name: 'latest version', severity: 'warn',
    message: `Latest release is ${latest} — you are on ${currentVersion}.`,
    fixable: true, fixDescription: 'Run npm install -g aura-code to update.',
  };
}

// ── 10. Memory pipeline ──────────────────────────────────────────────────────

export function checkMemory(root: string): Finding[] {
  const out: Finding[] = [];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  const auraHome = path.join(home, '.aura');

  if (!exists(auraHome)) {
    out.push({ category: 'memory', name: '.aura directory', severity: 'warn', message: `~/.aura/ does not exist yet — no episodes or memory recorded.`, fixable: false });
    return out;
  }
  out.push({ category: 'memory', name: '.aura directory', severity: 'ok', message: '~/.aura/ exists.', fixable: false });

  // Episodes
  const episodesDir = path.join(auraHome, 'episodes');
  if (exists(episodesDir)) {
    let episodeCount = 0;
    try {
      for (const projDir of fs.readdirSync(episodesDir, { withFileTypes: true })) {
        if (projDir.isDirectory()) {
          episodeCount += fs.readdirSync(path.join(episodesDir, projDir.name)).filter(f => f.endsWith('.json')).length;
        }
      }
    } catch { /* best-effort */ }
    out.push({
      category: 'memory', name: 'episodes',
      severity: episodeCount > 0 ? 'ok' : 'warn',
      message: `${episodeCount} episode(s) recorded.`,
      fixable: false,
    });
  }

  // Dreams (project-local)
  const dreamsDir = path.join(root, 'dreams');
  if (exists(dreamsDir)) {
    const dreams = fs.readdirSync(dreamsDir).filter(f => f.endsWith('.md'));
    out.push({ category: 'memory', name: 'dreams', severity: 'ok', message: `${dreams.length} dream file(s) in dreams/.`, fixable: false });
  }

  // Identity
  const identityPath = path.join(auraHome, 'memory', 'identity.json');
  if (exists(identityPath)) {
    if (readJson(identityPath)) {
      out.push({ category: 'memory', name: 'identity', severity: 'ok', message: 'identity.json present and valid.', fixable: false });
    } else {
      out.push({ category: 'memory', name: 'identity', severity: 'warn', message: 'identity.json is corrupted (invalid JSON).', fixable: true, fixDescription: 'Delete ~/.aura/memory/identity.json to reset, or restore from backup.' });
    }
  }

  return out;
}

// ── 11. Repo-root hygiene ────────────────────────────────────────────────────
// Standing rule: aura-code's repo root holds only aura-code source — personal
// / utility work (dashboards, cron scripts, one-off captures) belongs in the
// sibling projects/ directory. Interactive sessions launched from the repo
// root have repeatedly written stray files here anyway (identity.json memory
// alone hasn't reliably prevented it — see repo-hygiene-projects-dir), so
// this is the active-guard half: flag any new untracked, non-gitignored
// top-level entry so it surfaces in every `aura --doctor` run instead of only
// being caught by a manual `git status --short` sweep.
export function checkHygiene(root: string): Finding[] {
  const out: Finding[] = [];
  const isRepo = sh('git rev-parse --is-inside-work-tree', root);
  if (isRepo !== 'true') {
    return out; // checkGit already reports "not a git repo"; nothing more to say here
  }

  const status = sh('git status --porcelain', root);
  const strays = status.split('\n')
    .filter(l => l.startsWith('?? '))
    .map(l => l.slice(3).split('/')[0])
    .filter((v, i, arr) => v && arr.indexOf(v) === i); // unique top-level names

  if (strays.length === 0) {
    out.push({ category: 'hygiene', name: 'repo root', severity: 'ok', message: 'No untracked non-aura files in the repo root.', fixable: false });
    return out;
  }

  out.push({
    category: 'hygiene', name: 'stray root files', severity: 'warn',
    message: `${strays.length} untracked top-level item(s) in the repo root that git doesn't recognize: ${strays.join(', ')}.`,
    detail: 'If these are personal/utility work (not aura-code source), move them to /mnt/bigdata/aura/projects/<name>/ — see the repo-hygiene standing rule.',
    fixable: false,
  });
  return out;
}

// ── 12. Archimedes alternator ────────────────────────────────────────────────
// Gate visibility: which task categories the competence gate is currently
// blocking, and how often gated work is re-probed (epsilonProbeRate). The
// real gate matches per task-text pattern (see assessCompetence), so the
// per-category view here is an approximation for visibility, not the exact
// routing decision.
export function checkArchimedes(root: string): Finding[] {
  const out: Finding[] = [];
  const cfg = {
    ...DEFAULT_ARCHIMEDES_CONFIG,
    ...(loadProjectConfig(root).archimedes ?? {}),
  };

  out.push({
    category: 'archimedes', name: 'alternator config',
    severity: 'ok',
    message: cfg.enabled
      ? `Alternator enabled — threshold ${(cfg.competenceThreshold * 100).toFixed(0)}%, min attempts ${cfg.minAttempts}, epsilon probe ${(cfg.epsilonProbeRate * 100).toFixed(0)}% (gated patterns re-tested at this rate).`
      : 'Alternator disabled in .aura.json — all tasks go straight to the large model.',
    fixable: false,
  });

  // Episodes for THIS project (same hash scheme as episodeStore.projectDir)
  const home = process.env.HOME ?? '/tmp';
  const hash = Buffer.from(root, 'utf8').toString('base64').slice(0, 8);
  const epDir = path.join(home, '.aura', 'episodes', hash);
  const episodes: Episode[] = [];
  if (exists(epDir)) {
    try {
      for (const f of fs.readdirSync(epDir).filter(f => f.endsWith('.json'))) {
        const ep = readJson<Episode>(path.join(epDir, f));
        if (ep?.id) episodes.push(ep);
      }
    } catch { /* best-effort */ }
  }

  if (episodes.length === 0) {
    out.push({
      category: 'archimedes', name: 'competence', severity: 'warn',
      message: 'No alternation episodes recorded for this project yet — no competence data.',
      fixable: false,
    });
    return out;
  }

  const report = getCompetenceReport(episodes);
  if (report.length === 0) {
    out.push({
      category: 'archimedes', name: 'competence', severity: 'warn',
      message: `${episodes.length} episode(s) recorded, but none with an Archimedes attempt — the score cannot move without attempts.`,
      fixable: false,
    });
    return out;
  }

  for (const row of report) {
    const gated = row.count >= cfg.minAttempts && row.successRate < cfg.competenceThreshold;
    const pct = (row.successRate * 100).toFixed(0);
    out.push({
      category: 'archimedes', name: `competence: ${row.category}`,
      severity: gated ? 'warn' : 'ok',
      message: gated
        ? `${row.category}: ${pct}% success over ${row.count} attempt(s) — GATED (below ${(cfg.competenceThreshold * 100).toFixed(0)}% threshold; re-probed ~${(cfg.epsilonProbeRate * 100).toFixed(0)}% of the time, or force with :small1).`
        : `${row.category}: ${pct}% success over ${row.count} attempt(s).`,
      detail: gated
        ? 'Gating is decided per task-text pattern, not per category — this row is an aggregate view.'
        : undefined,
      fixable: false,
    });
  }

  return out;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const ALL_CHECKS: Array<{ category: Category; run: (root: string, offline?: boolean) => Finding[] }> = [
  { category: 'build', run: (r) => checkBuild(r) },
  { category: 'config', run: (r) => checkConfig(r) },
  { category: 'source', run: (r) => checkSource(r) },
  { category: 'assets', run: (r) => checkAssets(r) },
  { category: 'skills', run: (r) => checkSkills(r) },
  { category: 'deps', run: (r) => checkDeps(r) },
  { category: 'git', run: (r) => checkGit(r) },
  { category: 'env', run: (r) => checkEnv(r) },
  { category: 'version', run: (r, o) => checkVersion(r, o) },
  { category: 'memory', run: (r) => checkMemory(r) },
  { category: 'hygiene', run: (r) => checkHygiene(r) },
  { category: 'archimedes', run: (r) => checkArchimedes(r) },
  { category: 'computer', run: (r) => checkComputerUse(r) },
];

// ── 13. Computer use ─────────────────────────────────────────────────────────

/**
 * Preflight for the computer-use sidecar.
 *
 * Every one of these is present on a developer machine that has been using the
 * feature and absent on a fresh one, so without this check the first symptom a
 * user gets is a task dying mid-run with a Python traceback — after the model
 * has already spent turns planning around a tool that could never work.
 *
 * Reported as 'warn', never 'error': computer use is opt-in, and a machine that
 * will never enable it is not broken for lacking evdev. The messages name the
 * package to install rather than the symptom, because "No module named evdev"
 * is not something a user can act on.
 */
export function checkComputerUse(root: string, platform: NodeJS.Platform = process.platform): Finding[] {
  const out: Finding[] = [];
  const add = (name: string, ok: boolean, okMsg: string, badMsg: string) =>
    out.push({
      category: 'computer', name,
      severity: ok ? 'ok' : 'warn',
      message: ok ? okMsg : badMsg,
      fixable: false,
    });

  // The sidecar itself. Missing from dist/ means the build's asset copy did not
  // run — a packaging fault, and the one failure here that is not the user's.
  const script = path.join(root, 'dist', 'tools', 'screen', 'aura_screen.py');
  const srcScript = path.join(root, 'src', 'tools', 'screen', 'aura_screen.py');
  if (exists(script)) {
    out.push({ category: 'computer', name: 'sidecar', severity: 'ok', message: 'Screen sidecar present in dist/.', fixable: false });
  } else if (exists(srcScript)) {
    out.push({
      category: 'computer', name: 'sidecar', severity: 'warn',
      message: 'dist/tools/screen/aura_screen.py is missing — run npm run build (postbuild copies it).',
      fixable: false,
    });
  } else {
    out.push({
      category: 'computer', name: 'sidecar', severity: 'warn',
      message: 'Screen sidecar not found in dist/ or src/ — computer use cannot start.',
      fixable: false,
    });
  }

  if (platform === 'darwin') {
    out.push(...checkComputerUseMacOS());
    return out;
  }

  if (platform !== 'linux') {
    out.push({
      category: 'computer', name: 'platform', severity: 'warn',
      message: `Computer use currently supports Linux only (this is ${platform}).`,
      fixable: false,
    });
    return out;
  }

  const python = process.env.AURA_PYTHON ?? 'python3';
  const py = (code: string) => {
    try {
      execSync(`${python} -c ${JSON.stringify(code)}`, { stdio: 'pipe', timeout: 10_000 });
      return true;
    } catch { return false; }
  };
  const haveBin = (bin: string) => {
    try { execSync(`command -v ${bin}`, { stdio: 'pipe', timeout: 5_000 }); return true; }
    catch { return false; }
  };

  const hasPython = haveBin(python);
  add('python3', hasPython,
    `${python} found.`,
    `${python} not found — the screen sidecar cannot run. Set AURA_PYTHON if it is elsewhere.`);
  if (!hasPython) return out;

  add('python gi/GLib', py('import gi; gi.require_version("Gst","1.0")'),
    'python3-gi with GStreamer bindings available.',
    'Missing python3-gi / GStreamer bindings — install python3-gi and gir1.2-gstreamer-1.0.');

  add('python evdev', py('import evdev'),
    'python3-evdev available (uinput input).',
    'Missing python3-evdev — install python3-evdev. Without it the agent cannot move the pointer.');

  add('pipewiresrc', py(
    'import gi; gi.require_version("Gst","1.0"); from gi.repository import Gst; Gst.init(None);'
    + ' raise SystemExit(0 if Gst.ElementFactory.find("pipewiresrc") else 1)'),
    'GStreamer pipewiresrc present (screen capture).',
    'GStreamer pipewiresrc missing — install gstreamer1.0-pipewire. Screen capture will fail.');

  add('ImageMagick', haveBin('convert'),
    'ImageMagick convert present (screenshot encoding).',
    'ImageMagick `convert` not found — install imagemagick. Screenshots cannot be encoded.');

  // /dev/uinput is the one that fails with a bare EACCES at the worst moment.
  let uinput = false;
  let uinputWhy = '/dev/uinput is missing — load the uinput kernel module.';
  try {
    fs.accessSync('/dev/uinput', fs.constants.W_OK);
    uinput = true;
  } catch {
    if (exists('/dev/uinput')) {
      uinputWhy = '/dev/uinput exists but is not writable — add your user to the `input` group '
        + '(then log out and back in), or set a udev rule.';
    }
  }
  add('/dev/uinput', uinput, '/dev/uinput is writable (virtual input device).', uinputWhy);

  const session = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (session === 'wayland' || session === 'x11') {
    out.push({
      category: 'computer', name: 'session', severity: 'ok',
      message: `Session type ${session} — uinput input works on both.`, fixable: false,
    });
  } else {
    out.push({
      category: 'computer', name: 'session', severity: 'warn',
      message: `XDG_SESSION_TYPE is "${session || 'unset'}" — expected wayland or x11. `
        + 'Capture needs a desktop session with an xdg-desktop-portal backend.',
      fixable: false,
    });
  }

  return out;
}

/**
 * Readiness preflight for computer use on macOS.
 *
 * **Computer use is not implemented on macOS yet.** This does not pretend
 * otherwise, and the `platform` finding says so first. What it does is answer
 * the question that has to be answered on real hardware before the backend can
 * be written at all: *would this Mac be able to run it?*
 *
 * That inversion is the point. The Linux work established the rule the hard
 * way — three of four input paths accepted every call and silently did
 * nothing, so an exit code proved nothing and only an end-to-end capture-and-
 * click did. macOS has the same shape of failure, in a worse form: when TCC
 * permission is missing, the APIs do not error. `CGWindowListCreateImage`
 * returns a picture of the desktop wallpaper with every window quietly
 * omitted, and posted `CGEvent`s are accepted and dropped. A backend written
 * against that, from a machine that cannot run it, would look finished and be
 * worthless.
 *
 * So the probes below check the two permissions and the two runtime pieces
 * that decide the outcome, and every one of them fails toward "not ready".
 *
 * A caveat stated rather than buried: these probes are written from Apple's
 * documented APIs and have **not been run on a Mac**. If one is wrong it will
 * mis-report readiness — which is why nothing here enables anything, and why
 * the platform finding refuses on its own terms regardless of what the rest
 * say.
 */
export function checkComputerUseMacOS(): Finding[] {
  const out: Finding[] = [];
  const add = (name: string, ok: boolean, okMsg: string, badMsg: string) =>
    out.push({
      category: 'computer', name,
      severity: ok ? 'ok' : 'warn',
      message: ok ? okMsg : badMsg,
      fixable: false,
    });

  out.push({
    category: 'computer', name: 'platform', severity: 'warn',
    message: 'Computer use is not implemented on macOS yet — Linux only today. '
      + 'The checks below report whether this Mac would be ready for it, so the backend '
      + 'can be built against a machine that has actually been measured.',
    fixable: false,
  });

  const python = process.env.AURA_PYTHON ?? 'python3';
  const py = (code: string) => {
    try {
      execSync(`${python} -c ${JSON.stringify(code)}`, { stdio: 'pipe', timeout: 10_000 });
      return true;
    } catch { return false; }
  };
  const haveBin = (bin: string) => {
    try { execSync(`command -v ${bin}`, { stdio: 'pipe', timeout: 5_000 }); return true; }
    catch { return false; }
  };

  const hasPython = haveBin(python);
  add('python3', hasPython,
    `${python} found.`,
    `${python} not found — install Python 3 (brew install python). Set AURA_PYTHON if it is elsewhere.`);
  if (!hasPython) return out;

  // Quartz is the whole macOS surface: CGDisplay for capture, CGEvent for
  // input. Without pyobjc there is nothing to build a sidecar on.
  add('pyobjc (Quartz)', py('import Quartz'),
    'pyobjc Quartz bindings available (capture and input).',
    'Missing pyobjc — install it (pip install pyobjc-framework-Quartz). '
    + 'Without it neither screen capture nor pointer control can work.');

  // Screen Recording. Denied, capture returns the desktop with every window
  // omitted and no error at all — the silent failure this preflight exists for.
  add('Screen Recording permission',
    py('import Quartz; raise SystemExit(0 if Quartz.CGPreflightScreenCaptureAccess() else 1)'),
    'Screen Recording is granted — capture will include windows.',
    'Screen Recording is not granted to this terminal. Grant it in System Settings ▸ Privacy & '
    + 'Security ▸ Screen Recording, then restart the terminal. Until then a capture returns the '
    + 'wallpaper with every window silently missing, and reports no error.');

  // Accessibility. Denied, CGEventPost is accepted and dropped — the exact
  // failure mode ydotool had on Linux, where the exit code said success.
  add('Accessibility permission',
    py('from ApplicationServices import AXIsProcessTrusted; raise SystemExit(0 if AXIsProcessTrusted() else 1)'),
    'Accessibility is granted — synthetic input will be delivered.',
    'Accessibility is not granted to this terminal. Grant it in System Settings ▸ Privacy & '
    + 'Security ▸ Accessibility, then restart the terminal. Until then clicks and keystrokes are '
    + 'accepted and silently discarded — the call succeeds and nothing happens.');

  // Both permissions attach to the *host application*, not to Aura, and that
  // catches people out: granting it to a binary called "aura" is not a thing
  // the system offers.
  out.push({
    category: 'computer', name: 'permission scope', severity: 'warn',
    message: 'macOS grants these to the application that launched the process — Terminal, iTerm, '
      + 'VS Code — not to Aura. Grant them to the terminal you run Aura from, and re-grant if you '
      + 'switch terminals.',
    fixable: false,
  });

  add('screencapture', haveBin('screencapture'),
    'screencapture present (fallback capture path).',
    'screencapture not found — unexpected on macOS, it ships with the OS.');

  return out;
}
