import { useCallback, useEffect, useRef, useState } from 'react';
import { useAura } from './hooks/useAura';
import { loadSettings, saveSettings, type Settings } from './lib/settings';
import { LOCALES, translate } from './i18n';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { Board, type ModelItem } from './components/Board';
import { Canvas } from './components/Canvas';
import { Code } from './components/Code';
import { SettingsPanel, type SettingsTab } from './components/Settings';
import auraSign from './assets/aura-sign.webp';
import { runCommand } from './lib/commands';

export type MainView = 'chat' | 'kanban' | 'canvas' | 'code';

const DEFAULT_MODELS_FALLBACK: ModelItem[] = [
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)', provider: 'Google', speed: 'Powerful · reasoning', hasKey: true },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', provider: 'Google', speed: 'Fast · cheap', hasKey: true },
  { id: 'gemini-pro-latest', name: 'Gemini Pro (latest)', provider: 'Google', speed: 'Powerful', hasKey: true },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'Google', speed: 'Fast', hasKey: true },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', provider: 'Google', speed: 'Fastest · cheap', hasKey: true },
  { id: 'cerebras/llama-3.3-70b', name: 'Llama 3.3 70B (Free Wafer-Scale)', provider: 'Cerebras', speed: 'Ultra-fast · free', hasKey: true },
  { id: 'sambanova/Meta-Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B (Free Tier)', provider: 'SambaNova', speed: 'Ultra-fast · free', hasKey: true },
  { id: 'opencode/big-pickle', name: 'Big Pickle (Free)', provider: 'OpenCode', speed: 'Powerful · free', hasKey: true },
  { id: 'openrouter/google/gemini-2.0-flash-lite-001:free', name: 'Gemini 2.0 Flash Lite (Free)', provider: 'OpenRouter', speed: 'Fast · free', hasKey: true },
  { id: 'groq/llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq)', provider: 'Groq', speed: 'Ultra-fast · 128k', hasKey: true },
  { id: 'mistral/codestral-latest', name: 'Codestral Latest', provider: 'Mistral AI', speed: 'Code · fast', hasKey: true },
  { id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', provider: 'Together AI', speed: 'Fast · 128k', hasKey: true },
  { id: 'cohere/command-r-plus-08-2024', name: 'Command R+ 08-2024', provider: 'Cohere', speed: 'Powerful · 128k', hasKey: true },
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'NVIDIA Nemotron 70B', provider: 'NVIDIA NIM', speed: 'Powerful · 131k', hasKey: true },
  { id: 'claude-sonnet-4-5-20251001', name: 'Claude Sonnet 4.5', provider: 'Anthropic', speed: 'Fast · balanced', hasKey: true },
  { id: 'claude-opus-4-5-20251001', name: 'Claude Opus 4.5', provider: 'Anthropic', speed: 'Powerful · flagship', hasKey: true },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI', speed: 'Fast · general', hasKey: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI', speed: 'Fastest', hasKey: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'DeepSeek', speed: 'Fast · 1M context', hasKey: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'DeepSeek', speed: 'Powerful · 1M context', hasKey: true },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', provider: 'Xiaomi MiMo', speed: 'Powerful · 1T', hasKey: true },
  { id: 'qwen3-coder:30b', name: 'Qwen3 Coder 30B (local)', provider: 'Ollama', speed: 'Local · fast', hasKey: true },
];

export function isTaskIntent(input: string): boolean {
  const text = input.trim().toLowerCase();
  if (!text) return false;

  const casualPhrases = new Set([
    'hi', 'hello', 'hey', 'yo', 'sup', 'howdy', 'good morning', 'good afternoon', 'good evening',
    'who are you', 'what are you', 'what can you do', 'what do you do', 'how are you',
    'thanks', 'thank you', 'thx', 'cool', 'nice', 'awesome', 'ok', 'okay', 'great',
    'help', 'bye', 'goodbye', 'ping', 'test'
  ]);
  const cleaned = text.replace(/[!?.,]/g, '');
  if (casualPhrases.has(cleaned)) return false;

  const actionKeywords = [
    'build', 'create', 'add', 'fix', 'implement', 'refactor', 'update', 'delete', 'remove',
    'change', 'modify', 'run', 'test', 'debug', 'check', 'search', 'find', 'read', 'write',
    'install', 'deploy', 'generate', 'setup', 'configure', 'optimize', 'parse', 'inspect',
    'clean', 'convert', 'script', 'component', 'function', 'class', 'file', 'code', 'bug',
    'issue', 'error', 'feature', 'kanban', 'tab', 'ui', 'api', 'server', 'db'
  ];

  const hasActionKeyword = actionKeywords.some((kw) => text.includes(kw));
  const isQuestionAboutBot = /^(what|who|how|why|are you|can you)\s+(is|are|can|do|did|does|you|your|aura|this app)\b/i.test(text);

  if (isQuestionAboutBot && !hasActionKeyword) {
    return false;
  }

  const wordCount = text.split(/\s+/).length;
  if (wordCount <= 3 && !hasActionKeyword) {
    return false;
  }

  return true;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [view, setView] = useState<MainView>(() => {
    try {
      const saved = localStorage.getItem('aura_active_view');
      if (saved === 'chat' || saved === 'kanban' || saved === 'canvas' || saved === 'code') {
        return saved as MainView;
      }
    } catch { /* */ }
    return 'chat';
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('agents');
  const [agentName, setAgentName] = useState('Aura');
  const [openMenuAt, setOpenMenuAt] = useState(0);
  const [canvasPreviewPayload, setCanvasPreviewPayload] = useState<{ path: string; content?: string } | null>(null);
  const [codeInitialFile, setCodeInitialFile] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('aura_code_active_file');
      if (saved) return saved;
    } catch { /* */ }
    return 'src/agent/loop.ts';
  });

  useEffect(() => {
    try { localStorage.setItem('aura_active_view', view); } catch { /* */ }
  }, [view]);

  useEffect(() => {
    try { localStorage.setItem('aura_code_active_file', codeInitialFile); } catch { /* */ }
  }, [codeInitialFile]);

  // Model selection state
  const [availableModels, setAvailableModels] = useState<ModelItem[]>(DEFAULT_MODELS_FALLBACK);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const t = useCallback((key: string) => translate(settings.locale, key), [settings.locale]);
  const aura = useAura(settings);

  // Update check — the server reports what npm reports; the banner is the
  // web client's whole story about newer versions.
  const [updateInfo, setUpdateInfo] = useState<{ available: boolean; current: string; latest: string | null } | null>(null);
  useEffect(() => {
    fetch('/api/update')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.update) setUpdateInfo(data.update); })
      .catch(() => { /* the banner is optional; a failed fetch is not news */ });
  }, []);

  // Load models from server endpoint & sync saved settings model with server
  useEffect(() => {
    fetch('/api/models')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.models)) {
          setAvailableModels(data.models);
          if (settings.model) {
            fetch('/api/model', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: settings.model }),
            }).catch(() => {});
          } else if (data.activeModel) {
            setSettings((prev) => ({ ...prev, model: data.activeModel }));
          }
        }
      })
      .catch(() => {
        // Use default fallback models
      });
  }, []);

  // Close model dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    if (modelDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [modelDropdownOpen]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    document.body.dataset.theme = settings.theme;
    document.body.className = settings.theme === 'light' ? 'theme-light' : 'theme-dark';
    root.lang = settings.locale;
    root.dir = LOCALES[settings.locale]?.dir || 'ltr';
    saveSettings(settings);
  }, [settings]);

  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...p }));
  }, []);

  const handleSelectModel = (modelId: string) => {
    const found = availableModels.find((m: ModelItem) => m.id === modelId) || DEFAULT_MODELS_FALLBACK.find((m: ModelItem) => m.id === modelId);
    patch({ model: modelId, ...(found?.provider ? { provider: found.provider } : {}) });
    setModelDropdownOpen(false);
    // Tell the running server
    fetch('/api/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
    }).catch(() => {});
  };

  const submit = useCallback((text: string, attachments: Parameters<typeof aura.send>[1]) => {
    const trimmed = text.trim();
    // `/` commands (/stats, /cost, /context) are commands too — only `:` was
    // checked here, so the slash half of the advertised set went to the model
    // as prose. A bare "/" or ":" is someone opening the menu, not a command.
    if ((trimmed.startsWith(':') || trimmed.startsWith('/')) && trimmed.length > 1) {
      runCommand(text, {
        t,
        sessionId: aura.sessionId,
        conversations: aura.conversations,
        messages: aura.messages,
        usage: aura.usage,
        newChat: () => void aura.newChat(),
        openChat: (id) => void aura.openChat(id),
        note: aura.systemNote,
        openSettings: (tab) => {
          setSettingsTab(tab);
          setSettingsOpen(true);
        },
        openCommandMenu: () => setOpenMenuAt(Date.now()),
        runOnEngine: (command) => aura.runEngineCommand(command),
      });
      return;
    }

    // Automatically create task in Kanban 'execution' lane ONLY when entering real building/researching tasks (not casual chat)
    if (trimmed && isTaskIntent(trimmed)) {
      const firstLine = trimmed.split('\n')[0].replace(/^#+\s*/, '').trim();
      const title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;

      void aura.board.add({
        title: title || 'Chat Task',
        notes: trimmed,
        column: 'execution',
        model: settings.model || 'gemini-3.1-pro-preview',
        tools: ['read_file', 'edit_file', 'write_file', 'search_code', 'run_shell', 'run_tests', 'git'],
        gated: false,
      });
    }

    void aura.send(text, attachments);
  }, [aura, settings.model, t]);

  const activeModel = settings.model || 'gemini-3.1-pro-preview';
  const isConnected = aura.connection === 'open';
  const connDotColor = isConnected ? 'var(--ok)' : aura.connection === 'connecting' ? 'var(--warn)' : 'var(--err)';
  const connLabel = isConnected ? 'Connected' : aura.connection === 'connecting' ? 'Connecting' : 'Disconnected';
  const activeConversation = aura.conversations.find((c) => c.sessionId === aura.sessionId);

  // Models filtered for dropdown (only models that have API key set, plus search filtering)
  const configuredModels = availableModels.filter((m) => m.hasKey);
  const modelsToDisplay = (configuredModels.length > 0 ? configuredModels : availableModels).filter((m) => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      m.id.toLowerCase().includes(q) ||
      (m.name && m.name.toLowerCase().includes(q)) ||
      m.provider.toLowerCase().includes(q)
    );
  });

  // Group models by provider
  const modelsByProvider: Record<string, ModelItem[]> = {};
  for (const m of modelsToDisplay) {
    if (!modelsByProvider[m.provider]) modelsByProvider[m.provider] = [];
    modelsByProvider[m.provider].push(m);
  }

  return (
    <div className="aura-app-root">
      {/* Background Watermark Sigil (8% opacity) */}
      <img
        src={auraSign}
        alt=""
        className="aura-bg-watermark"
        aria-hidden="true"
      />

      {/* Update notice — the web client's equivalent of the TUI's startup line */}
      {updateInfo?.available && (
        <div
          className="aura-update-banner"
          role="status"
          style={{
            position: 'relative', zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '8px', padding: '6px 16px', fontSize: '12.5px', fontWeight: 600,
            background: 'linear-gradient(90deg, rgba(90,158,110,0.18), rgba(110,208,234,0.18))',
            borderBottom: '1px solid rgba(90,158,110,0.35)',
            color: 'var(--txt, #e8eaf2)',
          }}
        >
          <span>⬆ Aura {updateInfo.latest} is available — you have {updateInfo.current}.</span>
          <code style={{ fontSize: '11.5px', opacity: 0.85 }}>npm install -g aura-code</code>
          <button
            type="button"
            onClick={() => setUpdateInfo((u) => (u ? { ...u, available: false } : u))}
            style={{ marginLeft: '8px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '13px' }}
            aria-label="Dismiss update notice"
          >
            ✕
          </button>
        </div>
      )}

      {/* Top Header */}
      <header className="aura-header">
        <div className="aura-header-brand">
          <img src={auraSign} alt="Aura Sign" className="aura-brand-mark" />
          <span className="aura-brand-title">Aura</span>
        </div>

        <nav className="aura-header-tabs" role="tablist">
          {(['chat', 'kanban', 'canvas', 'code'] as MainView[]).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={`aura-tab-btn ${view === v ? 'active' : ''}`}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </nav>

        <div className="aura-header-spacer" />

        <div className="aura-agent-status-pill">
          <span className="aura-agent-name">{agentName}</span>

          <div className="aura-model-picker-wrap" ref={modelDropdownRef}>
            <button
              type="button"
              className="aura-model-badge-btn"
              title="Select active model"
              onClick={() => setModelDropdownOpen((v) => !v)}
            >
              <span>{activeModel}</span>
              <span style={{ fontSize: '8px', color: 'var(--dim)' }}>▾</span>
            </button>

            {modelDropdownOpen && (
              <div className="model-dropdown-menu">
                <div className="model-dropdown-header">
                  <input
                    type="text"
                    className="model-dropdown-search"
                    placeholder="Search available models..."
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="model-dropdown-list">
                  {Object.keys(modelsByProvider).length === 0 ? (
                    <div style={{ padding: '12px', fontSize: '11px', color: 'var(--dim)', textAlign: 'center' }}>
                      No matching models found
                    </div>
                  ) : (
                    Object.entries(modelsByProvider).map(([provider, list]) => (
                      <div key={provider}>
                        <div className="model-dropdown-group-title">{provider}</div>
                        {list.map((m) => {
                          const isSelected = m.id === activeModel;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              className={`model-dropdown-item ${isSelected ? 'active' : ''}`}
                              onClick={() => handleSelectModel(m.id)}
                            >
                              <span className="model-dropdown-item-name">
                                {m.name || m.label || m.id}
                              </span>
                              {m.speed && (
                                <span className="model-dropdown-item-speed">{m.speed}</span>
                              )}
                              {isSelected && <span className="model-dropdown-item-check">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          className="aura-conn-button"
          title="Toggle or inspect connection"
          onClick={() => {
            if (aura.connection === 'closed') {
              window.location.reload();
            }
          }}
        >
          <span
            className={`conn-dot ${isConnected ? 'pulse' : ''}`}
            style={{ background: connDotColor }}
          />
          <span className="conn-label" style={{ color: connDotColor }}>{connLabel}</span>
          <span className="conn-url">ws://127.0.0.1:7337</span>
        </button>

        <button
          type="button"
          className="aura-settings-btn"
          onClick={() => setSettingsOpen(true)}
        >
          <span className="gear-icon">⚙</span>
          <span>Settings</span>
        </button>
      </header>

      {/* Main Surface - Persistent Keep-Alive Multi-View Layout */}
      <main className="aura-main-viewport">
        {/* Chat View */}
        <div
          className={`aura-view-pane ${view === 'chat' ? 'active' : ''}`}
          style={{
            display: view === 'chat' ? 'flex' : 'none',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            minHeight: 0,
            flex: 1,
          }}
        >
          <div className="chat-layout-wrapper">
            <Sidebar
              conversations={aura.conversations}
              sessionId={aura.sessionId}
              open={sidebarOpen}
              t={t}
              onNew={() => void aura.newChat()}
              onOpen={(id) => void aura.openChat(id)}
              onDelete={(id) => void aura.deleteChat(id)}
              onRename={(id, title) => void aura.renameChat(id, title)}
              onSettings={() => setSettingsOpen(true)}
              onClose={() => setSidebarOpen(false)}
            />
            <section className="chat-main-section">
              <Chat
                messages={aura.messages}
                busy={aura.busy}
                error={aura.error}
                sessionId={aura.sessionId}
                sessionNumber={activeConversation?.number ?? 1}
                chatTitle={activeConversation?.title}
                approval={aura.approval}
                permission={settings.permission}
                sandbox={settings.sandbox}
                t={t}
                openMenuAt={openMenuAt}
                onSend={submit}
                onStop={aura.stop}
                onRegenerate={aura.regenerate}
                onApprove={() => {}}
                onDeny={() => {}}
              />
            </section>
          </div>
        </div>

        {/* Kanban Board View */}
        <div
          className={`aura-view-pane ${view === 'kanban' ? 'active' : ''}`}
          style={{
            display: view === 'kanban' ? 'flex' : 'none',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            minHeight: 0,
            flex: 1,
          }}
        >
          <Board
            board={aura.board}
            busy={aura.busy}
            availableModels={configuredModels.length > 0 ? configuredModels : availableModels}
            activeModel={activeModel}
            onRun={(task) => {
              void aura.runTask(task);
            }}
            onPreviewHtml={(filePath, content) => {
              setCanvasPreviewPayload({ path: filePath, content });
              setView('canvas');
            }}
            onOpenFileInCode={(filePath) => {
              setCodeInitialFile(filePath);
              setView('code');
            }}
            t={t}
          />
        </div>

        {/* Canvas & Web Game Preview View */}
        <div
          className={`aura-view-pane ${view === 'canvas' ? 'active' : ''}`}
          style={{
            display: view === 'canvas' ? 'flex' : 'none',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            minHeight: 0,
            flex: 1,
          }}
        >
          <Canvas
            previewPayload={canvasPreviewPayload}
            onSaveWorkflowToPreparation={(wfTask) => {
              void aura.board.add({
                title: wfTask.title,
                notes: wfTask.notes,
                column: 'preparation',
                tools: wfTask.tools,
                gated: wfTask.gated,
                workflow: wfTask.workflow,
              });
              setView('kanban');
            }}
            onRunWorkflow={(wfTask) => {
              // Created in preparation, then run: boardRun is what moves a task
              // into Execution, so starting it there keeps one authority over
              // the column instead of two guesses that can disagree.
              void (async () => {
                const task = await aura.board.add({
                  title: wfTask.title,
                  notes: wfTask.notes,
                  column: 'preparation',
                  tools: wfTask.tools,
                  gated: wfTask.gated,
                  workflow: wfTask.workflow,
                });
                if (task) await aura.runTask(task);
              })();
              setView('kanban');
            }}
            onCreateTaskFromNote={(note) => {
              void aura.board.add({
                title: note.title,
                notes: note.text,
                column: 'preparation',
                tools: ['read_file', 'edit_file', 'run_tests'],
                gated: true,
              });
              setView('kanban');
            }}
          />
        </div>

        {/* IDE & Code Editor / System Terminal View */}
        <div
          className={`aura-view-pane ${view === 'code' ? 'active' : ''}`}
          style={{
            display: view === 'code' ? 'flex' : 'none',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            minHeight: 0,
            flex: 1,
          }}
        >
          <Code initialFile={codeInitialFile} isVisible={view === 'code'} />
        </div>
      </main>

      {/* Settings Dialog */}
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          tools={aura.tools}
          availableModels={availableModels}
          t={t}
          initialTab={settingsTab}
          activeAgentName={agentName}
          onAgentNameChange={setAgentName}
          onChange={patch}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
