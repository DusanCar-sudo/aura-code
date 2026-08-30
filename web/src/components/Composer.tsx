import { useEffect, useMemo, useRef, useState } from 'react';

type T = (key: string) => string;

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  category: string;
}

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

const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  // Session
  { id: ':new', label: 'New session', description: 'Start fresh session', category: 'Session' },
  { id: ':resume', label: 'Resume session', description: 'Resume latest session', category: 'Session' },
  { id: ':sessions', label: 'List sessions', description: 'All saved sessions', category: 'Session' },
  { id: ':history', label: 'Show history', description: 'Turn count in current session', category: 'Session' },
  { id: ':id', label: 'Show session ID', description: 'Current chat ID', category: 'Session' },
  { id: ':save', label: 'Save session', description: 'Rename/save current session', category: 'Session' },
  // Model & API
  { id: ':model', label: 'Switch model', description: 'Interactive model selector', category: 'Model / API' },
  { id: ':provider', label: 'Provider selector', description: 'Pick provider, then model', category: 'Model / API' },
  { id: ':apikey', label: 'Set API key', description: 'Set API key for session', category: 'Model / API' },
  // Workflows & Agentic
  { id: ':workflows', label: 'List workflows', description: 'All saved workflows', category: 'Workflows' },
  { id: ':workflow', label: 'Create workflow', description: 'Multi-step workflow', category: 'Workflows' },
  { id: ':machina', label: 'Machina task', description: 'Self-verification + auto-retry', category: 'Workflows' },
  { id: ':council', label: 'Council', description: 'Parallel read-only specialists', category: 'Workflows' },
  { id: ':designx', label: 'Design commission', description: 'Route a style, scrape references, build artefact', category: 'Design' },
  // Memory & Learning
  { id: ':dream', label: 'Dream', description: 'Consolidate episodes', category: 'Memory' },
  { id: ':rem', label: 'Show memory', description: 'Reconciled memory graph', category: 'Memory' },
  { id: ':mine --refine', label: 'Mine patterns', description: 'Mine episodes with local model', category: 'Memory' },
  { id: ':research', label: 'Research', description: 'Multi-step research pass', category: 'Memory' },
  { id: ':lessons', label: 'Lessons learned', description: 'What Aura learned from past turns', category: 'Memory' },
  { id: ':forget', label: 'Forget a lesson', description: 'Remove a learned lesson from context', category: 'Memory' },
  // System & Diagnostics
  { id: ':context', label: 'Context health', description: 'Token usage & context health dashboard', category: 'System' },
  { id: ':doctor', label: 'Doctor', description: 'Run environment and agent health checks', category: 'System' },
  { id: ':compact', label: 'Force compact', description: 'Manual context compaction', category: 'System' },
  { id: ':approve', label: 'Toggle auto-approve', description: 'Skip confirmation prompts', category: 'Safety' },
  { id: ':help', label: 'Help', description: 'Show all available commands', category: 'System' },
];

export function Composer({
  busy,
  canRegenerate,
  t,
  openMenuAt,
  onSend,
  onStop,
  onRegenerate,
}: {
  busy: boolean;
  canRegenerate: boolean;
  t: T;
  openMenuAt: number;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onRegenerate: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [commands, setCommands] = useState<SlashCommand[]>(DEFAULT_SLASH_COMMANDS);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    // Floor and ceiling come from the stylesheet (four lines resting, ten
    // before it scrolls) rather than pixel constants here, so changing the
    // font or line-height does not silently mis-size the box.
    const cs = getComputedStyle(ta);
    const floor = parseFloat(cs.minHeight) || 36;
    const ceiling = parseFloat(cs.maxHeight) || 140;
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, floor), ceiling)}px`;
  }, [draft]);

  useEffect(() => {
    void fetch('/api/commands')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (Array.isArray(d?.commands) && d.commands.length > 0) {
          setCommands(d.commands);
        }
      })
      .catch(() => {
        // Keeps DEFAULT_SLASH_COMMANDS
      });
  }, []);

  useEffect(() => {
    if (slashOpen) slashRef.current?.focus();
  }, [slashOpen]);

  useEffect(() => {
    if (openMenuAt > 0) setSlashOpen(true);
  }, [openMenuAt]);

  const filtered = useMemo(() => {
    const q = slashQuery.trim().toLowerCase().replace(/^[/:]/, '');
    const list = q
      ? commands.filter(
          (c) =>
            c.id.toLowerCase().includes(q) ||
            c.label.toLowerCase().includes(q) ||
            c.category.toLowerCase().includes(q) ||
            c.description.toLowerCase().includes(q)
        )
      : commands;
    const groups = new Map<string, SlashCommand[]>();
    for (const c of list) groups.set(c.category, [...(groups.get(c.category) ?? []), c]);
    return [...groups.entries()];
  }, [commands, slashQuery]);

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > 12 * 1024 * 1024) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((prev) => [
          ...prev,
          {
            id: `${file.name}-${file.size}-${Date.now()}`,
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: file.size,
            dataUrl: String(reader.result ?? ''),
          },
        ]);
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

  const TAKES_ARG = new Set([':archmodel', ':save', ':model', ':workflow', ':q add', ':forget', ':mine']);

  const pickCommand = (id: string) => {
    setSlashOpen(false);
    setSlashQuery('');
    if (TAKES_ARG.has(id)) {
      setDraft(`${id} `);
      taRef.current?.focus();
      return;
    }
    onSend(id, []);
    setDraft('');
  };

  return (
    <div className="composer-container">
      {attachments.length > 0 && (
        <div className="draft-attachments-list">
          {attachments.map((a) => (
            <span key={a.id} className="draft-attachment-tag">
              <span className="file-icon">{getFileIcon(a.name)}</span>
              <span className="file-name">{a.name}</span>
              <button
                type="button"
                className="btn-remove-attachment"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {slashOpen && (
        <div className="composer-slash-popup">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: '1px solid var(--line)', background: 'var(--recess)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--acc)' }}>/</span>
            <input
              ref={slashRef}
              className="slash-search-input"
              value={slashQuery}
              placeholder="Type a command or search (e.g. /model, /new, /history)..."
              style={{ border: 0, padding: 0, background: 'transparent', width: '100%', outline: 'none' }}
              onChange={(e) => setSlashQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSlashOpen(false);
                  taRef.current?.focus();
                }
                if (e.key === 'Enter' && filtered[0]?.[1]?.[0]) {
                  e.preventDefault();
                  pickCommand(filtered[0][1][0].id);
                }
              }}
            />
            <button
              type="button"
              style={{ background: 'transparent', border: 0, color: 'var(--dim)', cursor: 'pointer', fontSize: '12px' }}
              onClick={() => {
                setSlashOpen(false);
                taRef.current?.focus();
              }}
            >
              ✕
            </button>
          </div>

          <div className="slash-results-scroll">
            {filtered.length === 0 ? (
              <div className="slash-empty-text">No commands found</div>
            ) : (
              filtered.map(([category, items]) => (
                <div key={category} className="slash-category-block">
                  <div className="slash-category-name">{category}</div>
                  {items.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="slash-result-row"
                      onClick={() => pickCommand(c.id)}
                    >
                      <span className="slash-cmd-id">{c.id}</span>
                      <span className="slash-cmd-label">{c.label}</span>
                      <span className="slash-cmd-desc">{c.description}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="composer-input-row">
        <label
          className="btn-attach-plus"
          title="Attach files, photos, docs"
        >
          +
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>

        <textarea
          ref={taRef}
          className="composer-textarea"
          rows={4}
          value={draft}
          placeholder="Tell me what to verify... (type / or : for commands)"
          onChange={(e) => {
            const val = e.target.value;
            setDraft(val);
            if ((val.startsWith('/') || val.startsWith(':')) && !slashOpen) {
              setSlashOpen(true);
              setSlashQuery(val);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
            if ((e.key === '/' || e.key === ':') && draft.trim() === '') {
              e.preventDefault();
              setSlashOpen(true);
              setSlashQuery('');
            }
          }}
        />

        {busy ? (
          <button type="button" className="btn-run-send btn-stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn-run-send"
            onClick={submit}
            disabled={!draft.trim() && attachments.length === 0}
          >
            Run
          </button>
        )}
      </div>

      <div className="composer-footer-caption">
        + attaches files · photos · docs — type <span style={{ color: 'var(--acc2)' }}>/</span> or <span style={{ color: 'var(--acc2)' }}>:</span> for commands
      </div>
    </div>
  );
}
