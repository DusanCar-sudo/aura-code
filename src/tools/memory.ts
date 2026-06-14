import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Persistent Memory — cross-session knowledge store
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryInput {
  action: 'remember' | 'recall' | 'forget' | 'list';
  key?: string;
  value?: string;
  namespace?: string;
}

export const MEMORY_DEFINITION: ToolDefinition = {
  name: 'memory',
  description:
    'Persistent memory that survives across sessions. Store, retrieve, list, and delete key-value pairs. ' +
    'Use for remembering user preferences, project context, decisions, personal info.',
  parameters: {
    type: 'object',
    properties: {
      action:    { type: 'string', description: 'Action: remember, recall, forget, list' },
      key:       { type: 'string', description: 'Memory key (required for remember/recall/forget)' },
      value:     { type: 'string', description: 'Value to store (required for remember)' },
      namespace: { type: 'string', description: 'Optional namespace (default: "default")' },
    },
    required: ['action'],
  },
};

function memoryDir(): string {
  const dir = path.join(os.homedir(), '.aura', 'memory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function memoryPath(namespace: string): string {
  return path.join(memoryDir(), `${namespace}.json`);
}

function loadStore(namespace: string): Record<string, { value: string; updated: string }> {
  const p = memoryPath(namespace);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(namespace: string, store: Record<string, { value: string; updated: string }>): void {
  const p = memoryPath(namespace);
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8');
}

export async function memoryTool(input: MemoryInput): Promise<string> {
  const ns = input.namespace ?? 'default';

  switch (input.action) {
    case 'remember': {
      if (!input.key) return 'Error: key is required for remember';
      if (input.value === undefined) return 'Error: value is required for remember';
      const store = loadStore(ns);
      store[input.key] = { value: input.value, updated: new Date().toISOString() };
      saveStore(ns, store);
      return `Remembered "${input.key}" in namespace "${ns}"`;
    }

    case 'recall': {
      if (!input.key) return 'Error: key is required for recall';
      const store = loadStore(ns);
      const entry = store[input.key];
      if (!entry) return `No memory found for key "${input.key}" in namespace "${ns}"`;
      return `Memory [${input.key}]: ${entry.value}\n(Last updated: ${entry.updated})`;
    }

    case 'forget': {
      if (!input.key) return 'Error: key is required for forget';
      const store = loadStore(ns);
      if (!store[input.key]) return `No memory found for key "${input.key}" in namespace "${ns}"`;
      delete store[input.key];
      saveStore(ns, store);
      return `Forgot "${input.key}" in namespace "${ns}"`;
    }

    case 'list': {
      const store = loadStore(ns);
      const keys = Object.keys(store);
      if (keys.length === 0) return `No memories in namespace "${ns}"`;
      const lines = keys.map(k => `• ${k}: ${store[k].value.slice(0, 100)}${store[k].value.length > 100 ? '...' : ''}`);
      return `Memories in namespace "${ns}" (${keys.length}):\n${lines.join('\n')}`;
    }

    default:
      return `Error: Unknown memory action: ${input.action}`;
  }
}
