import { useState } from 'react';
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
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const addTask = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    void board.add({ title, column: 'planning' });
  };

  return (
    <div className="board-wrap">
      <div className="board-bar">
        <input
          className="board-new"
          value={draft}
          placeholder={t('board.new')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }}
          aria-label={t('board.new')}
        />
        <button type="button" className="btn btn-send" onClick={addTask} disabled={!draft.trim()}>
          {t('board.add')}
        </button>
        {board.error && <span className="board-error">{board.error}</span>}
      </div>

      <div className="board">
        {BOARD_COLUMNS.map((column) => {
          const cards = tasksIn(board.tasks, column);
          return (
            <section className="board-col" key={column} aria-label={t(`board.col.${column}`)}>
              <header className="board-col-head">
                <h2 className="board-col-title">{t(`board.col.${column}`)}</h2>
                <span className="board-col-count">{cards.length}</span>
              </header>
              <div className="board-col-cards">
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
                {cards.length === 0 && <p className="board-col-empty">{t('board.colEmpty')}</p>}
              </div>
            </section>
          );
        })}
      </div>
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
