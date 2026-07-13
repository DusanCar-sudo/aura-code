import { apiKeyEnvVarForModel, modelProviderFamily } from '../providers/factory.js';

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
