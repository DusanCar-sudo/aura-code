import { useState, useCallback, useEffect } from 'react';
import { LOCALES, type Locale } from '../i18n';
import type { PermissionLevel, Settings as S } from '../lib/settings';

type T = (key: string) => string;
export type SettingsTab = 'agents' | 'models' | 'skills' | 'autonomy' | 'general';

export interface ToolInfo {
  name: string;
  description: string;
}

interface AgentPersona {
  key: string;
  name: string;
  desc: string;
  tools: string[];
}

export interface ModelOption {
  id: string;
  name?: string;
  label?: string;
  provider: string;
  speed?: string;
  hasKey?: boolean;
}

const PRELOADED_AGENTS: AgentPersona[] = [
  {
    key: 'aura',
    name: 'Aura',
    desc: 'The default. Reproduces before touching, verifies before reporting. Full tool grant.',
    tools: ['read', 'list', 'edit', 'write', 'search', 'shell', 'test', 'git'],
  },
  {
    key: 'coder',
    name: 'Coder',
    desc: 'Writes and edits code, runs the suite. No shell, no git push without a gate.',
    tools: ['read', 'list', 'edit', 'write', 'test'],
  },
  {
    key: 'researcher',
    name: 'Researcher',
    desc: 'Reads and searches only. Never writes. Produces findings with citations.',
    tools: ['read', 'list', 'search'],
  },
  {
    key: 'writer',
    name: 'Writer',
    desc: 'Docs, changelogs, comments. Edits prose files, runs no code.',
    tools: ['read', 'edit', 'write'],
  },
];

const ALL_TOOLS = [
  { name: 'read', icon: '📄', label: 'read' },
  { name: 'list', icon: '📁', label: 'list' },
  { name: 'edit', icon: '✏️', label: 'edit' },
  { name: 'write', icon: '📝', label: 'write' },
  { name: 'search', icon: '🔍', label: 'search' },
  { name: 'shell', icon: '⚡', label: 'shell' },
  { name: 'test', icon: '🧪', label: 'test' },
  { name: 'git', icon: '🌿', label: 'git' },
];

interface ProviderEntry {
  id: string;
  name: string;
  envKey?: string;
  role: 'primary' | 'mesh' | 'archimedes' | 'review';
  endpoint: string;
  model: string;
  key: string;
  ping: string;
  pingOk: boolean;
}

const DEFAULT_PROVIDERS: ProviderEntry[] = [
  { id: 'p1', name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', role: 'primary', endpoint: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5-20251001', key: 'sk-ant-api03-9Xk2...7pQ4', ping: '42ms', pingOk: true },
  { id: 'p2', name: 'OpenCode Zen (Free & Fast)', envKey: 'OPENCODE_API_KEY', role: 'mesh', endpoint: 'https://opencode.ai/zen/v1', model: 'opencode/big-pickle', key: 'opencode-free', ping: '35ms', pingOk: true },
  { id: 'p3', name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', role: 'mesh', endpoint: 'https://openrouter.ai/api/v1', model: 'openrouter/deepseek/deepseek-v4-pro', key: 'sk-or-v1-b81f...c30a', ping: '118ms', pingOk: true },
  { id: 'p4', name: 'NVIDIA NIM (Nemotron)', envKey: 'NVIDIA_API_KEY', role: 'mesh', endpoint: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/llama-3.1-nemotron-70b-instruct', key: 'nvapi-9aK8...3xP1', ping: '55ms', pingOk: true },
  { id: 'p5', name: 'FPT Cloud AI', envKey: 'FPT_API_KEY', role: 'mesh', endpoint: 'https://mkp-api.fptcloud.com/v1', model: 'fpt/DeepSeek-V4-Flash', key: 'fpt-mkp-7b1...2c0a', ping: '62ms', pingOk: true },
  { id: 'p6', name: 'BytePlus ModelArk', envKey: 'ARK_API_KEY', role: 'mesh', endpoint: 'https://ark.ap-southeast.bytepluses.com/api/v3', model: 'byteplus/deepseek-v4-flash-ga-260731', key: 'ark-sec-88c...90e', ping: '48ms', pingOk: true },
  { id: 'p7', name: 'Google (Gemini)', envKey: 'GOOGLE_API_KEY', role: 'review', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-pro-preview', key: 'AIza...9wQ1', ping: '28ms', pingOk: true },
  { id: 'p8', name: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', role: 'mesh', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', key: 'sk-d98...21fa', ping: '84ms', pingOk: true },
  { id: 'p9', name: 'Xiaomi MiMo', envKey: 'XIAOMI_API_KEY', role: 'mesh', endpoint: 'https://token-plan-sgp.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', key: 'mimo-tp-92...11c', ping: '92ms', pingOk: true },
  { id: 'p10', name: 'Ollama (local)', envKey: undefined, role: 'archimedes', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder:30b', key: '-', ping: '6ms', pingOk: true },
];

const COMPREHENSIVE_FALLBACK_MODELS: ModelOption[] = [
  // OpenCode
  { id: 'opencode/big-pickle', label: 'Big Pickle (free)', provider: 'OpenCode', speed: 'Powerful · free' },
  { id: 'opencode/mimo-v2.5-free', label: 'MiMo V2.5 (free)', provider: 'OpenCode', speed: 'Fast · free' },
  { id: 'opencode/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra (free)', provider: 'OpenCode', speed: 'Powerful · free' },
  { id: 'opencode/hy3-free', label: 'HY3 (free)', provider: 'OpenCode', speed: 'Fast · free' },
  { id: 'opencode/gpt-5.4', label: 'GPT-5.4', provider: 'OpenCode', speed: 'Powerful · paid' },
  { id: 'opencode/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'OpenCode', speed: 'Powerful · paid' },
  { id: 'go-anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 (Go)', provider: 'OpenCode', speed: 'Powerful' },
  { id: 'go-anthropic/claude-opus-5', label: 'Claude Opus 5 (Go)', provider: 'OpenCode', speed: 'Powerful' },
  // OpenRouter
  { id: 'openrouter/deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro (OR)', provider: 'OpenRouter', speed: 'Powerful · open' },
  { id: 'openrouter/deepseek/deepseek-r1', label: 'DeepSeek R1 (OR)', provider: 'OpenRouter', speed: 'Reasoning · open' },
  { id: 'openrouter/anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (OR)', provider: 'OpenRouter', speed: 'Fast' },
  { id: 'openrouter/openai/gpt-4o', label: 'GPT-4o (OR)', provider: 'OpenRouter', speed: 'Powerful' },
  { id: 'openrouter/meta-llama/llama-3.1-405b-instruct', label: 'Llama 3.1 405B (OR)', provider: 'OpenRouter', speed: 'Open · powerful' },
  { id: 'openrouter/meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B (OR)', provider: 'OpenRouter', speed: 'Open · fast' },
  // NVIDIA Nemotron & NIM
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B (NIM)', provider: 'NVIDIA Nemotron', speed: 'Powerful · 131k' },
  { id: 'nvidia/meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (NIM)', provider: 'NVIDIA Nemotron', speed: 'Powerful · 128k' },
  { id: 'nvidia/deepseek-ai/deepseek-r1', label: 'DeepSeek R1 (NIM)', provider: 'NVIDIA Nemotron', speed: 'Reasoning · flagship' },
  // FPT Cloud AI
  { id: 'fpt/DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash (FPT)', provider: 'FPT Cloud AI', speed: 'Fast · marketplace' },
  { id: 'fpt/GLM-5.2', label: 'GLM-5.2 (FPT)', provider: 'FPT Cloud AI', speed: 'Powerful · marketplace' },
  { id: 'fpt/Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B (FPT)', provider: 'FPT Cloud AI', speed: 'Code · marketplace' },
  // BytePlus ModelArk
  { id: 'byteplus/deepseek-v4-flash-ga-260731', label: 'DeepSeek V4 Flash GA', provider: 'BytePlus ModelArk', speed: 'Fast · GA build' },
  { id: 'byteplus/deepseek-v4-pro-ga-260813', label: 'DeepSeek V4 Pro GA', provider: 'BytePlus ModelArk', speed: 'Powerful · GA build' },
  // Google Gemini
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', provider: 'Google', speed: 'Powerful · reasoning' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', provider: 'Google', speed: 'Fast · cheap' },
  { id: 'gemini-pro-latest', label: 'Gemini Pro (latest)', provider: 'Google', speed: 'Powerful' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'Google', speed: 'Fast' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', provider: 'Google', speed: 'Fastest · cheap' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', provider: 'Google', speed: 'Fast · cheap' },
  // Anthropic Claude
  { id: 'claude-sonnet-4-5-20251001', label: 'Claude Sonnet 4.5', provider: 'Anthropic', speed: 'Fast · balanced' },
  { id: 'claude-opus-4-5-20251001', label: 'Claude Opus 4.5', provider: 'Anthropic', speed: 'Powerful · flagship' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'Anthropic', speed: 'Fastest · cheap' },
  // OpenAI
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', speed: 'Fast · general' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI', speed: 'Fastest' },
  { id: 'o1', label: 'o1', provider: 'OpenAI', speed: 'Reasoning · flagship' },
  { id: 'o3-mini', label: 'o3-mini', provider: 'OpenAI', speed: 'Reasoning · fast' },
  // DeepSeek
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'DeepSeek', speed: 'Fast · 1M context' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'DeepSeek', speed: 'Powerful · 1M context' },
  // Xiaomi MiMo
  { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', provider: 'Xiaomi MiMo', speed: 'Powerful · 1T' },
  { id: 'mimo-v2.5', label: 'MiMo V2.5', provider: 'Xiaomi MiMo', speed: 'Fast · 310B' },
  // Zhipu
  { id: 'glm-5.2', label: 'GLM-5.2', provider: 'Zhipu', speed: 'Powerful · 1M context' },
  { id: 'glm-5.1', label: 'GLM-5.1', provider: 'Zhipu', speed: 'Powerful · agentic' },
  // Qwen
  { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', provider: 'Qwen', speed: 'Powerful · code' },
  { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash', provider: 'Qwen', speed: 'Fastest · code' },
  // Ollama
  { id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B (local)', provider: 'Ollama', speed: 'Local · code' },
  { id: 'llama3.3', label: 'Llama 3.3 (local)', provider: 'Ollama', speed: 'Local · 70B' },
];

interface SkillItem {
  id: string;
  name: string;
  type: 'skill' | 'plugin';
  version: string;
  desc: string;
  on: boolean;
}

const DEFAULT_SKILLS: SkillItem[] = [
  { id: 's1', name: 'read-pdf', type: 'skill', version: '1.4.0', desc: 'Extract text and tables from PDFs into markdown.', on: true },
  { id: 's2', name: 'playwright-verify', type: 'plugin', version: '0.9.2', desc: 'Registers a browser tool so I can verify UI claims by clicking.', on: true },
  { id: 's3', name: 'sql-explain', type: 'skill', version: '2.0.1', desc: 'Run EXPLAIN ANALYZE and read the plan before proposing an index.', on: true },
  { id: 's4', name: 'mesh-debate', type: 'plugin', version: '0.4.7', desc: 'Fan a decision out to three providers and diff their reasoning.', on: false },
  { id: 's5', name: 'changelog-writer', type: 'skill', version: '1.1.0', desc: 'Writes Was:/Fixed: entries from the verified diff.', on: true },
];

export function SettingsPanel({
  settings,
  tools,
  availableModels = [],
  t,
  initialTab = 'agents',
  activeAgentName = 'Aura',
  onAgentNameChange,
  onChange,
  onClose,
}: {
  settings: S;
  tools: ToolInfo[];
  availableModels?: ModelOption[];
  t: T;
  initialTab?: SettingsTab;
  activeAgentName?: string;
  onAgentNameChange?: (name: string) => void;
  onChange: (patch: Partial<S>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [agentKey, setAgentKey] = useState<string>('aura');
  const [agentName, setAgentName] = useState<string>(activeAgentName);
  const [agentTools, setAgentTools] = useState<string[]>(PRELOADED_AGENTS[0].tools);
  const [providers, setProviders] = useState<ProviderEntry[]>(DEFAULT_PROVIDERS);
  const [allModels, setAllModels] = useState<ModelOption[]>(
    availableModels.length > 0 ? availableModels : COMPREHENSIVE_FALLBACK_MODELS
  );
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [skills, setSkills] = useState<SkillItem[]>(DEFAULT_SKILLS);
  const [dragOver, setDragOver] = useState(false);
  const [dropStatus, setDropStatus] = useState('nothing staged');

  useEffect(() => {
    fetch('/api/models')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.models) && data.models.length > 0) {
          setAllModels(data.models);
        }
      })
      .catch(() => {});

    fetch('/api/providers')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.providers)) {
          setProviders((prev) =>
            prev.map((p) => {
              const found = data.providers.find(
                (prov: any) => prov.envKey === p.envKey || prov.name.toLowerCase() === p.name.toLowerCase()
              );
              if (found && found.keySet) {
                return { ...p, pingOk: true };
              }
              return p;
            })
          );
        }
      })
      .catch(() => {});
  }, []);

  const tabTitles: Record<SettingsTab, string> = {
    agents: 'Agents',
    models: 'Providers & Models — OpenCode, OpenRouter, NVIDIA Nemotron, FPT, BytePlus & More',
    skills: 'Skills & plugins',
    autonomy: 'Approval & sandbox',
    general: 'General Preferences',
  };

  const handleAgentSelect = (a: AgentPersona) => {
    setAgentKey(a.key);
    setAgentName(a.name);
    setAgentTools([...a.tools]);
    onAgentNameChange?.(a.name);
  };

  const toggleTool = (toolName: string) => {
    setAgentTools((prev) =>
      prev.includes(toolName) ? prev.filter((x) => x !== toolName) : [...prev, toolName],
    );
  };

  const handleProviderEdit = (id: string, field: 'endpoint' | 'model' | 'key' | 'name', val: string) => {
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: val } : p)));
    if (field === 'model') {
      const p = providers.find((x) => x.id === id);
      if (p && p.role === 'primary') {
        onChange({ model: val });
        fetch('/api/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: val }),
        }).catch(() => {});
      }
    } else if (field === 'key') {
      const p = providers.find((x) => x.id === id);
      if (p?.envKey) {
        fetch('/api/apikey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envKey: p.envKey, value: val }),
        }).catch(() => {});
      }
    }
  };

  const setPrimaryProvider = (id: string) => {
    setProviders((prev) =>
      prev.map((p) => ({
        ...p,
        role: p.id === id ? 'primary' : p.role === 'primary' ? 'mesh' : p.role,
      })),
    );
    const chosen = providers.find((p) => p.id === id);
    if (chosen) {
      onChange({ model: chosen.model, provider: chosen.name });
    }
  };

  const toggleSkill = (id: string) => {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, on: !s.on } : s)));
  };

  // Group models by provider for dropdown optgroups
  const modelsByProvider: Record<string, ModelOption[]> = {};
  for (const m of allModels) {
    const prov = m.provider || 'Other';
    if (!modelsByProvider[prov]) modelsByProvider[prov] = [];
    modelsByProvider[prov].push(m);
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-header">
          <div className="settings-tab-buttons" role="tablist">
            {(['agents', 'models', 'skills', 'autonomy', 'general'] as SettingsTab[]).map((tKey) => (
              <button
                key={tKey}
                type="button"
                role="tab"
                aria-selected={tab === tKey}
                className={`settings-nav-tab ${tab === tKey ? 'active' : ''}`}
                onClick={() => setTab(tKey)}
              >
                {tKey.charAt(0).toUpperCase() + tKey.slice(1)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="settings-close-btn"
            aria-label="Close settings"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-scroll-area">
            <h1 className="tab-main-heading">{tabTitles[tab]}</h1>

            {tab === 'agents' && (
              <div className="tab-agents">
                <p className="tab-intro">
                  Aura changes personality and tool grants depending on what she is doing. Click one to inspect or switch persona for this session.
                </p>

                <div className="section-label">Preloaded</div>
                <div className="persona-list">
                  {PRELOADED_AGENTS.map((a) => {
                    const isSelected = agentKey === a.key;
                    return (
                      <button
                        key={a.key}
                        type="button"
                        className={`persona-card ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleAgentSelect(a)}
                      >
                        <span className={`radio-outer ${isSelected ? 'checked' : ''}`}>
                          {isSelected && <span className="radio-inner" />}
                        </span>
                        <div className="persona-info">
                          <div className="persona-head">
                            <span className="persona-name">{a.name}</span>
                            <span className="persona-count">{a.tools.length} tools</span>
                          </div>
                          <div className="persona-desc">{a.desc}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="section-label" style={{ marginTop: '22px' }}>Active agent name</div>
                <input
                  className="agent-name-input"
                  value={agentName}
                  onChange={(e) => {
                    setAgentName(e.target.value);
                    onAgentNameChange?.(e.target.value);
                  }}
                />

                <div className="section-label" style={{ marginTop: '22px' }}>
                  Tools this agent may call — {agentTools.length} of {ALL_TOOLS.length}
                </div>
                <div className="tool-grants-grid">
                  {ALL_TOOLS.map((tItem) => {
                    const granted = agentTools.includes(tItem.name);
                    return (
                      <button
                        key={tItem.name}
                        type="button"
                        className={`tool-grant-chip ${granted ? 'granted' : ''}`}
                        onClick={() => toggleTool(tItem.name)}
                      >
                        <span className="tool-grant-icon">{tItem.icon}</span>
                        <span className="tool-grant-name">{tItem.label}</span>
                        <span className="tool-grant-check">{granted ? '✓' : ''}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === 'models' && (
              <div className="tab-models">
                <p className="tab-intro">
                  Model-agnostic by design. Choose any model via the dropdown menu for each provider. All major providers are supported: OpenCode, OpenRouter, NVIDIA Nemotron, FPT Cloud AI, BytePlus ModelArk, Google Gemini, Anthropic, OpenAI, DeepSeek, Xiaomi MiMo, and Ollama.
                </p>

                <div className="providers-list">
                  {providers.map((p) => {
                    const isPrimary = p.role === 'primary';
                    const isKeyRevealed = !!revealedKeys[p.id];
                    return (
                      <div key={p.id} className={`provider-card ${isPrimary ? 'primary' : ''}`}>
                        <div className="provider-card-head">
                          <button
                            type="button"
                            className="provider-radio-btn"
                            onClick={() => setPrimaryProvider(p.id)}
                            title="Set as primary model for loop"
                          >
                            <span className={`radio-outer ${isPrimary ? 'checked' : ''}`}>
                              {isPrimary && <span className="radio-inner" />}
                            </span>
                          </button>
                          <span className="provider-name">{p.name}</span>
                          <span className={`provider-role-badge role-${p.role}`}>{p.role}</span>
                          <div className="spacer" />
                          <span className={`provider-ping ${p.pingOk ? 'ok' : 'err'}`}>
                            {p.ping}
                          </span>
                        </div>

                        <div className="provider-fields-grid">
                          <label className="provider-field">
                            <span className="field-meta">Endpoint</span>
                            <input
                              className="field-input"
                              value={p.endpoint}
                              onChange={(e) => handleProviderEdit(p.id, 'endpoint', e.target.value)}
                            />
                          </label>

                          <label className="provider-field">
                            <span className="field-meta">Model ID (Dropdown Selector)</span>
                            <div className="model-select-wrapper">
                              <select
                                className="field-input field-select-model"
                                value={p.model}
                                onChange={(e) => handleProviderEdit(p.id, 'model', e.target.value)}
                              >
                                {p.model && !allModels.some((m) => m.id === p.model) && (
                                  <option value={p.model}>{p.model} (Custom / Current)</option>
                                )}
                                {Object.entries(modelsByProvider).map(([providerName, mList]) => (
                                  <optgroup key={providerName} label={`── ${providerName} ──`}>
                                    {mList.map((mItem) => (
                                      <option key={mItem.id} value={mItem.id}>
                                        {mItem.name || mItem.label || mItem.id} {mItem.speed ? `(${mItem.speed})` : ''}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            </div>
                          </label>

                          <label className="provider-field full-row">
                            <span className="field-meta">API key</span>
                            <div className="key-row">
                              <input
                                className="field-input key-input"
                                value={isKeyRevealed ? 'sk-live-configured-api-key' : p.key}
                                onChange={(e) => handleProviderEdit(p.id, 'key', e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn-key-toggle"
                                onClick={() =>
                                  setRevealedKeys((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                                }
                              >
                                {isKeyRevealed ? 'Hide' : 'Reveal'}
                              </button>
                            </div>
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
                  <button
                    type="button"
                    className="btn-add-endpoint"
                    onClick={() => {
                      const id = `p${Date.now()}`;
                      setProviders((prev) => [
                        ...prev,
                        {
                          id,
                          name: 'New Provider',
                          role: 'mesh',
                          endpoint: 'https://opencode.ai/zen/v1',
                          model: 'opencode/big-pickle',
                          key: '',
                          ping: '-',
                          pingOk: true,
                        },
                      ]);
                    }}
                  >
                    + Add Provider Endpoint
                  </button>
                </div>
              </div>
            )}

            {tab === 'skills' && (
              <div className="tab-skills">
                <p className="tab-intro">
                  A skill is a folder with a SKILL.md and its scripts. A plugin registers new tools with the loop. Both are read from your machine and mounted into the current work.
                </p>

                <label
                  className={`skill-dropzone ${dragOver ? 'drag-over' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const files = e.dataTransfer?.files;
                    if (files && files.length > 0) {
                      setDropStatus(`staged ${files[0].name} — click save to mount`);
                    }
                  }}
                >
                  <div className="dropzone-plus">+</div>
                  <div className="dropzone-text">Drop a skill folder or plugin .ts here</div>
                  <div className="dropzone-sub">
                    or select a file from <span className="underline">your machine</span>
                  </div>
                  <div className="dropzone-status">{dropStatus}</div>
                  <input type="file" style={{ display: 'none' }} />
                </label>

                <div className="section-label" style={{ marginTop: '22px' }}>Installed on this machine</div>
                <div className="skills-list">
                  {skills.map((s) => (
                    <div key={s.id} className="skill-card">
                      <div className="skill-head">
                        <span className="skill-name">{s.name}</span>
                        <span className="skill-ver">v{s.version}</span>
                        <span className={`skill-type-tag type-${s.type}`}>{s.type}</span>
                        <div className="spacer" />
                        <button
                          type="button"
                          className={`skill-toggle-switch ${s.on ? 'on' : 'off'}`}
                          onClick={() => toggleSkill(s.id)}
                        >
                          <span className="toggle-knob" />
                        </button>
                      </div>
                      <div className="skill-desc">{s.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'autonomy' && (
              <div className="tab-autonomy">
                <p className="tab-intro">
                  How much to ask before acting. The engine is read-only in planning; these gates apply once it enters execution.
                </p>

                <div className="section-label">Execution gate</div>
                <div className="permission-choices">
                  {[
                    { val: 'ask', label: 'Ask first (normal)', sub: 'Prompts for confirmation before every file edit and shell command.' },
                    { val: 'auto', label: 'Autonomous (--auto)', sub: 'Runs uninterrupted. Stops only on errors, gates, or task completion.' },
                    { val: 'plan', label: 'Read-only planning (--plan)', sub: 'Inspects codebase and writes a plan, but modifies no files.' },
                  ].map((opt) => (
                    <button
                      key={opt.val}
                      type="button"
                      className={`perm-choice-card ${settings.permission === opt.val ? 'selected' : ''}`}
                      onClick={() => onChange({ permission: opt.val as PermissionLevel })}
                    >
                      <span className={`radio-outer ${settings.permission === opt.val ? 'checked' : ''}`}>
                        {settings.permission === opt.val && <span className="radio-inner" />}
                      </span>
                      <div className="perm-info">
                        <div className="perm-label">{opt.label}</div>
                        <div className="perm-sub">{opt.sub}</div>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="section-label" style={{ marginTop: '24px' }}>Sandbox</div>
                <div className="sandbox-card">
                  <div className="sandbox-head">
                    <span className="sandbox-name">Filesystem isolation</span>
                    <span className={`sandbox-status-tag ${settings.sandbox ? 'on' : 'off'}`}>
                      {settings.sandbox ? 'enabled' : 'disabled'}
                    </span>
                    <div className="spacer" />
                    <button
                      type="button"
                      className={`skill-toggle-switch ${settings.sandbox ? 'on' : 'off'}`}
                      onClick={() => onChange({ sandbox: !settings.sandbox })}
                    >
                      <span className="toggle-knob" />
                    </button>
                  </div>
                  <div className="sandbox-desc">
                    When enabled, file writes and shell commands are restricted to the project root directory.
                  </div>
                </div>
              </div>
            )}

            {tab === 'general' && (
              <div className="tab-general">
                <p className="tab-intro">
                  Language, theme, attribution, and project parameters.
                </p>

                <div className="form-field-group" style={{ marginBottom: '16px' }}>
                  <label className="form-label">Interface Language</label>
                  <select
                    className="form-select"
                    value={settings.locale}
                    onChange={(e) => onChange({ locale: e.target.value as Locale })}
                  >
                    {Object.entries(LOCALES).map(([code, info]) => (
                      <option key={code} value={code}>
                        {info.native} ({info.name})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field-group" style={{ marginBottom: '20px' }}>
                  <label className="form-label">Theme</label>
                  <select
                    className="form-select"
                    value={settings.theme}
                    onChange={(e) => onChange({ theme: e.target.value as 'dark' | 'light' })}
                  >
                    <option value="dark">Dark (Default obsidian)</option>
                    <option value="light">Light</option>
                  </select>
                </div>

                {/* Attribution & Disclaimer Card */}
                <div
                  className="general-attribution-card"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px',
                    padding: '8px 0',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '24px' }}>⚡</span>
                    <div>
                      <div
                        style={{
                          fontFamily: 'var(--font-serif)',
                          fontSize: '22px',
                          color: 'var(--ink)',
                          fontWeight: 600,
                        }}
                      >
                        Built by Aura Code for LeanprogressIQ
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '16px',
                          marginTop: '6px',
                          fontFamily: 'var(--font-mono)',
                          fontSize: '13.5px',
                        }}
                      >
                        <a
                          href="https://leanproiq.com"
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'var(--acc2)', textDecoration: 'none', fontWeight: 600 }}
                        >
                          leanproiq.com ↗
                        </a>
                        <span style={{ color: 'var(--dim)' }}>·</span>
                        <a
                          href="https://aurawebsite-self.vercel.app"
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'var(--acc2)', textDecoration: 'none', fontWeight: 600 }}
                        >
                          aurawebsite-self.vercel.app ↗
                        </a>
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '14px',
                      color: 'var(--txt)',
                      lineHeight: '1.6',
                    }}
                  >
                    <strong style={{ color: 'var(--ink)', fontSize: '15px' }}>Architect & Developer:</strong> Dusan Milosavljevic (System Architect and Developer)
                  </div>

                  <div
                    style={{
                      fontSize: '13.5px',
                      lineHeight: '1.65',
                      color: 'var(--mut)',
                      borderTop: '1px solid var(--line)',
                      paddingTop: '12px',
                    }}
                  >
                    <strong style={{ color: 'var(--ink)', textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '12px' }}>
                      Disclaimer:
                    </strong>{' '}
                    AI-generated responses (summaries, chat, benchmarks analysis, etc.) may be inaccurate or incomplete. Aura Code does not verify model output — treat it as a starting point, not a source of truth, and confirm anything important independently.
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
