import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown, CopyButton } from './Markdown';
import { Sigil } from './Sigil';
import type { Message, ToolEvent } from '../hooks/useAura';

type T = (key: string) => string;

/** One tool call, collapsed by default — the transcript, not the headline. */
function ToolRow({ tool, t }: { tool: ToolEvent; t: T }) {
  const [open, setOpen] = useState(false);
  const body = tool.blocked ?? tool.result ?? '';
  const long = body.length > 240;
  const state = tool.blocked ? 'blocked' : tool.result !== undefined ? 'done' : 'running';

  return (
    <div className={`tool tool-${state}`}>
      <button className="tool-head" type="button" onClick={() => setOpen((v) => !v)}>
        <span className="tool-glyph" aria-hidden="true">
          {state === 'blocked' ? '⊘' : state === 'done' ? '✓' : '◆'}
        </span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-verb">
          {tool.blocked ? t('tool.blocked') : t('tool.called')}
        </span>
        {tool.elapsedMs !== undefined && (
          <span className="tool-ms">{Math.round(tool.elapsedMs)}ms</span>
        )}
        {body && <span className="tool-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </button>
      {open && body && (
        <pre className="tool-body">{long && !open ? body.slice(0, 240) : body}</pre>
      )}
    </div>
  );
}

function MessageRow({ message, t }: { message: Message; t: T }) {
  const mine = message.role === 'user';
  return (
    <div className={`msg ${mine ? 'msg-user' : 'msg-aura'}`}>
      <div className="msg-gutter" aria-hidden="true">
        {mine ? <span className="msg-badge">›</span> : <Sigil size={17} />}
      </div>
      <div className="msg-body">
        <div className="msg-who">{mine ? t('chat.you') : t('chat.aura')}</div>

        {message.tools.length > 0 && (
          <div className="tools">
            {message.tools.map((tool) => <ToolRow key={tool.id} tool={tool} t={t} />)}
          </div>
        )}

        {message.text
          ? <Markdown text={message.text} />
          : message.streaming && (
            <div className="thinking">
              <span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" />
              <span className="thinking-label">{t('chat.thinking')}</span>
            </div>
          )}

        {message.error && <div className="msg-error">{message.error}</div>}

        {!message.streaming && message.text && (
          <div className="msg-actions">
            <CopyButton text={message.text} label={t('chat.copy')} copiedLabel={t('chat.copied')} />
          </div>
        )}
      </div>
    </div>
  );
}

export function Chat({
  messages, busy, error, t, onSend, onStop, onRegenerate,
}: {
  messages: Message[];
  busy: boolean;
  error: string | null;
  t: T;
  onSend: (text: string) => void;
  onStop: () => void;
  onRegenerate: () => void;
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Only auto-scroll when the reader is already at the bottom; yanking them
  // down while they read back through a long answer is hostile.
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft('');
    pinned.current = true;
  };

  return (
    <div className="chat">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 ? (
          <div className="empty">
            <Sigil size={46} className="empty-sigil" />
            <h1 className="empty-title">{t('chat.emptyTitle')}</h1>
            <p className="empty-body">{t('chat.emptyBody')}</p>
          </div>
        ) : (
          <div className="thread">
            {messages.map((m) => <MessageRow key={m.id} message={m} t={t} />)}
            {error && <div className="thread-error">{error}</div>}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            ref={taRef}
            className="composer-input"
            rows={1}
            value={draft}
            placeholder={t('chat.placeholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline — the convention every
              // chat client shares, so breaking it would be the surprise.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-actions">
            {busy ? (
              <button type="button" className="btn btn-stop" onClick={onStop}>
                <span className="stop-glyph" aria-hidden="true">■</span>{t('chat.stop')}
              </button>
            ) : (
              <>
                {messages.some((m) => m.role === 'user') && (
                  <button type="button" className="btn btn-ghost" onClick={onRegenerate}>
                    ⟳ {t('chat.regenerate')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-send"
                  onClick={submit}
                  disabled={!draft.trim()}
                >
                  {t('chat.send')} <span aria-hidden="true">↵</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
