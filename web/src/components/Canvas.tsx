import { useState, useRef, useEffect, useCallback } from 'react';
import { type WorkflowStepNode, type WorkflowEdge, type WorkflowDef, type BoardTask } from '../hooks/useBoard';
import { getAuthTokenSync } from '../lib/auth';

export type CanvasMode = 'preview' | 'graph' | 'board' | 'diff';
export type ViewportPreset = 'full' | 'fhd' | 'laptop' | 'tablet_h' | 'tablet_v' | 'mobile' | 'custom';
export type PreviewSourceMode = 'code_sandbox' | 'dev_server';

interface NoteItem {
  id: string;
  x: number;
  y: number;
  w: number;
  label: string;
  tone: 'accent' | 'ok' | 'warn' | 'plain';
  text: string;
}

interface DiffArtifact {
  tag: string;
  tagColor: string;
  meta: string;
  lines: Array<{ text: string; kind: 'ctx' | 'add' | 'del' }>;
}

const INITIAL_WORKFLOW_NODES: WorkflowStepNode[] = [
  { id: 'node-1', name: 'Reproduce Bug', type: 'tool', tool: 'run_tests', desc: 'Run vitest 20x to capture failure rate', x: 40, y: 50 },
  { id: 'node-2', name: 'Inspect Source', type: 'tool', tool: 'read_file', desc: 'Read src/agent/loop.ts around clock line', x: 280, y: 50 },
  { id: 'node-3', name: 'Reason & Diagnose', type: 'llm', desc: 'Synthesize cause and design injected clock fix', x: 520, y: 50 },
  { id: 'node-4', name: 'Write Clock Module', type: 'tool', tool: 'write_file', desc: 'Generate src/agent/clock.ts', x: 160, y: 220 },
  { id: 'node-5', name: 'Edit Loop Gate', type: 'gate', desc: 'Require approval before patching loop.ts', x: 400, y: 220 },
  { id: 'node-6', name: 'Verify Stability', type: 'verify', tool: 'run_tests', desc: 'Run 40x repeat to confirm 0 regressions', x: 280, y: 390 },
];

const INITIAL_WORKFLOW_EDGES: WorkflowEdge[] = [
  { from: 'node-1', to: 'node-2' },
  { from: 'node-2', to: 'node-3' },
  { from: 'node-3', to: 'node-4' },
  { from: 'node-4', to: 'node-5' },
  { from: 'node-5', to: 'node-6' },
];

const DEFAULT_NOTES: NoteItem[] = [
  { id: 'n1', x: 40, y: 36, w: 260, label: 'Hypothesis', tone: 'accent', text: 'Every flake so far traces to a wall-clock read inside an assertion window.' },
  { id: 'n2', x: 340, y: 60, w: 240, label: 'Evidence', tone: 'ok', text: '40/40 green after injecting the clock. Was 17/20 before.' },
  { id: 'n3', x: 120, y: 220, w: 280, label: 'Open question', tone: 'warn', text: 'Does the scheduler have the same read? grep says 3 more call sites.' },
  { id: 'n4', x: 450, y: 260, w: 250, label: 'Artifact', tone: 'plain', text: 'src/agent/clock.ts - 28 lines, no dependencies.' },
];

const DEFAULT_ARTIFACTS: DiffArtifact[] = [
  {
    tag: 'Before · 17/20 failed',
    tagColor: 'var(--err)',
    meta: 'loop.ts @ 8f2a1c',
    lines: [
      { text: 'const startedAt = Date.now();', kind: 'del' },
      { text: 'const delay = backoff(n) + jitter();', kind: 'del' },
      { text: '', kind: 'ctx' },
      { text: 'if (delay > budget) throw ...', kind: 'ctx' },
      { text: 'await sleep(delay);', kind: 'del' },
      { text: '', kind: 'ctx' },
      { text: '// timing read from the wall clock', kind: 'ctx' },
    ],
  },
  {
    tag: 'After · 40/40 passed',
    tagColor: 'var(--ok)',
    meta: 'loop.ts @ working tree',
    lines: [
      { text: 'const startedAt = this.clock.now();', kind: 'add' },
      { text: 'const delay = backoff(n, this.clock.seed);', kind: 'add' },
      { text: '', kind: 'ctx' },
      { text: 'if (delay > budget) throw ...', kind: 'ctx' },
      { text: 'await this.clock.sleep(delay);', kind: 'add' },
      { text: '', kind: 'ctx' },
      { text: '// clock injected - deterministic in test', kind: 'ctx' },
    ],
  },
];

const TEMPLATES: Record<string, { name: string; code: string }> = {
  game_canvas: {
    name: '🎮 2D Canvas / WebGL Game Engine Starter',
    code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aura 2D Game Engine</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #090a10;
      color: #fff;
      font-family: 'JetBrains Mono', monospace;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      overflow: hidden;
    }
    .game-hud {
      display: flex;
      justify-content: space-between;
      width: 680px;
      margin-bottom: 10px;
      font-size: 13px;
      color: #6ed0ea;
    }
    #viewport {
      background: #05060a;
      border: 2px solid #232536;
      border-radius: 8px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.8), 0 0 20px rgba(110,208,234,0.1);
    }
    .game-footer {
      margin-top: 10px;
      font-size: 11px;
      color: #a4b0be;
    }
  </style>
</head>
<body>
  <div class="game-hud">
    <span>★ LEVEL 1 · 60 FPS</span>
    <span id="score-display">SCORE: 00000</span>
    <span>LIVES: ▲ ▲ ▲</span>
  </div>
  <canvas id="viewport" width="680" height="420"></canvas>
  <div class="game-footer">CONTROLS: [← / → / A / D] Move · [SPACE / W / ↑] Jump & Fire</div>

  <script>
    const canvas = document.getElementById('viewport');
    const ctx = canvas.getContext('2d');
    const scoreDisplay = document.getElementById('score-display');

    let score = 0;
    const player = {
      x: 340, y: 350, vx: 0, vy: 0,
      width: 28, height: 36,
      grounded: true, color: '#6ed0ea'
    };

    const keys = {};
    const particles = [];
    const coins = [
      { x: 120, y: 280, r: 8, collected: false },
      { x: 260, y: 220, r: 8, collected: false },
      { x: 420, y: 220, r: 8, collected: false },
      { x: 560, y: 280, r: 8, collected: false }
    ];

    window.addEventListener('keydown', e => { keys[e.code] = true; });
    window.addEventListener('keyup', e => { keys[e.code] = false; });

    function update() {
      // Horizontal physics
      if (keys['ArrowLeft'] || keys['KeyA']) player.vx = -5;
      else if (keys['ArrowRight'] || keys['KeyD']) player.vx = 5;
      else player.vx *= 0.8;

      // Jump physics
      if ((keys['Space'] || keys['KeyW'] || keys['ArrowUp']) && player.grounded) {
        player.vy = -11;
        player.grounded = false;
        // Spawn jump dust particles
        for (let i = 0; i < 6; i++) {
          particles.push({
            x: player.x + player.width / 2,
            y: player.y + player.height,
            vx: (Math.random() - 0.5) * 4,
            vy: -Math.random() * 2,
            life: 20, color: '#6ed0ea'
          });
        }
      }

      player.vy += 0.45; // gravity
      player.x += player.vx;
      player.y += player.vy;

      // Boundary & floor collision
      player.x = Math.max(10, Math.min(canvas.width - player.width - 10, player.x));
      if (player.y >= 350) {
        player.y = 350;
        player.vy = 0;
        player.grounded = true;
      }

      // Collect coins
      coins.forEach(c => {
        if (!c.collected && Math.hypot(player.x + 14 - c.x, player.y + 18 - c.y) < 24) {
          c.collected = true;
          score += 250;
          scoreDisplay.innerText = 'SCORE: ' + String(score).padStart(5, '0');
          for (let i = 0; i < 10; i++) {
            particles.push({
              x: c.x, y: c.y,
              vx: (Math.random() - 0.5) * 6,
              vy: (Math.random() - 0.5) * 6,
              life: 25, color: '#ffd166'
            });
          }
        }
      });

      // Update particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life--;
        if (p.life <= 0) particles.splice(i, 1);
      }
    }

    function render() {
      ctx.fillStyle = '#07080f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Floor
      ctx.fillStyle = '#1c1e2d';
      ctx.fillRect(0, 386, canvas.width, 34);
      ctx.fillStyle = '#2ed573';
      ctx.fillRect(0, 386, canvas.width, 3);

      // Platforms
      ctx.fillStyle = '#242738';
      ctx.fillRect(220, 260, 240, 12);
      ctx.fillStyle = '#6ed0ea';
      ctx.fillRect(220, 260, 240, 2);

      // Coins
      coins.forEach(c => {
        if (!c.collected) {
          ctx.fillStyle = '#ffd166';
          ctx.beginPath();
          ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      // Particles
      particles.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      });

      // Player
      ctx.fillStyle = player.color;
      ctx.fillRect(player.x, player.y, player.width, player.height);
      ctx.fillStyle = '#090a0e';
      ctx.fillRect(player.x + 16, player.y + 6, 6, 6); // visor eye
    }

    function loop() {
      update();
      render();
      requestAnimationFrame(loop);
    }
    loop();
  </script>
</body>
</html>`,
  },
  webapp_html: {
    name: '🌐 Responsive Web App Dashboard',
    code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aura Modern Web App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #090a0e;
      color: #ced6e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      min-height: 100vh;
    }
    .sidebar {
      width: 220px;
      background: #111218;
      border-right: 1px solid rgba(255,255,255,0.08);
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .brand { font-size: 16px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; }
    .nav-link { padding: 8px 12px; border-radius: 6px; color: #a4b0be; text-decoration: none; font-size: 13px; }
    .nav-link.active { background: #1c1f2e; color: #6ed0ea; font-weight: 600; }
    .main-content { flex: 1; padding: 28px 32px; display: flex; flex-direction: column; gap: 20px; }
    .header-row { display: flex; align-items: center; justify-content: space-between; }
    .cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
    .stat-card { background: #141520; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 18px; }
    .stat-label { font-size: 11px; text-transform: uppercase; color: #747d8c; letter-spacing: 0.08em; }
    .stat-val { font-size: 26px; font-weight: 700; color: #fff; margin-top: 6px; }
    .btn-action { padding: 8px 16px; background: #c2674c; border: 0; border-radius: 6px; color: #fff; font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="brand">⚡ Aura App</div>
    <div class="nav-link active">📊 Analytics</div>
    <div class="nav-link">📁 Deployments</div>
    <div class="nav-link">⚙️ Configuration</div>
  </div>
  <div class="main-content">
    <div class="header-row">
      <div>
        <h1 style="font-size: 22px; color: #fff;">Application Monitor</h1>
        <p style="font-size: 13px; color: #747d8c; margin-top: 4px;">Live sandbox runtime preview</p>
      </div>
      <button class="btn-action">+ New Instance</button>
    </div>
    <div class="cards-grid">
      <div class="stat-card">
        <div class="stat-label">Throughput</div>
        <div class="stat-val">2,480 req/s</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Latency</div>
        <div class="stat-val">12.4 ms</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Health</div>
        <div class="stat-val" style="color: #2ed573;">100% OK</div>
      </div>
    </div>
  </div>
</body>
</html>`,
  },
};

export const normalizePreviewUrl = (raw: string): string => {
  let trimmed = (raw || '').trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    if (trimmed.startsWith('localhost') || trimmed.startsWith('127.0.0.1')) {
      trimmed = 'http://' + trimmed;
    } else {
      trimmed = 'https://' + trimmed;
    }
  }
  return trimmed;
};

export const getProxiedPreviewUrl = (raw: string): string => {
  const normalized = normalizePreviewUrl(raw);
  if (!normalized) return '';
  // Sync on purpose — this feeds an <iframe src>. getAuthTokenSync returns the
  // token already resolved at startup, which under Tauri came from IPC; reading
  // ?token= here would find nothing, since tauri://localhost has no query string.
  const token = getAuthTokenSync();
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
  return `/api/preview-proxy?url=${encodeURIComponent(normalized)}${tokenParam}`;
};

export interface CanvasTab {
  id: string;
  title: string;
  type: 'code_sandbox' | 'web_url';
  url: string;
  codeContent: string;
  renderedSrcDoc: string;
  templateKey: string;
  history: string[];
  historyIndex: number;
  viewTab: 'render' | 'code';
  key: number;
  icon?: string;
}

const INITIAL_CANVAS_TABS: CanvasTab[] = [
  {
    id: 'tab-game-starter',
    title: '🕹️ 2D Game Sandbox',
    type: 'code_sandbox',
    url: '',
    codeContent: TEMPLATES.game_canvas.code,
    renderedSrcDoc: TEMPLATES.game_canvas.code,
    templateKey: 'game_canvas',
    history: [''],
    historyIndex: 0,
    viewTab: 'render',
    key: 1,
    icon: '🎮',
  },
  {
    id: 'tab-youtube-web',
    title: '🌐 YouTube Web',
    type: 'web_url',
    url: 'https://www.youtube.com',
    codeContent: '',
    renderedSrcDoc: '',
    templateKey: 'custom',
    history: ['https://www.youtube.com'],
    historyIndex: 0,
    viewTab: 'render',
    key: 2,
    icon: '▶️',
  },
];

export function Canvas({
  previewPayload,
  onSaveWorkflowToPreparation,
  onRunWorkflow,
  onCreateTaskFromNote,
}: {
  previewPayload?: { path: string; content?: string } | null;
  onSaveWorkflowToPreparation?: (task: {
    title: string;
    notes: string;
    tools: string[];
    gated: boolean;
    workflow: WorkflowDef;
  }) => void;
  /** Save the pipeline and start it immediately; it lands in Execution. */
  onRunWorkflow?: (task: {
    title: string;
    notes: string;
    tools: string[];
    gated: boolean;
    workflow: WorkflowDef;
  }) => void;
  onCreateTaskFromNote?: (note: { title: string; text: string }) => void;
}) {
  const [mode, setMode] = useState<CanvasMode>('preview');
  const [tabs, setTabs] = useState<CanvasTab[]>(INITIAL_CANVAS_TABS);
  const [activeTabId, setActiveTabId] = useState<string>('tab-game-starter');
  const [addressInput, setAddressInput] = useState<string>('https://www.youtube.com');
  const [viewportPreset, setViewportPreset] = useState<ViewportPreset>('full');
  const [customWidth, setCustomWidth] = useState<number>(1280);
  const [customHeight, setCustomHeight] = useState<number>(720);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── Workflow graph (mode: 'graph') ────────────────────────────────────────
  const [workflowNodes, setWorkflowNodes] = useState<WorkflowStepNode[]>(INITIAL_WORKFLOW_NODES);
  const [workflowEdges, setWorkflowEdges] = useState<WorkflowEdge[]>(INITIAL_WORKFLOW_EDGES);
  /** Node a wire is currently being dragged out of, if any. */
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  /** Loose end of that wire, in stage coordinates. */
  const [connectingWirePos, setConnectingWirePos] = useState<{ x: number; y: number } | null>(null);
  /** Node under the pointer while connecting, so it can highlight as a target. */
  const [hoverTargetNodeId, setHoverTargetNodeId] = useState<string | null>(null);
  const [dragWorkflowNode, setDragWorkflowNode] = useState<
    { id: string; cx: number; cy: number; x0: number; y0: number } | null
  >(null);
  /** A ref, not state: pointerup reads it in the same gesture that set it. */
  const isPointerDownConnecting = useRef<boolean>(false);
  const stageAreaRef = useRef<HTMLDivElement | null>(null);

  // ── Save-graph-to-Kanban modal ────────────────────────────────────────────
  const [saveModalOpen, setSaveModalOpen] = useState<boolean>(false);
  const [workflowTaskTitle, setWorkflowTaskTitle] = useState<string>('Pipeline from Canvas');
  const [workflowTaskNotes, setWorkflowTaskNotes] = useState<string>('');

  // ── Sticky notes (mode: 'board') ──────────────────────────────────────────
  const [notes, setNotes] = useState<NoteItem[]>(DEFAULT_NOTES);
  const [dragNote, setDragNote] = useState<
    { id: string; cx: number; cy: number; x0: number; y0: number } | null
  >(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0] || INITIAL_CANVAS_TABS[0];

  useEffect(() => {
    if (activeTab) {
      setAddressInput(activeTab.url || (activeTab.type === 'web_url' ? 'https://www.youtube.com' : ''));
    }
  }, [activeTabId]);

  useEffect(() => {
    if (previewPayload && previewPayload.path) {
      setMode('preview');
      const filename = previewPayload.path.split('/').pop() || previewPayload.path;
      let doc = previewPayload.content || '';
      if (!doc) {
        doc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${previewPayload.path}</title>
  <style>
    body { margin: 0; padding: 30px; background: #0d0f17; color: #ede0cc; font-family: system-ui, -apple-system, sans-serif; }
    .preview-card { background: #141724; border: 1px solid #6ed0ea; border-radius: 12px; padding: 24px; box-shadow: 0 12px 36px rgba(0,0,0,0.6); max-width: 860px; margin: 0 auto; }
    .badge { display: inline-block; padding: 3px 9px; border-radius: 5px; background: rgba(46, 213, 115, 0.15); border: 1px solid rgba(46, 213, 115, 0.35); color: #2ed573; font-family: monospace; font-size: 11px; font-weight: 700; margin-bottom: 12px; }
    h1 { margin: 0 0 10px; font-size: 24px; color: #6ed0ea; }
    p { line-height: 1.6; color: #c8b5a0; font-size: 14px; }
    .web-sandbox-box { margin-top: 18px; padding: 16px; background: #0b0c13; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); font-family: monospace; font-size: 12px; color: #8be0f5; }
  </style>
</head>
<body>
  <div class="preview-card">
    <div class="badge">✓ KANBAN TASK RESULT ARTIFACT</div>
    <h1>🌐 ${previewPayload.path}</h1>
    <p>Loaded directly from completed task results. Live HTML sandbox container is running with full DOM, scripts, styles, and animation capabilities.</p>
    <div class="web-sandbox-box">
      <div>Status: 200 OK · Artifact Mounted</div>
      <div>Source Path: ${previewPayload.path}</div>
    </div>
  </div>
</body>
</html>`;
      }

      const existingTab = tabs.find((t) => t.title.includes(filename));
      if (existingTab) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === existingTab.id
              ? {
                  ...t,
                  type: 'code_sandbox',
                  codeContent: doc,
                  renderedSrcDoc: doc,
                  viewTab: 'render',
                  key: t.key + 1,
                }
              : t
          )
        );
        setActiveTabId(existingTab.id);
      } else {
        const newId = `tab-file-${Date.now()}`;
        const newTab: CanvasTab = {
          id: newId,
          title: `📄 ${filename}`,
          type: 'code_sandbox',
          url: '',
          codeContent: doc,
          renderedSrcDoc: doc,
          templateKey: 'custom',
          history: [''],
          historyIndex: 0,
          viewTab: 'render',
          key: Date.now(),
          icon: '📄',
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newId);
      }
    }
  }, [previewPayload]);

  const handleCreateTab = (
    type: 'code_sandbox' | 'web_url' = 'web_url',
    initialUrl = 'https://www.youtube.com',
    initialTitle = '🌐 YouTube / Web',
    initialCode?: string
  ) => {
    const newId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const code = initialCode || TEMPLATES.game_canvas.code;
    const newTab: CanvasTab = {
      id: newId,
      title: type === 'code_sandbox' ? (initialTitle || '🎮 Code Sandbox') : initialTitle,
      type,
      url: type === 'web_url' ? initialUrl : '',
      codeContent: code,
      renderedSrcDoc: code,
      templateKey: type === 'code_sandbox' ? 'game_canvas' : 'custom',
      history: type === 'web_url' ? [initialUrl] : [''],
      historyIndex: 0,
      viewTab: 'render',
      key: Date.now(),
      icon: type === 'code_sandbox' ? '🎮' : '🌐',
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    setAddressInput(newTab.url);
  };

  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) {
      const resetTab: CanvasTab = {
        id: `tab-${Date.now()}`,
        title: '🌐 YouTube Web',
        type: 'web_url',
        url: 'https://www.youtube.com',
        codeContent: TEMPLATES.game_canvas.code,
        renderedSrcDoc: TEMPLATES.game_canvas.code,
        templateKey: 'game_canvas',
        history: ['https://www.youtube.com'],
        historyIndex: 0,
        viewTab: 'render',
        key: Date.now(),
        icon: '▶️',
      };
      setTabs([resetTab]);
      setActiveTabId(resetTab.id);
      setAddressInput(resetTab.url);
      return;
    }
    const idx = tabs.findIndex((t) => t.id === tabId);
    const newTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(newTabs);
    if (activeTabId === tabId) {
      const nextActive = newTabs[Math.max(0, idx - 1)] || newTabs[0];
      setActiveTabId(nextActive.id);
      setAddressInput(nextActive.url);
    }
  };

  const handleNavigate = (direction: 'back' | 'forward' | 'reload') => {
    if (!activeTab) return;
    if (direction === 'reload') {
      setTabs((prev) =>
        prev.map((t) => (t.id === activeTab.id ? { ...t, key: t.key + 1 } : t))
      );
      return;
    }
    if (direction === 'back' && activeTab.historyIndex > 0) {
      const nextIndex = activeTab.historyIndex - 1;
      const prevUrl = activeTab.history[nextIndex];
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? { ...t, historyIndex: nextIndex, url: prevUrl, key: t.key + 1 }
            : t
        )
      );
      setAddressInput(prevUrl);
    } else if (direction === 'forward' && activeTab.historyIndex < activeTab.history.length - 1) {
      const nextIndex = activeTab.historyIndex + 1;
      const nextUrl = activeTab.history[nextIndex];
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? { ...t, historyIndex: nextIndex, url: nextUrl, key: t.key + 1 }
            : t
        )
      );
      setAddressInput(nextUrl);
    }
  };

  const handleGoToUrl = () => {
    if (!activeTab) return;
    const normalized = normalizePreviewUrl(addressInput);
    if (!normalized) return;

    let detectedTitle = normalized;
    let icon = '🌐';
    try {
      const parsed = new URL(normalized);
      const host = parsed.hostname.replace(/^www\./, '');
      if (host.includes('youtube') || host.includes('youtu.be')) {
        detectedTitle = 'YouTube';
        icon = '▶️';
      } else if (host.includes('github')) {
        detectedTitle = 'GitHub';
        icon = '🐙';
      } else if (host.includes('wikipedia')) {
        detectedTitle = 'Wikipedia';
        icon = '📚';
      } else {
        detectedTitle = host;
      }
    } catch {}

    const newHistory = activeTab.history.slice(0, activeTab.historyIndex + 1);
    newHistory.push(normalized);

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTab.id
          ? {
              ...t,
              type: 'web_url',
              url: normalized,
              title: `${icon} ${detectedTitle}`,
              history: newHistory,
              historyIndex: newHistory.length - 1,
              key: t.key + 1,
              icon,
            }
          : t
      )
    );
    setAddressInput(normalized);
  };

  const handleSelectTemplate = (key: string) => {
    const tmpl = TEMPLATES[key];
    if (!tmpl || !activeTab) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTab.id
          ? {
              ...t,
              type: 'code_sandbox',
              templateKey: key,
              codeContent: tmpl.code,
              renderedSrcDoc: tmpl.code,
              title: `🎮 ${tmpl.name}`,
              viewTab: 'render',
              key: t.key + 1,
              icon: '🎮',
            }
          : t
      )
    );
  };

  const handleNewInstance = () => {
    const freshStarter = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Fresh Game & App Instance</title>
  <style>
    body { margin: 0; background: #0d0f17; color: #ede0cc; font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; overflow: hidden; }
    .hud { text-align: center; margin-bottom: 12px; }
    h2 { margin: 0 0 6px; color: #6ed0ea; font-size: 20px; }
    p { margin: 0; color: #8a7768; font-size: 13px; }
    canvas { background: #141724; border: 2px solid #6ed0ea; border-radius: 10px; box-shadow: 0 0 28px rgba(110, 208, 234, 0.25); }
  </style>
</head>
<body>
  <div class="hud">
    <h2>⚡ New Instance Ready</h2>
    <p>Use "📁 Add File" or write code in the editor to run custom games and web apps.</p>
  </div>
  <canvas id="gameCanvas" width="600" height="340"></canvas>
  <script>
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    let x = 60, y = 170, dx = 4, dy = 3, radius = 22, angle = 0;
    function draw() {
      ctx.fillStyle = 'rgba(20, 23, 36, 0.25)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = '#6ed0ea';
      ctx.shadowColor = '#6ed0ea';
      ctx.shadowBlur = 15;
      ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
      ctx.restore();
      x += dx;
      y += dy;
      angle += 0.04;
      if (x + radius > canvas.width || x - radius < 0) dx = -dx;
      if (y + radius > canvas.height || y - radius < 0) dy = -dy;
      requestAnimationFrame(draw);
    }
    draw();
  </script>
</body>
</html>`;
    if (activeTab) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? {
                ...t,
                type: 'code_sandbox',
                codeContent: freshStarter,
                renderedSrcDoc: freshStarter,
                templateKey: 'custom',
                viewTab: 'render',
                title: '⚡ Fresh Instance',
                key: t.key + 1,
                icon: '⚡',
              }
            : t
        )
      );
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fileName = file.name.toLowerCase();
    const reader = new FileReader();
    reader.onload = (event) => {
      let content = (event.target?.result as string) || '';
      if (typeof content === 'string') {
        if ((fileName.endsWith('.js') || fileName.endsWith('.ts') || fileName.endsWith('.jsx') || fileName.endsWith('.tsx')) && !content.includes('<html')) {
          content = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${file.name} - Game Runner</title>
  <style>
    body { margin:0; background:#0b0c12; color:#fff; font-family:sans-serif; overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; }
    canvas { background:#000; border:1px solid #333; display:block; border-radius:8px; }
    #overlay-console { position:fixed; bottom:0; left:0; right:0; background:rgba(0,0,0,0.85); color:#00ff88; font-family:monospace; font-size:11px; padding:8px 14px; max-height:80px; overflow:auto; border-top:1px solid #222; }
  </style>
</head>
<body>
  <canvas id="canvas" width="800" height="600"></canvas>
  <div id="overlay-console">⚡ Game script running: ${file.name}</div>
  <script>
    const _origLog = console.log;
    console.log = function(...args) { _origLog.apply(console, args); const c = document.getElementById('overlay-console'); if (c) c.innerText = '> ' + args.join(' '); };
  </script>
  <script>
    try { ${content} } catch(err) { document.getElementById('overlay-console').style.color = '#ff4757'; document.getElementById('overlay-console').innerText = 'Execution Error: ' + err.message; console.error(err); }
  </script>
</body>
</html>`;
        }

        const newId = `tab-file-${Date.now()}`;
        const newTab: CanvasTab = {
          id: newId,
          title: `📄 ${file.name}`,
          type: 'code_sandbox',
          url: '',
          codeContent: content,
          renderedSrcDoc: content,
          templateKey: 'custom',
          history: [''],
          historyIndex: 0,
          viewTab: 'render',
          key: Date.now(),
          icon: '📄',
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newId);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const toggleFullscreen = () => {
    if (!isFullscreen) {
      setIsFullscreen(true);
      const elem = previewFrameRef.current;
      if (elem && elem.requestFullscreen) elem.requestFullscreen().catch(() => {});
    } else {
      setIsFullscreen(false);
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    }
  };

  const getViewportDimensions = () => {
    switch (viewportPreset) {
      case 'fhd':
        return { width: '1920px', height: '1080px' };
      case 'laptop':
        return { width: '1024px', height: '768px' };
      case 'tablet_v':
        return { width: '768px', height: '1024px' };
      case 'mobile':
        return { width: '375px', height: '667px' };
      case 'full':
      default:
        return { width: '100%', height: '100%' };
    }
  };

  const dimensions = getViewportDimensions();

  const handleAddNode = (type: 'tool' | 'llm' | 'gate' | 'verify') => {
    const newId = `node-${Date.now()}`;
    const titles = {
      tool: 'Shell / Test Runner',
      llm: 'Architect Reasoning Plan',
      gate: 'Human Approval Gate',
      verify: '40-Run Verification Loop',
    };

    const newNode: WorkflowStepNode = {
      id: newId,
      name: titles[type],
      type,
      x: 100 + (workflowNodes.length % 5) * 60,
      y: 120 + (workflowNodes.length % 4) * 45,
      tool: type === 'tool' ? 'run_tests' : undefined,
      // Left empty on purpose: the placeholder asks what the step should do,
      // which is a prompt to write. Canned filler has to be deleted first and
      // reads as finished when it is not.
      desc: '',
    };
    setWorkflowNodes((prev) => [...prev, newNode]);
  };

  /**
   * Rewrite what a step is and what it does.
   *
   * The graph is where a pipeline is authored, so the node text has to be
   * typeable here. It used to be read-only `div`s filled from a canned title
   * and description per node type, which meant every pipeline said the same
   * four things no matter what it was actually for.
   */
  const updateWorkflowNode = (id: string, patch: Partial<WorkflowStepNode>) => {
    setWorkflowNodes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  };

  const handleDeleteNode = (id: string) => {
    setWorkflowNodes((prev) => prev.filter((n) => n.id !== id));
    setWorkflowEdges((prev) => prev.filter((e) => e.from !== id && e.to !== id));
  };

  const handleDeleteEdge = (from: string, to: string) => {
    setWorkflowEdges((prev) => prev.filter((e) => !(e.from === from && e.to === to)));
  };

  // Accepts a mouse event too: the port supports both drag-to-connect
  // (pointerdown) and click-to-connect, and only clientX/clientY are read.
  const handleStartConnecting = (e: React.PointerEvent | React.MouseEvent, sourceId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setConnectingFrom(sourceId);
    isPointerDownConnecting.current = true;

    if (stageAreaRef.current) {
      const rect = stageAreaRef.current.getBoundingClientRect();
      setConnectingWirePos({
        x: e.clientX - rect.left + stageAreaRef.current.scrollLeft,
        y: e.clientY - rect.top + stageAreaRef.current.scrollTop,
      });
    }
  };

  const handleConnectToNode = (targetId: string) => {
    if (connectingFrom && connectingFrom !== targetId) {
      const exists = workflowEdges.some((e) => e.from === connectingFrom && e.to === targetId);
      if (!exists) {
        setWorkflowEdges((prev) => [...prev, { from: connectingFrom, to: targetId }]);
      }
    }
    setConnectingFrom(null);
    setConnectingWirePos(null);
    setHoverTargetNodeId(null);
    isPointerDownConnecting.current = false;
  };

  const handleWorkflowPointerMove = (e: React.PointerEvent) => {
    if (connectingFrom && stageAreaRef.current) {
      const rect = stageAreaRef.current.getBoundingClientRect();
      setConnectingWirePos({
        x: e.clientX - rect.left + stageAreaRef.current.scrollLeft,
        y: e.clientY - rect.top + stageAreaRef.current.scrollTop,
      });
    }

    if (dragWorkflowNode && stageAreaRef.current) {
      const dx = e.clientX - dragWorkflowNode.cx;
      const dy = e.clientY - dragWorkflowNode.cy;
      setWorkflowNodes((prev) =>
        prev.map((n) =>
          n.id === dragWorkflowNode.id
            ? {
                ...n,
                x: Math.max(20, dragWorkflowNode.x0 + dx),
                y: Math.max(20, dragWorkflowNode.y0 + dy),
              }
            : n
        )
      );
    }
  };

  const handleWorkflowPointerUp = () => {
    if (dragWorkflowNode) {
      setDragWorkflowNode(null);
    }
    if (isPointerDownConnecting.current && connectingFrom) {
      if (hoverTargetNodeId && hoverTargetNodeId !== connectingFrom) {
        handleConnectToNode(hoverTargetNodeId);
      } else {
        setConnectingFrom(null);
        setConnectingWirePos(null);
        setHoverTargetNodeId(null);
      }
      isPointerDownConnecting.current = false;
    }
  };

  /** The task a save or a run creates from the current graph. */
  const workflowTaskPayload = () => ({
    title: workflowTaskTitle.trim() || 'Pipeline from Canvas',
    notes: workflowTaskNotes.trim(),
    // The tools the graph actually calls, de-duplicated — the task should
    // carry the permissions the pipeline needs and nothing wider.
    tools: Array.from(
      new Set(workflowNodes.map((n) => n.tool).filter((t): t is string => Boolean(t)))
    ),
    gated: workflowNodes.some((n) => n.type === 'gate'),
    workflow: { nodes: workflowNodes, edges: workflowEdges },
  });

  const handleSaveWorkflowModal = () => {
    onSaveWorkflowToPreparation?.(workflowTaskPayload());
    setSaveModalOpen(false);
  };

  const handleRunWorkflow = () => {
    onRunWorkflow?.(workflowTaskPayload());
    setSaveModalOpen(false);
  };

  // ── Sticky notes ──────────────────────────────────────────────────────────
  const handleAddStickyNote = (tone: NoteItem['tone']) => {
    setNotes((prev) => [
      ...prev,
      {
        id: `n-${Date.now().toString(36)}`,
        // Stagger new notes so consecutive additions do not stack invisibly.
        x: 40 + (prev.length % 5) * 40,
        y: 40 + (prev.length % 4) * 36,
        w: 260,
        label: 'Note',
        tone,
        text: '',
      },
    ]);
  };

  const handleUpdateNote = (id: string, patch: Partial<NoteItem>) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  };

  const handleDeleteNote = (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  };

  const handleNoteDown = (e: React.PointerEvent, note: NoteItem) => {
    // Let the note's own controls work; only the card body starts a drag.
    const el = e.target as HTMLElement;
    if (el.closest('input, textarea, button')) return;
    setDragNote({ id: note.id, cx: e.clientX, cy: e.clientY, x0: note.x, y0: note.y });
  };

  const handleBoardPointerMove = (e: React.PointerEvent) => {
    if (!dragNote) return;
    const dx = e.clientX - dragNote.cx;
    const dy = e.clientY - dragNote.cy;
    setNotes((prev) =>
      prev.map((n) =>
        n.id === dragNote.id
          ? { ...n, x: Math.max(0, dragNote.x0 + dx), y: Math.max(0, dragNote.y0 + dy) }
          : n
      )
    );
  };

  const handleBoardPointerUp = () => {
    if (dragNote) setDragNote(null);
  };

  const handleWorkflowNodeDown = (e: React.PointerEvent, node: WorkflowStepNode) => {
    if ((e.target as HTMLElement).classList.contains('node-port')) return;
    if ((e.target as HTMLElement).classList.contains('wf-node-del-btn')) return;
    // A pointerdown on a field is someone placing a caret, not starting a
    // drag. Without this the card moves as you click into it and the text is
    // never focusable.
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;

    setDragWorkflowNode({
      id: node.id,
      x0: node.x,
      y0: node.y,
      cx: e.clientX,
      cy: e.clientY,
    });
  };

  return (
    <div className="canvas-root">
      <div className="canvas-mode-bar">
        <div className="canvas-mode-pills">
          {(['preview', 'graph', 'board', 'diff'] as CanvasMode[]).map((mKey) => (
            <button
              key={mKey}
              type="button"
              className={`mode-pill ${mode === mKey ? 'active' : ''}`}
              onClick={() => setMode(mKey)}
            >
              {mKey === 'preview' && '🎮 Web and Game Preview'}
              {mKey === 'graph' && '⚡ Workflow DAG'}
              {mKey === 'board' && '📌 Sticky Board'}
              {mKey === 'diff' && '📄 Code Diff'}
            </button>
          ))}
        </div>
        <div className="canvas-hint">
          {mode === 'preview' && 'Chrome-style multi-tab workspace · Run external sites, games, dev servers & sandbox with live framing bypass'}
          {mode === 'graph' && 'Visual workflow pipeline DAG builder — connect nodes, tools & gates, then save to Kanban preparation'}
          {mode === 'board' && 'pinned artifacts & freeform notes'}
          {mode === 'diff' && 'before / after, same file'}
        </div>
      </div>

      <div className="canvas-body">
        {mode === 'preview' && (
          <div className={`canvas-preview-workspace ${isFullscreen ? 'is-fullscreen-mode' : ''}`}>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept=".html,.htm,.js,.jsx,.ts,.tsx,.json,.kt,.css,.txt"
              onChange={handleFileUpload}
            />

            <div className="browser-tab-strip">
              <div className="browser-tab-list">
                {tabs.map((tab) => {
                  const isActive = tab.id === activeTabId;
                  return (
                    <div
                      key={tab.id}
                      className={`browser-tab-item ${isActive ? 'active' : ''}`}
                      onClick={() => setActiveTabId(tab.id)}
                      title={tab.url || tab.title}
                    >
                      <span className="tab-icon">{tab.icon || (tab.type === 'code_sandbox' ? '🎮' : '🌐')}</span>
                      <span className="tab-title-text">{tab.title}</span>
                      <button
                        type="button"
                        className="btn-tab-close"
                        title="Close Tab (Ctrl+W)"
                        onClick={(e) => handleCloseTab(tab.id, e)}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}

                <button
                  type="button"
                  className="btn-tab-new"
                  title="Open New Tab"
                  onClick={() => handleCreateTab('web_url', 'https://www.youtube.com', '🌐 YouTube / Web')}
                >
                  +
                </button>
              </div>

              <div className="tab-strip-actions-right">
                <div className="viewport-controls">
                  <span className="ctrl-group-label">Size:</span>
                  <button
                    type="button"
                    className={`btn-viewport ${viewportPreset === 'full' ? 'active' : ''}`}
                    onClick={() => setViewportPreset('full')}
                    title="Auto Full Width"
                  >
                    Auto
                  </button>
                  <button
                    type="button"
                    className={`btn-viewport ${viewportPreset === 'fhd' ? 'active' : ''}`}
                    onClick={() => setViewportPreset('fhd')}
                    title="1920 × 1080 Full HD"
                  >
                    1080p
                  </button>
                  <button
                    type="button"
                    className={`btn-viewport ${viewportPreset === 'laptop' ? 'active' : ''}`}
                    onClick={() => setViewportPreset('laptop')}
                    title="1024 × 768 Laptop"
                  >
                    Laptop
                  </button>
                  <button
                    type="button"
                    className={`btn-viewport ${viewportPreset === 'tablet_v' ? 'active' : ''}`}
                    onClick={() => setViewportPreset('tablet_v')}
                    title="768 × 1024 Tablet"
                  >
                    Tablet
                  </button>
                  <button
                    type="button"
                    className={`btn-viewport ${viewportPreset === 'mobile' ? 'active' : ''}`}
                    onClick={() => setViewportPreset('mobile')}
                    title="375 × 667 Mobile"
                  >
                    Mobile
                  </button>
                </div>

                <button
                  type="button"
                  className={`btn-fullscreen-toggle ${isFullscreen ? 'active' : ''}`}
                  onClick={toggleFullscreen}
                  title="Toggle Fullscreen Mode (⛶)"
                >
                  {isFullscreen ? '✕ Exit Fullscreen' : '⛶ Fullscreen'}
                </button>
              </div>
            </div>

            <div className="browser-nav-bar">
              <div className="browser-nav-buttons">
                <button
                  type="button"
                  className="btn-nav-action"
                  onClick={() => handleNavigate('back')}
                  disabled={activeTab.historyIndex <= 0}
                  title="Back"
                >
                  ◀
                </button>
                <button
                  type="button"
                  className="btn-nav-action"
                  onClick={() => handleNavigate('forward')}
                  disabled={activeTab.historyIndex >= activeTab.history.length - 1}
                  title="Forward"
                >
                  ▶
                </button>
                <button
                  type="button"
                  className="btn-nav-action"
                  onClick={() => handleNavigate('reload')}
                  title="Reload Active Tab"
                >
                  ⟳
                </button>
              </div>

              <div className="tab-mode-pills">
                <button
                  type="button"
                  className={`btn-mode-pill ${activeTab.type === 'web_url' ? 'active' : ''}`}
                  onClick={() => {
                    setTabs((prev) =>
                      prev.map((t) =>
                        t.id === activeTab.id
                          ? {
                              ...t,
                              type: 'web_url',
                              url: t.url || 'https://www.youtube.com',
                              title: t.title.startsWith('🌐') ? t.title : '🌐 Web Browser',
                              icon: '🌐',
                            }
                          : t
                      )
                    );
                    if (!activeTab.url) setAddressInput('https://www.youtube.com');
                  }}
                >
                  🌐 Web / Proxy
                </button>
                <button
                  type="button"
                  className={`btn-mode-pill ${activeTab.type === 'code_sandbox' ? 'active' : ''}`}
                  onClick={() => {
                    setTabs((prev) =>
                      prev.map((t) =>
                        t.id === activeTab.id
                          ? {
                              ...t,
                              type: 'code_sandbox',
                              title: t.title.startsWith('🎮') || t.title.startsWith('📄') ? t.title : '🎮 Code Sandbox',
                              icon: '🎮',
                            }
                          : t
                      )
                    );
                  }}
                >
                  ⚡ Sandbox Engine
                </button>
              </div>

              {activeTab.type === 'web_url' ? (
                <div className="browser-address-wrap">
                  <span className="address-security-icon">🔒</span>
                  <input
                    type="text"
                    className="browser-address-input"
                    value={addressInput}
                    onChange={(e) => setAddressInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleGoToUrl();
                    }}
                    placeholder="https://www.youtube.com, https://en.wikipedia.org, http://localhost:5173..."
                  />
                  <button
                    type="button"
                    className="btn-address-go"
                    onClick={handleGoToUrl}
                  >
                    Go ➔
                  </button>
                  <button
                    type="button"
                    className="btn-add-file-action"
                    onClick={() => fileInputRef.current?.click()}
                    title="Open a local file in sandbox"
                  >
                    📁 Add File
                  </button>
                </div>
              ) : (
                <div className="sandbox-template-bar">
                  <div className="view-tab-pills">
                    <button
                      type="button"
                      className={`btn-view-tab ${activeTab.viewTab === 'render' ? 'active' : ''}`}
                      onClick={() => {
                        setTabs((prev) =>
                          prev.map((t) => (t.id === activeTab.id ? { ...t, viewTab: 'render' } : t))
                        );
                      }}
                    >
                      ▶ Live Viewport
                    </button>
                    <button
                      type="button"
                      className={`btn-view-tab ${activeTab.viewTab === 'code' ? 'active' : ''}`}
                      onClick={() => {
                        setTabs((prev) =>
                          prev.map((t) => (t.id === activeTab.id ? { ...t, viewTab: 'code' } : t))
                        );
                      }}
                    >
                      ✏️ Edit Code
                    </button>
                  </div>

                  <button
                    type="button"
                    className="btn-new-instance-action"
                    onClick={handleNewInstance}
                    title="Initialize fresh canvas & game engine instance"
                  >
                    ➕ New Instance
                  </button>
                  <button
                    type="button"
                    className="btn-add-file-action"
                    onClick={() => fileInputRef.current?.click()}
                    title="Open and run any local game, HTML, Kotlin, or JS script"
                  >
                    📁 Add File
                  </button>
                  <span className="template-label" style={{ marginLeft: '4px' }}>Templates:</span>
                  {Object.entries(TEMPLATES).map(([key, item]) => (
                    <button
                      key={key}
                      type="button"
                      className={`btn-template-chip ${activeTab.templateKey === key ? 'active' : ''}`}
                      onClick={() => handleSelectTemplate(key)}
                    >
                      {item.name}
                    </button>
                  ))}
                  <div className="spacer" />
                  <button
                    type="button"
                    className="btn-hot-reload"
                    onClick={() => {
                      setTabs((prev) =>
                        prev.map((t) =>
                          t.id === activeTab.id
                            ? { ...t, renderedSrcDoc: t.codeContent, viewTab: 'render', key: t.key + 1 }
                            : t
                        )
                      );
                    }}
                  >
                    ⚡ Hot-Reload
                  </button>
                </div>
              )}
            </div>

            <div className="preview-stage-container">
              <div
                ref={previewFrameRef}
                className={`preview-dimension-box ${isFullscreen ? 'fullscreen-frame' : ''}`}
                style={{
                  width: dimensions.width,
                  height: dimensions.height,
                  maxWidth: isFullscreen ? '100vw' : '100%',
                  maxHeight: isFullscreen ? '100vh' : '100%',
                }}
              >
                <div className="dimension-box-header">
                  <div className="window-dots">
                    <span className="dot dot-err" />
                    <span className="dot dot-warn" />
                    <span className="dot dot-ok" />
                  </div>
                  <div className="window-dimension-tag">
                    {viewportPreset === 'full' ? 'Auto Width (100%)' : `${dimensions.width} × ${dimensions.height}`}
                    {activeTab.type === 'code_sandbox' ? ' · Sandbox Engine' : ` · ${activeTab.url || 'Web View'}`}
                  </div>
                  <div className="window-actions-right">
                    <button
                      type="button"
                      className="btn-refresh-preview"
                      title="Reload Viewport"
                      onClick={() => handleNavigate('reload')}
                    >
                      ⟳ Reload
                    </button>
                  </div>
                </div>

                <div className="dimension-box-body">
                  {tabs.map((tab) => {
                    const isActive = tab.id === activeTabId;
                    return (
                      <div
                        key={tab.id}
                        className="tab-content-frame"
                        style={{
                          display: isActive ? 'flex' : 'none',
                          flexDirection: 'column',
                          width: '100%',
                          height: '100%',
                          flex: 1,
                          minHeight: 0,
                          overflow: 'hidden',
                        }}
                      >
                        {tab.type === 'code_sandbox' ? (
                          tab.viewTab === 'render' ? (
                            <iframe
                              key={tab.key}
                              srcDoc={tab.renderedSrcDoc}
                              title={tab.title}
                              className="live-sandbox-iframe"
                              sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
                            />
                          ) : (
                            <div className="code-editor-pane">
                              <div className="code-editor-header">
                                <span>HTML / CSS / JS / Kotlin Sandbox Source Code</span>
                                <button
                                  type="button"
                                  className="btn-editor-run"
                                  onClick={() => {
                                    setTabs((prev) =>
                                      prev.map((t) =>
                                        t.id === tab.id
                                          ? { ...t, renderedSrcDoc: t.codeContent, viewTab: 'render', key: t.key + 1 }
                                          : t
                                      )
                                    );
                                  }}
                                >
                                  ▶ Apply & Run Code (Hot Reload)
                                </button>
                              </div>
                              <textarea
                                className="code-editor-textarea"
                                value={tab.codeContent}
                                onChange={(e) => {
                                  const newCode = e.target.value;
                                  setTabs((prev) =>
                                    prev.map((t) => (t.id === tab.id ? { ...t, codeContent: newCode } : t))
                                  );
                                }}
                                placeholder="Paste or write your HTML, Canvas game script, or web app code here..."
                              />
                            </div>
                          )
                        ) : (
                          <iframe
                            key={tab.key}
                            src={getProxiedPreviewUrl(tab.url)}
                            title={tab.title}
                            className="live-sandbox-iframe"
                            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-presentation allow-downloads"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                            allowFullScreen
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── WORKFLOW GRAPH (n8n style) ─────────────────────────────────── */}
        {mode === 'graph' && (
          <div
            className="workflow-builder-container"
            onPointerMove={handleWorkflowPointerMove}
            onPointerUp={handleWorkflowPointerUp}
          >
            {/* Toolbar */}
            <div className="workflow-toolbar">
              <div className="workflow-node-palette">
                <span className="palette-label">+ Add Node:</span>
                <button
                  type="button"
                  className="btn-palette-node node-tool"
                  onClick={() => handleAddNode('tool')}
                >
                  ⚡ Tool Action
                </button>
                <button
                  type="button"
                  className="btn-palette-node node-llm"
                  onClick={() => handleAddNode('llm')}
                >
                  🧠 LLM Reasoning
                </button>
                <button
                  type="button"
                  className="btn-palette-node node-gate"
                  onClick={() => handleAddNode('gate')}
                >
                  ⚠️ Approval Gate
                </button>
                <button
                  type="button"
                  className="btn-palette-node node-verify"
                  onClick={() => handleAddNode('verify')}
                >
                  🧪 Verify Step
                </button>
              </div>

              <div className="workflow-actions-right">
                {connectingFrom && (
                  <div className="connecting-badge">
                    <span>Click or drag to any target node to connect</span>
                    <button
                      type="button"
                      className="btn-cancel-conn"
                      onClick={() => setConnectingFrom(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="btn-save-workflow-kanban"
                  onClick={() => setSaveModalOpen(true)}
                >
                  💾 Save to Kanban (Preparation)
                </button>
                <button
                  type="button"
                  className="btn-run-workflow-kanban"
                  // Disabled on an empty graph: there would be nothing to run,
                  // and it would create a task that does nothing.
                  disabled={workflowNodes.length === 0}
                  title={workflowNodes.length === 0
                    ? 'Add at least one step first'
                    : 'Save the pipeline and start it — it moves to Execution'}
                  onClick={handleRunWorkflow}
                >
                  ▶ Run Pipeline
                </button>
              </div>
            </div>

            {/* Interactive SVG Canvas */}
            <div
              ref={stageAreaRef}
              className={`workflow-stage-area ${connectingFrom ? 'is-connecting-mode' : ''}`}
            >
              <svg className="workflow-svg-edges">
                {/* Render Existing Connected Edges */}
                {workflowEdges.map((e, idx) => {
                  const fromNode = workflowNodes.find((n) => n.id === e.from);
                  const toNode = workflowNodes.find((n) => n.id === e.to);
                  if (!fromNode || !toNode) return null;

                  const x1 = fromNode.x + 220;
                  const y1 = fromNode.y + 40;
                  const x2 = toNode.x;
                  const y2 = toNode.y + 40;
                  const dx = Math.max(30, Math.min(180, Math.abs(x2 - x1) * 0.5));
                  const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
                  const midX = (x1 + x2) / 2;
                  const midY = (y1 + y2) / 2;

                  return (
                    <g key={`${e.from}-${e.to}-${idx}`} className="workflow-edge-group">
                      <path
                        d={pathD}
                        fill="none"
                        stroke="var(--acc2)"
                        strokeWidth="2.5"
                        className="workflow-edge-line"
                      />
                      <circle
                        cx={midX}
                        cy={midY}
                        r="6.5"
                        fill="var(--acc)"
                        className="workflow-edge-mid-handle"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handleDeleteEdge(e.from, e.to);
                        }}
                        onDoubleClick={(ev) => {
                          ev.stopPropagation();
                          ev.preventDefault();
                          handleDeleteEdge(e.from, e.to);
                        }}
                      />
                    </g>
                  );
                })}

                {/* Render Live Dragging Connection Wire */}
                {connectingFrom && connectingWirePos && (() => {
                  const fromNode = workflowNodes.find((n) => n.id === connectingFrom);
                  if (!fromNode) return null;
                  const x1 = fromNode.x + 220;
                  const y1 = fromNode.y + 40;
                  let x2 = connectingWirePos.x;
                  let y2 = connectingWirePos.y;

                  if (hoverTargetNodeId) {
                    const targetNode = workflowNodes.find((n) => n.id === hoverTargetNodeId);
                    if (targetNode) {
                      x2 = targetNode.x;
                      y2 = targetNode.y + 40;
                    }
                  }

                  const dx = Math.max(30, Math.min(180, Math.abs(x2 - x1) * 0.5));
                  const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

                  return (
                    <g className="workflow-drag-wire-group">
                      <path
                        d={pathD}
                        fill="none"
                        stroke="#ffd166"
                        strokeWidth="3"
                        strokeDasharray="6 4"
                        className="workflow-drag-wire"
                      />
                      <circle cx={x2} cy={y2} r="7" fill="#ffd166" className="workflow-drag-wire-head" />
                    </g>
                  );
                })()}
              </svg>

              {/* Render Workflow Nodes */}
              {workflowNodes.map((node) => {
                const isTool = node.type === 'tool';
                const isGate = node.type === 'gate';
                const isVerify = node.type === 'verify';
                const isLlm = node.type === 'llm';
                const isConnectingSource = connectingFrom === node.id;
                const isHoverTarget = hoverTargetNodeId === node.id;

                const nodeTypeClass = isGate
                  ? 'node-type-gate'
                  : isVerify
                  ? 'node-type-verify'
                  : isTool
                  ? 'node-type-tool'
                  : 'node-type-llm';

                return (
                  <div
                    key={node.id}
                    className={`workflow-node-box ${nodeTypeClass} ${isConnectingSource ? 'is-connecting-source' : ''} ${isHoverTarget ? 'is-hover-target' : ''}`}
                    style={{ left: `${node.x}px`, top: `${node.y}px` }}
                    onPointerDown={(e) => handleWorkflowNodeDown(e, node)}
                    onPointerEnter={() => {
                      if (connectingFrom && connectingFrom !== node.id) {
                        setHoverTargetNodeId(node.id);
                      }
                    }}
                    onPointerLeave={() => {
                      if (hoverTargetNodeId === node.id) {
                        setHoverTargetNodeId(null);
                      }
                    }}
                    onPointerUp={(e) => {
                      if (connectingFrom && connectingFrom !== node.id) {
                        e.stopPropagation();
                        handleConnectToNode(node.id);
                      }
                    }}
                    onClick={(e) => {
                      if (connectingFrom && connectingFrom !== node.id) {
                        e.stopPropagation();
                        handleConnectToNode(node.id);
                      }
                    }}
                  >
                    {/* Input Port (Target Circle: Click/Drag to connect · Double-Click to break node) */}
                    <button
                      type="button"
                      className={`node-port port-input ${isHoverTarget ? 'target-active' : ''}`}
                      title={connectingFrom ? 'Click or release to connect' : 'Input port · Double-click to break node connections'}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (connectingFrom) {
                          handleConnectToNode(node.id);
                        }
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setWorkflowEdges((prev) => prev.filter((ed) => ed.from !== node.id && ed.to !== node.id));
                      }}
                    />

                    {/* Node Header */}
                    <div className="wf-node-head">
                      <div className="wf-node-type-badge">
                        {isGate && '⚠️ Gate'}
                        {isVerify && '🧪 Verify'}
                        {isTool && `⚡ ${node.tool || 'Tool'}`}
                        {isLlm && '🧠 LLM Reasoning'}
                      </div>
                      <button
                        type="button"
                        className="wf-node-del-btn"
                        title="Delete node"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteNode(node.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>

                    <input
                      className="wf-node-title-input"
                      value={node.name}
                      onChange={(e) => updateWorkflowNode(node.id, { name: e.target.value })}
                      placeholder="Step name"
                      aria-label="Step name"
                      spellCheck={false}
                    />
                    <textarea
                      className="wf-node-desc-input"
                      value={node.desc || ''}
                      onChange={(e) => updateWorkflowNode(node.id, { desc: e.target.value })}
                      placeholder="What should this step do?"
                      aria-label="Step instructions"
                      rows={3}
                    />
                    {isTool && (
                      <input
                        className="wf-node-tool-input"
                        value={node.tool || ''}
                        onChange={(e) => updateWorkflowNode(node.id, { tool: e.target.value })}
                        placeholder="tool, e.g. run_tests"
                        aria-label="Tool this step calls"
                        spellCheck={false}
                      />
                    )}

                    {/* Output Port (Source Circle: Supports Click & Drag-Hold · Double-Click to break node) */}
                    <button
                      type="button"
                      className={`node-port port-output ${isConnectingSource ? 'connecting' : ''}`}
                      title="Click or drag to connect · Double-click to break node connections"
                      onPointerDown={(e) => handleStartConnecting(e, node.id)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!connectingFrom) {
                          handleStartConnecting(e, node.id);
                        } else if (connectingFrom === node.id) {
                          setConnectingFrom(null);
                        }
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setWorkflowEdges((prev) => prev.filter((ed) => ed.from !== node.id && ed.to !== node.id));
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── STICKY BOARD ────────────────────────────────────────────────── */}
        {mode === 'board' && (
          <div
            className="canvas-board-fullscreen-wrap"
            onPointerMove={handleBoardPointerMove}
            onPointerUp={handleBoardPointerUp}
          >
            {/* Background Watermark Sign */}
            <img
              src="/app.webp"
              alt="Aura watermark"
              className="aura-bg-watermark sticky-board-watermark"
            />

            {/* Top Action Bar for Sticky Board */}
            <div className="sticky-board-toolbar">
              <div className="sticky-toolbar-left">
                <span className="sticky-toolbar-title">📌 Infinite Sticky Board & Note Space</span>
                <span className="sticky-toolbar-sub">Click & drag notes freely · Leave architecture thoughts · Convert notes to Kanban tasks</span>
              </div>
              <div className="sticky-toolbar-actions">
                <button
                  type="button"
                  className="btn-add-sticky-note"
                  onClick={() => handleAddStickyNote('accent')}
                >
                  <span>+</span> Add Sticky Note
                </button>
                <button
                  type="button"
                  className="btn-add-sticky-note note-tone-ok-btn"
                  onClick={() => handleAddStickyNote('ok')}
                >
                  <span>📗</span> Green
                </button>
                <button
                  type="button"
                  className="btn-add-sticky-note note-tone-warn-btn"
                  onClick={() => handleAddStickyNote('warn')}
                >
                  <span>📙</span> Amber
                </button>
              </div>
            </div>

            {/* Infinite Canvas with Sticky Notes */}
            <div className="sticky-board-stage">
              {notes.map((nt) => {
                const toneClass = `note-tone-${nt.tone}`;
                return (
                  <div
                    key={nt.id}
                    className={`canvas-note ${toneClass}`}
                    style={{ left: `${nt.x}px`, top: `${nt.y}px`, width: `${nt.w || 280}px` }}
                    onPointerDown={(e) => handleNoteDown(e, nt)}
                  >
                    <div className="note-card-header">
                      <input
                        type="text"
                        className="note-label-input"
                        value={nt.label}
                        onChange={(e) => handleUpdateNote(nt.id, { label: e.target.value })}
                        placeholder="Note Title..."
                        onPointerDown={(e) => e.stopPropagation()}
                      />
                      <button
                        type="button"
                        className="note-del-btn"
                        title="Delete note"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteNote(nt.id);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    <textarea
                      className="note-textarea"
                      value={nt.text}
                      rows={4}
                      onChange={(e) => handleUpdateNote(nt.id, { text: e.target.value })}
                      placeholder="Write thoughts, bug analysis, design notes..."
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                    <div className="note-card-footer">
                      <div className="note-tone-pills">
                        {(['accent', 'ok', 'warn', 'plain'] as Array<'accent' | 'ok' | 'warn' | 'plain'>).map((t) => (
                          <button
                            key={t}
                            type="button"
                            className={`note-tone-dot dot-${t} ${nt.tone === t ? 'active' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUpdateNote(nt.id, { tone: t });
                            }}
                            title={`Color: ${t}`}
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        className="btn-create-task-from-note"
                        title="Convert note into a task on the Kanban board"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onCreateTaskFromNote) {
                            onCreateTaskFromNote({
                              title: nt.label || 'Note Task',
                              text: nt.text,
                            });
                          }
                        }}
                      >
                        ⚡ Create Task
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── CODE DIFF ───────────────────────────────────────────────────── */}
        {mode === 'diff' && (
          <div className="canvas-diff-wrap">
            {DEFAULT_ARTIFACTS.map((a, i) => (
              <div key={i} className="diff-artifact-card">
                <div className="diff-artifact-head">
                  <span className="diff-artifact-tag" style={{ color: a.tagColor }}>{a.tag}</span>
                  <span className="diff-artifact-meta">{a.meta}</span>
                </div>
                <div className="diff-artifact-body">
                  {a.lines.map((l, j) => {
                    const bg = l.kind === 'add' ? 'rgba(90,158,110,0.14)' : l.kind === 'del' ? 'rgba(177,84,57,0.14)' : 'transparent';
                    const fg = l.kind === 'ctx' ? 'var(--mut)' : 'var(--ink)';
                    return (
                      <div key={j} className="diff-code-line" style={{ background: bg, color: fg }}>
                        {l.text || '\u00A0'}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save Workflow to Kanban Modal */}
      {saveModalOpen && (
        <div className="modal-backdrop nes-backdrop" onClick={() => setSaveModalOpen(false)}>
          <div
            className="modal-card nes-modal-box kanban-create-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="nes-cartridge-strip">
              <span className="nes-strip-chip">WORKFLOW-SAVE-01</span>
              <span className="nes-strip-title">★ DEPLOY PIPELINE TO KANBAN PREPARATION ★</span>
              <span className="nes-strip-led" />
            </div>

            <div className="nes-header">
              <div className="nes-header-left">
                <div className="nes-badge-stage">PIPELINE TO TASK</div>
                <h2 className="nes-mission-title">Save Graph to Kanban Preparation</h2>
              </div>
              <button
                type="button"
                className="nes-btn-close"
                onClick={() => setSaveModalOpen(false)}
              >
                ✕ [ESC]
              </button>
            </div>

            <div className="nes-content-body">
              <div className="form-field-group">
                <label className="form-label">Task Title</label>
                <input
                  type="text"
                  className="form-input-text"
                  value={workflowTaskTitle}
                  onChange={(e) => setWorkflowTaskTitle(e.target.value)}
                />
              </div>

              <div className="form-field-group" style={{ marginTop: '12px' }}>
                <label className="form-label">Task Notes & Pipeline Summary</label>
                <textarea
                  className="form-textarea"
                  rows={3}
                  value={workflowTaskNotes}
                  onChange={(e) => setWorkflowTaskNotes(e.target.value)}
                />
              </div>

              <div className="nes-actions-bar" style={{ marginTop: '16px' }}>
                <button
                  type="button"
                  className="nes-arcade-btn btn-nes-b"
                  onClick={() => setSaveModalOpen(false)}
                >
                  <span className="nes-btn-badge">[ B ]</span> Cancel
                </button>
                <button
                  type="button"
                  className="nes-arcade-btn btn-nes-a"
                  onClick={handleSaveWorkflowModal}
                >
                  <span className="nes-btn-badge">[ A ]</span> Save to Kanban (Preparation)
                </button>
                <button
                  type="button"
                  className="nes-arcade-btn btn-nes-run"
                  disabled={workflowNodes.length === 0}
                  onClick={handleRunWorkflow}
                >
                  <span className="nes-btn-badge">[ R ]</span> Save &amp; Run Now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
