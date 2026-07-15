import * as readline from 'readline';
import chalk from 'chalk';
import { apiKeyEnvVarForModel, modelProviderFamily, getAllModels } from '../providers/factory.js';
import { PROVIDER_LIST, fetchLiveModels } from '../providers/live-models.js';
import type { LiveModel } from '../providers/live-models.js';
import { getApiKey, saveToAgentsEnv } from '../util/env.js';
import type { ProviderEntry } from '../providers/live-models.js';

/**
 * True when switching prevModel → newModel crosses a provider family
 * boundary (anthropic → zhipu, etc.). A missing prevModel counts as a
 * change — there is nothing safe to inherit.
 */
export function isProviderChange(prevModel: string | undefined, newModel: string): boolean {
  if (!prevModel) return true;
  return modelProviderFamily(prevModel) !== modelProviderFamily(newModel);
}

/**
 * Env-var name to persist for a model switch. The new model's own provider
 * definition always wins. When it has none (ollama/local/unknown), never
 * inherit the OLD provider's env name across a provider change — persisting
 * e.g. ZHIPU_API_KEY for a gpt-4o switch silently pairs the wrong key with
 * the model on the next startup.
 */
export function apiKeyEnvForModelSwitch(
  newModel: string,
  prevModel: string | undefined,
  savedApiKeyEnv: string | undefined,
): string {
  const own = apiKeyEnvVarForModel(newModel);
  if (own) return own;
  if (isProviderChange(prevModel, newModel)) return 'AURA_API_KEY';
  return savedApiKeyEnv ?? 'AURA_API_KEY';
}

export type ModelRow =
  | { kind: 'header'; provider: string }
  | { kind: 'model'; num: number; id: string; name: string; speed: string };

/**
 * Rows for the interactive model selector. Section headers are display-only:
 * they carry no number, so the first real model is always 1 and a header
 * can never be selected by number.
 */
export function buildModelRows(
  models: { id: string; name: string; provider: string; speed: string }[],
): ModelRow[] {
  const rows: ModelRow[] = [];
  let currentProvider = '';
  let num = 0;
  for (const m of models) {
    if (m.provider !== currentProvider) {
      currentProvider = m.provider;
      rows.push({ kind: 'header', provider: m.provider });
    }
    num++;
    rows.push({ kind: 'model', num, id: m.id, name: m.name, speed: m.speed });
  }
  return rows;
}

/** Model id for a typed selector number, or undefined when out of range. */
export function modelIdForNumber(rows: ModelRow[], n: number): string | undefined {
  for (const r of rows) {
    if (r.kind === 'model' && r.num === n) return r.id;
  }
  return undefined;
}

/** Count of selectable models (the valid number range is 1..count). */
export function modelCount(rows: ModelRow[]): number {
  return rows.reduce((acc, r) => acc + (r.kind === 'model' ? 1 : 0), 0);
}

/**
 * Lay items out column-major (numbers read down each column, like `ls`) into
 * as many columns as fit the terminal. Returns rows of items; the caller
 * renders each cell padded to cellWidth.
 */
// ─── Two-level :provider selector ────────────────────────────────────────────

const ACCENT = '#cc785c';
const GREEN = '#5a9e6e';
const DIM = '#8a8a8a';

const LIVE_FETCH_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms).unref()),
  ]);
}

interface ListItem {
  label: string;   // plain text used for width math and filtering
  render: string;  // colored text actually printed
}

type ListResult = { kind: 'pick'; index: number } | { kind: 'back' } | { kind: 'cancel' };

/**
 * Interactive vertical list: ↑/↓ move, Enter select, ESC back, `/` filter.
 * Falls back to a numbered readline prompt when stdin is not a TTY.
 * Caller must have stopped any competing stdin reader (TUI input / readline).
 */
async function interactiveList(title: string, items: ListItem[], opts?: { filter?: boolean }): Promise<ListResult> {
  if (!process.stdin.isTTY) return numberedListFallback(title, items);

  return new Promise<ListResult>(resolve => {
    let selected = 0;
    let filter = '';
    let filtering = false;

    const visible = (): number[] => {
      if (!filter) return items.map((_, i) => i);
      const f = filter.toLowerCase();
      return items.map((it, i) => (it.label.toLowerCase().includes(f) ? i : -1)).filter(i => i !== -1);
    };

    const render = () => {
      const vis = visible();
      if (selected >= vis.length) selected = Math.max(0, vis.length - 1);
      const rows = process.stdout.rows ?? 24;
      const maxRows = Math.max(4, rows - 7);
      let start = 0;
      if (vis.length > maxRows) {
        start = Math.min(Math.max(0, selected - Math.floor(maxRows / 2)), vis.length - maxRows);
      }
      const lines: string[] = [];
      lines.push(chalk.hex(ACCENT).bold(`\n  ${title}\n`));
      if (filtering || filter) {
        lines.push(chalk.hex(DIM)(`  filter: `) + chalk.hex(ACCENT)(filter) + (filtering ? chalk.hex(DIM)('▏') : '') + '\n');
      }
      if (vis.length === 0) {
        lines.push(chalk.hex(DIM)('  (no matches)\n'));
      }
      for (let r = start; r < Math.min(start + maxRows, vis.length); r++) {
        const it = items[vis[r]];
        lines.push((r === selected ? chalk.hex(ACCENT)('  ❯ ') : '    ') + it.render + '\n');
      }
      if (vis.length > maxRows) {
        lines.push(chalk.hex(DIM)(`  … ${vis.length} matches (${start + 1}–${Math.min(start + maxRows, vis.length)} shown)\n`));
      }
      lines.push(chalk.hex(DIM)(`\n  ↑/↓ move · Enter select · ESC back${opts?.filter ? ' · / filter' : ''}\n`));
      process.stdout.write('\x1b[2J\x1b[H' + lines.join(''));
    };

    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const done = (r: ListResult) => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdout.write('\x1b[2J\x1b[H');
      resolve(r);
    };

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      const vis = visible();
      if (key.ctrl && key.name === 'c') return done({ kind: 'cancel' });
      if (key.name === 'escape') {
        if (filtering || filter) { filtering = false; filter = ''; selected = 0; return render(); }
        return done({ kind: 'back' });
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (filtering) { filtering = false; return render(); }
        if (vis.length === 0) return done({ kind: 'cancel' });
        return done({ kind: 'pick', index: vis[selected] });
      }
      if (key.name === 'up') { selected = Math.max(0, selected - 1); filtering = false; return render(); }
      if (key.name === 'down') { selected = Math.min(vis.length - 1, selected + 1); filtering = false; return render(); }
      if (key.name === 'pageup') { selected = Math.max(0, selected - 10); return render(); }
      if (key.name === 'pagedown') { selected = Math.min(vis.length - 1, selected + 10); return render(); }
      if (filtering) {
        if (key.name === 'backspace') { filter = filter.slice(0, -1); selected = 0; return render(); }
        if (str && !key.ctrl && str >= ' ') { filter += str; selected = 0; return render(); }
        return;
      }
      if (opts?.filter && str === '/') { filtering = true; return render(); }
    };

    process.stdin.on('keypress', onKey);
    render();
  });
}

/** Numbered prompt for non-TTY stdin (pipes, tests) — no raw mode available. */
async function numberedListFallback(title: string, items: ListItem[]): Promise<ListResult> {
  console.log(chalk.hex(ACCENT).bold(`\n  ${title}\n`));
  items.forEach((it, i) => console.log(`  ${chalk.hex(ACCENT)(String(i + 1).padStart(3))}. ${it.render}`));
  const answer = await askLine(chalk.hex(DIM)('\n  Number (Enter to cancel): '));
  const n = parseInt(answer.trim(), 10);
  if (isNaN(n) || n < 1 || n > items.length) return { kind: 'cancel' };
  return { kind: 'pick', index: n - 1 };
}

function askLine(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, ans => { rl.close(); resolve(ans); });
  });
}

/** Static models from getAllModels() belonging to one PROVIDER_LIST entry. */
function staticModelsForProvider(providerId: string): { id: string; name: string }[] {
  const match = (id: string, provider: string): boolean => {
    const p = provider.toLowerCase();
    switch (providerId) {
      case 'anthropic': return p === 'anthropic' || id.startsWith('claude-');
      case 'openai': return p === 'openai' || id.startsWith('gpt-') || /^o\d/.test(id);
      case 'gemini':
      case 'vertex': return p === 'google' || id.startsWith('gemini');
      case 'glm': return id.startsWith('glm-') || id.startsWith('zhipu');
      case 'mimo': return id.startsWith('mimo') || id.startsWith('xiaomi/');
      case 'opencode-zen': return id.startsWith('opencode/') || id.startsWith('zen/');
      case 'opencode-go': return id.startsWith('go-anthropic/');
      default: return id.startsWith(`${providerId}/`) || p === providerId;
    }
  };
  const found = getAllModels()
    .filter(m => match(m.id.toLowerCase(), m.provider))
    .map(m => ({ id: m.id, name: m.name }));
  return found.length > 0 ? found : (SELECTOR_STATIC_FALLBACK[providerId] ?? []);
}

// Last-resort entries for providers absent from both KNOWN_MODELS and any
// custom .aura.json list, so their selector page is never empty.
const SELECTOR_STATIC_FALLBACK: Record<string, { id: string; name: string }[]> = {
  deepseek: [
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat (V3)' },
    { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner (R1)' },
  ],
  kimi: [
    { id: 'kimi/kimi-k2-0905-preview', name: 'Kimi K2' },
  ],
  qwen: [
    { id: 'qwen/qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
    { id: 'qwen/qwen-max', name: 'Qwen Max' },
  ],
  minimax: [
    { id: 'minimax/MiniMax-M2', name: 'MiniMax M2' },
    { id: 'minimax/MiniMax-Text-01', name: 'MiniMax Text-01' },
  ],
};

/**
 * Level 2: model list for one provider. Live-fetches when the provider
 * supports it (5s cap), falls back to the static list, and to manual entry
 * when neither has anything. Returns the chosen model id, 'back' on ESC,
 * or undefined on cancel. Never throws.
 */
export async function showModelSelectorForProvider(providerId: string): Promise<string | 'back' | undefined> {
  const entry = PROVIDER_LIST.find(p => p.id === providerId);
  const title = `${entry?.name ?? providerId} — models`;

  if (providerId === 'custom') {
    const id = (await askLine(chalk.hex(ACCENT)('  Model id (e.g. openrouter/vendor/model, Enter to cancel): '))).trim();
    return id || undefined;
  }

  let live: LiveModel[] = [];
  // Known providers only fetch when flagged; unknown ids get a best-effort try.
  if (entry ? entry.liveFetch === true : true) {
    const spinner = process.stdout.isTTY
      ? setInterval(() => process.stdout.write(`\r  ${chalk.hex(ACCENT)('◐◓◑◒'[Math.floor(Date.now() / 120) % 4])} Fetching models...`), 120)
      : undefined;
    try {
      live = await withTimeout(fetchLiveModels(providerId), LIVE_FETCH_TIMEOUT_MS, []);
    } finally {
      if (spinner) { clearInterval(spinner); process.stdout.write('\r\x1b[K'); }
    }
  }

  const models: { id: string; label: string; free?: boolean }[] = live.length > 0
    ? live.map(m => ({ id: m.id, label: m.name ?? m.id, free: m.free }))
    : staticModelsForProvider(providerId).map(m => ({ id: m.id, label: m.name }));

  if (models.length === 0) {
    console.log(chalk.hex(DIM)(`\n  No models found for ${entry?.name ?? providerId} (live fetch empty, no static entries).`));
    const id = (await askLine(chalk.hex(ACCENT)('  Model id (Enter to go back): '))).trim();
    if (!id) return 'back';
    const prefixed = applyRoutePrefix(providerId, id);
    if (prefixed !== id) console.log(chalk.hex(DIM)(`  Routing as ${prefixed}`));
    return prefixed;
  }

  const items: ListItem[] = models.map(m => ({
    label: `${m.label} ${m.id}`,
    render: chalk.hex('#eee8e2')(m.label)
      + (m.id !== m.label ? chalk.hex(DIM)(`  ${m.id}`) : '')
      + (m.free ? chalk.hex(GREEN)(' [free]') : ''),
  }));

  const r = await interactiveList(title, items, { filter: true });
  if (r.kind === 'back') return 'back';
  if (r.kind === 'cancel') return undefined;
  return models[r.index].id;
}

/**
 * Routing prefix the factory expects for models of a given selector provider.
 * A bare id typed on a provider's page gets this prefix so createProvider
 * routes it to that provider's endpoint instead of the OpenAI-compatible
 * default (which 401s against api.openai.com).
 */
const ROUTE_PREFIX: Record<string, string> = {
  'opencode-zen': 'zen/',
  'opencode-go': 'go-anthropic/',
  openrouter: 'openrouter/',
  ollama: 'ollama/',
  lmstudio: 'lmstudio/',
  groq: 'groq/',
  nvidia: 'nvidia/',
  gemini: 'gemini/',
  huggingface: 'huggingface/',
  deepseek: 'deepseek/',
  kimi: 'kimi/',
  qwen: 'qwen/',
  minimax: 'minimax/',
  stepfun: 'stepfun/',
  fireworks: 'fireworks/',
  upstage: 'upstage/',
  arcee: 'arcee/',
  tencent: 'tencent/',
  gmi: 'gmi/',
  kilocode: 'kilocode/',
  alibaba: 'alibaba/',
};

/** Prefix a bare model id with its provider's routing prefix when missing. */
function applyRoutePrefix(providerId: string, id: string): string {
  const prefix = ROUTE_PREFIX[providerId];
  if (!prefix || id.startsWith(prefix)) return id;
  // Already carries some other known routing prefix (user typed it fully) — leave alone.
  if (/^(openrouter|ollama|lmstudio|local|groq|nvidia|gemini|huggingface|deepseek|kimi|qwen|zen|opencode|go-anthropic|zhipu|xiaomi|mimo|xai|minimax|stepfun|fireworks|upstage|arcee|tencent|gmi|kilocode|alibaba)\//.test(id)) return id;
  return prefix + id;
}

/** Mask a secret: last 6 chars visible, e.g. "sk-or-****9f9802". */
function maskKey(key: string): string {
  if (key.length <= 6) return '****';
  return '****' + key.slice(-6);
}

/** Env var holding a provider's base URL override. */
function baseUrlEnvFor(entry: ProviderEntry): string {
  switch (entry.id) {
    case 'ollama': return 'OLLAMA_BASE_URL';
    case 'lmstudio': return 'LMSTUDIO_BASE_URL';
    case 'glm': return 'ZHIPU_BASE_URL';
    default:
      if (entry.envKey?.endsWith('_API_KEY')) return entry.envKey.replace(/_API_KEY$/, '_BASE_URL');
      return `${entry.id.toUpperCase().replace(/-/g, '_')}_BASE_URL`;
  }
}

/**
 * Read one line from stdin with no echo (API keys). Enter finishes,
 * backspace works, Ctrl-C/ESC cancels (returns undefined).
 * Non-TTY stdin falls back to a plain visible prompt.
 */
async function readHiddenLine(prompt: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    const v = (await askLine(prompt)).trim();
    return v || undefined;
  }
  return new Promise(resolve => {
    process.stdout.write(prompt);
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    const done = (result: string | undefined) => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdout.write('\n');
      resolve(result);
    };
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') return done(undefined);
      if (key.name === 'escape') return done(undefined);
      if (key.name === 'return' || key.name === 'enter') return done(value.trim() || undefined);
      if (key.name === 'backspace') { value = value.slice(0, -1); return; }
      if (str && !key.ctrl && str >= ' ') value += str;
    };
    process.stdin.on('keypress', onKey);
  });
}

/** Wait for a single keypress; returns lowercase key name or char. */
async function readSingleKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    const v = (await askLine('')).trim().toLowerCase();
    return v === '' ? 'escape' : v[0];
  }
  return new Promise(resolve => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(wasRaw ?? false);
      if (key.ctrl && key.name === 'c') return resolve('escape');
      resolve((key.name ?? str ?? '').toLowerCase());
    };
    process.stdin.on('keypress', onKey);
  });
}

/** [K] Update API key — masked current value, hidden input, agents.env save. */
async function updateApiKeyFlow(entry: ProviderEntry): Promise<void> {
  if (!entry.envKey) {
    console.log(chalk.hex(DIM)(`\n  ${entry.name} needs no API key.\n`));
    return;
  }
  const current = getApiKey(entry.envKey);
  console.log(chalk.hex(DIM)(`\n  ${entry.envKey}: ${current ? maskKey(current) : chalk.hex('#d4903a')('not set')}`));
  const key = await readHiddenLine(chalk.hex(ACCENT)(`  New key (hidden, Enter to cancel): `));
  if (!key) {
    console.log(chalk.hex(DIM)('  Unchanged.\n'));
    return;
  }
  const file = saveToAgentsEnv(entry.envKey, key);
  console.log(chalk.hex(GREEN)(`  ✓ Key saved`) + chalk.hex(DIM)(` (${entry.envKey} → ${file})\n`));
}

/** [U] Change base URL — visible input, agents.env save. */
async function updateBaseUrlFlow(entry: ProviderEntry): Promise<void> {
  const envVar = baseUrlEnvFor(entry);
  const current = process.env[envVar];
  console.log(chalk.hex(DIM)(`\n  ${envVar}: ${current ?? chalk.hex('#d4903a')('not set (provider default)')}`));
  const url = (await askLine(chalk.hex(ACCENT)('  New base URL (Enter to cancel): '))).trim();
  if (!url) {
    console.log(chalk.hex(DIM)('  Unchanged.\n'));
    return;
  }
  const file = saveToAgentsEnv(envVar, url);
  console.log(chalk.hex(GREEN)(`  ✓ URL saved`) + chalk.hex(DIM)(` (${envVar} → ${file})\n`));
}

/** Per-provider action submenu: browse models / update key / change URL. */
async function providerActionMenu(entry: ProviderEntry): Promise<'models' | 'key' | 'url' | 'back'> {
  const key = entry.envKey ? getApiKey(entry.envKey) : undefined;
  const keyLabel = entry.envKey
    ? (key ? `current: ${maskKey(key)}` : 'not set')
    : 'no key needed';
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(chalk.hex(ACCENT).bold(`\n  ${entry.name}`));
  console.log(chalk.hex(DIM)(`  ${entry.desc}\n`));
  console.log(`  ${chalk.hex(ACCENT)('[M]')} Browse models`);
  console.log(`  ${chalk.hex(ACCENT)('[K]')} Update API key  ${chalk.hex(DIM)(`(${keyLabel})`)}`);
  console.log(`  ${chalk.hex(ACCENT)('[U]')} Change base URL`);
  console.log(`  ${chalk.hex(DIM)('ESC Back')}\n`);
  for (;;) {
    const k = await readSingleKey();
    if (k === 'm' || k === 'return' || k === 'enter') return 'models';
    if (k === 'k') return 'key';
    if (k === 'u') return 'url';
    if (k === 'escape' || k === 'q') return 'back';
  }
}

/**
 * Level 1: full provider list. Configured providers (env key present) show ✓.
 * Selecting a provider opens its action submenu (models / key / URL); ESC
 * anywhere walks back up one level.
 * Returns the finally-chosen model id, or undefined on cancel/ESC.
 */
export async function showProviderSelector(): Promise<string | undefined> {
  for (;;) {
    const items: ListItem[] = PROVIDER_LIST.map(p => {
      const configured = p.envKey ? Boolean(getApiKey(p.envKey)) : false;
      return {
        label: `${p.name} ${p.desc}`,
        render: chalk.hex('#eee8e2')(p.name.padEnd(28))
          + (configured ? chalk.hex(GREEN)('✓ ') : '  ')
          + chalk.hex(DIM)(p.desc),
      };
    });
    const r = await interactiveList('Select provider', items, { filter: true });
    if (r.kind !== 'pick') return undefined;
    const entry = PROVIDER_LIST[r.index];

    submenu: for (;;) {
      const action = await providerActionMenu(entry);
      switch (action) {
        case 'back':
          break submenu;
        case 'key':
          await updateApiKeyFlow(entry);
          continue;
        case 'url':
          await updateBaseUrlFlow(entry);
          continue;
        case 'models': {
          const model = await showModelSelectorForProvider(entry.id);
          if (model === 'back') continue;
          return model;
        }
      }
    }
  }
}

/**
 * Interactive recovery for a 401/403 from a provider: offer to update the
 * API key in place (saved to ~/.secrets/agents.env). Returns the new key
 * when one was entered and saved, undefined otherwise.
 */
export async function promptAuthKeyUpdate(model: string): Promise<string | undefined> {
  const envKey = apiKeyEnvVarForModel(model);
  const family = modelProviderFamily(model);
  const label = PROVIDER_LIST.find(p => p.envKey === envKey)?.name ?? family;
  console.log(chalk.hex('#d4903a')(`\n  ⚠ API key rejected for ${label}. Press K to update key or ESC to cancel.`));
  const k = await readSingleKey();
  if (k !== 'k') {
    console.log(chalk.hex(DIM)('  Cancelled.\n'));
    return undefined;
  }
  if (!envKey) {
    console.log(chalk.hex(DIM)(`  No API-key env var known for model "${model}" — set it with :apikey instead.\n`));
    return undefined;
  }
  const current = getApiKey(envKey);
  console.log(chalk.hex(DIM)(`  ${envKey}: ${current ? maskKey(current) : 'not set'}`));
  const key = await readHiddenLine(chalk.hex(ACCENT)('  New key (hidden, Enter to cancel): '));
  if (!key) {
    console.log(chalk.hex(DIM)('  Unchanged.\n'));
    return undefined;
  }
  const file = saveToAgentsEnv(envKey, key);
  console.log(chalk.hex(GREEN)('  ✓ Key saved') + chalk.hex(DIM)(` (${envKey} → ${file})\n`));
  return key;
}

export function layoutColumns<T>(items: T[], cellWidth: number, termWidth: number, indent: number): T[][] {
  const usable = Math.max(cellWidth, termWidth - indent);
  const cols = Math.max(1, Math.floor(usable / cellWidth));
  const rowCount = Math.ceil(items.length / cols);
  const grid: T[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: T[] = [];
    for (let c = 0; c < cols; c++) {
      const idx = c * rowCount + r;
      if (idx < items.length) row.push(items[idx]);
    }
    grid.push(row);
  }
  return grid;
}
