import * as readline from 'readline';
import chalk from 'chalk';
import { apiKeyEnvVarForModel, modelProviderFamily, getAllModels } from '../providers/factory.js';
import { PROVIDER_LIST, fetchLiveModels } from '../providers/live-models.js';
import type { LiveModel } from '../providers/live-models.js';
import { getApiKey } from '../util/env.js';

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
    return id || 'back';
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
 * Level 1: full provider list. Configured providers (env key present) show ✓.
 * Selecting a provider opens its model list; ESC there returns here.
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
    const model = await showModelSelectorForProvider(PROVIDER_LIST[r.index].id);
    if (model === 'back') continue;
    return model;
  }
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
