import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import type { Conversation } from '../hooks/useAura';

type T = (key: string) => string;

const DEFAULT_SAMPLE_CHATS: Conversation[] = [
  { sessionId: 'ch1', title: 'Flaky retry in the agent loop', at: Date.now() - 12 * 60000 },
  { sessionId: 'ch2', title: 'Bound the retry queue at 8', at: Date.now() - 60 * 60000 },
  { sessionId: 'ch3', title: 'Telegram long-poll fallback', at: Date.now() - 24 * 3600000 },
  { sessionId: 'ch4', title: 'Strip ANSI from bot replies', at: Date.now() - 48 * 3600000 },
  { sessionId: 'ch5', title: 'Sidecar WebSocket reconnect', at: Date.now() - 72 * 3600000 },
];

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

  // The placeholder list stands in for an empty history. Its rows have no
  // session behind them, so rename and delete would call the engine with an id
  // it has never seen, fail, and be swallowed — a control that looks live and
  // does nothing. They are hidden until there is something real to act on.
  const hasRealChats = conversations.length > 0;
  const listToDisplay = hasRealChats ? conversations : DEFAULT_SAMPLE_CHATS;
  const activeId = sessionId || (conversations.length > 0 ? conversations[0].sessionId : 'ch1');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? listToDisplay.filter((c) => c.title.toLowerCase().includes(q)) : listToDisplay;
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
            <div className="chat-sidebar-empty">No conversations</div>
          ) : (
            filtered.map((c, i) => {
              const isActive = c.sessionId === activeId;
              const isLive = isActive || (i === 0 && !c.sessionId.startsWith('ch'));
              const timeAgo = c.at ? formatTimeAgo(c.at) : '';
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
                      onDoubleClick={() => hasRealChats && setRenaming({ id: c.sessionId, value: c.title || '' })}
                      title="Click to open · double-click to rename"
                    >
                      <div className="convo-title-row">
                        <span className={`convo-status-dot ${isLive ? 'live' : ''}`} />
                        <span className="convo-title-text">{c.title || 'Untitled Session'}</span>
                      </div>
                      {timeAgo && <span className="convo-time-meta">{timeAgo}</span>}
                    </button>
                  )}
                  {hasRealChats && (
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
                  )}
                  {hasRealChats && (
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
                  )}
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
