import { useRef, useState, useEffect } from 'react';
import { Icon } from './Icon';
import {
  type BoardApi,
  type BoardColumn,
  type BoardTask,
  type WorkflowDef,
} from '../hooks/useBoard';

type T = (key: string) => string;

export interface ModelItem {
  id: string;
  name?: string;
  label?: string;
  provider: string;
  speed?: string;
  hasKey?: boolean;
}

interface LaneMeta {
  key: BoardColumn;
  name: string;
  rule: string;
  dot: string;
  tint: string;
}

const LANES: LaneMeta[] = [
  { key: 'planning', name: 'Planning', rule: 'Read-only. No edits yet.', dot: 'var(--mut)', tint: 'transparent' },
  { key: 'preparation', name: 'Preparation', rule: 'Plan written, waiting on a gate.', dot: 'var(--acc2)', tint: 'rgba(110,208,234,0.03)' },
  { key: 'execution', name: 'Execution', rule: 'Editing and running now.', dot: 'var(--acc)', tint: 'rgba(194,103,76,0.05)' },
  { key: 'finished', name: 'Finished', rule: 'Verified. Evidence attached.', dot: 'var(--ok)', tint: 'rgba(90,158,110,0.04)' },
];

export const AVAILABLE_TOOLS = [
  { id: 'read_file', label: 'Read File', icon: '📄', desc: 'Read file contents' },
  { id: 'list_dir', label: 'List Dir', icon: '📁', desc: 'Explore directory structure' },
  { id: 'edit_file', label: 'Edit File', icon: '✏️', desc: 'Surgically replace text in files' },
  { id: 'write_file', label: 'Write File', icon: '📝', desc: 'Create or overwrite files' },
  { id: 'search_code', label: 'Search Code', icon: '🔍', desc: 'Ripgrep search across workspace' },
  { id: 'run_shell', label: 'Run Shell', icon: '⚡', desc: 'Execute bash commands' },
  { id: 'run_tests', label: 'Run Tests', icon: '🧪', desc: 'Execute test suites' },
  { id: 'git', label: 'Git Ops', icon: '🌿', desc: 'Check git status and diffs' },
  { id: 'web_fetch', label: 'Web Fetch', icon: '🌐', desc: 'Fetch web pages directly' },
  { id: 'web_search', label: 'Web Search', icon: '🔎', desc: 'Search documentation & web' },
  { id: 'memory', label: 'Memory', icon: '🧠', desc: 'Episodic memory recall' },
  { id: 'clipboard', label: 'Clipboard', icon: '📋', desc: 'System clipboard interaction' },
  { id: 'mcp', label: 'MCP Client', icon: '🔌', desc: 'Model Context Protocol servers' },
  { id: 'notify', label: 'Notify', icon: '🔔', desc: 'Desktop alerts & notifications' },
];

export interface SwarmAgentPreset {
  id: string;
  name: string;
  role: string;
  icon: string;
  model: string;
  tools: string[];
}

export const SWARM_AGENT_PRESETS: SwarmAgentPreset[] = [
  { id: 'architect', name: 'System Architect', role: 'Decomposes task, plans dataflows & file diffs', icon: '🧠', model: 'gemini-3.1-pro-preview', tools: ['read_file', 'search_code', 'list_dir'] },
  { id: 'researcher', name: 'Codebase Researcher', role: 'Surveys call sites, dependencies & docs', icon: '🔍', model: 'deepseek-v4-flash', tools: ['search_code', 'read_file', 'web_search'] },
  { id: 'engineer', name: 'Senior Engineer', role: 'Writes surgical fixes & implements features', icon: '💻', model: 'claude-sonnet-4-5-20251001', tools: ['edit_file', 'write_file', 'run_shell'] },
  { id: 'qa', name: 'QA & Verification Engine', role: 'Executes tests, checks flakes & guarantees integrity', icon: '🧪', model: 'gpt-4o', tools: ['run_tests', 'run_shell', 'git'] },
  { id: 'security', name: 'Security Auditor', role: 'Audits secrets, dangerous calls & permissions', icon: '🛡️', model: 'claude-opus-4-5-20251001', tools: ['search_code', 'read_file'] },
  { id: 'perf', name: 'Performance Optimizer', role: 'Profiles latency, cache hits & token usage', icon: '⚡', model: 'opencode-zen', tools: ['run_shell', 'read_file'] },
  { id: 'ui', name: 'UI/UX Specialist', role: 'Polishes component tokens, design systems & themes', icon: '🎨', model: 'gemini-3.1-pro-preview', tools: ['read_file', 'edit_file'] },
];

export interface ThirdPartyProviderItem {
  id: string;
  name: string;
  category: 'automation' | 'chat' | 'webhook';
  icon: string;
  role: string;
  desc: string;
  envKey?: string;
  inboundUrl: string;
  outboundUrl?: string;
  capabilities: string[];
}

export const THIRD_PARTY_PROVIDERS_LIST: ThirdPartyProviderItem[] = [
  {
    id: 'n8n',
    name: 'n8n Workflow Automation',
    category: 'automation',
    icon: '🪢',
    role: 'Node-Based Flow Engine',
    desc: 'Self-hosted n8n workflows. Receive webhook payloads from n8n nodes to execute tasks and send status back to n8n webhook targets.',
    envKey: 'N8N_WEBHOOK_SECRET',
    inboundUrl: 'http://localhost:7399/api/webhooks/n8n/inbound',
    outboundUrl: 'http://localhost:5678/webhook/aura-callback',
    capabilities: ['Webhook Node', 'Task Execution Trigger', 'HMAC SHA-256 Auth', 'Structured Result Callback']
  },
  {
    id: 'zapier',
    name: 'Zapier Automation',
    category: 'automation',
    icon: '⚡',
    role: 'Zap Webhook Integration',
    desc: 'Connect 6,000+ Zapier apps to Aura tasks. Trigger workflows via Webhooks by Zapier and post agent progress back to Zapier actions.',
    envKey: 'ZAPIER_WEBHOOK_SECRET',
    inboundUrl: 'http://localhost:7399/api/webhooks/zapier/inbound',
    outboundUrl: 'https://hooks.zapier.com/hooks/catch/aura-target/',
    capabilities: ['Catch Hook Trigger', 'Outbound Webhook Action', 'JSON Body Payload', 'Real-time Event Dispatch']
  },
  {
    id: 'make',
    name: 'Make.com (Integromat)',
    category: 'automation',
    icon: '🧩',
    role: 'Scenario Visual Builder',
    desc: 'Integrate with Make.com visual scenarios. Receive execution hooks and trigger downstream HTTP modules upon task verification.',
    envKey: 'MAKE_API_TOKEN',
    inboundUrl: 'http://localhost:7399/api/webhooks/make/inbound',
    outboundUrl: 'https://hook.eu1.make.com/aura-scenario-target',
    capabilities: ['Custom Webhook Module', 'Scenario Dataflow', 'JSON Data Structures', 'Execution Status Polling']
  },
  {
    id: 'pipedream',
    name: 'Pipedream Serverless',
    category: 'automation',
    icon: '💧',
    role: 'Serverless Code Steps',
    desc: 'Run serverless Node.js / Python code steps that trigger Aura tasks and process async verification events.',
    envKey: 'PIPEDREAM_API_KEY',
    inboundUrl: 'http://localhost:7399/api/webhooks/pipedream/inbound',
    outboundUrl: 'https://eo12345678.m.pipedream.net',
    capabilities: ['Node.js & Python SDK', 'Serverless Triggers', 'Sub-second Event Stream', 'Built-in Key Store']
  },
  {
    id: 'activepieces',
    name: 'Activepieces',
    category: 'automation',
    icon: '🧩',
    role: 'Open-Source Flow Engine',
    desc: 'Self-hosted open-source automation alternative for enterprise stacks with native Webhook piece triggers.',
    envKey: 'ACTIVEPIECES_API_KEY',
    inboundUrl: 'http://localhost:7399/api/webhooks/activepieces/inbound',
    capabilities: ['Self-Hosted Engine', 'Custom Piece Connector', 'Flow Execution Hook', 'OAuth2 / API Key Auth']
  },
  {
    id: 'telegram',
    name: 'Telegram Bot & Service',
    category: 'chat',
    icon: '✈️',
    role: 'Telegram ChatOps',
    desc: 'Control Aura agent loops, trigger task runs, and receive real-time execution logs directly in Telegram channels.',
    envKey: 'TELEGRAM_BOT_TOKEN',
    inboundUrl: 'http://localhost:7399/api/webhooks/telegram',
    capabilities: ['Chat Commands (/run, /status)', 'Real-time Progress Stream', 'Interactive Inline Keyboards', 'Multi-user Permission Gating']
  },
  {
    id: 'slack_discord',
    name: 'Slack & Discord Webhooks',
    category: 'chat',
    icon: '💬',
    role: 'Chat Alerts & Notifications',
    desc: 'Broadcast task execution starts, completion summaries, and verification results directly into Slack or Discord channels.',
    envKey: 'SLACK_WEBHOOK_URL',
    inboundUrl: 'http://localhost:7399/api/webhooks/slack',
    capabilities: ['Rich BlockKit Formatting', 'Discord Embed Support', 'Task Failure Alerts', 'Interactive Action Buttons']
  },
  {
    id: 'generic_webhook',
    name: 'Generic REST Webhook',
    category: 'webhook',
    icon: '🔔',
    role: 'Universal HTTP REST Connector',
    desc: 'Universal HTTP POST/PUT inbound and outbound REST webhooks with configurable Bearer Token, Basic Auth, or HMAC SHA-256 signatures.',
    envKey: 'WEBHOOK_SECRET_KEY',
    inboundUrl: 'http://localhost:7399/api/webhooks/generic/inbound',
    capabilities: ['Bearer Token Auth', 'HMAC SHA-256 Verification', 'Custom Headers', 'JSON Schema Validation']
  }
];

const DEFAULT_MOCK_CARDS: Array<Partial<BoardTask> & {
  tools?: string[];
  files?: string[];
  verify?: string;
  verifyColor?: string;
  tokens?: string;
  duration?: string;
  gated?: boolean;
  workflow?: WorkflowDef;
}> = [
  {
    id: 'c1',
    column: 'planning',
    title: 'Drop the wall clock from scheduler',
    notes: 'Same class of bug as loop.ts:47. Audit every Date.now() under src/agent to eliminate non-deterministic timing flakes in continuous integration runs.',
    tools: ['search_code', 'read_file'],
    files: ['src/agent/scheduler.ts', 'src/agent/queue.ts'],
    verify: '◯ not started',
    verifyColor: 'var(--mut)',
    model: 'gemini-3.1-pro-preview',
    tokens: '-',
    duration: '-',
    gated: false,
  },
  {
    id: 'c2',
    column: 'preparation',
    title: 'Bound the retry queue',
    notes: 'Cap in-flight jobs at 8 and surface the backlog to the sidecar so the client can render it in the preview chrome.',
    tools: ['read_file', 'edit_file', 'run_tests'],
    files: ['src/agent/queue.ts', 'src/sidecar/state.ts'],
    verify: '⚠ 1 gate pending',
    verifyColor: 'var(--warn)',
    model: 'claude-sonnet-4-5-20251001',
    tokens: '18.4k',
    duration: '-',
    gated: true,
    workflow: {
      nodes: [
        { id: 'w1', name: 'Audit Queue Backlog', type: 'tool', tool: 'read_file', desc: 'Read queue size limits', x: 20, y: 30 },
        { id: 'w2', name: 'Cap In-flight at 8', type: 'tool', tool: 'edit_file', desc: 'Edit queue.ts bounding logic', x: 220, y: 30 },
        { id: 'w3', name: 'Gate Approval', type: 'gate', desc: 'Confirm state persistence', x: 420, y: 30 },
        { id: 'w4', name: 'Stress Test Queue', type: 'verify', tool: 'run_tests', desc: 'Run concurrent queue tests', x: 220, y: 150 },
      ],
      edges: [
        { from: 'w1', to: 'w2' },
        { from: 'w2', to: 'w3' },
        { from: 'w3', to: 'w4' },
      ],
    },
  },
  {
    id: 'c3',
    column: 'preparation',
    title: 'Autonomous Swarm: Token Optimization Pipeline',
    notes: 'Multi-agent swarm: Architect designs AST transform, Researcher surveys token cost hotspots, Coder implements surgical edits, and QA validates test integrity.',
    tools: ['search_code', 'read_file', 'edit_file', 'run_tests'],
    files: ['src/providers/resilient.ts', 'src/agent/loop.ts'],
    verify: '🐝 4 agents ready',
    verifyColor: '#ffd166',
    model: 'gemini-3.1-pro-preview',
    tokens: '28.4k',
    duration: '-',
    gated: true,
    swarm: {
      strategy: 'parallel',
      agents: [
        { id: 'architect', name: 'System Architect', role: 'Decomposes task', icon: '🧠' },
        { id: 'researcher', name: 'Codebase Researcher', role: 'Surveys hotspots', icon: '🔍' },
        { id: 'engineer', name: 'Senior Engineer', role: 'Writes surgical fixes', icon: '💻' },
        { id: 'qa', name: 'QA & Verification', role: 'Guarantees integrity', icon: '🧪' },
      ],
    },
  },
  {
    id: 'c4',
    column: 'execution',
    title: 'Inject a clock into the agent loop',
    notes: 'Replace Date.now() with a Clock interface. Test supplies a fake injected timer; production supplies wall clock.',
    tools: ['edit_file', 'write_file', 'run_tests', 'run_shell'],
    files: ['src/agent/loop.ts', 'src/agent/clock.ts', 'test/loop.spec.ts'],
    verify: '⟳ 40/40 running',
    verifyColor: '#ff6b6b',
    model: 'nvidia/llama-3.1-nemotron-70b-instruct',
    tokens: '31.7k',
    duration: '6m 12s',
    gated: true,
  },
  {
    id: 'c4_parallel',
    column: 'execution',
    title: 'Stream tokenizer backpressure',
    notes: 'Worker 2 parallel execution. Buffer tokens over SSE and throttled websocket pushes to eliminate UI frame stuttering.',
    tools: ['read_file', 'edit_file', 'run_tests'],
    files: ['src/agent/stream.ts', 'src/server/index.ts'],
    verify: '⟳ parallel worker 2',
    verifyColor: '#6ed0ea',
    model: 'claude-sonnet-4-5-20251001',
    tokens: '14.2k',
    duration: '2m 45s',
    gated: false,
  },
  {
    id: 'c5',
    column: 'finished',
    title: 'Sidecar WebSocket reconnect',
    notes: 'Exponential backoff with jitter, and the client resumes the transcript seamlessly from the last sequence number.',
    tools: ['edit_file', 'run_tests', 'git'],
    files: ['src/sidecar/ws.ts', 'src/cli/display.ts'],
    verify: '✓ 1,205 passing · 0 regressions',
    verifyColor: 'var(--ok)',
    model: 'claude-opus-4-5-20251001',
    tokens: '52.9k',
    duration: '14m 03s',
    gated: false,
  },
  {
    id: 'c6',
    column: 'finished',
    title: 'Strip ANSI from bot replies',
    notes: 'Terminal color codes were leaking into Telegram messages as literal escape sequences.',
    tools: ['search_code', 'edit_file', 'run_tests'],
    files: ['src/bots/telegram/format.ts', 'dist/test-results.html'],
    verify: '✓ 12 new tests',
    verifyColor: 'var(--ok)',
    model: 'gpt-4o',
    tokens: '7.3k',
    duration: '2m 41s',
    gated: false,
  },
  {
    id: 'c7',
    column: 'finished',
    title: 'Interactive 2D Cyber Arcade & Web Dashboard',
    notes: 'Built interactive canvas game engine with particle physics, responsive controls, and live HTML scoreboard dashboard.',
    tools: ['write_file', 'edit_file', 'run_tests'],
    files: ['web/game-preview.html', 'dist/scoreboard.html', 'src/game/engine.js'],
    verify: '✓ 60 FPS verified · 0 drops',
    verifyColor: 'var(--ok)',
    model: 'nvidia/llama-3.1-nemotron-70b-instruct',
    tokens: '19.4k',
    duration: '3m 12s',
    gated: false,
  },
];

export function isDesignFile(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.endsWith('.html') ||
    p.endsWith('.htm') ||
    p.endsWith('.svg') ||
    p.endsWith('.png') ||
    p.endsWith('.jpg') ||
    p.endsWith('.jpeg') ||
    p.endsWith('.webp') ||
    p.endsWith('.gif') ||
    p.endsWith('.css') ||
    p.includes('preview') ||
    p.includes('game-preview')
  );
}

export function isGameProject(task: BoardTask | { title?: string; notes?: string; files?: string[] }): boolean {
  const t = (task.title || '').toLowerCase();
  const n = (task.notes || '').toLowerCase();
  return (
    t.includes('game') ||
    t.includes('arcade') ||
    t.includes('canvas') ||
    t.includes('scoreboard') ||
    n.includes('game') ||
    n.includes('arcade') ||
    n.includes('physics')
  );
}

export function Board({
  board,
  busy,
  availableModels = [],
  activeModel = 'gemini-2.5-pro',
  onRun,
  onPreviewHtml,
  onOpenFileInCode,
  t,
}: {
  board: BoardApi;
  busy: boolean;
  availableModels?: ModelItem[];
  activeModel?: string;
  onRun: (task: BoardTask) => void;
  onPreviewHtml?: (filePath: string, content?: string) => void;
  onOpenFileInCode?: (filePath: string) => void;
  t: T;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  /** Read by the seeding effect, which must not re-run when the list changes. */
  const allTasksRef = useRef<BoardTask[]>([]);
  /** Mirrors stepDrafts so a blur handler reads the current value, not a stale
   *  closure from the render that installed it. */
  const stepDraftsRef = useRef<Record<string, { name?: string; desc?: string }>>({});
  /** Latest closeDetail, so the Escape listener need not re-bind each render. */
  const closeDetailRef = useRef<() => void>(() => {});
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [targetColumn, setTargetColumn] = useState<BoardColumn>('planning');
  const [selectedModel, setSelectedModel] = useState(activeModel);
  const [requireGate, setRequireGate] = useState(true);

  // ── NES detail modal inline editing state ──
  const [isEditingDetail, setIsEditingDetail] = useState(false);
  const [mockEditWarning, setMockEditWarning] = useState<string | null>(null);
  /** Uncommitted step edits, keyed by node id. Flushed on blur and on close. */
  const [stepDrafts, setStepDrafts] = useState<Record<string, { name?: string; desc?: string }>>({});
  const [editTitle, setEditTitle] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editModel, setEditModel] = useState('');
  const modalFileInputRef = useRef<HTMLInputElement>(null);

  // Seed the edit fields when the modal opens.
  //
  // Keyed on the task id, never on the task object. The task is now derived
  // from the board on every render, so it is a new object each time the board
  // changes — depending on it would re-seed these fields mid-edit and wipe
  // whatever the user had typed.
  useEffect(() => {
    const t = detailTaskId ? allTasksRef.current.find((x) => x.id === detailTaskId) : null;
    if (!t) return;
    setEditTitle(t.title);
    setEditNotes(t.notes || '');
    setEditModel(t.model || activeModel);
    setIsEditingDetail(false);
    setMockEditWarning(null);
    setStepDrafts({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTaskId]);

  // Escape closes the detail modal — its close button is labelled "[ESC]",
  // which was a promise nothing kept. Closing this way saves like any other
  // exit, so it is not a discard route.
  useEffect(() => {
    if (!detailTaskId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDetailRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailTaskId]);

  // File launching for Code vs Canvas vs Game Projects (dual routing)
  const handleFileLaunch = (file: string, task: BoardTask | { title?: string; notes?: string; files?: string[] }) => {
    const isGame = isGameProject(task);
    const isDesign = isDesignFile(file);

    if (isGame) {
      // For game projects: Route code to code editor AND graphical assets / HTML to canvas web game preview simultaneously!
      const allFiles = (task as any).files as string[] | undefined;
      const codeFile = allFiles?.find((f) => !isDesignFile(f)) || (isDesign ? 'src/game/engine.js' : file);
      const assetFile = allFiles?.find((f) => isDesignFile(f)) || (isDesign ? file : 'web/game-preview.html');

      if (onOpenFileInCode) onOpenFileInCode(codeFile);
      if (onPreviewHtml) onPreviewHtml(assetFile);
    } else {
      if (isDesign) {
        if (onPreviewHtml) onPreviewHtml(file);
      } else {
        if (onOpenFileInCode) onOpenFileInCode(file);
      }
    }
  };

  // Swarm Modal State
  const [swarmModalOpen, setSwarmModalOpen] = useState(false);
  const [swarmTitle, setSwarmTitle] = useState('Autonomous Multi-Agent Swarm Mission');
  const [swarmObjective, setSwarmObjective] = useState('Collaborative multi-agent swarm: Architect maps design blueprints, Researcher indexes call-sites, Coder implements surgical changes, and QA verifies stability concurrently.');
  const [swarmTargetColumn, setSwarmTargetColumn] = useState<BoardColumn>('preparation');
  const [selectedSwarmAgents, setSelectedSwarmAgents] = useState<string[]>(['architect', 'researcher', 'engineer', 'qa']);
  const [swarmStrategy, setSwarmStrategy] = useState<'parallel' | 'pipeline' | 'hierarchical'>('parallel');

  // All tools ON by default
  const [enabledTools, setEnabledTools] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const tool of AVAILABLE_TOOLS) {
      init[tool.id] = true;
    }
    return init;
  });

  const [dragCard, setDragCard] = useState<{ id: string; x0: number; y0: number; cx: number; cy: number } | null>(null);
  const [cardPositions, setCardPositions] = useState<Record<string, { x: number; y: number }>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [targetTaskId, setTargetTaskId] = useState<string | null>(null);

  // Sub-Tab Navigation inside Kanban ('board' | 'list' | 'providers')
  const [kanbanSubTab, setKanbanSubTab] = useState<'board' | 'list' | 'providers'>('board');

  // Execution List View Filters & Search
  const [listSearch, setListSearch] = useState('');
  const [listColumnFilter, setListColumnFilter] = useState<'all' | BoardColumn>('all');

  // Third-Party Providers Management State
  const [providerKeyInputs, setProviderKeyInputs] = useState<Record<string, string>>({});
  const [providerSaveStatus, setProviderSaveStatus] = useState<Record<string, string>>({});
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [liveProviders, setLiveProviders] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/providers')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.providers)) {
          setLiveProviders(data.providers);
        }
      })
      .catch(() => {});
  }, []);

  const handleSaveProviderKey = async (providerId: string, envKey: string | undefined) => {
    if (!envKey) return;
    const value = providerKeyInputs[providerId]?.trim();
    if (!value) return;

    setProviderSaveStatus((prev) => ({ ...prev, [providerId]: 'Saving...' }));
    try {
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envKey, value }),
      });
      if (res.ok) {
        setProviderSaveStatus((prev) => ({ ...prev, [providerId]: 'Saved!' }));
        setLiveProviders((prev) =>
          prev.map((p) => (p.envKey === envKey ? { ...p, keySet: true } : p))
        );
      } else {
        setProviderSaveStatus((prev) => ({ ...prev, [providerId]: 'Failed to save' }));
      }
    } catch {
      setProviderSaveStatus((prev) => ({ ...prev, [providerId]: 'Saved locally' }));
    }
    setTimeout(() => {
      setProviderSaveStatus((prev) => ({ ...prev, [providerId]: '' }));
    }, 3000);
  };

  const handleTestProviderPing = (providerId: string) => {
    setTestingProviderId(providerId);
    setTimeout(() => {
      setTestingProviderId(null);
    }, 1200);
  };

  const allTasks = board.tasks.length > 0 ? board.tasks : (DEFAULT_MOCK_CARDS as unknown as BoardTask[]);
  allTasksRef.current = allTasks;
  stepDraftsRef.current = stepDrafts;

  /** True when the board is empty and the cards on screen are the samples. */
  const showingMocks = board.tasks.length === 0;

  // Derived, not stored. Holding a snapshot in state meant the modal kept
  // showing the task as it was when opened: a run finishing, a file attaching,
  // or an edit saved from anywhere else left it stale until reopened.
  const detailModalTask = detailTaskId
    ? (allTasks.find((x) => x.id === detailTaskId) ?? null)
    : null;

  // Calculate clean non-overlapping positions for every card based on lane
  const laneTaskLists: Record<BoardColumn, BoardTask[]> = {
    planning: [],
    preparation: [],
    execution: [],
    finished: [],
  };

  for (const tItem of allTasks) {
    if (laneTaskLists[tItem.column]) {
      laneTaskLists[tItem.column].push(tItem);
    } else {
      laneTaskLists.planning.push(tItem);
    }
  }

  const [pointerStart, setPointerStart] = useState<{
    id: string;
    x0: number;
    y0: number;
    cx: number;
    cy: number;
    targetEl: HTMLElement | null;
  } | null>(null);

  const handleGrab = (e: React.PointerEvent, id: string, initialX: number, initialY: number) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, label, .btn-preview-html-chip, .btn-open-code-chip, .btn-edit-card-chip')) {
      return;
    }
    const currentPos = cardPositions[id] || { x: initialX, y: initialY };
    setPointerStart({
      id,
      x0: currentPos.x,
      y0: currentPos.y,
      cx: e.clientX,
      cy: e.clientY,
      targetEl: e.currentTarget as HTMLElement,
    });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (pointerStart && !dragCard) {
      const dx = e.clientX - pointerStart.cx;
      const dy = e.clientY - pointerStart.cy;
      if (Math.hypot(dx, dy) > 4) {
        if (pointerStart.targetEl) {
          try {
            pointerStart.targetEl.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }
        setDragCard({
          id: pointerStart.id,
          x0: pointerStart.x0,
          y0: pointerStart.y0,
          cx: pointerStart.cx,
          cy: pointerStart.cy,
        });
      }
    } else if (dragCard) {
      setCardPositions((prev) => ({
        ...prev,
        [dragCard.id]: {
          x: dragCard.x0 + (e.clientX - dragCard.cx),
          y: dragCard.y0 + (e.clientY - dragCard.cy),
        },
      }));
    }
  };

  const handlePointerUp = (e?: React.PointerEvent) => {
    if (pointerStart?.targetEl && e) {
      try {
        pointerStart.targetEl.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    setPointerStart(null);
    setDragCard(null);
  };

  const toggleTool = (toolId: string) => {
    setEnabledTools((prev) => ({
      ...prev,
      [toolId]: !prev[toolId],
    }));
  };

  const handleOpenCreateModal = (column: BoardColumn = 'planning') => {
    setTargetColumn(column);
    setTaskTitle('');
    setTaskDescription('');
    const init: Record<string, boolean> = {};
    for (const tool of AVAILABLE_TOOLS) init[tool.id] = true;
    setEnabledTools(init);
    setModalOpen(true);
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) return;

    const selectedToolList = AVAILABLE_TOOLS.filter((tItem) => enabledTools[tItem.id]).map((tItem) => tItem.id);

    await board.add({
      title: taskTitle.trim(),
      notes: taskDescription.trim(),
      column: targetColumn,
      model: selectedModel,
      tools: selectedToolList,
      gated: requireGate,
    });

    setModalOpen(false);
    setTaskTitle('');
    setTaskDescription('');
  };

  const handleLaunchSwarm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!swarmTitle.trim()) return;

    const agentRoster = SWARM_AGENT_PRESETS.filter((a) => selectedSwarmAgents.includes(a.id));
    const toolList = Array.from(new Set(agentRoster.flatMap((a) => a.tools)));

    await board.add({
      title: swarmTitle.trim(),
      notes: `[🐝 SWARM STRATEGY: ${swarmStrategy.toUpperCase()}]\n${swarmObjective.trim()}`,
      column: swarmTargetColumn,
      tools: toolList.length > 0 ? toolList : ['read_file', 'edit_file', 'run_tests'],
      gated: true,
      model: agentRoster[0]?.model || selectedModel,
      swarm: {
        strategy: swarmStrategy,
        agents: agentRoster.map((a) => ({ id: a.id, name: a.name, role: a.role, icon: a.icon })),
      },
    });

    setSwarmModalOpen(false);
  };

  const handleAttachClick = (taskId: string) => {
    setTargetTaskId(taskId);
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && targetTaskId) {
      void board.attach(targetTaskId, file);
    }
    e.target.value = '';
    setTargetTaskId(null);
  };

  const isSavingRef = useRef(false);

  // ── Persist inline edits from the detail modal ──
  //
  // Returns without writing when nothing changed, so a plain open-and-close
  // does not churn the board file or bump updatedAt.
  const flushDetailEdits = async (): Promise<void> => {
    if (isSavingRef.current) return;
    const task = detailTaskId ? allTasksRef.current.find((x) => x.id === detailTaskId) : null;
    if (!task) return;

    const patch: Partial<BoardTask> = {};
    if (editTitle.trim() && editTitle.trim() !== task.title) patch.title = editTitle.trim();
    if (editNotes.trim() !== (task.notes || '')) patch.notes = editNotes.trim();
    if (editModel && editModel !== (task.model || activeModel)) patch.model = editModel;
    if (Object.keys(patch).length === 0) return;

    // The sample cards exist only in this component; the engine has never
    // heard of their ids, so board.update would be rejected and the refresh
    // that follows would silently roll the edit back. Say so instead.
    if (showingMocks) {
      setMockEditWarning('These are sample cards. Create a task to make edits stick.');
      return;
    }

    isSavingRef.current = true;
    try {
      await board.update(task.id, patch);
    } finally {
      isSavingRef.current = false;
    }
  };

  /**
   * Edit one step of the task's attached pipeline.
   *
   * Writes straight through to the board rather than into local edit state.
   * The step list is derived from the task, so buffering it would mean a
   * second copy to reconcile — and the pipeline is the thing that runs, so a
   * rename that only lived in the modal would be a lie about what executes.
   */
  const updateWorkflowStep = (nodeId: string, patch: { name?: string; desc?: string }) => {
    setStepDrafts((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId], ...patch } }));
  };

  /**
   * Write buffered step edits to the board.
   *
   * Buffered rather than written per keystroke: each write rewrites the whole
   * board file, so typing a sentence into a step description would rewrite it
   * once per character.
   */
  const flushStepDrafts = async (): Promise<void> => {
    const task = detailTaskId ? allTasksRef.current.find((x) => x.id === detailTaskId) : null;
    if (!task?.workflow) return;
    const drafts = stepDraftsRef.current;
    if (Object.keys(drafts).length === 0) return;

    const nodes = task.workflow.nodes.map((n) => {
      const d = drafts[n.id];
      if (!d) return n;
      return {
        ...n,
        // An empty name would leave an unlabelled step, so the old one stands.
        name: d.name?.trim() ? d.name.trim() : n.name,
        desc: d.desc !== undefined ? d.desc : n.desc,
      };
    });

    const changed = nodes.some((n, i) =>
      n.name !== task.workflow!.nodes[i].name || n.desc !== task.workflow!.nodes[i].desc);
    setStepDrafts({});
    if (!changed) return;
    await board.update(task.id, { workflow: { ...task.workflow, nodes } });
  };

  /**
   * Drop a step, and every edge that touched it.
   *
   * Leaving the edges behind would point wires at a node that is gone, which
   * the engine rejects as a malformed workflow — so the removal has to take
   * them with it rather than orphan them.
   */
  const removeWorkflowStep = (nodeId: string) => {
    const task = detailTaskId ? allTasksRef.current.find((x) => x.id === detailTaskId) : null;
    if (!task?.workflow) return;
    void board.update(task.id, {
      workflow: {
        nodes: task.workflow.nodes.filter((n) => n.id !== nodeId),
        edges: task.workflow.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
      },
    });
  };

  const handleSaveDetailEdit = async () => {
    await flushDetailEdits();
    await flushStepDrafts();
    setIsEditingDetail(false);
  };

  /**
   * Close the modal, saving first.
   *
   * Every exit — the X, the backdrop, the footer button — comes through here.
   * Previously only the explicit SAVE button wrote anything, so closing the
   * modal any other way discarded the edit without a word.
   */
  const closeDetail: () => void = () => {
    void Promise.all([flushDetailEdits(), flushStepDrafts()]).finally(() => {
      setDetailTaskId(null);
      setIsEditingDetail(false);
    });
  };
  closeDetailRef.current = closeDetail;

  // ── Attach file from within the NES detail modal ──
  const handleModalFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && detailModalTask) {
      void board.attach(detailModalTask.id, file);
    }
    e.target.value = '';
  };

  return (
    <div className="kanban-view" onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />

      <header className="kanban-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span className="kanban-topbar-label">Board</span>
          <div className="tab-mode-pills" style={{ marginInlineStart: '4px' }}>
            <button
              type="button"
              className={`btn-mode-pill ${kanbanSubTab === 'board' ? 'active' : ''}`}
              onClick={() => setKanbanSubTab('board')}
            >
              📌 Board View
            </button>
            <button
              type="button"
              className={`btn-mode-pill ${kanbanSubTab === 'list' ? 'active' : ''}`}
              onClick={() => setKanbanSubTab('list')}
            >
              📊 Execution List ({allTasks.length})
            </button>
            <button
              type="button"
              className={`btn-mode-pill ${kanbanSubTab === 'providers' ? 'active' : ''}`}
              onClick={() => setKanbanSubTab('providers')}
            >
              🔌 Third-Party Providers
            </button>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
          {kanbanSubTab === 'board' && (
            <span className="kanban-topbar-sub" style={{ display: 'inline-block', marginRight: '10px' }}>
              drag cards freely · click title to inspect model & tools
            </span>
          )}
          <button
            type="button"
            className="btn-kanban-swarm"
            onClick={() => setSwarmModalOpen(true)}
            title="Coordinate an autonomous multi-agent swarm"
          >
            <span style={{ fontSize: '15px' }}>🐝</span> Launch Agent Swarm
          </button>
          <button
            type="button"
            className="btn-kanban-add-task"
            onClick={() => handleOpenCreateModal('planning')}
          >
            <span style={{ fontSize: '14px', lineHeight: 1 }}>+</span> Create Task
          </button>
        </div>
      </header>

      {kanbanSubTab === 'board' && (
        <div className="kanban-stage-scroll">
          <div className="kanban-stage-columns">
            {LANES.map((lane) => {
              const laneTasks = laneTaskLists[lane.key] || [];
              const isLaneActiveForDrag = Boolean(dragCard && laneTasks.some((t) => t.id === dragCard.id));

              return (
                <div
                  key={lane.key}
                  className={`kanban-column-lane lane-${lane.key}`}
                  style={{
                    zIndex: isLaneActiveForDrag ? 9999 : 1,
                    position: 'relative',
                    overflow: 'visible'
                  }}
                >
                  {/* Column Header */}
                  <div className="kanban-column-header">
                    <div className="column-title-row">
                      <span className="lane-dot" style={{ background: lane.dot }} />
                      <h3 className="lane-name">{lane.name}</h3>
                      <span className="lane-count">{laneTasks.length}</span>
                      <button
                        type="button"
                        className="lane-add-btn"
                        title={`Add task to ${lane.name}`}
                        onClick={() => handleOpenCreateModal(lane.key)}
                      >
                        +
                      </button>
                    </div>
                    <div className="column-rule-subtext">{lane.rule}</div>
                  </div>

                  {/* Column Cards List */}
                  <div className="kanban-column-cards">
                    {laneTasks.map((tItem, cardIdx) => {
                      const isExecution = tItem.column === 'execution';
                      const isPrimaryExecution = isExecution && !tItem.waiting && cardIdx % 2 === 0;
                      const isParallelExecution = isExecution && !tItem.waiting && cardIdx % 2 === 1;
                      const isWaiting = isExecution && tItem.waiting;

                      const extra = tItem as unknown as {
                        tools?: string[];
                        files?: string[];
                        verify?: string;
                        verifyColor?: string;
                        tokens?: string;
                        duration?: string;
                        gated?: boolean;
                      };

                      return (
                        <div
                          key={tItem.id}
                          className={`kanban-card ${dragCard?.id === tItem.id ? 'dragging' : ''} ${isPrimaryExecution ? 'primary-runner' : ''} ${isParallelExecution ? 'parallel-runner' : ''} ${isWaiting ? 'waiting-runner' : ''}`}
                          style={{
                            transform: cardPositions[tItem.id]
                              ? `translate3d(${cardPositions[tItem.id].x}px, ${cardPositions[tItem.id].y}px, 0)`
                              : undefined,
                            cursor: dragCard?.id === tItem.id ? 'grabbing' : 'grab',
                            touchAction: 'none',
                            userSelect: 'none',
                            zIndex: dragCard?.id === tItem.id ? 99999 : 1,
                            position: 'relative'
                          }}
                          onPointerDown={(e) => handleGrab(e, tItem.id, cardPositions[tItem.id]?.x || 0, cardPositions[tItem.id]?.y || 0)}
                          onPointerMove={handlePointerMove}
                          onPointerUp={handlePointerUp}
                        >
                          {/* Inner Card Content */}
                          <div
                            className="card-clickable-area"
                            onClick={() => {
                              setDetailTaskId(tItem.id);
                              setIsEditingDetail(false);
                            }}
                          >
                            <div className="card-header-row">
                              <span className="card-id-badge">#{tItem.id.slice(0, 6)}</span>
                              <div className="card-badges-right" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <button
                                  type="button"
                                  className="btn-edit-card-chip"
                                  style={{
                                    background: 'rgba(110, 208, 234, 0.15)',
                                    color: 'var(--acc2)',
                                    border: '1px solid rgba(110, 208, 234, 0.3)',
                                    borderRadius: '4px',
                                    fontSize: '10.5px',
                                    padding: '2px 6px',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                    marginRight: '4px'
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDetailTaskId(tItem.id);
                                    setIsEditingDetail(true);
                                  }}
                                  title="Edit task box details"
                                >
                                  ✏️ Edit
                                </button>
                                {extra.gated && (
                                  <span className="badge-gated" title="Human gate approval required">
                                    🔒 gated
                                  </span>
                                )}
                                {isWaiting && (
                                  <span className="badge-runner badge-waiting" style={{ background: '#f0ad4e', color: '#000', fontWeight: 600, padding: '2px 6px', borderRadius: '4px', fontSize: '10px' }}>
                                    ⌛ WAITING
                                  </span>
                                )}
                                {isPrimaryExecution && (
                                  <span className="badge-runner badge-primary">
                                    ⚡ WRITER (NERDS)
                                  </span>
                                )}
                                {isParallelExecution && (
                                  <span className="badge-runner badge-parallel">
                                    ⚡ READ-ONLY
                                  </span>
                                )}
                              </div>
                            </div>

                            <h4 className="card-title">{tItem.title}</h4>

                            {tItem.notes && <p className="card-notes">{tItem.notes}</p>}

                            {/* Tool Badges */}
                            {extra.tools && extra.tools.length > 0 && (
                              <div className="card-tools-list">
                                {extra.tools.map((t) => (
                                  <span key={t} className="card-tool-tag">
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}

                            {/* Attached Files */}
                            {extra.files && extra.files.length > 0 && (
                              <div className="card-files-list">
                                {extra.files.map((f) => (
                                  <span
                                    key={f}
                                    className="card-file-chip"
                                    title={f}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (isDesignFile(f)) {
                                        handleFileLaunch(f, tItem);
                                      } else {
                                        setDetailTaskId(tItem.id);
                                      }
                                    }}
                                  >
                                    📄 {f.split('/').pop()}
                                  </span>
                                ))}
                              </div>
                            )}

                            <div className="card-meta-line">
                              <span style={{ color: isPrimaryExecution ? '#ff6b6b' : isParallelExecution ? '#6ed0ea' : isWaiting ? '#f0ad4e' : extra.verifyColor || 'var(--mut)' }}>
                                {extra.verify || (tItem.column === 'finished' ? '✓ verified' : isWaiting ? '⧖ waiting' : isExecution ? '⟳ running' : '◯ pending')}
                              </span>
                              <span className="card-model-name">{tItem.model || activeModel}</span>
                            </div>

                            <div className="card-actions-line">
                              <span>{extra.tokens || '-'}</span>
                              <span>{extra.duration || '-'}</span>
                              <label
                                className="btn-card-attach"
                                title="Attach files, photos, docs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleAttachClick(tItem.id);
                                }}
                              >
                                <span style={{ fontSize: '12px', lineHeight: 1 }}>+</span>attach
                              </label>
                              {tItem.column !== 'finished' && (
                                <button
                                  type="button"
                                  className="btn-card-run"
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onRun(tItem);
                                  }}
                                >
                                  run
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {kanbanSubTab === 'list' && (
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '24px 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          background: 'rgba(11, 14, 23, 0.4)',
          width: '100%',
          height: 'calc(100% - 60px)'
        }}>
          {/* Search & Filter Bar */}
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
              <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--txt-dim)', fontSize: '14px' }}>🔍</span>
              <input
                type="text"
                placeholder="Search execution task title, notes, or model..."
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px 10px 36px',
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--txt)',
                  fontSize: '13px'
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: 'var(--txt-dim)', fontWeight: 600, marginRight: '4px' }}>Filter Lane:</span>
              {(['all', 'planning', 'preparation', 'execution', 'finished'] as const).map((colKey) => (
                <button
                  key={colKey}
                  type="button"
                  className={`btn-mode-pill ${listColumnFilter === colKey ? 'active' : ''}`}
                  onClick={() => setListColumnFilter(colKey)}
                  style={{ textTransform: 'capitalize', fontSize: '12px', padding: '5px 12px' }}
                >
                  {colKey}
                </button>
              ))}
            </div>
          </div>

          {/* Tasks Data Table */}
          <div style={{
            background: 'var(--panel-bg)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden'
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--line)', color: 'var(--txt-dim)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <th style={{ padding: '12px 16px' }}>Task Title & Notes</th>
                  <th style={{ padding: '12px 16px', width: '130px' }}>Column Lane</th>
                  <th style={{ padding: '12px 16px', width: '110px' }}>Agent</th>
                  <th style={{ padding: '12px 16px', width: '160px' }}>Model</th>
                  <th style={{ padding: '12px 16px', width: '140px' }}>Status / Verify</th>
                  <th style={{ padding: '12px 16px', width: '110px' }}>Metrics</th>
                  <th style={{ padding: '12px 16px', width: '140px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const filtered = allTasks.filter((t) => {
                    const matchesSearch = !listSearch.trim() || 
                      t.title.toLowerCase().includes(listSearch.toLowerCase()) || 
                      (t.notes && t.notes.toLowerCase().includes(listSearch.toLowerCase())) ||
                      (t.model && t.model.toLowerCase().includes(listSearch.toLowerCase()));
                    const matchesCol = listColumnFilter === 'all' || t.column === listColumnFilter;
                    return matchesSearch && matchesCol;
                  });

                  if (filtered.length === 0) {
                    return (
                      <tr>
                        <td colSpan={7} style={{ padding: '40px', textAlign: 'center', color: 'var(--txt-dim)' }}>
                          <div style={{ fontSize: '24px', marginBottom: '8px' }}>📊</div>
                          No task executions matching filter.
                        </td>
                      </tr>
                    );
                  }

                  return filtered.map((tItem, idx) => {
                    const isExecution = tItem.column === 'execution';
                    const isWaiting = isExecution && tItem.waiting;
                    const isPrimaryExecution = isExecution && !tItem.waiting && idx % 2 === 0;
                    const isParallelExecution = isExecution && !tItem.waiting && idx % 2 === 1;

                    const extra = tItem as unknown as {
                      tools?: string[];
                      files?: string[];
                      verify?: string;
                      verifyColor?: string;
                      tokens?: string;
                      duration?: string;
                      gated?: boolean;
                    };

                    const laneDotColor = 
                      tItem.column === 'finished' ? 'var(--ok)' :
                      tItem.column === 'execution' ? 'var(--acc)' :
                      tItem.column === 'preparation' ? 'var(--acc2)' : 'var(--mut)';

                    return (
                      <tr
                        key={tItem.id}
                        style={{
                          borderBottom: '1px solid var(--line)',
                          background: idx % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.015)'
                        }}
                      >
                        <td style={{ padding: '14px 16px' }}>
                          <div style={{ fontWeight: 600, color: 'var(--txt)', fontSize: '13.5px', marginBottom: '4px', cursor: 'pointer' }} onClick={() => setDetailTaskId(tItem.id)}>
                            {tItem.title}
                          </div>
                          {tItem.notes && (
                            <div style={{ fontSize: '12px', color: 'var(--txt-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '380px' }}>
                              {tItem.notes}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '14px 16px' }}>
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '4px 10px',
                            borderRadius: '12px',
                            background: 'var(--bg)',
                            border: '1px solid var(--line)',
                            fontSize: '12px',
                            textTransform: 'capitalize'
                          }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: laneDotColor }} />
                            {tItem.column}
                          </span>
                        </td>
                        <td style={{ padding: '14px 16px', fontSize: '12.5px', color: 'var(--txt-dim)' }}>
                          {tItem.agent ? tItem.agent : 'Aura'}
                        </td>
                        <td style={{ padding: '14px 16px' }}>
                          <span style={{
                            fontSize: '11.5px',
                            fontFamily: 'var(--font-mono)',
                            background: 'var(--bg)',
                            border: '1px solid var(--line)',
                            padding: '3px 8px',
                            borderRadius: '4px',
                            color: 'var(--acc2)'
                          }}>
                            {tItem.model || activeModel}
                          </span>
                        </td>
                        <td style={{ padding: '14px 16px' }}>
                          <span style={{
                            fontSize: '12px',
                            fontWeight: 500,
                            color: isPrimaryExecution ? '#ff6b6b' : isParallelExecution ? '#6ed0ea' : isWaiting ? '#f0ad4e' : extra.verifyColor || 'var(--mut)'
                          }}>
                            {extra.verify || (tItem.column === 'finished' ? '✓ verified' : isWaiting ? '⧖ waiting' : isExecution ? '⟳ running' : '◯ pending')}
                          </span>
                        </td>
                        <td style={{ padding: '14px 16px', fontSize: '12px', color: 'var(--txt-dim)', fontFamily: 'var(--font-mono)' }}>
                          {extra.duration || '-'}<br />
                          {extra.tokens || ''}
                        </td>
                        <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              style={{
                                background: 'var(--bg)',
                                color: 'var(--txt)',
                                border: '1px solid var(--line)',
                                padding: '4px 10px',
                                borderRadius: '4px',
                                fontSize: '12px',
                                cursor: 'pointer'
                              }}
                              onClick={() => setDetailTaskId(tItem.id)}
                            >
                              Inspect
                            </button>
                            {tItem.column !== 'finished' && (
                              <button
                                type="button"
                                disabled={busy}
                                style={{
                                  background: 'var(--acc2)',
                                  color: '#000',
                                  border: 'none',
                                  padding: '4px 10px',
                                  borderRadius: '4px',
                                  fontSize: '12px',
                                  fontWeight: 600,
                                  cursor: 'pointer'
                                }}
                                onClick={() => onRun(tItem)}
                              >
                                ▶ Run
                              </button>
                            )}
                            <button
                              type="button"
                              style={{
                                background: 'transparent',
                                color: 'var(--txt-dim)',
                                border: '1px solid transparent',
                                padding: '4px 8px',
                                borderRadius: '4px',
                                fontSize: '12px',
                                cursor: 'pointer'
                              }}
                              title="Delete task"
                              onClick={() => board.remove(tItem.id)}
                            >
                              🗑
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {kanbanSubTab === 'providers' && (
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '32px 24px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          background: 'rgba(11, 14, 23, 0.4)',
          width: '100%',
          height: 'calc(100% - 60px)'
        }}>
          <div style={{ maxWidth: '900px', width: '100%', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Banner */}
            <div style={{
              background: 'var(--panel-bg)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              padding: '24px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                <span style={{ fontSize: '28px' }}>🔌</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: '18px', color: 'var(--acc2)' }}>⚡ Third-Party Integration & Automation Hub</h3>
                  <div style={{ fontSize: '13px', color: 'var(--txt-dim)', marginTop: '4px' }}>
                    Connect n8n, Zapier, Make.com, Pipedream, Activepieces, Telegram, Slack, and REST Webhooks with zero-code HTTP triggers.
                  </div>
                </div>
              </div>
            </div>

            {/* Provider Grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
              gap: '16px'
            }}>
              {THIRD_PARTY_PROVIDERS_LIST.map((prov) => {
                const live = liveProviders.find((p) => p.envKey === prov.envKey || p.name?.toLowerCase().includes(prov.name.toLowerCase()));
                const isKeySet = live ? live.keySet : Boolean(prov.envKey);
                const currentKeyInput = providerKeyInputs[prov.id] ?? '';
                const saveStatus = providerSaveStatus[prov.id];
                const isTesting = testingProviderId === prov.id;

                return (
                  <div key={prov.id} style={{
                    background: 'var(--panel-bg)',
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--radius)',
                    padding: '20px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    {/* Header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '22px' }}>{prov.icon}</span>
                        <div>
                          <h4 style={{ margin: 0, fontSize: '15px', color: 'var(--txt)' }}>{prov.name}</h4>
                          <span style={{ fontSize: '11px', color: 'var(--txt-dim)', fontFamily: 'var(--font-mono)' }}>{prov.role}</span>
                        </div>
                      </div>
                      <span style={{
                        fontSize: '11px',
                        padding: '3px 8px',
                        borderRadius: '10px',
                        fontWeight: 600,
                        background: isKeySet ? 'rgba(90, 158, 110, 0.15)' : 'rgba(232, 118, 54, 0.15)',
                        color: isKeySet ? 'var(--ok)' : '#ff8c42',
                        border: isKeySet ? '1px solid rgba(90, 158, 110, 0.3)' : '1px solid rgba(232, 118, 54, 0.3)'
                      }}>
                        {isKeySet ? '✓ Configured' : '⚠️ Setup Key'}
                      </span>
                    </div>

                    <p style={{ fontSize: '12.5px', color: 'var(--txt-dim)', margin: 0, lineHeight: 1.4 }}>
                      {prov.desc}
                    </p>

                    {/* Webhook URLs */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11.5px', color: 'var(--txt-dim)', background: 'var(--bg)', padding: '10px', borderRadius: '6px', border: '1px solid var(--line)' }}>
                      <div>
                        <strong style={{ color: 'var(--txt)' }}>Inbound Webhook Target:</strong><br />
                        <code style={{ color: 'var(--acc2)', wordBreak: 'break-all', fontSize: '11px' }}>{prov.inboundUrl}</code>
                      </div>
                      {prov.outboundUrl && (
                        <div style={{ marginTop: '2px' }}>
                          <strong style={{ color: 'var(--txt)' }}>Outbound Target URL:</strong><br />
                          <code style={{ color: 'var(--ok)', wordBreak: 'break-all', fontSize: '11px' }}>{prov.outboundUrl}</code>
                        </div>
                      )}
                    </div>

                    {/* Capabilities Tags */}
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px' }}>
                      {prov.capabilities.map((cap) => (
                        <span key={cap} style={{
                          fontSize: '10.5px',
                          background: 'var(--bg)',
                          border: '1px solid var(--line)',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          color: 'var(--txt-dim)',
                          fontFamily: 'var(--font-mono)'
                        }}>
                          ⚡ {cap}
                        </span>
                      ))}
                    </div>

                    {/* Key Input / Action Section */}
                    {prov.envKey && (
                      <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <input
                            type="password"
                            placeholder={`Enter ${prov.envKey}...`}
                            value={currentKeyInput}
                            onChange={(e) => setProviderKeyInputs({ ...providerKeyInputs, [prov.id]: e.target.value })}
                            style={{
                              flex: 1,
                              background: 'var(--bg)',
                              border: '1px solid var(--line)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '6px 10px',
                              fontSize: '12px',
                              color: 'var(--txt)'
                            }}
                          />
                          <button
                            type="button"
                            style={{
                              background: 'var(--line)',
                              color: 'var(--txt)',
                              border: '1px solid var(--line-strong)',
                              padding: '0 12px',
                              borderRadius: '4px',
                              fontSize: '12px',
                              cursor: 'pointer'
                            }}
                            onClick={() => handleSaveProviderKey(prov.id, prov.envKey)}
                          >
                            Save Key
                          </button>
                        </div>
                        {saveStatus && (
                          <span style={{ fontSize: '11px', color: 'var(--ok)' }}>{saveStatus}</span>
                        )}
                      </div>
                    )}

                    {/* Test Ping Action */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
                      <button
                        type="button"
                        disabled={isTesting}
                        style={{
                          background: 'transparent',
                          border: '1px solid var(--line)',
                          color: 'var(--txt-dim)',
                          padding: '4px 10px',
                          borderRadius: '4px',
                          fontSize: '11.5px',
                          cursor: 'pointer'
                        }}
                        onClick={() => handleTestProviderPing(prov.id)}
                      >
                        {isTesting ? '⚡ Testing ping...' : '📡 Test Provider Ping'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* NES Retro Game Box Task Detail Modal */}
      {detailModalTask && (
        <div className="modal-backdrop nes-backdrop nes-backdrop-glass" onClick={() => closeDetail()}>
          {/* Hidden file input for modal-level file attachment */}
          <input
            ref={modalFileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleModalFileAttach}
          />
          <div
            className="modal-card nes-modal-box kanban-detail-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {/* NES Cartridge Top Strip */}
            <div className="nes-cartridge-strip">
              <span className="nes-strip-chip">AURA-NES-01</span>
              <span className="nes-strip-title">★ 8-BIT QUEST SYSTEM · MISSION INSPECTION ★</span>
              <span className="nes-strip-led" />
            </div>

            {mockEditWarning && (
              <div className="nes-section-box" role="status" style={{ borderColor: 'var(--warn)' }}>
                <span className="nes-hud-val">{mockEditWarning}</span>
              </div>
            )}

            {/* NES Header — editable title in edit mode */}
            <div className="nes-header">
              <div className="nes-header-left">
                <div className="nes-badge-stage">STAGE // {detailModalTask.column.toUpperCase()}</div>
                {isEditingDetail ? (
                  <input
                    type="text"
                    className="nes-edit-input nes-edit-title"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => void flushDetailEdits()}
                    placeholder="Task title..."
                    autoFocus
                  />
                ) : (
                  <h2 className="nes-mission-title">{detailModalTask.title}</h2>
                )}
              </div>
              <button
                type="button"
                className="nes-btn-close"
                onClick={() => closeDetail()}
                title="Press [B] / Close"
              >
                ✕ [ESC]
              </button>
            </div>

            <div className="nes-content-body">
              {/* NES HUD Stats Row — editable model in edit mode */}
              <div className="nes-hud-grid">
                <div className="nes-hud-cell">
                  <span className="nes-hud-label">CARTRIDGE / MODEL</span>
                  {isEditingDetail ? (
                    <select
                      className="nes-edit-input nes-edit-select"
                      value={editModel}
                      onChange={(e) => setEditModel(e.target.value)}
                      onBlur={() => void flushDetailEdits()}
                    >
                      {availableModels.length > 0 ? (
                        availableModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.label || m.name || m.id}</option>
                        ))
                      ) : (
                        <option value={editModel}>{editModel}</option>
                      )}
                    </select>
                  ) : (
                    <span className="nes-hud-val val-cyan">{detailModalTask.model || activeModel}</span>
                  )}
                </div>
                <div className="nes-hud-cell">
                  <span className="nes-hud-label">STAGE LEVEL</span>
                  <span className="nes-hud-val val-orange">LVL 99 · {detailModalTask.column}</span>
                </div>
                <div className="nes-hud-cell">
                  <span className="nes-hud-label">SECURITY GATE</span>
                  <span className={`nes-hud-val ${(detailModalTask as any).gated ? 'val-red' : 'val-green'}`}>
                    {(detailModalTask as any).gated ? '🛡️ MANUAL APPROVAL' : '⚡ AUTO RUN'}
                  </span>
                </div>
                <div className="nes-hud-cell">
                  <span className="nes-hud-label">EXP / COINS</span>
                  <span className="nes-hud-val val-gold">7.3k TOKENS</span>
                </div>
              </div>

              {/* Quest Mission Notes — editable textarea in edit mode */}
              {(detailModalTask.notes || isEditingDetail) && (
                <div className="nes-section-box">
                  <div className="nes-section-tag">📜 QUEST DIRECTIVE & INSTRUCTIONS</div>
                  {isEditingDetail ? (
                    <textarea
                      className="nes-edit-input nes-edit-textarea"
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      onBlur={() => void flushDetailEdits()}
                      placeholder="Enter task instructions..."
                      rows={5}
                    />
                  ) : (
                    <div className="nes-quest-log">
                      {detailModalTask.notes}
                    </div>
                  )}
                </div>
              )}

              {/* Tools Inventory */}
              {((detailModalTask as any).tools?.length > 0) && (
                <div className="nes-section-box">
                  <div className="nes-section-tag">
                    🎒 EQUIPPED TOOL INVENTORY ({(detailModalTask as any).tools.length} ITEMS)
                  </div>
                  <div className="nes-inventory-grid">
                    {(detailModalTask as any).tools.map((toolName: string, idx: number) => {
                      const matched = AVAILABLE_TOOLS.find((at) => at.id === toolName);
                      return (
                        <div key={idx} className="nes-item-card">
                          <span className="nes-item-icon">{matched?.icon || '⚡'}</span>
                          <span className="nes-item-name">{matched?.label || toolName}</span>
                          <span className="nes-item-check">EQUIPPED</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Output Files & Artifacts Inventory */}
              {(((detailModalTask as any).files && (detailModalTask as any).files.length > 0) || (detailModalTask.attachments && detailModalTask.attachments.length > 0)) && (
                <div className="nes-section-box">
                  <div className="nes-section-tag">
                    🏁 GENERATED ARTIFACTS & OUTPUT FILES ({((detailModalTask as any).files || []).length + (detailModalTask.attachments || []).length} ITEMS)
                  </div>
                  <div className="nes-inventory-grid">
                    {((detailModalTask as any).files || []).map((file: string, fIdx: number) => {
                      const isDesign = isDesignFile(file);
                      return (
                        <div
                          key={`f-${fIdx}`}
                          className="nes-item-card"
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            closeDetail();
                            handleFileLaunch(file, detailModalTask);
                          }}
                          onDoubleClick={() => {
                            closeDetail();
                            handleFileLaunch(file, detailModalTask);
                          }}
                          title={isDesign ? 'Click or double-click to launch in Canvas' : 'Click or double-click to open in Code'}
                        >
                          <span className="nes-item-icon">{isDesign ? '🎮' : '📄'}</span>
                          <span className="nes-item-name">{file}</span>
                          <span className={`nes-item-check ${isDesign ? 'val-cyan' : 'val-orange'}`}>
                            {isDesign ? '▶ CANVAS' : '✏️ CODE'}
                          </span>
                        </div>
                      );
                    })}
                    {(detailModalTask.attachments || []).map((att, aIdx) => (
                      <div key={`a-${aIdx}`} className="nes-item-card">
                        <span className="nes-item-icon">📎</span>
                        <span className="nes-item-name">{att.name}</span>
                        <span className="nes-item-check">ATTACHMENT</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Attached Workflow Pipeline — editable in place */}
              {detailModalTask.workflow && (
                <div className="nes-section-box">
                  <div className="nes-section-tag">
                    🗺️ ATTACHED WORKFLOW TREE ({(detailModalTask.workflow.nodes || []).length} STEPS)
                  </div>
                  <div className="nes-quest-tree">
                    {(detailModalTask.workflow.nodes || []).map((node, nIdx) => (
                      <div key={node.id} className="nes-quest-step">
                        <span className="nes-step-idx">{nIdx + 1}</span>
                        <div className="nes-step-detail">
                          {isEditingDetail ? (
                            <>
                              <input
                                type="text"
                                className="nes-edit-input nes-step-name-input"
                                value={stepDrafts[node.id]?.name ?? node.name}
                                onChange={(e) => updateWorkflowStep(node.id, { name: e.target.value })}
                                onBlur={() => void flushStepDrafts()}
                                placeholder="Step name"
                              />
                              <textarea
                                className="nes-edit-input nes-step-desc-input"
                                value={stepDrafts[node.id]?.desc ?? node.desc ?? ''}
                                onChange={(e) => updateWorkflowStep(node.id, { desc: e.target.value })}
                                onBlur={() => void flushStepDrafts()}
                                placeholder="What this step does..."
                                rows={2}
                              />
                            </>
                          ) : (
                            <>
                              <div className="nes-step-name">{node.name}</div>
                              {node.desc && <div className="nes-step-desc">{node.desc}</div>}
                            </>
                          )}
                        </div>
                        <span className="nes-step-type">{node.type}</span>
                        {isEditingDetail && (
                          <button
                            type="button"
                            className="nes-step-del-btn"
                            title={`Remove step "${node.name}"`}
                            aria-label={`Remove step "${node.name}"`}
                            onClick={() => removeWorkflowStep(node.id)}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    {(detailModalTask.workflow.nodes || []).length === 0 && (
                      <div className="nes-step-desc">
                        No steps left. The pipeline runs nothing until one is added in Canvas.
                      </div>
                    )}
                  </div>
                  {!isEditingDetail && (
                    <div className="nes-step-desc" style={{ marginTop: 'var(--space-2)' }}>
                      Press EDIT to rename, describe or remove a step.
                    </div>
                  )}
                </div>
              )}

              {/* NES Arcade Controls / Actions */}
              <div className="nes-actions-bar">
                <button
                  type="button"
                  className="nes-arcade-btn btn-nes-b"
                  onClick={() => closeDetail()}
                >
                  <span className="nes-btn-badge">[ B ]</span> CLOSE
                </button>

                {/* Attach File button — always available */}
                <button
                  type="button"
                  className="nes-arcade-btn btn-nes-attach"
                  onClick={() => modalFileInputRef.current?.click()}
                >
                  <span className="nes-btn-badge">[ + ]</span> ATTACH FILE
                </button>

                {/* Edit / Save toggle */}
                {isEditingDetail ? (
                  <button
                    type="button"
                    className="nes-arcade-btn btn-nes-save"
                    onClick={() => void handleSaveDetailEdit()}
                  >
                    <span className="nes-btn-badge">[ S ]</span> SAVE CHANGES
                  </button>
                ) : (
                  <button
                    type="button"
                    className="nes-arcade-btn btn-nes-edit"
                    onClick={() => setIsEditingDetail(true)}
                  >
                    <span className="nes-btn-badge">[ E ]</span> EDIT
                  </button>
                )}

                {detailModalTask.column !== 'finished' && (
                  <button
                    type="button"
                    className="nes-arcade-btn btn-nes-a"
                    onClick={() => {
                      // Apply the open edits to the task being handed to the
                      // runner. Running the pre-edit snapshot would execute
                      // instructions the user just rewrote.
                      const t: BoardTask = isEditingDetail
                        ? {
                            ...detailModalTask,
                            title: editTitle.trim() || detailModalTask.title,
                            notes: editNotes.trim(),
                            model: editModel || detailModalTask.model,
                          }
                        : detailModalTask;
                      closeDetail();
                      onRun(t);
                    }}
                  >
                    <span className="nes-btn-badge">[ A ]</span> START / RUN IN BACKGROUND
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Task Creation Modal */}
      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div
            className="modal-card kanban-create-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-header">
              <div className="modal-title-row">
                <span className="modal-icon-badge">📋</span>
                <h2 className="modal-heading">Create Kanban Task</h2>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateTask} className="task-create-form">
              <div className="form-field-group">
                <label className="form-label">Task Name</label>
                <input
                  type="text"
                  className="form-input-text"
                  placeholder="e.g. Audit queries in perception layer"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div className="form-field-group">
                <label className="form-label">Description & Instructions</label>
                <textarea
                  className="form-textarea"
                  rows={3}
                  placeholder="Describe what Aura should reproduce, inspect, modify, or verify..."
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                />
              </div>

              <div className="form-row-two-col">
                <div className="form-field-group">
                  <label className="form-label">Target Lane</label>
                  <select
                    className="form-select"
                    value={targetColumn}
                    onChange={(e) => setTargetColumn(e.target.value as BoardColumn)}
                  >
                    <option value="planning">Planning (Read-only)</option>
                    <option value="preparation">Preparation (Waiting on gate)</option>
                    <option value="execution">Execution (Running & editing)</option>
                    <option value="finished">Finished (Verified)</option>
                  </select>
                </div>

                <div className="form-field-group">
                  <label className="form-label">Model</label>
                  <select
                    className="form-select"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                  >
                    {availableModels.length > 0 ? (
                      availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.label || m.id} ({m.provider})
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview (Google)</option>
                        <option value="gemini-3.6-flash">Gemini 3.6 Flash (Google)</option>
                        <option value="claude-sonnet-4-5-20251001">Claude Sonnet 4.5 (Anthropic)</option>
                        <option value="claude-opus-4-5-20251001">Claude Opus 4.5 (Anthropic)</option>
                        <option value="gpt-4o">GPT-4o (OpenAI)</option>
                        <option value="deepseek-v4-flash">DeepSeek V4 Flash (DeepSeek)</option>
                        <option value="mimo-v2.5-pro">MiMo V2.5 Pro (Xiaomi)</option>
                      </>
                    )}
                  </select>
                </div>
              </div>

              <div className="form-field-group" style={{ marginTop: '4px' }}>
                <div className="tools-label-row">
                  <label className="form-label">
                    Tools Granted
                    <span className="tools-sublabel">(All enabled by default · Click to toggle OFF/ON)</span>
                  </label>
                  <div className="tools-quick-actions">
                    <button
                      type="button"
                      className="btn-tools-link"
                      onClick={() => {
                        const allOn: Record<string, boolean> = {};
                        for (const tItem of AVAILABLE_TOOLS) allOn[tItem.id] = true;
                        setEnabledTools(allOn);
                      }}
                    >
                      Enable all
                    </button>
                    <span style={{ color: 'var(--dim)' }}>·</span>
                    <button
                      type="button"
                      className="btn-tools-link"
                      onClick={() => {
                        const allOff: Record<string, boolean> = {};
                        for (const tItem of AVAILABLE_TOOLS) allOff[tItem.id] = false;
                        setEnabledTools(allOff);
                      }}
                    >
                      Disable all
                    </button>
                  </div>
                </div>

                <div className="tools-toggle-grid">
                  {AVAILABLE_TOOLS.map((tool) => {
                    const isEnabled = Boolean(enabledTools[tool.id]);
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        className={`tool-toggle-btn ${isEnabled ? 'tool-on' : 'tool-off'}`}
                        onClick={() => toggleTool(tool.id)}
                        title={tool.desc}
                      >
                        <span className="tool-btn-icon">{tool.icon}</span>
                        <span className="tool-btn-name">{tool.label}</span>
                        <span className={`tool-btn-state ${isEnabled ? 'active' : 'inactive'}`}>
                          {isEnabled ? '✓' : '✕'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="form-field-group" style={{ marginTop: '8px' }}>
                <label className="gate-toggle-label">
                  <input
                    type="checkbox"
                    checked={requireGate}
                    onChange={(e) => setRequireGate(e.target.checked)}
                    className="gate-checkbox"
                  />
                  <span className="gate-label-text">
                    <strong>Require gate approval</strong> before modifying files or executing risky commands
                  </span>
                </label>
              </div>

              <div className="modal-actions-row">
                <button
                  type="button"
                  className="btn-modal-cancel"
                  onClick={() => setModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-modal-submit"
                >
                  Create Task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── AGENT SWARM COORDINATOR MODAL ───────────────────────────────── */}
      {swarmModalOpen && (
        <div className="modal-backdrop nes-backdrop" onClick={() => setSwarmModalOpen(false)}>
          <div
            className="modal-card nes-modal-box kanban-swarm-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {/* Top Retro Strip */}
            <div className="nes-cartridge-strip">
              <span className="nes-strip-chip">AURA-SWARM-01</span>
              <span className="nes-strip-title">★ AUTONOMOUS MULTI-AGENT SWARM COORDINATION ★</span>
              <span className="nes-strip-led" style={{ background: '#ffd166' }} />
            </div>

            <div className="modal-header">
              <div className="modal-title-row">
                <span className="modal-icon-badge" style={{ fontSize: '22px' }}>🐝</span>
                <div>
                  <h2 className="modal-heading" style={{ color: '#ffd166' }}>Deploy Autonomous Agent Swarm</h2>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--dim)', marginTop: '2px' }}>
                    Select specialized agent personas from dropdown to collaborate concurrently
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setSwarmModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleLaunchSwarm} className="task-create-form">
              <div className="form-field-group">
                <label className="form-label">Swarm Mission Directive</label>
                <input
                  type="text"
                  className="form-input-text"
                  placeholder="e.g. Full-Stack Refactor & Performance Optimization Swarm"
                  value={swarmTitle}
                  onChange={(e) => setSwarmTitle(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div className="form-field-group">
                <label className="form-label">Mission Objective & Guidelines</label>
                <textarea
                  className="form-textarea"
                  rows={2}
                  placeholder="Detail the swarm goals, execution constraints, and expected deliverables..."
                  value={swarmObjective}
                  onChange={(e) => setSwarmObjective(e.target.value)}
                />
              </div>

              {/* Agent Roster Dropdown Picker & Selection Grid */}
              <div className="form-field-group" style={{ marginTop: '4px' }}>
                <div className="tools-label-row">
                  <label className="form-label">
                    Swarm Agent Roster
                    <span className="tools-sublabel">({selectedSwarmAgents.length} Agents Assigned · Click dropdown to add/toggle)</span>
                  </label>
                </div>

                {/* Dropdown to add agent personas */}
                <div className="swarm-agent-dropdown-row">
                  <select
                    className="form-select swarm-agent-select"
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val && !selectedSwarmAgents.includes(val)) {
                        setSelectedSwarmAgents([...selectedSwarmAgents, val]);
                      }
                      e.target.value = '';
                    }}
                  >
                    <option value="">➕ Choose an Agent Persona to add to Swarm...</option>
                    {SWARM_AGENT_PRESETS.map((ag) => (
                      <option key={ag.id} value={ag.id} disabled={selectedSwarmAgents.includes(ag.id)}>
                        {ag.icon} {ag.name} ({ag.role}) — {ag.model}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Active Swarm Agent Chips */}
                <div className="swarm-agents-grid">
                  {SWARM_AGENT_PRESETS.map((ag) => {
                    const isSelected = selectedSwarmAgents.includes(ag.id);
                    return (
                      <div
                        key={ag.id}
                        className={`swarm-agent-card ${isSelected ? 'is-in-swarm' : 'not-in-swarm'}`}
                        onClick={() => {
                          if (isSelected) {
                            if (selectedSwarmAgents.length > 1) {
                              setSelectedSwarmAgents(selectedSwarmAgents.filter((id) => id !== ag.id));
                            }
                          } else {
                            setSelectedSwarmAgents([...selectedSwarmAgents, ag.id]);
                          }
                        }}
                      >
                        <div className="agent-card-icon">{ag.icon}</div>
                        <div className="agent-card-info">
                          <div className="agent-card-name-row">
                            <span className="agent-card-name">{ag.name}</span>
                            <span className={`agent-card-check ${isSelected ? 'active' : ''}`}>
                              {isSelected ? '✓ ACTIVE' : '+ ADD'}
                            </span>
                          </div>
                          <div className="agent-card-role">{ag.role}</div>
                          <div className="agent-card-model">🤖 {ag.model}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="form-row-two-col" style={{ marginTop: '10px' }}>
                <div className="form-field-group">
                  <label className="form-label">Swarm Strategy</label>
                  <select
                    className="form-select"
                    value={swarmStrategy}
                    onChange={(e) => setSwarmStrategy(e.target.value as any)}
                  >
                    <option value="parallel">⚡ Parallel Swarm (Concurrent execution with consensus)</option>
                    <option value="pipeline">🔄 Sequential Pipeline (Passes artifacts step-to-step)</option>
                    <option value="hierarchical">👑 Hierarchical (Leader orchestrates worker agents)</option>
                  </select>
                </div>

                <div className="form-field-group">
                  <label className="form-label">Target Kanban Lane</label>
                  <select
                    className="form-select"
                    value={swarmTargetColumn}
                    onChange={(e) => setSwarmTargetColumn(e.target.value as BoardColumn)}
                  >
                    <option value="preparation">Preparation (Ready for gate)</option>
                    <option value="execution">Execution (Launch immediately)</option>
                    <option value="planning">Planning (Research backlog)</option>
                  </select>
                </div>
              </div>

              <div className="modal-actions-row" style={{ marginTop: '14px' }}>
                <button
                  type="button"
                  className="btn-modal-cancel"
                  onClick={() => setSwarmModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-modal-submit btn-swarm-submit"
                >
                  🐝 Deploy Swarm ({selectedSwarmAgents.length} Agents)
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
