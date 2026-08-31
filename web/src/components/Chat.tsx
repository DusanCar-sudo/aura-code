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

export function Chat({
  messages,
  busy,
  error,
  sessionId,
  sessionNumber,
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
  sessionNumber?: number;
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

  // Use real messages in the active thread
  const displayList: CustomMessage[] = (messages as CustomMessage[]);

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
          <span className="meta-badge-session">{sessionNumber ? `Session #${sessionNumber}` : 'Session'}</span>
          <span className="meta-session-id">
            {sessionId ? `sess ${sessionId.slice(0, 8)} · aura-code · main` : 'no session active'}
          </span>
          <div className="spacer" />
          <span className="meta-policy-pills">{approvalPill} · {sandboxPill}</span>
        </div>
        <h1 className="chat-header-title">{chatTitle || (sessionId ? `Session #${sessionNumber ?? 1}` : 'New Chat')}</h1>
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
                return (
                  <div key={m.id} className="chat-msg-row">
                    <div className="chat-gate-card">
                      <div className="gate-card-head">
                        <span className="gate-icon">⚠️</span>
                        <span className="gate-title">Approval</span>
                      </div>
                      <div className="gate-tool-text">{m.text}</div>
                      {m.detail && <div className="gate-detail-text">{m.detail}</div>}
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
