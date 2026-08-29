import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

type T = (key: string) => string;

export interface Attachment {
  id: string;
  name: string;
  /** MIME type as the browser reported it. */
  type: string;
  size: number;
  /** data: URI — images are previewed from it, everything else is carried. */
  dataUrl: string;
}

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  category: string;
}

/**
 * The composer.
 *
 * Two affordances beside the text: `+` attaches images and files, `/` opens the
 * same command set the TUI palette exposes. The command list is fetched from
 * the engine (`/api/commands`, served straight from PALETTE_COMMANDS) rather
 * than copied here, so the two surfaces cannot drift apart.
 */
export function Composer({
  busy, canRegenerate, t, openMenuAt, onSend, onStop, onRegenerate,
}: {
  busy: boolean;
  canRegenerate: boolean;
  t: T;
  /** Changes when something else asks for the menu (`:help`). */
  openMenuAt: number;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onRegenerate: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [commands, setCommands] = useState<SlashCommand[]>([]);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const slashRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 74), 320)}px`;
  }, [draft]);

  // Commands are engine-owned; fetched once and reused for every open.
  useEffect(() => {
    void fetch('./api/commands')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCommands(Array.isArray(d?.commands) ? d.commands : []))
      .catch(() => setCommands([]));
  }, []);

  useEffect(() => { if (slashOpen) slashRef.current?.focus(); }, [slashOpen]);
  useEffect(() => { if (openMenuAt > 0) setSlashOpen(true); }, [openMenuAt]);

  const filtered = useMemo(() => {
    const q = slashQuery.trim().toLowerCase().replace(/^[/:]/, '');
    const list = q
      ? commands.filter((c) =>
        c.id.toLowerCase().includes(q)
        || c.label.toLowerCase().includes(q)
        || c.category.toLowerCase().includes(q))
      : commands;
    const groups = new Map<string, SlashCommand[]>();
    for (const c of list) groups.set(c.category, [...(groups.get(c.category) ?? []), c]);
    return [...groups.entries()];
  }, [commands, slashQuery]);

  /** Read picked files into data URIs so they survive the send round-trip. */
  const absorb = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      // 12 MB per file: beyond that a data: URI in a JSON frame is the wrong
      // transport, and silently truncating would be worse than refusing.
      if (file.size > 12 * 1024 * 1024) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((prev) => [...prev, {
          id: `${file.name}-${file.size}-${Date.now()}`,
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          dataUrl: String(reader.result ?? ''),
        }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const submit = () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy) return;
    onSend(text, attachments);
    setDraft('');
    setAttachments([]);
  };

  /** Commands that read an argument; those are staged in the box to be completed. */
  const TAKES_ARG = new Set([':archmodel', ':save', ':model', ':workflow', ':q add', ':forget']);

  const pickCommand = (id: string) => {
    setSlashOpen(false);
    setSlashQuery('');
    if (TAKES_ARG.has(id)) {
      setDraft(`${id} `);
      taRef.current?.focus();
      return;
    }
    // Everything else runs on selection — staging it in the box was how a
    // command ended up being sent to the model as a question.
    onSend(id, []);
    setDraft('');
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        {slashOpen && (
          <div className="slash">
            <input
              ref={slashRef}
              className="slash-search"
              value={slashQuery}
              placeholder={t('composer.commandSearch')}
              onChange={(e) => setSlashQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setSlashOpen(false); taRef.current?.focus(); }
                if (e.key === 'Enter' && filtered[0]?.[1]?.[0]) {
                  e.preventDefault();
                  pickCommand(filtered[0][1][0].id);
                }
              }}
            />
            <div className="slash-list">
              {filtered.length === 0 ? (
                <div className="slash-empty">{t('composer.noCommands')}</div>
              ) : (
                filtered.map(([category, items]) => (
                  <div key={category}>
                    <div className="slash-group">{category}</div>
                    {items.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="slash-item"
                        onClick={() => pickCommand(c.id)}
                      >
                        <span className="slash-id">{c.id}</span>
                        <span className="slash-label">{c.label}</span>
                        <span className="slash-desc">{c.description}</span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a) => (
              <span key={a.id} className="attachment">
                {a.type.startsWith('image/')
                  ? <img src={a.dataUrl} alt="" />
                  : <span className="attachment-doc" aria-hidden="true"><Icon name="file" /></span>}
                <span className="attachment-name" title={a.name}>{a.name}</span>
                <button
                  type="button"
                  className="attachment-del"
                  aria-label={t('app.delete')}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                >
                  <Icon name="close" size="0.9em" />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          className="composer-input"
          rows={3}
          value={draft}
          placeholder={t('chat.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
            // Typing "/" on an empty box opens the menu, as it does in chat
            // clients generally; mid-sentence it stays a plain slash.
            if (e.key === '/' && draft.trim() === '') {
              e.preventDefault();
              setSlashOpen(true);
            }
          }}
        />

        <div className="composer-actions">
          <div className="composer-tools">
            <button
              type="button"
              className="tool-btn"
              title={t('composer.attach')}
              aria-label={t('composer.attach')}
              onClick={() => photoRef.current?.click()}
            >
              +
            </button>
            <button
              type="button"
              className={`tool-btn ${slashOpen ? 'tool-btn-on' : ''}`}
              title={t('composer.commands')}
              aria-label={t('composer.commands')}
              onClick={() => setSlashOpen((v) => !v)}
            >
              /
            </button>
            <button
              type="button"
              className="tool-btn"
              title={t('composer.attachFile')}
              aria-label={t('composer.attachFile')}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="paperclip" size="1.05em" />
            </button>
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => { absorb(e.target.files); e.target.value = ''; }}
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { absorb(e.target.files); e.target.value = ''; }}
            />
          </div>

          <span className="composer-spacer" />

          {busy ? (
            <button type="button" className="btn btn-stop" onClick={onStop}>
              <span className="stop-glyph" aria-hidden="true">■</span>{t('chat.stop')}
            </button>
          ) : (
            <>
              {canRegenerate && (
                <button type="button" className="btn btn-ghost" onClick={onRegenerate}>
                  ⟳ {t('chat.regenerate')}
                </button>
              )}
              <button
                type="button"
                className="btn btn-send"
                onClick={submit}
                disabled={!draft.trim() && attachments.length === 0}
              >
                {t('chat.send')} <span aria-hidden="true">↵</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
