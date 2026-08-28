import { useMemo, useState } from 'react';
import { Sigil } from './Sigil';
import type { Conversation } from '../hooks/useAura';

type T = (key: string) => string;

export function Sidebar({
  conversations, sessionId, open, t,
  onNew, onOpen, onDelete, onSettings, onClose,
}: {
  conversations: Conversation[];
  sessionId: string | null;
  open: boolean;
  t: T;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations;
  }, [conversations, query]);

  return (
    <>
      {/* Scrim only exists on narrow screens, where the sidebar overlays. */}
      {open && <div className="scrim" onClick={onClose} aria-hidden="true" />}

      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
        <div className="sidebar-head">
          <div className="brand">
            <Sigil size={19} />
            <span className="brand-name">Aura</span>
          </div>
          <button type="button" className="icon-btn sidebar-close" onClick={onClose} aria-label={t('settings.close')}>
            ✕
          </button>
        </div>

        <button type="button" className="new-chat" onClick={onNew}>
          <span aria-hidden="true">+</span> {t('app.newChat')}
        </button>

        <div className="search">
          <input
            className="search-input"
            value={query}
            placeholder={t('app.search')}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('app.search')}
          />
        </div>

        <div className="convo-list">
          <div className="convo-label">{t('app.conversations')}</div>
          {filtered.length === 0 ? (
            <div className="convo-empty">{t('app.noConversations')}</div>
          ) : (
            filtered.map((c) => (
              <div
                key={c.sessionId}
                className={`convo ${c.sessionId === sessionId ? 'convo-active' : ''}`}
              >
                <button type="button" className="convo-open" onClick={() => onOpen(c.sessionId)}>
                  <span className="convo-title">{c.title}</span>
                </button>
                <button
                  type="button"
                  className="convo-del"
                  aria-label={t('app.delete')}
                  onClick={() => { if (confirm(t('app.deleteConfirm'))) onDelete(c.sessionId); }}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <button type="button" className="sidebar-settings" onClick={onSettings}>
          <span aria-hidden="true">⚙</span> {t('app.settings')}
        </button>
      </aside>
    </>
  );
}
