import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import type { Conversation } from '../hooks/useAura';

type T = (key: string) => string;

export function Sidebar({
  conversations,
  sessionId,
  open,
  t,
  onNew,
  onOpen,
  onDelete,
  onRename,
  onSettings,
  onClose,
}: {
  conversations: Conversation[];
  sessionId: string | null;
  open: boolean;
  t: T;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  /** Session being renamed, and the text so far. */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const commitRename = () => {
    if (!renaming) return;
    onRename(renaming.id, renaming.value.trim());
    setRenaming(null);
  };

  const listToDisplay = conversations;
  const activeId = sessionId || (conversations.length > 0 ? conversations[0].sessionId : null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? listToDisplay.filter((c) => c.title.toLowerCase().includes(q) || c.sessionId.toLowerCase().includes(q)) : listToDisplay;
  }, [listToDisplay, query]);

  return (
    <>
      {open && <div className="sidebar-mobile-scrim" onClick={onClose} aria-hidden="true" />}

      <aside className={`chat-sidebar-pane ${open ? 'open' : ''}`}>
        <div className="chat-sidebar-top">
          <button type="button" className="btn-new-chat-action" onClick={onNew}>
            <span className="plus-sym">+</span> New chat
          </button>
        </div>

        <div className="chat-sidebar-label">History</div>

        <div className="chat-sidebar-list">
          {filtered.length === 0 ? (
            <div className="chat-sidebar-empty" style={{ padding: '16px', fontSize: '11.5px', color: 'var(--dim)', textAlign: 'center' }}>
              No saved conversations
            </div>
          ) : (
            filtered.map((c, i) => {
              const isActive = c.sessionId === activeId;
              const isLive = isActive;
              const timeAgo = c.at ? formatTimeAgo(c.at) : '';
              const sessionNum = c.number ?? (i + 1);
              return (
                <div
                  key={c.sessionId}
                  className={`chat-convo-item ${isActive ? 'active' : ''}`}
                >
                  {renaming?.id === c.sessionId ? (
                    <input
                      className="convo-rename-input"
                      value={renaming.value}
                      autoFocus
                      // Select the old name on focus, so typing replaces it.
                      // Without this the caret lands at the end and the new
                      // name is appended to the old one.
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setRenaming({ id: c.sessionId, value: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                        // Escape abandons the edit rather than saving it — the
                        // one gesture people expect to mean "never mind".
                        if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                      }}
                      placeholder="Name this chat"
                      aria-label="Chat name"
                    />
                  ) : (
                    <button
                      type="button"
                      className="convo-select-btn"
                      onClick={() => onOpen(c.sessionId)}
                      onDoubleClick={() => setRenaming({ id: c.sessionId, value: c.title || '' })}
                      title="Click to open · double-click to rename"
                    >
                      <div className="convo-title-row">
                        <span className="convo-number-badge">#{sessionNum}</span>
                        <span className={`convo-status-dot ${isLive ? 'live' : ''}`} />
                        <span className="convo-title-text">{c.title || 'Untitled Session'}</span>
                      </div>
                      <div className="convo-meta-row">
                        <span className="convo-id-pill">{c.sessionId.slice(0, 8)}</span>
                        {c.turns !== undefined && c.turns > 0 && <span className="convo-turns-meta">· {c.turns}t</span>}
                        {timeAgo && <span className="convo-time-meta">· {timeAgo}</span>}
                      </div>
                    </button>
                  )}
                  <button
                    type="button"
                    className="convo-rename-btn"
                    title="Rename session"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenaming({ id: c.sessionId, value: c.title || '' });
                    }}
                  >
                    <Icon name="edit" size="0.85em" />
                  </button>
                  <button
                    type="button"
                    className="convo-delete-btn"
                    title="Delete session"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm('Delete this conversation?')) onDelete(c.sessionId);
                    }}
                  >
                    <Icon name="trash" size="0.85em" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago · running`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago · verified`;
}
