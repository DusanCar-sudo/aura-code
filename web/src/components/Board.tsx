import { useRef, useState } from 'react';
import {
  BOARD_COLUMNS, tasksIn,
  type BoardApi, type BoardColumn, type BoardTask,
} from '../hooks/useBoard';

type T = (key: string) => string;

/**
 * The project board: four columns, tiles you author, an agent per tile.
 *
 * The board is not a picture of the run — it is where the run is started from.
 * Moving a tile into `execution` dispatches it to its agent, and the answer
 * comes back onto the tile. That is the whole reason it exists: Aura's
 * previous Kanban was 2855 lines that nothing wrote to and nothing read from,
 * and it was deleted as dead code. A board that cannot run anything is
 * decoration, and decoration is what got deleted.
 *
 * Movement is by button rather than drag. Dragging is nicer to demo and worse
 * to use here: one column is a dispatch trigger, and an accidental drop that
 * spends money and edits files is not a mistake worth designing in. The
 * buttons say what will happen.
 */
export function Board({ board, busy, onRun, t }: {
  board: BoardApi;
  /** A turn is in flight — only one task may execute at a time. */
  busy: boolean;
  onRun: (task: BoardTask) => void;
  t: T;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // Which column is currently showing its new-job input, if any. One at a
  // time: two open inputs would leave the user guessing which one Enter lands
  // in.
  const [adding, setAdding] = useState<BoardColumn | null>(null);

  return (
    <div className="board-wrap">
      {board.error && <div className="board-bar"><span className="board-error">{board.error}</span></div>}

      <div className="board">
        {BOARD_COLUMNS.map((column) => {
          const cards = tasksIn(board.tasks, column);
          return (
            <section className="board-col" key={column} aria-label={t(`board.col.${column}`)}>
              <header className="board-col-head">
                <h2 className="board-col-title">{t(`board.col.${column}`)}</h2>
                <span className="board-col-count">{cards.length}</span>
                {/* A job can be added straight into any column, not only the
                    first: work does not always arrive at the planning stage —
                    something already investigated belongs in Preparation, and
                    something already done belongs in Finished. */}
                <button
                  type="button"
                  className="board-add"
                  title={t('board.new')}
                  aria-label={`${t('board.new')} — ${t(`board.col.${column}`)}`}
                  onClick={() => setAdding(adding === column ? null : column)}
                >
                  +
                </button>
              </header>
              <div className="board-col-cards">
                {adding === column && (
                  <NewJob
                    t={t}
                    onCancel={() => setAdding(null)}
                    onAdd={(title) => { void board.add({ title, column }); setAdding(null); }}
                  />
                )}
                {cards.map((task) => (
                  <Tile
                    key={task.id}
                    task={task}
                    board={board}
                    busy={busy}
                    open={editing === task.id}
                    onToggle={() => setEditing(editing === task.id ? null : task.id)}
                    onRun={onRun}
                    t={t}
                  />
                ))}
                {cards.length === 0 && adding !== column && (
                  <p className="board-col-empty">{t('board.colEmpty')}</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The inline input a `+` opens.
 *
 * Its own component so it can hold its own draft: keeping four drafts in the
 * Board would mean every keystroke re-rendered every column and every tile.
 * Autofocused, because the click that opened it was the user saying they want
 * to type — making them click again would be asking twice.
 */
function NewJob({ onAdd, onCancel, t }: {
  onAdd: (title: string) => void;
  onCancel: () => void;
  t: T;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const title = draft.trim();
    if (title) onAdd(title);
    else onCancel();
  };
  return (
    <input
      className="board-new"
      autoFocus
      value={draft}
      placeholder={t('board.new')}
      aria-label={t('board.new')}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        // Escape abandons the draft outright. Blur commits instead, because
        // clicking away from a half-typed job to check something is not the
        // same as deciding against it.
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={commit}
    />
  );
}


/** 📷 for something the agent can look at, 📄 for something it can read. */
function fileIcon(type: string): string {
  return type.startsWith('image/') ? '📷' : '📄';
}

/**
 * The `+` that puts files and images on a task.
 *
 * The picker takes several at once and uploads them in sequence rather than in
 * parallel: each upload rewrites the board file, and firing five at once would
 * have them overwrite each other's attachment list — last write wins, four
 * files silently missing.
 */
function Attachments({ task, board, t }: { task: BoardTask; board: BoardApi; t: T }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const files = task.attachments ?? [];

  const pick = async (chosen: FileList | null) => {
    if (!chosen?.length) return;
    setBusy(true);
    for (const file of Array.from(chosen)) await board.attach(task.id, file);
    setBusy(false);
    // Clear the input, or picking the same file twice in a row fires no change
    // event the second time and looks like the button stopped working.
    if (input.current) input.current.value = '';
  };

  return (
    <div className="board-field">
      <span className="board-field-label">{t('board.files')}</span>

      {files.length > 0 && (
        <div className="board-card-files">
          {files.map((a) => (
            <span className="board-file" key={a.path} title={a.path}>
              {fileIcon(a.type)} {a.name}
              <span className="board-file-size">{Math.max(1, Math.round(a.size / 1024))} KB</span>
            </span>
          ))}
        </div>
      )}

      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => void pick(e.target.files)}
      />
      <button
        type="button"
        className="board-attach"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? t('board.filesBusy') : `+ ${t('board.filesAdd')}`}
      </button>
      {/* Said once, here, because it is the thing that makes the feature make
          sense: the agent opens the file itself rather than being handed bytes. */}
      <p className="board-preset">{t('board.filesHint')}</p>
    </div>
  );
}

/** Where a tile can go from here, and what the button should say. */
function nextColumn(column: BoardColumn): BoardColumn | null {
  const at = BOARD_COLUMNS.indexOf(column);
  return at < 0 || at === BOARD_COLUMNS.length - 1 ? null : BOARD_COLUMNS[at + 1];
}

function prevColumn(column: BoardColumn): BoardColumn | null {
  const at = BOARD_COLUMNS.indexOf(column);
  return at <= 0 ? null : BOARD_COLUMNS[at - 1];
}

function Tile({ task, board, busy, open, onToggle, onRun, t }: {
  task: BoardTask;
  board: BoardApi;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onRun: (task: BoardTask) => void;
  t: T;
}) {
  const preset = board.presets.find((p) => p.id === task.agent);
  const next = nextColumn(task.column);
  const prev = prevColumn(task.column);
  // Advancing out of `preparation` is a dispatch, not a move: it spends money
  // and can edit files, so it is labelled for what it does and is the only
  // control disabled while another task is running.
  const advanceRuns = task.column === 'preparation';

  return (
    <article className={`board-card${task.failed ? ' board-card-failed' : ''}${task.column === 'execution' ? ' board-card-running' : ''}`}>
      <button type="button" className="board-card-face" onClick={onToggle} aria-expanded={open}>
        <span className="board-card-title">{task.title}</span>
        <span className="board-card-agent">{preset?.label ?? task.agent}</span>
      </button>

      {task.notes && !open && <div className="board-card-detail">{task.notes}</div>}

      {!open && !!task.attachments?.length && (
        <div className="board-card-files">
          {task.attachments.map((a) => (
            <span className="board-file" key={a.path}>{fileIcon(a.type)} {a.name}</span>
          ))}
        </div>
      )}

      {task.result && (
        <div className={`board-card-result${task.failed ? ' board-card-result-failed' : ''}`}>
          {task.result}
        </div>
      )}

      {open && (
        <div className="board-card-edit">
          <label className="board-field">
            <span className="board-field-label">{t('board.title')}</span>
            <input
              className="board-input"
              defaultValue={task.title}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== task.title) void board.update(task.id, { title: v });
              }}
            />
          </label>

          <label className="board-field">
            <span className="board-field-label">{t('board.notes')}</span>
            <textarea
              className="board-input board-textarea"
              defaultValue={task.notes ?? ''}
              placeholder={t('board.notesHint')}
              onBlur={(e) => {
                if (e.target.value !== (task.notes ?? '')) {
                  void board.update(task.id, { notes: e.target.value });
                }
              }}
            />
          </label>

          <label className="board-field">
            <span className="board-field-label">{t('board.agent')}</span>
            <select
              className="board-input"
              value={task.agent}
              onChange={(e) => void board.update(task.id, { agent: e.target.value })}
            >
              {board.agents.map((id) => (
                <option key={id} value={id}>
                  {board.presets.find((p) => p.id === id)?.label ?? id}
                </option>
              ))}
            </select>
          </label>

          {/* What the agent may actually touch, stated rather than implied —
              the whole point of the preset is that it is enforced, so the user
              should be able to see what they picked. */}
          {preset && <p className="board-preset">{preset.description}</p>}

          <label className="board-field">
            <span className="board-field-label">{t('board.model')}</span>
            <input
              className="board-input"
              defaultValue={task.model ?? ''}
              placeholder={t('board.modelHint')}
              onBlur={(e) => {
                if (e.target.value !== (task.model ?? '')) {
                  void board.update(task.id, { model: e.target.value });
                }
              }}
            />
          </label>

          <Attachments task={task} board={board} t={t} />

          <button
            type="button"
            className="btn btn-ghost board-delete"
            onClick={() => void board.remove(task.id)}
          >
            {t('board.delete')}
          </button>
        </div>
      )}

      <div className="board-card-foot">
        {prev && (
          <button
            type="button"
            className="board-move"
            title={t(`board.col.${prev}`)}
            onClick={() => void board.update(task.id, { column: prev })}
          >
            ←
          </button>
        )}
        {next && (
          advanceRuns ? (
            <button
              type="button"
              className="board-run"
              disabled={busy}
              title={t('board.runHint')}
              onClick={() => onRun(task)}
            >
              {t('board.run')}
            </button>
          ) : (
            <button
              type="button"
              className="board-move board-move-next"
              title={t(`board.col.${next}`)}
              onClick={() => void board.update(task.id, { column: next })}
            >
              →
            </button>
          )
        )}
      </div>
    </article>
  );
}
