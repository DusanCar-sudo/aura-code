import { useLayoutEffect, useRef, useState } from 'react';
import { Markdown, CopyButton } from './Markdown';
import { Composer, type Attachment } from './Composer';
import auraSign from '../assets/aura-sign.webp';
import type { Message, ToolEvent, PendingApproval } from '../hooks/useAura';

type T = (key: string) => string;

const EXT_ICON: Record<string, string> = {
  pdf: '📄', doc: '📄', docx: '📄', md: '📄', txt: '📄',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', webp: '🖼️', gif: '🖼️',
  zip: '🗄️', tar: '🗄️', gz: '🗄️', csv: '📊', json: '{ }',
  ts: '📝', js: '📝', py: '📝', rs: '📝', go: '📝',
};

function getFileIcon(name: string): string {
  const ext = String(name).split('.').pop()?.toLowerCase() ?? '';
  return EXT_ICON[ext] || '📎';
}

function ToolCard({
  icon,
  tool,
  detail,
  status,
  statusColor,
}: {
  icon?: string;
  tool: string;
  detail: string;
  status: string;
  statusColor?: string;
}) {
  const [open, setOpen] = useState(false);
  const iconGlyph = icon || (
    tool === 'shell' || tool === 'run_shell' ? '⚡'
    : tool === 'test' || tool === 'run_tests' ? '🧪'
    : tool === 'search' || tool === 'search_code' ? '🔍'
    : tool === 'edit' || tool === 'edit_file' ? '✏️'
    : tool === 'write' || tool === 'write_file' ? '📝'
    : tool === 'git' ? '🌿'
    : '📄'
  );

  return (
    <div className="chat-tool-card">
      <span className="tool-card-icon">{iconGlyph}</span>
      <div className="tool-card-body">
        <div className="tool-card-name">{tool}</div>
        <div className="tool-card-detail" title={detail}>
          {detail.length > 90 && !open ? `${detail.slice(0, 90)}…` : detail}
        </div>
      </div>
      <span className="tool-card-status" style={{ color: statusColor || 'var(--mut)' }}>
        {status}
      </span>
      {detail.length > 90 && (
        <button
          type="button"
          className="tool-card-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '▴' : '▾'}
        </button>
      )}
    </div>
  );
}

export interface VerifyLine {
  text: string;
  color?: string;
}

// `role` is deliberately wider here than the engine's Role (it carries the
// UI-only 'gate' | 'tool' | 'verify' rows), so it is excluded from the base
// rather than conflicting with it.
export interface CustomMessage extends Omit<Partial<Message>, 'role'> {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'gate' | 'tool' | 'verify';
  text?: string;
  files?: Array<{ name: string }>;
  tool?: string;
  icon?: string;
  detail?: string;
  status?: string;
  statusColor?: string;
  lines?: VerifyLine[];
  pending?: boolean;
  resolved?: boolean;
}

const DEFAULT_SAMPLE_MESSAGES: CustomMessage[] = [
  {
    id: 'm1',
    role: 'user',
    text: 'The retry test in loop.spec.ts fails maybe one run in six. Find out why.',
    files: [{ name: 'loop.spec.ts' }, { name: 'ci-run-1188.log' }],
  },
  {
    id: 'm2',
    role: 'assistant',
    text: 'I will reproduce it before I touch anything. Running the single spec twenty times.',
  },
  {
    id: 'm3',
    role: 'tool',
    icon: '⚡',
    tool: 'shell',
    detail: 'vitest run loop.spec.ts --repeat 20',
    status: '3 failed',
    statusColor: 'var(--err)',
  },
  {
    id: 'm4',
    role: 'tool',
    icon: '📄',
    tool: 'read',
    detail: 'src/agent/loop.ts:31-78',
    status: '48 lines',
    statusColor: 'var(--mut)',
  },
  {
    id: 'm5',
    role: 'assistant',
    text: 'Line 47 computes the backoff from Date.now() inside the assertion window, so a slow tick pushes the third retry past the 200ms budget. The bug is in the test clock, not the loop - but the loop should not read the wall clock either.',
  },
  {
    id: 'm6',
    role: 'gate',
    text: 'edit src/agent/loop.ts',
    detail: '2 hunks · replaces Date.now() with an injected clock',
    pending: true,
  },
  {
    id: 'm7',
    role: 'tool',
    icon: '🧪',
    tool: 'test',
    detail: 'vitest run --repeat 40',
    status: '40/40',
    statusColor: 'var(--ok)',
  },
  {
    id: 'm8',
    role: 'verify',
    lines: [
      { text: '✓ 1,205 tests passing', color: 'var(--ok)' },
      { text: '✓ loop.spec.ts stable over 40 runs', color: 'var(--ok)' },
      { text: '✗ 0 regressions', color: 'var(--mut)' },
      { text: '→ src/agent/loop.ts:47, src/agent/clock.ts (new)', color: 'var(--mut)' },
    ],
  },
];

export function Chat({
  messages,
  busy,
  error,
  sessionId,
  chatTitle,
  approval,
  permission = 'auto',
  sandbox = false,
  t,
  openMenuAt,
  onSend,
  onStop,
  onRegenerate,
  onApprove,
  onDeny,
}: {
  messages: Message[];
  busy: boolean;
  error: string | null;
  sessionId: string | null;
  chatTitle?: string;
  approval?: PendingApproval | null;
  permission?: string;
  sandbox?: boolean;
  t: T;
  openMenuAt: number;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [sampleGateState, setSampleGateState] = useState<'pending' | 'approved' | 'denied'>('pending');

  // Use real messages if present, or sample messages for ch1 / demo session
  const displayList: CustomMessage[] = messages.length > 0
    ? (messages as CustomMessage[])
    : (!sessionId || sessionId === 'ch1' ? DEFAULT_SAMPLE_MESSAGES : []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [displayList, approval]);

  const approvalPill = permission === 'auto' ? 'auto' : permission === 'normal' ? 'ask: writes' : 'ask: all';
  const sandboxPill = sandbox ? 'sandbox on' : 'sandbox off';

  return (
    <div className="chat-pane-root">
      <header className="chat-pane-header">
        <div className="chat-header-meta-row">
          <span className="meta-badge-session">Session</span>
          <span className="meta-session-id">
            {sessionId ? `sess ${sessionId.slice(0, 6)} · aura-code · main` : 'sess 4f8c · aura-code · main'}
          </span>
          <div className="spacer" />
          <span className="meta-policy-pills">{approvalPill} · {sandboxPill}</span>
        </div>
        <h1 className="chat-header-title">{chatTitle || 'Flaky retry in the agent loop'}</h1>
      </header>

      <div
        className="chat-thread-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {displayList.length === 0 ? (
          <div className="chat-empty-state">
            <img src={auraSign} alt="Aura Logo" className="empty-state-logo" />
            <h2 className="empty-state-quote">I don't try. I verify.</h2>
            <p className="empty-state-sub">Give me something to reproduce, and I'll run it before I touch it.</p>
          </div>
        ) : (
          <div className="chat-thread-list">
            {displayList.map((m) => {
              const isUser = m.role === 'user';
              const isAura = m.role === 'assistant';
              const isTool = m.role === 'tool';
              const isGate = m.role === 'gate';
              const isVerify = m.role === 'verify';
              const isSystem = m.role === 'system';

              if (isSystem) {
                return (
                  <div key={m.id} className="chat-msg-row chat-msg-system">
                    <pre className="system-output-box">{m.text}</pre>
                  </div>
                );
              }

              if (isUser) {
                return (
                  <div key={m.id} className="chat-msg-row chat-msg-user-row">
                    <div className="chat-user-bubble">
                      <div className="bubble-author">You</div>
                      <div className="bubble-text">{m.text}</div>
                      {m.files && m.files.length > 0 && (
                        <div className="chat-attached-files-row">
                          {m.files.map((af, j) => (
                            <span key={j} className="chat-attached-chip">
                              <span>{getFileIcon(af.name)}</span>
                              <span>{af.name}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              if (isTool) {
                return (
                  <div key={m.id} className="chat-msg-row">
                    <ToolCard
                      icon={m.icon}
                      tool={m.tool || 'tool'}
                      detail={m.detail || ''}
                      status={m.status || 'done'}
                      statusColor={m.statusColor}
                    />
                  </div>
                );
              }

              if (isGate) {
                const isPending = sampleGateState === 'pending';
                return (
                  <div key={m.id} className="chat-msg-row">
                    <div className="chat-gate-card">
                      <div className="gate-card-head">
                        <span className="gate-icon">⚠️</span>
                        <span className="gate-title">Approval required</span>
                      </div>
                      <div className="gate-tool-text">{m.text}</div>
                      <div className="gate-detail-text">{m.detail}</div>
                      {isPending ? (
                        <div className="gate-actions-row">
                          <button
                            type="button"
                            className="btn-gate-approve"
                            onClick={() => setSampleGateState('approved')}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="btn-gate-deny"
                            onClick={() => setSampleGateState('denied')}
                          >
                            Deny
                          </button>
                        </div>
                      ) : (
                        <div
                          style={{
                            marginTop: '10px',
                            fontFamily: 'var(--font-mono)',
                            fontSize: '10.5px',
                            letterSpacing: '0.06em',
                            color: sampleGateState === 'approved' ? 'var(--ok)' : 'var(--err)',
                          }}
                        >
                          {sampleGateState === 'approved'
                            ? '✓ approved — applied 2 hunks'
                            : '✗ denied — no files written'}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              if (isVerify) {
                return (
                  <div key={m.id} className="chat-msg-row">
                    <div className="chat-verify-box">
                      {m.lines?.map((vl, j) => (
                        <div key={j} className="verify-line" style={{ color: vl.color || 'var(--mut)' }}>
                          {vl.text}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              return (
                <div key={m.id} className="chat-msg-row chat-msg-aura-row">
                  <div className="chat-aura-container">
                    <div className="bubble-author-aura">Aura</div>

                    {m.tools && m.tools.length > 0 && (
                      <div className="chat-tools-stack">
                        {m.tools.map((tool) => (
                          <ToolCard
                            key={tool.id}
                            tool={tool.name}
                            detail={
                              typeof tool.input === 'string'
                                ? tool.input
                                : tool.input
                                ? JSON.stringify(tool.input)
                                : tool.result || ''
                            }
                            status={
                              tool.blocked
                                ? 'blocked'
                                : tool.result !== undefined
                                ? tool.elapsedMs
                                  ? `${Math.round(tool.elapsedMs)}ms`
                                  : 'done'
                                : 'running...'
                            }
                            statusColor={tool.blocked ? 'var(--err)' : tool.result !== undefined ? 'var(--ok)' : 'var(--mut)'}
                          />
                        ))}
                      </div>
                    )}

                    {m.text ? (
                      <div className="aura-markdown-wrapper">
                        <Markdown text={m.text} />
                      </div>
                    ) : m.streaming ? (
                      <div className="chat-thinking-indicator">
                        <span className="thinking-dot" />
                        <span className="thinking-dot" />
                        <span className="thinking-dot" />
                        <span className="thinking-label">Thinking...</span>
                      </div>
                    ) : null}

                    {m.error && <div className="chat-turn-error">{m.error}</div>}

                    {!m.streaming && m.text && (
                      <div className="chat-msg-actions">
                        <CopyButton text={m.text} label="Copy" copiedLabel="Copied" />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Live Approval Card if an approval is currently pending */}
            {approval && (
              <div className="chat-gate-card">
                <div className="gate-card-head">
                  <span className="gate-icon">⚠️</span>
                  <span className="gate-title">Approval required</span>
                </div>
                <div className="gate-tool-text">{approval.tool}</div>
                <div className="gate-detail-text">{approval.detail}</div>
                <div className="gate-actions-row">
                  <button
                    type="button"
                    className="btn-gate-approve"
                    onClick={() => {
                      approval.resolve(true);
                      onApprove?.();
                    }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn-gate-deny"
                    onClick={() => {
                      approval.resolve(false);
                      onDeny?.();
                    }}
                  >
                    Deny
                  </button>
                </div>
              </div>
            )}

            {error && <div className="chat-stream-error">{error}</div>}
          </div>
        )}
      </div>

      <footer className="chat-pane-footer">
        <Composer
          openMenuAt={openMenuAt}
          busy={busy}
          canRegenerate={displayList.some((m) => m.role === 'user')}
          t={t}
          onSend={(text, attachments) => {
            pinned.current = true;
            onSend(text, attachments);
          }}
          onStop={onStop}
          onRegenerate={onRegenerate}
        />
      </footer>
    </div>
  );
}
