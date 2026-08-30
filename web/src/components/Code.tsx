import { useState, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getAuthToken } from '../lib/auth';

interface TreeItem {
  name: string;
  type: 'folder' | 'file';
  depth: number;
  badge?: string;
  badgeColor?: string;
  path: string;
}

interface CodeLine {
  n: string;
  mark: string;
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

const DEFAULT_TREE: TreeItem[] = [
  { name: 'src', type: 'folder', depth: 0, path: 'src' },
  { name: 'agent', type: 'folder', depth: 1, path: 'src/agent' },
  { name: 'loop.ts', type: 'file', depth: 2, badge: 'M', badgeColor: 'var(--warn)', path: 'src/agent/loop.ts' },
  { name: 'clock.ts', type: 'file', depth: 2, badge: 'A', badgeColor: 'var(--ok)', path: 'src/agent/clock.ts' },
  { name: 'scheduler.ts', type: 'file', depth: 2, path: 'src/agent/scheduler.ts' },
  { name: 'server', type: 'folder', depth: 1, path: 'src/server' },
  { name: 'index.ts', type: 'file', depth: 2, badge: 'M', badgeColor: 'var(--ok)', path: 'src/server/index.ts' },
  { name: 'sidecar', type: 'folder', depth: 1, path: 'src/sidecar' },
  { name: 'ws.ts', type: 'file', depth: 2, badge: 'M', badgeColor: 'var(--warn)', path: 'src/sidecar/ws.ts' },
  { name: 'tests', type: 'folder', depth: 0, path: 'tests' },
  { name: 'tools.test.ts', type: 'file', depth: 1, badge: '✓', badgeColor: 'var(--ok)', path: 'tests/tools.test.ts' },
  { name: 'board', type: 'folder', depth: 1, path: 'tests/board' },
  { name: 'store.test.ts', type: 'file', depth: 2, badge: '✓', badgeColor: 'var(--ok)', path: 'tests/board/store.test.ts' },
];

const INITIAL_FILE_CONTENTS: Record<string, string> = {
  'src/agent/loop.ts': `import { createProvider } from '../providers/factory.js';
import { ProjectContext } from './context.js';
import { Clock } from './clock.js';
import { Step, StepResult } from '../protocol/types.js';

export class AgentExecutionLoop {
  private clock: Clock;
  private tools: any;
  private log: any;

  constructor(private opts: { retryBudgetMs: number; seed?: number }) {
    this.clock = new Clock(opts.seed ?? Date.now());
  }

  private async attempt(step: Step, n: number): Promise<StepResult> {
    const budget = this.opts.retryBudgetMs;
    const startedAt = this.clock.now();
    const delay = backoff(n, this.clock.seed);

    if (delay > budget) {
      throw new Error(\`Retry budget of \${budget}ms exceeded for step \${step.id}\`);
    }

    await this.clock.sleep(delay);
    const result = await this.tools.run(step);

    this.log.tool(step.tool, {
      ms: this.clock.now() - startedAt,
      attempt: n,
    });

    return result;
  }
}

function backoff(attempt: number, seed = 1): number {
  return Math.min(1000 * Math.pow(2, attempt) + (seed % 100), 10000);
}
`,
  'src/server/index.ts': `import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';

// Aura server index - Node-pty pseudoterminal streaming backend
`,
  'src/sidecar/ws.ts': `import { WebSocketServer, WebSocket } from 'ws';

export function attachSidecar(port: number) {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'ready', timestamp: Date.now() }));
  });
  return wss;
}
`,
  'tests/tools.test.ts': `import { describe, it, expect } from 'vitest';

describe('Aura Tools Suite', () => {
  it('executes tool runner correctly', () => {
    expect(true).toBe(true);
  });
});
`,
};

const DEFAULT_DIFF_LINES: CodeLine[] = [
  { n: '41', mark: '', kind: 'ctx', text: '  private async attempt(step: Step, n: number) {' },
  { n: '42', mark: '', kind: 'ctx', text: '    const budget = this.opts.retryBudgetMs;' },
  { n: '43', mark: '-', kind: 'del', text: '    const startedAt = Date.now();' },
  { n: '44', mark: '-', kind: 'del', text: '    const delay = backoff(n) + jitter();' },
  { n: '45', mark: '+', kind: 'add', text: '    const startedAt = this.clock.now();' },
  { n: '46', mark: '+', kind: 'add', text: '    const delay = backoff(n, this.clock.seed);' },
  { n: '47', mark: '', kind: 'ctx', text: '' },
  { n: '48', mark: '', kind: 'ctx', text: '    if (delay > budget) {' },
  { n: '49', mark: '', kind: 'ctx', text: '      throw new RetryBudgetExceeded(step.id, delay, budget);' },
  { n: '50', mark: '', kind: 'ctx', text: '    }' },
  { n: '51', mark: '', kind: 'ctx', text: '' },
  { n: '52', mark: '+', kind: 'add', text: '    await this.clock.sleep(delay);' },
  { n: '53', mark: '-', kind: 'del', text: '    await sleep(delay);' },
  { n: '54', mark: '', kind: 'ctx', text: '    const result = await this.tools.run(step);' },
  { n: '55', mark: '', kind: 'ctx', text: '' },
  { n: '56', mark: '', kind: 'ctx', text: '    this.log.tool(step.tool, {' },
  { n: '57', mark: '', kind: 'ctx', text: '      ms: this.clock.now() - startedAt,' },
  { n: '58', mark: '', kind: 'ctx', text: '      attempt: n,' },
  { n: '59', mark: '', kind: 'ctx', text: '    });' },
  { n: '60', mark: '', kind: 'ctx', text: '' },
  { n: '61', mark: '', kind: 'ctx', text: '    return result;' },
  { n: '62', mark: '', kind: 'ctx', text: '  }' },
];

export function Code({
  initialFile,
  isVisible = true,
}: {
  initialFile?: string;
  isVisible?: boolean;
} = {}) {
  const [activeFile, setActiveFile] = useState(initialFile || 'src/agent/loop.ts');
  const [files, setFiles] = useState<Record<string, string>>(INITIAL_FILE_CONTENTS);
  const [viewMode, setViewMode] = useState<'edit' | 'diff'>('edit');
  const [reverted, setReverted] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const [terminalHeight, setTerminalHeight] = useState<number>(260);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [termConnected, setTermConnected] = useState(false);
  const [termInfo, setTermInfo] = useState<{ cwd: string; shell: string; user: string } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const xtermContainerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const currentBufferCmdRef = useRef<string>('');

  useEffect(() => {
    if (initialFile) {
      setActiveFile(initialFile);
    }
  }, [initialFile]);

  useEffect(() => {
    fetch(`/api/file/read?path=${encodeURIComponent(activeFile)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.content === 'string') {
          setFiles((prev) => ({ ...prev, [activeFile]: data.content }));
        }
      })
      .catch(() => {});
  }, [activeFile]);

  useEffect(() => {
    fetch('/api/terminal/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setTermInfo(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!xtermContainerRef.current) return;

    if (xtermRef.current) {
      try { xtermRef.current.dispose(); } catch {}
    }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: '#0a0d16',
        foreground: '#e2e8f0',
        cursor: '#6ed0ea',
        cursorAccent: '#0a0d16',
        selectionBackground: 'rgba(110, 208, 234, 0.35)',
        black: '#121624',
        red: '#ff6b6b',
        green: '#2ed573',
        yellow: '#ffd166',
        blue: '#6ed0ea',
        magenta: '#d9785c',
        cyan: '#70a1ff',
        white: '#f1f2f6',
        brightBlack: '#57606f',
        brightRed: '#ff4757',
        brightGreen: '#7bed9f',
        brightYellow: '#ffeaa7',
        brightBlue: '#70a1ff',
        brightMagenta: '#ff7f50',
        brightCyan: '#00d2d3',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(xtermContainerRef.current);
    try { fitAddon.fit(); } catch {}

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
    let unlistenStdout: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    if (isTauri) {
      // ── Native Rust PTY Integration via Tauri IPC (portable-pty) ───────────
      (async () => {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const { listen } = await import('@tauri-apps/api/event');

          const { cols, rows } = term;
          const spawnedId = await invoke<string>('spawn_pty', { rows, cols });
          ptyIdRef.current = spawnedId;
          setTermConnected(true);
          setTermInfo({ cwd: '.', shell: 'native-rust-pty', user: 'aura' });

          unlistenStdout = await listen<{ id: string; data: string } | string>('pty-stdout', (event) => {
            if (typeof event.payload === 'string') {
              term.write(event.payload);
            } else if (event.payload && event.payload.id === spawnedId) {
              term.write(event.payload.data);
            }
          });

          unlistenExit = await listen(`pty-exit-${spawnedId}`, () => {
            term.write(`\r\n\x1b[33m[Process exited]\x1b[0m\r\n`);
          });
        } catch (err: any) {
          console.warn('Tauri native PTY spawn error, falling back to WebSocket:', err);
          void initWebSocket();
        }
      })();
    } else {
      void initWebSocket();
    }

    async function initWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = await getAuthToken();
      const isTauriEnv = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
      const host = isTauriEnv || window.location.port === '5173' || !window.location.port
        ? '127.0.0.1:7337'
        : window.location.host;
      const wsUrl = `${protocol}//${host}/api/terminal/pty?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setTermConnected(true);
        const { cols, rows } = term;
        ws.send(JSON.stringify({ type: 'pty_resize', cols, rows }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pty_output' && typeof msg.data === 'string') {
            term.write(msg.data);
          } else if (msg.type === 'pty_ready') {
            setTermInfo({ cwd: msg.cwd, shell: msg.shell, user: 'aura' });
          } else if (msg.type === 'pty_exit') {
            term.write(`\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
          }
        } catch {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        setTermConnected(false);
        term.write('\r\n\x1b[90m[Terminal disconnected · click Reconnect above]\x1b[0m\r\n');
      };
    }

    term.onData(async (data) => {
      if (isTauri && ptyIdRef.current) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('write_pty', { id: ptyIdRef.current, data });
        } catch {}
      } else if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'pty_input', data }));
      }

      if (data === '\r' || data === '\n') {
        const fullCmd = currentBufferCmdRef.current.trim();
        currentBufferCmdRef.current = '';

        if (fullCmd) {
          const fileTokens = fullCmd.split(/\s+/).filter((tok) =>
            tok.includes('.') &&
            !tok.startsWith('-') &&
            (tok.endsWith('.ts') || tok.endsWith('.tsx') || tok.endsWith('.js') || tok.endsWith('.jsx') ||
             tok.endsWith('.py') || tok.endsWith('.json') || tok.endsWith('.md') || tok.endsWith('.html') ||
             tok.endsWith('.css') || tok.endsWith('.yaml') || tok.endsWith('.yml') || tok.endsWith('.sh') ||
             tok.endsWith('.rs') || tok.endsWith('.go') || tok.endsWith('.sql'))
          );
          if (fileTokens.length > 0) {
            const targetFile = fileTokens[0].replace(/^\.\//, '').replace(/^['"]/, '').replace(/['"]$/, '');
            setActiveFile(targetFile);
            fetch(`/api/file/read?path=${encodeURIComponent(targetFile)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => {
                if (data && typeof data.content === 'string') {
                  setFiles((prev) => ({ ...prev, [targetFile]: data.content }));
                  setViewMode('edit');
                }
              })
              .catch(() => {});
          }
        }
      } else if (data === '\u007F' || data === '\b') {
        currentBufferCmdRef.current = currentBufferCmdRef.current.slice(0, -1);
      } else if (data.length === 1 && data >= ' ') {
        currentBufferCmdRef.current += data;
      }
    });

    const handleWindowResize = async () => {
      try {
        fitAddon.fit();
        if (isTauri && ptyIdRef.current) {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('resize_pty', { id: ptyIdRef.current, cols: term.cols, rows: term.rows });
        } else if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'pty_resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    };

    window.addEventListener('resize', handleWindowResize);

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      if (unlistenStdout) unlistenStdout();
      if (unlistenExit) unlistenExit();
      if (isTauri && ptyIdRef.current) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('kill_pty', { id: ptyIdRef.current }).catch(() => {});
        });
      }
      try { wsRef.current?.close(); } catch {}
      try { term.dispose(); } catch {}
    };
  }, []);

  // Keep-alive auto fit on tab visibility transition or terminal resize
  useEffect(() => {
    if (isVisible && fitAddonRef.current && xtermRef.current) {
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          const { cols, rows } = xtermRef.current!;
          const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
          if (isTauri && ptyIdRef.current) {
            import('@tauri-apps/api/core').then(({ invoke }) => {
              invoke('resize_pty', { id: ptyIdRef.current, cols, rows }).catch(() => {});
            });
          } else if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'pty_resize', cols, rows }));
          }
        } catch {}
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible, terminalHeight]);

  useEffect(() => {
    const onResize = () => setTerminalHeight((h) => Math.min(h, maxTerminalHeight()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentCode = files[activeFile] ?? '// New empty file\n';
  const lineCount = currentCode.split('\n').length;

  const handleCodeChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setFiles((prev) => ({ ...prev, [activeFile]: val }));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const nextVal = val.substring(0, start) + '  ' + val.substring(end);
      setFiles((prev) => ({ ...prev, [activeFile]: nextVal }));
      setTimeout(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      }, 0);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
  };

  const handleSave = async () => {
    setSaveStatus('Saving...');
    try {
      const res = await fetch('/api/file/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: activeFile, content: currentCode }),
      });
      if (res.ok) {
        setSaveStatus('✓ Saved');
      } else {
        setSaveStatus('✓ Saved Locally');
      }
    } catch {
      setSaveStatus('✓ Saved Locally');
    }
    setTimeout(() => setSaveStatus(null), 2500);
  };

  /** Height of the drag handle, so the terminal can never swallow it. */
  const HANDLE_H = 10;

  /**
   * The tallest the terminal may be: the whole split, less the handle.
   *
   * Measured from the container rather than capped at a fraction of the
   * viewport — a share of the window is not the space actually available, and
   * it stopped the terminal well short of covering the editor. Leaving the
   * handle out is what keeps a full-height terminal draggable back down.
   */
  const maxTerminalHeight = () => {
    const box = workspaceRef.current?.getBoundingClientRect();
    return Math.max(70, (box?.height ?? window.innerHeight) - HANDLE_H);
  };

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startY = e.clientY;
    const startHeight = terminalHeight;
    const ceiling = maxTerminalHeight();

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const nextHeight = Math.min(Math.max(startHeight + deltaY, 70), ceiling);
      setTerminalHeight(nextHeight);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  /**
   * Cycle the three sizes a double-click is actually asking for: collapsed,
   * a working split, and full — rather than toggling between two.
   */
  const handleResizeDoubleClick = () => {
    const full = maxTerminalHeight();
    setTerminalHeight((h) => {
      if (h < 140) return 300;
      if (h < full - 4) return full;
      return 80;
    });
  };

  const sendQuickCommand = (cmd: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'pty_input', data: `${cmd}\r` }));
      xtermRef.current?.focus();
    }
    const fileTokens = cmd.split(/\s+/).filter((tok) =>
      tok.includes('.') &&
      !tok.startsWith('-') &&
      (tok.endsWith('.ts') || tok.endsWith('.tsx') || tok.endsWith('.js') || tok.endsWith('.jsx') ||
       tok.endsWith('.py') || tok.endsWith('.json') || tok.endsWith('.md') || tok.endsWith('.html') ||
       tok.endsWith('.css') || tok.endsWith('.yaml') || tok.endsWith('.yml') || tok.endsWith('.sh') ||
       tok.endsWith('.rs') || tok.endsWith('.go') || tok.endsWith('.sql'))
    );
    if (fileTokens.length > 0) {
      const targetFile = fileTokens[0].replace(/^\.\//, '').replace(/^['"]/, '').replace(/['"]$/, '');
      setActiveFile(targetFile);
      fetch(`/api/file/read?path=${encodeURIComponent(targetFile)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && typeof data.content === 'string') {
            setFiles((prev) => ({ ...prev, [targetFile]: data.content }));
            setViewMode('edit');
          }
        })
        .catch(() => {});
    }
  };

  const handleInterrupt = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'pty_input', data: '\x03' }));
      xtermRef.current?.focus();
    }
  };

  const handleClear = () => {
    xtermRef.current?.clear();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'pty_input', data: '\x0c' }));
      xtermRef.current?.focus();
    }
  };

  const diffAdd = DEFAULT_DIFF_LINES.filter((l) => l.kind === 'add').length;
  const diffDel = DEFAULT_DIFF_LINES.filter((l) => l.kind === 'del').length;

  return (
    <div className="code-workspace" ref={workspaceRef}>
      {/* Upper IDE Row: File Tree Sidebar (Left) + Code Editor / Diff Pane (Right) */}
      <div className="code-upper-workspace">
        <aside className="code-sidebar">
          <div className="code-sidebar-head">
            <span className="code-sidebar-label">Explorer</span>
            <span className="code-sidebar-sub">{termInfo?.cwd ? termInfo.cwd.split('/').pop() : 'aura-code'}</span>
          </div>

          <div className="code-tree">
            {DEFAULT_TREE.map((item) => {
              const isSelected = item.path === activeFile;
              return (
                <div
                  key={item.path}
                  className={`code-tree-item ${item.type} ${isSelected ? 'selected' : ''}`}
                  style={{ paddingLeft: `${16 + item.depth * 14}px` }}
                  onClick={() => {
                    if (item.type === 'file') {
                      setActiveFile(item.path);
                      setViewMode('edit');
                    }
                  }}
                >
                  <span className="tree-icon">{item.type === 'folder' ? '📁' : '📄'}</span>
                  <span className="tree-name">{item.name}</span>
                  {item.badge && (
                    <span className="tree-badge" style={{ color: item.badgeColor || 'var(--mut)' }}>
                      {item.badge}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        <section className="code-main-pane">
          <header className="code-file-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="code-file-path">{activeFile}</span>
              {saveStatus && (
                <span className="save-status-badge">{saveStatus}</span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '16px' }}>
              <button
                type="button"
                className={`btn-code-mode-toggle ${viewMode === 'edit' ? 'active' : ''}`}
                onClick={() => setViewMode('edit')}
              >
                ✏️ Code Editor
              </button>
              <button
                type="button"
                className={`btn-code-mode-toggle ${viewMode === 'diff' ? 'active' : ''}`}
                onClick={() => setViewMode('diff')}
              >
                🔍 Diff Inspector (+{diffAdd} / −{diffDel})
              </button>
            </div>

            <div className="spacer" />

            {viewMode === 'edit' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button type="button" className="btn-code-action btn-save-code" onClick={handleSave}>
                  💾 Save File
                </button>
                <button
                  type="button"
                  className="btn-code-action btn-run-code"
                  onClick={() => sendQuickCommand('npm test')}
                >
                  ▶ Run Tests
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-hunk"
                onClick={() => setReverted((v) => !v)}
              >
                {reverted ? 'Restore hunk' : 'Revert hunk'}
              </button>
            )}
          </header>

          {viewMode === 'edit' ? (
            <div className="code-editor-workspace">
              <div className="code-editor-gutter">
                {Array.from({ length: lineCount }).map((_, i) => (
                  <div key={i} className="gutter-line-num">
                    {i + 1}
                  </div>
                ))}
              </div>
              <textarea
                ref={textareaRef}
                className="code-editor-textarea"
                value={currentCode}
                onChange={handleCodeChange}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
              />
            </div>
          ) : (
            <div className="code-lines-scroll">
              {DEFAULT_DIFF_LINES.map((l, i) => {
                const bg = l.kind === 'add' ? 'rgba(90,158,110,0.13)' : l.kind === 'del' ? 'rgba(177,84,57,0.13)' : 'transparent';
                const markColor = l.kind === 'add' ? 'var(--ok)' : l.kind === 'del' ? 'var(--err)' : 'transparent';
                const fg = l.kind === 'ctx' ? 'var(--txt)' : 'var(--ink)';
                return (
                  <div key={i} className="code-line-row" style={{ background: bg }}>
                    <span className="line-num">{l.n}</span>
                    <span className="line-mark" style={{ color: markColor }}>{l.mark}</span>
                    <span className="line-code" style={{ color: fg }}>{l.text || ' '}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Full-Width Draggable Separator between Upper Workspace & Lower Terminal */}
      <div
        className={`terminal-resize-handle ${isDragging ? 'is-dragging' : ''}`}
        onMouseDown={handleResizeMouseDown}
        onDoubleClick={handleResizeDoubleClick}
        title="Drag up/down to resize terminal height · Double-click to toggle"
      >
        <div className="terminal-resize-grip" />
      </div>

      {/* Full-Width Lower Section: Native System Pseudoterminal beneath both Sidebar and Editor */}
      <div className="code-terminal-pane" style={{ height: `${terminalHeight}px` }}>
        <div className="terminal-titlebar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={`terminal-status-dot ${termConnected ? 'connected' : 'disconnected'}`} />
            <span>⚡ Terminal — {termInfo?.user || 'aura'}@{termInfo?.shell ? termInfo.shell.split('/').pop() : 'bash'} (pty)</span>
            {termConnected && (
              <span className="terminal-badge-running">
                <span className="live-pulse" /> LIVE PTY
              </span>
            )}
          </div>

          <div className="terminal-header-tools">
            <button
              type="button"
              className="terminal-quick-btn"
              onClick={() => sendQuickCommand('npm test')}
              title="Run test suite in pty"
            >
              npm test
            </button>
            <button
              type="button"
              className="terminal-quick-btn"
              onClick={() => sendQuickCommand('git status')}
              title="Run git status in pty"
            >
              git status
            </button>
            <button
              type="button"
              className="terminal-quick-btn"
              onClick={() => sendQuickCommand('git diff')}
              title="Run git diff in pty"
            >
              git diff
            </button>
            <button
              type="button"
              className="terminal-quick-btn"
              onClick={() => sendQuickCommand('ls -la')}
              title="Run ls -la in pty"
            >
              ls -la
            </button>
            <button
              type="button"
              className="terminal-quick-btn btn-term-interrupt"
              onClick={handleInterrupt}
              title="Send SIGINT (Ctrl+C)"
            >
              ■ Ctrl+C
            </button>
            <button
              type="button"
              className="btn-clear-term"
              onClick={handleClear}
              title="Clear screen (Ctrl+L)"
            >
              Clear
            </button>
          </div>
        </div>

        <div
          className="xterm-terminal-container"
          ref={xtermContainerRef}
          tabIndex={0}
          onClick={() => xtermRef.current?.focus()}
        />
      </div>
    </div>
  );
}
